// DSH (Cordis) plugin: expose a loopback HTTP route that lets an external
// caller drive a *desktop* session — the thing `dsh --profile headless` cannot
// do, because dsh-headless hard-refuses any session carrying an agent preset:
//
//     const preset = currentPreset(header, events, sessionId);
//     if (preset !== void 0) throw new Error(`session "..." runs under agent
//     preset "...", which the one-shot runner does not compose`);
//
// Running inside the desktop process means the real sessionController is right
// here, so we can prompt an existing session and read its answer back.
//
// Contract: Cordis plugin exporting { name, inject, apply }.
// Zero external imports on purpose — only node: builtins — so that loading it
// cannot fail on module resolution.
//
// Implementation note: do NOT use sessionController.follow() here. Calling the
// @Remote stream method directly from inside the host blew up with
// "Cannot read properties of undefined (reading 'throwIfAborted')" no matter
// how the signal was passed. Polling inspect() for new events is boring but it
// works and needs no stream plumbing.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const name = "dsh-wechat-bridge";

// Wait until webServer exists; the session controller is fetched lazily inside
// the request so a slow-to-appear service cannot block plugin activation.
export const inject = ["webServer"];

// Deliberately no `export const Config` schema here.
//
// Declaring one means importing @deepseek-ai/schemastery, which resolves only
// when the plugin is installed as a package with its own node_modules. A
// file:// mount has none, and the import then fails at load time, taking the
// whole plugin (and with it the phone bridge) down. Keeping this file on
// node: builtins alone is what lets it be mounted straight from disk.
//
// Settings therefore arrive as apply()'s second argument, filled in from the
// `config:` block of the row in cordis.patch.yml. Anything absent falls back to
// the defaults below, so mounting the plugin with no config at all works.
const DEFAULTS = {
  // Where the routes are mounted. Change it if something else already owns
  // /phone-bridge; the external caller has to use the same value.
  routePath: "/phone-bridge",
  // Default budget for one prompt turn when the caller does not pass timeoutMs.
  timeoutMs: 300000,
  // How often the turn loop re-reads the session for new events.
  pollIntervalMs: 1000,
  // Request bodies larger than this are refused.
  maxBodyBytes: 1024 * 1024,
  // Where deleted sessions are parked. Empty means <dsh home>/deleted-sessions.
  trashDir: "",
};

// Seeded from the resolved settings in apply(). Kept at module scope because the
// helpers below read them, and re-threading a config object through every one of
// them would touch far more code than it is worth.
let ROUTE_PATH = DEFAULTS.routePath;
let DEFAULT_TIMEOUT_MS = DEFAULTS.timeoutMs;
let POLL_INTERVAL_MS = DEFAULTS.pollIntervalMs;
let MAX_BODY_BYTES = DEFAULTS.maxBodyBytes;
let TRASH_ROOT = "";

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Assistant text out of one session event. Shape mirrors SessionEventMap:
// 'assistant/message' -> { turn, step, message: { content: ContentBlock[] } }.
function assistantTextOf(event) {
  if (!event || event.type !== "assistant/message") return "";
  const content = event.data?.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

function lastAssistantText(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const text = assistantTextOf(events[index]);
    if (text) return text;
  }
  return "";
}

async function eventCountOf(sessionController, sessionId, signal) {
  const inspection = await sessionController.inspect(sessionId, signal);
  return Array.isArray(inspection?.events) ? inspection.events.length : 0;
}

