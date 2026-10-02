// OpenClaw plugin: answer inbound private-chat messages from DeepSeek Harness
// by prompting a real DSH desktop session, so the phone and the desktop share
// one conversation instead of two isolated ones.
//
// Why the route instead of `dsh --profile headless`: dsh-headless hard-refuses
// any session carrying an agent preset
//   (`if (preset !== void 0) throw ... "which the one-shot runner does not
//   compose"`), and desktop sessions always carry one. So headless can never
// adopt a desktop conversation. The DSH plugin `phone-bridge` runs inside the
// desktop process and calls sessionController directly, which does work.
//
// Hard-won specifics, do not "fix" these back:
//   - before_dispatch is dispatched by the TYPED hook runner only and must be
//     registered with api.on("before_dispatch", handler). api.registerHook()
//     registrations for it are silently never invoked; the Gateway logs
//     'hook event "before_dispatch" is dispatched by the typed hook runner
//     only'. plugins inspect's `hookNames` field tracks the other (internal)
//     hook family, so it stays empty for typed hooks and is NOT a real signal.
//   - The inbound text lives on event.content. Reading event.text yields
//     undefined and makes guards return silently, which looks exactly like
//     "the hook never fired".
//   - Sender identity is NOT reliably populated: yuanbao fills
//     event.senderId, the WeChat plugin leaves it empty and puts the id in the
//     context instead. Match across several fields, and when nothing matches,
//     refuse rather than hand an unknown sender a shell.
//   - `openclaw agent -m` does NOT exercise this hook. Test with a real
//     channel message.
//   - `openclaw plugins reload` does not pick up code changes; restart the
//     Gateway.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Where the DSH-side plugin listens. Overridable from the plugin config
// (bridgeUrl / notifyUrl); the environment variables are kept as a fallback so
// an existing deployment does not have to change anything.
let BRIDGE_URL = process.env.DSH_PHONE_BRIDGE_URL || "http://127.0.0.1:19387/phone-bridge";
// The notify plugin's "pending question / approval" endpoint. While one is
// pending, a plain message answers it instead of being sent to the session.
let ANSWER_URL = process.env.DSH_NOTIFY_URL || "http://127.0.0.1:19387/dsh-notify";
let PAGE_SIZE = 15;
let TURN_TIMEOUT_MS = 300000;

const stateDir = join(process.env.LOCALAPPDATA ?? ".", "dsh-bridge");
const logFile = join(stateDir, "hook.log");
const targetFile = join(stateDir, "target-session.json");

function note(line) {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* logging must never break the hook */
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(targetFile, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(targetFile, JSON.stringify(state, null, 2), "utf8");
    return true;
  } catch (error) {
    note(`state write failed: ${error?.message ?? error}`);
    return false;
  }
}

async function httpJson(method, url, body) {
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json; charset=utf-8" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: `unparseable response (${response.status}): ${text.slice(0, 200)}` };
    }
  } catch (error) {
    return { ok: false, error: `request failed: ${error?.message ?? error}` };
  }
}

