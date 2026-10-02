// Load-both-halves smoke test.
//
// The cheapest failure this catches is the one that already happened once: the
// DSH half imported "@deepseek-ai/schemastery", which does not exist when the
// plugin is mounted from disk with file://, so the whole phone link died on
// load. A plain import reproduces that in a second, with no DSH and no
// OpenClaw running.
//
// Run it with: node scripts/smoke.mjs

import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(join(root, rel)).href);

const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};

const dsh = await load("dsh-plugin/index.js").catch((error) => {
  problems.push(`dsh-plugin/index.js 加载失败: ${error.message}`);
  return null;
});
if (dsh) {
  check(typeof dsh.apply === "function", "dsh-plugin 没有导出 apply 函数");
  check(typeof dsh.name === "string" && dsh.name.length > 0, "dsh-plugin 没有 name");
  // The host runner injects services by name; a wrong name means apply never runs
  // and every route 404s with nothing in the log.
  check(Array.isArray(dsh.inject), "dsh-plugin 没有声明 inject 数组");
  check((dsh.inject ?? []).includes("webServer"), "dsh-plugin 的 inject 里没有 webServer");
}

const oc = await load("openclaw-plugin/index.js").catch((error) => {
  problems.push(`openclaw-plugin/index.js 加载失败: ${error.message}`);
  return null;
});
const plugin = oc?.default ?? oc?.plugin;
if (oc) {
  check(Boolean(plugin), "openclaw-plugin 没有导出插件对象");
  check(plugin?.id === "dsh-bridge", `openclaw-plugin 的 id 是 ${plugin?.id}，配置里按 dsh-bridge 引用`);
  check(typeof plugin?.register === "function", "openclaw-plugin 没有 register 方法");
}

if (problems.length === 0) {
  console.log("两个半边都能加载，导出契约正确");
  process.exit(0);
}

console.error(`冒烟测试失败，共 ${problems.length} 处：`);
for (const p of problems) console.error("  - " + p);
process.exit(1);