async function runTurn(ctx, sessionId, text, timeoutMs) {
  const sessionController = ctx.get("sessionController");
  if (!sessionController) throw new Error("sessionController is unavailable");

  const controller = new AbortController();
  const signal = controller.signal;

  // Count existing events so the answer is read only from this turn's tail.
  const before = await eventCountOf(sessionController, sessionId, signal);

  try {
    await sessionController.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: "queue",
        content: [{ type: "text", text }],
      },
      signal,
    );
  } catch (error) {
    controller.abort();
    throw new Error(`prompt rejected: ${error?.message ?? error}`);
  }

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const inspection = await sessionController.inspect(sessionId, signal);
      const events = Array.isArray(inspection?.events) ? inspection.events : [];
      const fresh = events.slice(before);
      const ended = fresh.some((event) => event?.type === "turn/end");
      if (ended) {
        const reply = lastAssistantText(fresh);
        return { reply: reply || "（DSH 本轮没有产生文本回复）", timedOut: false };
      }
    }
  } finally {
    controller.abort();
  }

  // Timed out: report whatever text did land rather than nothing at all.
  try {
    const inspection = await sessionController.inspect(sessionId);
    const fresh = (inspection?.events ?? []).slice(before);
    const partial = lastAssistantText(fresh);
    if (partial) return { reply: partial, timedOut: true };
  } catch { /* fall through to the generic timeout message */ }
  return { reply: "（DSH 处理超时，本轮未在限定时间内结束）", timedOut: true };
}

function extractBearer(req) {
  const raw = req.headers?.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(String(raw));
  return match ? match[1].trim() : "";
}

function createHandler(ctx) {
  return async (req, res) => {
    try {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "POST only" });
        return;
      }

      const expected = process.env.DSH_PHONE_BRIDGE_TOKEN ?? "";
      if (expected && extractBearer(req) !== expected) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw || "{}");
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid json" });
        return;
      }

      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      const sessionId = String(payload.sessionId ?? process.env.DSH_PHONE_BRIDGE_SESSION ?? "").trim();
      if (!text) {
        sendJson(res, 400, { ok: false, error: "text is required" });
        return;
      }
      if (!sessionId) {
        sendJson(res, 400, { ok: false, error: "sessionId is required" });
        return;
      }

      const timeoutMs = Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : DEFAULT_TIMEOUT_MS;
      const result = await runTurn(ctx, sessionId, text, timeoutMs);
      sendJson(res, 200, { ok: true, sessionId, ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };
}

const DSH_HOME = join(homedir(), ".dsh");
const SESSIONS_ROOT = join(DSH_HOME, "sessions");
const PROJCACHE_ROOT = join(DSH_HOME, "storages", "session_projcache", "sessions");
// The desktop sidebar renders this registry, so the /sessions route reads it too
// in order to list the same rows the desktop does.
const WORKSPACE_FILE = join(DSH_HOME, "storages", "workspace.json");
// TRASH_ROOT is assigned in apply() from Config, because it is the one path a
// deployment may reasonably want to move somewhere else.

// Every sessionController method this plugin calls. DSH is pre-1.0 and this set
// is an internal surface, so it is checked at load and reported by /health
// rather than discovered one failing route at a time.
const REQUIRED_CONTROLLER_METHODS = [
  "cancel",
  "create",
  "follow",
  "inspect",
  "list",
  "modelCatalog",
  "page",
  "prompt",
  "rename",
  "search",
  "selectModel",
];

// The DSH version this build was last exercised against. Bumped by hand when the
// plugin is re-tested on a newer DSH. It is not a compatibility claim, only the
// value /health compares the running version to, so that a mismatch shows up as a
// sentence rather than as a mystery.
const TESTED_WITH_DSH = "0.2.0-rc.2";

// Best effort. The plugin runs inside the DSH process, and Electron patches fs so
// an app.asar reads like a directory, which is what makes this possible at all.
// Returns null when it cannot be read; /health says so rather than guessing.
function readDshVersion() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, "app.asar", "package.json"));
    candidates.push(join(process.resourcesPath, "app", "package.json"));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      if (parsed?.version) return { name: parsed.name ?? null, version: parsed.version };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// A session lives at sessions/<slug-of-cwd>/<sessionId>/, where the slug is a