// Strip the shared "session-" prefix before truncating: every headless session
// starts with it, so a naive slice(0, 8) renders them all as "session-".
const shortId = (sessionId) => {
  const value = String(sessionId ?? "");
  return (value.startsWith("session-") ? value.slice(8) : value).slice(0, 8) || "(空)";
};

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let current = value;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(index === 0 || current >= 10 ? 0 : 1)} ${units[index]}`;
}

function formatAge(updatedAt) {
  const ms = Date.now() - Number(updatedAt ?? 0);
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

// Titles live in the session projections. The exact key is not guaranteed
// across versions, so probe the plausible names instead of assuming one.
function titleOf(item) {
  const values = item?.projections ?? {};
  for (const key of ["title", "sessionTitle", "name", "label"]) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object" && typeof value.title === "string" && value.title.trim()) {
      return value.title.trim();
    }
  }
  return "";
}

async function listSessions(pageArgument) {
  const page = Math.max(1, Math.floor(Number(pageArgument)) || 1);
  const result = await httpJson("GET", `${BRIDGE_URL}/sessions`);
  if (!result.ok) return `读取会话列表失败：${result.error}`;

  const all = (result.sessions ?? [])
    .slice()
    .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));

  if (!all.length) return "没有读到任何会话。";

  const totalPages = Math.ceil(all.length / PAGE_SIZE);
  const start = (page - 1) * PAGE_SIZE;
  const slice = all.slice(start, start + PAGE_SIZE);
  if (!slice.length) {
    return `第 ${page} 页是空的。共 ${all.length} 个会话、${totalPages} 页。`;
  }

  // Store the FULL ordering so /use can take a global index that stays stable
  // across pages.
  const state = readState();
  state.lastList = all.map((item) => item.sessionId);
  writeState(state);

  const lines = slice.map((item, index) => {
    const flags = [item.running ? "运行中" : "", item.blank ? "空会话" : ""].filter(Boolean).join(" ");
    const title = titleOf(item) || "(无标题)";
    return `${start + index + 1}. ${title}  [${shortId(item.sessionId)}]  ${formatAge(item.updatedAt)}${flags ? "  " + flags : ""}`;
  });

  const footer = [`发 /use <序号> 指定（序号跨页连续）`];
  if (page < totalPages) footer.push(`/list ${page + 1} 看下一页`);
  if (page > 1) footer.push(`/list ${page - 1} 看上一页`);
  footer.push("/find <关键词> 直接搜内容");

  return [
    `可用会话（第 ${page}/${totalPages} 页，共 ${all.length} 个）：`,
    ...lines,
    "",
    footer.join("；"),
  ].join("\n");
}

// Locate sessions by message content. This is the answer to "the list keeps
// growing" - with search you never need to page through everything.
async function findSessions(keyword) {
  const query = String(keyword ?? "").trim();
  if (!query) return "用法：/find <关键词>";

  // Match the session TITLE, not message content. Titles are what you actually
  // recognise ("基金投资推荐与预算建议"), and they are LLM-generated summaries,
  // so the words in them often never appear in the message body - full-text
  // search finds nothing while the session you want is sitting right there.
  // This is a local filter over the session list, so it also needs no search
  // index. /find-any below keeps the old content search available.
  const listing = await httpJson("GET", `${BRIDGE_URL}/sessions`);
  if (!listing.ok) return `读取会话列表失败：${listing.error}`;

  const needle = query.toLowerCase();
  const matches = (listing.sessions ?? [])
    .map((item) => ({ item, title: titleOf(item) }))
    .filter(({ title }) => title.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.item.updatedAt ?? 0) - Number(a.item.updatedAt ?? 0));

  if (!matches.length) {
    return `没有标题含「${query}」的会话。想按消息内容搜试试 /find-any ${query}。`;
  }

  const state = readState();
  state.lastList = matches.map(({ item }) => item.sessionId);
  writeState(state);
  note(`find "${query}" -> ${matches.length} title hit(s)`);

  const lines = matches.slice(0, PAGE_SIZE).map(({ item, title }, index) =>
    `${index + 1}. ${title}  [${shortId(item.sessionId)}]  ${formatAge(item.updatedAt)}`,
  );

  return [
    `标题含「${query}」的会话（${matches.length} 个）：`,
    ...lines,
    "",
    "发 /use <序号> 切过去。",
  ].join("\n");
}

// The original content search, kept as a separate command. It needs the
// session-query index (openAt must not be "never") and matches message bodies.
async function findAnywhere(keyword) {
  const query = String(keyword ?? "").trim();
  if (!query) return "用法：/find-any <关键词>";

  const result = await httpJson("GET", `${BRIDGE_URL}/search?q=${encodeURIComponent(query)}`);
  if (!result.ok) return `搜索失败：${result.error}`;

  const payload = result.result ?? {};
  const hits = payload.items ?? payload.sessions ?? payload.matches ?? payload.results ?? [];
  if (!Array.isArray(hits) || !hits.length) return `消息内容里没搜到「${query}」。`;

  const titleById = new Map();
  const listing = await httpJson("GET", `${BRIDGE_URL}/sessions`);
  if (listing.ok) {
    for (const item of listing.sessions ?? []) titleById.set(item.sessionId, titleOf(item));
  }

  const seen = new Set();
  const lines = [];
  for (const hit of hits) {
    const sessionId = hit?.sessionId ?? hit?.id ?? hit?.session?.sessionId;
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const title = titleOf(hit) || titleById.get(sessionId) || "(无标题)";
    const snippet = String(hit?.snippet ?? "").replace(/\s+/g, " ").trim();
    lines.push(`${lines.length + 1}. ${title}  [${shortId(sessionId)}]`);
    if (snippet) lines.push(`     ${snippet.slice(0, 110)}`);
    if (seen.size >= PAGE_SIZE) break;
  }
  if (!lines.length) return `搜到了结果但认不出会话 id，原始返回：${JSON.stringify(payload).slice(0, 300)}`;

  const state = readState();
  state.lastList = [...seen];
  writeState(state);
  note(`find-any "${query}" -> ${seen.size} hit(s)`);

  return [
    `消息内容含「${query}」的会话（${seen.size} 个）：`,
    ...lines,
    "",
    "发 /use <序号> 切过去。",
  ].join("\n");
}

// DSH's own per-profile launch directory is never a user workspace. A session
// created there lands in a cwd group the desktop sidebar does not show. Worse,
// inheriting such a cwd propagates the mistake: one bad session spawns another.
const DSH_INTERNAL_CWD = /\.dsh[\\/]profiles[\\/][^\\/]+$/i;

function isUsableCwd(value) {
  const cwd = typeof value === "string" ? value.trim() : "";
  return cwd.length > 0 && !DSH_INTERNAL_CWD.test(cwd);
}

// Pick the working directory for a new session: the current target's cwd when
// that is usable, otherwise the most recent usable one.
async function pickCwd(preferredSessionId) {
  const listing = await httpJson("GET", `${BRIDGE_URL}/sessions`);
  if (!listing.ok) return "";
  const usable = (listing.sessions ?? [])
    .filter((item) => isUsableCwd(item.cwd))
    .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
  if (preferredSessionId) {
    const match = usable.find((item) => item.sessionId === preferredSessionId);
    if (match) return match.cwd.trim();
  }
  return usable[0]?.cwd?.trim() ?? "";
}

async function createSession(title) {
  const cleanTitle = String(title ?? "").trim();

  // DSH groups sessions by cwd and the desktop sidebar only lists the workspace
  // you are looking at. create() called with no cwd falls back to the desktop
  // app's launch directory (.dsh\profiles\desktop), which the sidebar never
  // shows - that is why a bare /new looked like a hidden session.
  const state = readState();
  const cwd = await pickCwd(state.sessionId);

  const body = {
    ...(cwd ? { cwd } : {}),
    ...(cleanTitle ? { title: cleanTitle } : {}),
  };
  const result = await httpJson("POST", `${BRIDGE_URL}/create`, body);
  if (!result.ok) return `新建会话失败：${result.error}`;

  // Point the phone at the fresh session so the next message lands there.
  state.sessionId = result.sessionId;
  writeState(state);
  note(`created ${result.sessionId} cwd=${cwd || "(default)"}`);

  const label = cleanTitle ? `（${cleanTitle}）` : "";
  const where = cwd
    ? `，工作目录沿用 ${cwd}`
    : "，没能推断出工作目录，用了 DSH 默认值（桌面端可能看不到它）";
  return `已新建会话 ${shortId(result.sessionId)}${label}${where}。直接发消息即可。`;
}

// Two-step delete: /del <ref> only stages the target, /del! commits. Deleting a
// conversation is not something you want to trigger by a mistyped index, so the
// confirmation step names the exact session first.
async function prepareDelete(reference) {
  const sessionId = resolveTarget(reference);
  if (!sessionId) {
    return "没认出这个会话。先用 /list 或 /find 看列表，再 /del <序号>。";
  }

  const listing = await httpJson("GET", `${BRIDGE_URL}/sessions`);
  const item = (listing.sessions ?? []).find((entry) => entry.sessionId === sessionId);
  const title = titleOf(item) || "(无标题)";

  const state = readState();
  state.pendingDelete = sessionId;
  writeState(state);

  return [
    `即将删除会话「${title}」[${shortId(sessionId)}]`,
    item?.running ? "注意：它正在运行，删除会被拒绝。" : "",
    "",
    "确认回 /del!，取消回 /del-out。",
  ].filter(Boolean).join("\n");
}

async function commitDelete() {
  const state = readState();
  const sessionId = state.pendingDelete;
  if (!sessionId) return "没有待确认的删除。先发 /del <序号>。";

  const result = await httpJson("POST", `${BRIDGE_URL}/delete`, { sessionId });

  state.pendingDelete = "";
  // Do not keep pointing at a session that no longer exists.
  if (state.sessionId === sessionId) state.sessionId = "";
  writeState(state);

  if (!result.ok) return `删除失败：${result.error}`;
  note(`deleted ${sessionId} moved=${(result.moved ?? []).join("+")}`);
  const moved = (result.moved ?? []).join(" + ") || "(nothing)";
  return `已删除会话 ${shortId(sessionId)}（移走：${moved}）。\n副本在 ~/.dsh/deleted-sessions/ 下，需要时能捞回来。`;
}

function cancelDelete() {
  const state = readState();
  const had = Boolean(state.pendingDelete);
  state.pendingDelete = "";
  writeState(state);
  return had ? "已取消。" : "没有待确认的删除。";
}

// Show what the trash holds, so the decision to purge is an informed one.
async function showTrash() {
  const result = await httpJson("GET", `${BRIDGE_URL}/trash`);
  if (!result.ok) return `读取回收站失败：${result.error}`;

  const entries = result.entries ?? [];
  if (!entries.length) return "回收站是空的，没有占用空间。";

  const lines = entries.slice(0, PAGE_SIZE).map((entry, index) =>
    `${index + 1}. ${String(entry.name).slice(0, 46)}  ${formatBytes(entry.bytes)}`,
  );
  const more = entries.length > PAGE_SIZE ? [`（只显示前 ${PAGE_SIZE} 项）`] : [];

  return [
    `回收站：${entries.length} 项，共 ${formatBytes(result.totalBytes)}`,
    ...lines,
    ...more,
    "",
    "/restore <序号> 放回原位置；/purge <序号> 只删那一个；/purge 清空全部（后两个不可恢复）。",
  ].join("\n");
}

// Stage a purge. Two-step for the same reason as delete: this one really does
// destroy data, and a stray index should not be able to do it alone.
async function preparePurge(reference) {
  const wanted = String(reference ?? "").trim();

  if (wanted) {
    const listing = await httpJson("GET", `${BRIDGE_URL}/trash`);
    if (!listing.ok) return `读取回收站失败：${listing.error}`;
    const entry = (listing.entries ?? [])[Number(wanted) - 1];
    if (!entry) return `没有第 ${wanted} 项。先发 /trash 看列表。`;

    const state = readState();
    state.pendingPurge = entry.name;
    writeState(state);
    return `即将彻底删除「${String(entry.name).slice(0, 46)}」（${formatBytes(entry.bytes)}），不可恢复。\n确认回 /purge!，取消回 /purge-out。`;
  }

  const listing = await httpJson("GET", `${BRIDGE_URL}/trash`);
  if (!listing.ok) return `读取回收站失败：${listing.error}`;
  const count = (listing.entries ?? []).length;
  if (!count) return "回收站是空的。";

  const state = readState();
  state.pendingPurge = "*";
  writeState(state);
  return `即将彻底删除回收站里全部 ${count} 项（共 ${formatBytes(listing.totalBytes)}），不可恢复。\n确认回 /purge!，取消回 /purge-out。`;
}

async function commitPurge() {
  const state = readState();
  const pending = state.pendingPurge;
  if (!pending) return "没有待确认的清理。先发 /purge 或 /purge <序号>。";

  const body = pending === "*" ? {} : { name: pending };
  const result = await httpJson("POST", `${BRIDGE_URL}/purge`, body);

  state.pendingPurge = "";
  writeState(state);

  if (!result.ok) return `清理失败：${result.error}`;
  note(`purged ${result.removed} item(s) freed=${result.freedBytes}`);
  return `已彻底删除 ${result.removed} 项，释放 ${formatBytes(result.freedBytes)}。回收站还剩 ${result.remaining} 项。`;
}

function cancelPurge() {
  const state = readState();
  const had = Boolean(state.pendingPurge);
  state.pendingPurge = "";
  writeState(state);
  return had ? "已取消。" : "没有待确认的清理。";
}

// Put one trashed session back. Single step on purpose: unlike purge this
// destroys nothing, and the worst a wrong index costs is another /del.
async function restoreFromTrash(reference) {
  const wanted = String(reference ?? "").trim();
  if (!wanted) return "用法：/restore <序号>（序号看 /trash）。";

  const listing = await httpJson("GET", `${BRIDGE_URL}/trash`);
  if (!listing.ok) return `读取回收站失败：${listing.error}`;

  const entry = (listing.entries ?? [])[Number(wanted) - 1];
  if (!entry) return `没有第 ${wanted} 项。先发 /trash 看列表。`;
  if (!entry.restorable) {
    return `第 ${wanted} 项没有原位置记录，系统不知道该放回哪里，无法自动恢复。`;
  }

  const result = await httpJson("POST", `${BRIDGE_URL}/restore`, { name: entry.name });
  if (!result.ok) return `恢复失败：${result.error}`;

  note(`restored ${result.sessionId ?? entry.name}`);
  return `已恢复：${result.sessionId ?? entry.name}\n它回到了原来的工作目录，桌面侧边栏里应该就能看到了。`;
}

// How the current session is doing. One round trip, since the phone is often on
// a slow link and status is the command you fire when something feels stuck.
async function showStatus() {
  const current = readState().sessionId ?? "";
  const query = current ? `?sessionId=${encodeURIComponent(current)}` : "";
  const result = await httpJson("GET", `${BRIDGE_URL}/status${query}`);
  if (!result.ok) return `读取状态失败：${result.error}`;

  const lines = [];
  const detail = result.detail;
  if (!current) {
    lines.push("还没指定会话。发 /list 看列表后用 /use <序号>，或者 /new 开一个。");
  } else if (!detail?.known) {
    lines.push(`当前指向 ${shortId(current)}，但它已不在会话列表里（可能被删了）。`);
    lines.push("发 /list 重新指定。");
  } else {
    const title = titleOf({ projections: detail.projections }) || "(无标题)";
    const flags = [detail.running ? "正在跑任务" : "空闲", detail.blank ? "空会话" : ""]
      .filter(Boolean)
      .join("，");
    lines.push(`当前会话：${title}  [${shortId(current)}]`);
    lines.push(`状态：${flags}`);
    if (detail.cwd) lines.push(`工作目录：${detail.cwd}`);
    if (detail.updatedAt) lines.push(`最近活动：${formatAge(detail.updatedAt)}`);
  }

  const runningCount = Number(result.runningCount ?? 0);
  if (runningCount > 1) lines.push("", `另有 ${runningCount - 1} 个会话也在跑任务。`);
  lines.push("", "/kill 停下当前任务；/model 看可用模型。");
  return lines.join("\n");
}

// Stop whatever the current session is running. The bridge cancels with
// keepInbox, so messages you already sent are not thrown away with the turn.
//
// The request is sent and then left alone: this does NOT await the round trip.
// Awaiting it made the command useless in the one situation it exists for. Sent
// from the phone partway through a turn, /kill drew no answer until that turn
// ended - even though the DSH route answers in milliseconds when the same POST
// is made by hand, with the session just as busy. The hook is the wrong thing to
// hold open; it confirms now and records the outcome when it lands.
async function stopSession() {
  const current = readState().sessionId ?? "";
  if (!current) return "还没指定会话。发 /list 看列表后用 /use <序号>。";

  const startedAt = Date.now();
  void httpJson("POST", `${BRIDGE_URL}/stop`, { sessionId: current })
    .then((result) => {
      const ms = Date.now() - startedAt;
      note(result.ok ? `stopped ${current} in ${ms}ms` : `stop failed after ${ms}ms: ${result.error}`);
    })
    .catch((error) => note(`stop error ${String(error?.message ?? error)}`));

  return `已发出停止请求：${shortId(current)}。\n它到下个步骤边界就会停；如果正在跑的是一个不响应中断的长命令，得等它自己结束。`;
}

// Read the catalog this DSH build actually returns: groups of models, where the
// group id is the provider id and each model carries id + name.
//
//   { default: {provider, model}, groups: [{ id, name, models: [{ id, name }] }] }
//
// A structural walk covers a build whose shape differs, so a change there
// shortens the list instead of crashing. The walk alone is not enough as the
// primary path: it also matches the group object itself (it has an id) and never
// sees a provider, so every entry would come back unswitchable.
function flattenCatalog(catalog) {
  const fromGroups = [];
  if (Array.isArray(catalog?.groups)) {
    for (const group of catalog.groups) {
      if (!group || typeof group !== "object") continue;
      const provider = String(group.id ?? group.provider ?? "").trim();
      for (const entry of Array.isArray(group.models) ? group.models : []) {
        if (!entry || typeof entry !== "object") continue;
        const model = String(entry.id ?? entry.model ?? "").trim();
        if (!model) continue;
        fromGroups.push({
          provider,
          model,
          label: String(entry.name ?? entry.label ?? model).trim() || model,
        });
      }
    }
  }
  if (fromGroups.length) return fromGroups;
  return walkCatalog(catalog);
}

// Fallback for an unfamiliar shape: keep anything carrying a model id.
function walkCatalog(catalog) {
  const found = [];
  const seen = new Set();
  const visit = (node, depth) => {
    if (!node || depth > 5) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;

    const model = [node.model, node.modelId, node.id]
      .find((value) => typeof value === "string" && value.trim());
    if (model) {
      const provider = [node.provider, node.providerId, node.providerKey]
        .find((value) => typeof value === "string" && value.trim()) ?? "";
      const label = [node.label, node.displayName, node.name]
        .find((value) => typeof value === "string" && value.trim()) ?? model;
      const key = `${provider}|${model}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ provider, model, label });
      }
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  visit(catalog, 0);
  return found;
}

