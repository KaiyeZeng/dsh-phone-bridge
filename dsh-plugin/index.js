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
import Schema from "@deepseek-ai/schemastery";

export const name = "dsh-phone-bridge";

// Wait until webServer exists; the session controller is fetched lazily inside
// the request so a slow-to-appear service cannot block plugin activation.
export const inject = ["webServer"];

// Every knob a deployment might want to change lives here, so the plugin can be
// installed on any machine without editing the source.
export const Config = Schema.object({
  // Where the routes are mounted. Change it if something else already owns
  // /phone-bridge; the external caller has to use the same value.
  routePath: Schema.string().default("/phone-bridge"),
  // Default budget for one prompt turn when the caller does not pass timeoutMs.
  timeoutMs: Schema.number().default(300000),
  // How often the turn loop re-reads the session for new events.
  pollIntervalMs: Schema.number().default(1000),
  // Request bodies larger than this are refused.
  maxBodyBytes: Schema.number().default(1024 * 1024),
  // Where deleted sessions are parked. Empty means <dsh home>/deleted-sessions.
  trashDir: Schema.string().default(""),
});

// Seeded from Config in apply(). Kept at module scope because the helpers below
// read them, and re-threading a config object through every one of them would
// touch far more code than it is worth.
let ROUTE_PATH = "/phone-bridge";
let DEFAULT_TIMEOUT_MS = 300000;
let POLL_INTERVAL_MS = 1000;
let MAX_BODY_BYTES = 1024 * 1024;
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
// TRASH_ROOT is assigned in apply() from Config, because it is the one path a
// deployment may reasonably want to move somewhere else.

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
  // Seed the module-level settings. Cordis validates the row against Config and
  // passes the resolved object in as the second argument, so every value here is
  // already defaulted — the fallbacks below only guard against a caller that
  // mounts the plugin by hand without going through the loader.
  ROUTE_PATH = String(config.routePath || ROUTE_PATH);
  DEFAULT_TIMEOUT_MS = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
  POLL_INTERVAL_MS = Number(config.pollIntervalMs) > 0 ? Number(config.pollIntervalMs) : POLL_INTERVAL_MS;
  MAX_BODY_BYTES = Number(config.maxBodyBytes) > 0 ? Number(config.maxBodyBytes) : MAX_BODY_BYTES;
  TRASH_ROOT = String(config.trashDir || "").trim() || join(DSH_HOME, "deleted-sessions");

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
        const sessions = (listing?.items ?? []).map((item) => ({
          sessionId: item.sessionId,
          updatedAt: item.updatedAt,
          running: Boolean(item.running),
          blank: Boolean(item.blank),
          cwd: item.cwd ?? "",
          // Projection values carry derived per-session data such as the
          // generated title, which is what makes a session identifiable.
          projections: item.projections?.values ?? null,
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

  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: ROUTE_PATH,
    handler: createHandler(ctx),
  }));

  ctx.logger?.info?.(`phone-bridge listening on ${ROUTE_PATH}`);

  return async () => {
    for (const dispose of disposers) {
      try { await dispose?.(); } catch { /* disposal is best effort */ }
    }
  };
}