// lossy encoding of the working directory. Locate it by scanning instead of
// trying to re-derive that encoding.
function findSessionDir(sessionId) {
  if (!existsSync(SESSIONS_ROOT)) return null;
  for (const slug of readdirSync(SESSIONS_ROOT)) {
    const candidate = join(SESSIONS_ROOT, slug, sessionId);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Every session id that still has a directory under sessions/. sessionController
// keeps an in-process cache that is not evicted when a session's directory is
// moved into the trash, so a freshly deleted session lingers in list() until DSH
// restarts. The /sessions route filters against this set to hide such phantoms
// immediately, while still letting running sessions through (they may be created
// but not yet materialized).
function listOnDiskSessionIds() {
  const ids = new Set();
  if (!existsSync(SESSIONS_ROOT)) return ids;
  for (const slug of readdirSync(SESSIONS_ROOT)) {
    const slugDir = join(SESSIONS_ROOT, slug);
    let entries = [];
    try { entries = readdirSync(slugDir); } catch { continue; }
    for (const name of entries) ids.add(name);
  }
  return ids;
}

// Plain text out of a message's content blocks.
//
// The block shape is not a stable surface either, so only text-ish fields are
// read and anything unrecognised is skipped rather than stringified into the
// output as "[object Object]".
function textFromContentBlocks(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") {
      if (block.trim()) parts.push(block.trim());
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const text = [block.text, block.content].find((v) => typeof v === "string" && v.trim());
    if (text) parts.push(text.trim());
  }
  return parts.join("\n").trim();
}

// Pull just the title out of a session's projection bag.
//
// The bag also carries token counts, context pressure, the turn outline and the
// subagent catalog. On a long session that is tens of kilobytes, and a session
// list or a status line needs none of it - the title is the only part that makes
// a session identifiable. The key is not guaranteed across versions, so probe
// the plausible names the same way the phone side does.
function titleFromProjections(values) {
  for (const key of ["title", "sessionTitle", "name", "label"]) {
    const value = values?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object" && typeof value.title === "string" && value.title.trim()) {
      return value.title.trim();
    }
  }
  return "";
}

// The ids the desktop sidebar would actually list.
//
// The sidebar renders DSH's workspace registry (workspaces[<id>].sessionIds),
// not the disk. Sessions that were never registered there - subagent sessions,
// ones made before the registry existed - have files but no row. Listing the
// disk alone therefore shows the phone rows the desktop does not have, which
// reads as "the phone still shows sessions I deleted".
//
// Returns null when the registry cannot be read, so the caller can fall back to
// the disk list instead of hiding everything.
function readRegisteredSessionIds() {
  try {
    const parsed = JSON.parse(readFileSync(WORKSPACE_FILE, "utf8"));
    const ids = new Set();
    for (const workspace of Object.values(parsed?.tables?.workspaces ?? {})) {
      for (const id of workspace?.sessionIds ?? []) ids.add(id);
    }
    // Archived sessions live in their own sidebar section, not the main list.
    for (const id of parsed?.global?.archivedSessionIds ?? []) ids.delete(id);
    return ids;
  } catch {
    return null;
  }
}

// Move rather than unlink. DSH exposes no delete API, and an irreversible
// deletion triggered from a chat message is a bad trade. A session becomes
// invisible to DSH the instant its directory leaves the sessions root, so
// moving it aside achieves the deletion while staying recoverable.
function moveAside(from, to) {
  if (!existsSync(from)) return false;
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  return true;
}

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else {
      try { total += statSync(full).size; } catch { /* file vanished mid-walk */ }
    }
  }
  return total;
}