// Whether this row is the deployment default, so the listing can mark which one
// DSH reaches for when a session has made no explicit choice.
function isCatalogDefault(catalog, entry) {
  const provider = String(catalog?.default?.provider ?? "").trim();
  const model = String(catalog?.default?.model ?? "").trim();
  return Boolean(model) && entry.model === model && entry.provider === provider;
}

// Remember the last listing so /model <序号> can refer to a row.
async function showModels() {
  const result = await httpJson("GET", `${BRIDGE_URL}/models`);
  if (!result.ok) return `读取模型列表失败：${result.error}`;

  const models = flattenCatalog(result.catalog);
  if (!models.length) return "DSH 没有返回可用的模型列表。";

  const state = readState();
  state.lastModels = models;
  writeState(state);

  const lines = models.slice(0, PAGE_SIZE).map((entry, index) => {
    const name = `${entry.provider ? `${entry.provider} / ` : ""}${entry.label}`;
    return `${index + 1}. ${name}${isCatalogDefault(result.catalog, entry) ? "（默认）" : ""}`;
  });
  const more = models.length > PAGE_SIZE ? [`（只显示前 ${PAGE_SIZE} 个）`] : [];
  return [
    `可用模型：${models.length} 个`,
    ...lines,
    ...more,
    "",
    "/model <序号> 切换当前会话用的模型。",
  ].join("\n");
}

