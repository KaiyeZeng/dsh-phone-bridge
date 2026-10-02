// Doc/code consistency check.
//
// Written after two README hints turned out to be false at once ("there is no
// install script, two config files must be edited by hand" and a pointer to a
// runTurn function that does not exist). Both were caught by hand, which is not
// a mechanism. This is the mechanism.
//
// Run it with: node scripts/check-docs.mjs
// Exits non-zero and prints every mismatch, so CI fails on drift.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

const problems = [];
const fail = (where, message) => problems.push(`${where}: ${message}`);

// Commands that are accepted for convenience and deliberately kept out of help
// so the command list stays short. Anything else accepted by the dispatcher has
// to be listed in the help text, and vice versa.
const UNDOCUMENTED_ALIASES = new Set(["h", "?", "ls", "del-off", "purge-off"]);

// ---------------------------------------------------------------- chat plugin

const ocSrc = read("openclaw-plugin/index.js");

// Dispatchable commands: `text === "/x"` and `text.startsWith("/x " / "/x")`.
const dispatchable = new Set();
for (const m of ocSrc.matchAll(/text\s*===\s*"(\/[a-z!?-]+)"/g)) dispatchable.add(m[1].slice(1));
for (const m of ocSrc.matchAll(/text\.startsWith\("(\/[a-z!?-]+)/g)) dispatchable.add(m[1].slice(1));
for (const m of ocSrc.matchAll(/return\s*\{\s*handled:\s*true\s*,\s*text:\s*helpText/g)) void m;

// Commands advertised in helpText(): only lines that *start* with a command, so
// an explanatory sentence that happens to contain one ("/stop is OpenClaw's...")
// is not mistaken for a listing.
const helpBody = ocSrc.slice(ocSrc.indexOf("function helpText()"));
const helpEnd = helpBody.indexOf("\n}");
const helpText = helpBody.slice(0, helpEnd === -1 ? undefined : helpEnd);
const advertised = new Set();
for (const m of helpText.matchAll(/^\s*"\/([a-z!?-]+)/gm)) advertised.add(m[1]);

// Anything the help text mentions anywhere, including inside a sentence. The
// confirmation pair (/del!, /purge!) is described in prose rather than listed.
const mentioned = (cmd) => new RegExp(`\\/${cmd}(?![a-z])`).test(helpText);

for (const cmd of advertised) {
  if (!dispatchable.has(cmd)) fail("openclaw-plugin/index.js", `help lists /${cmd} but the dispatcher does not handle it`);
}
for (const cmd of dispatchable) {
  if (advertised.has(cmd) || mentioned(cmd)) continue;
  if (UNDOCUMENTED_ALIASES.has(cmd)) continue;
  fail("openclaw-plugin/index.js", `dispatcher handles /${cmd} but help never mentions it`);
}

// The typo suggester keeps its own list of command names. A command missing from
// it does not break anything, it just silently stops suggesting that typo, which
// is exactly the kind of drift nobody notices.
const knownBlock = ocSrc.slice(ocSrc.indexOf("const KNOWN_COMMANDS"));
const knownList = knownBlock.slice(0, knownBlock.indexOf("]"));
const knownCommands = new Set([...knownList.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]));
for (const cmd of advertised) {
  if (!knownCommands.has(cmd)) {
    fail("openclaw-plugin/index.js", `/${cmd} is a real command but KNOWN_COMMANDS omits it, so a typo of it gets no suggestion`);
  }
}

// Commands advertised in help must also appear in both readmes.
for (const file of ["README.md", "README.en.md"]) {
  const text = read(file);
  for (const cmd of advertised) {
    if (!text.includes(`/${cmd}`)) fail(file, `/${cmd} is in the plugin help but not in this readme`);
  }
}

// ------------------------------------------------------------------ config

const manifest = readJson("openclaw-plugin/openclaw.plugin.json");
const declared = new Set(Object.keys(manifest.configSchema?.properties ?? {}));
const used = new Set();
for (const m of ocSrc.matchAll(/config\.([a-zA-Z][a-zA-Z0-9]*)/g)) used.add(m[1]);

for (const key of used) {
  if (!declared.has(key)) {
    fail("openclaw.plugin.json", `code reads config.${key} but configSchema does not declare it, so additionalProperties:false rejects it`);
  }
}
for (const key of declared) {
  if (!used.has(key)) fail("openclaw.plugin.json", `configSchema declares ${key} but no code reads it`);
}

// ------------------------------------------------------------------ routes

const dshSrc = read("dsh-plugin/index.js");
const routes = new Set();
for (const m of dshSrc.matchAll(/path:\s*`\$\{ROUTE_PATH\}\/([a-z-]+)`/g)) routes.add(m[1]);

const dshReadme = read("dsh-plugin/README.md");
for (const route of routes) {
  // The readme's table names the routes by their short form (`GET /sessions`),
  // since the /phone-bridge prefix is stated once above it.
  if (!new RegExp(`\\/${route}(?![a-z-])`).test(dshReadme)) {
    fail("dsh-plugin/README.md", `route /phone-bridge/${route} is registered but not in the route table`);
  }
}

// ------------------------------------------------------- package file lists

// npm silently ships nothing for a `files` entry that does not exist, which is
// how 0.1.0 went out without its readme or licence.
for (const dir of ["dsh-plugin", "openclaw-plugin"]) {
  const pkg = readJson(`${dir}/package.json`);
  for (const entry of pkg.files ?? []) {
    if (!existsSync(join(root, dir, entry))) fail(`${dir}/package.json`, `files lists "${entry}" but ${dir}/${entry} does not exist`);
  }
  if (!pkg.license) fail(`${dir}/package.json`, "no license field");
}

// ------------------------------------------------------------------ report

if (problems.length === 0) {
  console.log("文档与代码一致");
  console.log(`  指令 ${advertised.size} 条，配置项 ${declared.size} 条，路由 ${routes.size} 条`);
  process.exit(0);
}

console.error(`文档与代码不一致，共 ${problems.length} 处：`);
for (const p of problems) console.error("  - " + p);
process.exit(1);