// What is sitting in the trash, so the phone and the desktop panel can decide
// whether to restore or purge before doing something irreversible.
function readTrashMeta(trashDir) {
  try {
    return JSON.parse(readFileSync(join(trashDir, "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

function listTrash() {
  if (!existsSync(TRASH_ROOT)) return [];
  return readdirSync(TRASH_ROOT)
    .map((name) => {
      const full = join(TRASH_ROOT, name);
      let bytes = 0;
      let mtime = 0;
      try { bytes = dirSize(full); } catch { /* unreadable entry */ }
      try { mtime = statSync(full).mtimeMs; } catch { /* same */ }
      const meta = readTrashMeta(full);
      return {
        name,
        bytes,
        mtime,
        sessionId: meta?.sessionId ?? null,
        cwd: meta?.cwd ?? "",
        deletedAt: meta?.deletedAt ?? null,
        // Entries trashed before meta.json existed carry no original path and
        // cannot be put back automatically.
        restorable: Boolean(meta?.originalPath),
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function apply(ctx, config = {}) {
  // Settings come from the row's `config:` block, handed in as apply()'s second
  // argument by the host runner. Do NOT read ctx.config here: DSH runs host
  // halves inside a sandbox Proxy whose get trap throws on any property that is
  // not an injected service, and `?.` cannot swallow a throw. `config` is
  // already the resolved value, so merge it over the defaults.
  const settings = { ...DEFAULTS, ...(config ?? {}) };

  ROUTE_PATH = String(settings.routePath || DEFAULTS.routePath);
  DEFAULT_TIMEOUT_MS = Number(settings.timeoutMs) > 0 ? Number(settings.timeoutMs) : DEFAULTS.timeoutMs;
  POLL_INTERVAL_MS = Number(settings.pollIntervalMs) > 0 ? Number(settings.pollIntervalMs) : DEFAULTS.pollIntervalMs;
  MAX_BODY_BYTES = Number(settings.maxBodyBytes) > 0 ? Number(settings.maxBodyBytes) : DEFAULTS.maxBodyBytes;
  TRASH_ROOT = String(settings.trashDir || "").trim() || join(DSH_HOME, "deleted-sessions");

  const disposers = [];

  // List visible sessions so the phone side can offer a picker. Read-only.
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: `${ROUTE_PATH}/sessions`,
    handler: async (req, res) => {
      try {
        const sessionController = ctx.get("sessionController");
        if (!sessionController) throw new Error("sessionController is unavailable");
        const listing = await sessionController.list({}, new AbortController().signal);
        // Two filters, both about agreeing with the desktop sidebar:
        //  - the registry filter drops sessions the sidebar would not list at all
        //    (never registered in a workspace: subagent sessions, pre-registry
        //    ones). Without it the phone shows rows the desktop does not have,
        //    which reads as "the phone still has the sessions I deleted".
        //  - the disk filter drops cached phantoms: sessionController.list()
        //    keeps returning a session after its directory is moved to the trash,
        //    because that cache is only rebuilt on restart.
        // Running sessions bypass both: they can exist before being materialized
        // or registered.
        const onDisk = listOnDiskSessionIds();
        const registered = readRegisteredSessionIds();
        const sessions = (listing?.items ?? [])
          .filter((item) => {
            if (item.running) return true;
            if (!onDisk.has(item.sessionId)) return false;
            if (registered !== null && !registered.has(item.sessionId)) return false;
            return true;
          })
          .map((item) => ({
          sessionId: item.sessionId,
          updatedAt: item.updatedAt,
          running: Boolean(item.running),
          blank: Boolean(item.blank),
          cwd: item.cwd ?? "",
          // Only the title is sent: the full projection bag runs to tens of
          // kilobytes per session on a long one, and the phone lists these.
          projections: { title: titleFromProjections(item.projections?.values) },
        }));
        sendJson(res, 200, { ok: true, sessions });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }));

  // Search session message content, so the phone can locate a session by
  // keyword instead of paging through an ever-growing list. Read-only and
  // does not activate the matched sessions.
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: `${ROUTE_PATH}/search`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const query = (url.searchParams.get("q") ?? "").trim();
        if (!query) {
          sendJson(res, 400, { ok: false, error: "q is required" });
          return;
        }
        const sessionController = ctx.get("sessionController");
        if (!sessionController) throw new Error("sessionController is unavailable");
        const result = await sessionController.search({ query }, new AbortController().signal);
        sendJson(res, 200, { ok: true, result });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }));

  // Create a fresh session. Called with no arguments the controller falls back
  // to its default working directory, which is what the phone wants.
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: `${ROUTE_PATH}/create`,
    handler: async (req, res) => {
      try {
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "POST only" });
          return;
        }
        const raw = await readBody(req);
        let payload = {};
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { ok: false, error: "invalid json" });
          return;
        }
        const sessionController = ctx.get("sessionController");
        if (!sessionController) throw new Error("sessionController is unavailable");
        const created = await sessionController.create({
          ...(typeof payload.cwd === "string" && payload.cwd.trim() ? { cwd: payload.cwd.trim() } : {}),
          ...(typeof payload.agentPreset === "string" && payload.agentPreset.trim()
            ? { agentPreset: payload.agentPreset.trim() }
            : {}),
        });
        const sessionId = created?.sessionId;
        if (!sessionId) throw new Error("create returned no sessionId");
        const title = typeof payload.title === "string" ? payload.title.trim() : "";
        if (title) {
          try {
            await sessionController.rename({ sessionId, title });
          } catch { /* naming is best effort; the session exists either way */ }
        }
        sendJson(res, 200, { ok: true, sessionId, agentPreset: created?.agentPreset ?? null });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }));

  // Delete a session by moving it out of the sessions root; a recovery copy
  // lands under ~/.dsh/deleted-sessions/. DSH has no delete API of its own.
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: `${ROUTE_PATH}/delete`,
    handler: async (req, res) => {
      try {
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "POST only" });
          return;
        }
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { ok: false, error: "invalid json" });
          return;
        }
        const sessionId = String(payload.sessionId ?? "").trim();
        if (!sessionId) {
          sendJson(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }

        const sessionController = ctx.get("sessionController");
        if (!sessionController) throw new Error("sessionController is unavailable");

        // Refuse while the session is running: DSH holds the file handle and a
        // rename would fight the writer.
        const listing = await sessionController.list({}, new AbortController().signal);
        const summary = (listing?.items ?? []).find((item) => item.sessionId === sessionId);
        if (summary?.running) {
          sendJson(res, 409, { ok: false, error: "会话正在运行，先停掉再删" });
          return;
        }

        const dir = findSessionDir(sessionId);
        const cache = join(PROJCACHE_ROOT, `${sessionId}.json`);
        if (!dir && !existsSync(cache)) {
          sendJson(res, 404, { ok: false, error: "磁盘上找不到这个会话" });
          return;
        }

        const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${sessionId}`;
        const trash = join(TRASH_ROOT, stamp);
        const moved = [];
        if (dir && moveAside(dir, join(trash, "session"))) moved.push("session");
        if (moveAside(cache, join(trash, "projcache.json"))) moved.push("projcache");

        // Record where it came from. Without this the trash is a one-way door and
        // the whole "move instead of delete" promise is empty: the folder name
        // carries only the session id, while the sessions root is keyed by an
        // encoded form of the cwd - so the original location cannot be recovered
        // from the trash alone.
        try {
          writeFileSync(join(trash, "meta.json"), JSON.stringify({
            sessionId,
            originalPath: dir ?? null,
            cachePath: cache,
            cwd: summary?.cwd ?? "",
            deletedAt: new Date().toISOString(),
          }, null, 2), "utf8");
          moved.push("meta");
        } catch { /* best effort - the move already happened */ }

        sendJson(res, 200, { ok: true, sessionId, moved, trash });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }));

  // Show what the trash is holding, with sizes, before anything irreversible.
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: `${ROUTE_PATH}/trash`,
    handler: async (req, res) => {
      try {
        const entries = listTrash();
        sendJson(res, 200, {
          ok: true,
          entries,
          totalBytes: entries.reduce((sum, item) => sum + item.bytes, 0),
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }));

  // Really delete from the trash. Irreversible. Passing a name purges just that
  // entry; omitting it wipes the whole trash.
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: `${ROUTE_PATH}/purge`,
    handler: async (req, res) => {
      try {
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "POST only" });
          return;
        }
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { ok: false, error: "invalid json" });
          return;
        }
        const name = String(payload.name ?? "").trim();
        const before = listTrash();

        if (name) {
          // Only accept a single plain component that is actually present, so a
          // crafted name cannot escape the trash directory.
          if (name.includes("/") || name.includes("\\") || name.includes("..")) {
            sendJson(res, 400, { ok: false, error: "invalid name" });
            return;
          }
          if (!before.some((entry) => entry.name === name)) {
            sendJson(res, 404, { ok: false, error: "no such trash entry" });
            return;
          }
          rmSync(join(TRASH_ROOT, name), { recursive: true, force: true });
        } else {
          rmSync(TRASH_ROOT, { recursive: true, force: true });
        }

        const after = listTrash();
        sendJson(res, 200, {
          ok: true,
          removed: before.length - after.length,
          freedBytes: before.reduce((s, e) => s + e.bytes, 0) - after.reduce((s, e) => s + e.bytes, 0),
          remaining: after.length,
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }));

  // Put a trashed session back where it came from. Relies on meta.json, which
  // the delete route writes; entries trashed before that existed cannot be
  // restored automatically and say so rather than guessing a location.
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: `${ROUTE_PATH}/restore`,
    handler: async (req, res) => {
      try {
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "POST only" });
          return;
        }
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { ok: false, error: "invalid json" });
          return;
        }
        const name = String(payload.name ?? "").trim();
        if (!name) {
          sendJson(res, 400, { ok: false, error: "name is required" });
          return;
        }
        if (name.includes("/") || name.includes("\\") || name.includes("..")) {
          sendJson(res, 400, { ok: false, error: "invalid name" });
          return;
        }

        const trashDir = join(TRASH_ROOT, name);
        if (!existsSync(trashDir)) {
          sendJson(res, 404, { ok: false, error: "no such trash entry" });
          return;
        }

        const meta = readTrashMeta(trashDir);
        if (!meta?.originalPath) {
          sendJson(res, 409, {
            ok: false,
            error: "这一项没有记录原位置，无法自动恢复（它是在本功能加入之前删的）",
          });
          return;
        }

        const hasSession = existsSync(join(trashDir, "session"));
        if (hasSession && existsSync(meta.originalPath)) {
          sendJson(res, 409, { ok: false, error: "原位置已被占用，没有覆盖" });
          return;
        }

        const restored = [];
        if (hasSession) {
          mkdirSync(dirname(meta.originalPath), { recursive: true });
          renameSync(join(trashDir, "session"), meta.originalPath);
          restored.push("session");
        }
        if (meta.cachePath && existsSync(join(trashDir, "projcache.json"))) {
          mkdirSync(dirname(meta.cachePath), { recursive: true });
          renameSync(join(trashDir, "projcache.json"), meta.cachePath);
          restored.push("projcache");
        }

        // Drop what is left: meta.json and the now-empty folder.
        rmSync(trashDir, { recursive: true, force: true });

        sendJson(res, 200, {
          ok: true,
          sessionId: meta.sessionId ?? null,
          restored,
          path: meta.originalPath,
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }));

  // Rename a session so the phone can label targets the way the desktop
  // sidebar does.
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: `${ROUTE_PATH}/rename`,
    handler: async (req, res) => {
      try {
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "POST only" });
          return;
        }
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { ok: false, error: "invalid json" });
          return;
        }
        const sessionId = String(payload.sessionId ?? "").trim();
        const title = String(payload.title ?? "").trim();
        if (!sessionId || !title) {
          sendJson(res, 400, { ok: false, error: "sessionId and title are required" });
          return;
        }
        const sessionController = ctx.get("sessionController");
        if (!sessionController) throw new Error("sessionController is unavailable");
        const result = await sessionController.rename({ sessionId, title });
        sendJson(res, 200, { ok: true, title: result?.title ?? title });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }));

  // What is the session doing right now. Everything here comes from list(),
  // which is cheap and does not activate a cold session - asking for status
  // should never wake one up.
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: `${ROUTE_PATH}/status`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const sessionId = (url.searchParams.get("sessionId") ?? "").trim();
        const sessionController = ctx.get("sessionController");
        if (!sessionController) throw new Error("sessionController is unavailable");
        const signal = new AbortController().signal;
        const listing = await sessionController.list({}, signal);
        const items = listing?.items ?? [];
        const running = items.filter((item) => item.running);

        let detail = null;
        if (sessionId) {
          const found = items.find((item) => item.sessionId === sessionId);
          detail = {
            sessionId,
            known: Boolean(found),
            running: Boolean(found?.running),
            blank: Boolean(found?.blank),
            cwd: found?.cwd ?? "",
            updatedAt: found?.updatedAt ?? null,
            projections: { title: titleFromProjections(found?.projections?.values) },
          };
        }

        sendJson(res, 200, {
          ok: true,
          runningCount: running.length,
          runningIds: running.map((item) => item.sessionId),
          detail,
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }));

  // Stop whatever the session is doing. cancel() takes { kind } internally and
  // keeps the inbox, so the user's queued messages are not silently dropped.
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: `${ROUTE_PATH}/stop`,
    handler: async (req, res) => {
      try {
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "POST only" });
          return;
        }
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { ok: false, error: "invalid json" });
          return;
        }
        const sessionId = String(payload.sessionId ?? "").trim();
        if (!sessionId) {
          sendJson(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        const sessionController = ctx.get("sessionController");
        if (!sessionController) throw new Error("sessionController is unavailable");
        if (typeof sessionController.cancel !== "function") {
          throw new Error("this DSH build does not expose cancel");
        }
        const result = await sessionController.cancel({ sessionId });
        sendJson(res, 200, { ok: true, accepted: result?.accepted !== false });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }));

  // The model catalog is a deployment-wide read, so the phone can fetch it once
  // and then switch models by index without carrying provider ids around.
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: `${ROUTE_PATH}/models`,
    handler: async (_req, res) => {
      try {
        const sessionController = ctx.get("sessionController");
        if (!sessionController) throw new Error("sessionController is unavailable");
        if (typeof sessionController.modelCatalog !== "function") {
          throw new Error("this DSH build does not expose modelCatalog");
        }
        sendJson(res, 200, { ok: true, catalog: (await sessionController.modelCatalog()) ?? null });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }));

  // Switch the model a session uses. selectModel() resumes the session, so this
  // is the one route here with a deliberate side effect.
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: `${ROUTE_PATH}/model`,
    handler: async (req, res) => {
      try {
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "POST only" });
          return;
        }
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { ok: false, error: "invalid json" });
          return;
        }
        const sessionId = String(payload.sessionId ?? "").trim();
        const provider = String(payload.provider ?? "").trim();
        const model = String(payload.model ?? "").trim();
        if (!sessionId || !provider || !model) {
          sendJson(res, 400, { ok: false, error: "sessionId, provider and model are required" });
          return;
        }
        const sessionController = ctx.get("sessionController");
        if (!sessionController) throw new Error("sessionController is unavailable");
        if (typeof sessionController.selectModel !== "function") {
          throw new Error("this DSH build does not expose selectModel");
        }
        const request = { sessionId, provider, model };
        if (payload.reasoningEffort) request.reasoningEffort = payload.reasoningEffort;
        sendJson(res, 200, { ok: true, selection: (await sessionController.selectModel(request)) ?? null });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }));

  // What this build of DSH is expected to hand us. The plugin drives sessions
  // through sessionController, which is an internal surface that can change
  // between releases; when it does, the symptom would otherwise be a bare 500 on
  // whichever route happens to touch the missing method, with nothing said about
  // why. Reporting it up front turns that into one clear line.
  // The user's own last few messages in a session, so the phone can answer "where
  // did this conversation get to" without scrolling a chat app.
  //
  // Read through sessionController.page(), which is the supported history read and
  // does not activate a cold session. The event shape is not a stable surface, so
  // every field access is guarded and an unknown payload degrades to fewer lines
  // rather than throwing.
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: `${ROUTE_PATH}/recent`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const sessionId = (url.searchParams.get("sessionId") ?? "").trim();
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 3, 1), 20);
        if (!sessionId) {
          sendJson(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        const sessionController = ctx.get("sessionController");
        if (!sessionController) throw new Error("sessionController is unavailable");

        const signal = new AbortController().signal;
        const traces = {};

        // Two ways in, tried in order.
        //
        // inspect() hands back the event list outright (SessionInspection.events),
        // so it needs no cursor. page() does need one: throughSeq is an absolute
        // sequence, and -1 is not "newest" but "nothing", since paginate starts at
        // end = throughSeq + 1 = 0 and walks backwards from -1. That misreading is
        // what made the first version answer ok with zero messages.
        let events = [];
        let used = null;

        if (typeof sessionController.inspect === "function") {
          try {
            const inspection = await sessionController.inspect(sessionId, signal);
            const list = Array.isArray(inspection?.events) ? inspection.events : [];
            traces.inspect = {
              eventCount: list.length,
              firstSeq: list[0]?.seq ?? null,
              lastSeq: list[list.length - 1]?.seq ?? null,
            };
            if (list.length) {
              events = list;
              used = "inspect";
            }
          } catch (error) {
            traces.inspect = { error: String(error?.message ?? error) };
          }
        }

        if (!events.length && typeof sessionController.page === "function") {
          try {
            // Page from whatever cursor inspect gave us, else from the very start.
            const cursor = Number(traces.inspect?.lastSeq ?? 0);
            const page = await sessionController.page({
              address: { kind: "session", sessionId },
              throughSeq: Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0,
              maxMessages: 400,
            }, signal);
            const list = (page?.records ?? []).map((record) => record?.event).filter(Boolean);
            traces.page = {
              cursor,
              recordCount: list.length,
              hasMore: page?.hasMore ?? null,
              firstSeq: list[0]?.seq ?? null,
              lastSeq: list[list.length - 1]?.seq ?? null,
            };
            if (list.length) {
              events = list;
              used = "page";
            }
          } catch (error) {
            traces.page = { error: String(error?.message ?? error) };
          }
        }

        const texts = [];
        const typeTally = {};
        let firstUserEvent = null;
        let userEventCount = 0;
        for (const event of events) {
          if (!event) continue;
          const key = event.type ?? "(none)";
          typeTally[key] = (typeTally[key] ?? 0) + 1;
          if (event.type !== "user/message") continue;
          userEventCount += 1;
          if (!firstUserEvent) firstUserEvent = event;
          if (event?.data?.source?.kind !== "user") continue;
          const text = textFromContentBlocks(event.data.content);
          if (!text) continue;
          texts.push({ at: event.time ?? null, text });
        }

        const payload = {
          ok: true,
          sessionId,
          source: used,
          total: texts.length,
          // Newest last, so the caller can slice from the end.
          messages: texts.slice(-limit),
        };

        // Opt-in shape report. The history event format is not a documented
        // surface, so when a read comes back empty the only quick way to find out
        // why is to look at what actually arrived. Loopback-only, and truncated.
        if ((url.searchParams.get("debug") ?? "") === "1") {
          payload.diagnostics = {
            used,
            eventCount: events.length,
            userEventCount,
            eventTypes: typeTally,
            traces,
            firstEventKeys: events[0] ? Object.keys(events[0]) : [],
            firstUserEventSample: firstUserEvent ? JSON.stringify(firstUserEvent).slice(0, 1500) : null,
          };
        }

        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }));

  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: `${ROUTE_PATH}/health`,
    handler: async (_req, res) => {
      try {
        const sessionController = ctx.get("sessionController");
        const missing = sessionController
          ? REQUIRED_CONTROLLER_METHODS.filter((name) => typeof sessionController[name] !== "function")
          : REQUIRED_CONTROLLER_METHODS.slice();
        const dsh = readDshVersion();
        sendJson(res, 200, {
          ok: missing.length === 0,
          controllerAvailable: Boolean(sessionController),
          required: REQUIRED_CONTROLLER_METHODS,
          missing,
          // The method list above is the real compatibility signal. The version is
          // context: a newer DSH can keep every method and still change what one of
          // them means, and that is the one failure nothing here can detect.
          testedWith: TESTED_WITH_DSH,
          dshVersion: dsh?.version ?? null,
          versionMatchesTested: dsh?.version ? dsh.version === TESTED_WITH_DSH : null,
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }));

  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: ROUTE_PATH,
    handler: createHandler(ctx),
  }));

  ctx.logger?.info?.(`phone-bridge listening on ${ROUTE_PATH}`);
  {
    const controller = ctx.get("sessionController");
    const missing = controller
      ? REQUIRED_CONTROLLER_METHODS.filter((name) => typeof controller[name] !== "function")
      : REQUIRED_CONTROLLER_METHODS.slice();
    if (missing.length > 0) {
      ctx.logger?.warn?.(
        `phone-bridge: this DSH build is missing ${missing.join(", ")} on sessionController - the routes that use them will fail. GET ${ROUTE_PATH}/health reports the same list.`,
      );
    }
  }

  return async () => {
    for (const dispose of disposers) {
      try { await dispose?.(); } catch { /* disposal is best effort */ }
    }
  };
}