async function switchModel(reference) {
  const wanted = String(reference ?? "").trim();
  if (!wanted) return showModels();

  const current = readState().sessionId ?? "";
  if (!current) return "还没指定会话。发 /list 看列表后用 /use <序号>，再切模型。";

  const state = readState();
  const list = Array.isArray(state.lastModels) ? state.lastModels : [];
  let picked = null;
  if (/^\d+$/.test(wanted)) {
    picked = list[Number(wanted) - 1] ?? null;
    if (!picked) return `没有第 ${wanted} 个模型。先发 /model 看列表。`;
  } else {
    // Exact id first, then a case-insensitive substring so a typed name does not
    // have to match the full id.
    const lower = wanted.toLowerCase();
    picked = list.find((entry) => entry.model === wanted)
      ?? list.find((entry) => String(entry.model).toLowerCase().includes(lower))
      ?? null;
    if (!picked) return `没找到「${wanted}」。先发 /model 看列表。`;
  }

  if (!picked.provider) {
    return `「${picked.label}」没有提供者信息，切不了。用 /model 看列表里的序号再试。`;
  }

  const result = await httpJson("POST", `${BRIDGE_URL}/model`, {
    sessionId: current,
    provider: picked.provider,
    model: picked.model,
  });
  if (!result.ok) return `切换失败：${result.error}`;
  note(`model ${picked.provider}/${picked.model}`);
  return `已把 ${shortId(current)} 切到 ${picked.provider} / ${picked.label}。\n下一条消息就会用新模型。`;
}

