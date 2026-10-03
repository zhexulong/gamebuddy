#!/usr/bin/env node
// clean-host-workspace.mjs — Phase 1 Step 1.1
// 物理清理 host/ 工作区的一次性构建暂存与探测产物（全部为 .gitignore 覆盖的机器本地物）。
//
// 范围严格遵循 governance 任务 Step 1.1 的清单：
//   1. .dist-production-closure-*（仅清理 PID 已死的闭包，避免打断在运行构建）
//   2. dist-browser-probe
//   3. .tmp-runtime-fixture（含原生 node 二进制）
//   4. GameBuddy.WindowsStaleLockReclaimer.exe
//   5. 临时 tsconfig.*.json（白名单之外的；白名单=tsconfig.json/production/test.json，被 scripts 引用）
//   6. 孤儿空探测目录 tools/stardew-portfolio-*-content-probe
//   7. 重定向调试日志（_*.log、*.txt，仅 host/ 根）
//
// 明确不处理：host/dist-* 散落目录（并行 lane 可能在使用）、host/native/*/bin|obj、
// host/dist（generations 产品产物）、host/dist-test（测试基础设施）。
import { readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const host = join(root, "host");
const KEEP_TSCONFIGS = new Set(["tsconfig.json", "tsconfig.production.json", "tsconfig.test.json"]);

let freedBytes = 0;
const removed = [];
const warnings = [];

function freed(entryPath) {
  try {
    const st = statSync(entryPath);
    if (st.isDirectory()) {
      let s = 0;
      const walk = (p) => {
        for (const e of readdirSync(p, { withFileTypes: true })) {
          const f = join(p, e.name);
          if (e.isDirectory()) walk(f);
          else s += statSync(f).size;
        }
      };
      walk(entryPath);
      return s;
    }
    return st.size;
  } catch {
    return 0;
  }
}

function remove(entryPath, label) {
  if (!existsSync(entryPath)) return;
  freedBytes += freed(entryPath);
  rmSync(entryPath, { recursive: true, force: true });
  removed.push(label);
}

// PID 存活检查（Windows：process.kill(pid, 0) 抛 ESRCH 表示不存在）
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM"; // 存在但无权限
  }
}

// 1. 闭包：名字形如 .dist-production-closure-<pid>-<hash>
for (const name of readdirSync(host)) {
  const m = /^\.dist-production-closure-(\d+)-/.exec(name);
  if (!m) continue;
  const pid = Number(m[1]);
  if (pidAlive(pid)) {
    warnings.push(`${name} → PID ${pid} 仍存活, 跳过`);
    continue;
  }
  remove(join(host, name), name);
}

// 2-4. 单项
remove(join(host, "dist-browser-probe"), "dist-browser-probe");
remove(join(host, ".tmp-runtime-fixture"), ".tmp-runtime-fixture");
remove(join(host, "GameBuddy.WindowsStaleLockReclaimer.exe"), "GameBuddy.WindowsStaleLockReclaimer.exe");

// 5. 临时 tsconfig
for (const name of readdirSync(host)) {
  if (!/^tsconfig\.\w.*\.json$/.test(name)) continue;
  if (KEEP_TSCONFIGS.has(name)) continue;
  if (!/\.tmp\.json$/.test(name) && existsSync(join(host, name))) remove(join(host, name), name);
}

// 6. 孤儿探测目录
for (const name of ["stardew-portfolio-enter-mine-content-probe", "stardew-portfolio-m8-mine-route-content-probe"]) {
  remove(join(root, "tools", name), `tools/${name}`);
}

// 7. 重定向日志（host/ 根）
for (const name of readdirSync(host)) {
  if (/^(_.*\.log|.*\.txt)$/.test(name)) remove(join(host, name), name);
}

console.log(`已释放 ${(freedBytes / 1048576).toFixed(1)} MB`);
console.log(`已删除 ${removed.length} 项:`);
for (const r of removed) console.log(`  - ${r}`);
if (warnings.length) {
  console.log(`\n跳过 ${warnings.length} 项（外部仍在使用）:`);
  for (const w of warnings) console.log(`  ! ${w}`);
}
if (!removed.length && !warnings.length) console.log("无事可做。");