// DSH contract check.
//
// The plugin calls into DSH internals, and DSH is pre-1.0. This job is what makes
// the maintenance model work: the plugin is fixed by hand when DSH changes, and
// this is how we find out that it changed - before users upgrade, rather than
// after they report it broken.
//
// It asks npm for the same DSH line the desktop app uses (the "next" dist-tag
// tracked 0.2.0-rc.2 exactly, while "latest" pointed at an older alpha), reads the
// service metadata shipped in the package, and asserts that everything the plugin
// reaches for is still there.
//
// It deliberately does NOT try to be clever about renames. Adapting to a renamed
// method would mean guessing candidate names, and a guess that silently binds to
// the wrong method is worse than a red build. Detect, then fix by hand.
//
// Run: node scripts/check-dsh-contract.mjs [dist-tag]
// Env: DSH_CONTRACT_TAG (default: next)

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2] || process.env.DSH_CONTRACT_TAG || "next";
const pkgName = "@deepseek-ai/dsh-api-session-controller";

const problems = [];
const fail = (message) => problems.push(message);

// --------------------------------------------------------------- expected set

// One source of truth: the plugin declares what it calls, and this reads it back
// out rather than keeping a second copy that can drift.
const pluginSrc = readFileSync(join(root, "dsh-plugin/index.js"), "utf8");
const block = pluginSrc.slice(pluginSrc.indexOf("const REQUIRED_CONTROLLER_METHODS"));
const listEnd = block.indexOf("]");
if (listEnd === -1) {
  console.error("在 dsh-plugin/index.js 里找不到 REQUIRED_CONTROLLER_METHODS");
  process.exit(1);
}
const required = [...block.slice(0, listEnd).matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
if (required.length === 0) {
  console.error("REQUIRED_CONTROLLER_METHODS 解析出来是空的，脚本本身有问题");
  process.exit(1);
}

// Types and fields the plugin reads, not just method names.
const requiredTypes = ["SessionPageRequest", "SessionInspection", "SessionAddress"];
const requiredTypeFields = {
  SessionPageRequest: ["throughSeq", "address"],
  SessionInspection: ["events"],
};

// ------------------------------------------------------------------- download

const work = join(tmpdir(), `dsh-contract-${Date.now()}`);
mkdirSync(work, { recursive: true });

// The registry over plain HTTP rather than shelling out to npm: npm is npm.cmd on
// Windows and Node refuses to spawn a .cmd without a shell, and the pack step
// needs neither auth nor a cache.
const tarBin = process.platform === "win32" ? "tar.exe" : "tar";

let tarballUrl = "";
let version = "";
try {
  const meta = await (await fetch(`https://registry.npmjs.org/${pkgName}`)).json();
  version = meta["dist-tags"]?.[tag] ?? "";
  if (!version) {
    console.error(`registry 上没有 ${tag} 这个 dist-tag，现有：${Object.keys(meta["dist-tags"] ?? {}).join(", ")}`);
    process.exit(1);
  }
  tarballUrl = meta.versions?.[version]?.dist?.tarball ?? "";
  if (!tarballUrl) {
    console.error(`registry 里 ${version} 没有 tarball 地址`);
    process.exit(1);
  }
} catch (error) {
  console.error(`查询 registry 失败：${error?.message ?? error}`);
  process.exit(1);
}

const tarball = join(work, "pkg.tgz");
try {
  const response = await fetch(tarballUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
} catch (error) {
  console.error(`下载 ${tarballUrl} 失败：${error?.message ?? error}`);
  process.exit(1);
}

try {
  execFileSync(tarBin, ["-xzf", tarball, "-C", work], { stdio: "ignore" });
} catch (error) {
  console.error(`解压失败：${error?.message ?? error}`);
  process.exit(1);
}

const libDir = join(work, "package", "lib");
if (!existsSync(libDir)) {
  console.error("包里没有 lib/ 目录，包装结构变了，脚本要跟着改");
  process.exit(1);
}

const metaFile = readdirSync(libDir).find((name) => /^typert\.host\.js$/.test(name));
if (!metaFile) {
  console.error("包里没有 lib/typert.host.js，接口元数据的位置变了");
  process.exit(1);
}
const meta = readFileSync(join(libDir, metaFile), "utf8");

// --------------------------------------------------------------------- checks

// Two shapes live in this file and they have to be read differently.
//
//  1. Remote method descriptors, which are scoped to a service:
//     { service: 'sessionController', namespace: 'session', method: 'cancel', ... }
//  2. Service declaration entries carrying a signature, which also cover methods
//     that are not @Remote (inspect is one of those):
//     { "kind": "method", "name": "inspect", "signature": "inspect( sessionId: ... )" }
//
// Reading shape 2 alone is not safe: the same file describes other services, and
// a bare name match on "list" picks up a SkillListRequest from the skills
// service, so a removed Session list would still look present. Shape 1 is scoped
// and is therefore the primary check.
const serviced = new Set();
for (const m of meta.matchAll(/service:\s*'sessionController',\s*namespace:\s*'[^']*',\s*method:\s*'([A-Za-z0-9_]+)'/g)) {
  serviced.add(m[1]);
}
if (serviced.size === 0) {
  fail("在接口元数据里找不到 service: 'sessionController' 的方法条目，元数据格式可能变了");
}

// name -> signature, for the declaration shape.
const declarations = new Map();
for (const m of meta.matchAll(/"kind":\s*"method",\s*"name":\s*"([A-Za-z0-9_]+)",\s*"signature":\s*"([^"]*)"/g)) {
  if (!declarations.has(m[1])) declarations.set(m[1], m[2].replace(/\\n/g, " "));
}

const signatures = {};
for (const name of required) {
  if (serviced.has(name)) {
    signatures[name] = `service:sessionController`;
    continue;
  }
  // Not a Remote method, so fall back to the declaration, but insist that it is
  // the Session-domain one rather than a same-named method on another service.
  const signature = declarations.get(name) ?? "";
  if (signature && /Session/.test(signature)) {
    signatures[name] = signature.slice(0, 120);
    continue;
  }
  fail(
    signature
      ? `sessionController.${name} 不是 sessionController 服务上的方法了（同名声明指向 ${signature.slice(0, 80)}）`
      : `sessionController.${name} 不见了（sessionController 服务现在声明了 ${serviced.size} 个方法）`,
  );
}

for (const type of requiredTypes) {
  const at = meta.indexOf(`"${type}"`);
  if (at === -1) {
    fail(`类型 ${type} 不再声明，读它的代码要重写`);
    continue;
  }
  // The declaration text lives in the same entry; search a window around the name.
  const window = meta.slice(at, at + 2500);
  for (const field of requiredTypeFields[type] ?? []) {
    if (!window.includes(field)) fail(`类型 ${type} 里找不到字段 ${field}，取值的代码要重写`);
  }
}

rmSync(work, { recursive: true, force: true });

if (problems.length === 0) {
  console.log(`DSH 接口契约检查通过（${pkgName}@${tag} = ${version}）`);
  console.log(`  sessionController 声明 ${serviced.size} 个方法，我们要的 ${required.length} 个都在；${requiredTypes.length} 个依赖类型都在`);
  for (const [name, signature] of Object.entries(signatures)) {
    console.log(`    ${name}: ${signature.slice(0, 110)}`);
  }
  process.exit(0);
}

console.error(`DSH 接口契约变了（${pkgName}@${tag} = ${version}），共 ${problems.length} 处：`);
for (const p of problems) console.error("  - " + p);
console.error("");
console.error("这意味着桌面版升级后这个插件会失效。本地升级 DSH、跑 verify.ps1、看 /phone-bridge/health，然后改 dsh-plugin/index.js。");
process.exit(1);