function resolveTarget(reference) {
  const state = readState();
  const wanted = String(reference ?? "").trim();
  if (!wanted) return null;

  // Numeric picks a row from the most recent /list output.
  if (/^\d+$/.test(wanted)) {
    const index = Number(wanted) - 1;
    const list = Array.isArray(state.lastList) ? state.lastList : [];
    return list[index] ?? null;
  }
  // Otherwise treat it as an id or id prefix.
  const list = Array.isArray(state.lastList) ? state.lastList : [];
  const matches = list.filter((id) => String(id).startsWith(wanted));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return null;
  return wanted.length >= 8 ? wanted : null;
}

async function askSession(sessionId, text) {
  const result = await httpJson("POST", BRIDGE_URL, { text, sessionId, timeoutMs: TURN_TIMEOUT_MS });
  if (result.ok) return result.reply ?? "（DSH 没有返回内容）";
  return `DSH 调用失败：${result.error ?? "未知错误"}`;
}

// Everything the dispatcher below actually handles. Used only to suggest the
// likely intent when someone mistypes one.
const KNOWN_COMMANDS = [
  "list", "use", "where", "find", "find-any", "new", "name", "status",
  "kill", "model", "del", "trash", "restore", "purge", "pending", "help",
];

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

// The likely intended command, or null when the text does not look like a
// mistyped one. The threshold is deliberately tight: people do paste things like
// /home/you/notes.md as chat, and those must keep going through untouched.
function closestCommand(word) {
  if (word.length < 3) return null;
  let best = null;
  let bestScore = Infinity;
  for (const command of KNOWN_COMMANDS) {
    const score = editDistance(word, command);
    if (score < bestScore) {
      bestScore = score;
      best = command;
    }
  }
  // Two edits for words of five letters and up, one below that. A transposition
  // costs two in Levenshtein, so the tighter bound would miss the commonest typo
  // of all (/modle). Loosening it is safe because this only ever runs on input
  // that already starts with a slash.
  return bestScore <= (word.length <= 4 ? 1 : 2) ? best : null;
}

// Collect every identity-ish field the two hook objects expose. Real channels
// fill different ones.
function identityCandidates(event, ctx) {
  const values = [
    event?.senderId,
    event?.sender,
    event?.from,
    event?.peer,
    event?.userId,
    event?.accountId,
    ctx?.senderId,
    ctx?.accountId,
    ctx?.conversationId,
    ctx?.channelId,
    event?.sessionKey,
    ctx?.sessionKey,
  ];
  return values.map((value) => String(value ?? "").trim()).filter(Boolean);
}

// One place to look up the command set. Kept in sync with the handlers below -
// when adding a command, add it here too.
// One command per line, with no column padding. A fixed-width layout lines up in
// a terminal and falls apart in a chat bubble, where wrapping and a proportional
// font turn the gaps into ragged columns. The fullwidth bar keeps the command
// and its description visually separate without depending on space counts.
function helpText() {
  return [
    "手机桥指令",
    "",
    "会话",
    "/list [页码]｜列出会话，每页 15 条",
    "/find <关键词>｜按标题（任务名）查",
    "/find-any <关键词>｜按消息正文全文搜",
    "/new [标题]｜新建会话并切过去",
    "/use <序号>｜指定目标会话",
    "/where｜当前会话、工作目录、活跃时间",
    "/name <标题>｜给当前会话命名",
    "/status｜当前会话的状态",
    "",
    "运行控制",
    "/kill｜停下当前会话正在跑的任务",
    "/model [序号]｜查看可用模型；带序号就是切换",
    "",
    "删除与回收站",
    "/del <序号>｜删除，移进回收站可恢复",
    "/trash｜查看回收站内容与占用",
    "/restore <序号>｜把回收站里的一项放回原位置",
    "/purge [序号]｜彻底抹除；不带序号是全部",
    "确认回 /del! 或 /purge!，取消回 /del-out 或 /purge-out",
    "",
    "其他",
    "/help｜显示这份列表",
    "/pending｜查看挂起的提问/审批",
    "",
    "普通消息会发给当前会话；没指定过就先 /list 或 /new。",
    "有挂起的提问/审批时，普通消息当作答（按提示回编号或文字）。",
    "想强行当聊天消息发，用 // 开头。",
    "",
    "注意：/stop 是 OpenClaw 自己的中断，停不了 DSH 里的任务，要停用 /kill。",
  ].join("\n");
}

const plugin = {
  id: "dsh-bridge",
  name: "DSH Bridge",
  description: "Answer private-chat messages from DeepSeek Harness desktop sessions",

  register(api) {
    const config = api.pluginConfig ?? {};
    const allowGroups = config.allowGroups === true;
    const allowedSenders = Array.isArray(config.allowedSenders)
      ? config.allowedSenders.map((value) => String(value).trim()).filter(Boolean)
      : [];

    // Endpoints and limits, so a fresh install never has to edit this file.
    if (config.bridgeUrl) BRIDGE_URL = String(config.bridgeUrl).trim();
    if (config.notifyUrl) ANSWER_URL = String(config.notifyUrl).trim();
    if (Number(config.pageSize) > 0) PAGE_SIZE = Number(config.pageSize);
    if (Number(config.turnTimeoutMs) > 0) TURN_TIMEOUT_MS = Number(config.turnTimeoutMs);
    // timeoutSeconds is the older name for the same setting; keep honouring it.
    else if (Number(config.timeoutSeconds) > 0) TURN_TIMEOUT_MS = Number(config.timeoutSeconds) * 1000;

    api.on("before_dispatch", async (event, ctx) => {
      const text = String(event?.content ?? event?.body ?? "").trim();
      const candidates = identityCandidates(event, ctx);
      note(`fire channel=${event?.channel ?? "-"} isGroup=${event?.isGroup ?? false} chars=${text.length} id=${candidates.join("|")}`);

      if (!text) return;
      if (config.enabled === false) return;
      if (event?.isGroup && !allowGroups) return;

      if (allowedSenders.length > 0) {
        const matched = candidates.some((value) => allowedSenders.includes(value));
        if (!matched) {
          note(`blocked ids=${candidates.join("|") || "(none)"}`);
          // Answer with the identifiers we saw rather than staying silent. That
          // is how a new user gets themselves onto the allowlist without reading
          // hook.log on the machine, and it gives away nothing: these are the
          // sender's own ids, and knowing them does not grant access.
          const shown = candidates.length > 0
            ? candidates.map((value) => `  ${value}`).join("\n")
            : "  （这个渠道的消息里没有任何身份字段）";
          return {
            handled: true,
            text: [
              "这条通道只对白名单里的账号开放，你不在名单里。",
              "",
              "我看到的身份是：",
              shown,
              "",
              "要放行，把上面任意一行加进 openclaw.json 里这个插件的 allowedSenders，然后重启 Gateway。",
            ].join("\n"),
          };
        }
      }

      const startedAt = Date.now();
      try {
        if (text === "/help" || text === "/?" || text === "/h") {
          return { handled: true, text: helpText() };
        }

        if (text === "/list" || text === "/ls" || text.startsWith("/list ") || text.startsWith("/ls ")) {
          const argument = text.replace(/^\/(?:list|ls)\s*/, "").trim();
          return { handled: true, text: await listSessions(argument) };
        }

        if (text === "/trash") {
          return { handled: true, text: await showTrash() };
        }

        if (text === "/restore" || text.startsWith("/restore ")) {
          return { handled: true, text: await restoreFromTrash(text.slice(8)) };
        }

        if (text === "/status") {
          return { handled: true, text: await showStatus() };
        }

        // Deliberately not /stop: OpenClaw claims that one before any plugin
        // hook runs. Its ABORT_TRIGGERS set matches /stop plus stop, halt,
        // abort, interrupt, exit, esc, 停止, 暂停 and more, and it aborts the
        // OpenClaw reply rather than the DSH session, so a DSH turn would keep
        // running while the phone said it had stopped. /kill is not in that
        // set.
        if (text === "/kill") {
          return { handled: true, text: await stopSession() };
        }

        if (text === "/model" || text.startsWith("/model ")) {
          return { handled: true, text: await switchModel(text.slice(6)) };
        }

        if (text === "/purge!") {
          return { handled: true, text: await commitPurge() };
        }

        if (text === "/purge-out" || text === "/purge-off") {
          return { handled: true, text: cancelPurge() };
        }

        if (text === "/purge" || text.startsWith("/purge ")) {
          return { handled: true, text: await preparePurge(text.slice(6)) };
        }

        if (text === "/del!") {
          return { handled: true, text: await commitDelete() };
        }

        if (text === "/del-out" || text === "/del-off") {
          return { handled: true, text: cancelDelete() };
        }

        if (text.startsWith("/del ")) {
          return { handled: true, text: await prepareDelete(text.slice(5)) };
        }

        if (text.startsWith("/find-any ")) {
          return { handled: true, text: await findAnywhere(text.slice(10)) };
        }

        if (text.startsWith("/find ")) {
          return { handled: true, text: await findSessions(text.slice(6)) };
        }

        if (text === "/new" || text.startsWith("/new ")) {
          return { handled: true, text: await createSession(text.slice(4)) };
        }

        if (text.startsWith("/use ")) {
          const resolved = resolveTarget(text.slice(5));
          if (!resolved) {
            return { handled: true, text: "没认出这个会话。先发 /list 看列表，再用 /use <序号>。" };
          }
          const state = readState();
          state.sessionId = resolved;
          writeState(state);
          note(`target set ${resolved}`);

          // Report the working directory too: when you pick a historical session
          // that IS the project space your next messages will run in.
          const listing = await httpJson("GET", `${BRIDGE_URL}/sessions`);
          const item = (listing.sessions ?? []).find((entry) => entry.sessionId === resolved);
          const title = titleOf(item) || "(无标题)";
          const cwdLine = item?.cwd ? `\n工作目录：${item.cwd}` : "";
          return {
            handled: true,
            text: `已切到「${title}」[${shortId(resolved)}]。${cwdLine}\n之后的普通消息都发给它。`,
          };
        }

        if (text === "/where") {
          const current = readState().sessionId;
          if (!current) {
            return {
              handled: true,
              text: "还没有指定会话。发 /list 看列表后用 /use <序号>，或者 /new 开一个。",
            };
          }

          const listing = await httpJson("GET", `${BRIDGE_URL}/sessions`);
          const item = (listing.sessions ?? []).find((entry) => entry.sessionId === current);
          if (!item) {
            return {
              handled: true,
              text: `当前指向 ${shortId(current)}，但它已不在会话列表里（可能被删了）。\n发 /list 重新指定。`,
            };
          }

          const title = titleOf(item) || "(无标题)";
          const flags = [item.running ? "运行中" : "", item.blank ? "空会话" : ""].filter(Boolean).join(" ");
          return {
            handled: true,
            text: [
              `当前会话：${title}  [${shortId(current)}]`,
              `工作目录：${item.cwd || "(未知)"}`,
              `最后活跃：${formatAge(item.updatedAt)}${flags ? "  " + flags : ""}`,
              `完整 id：${current}`,
            ].join("\n"),
          };
        }

        if (text.startsWith("/name ")) {
          const title = text.slice(6).trim();
          if (!title) {
            return { handled: true, text: "用法：/name <标题>" };
          }
          const current = readState().sessionId;
          if (!current) {
            return { handled: true, text: "先发 /use <序号> 指定一个会话，再给它命名。" };
          }
          const result = await httpJson("POST", `${BRIDGE_URL}/rename`, { sessionId: current, title });
          return {
            handled: true,
            text: result.ok
              ? `已把 ${shortId(current)} 命名为「${result.title ?? title}」，电脑端侧边栏也会同步。`
              : `命名失败：${result.error}`,
          };
        }

        if (text === "/pending") {
          const list = await httpJson("GET", `${ANSWER_URL}/pending`);
          const items = Array.isArray(list?.items) ? list.items : [];
          if (!items.length) return { handled: true, text: "现在没有挂起的提问或审批。" };
          return { handled: true, text: items.map((item) => item.text).join("\n\n———\n\n") };
        }

        // 有挂起的提问/审批时，普通消息优先当作答处理，不投递给会话。
        // 想强行当聊天消息发出去，用 // 开头（下面会去掉前缀）。
        let body = text;
        const forceChat = body.startsWith("//");
        if (forceChat) body = body.slice(2).trim();
        if (!forceChat) {
          const pendingList = await httpJson("GET", `${ANSWER_URL}/pending`);
          if (pendingList?.ok && Array.isArray(pendingList.items) && pendingList.items.length > 0) {
            const answered = await httpJson("POST", `${ANSWER_URL}/answer`, { text });
            if (answered?.ok) {
              note(`answer ${answered.code ?? "?"} ${answered.kind ?? "?"}`);
              // A：答完把微信这边切到发问的那个会话，之后随口接的话就是跟它说
              let tail = "";
              if (answered.sessionId) {
                const state = readState();
                if (state.sessionId !== answered.sessionId) {
                  state.sessionId = answered.sessionId;
                  writeState(state);
                  note(`target switched to ${answered.sessionId} after answer`);
                }
                tail = `\n（已把微信切到这个会话${answered.sessionTitle ? `「${answered.sessionTitle}」` : ""}，之后的消息都发给它；它这一轮的收尾回复会随后推给你）`;
              }
              return { handled: true, text: `${answered.summary ?? "已作答"}${tail}` };
            }
            if (answered?.error) {
              note(`answer rejected: ${answered.error}`);
              return { handled: true, text: `${answered.error}\n发 /pending 可以看还有哪些没处理。` };
            }
          }
        }

        // A near-miss command is answered with a suggestion rather than being
        // forwarded to the session. Typing /lst and watching it arrive at the
        // agent as prose is confusing, and this channel runs DSH with approvals
        // off, so stray text is also a stray instruction.
        if (!body.startsWith("//") && body.startsWith("/")) {
          const word = (body.slice(1).split(/\s+/)[0] ?? "").toLowerCase();
          const guess = closestCommand(word);
          if (guess) {
            return {
              handled: true,
              text: `没有 /${word} 这个指令。\n是想用 /${guess} 吗？\n全部指令发 /help。`,
            };
          }
        }

        const target = readState().sessionId;
        if (!target) {
          return {
            handled: true,
            text: "还没有指定会话。先发 /list 看有哪些，再用 /use <序号> 指定一个。",
          };
        }

        note(`ask ${shortId(target)} chars=${body.length}`);
        const reply = await askSession(target, body);
        note(`done elapsedMs=${Date.now() - startedAt} replyChars=${reply.length}`);
        return { handled: true, text: reply };
      } catch (error) {
        note(`error ${error?.message ?? error}`);
        return { handled: true, text: `桥接出错：${error?.message ?? error}` };
      }
    });
  },
};

export { plugin as default };
