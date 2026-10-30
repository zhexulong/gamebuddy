// check-hot-file-falsifier 的假命题测试：每条断言都必须在真实注入的违规上先红。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MOD = pathToFileURL("E:/projects/ai-game-companion/tools/check-hot-file-falsifier.mjs").href;
const { assess, deriveHotFiles, hasFalsifier, POLICY, parseCli } = await import(MOD);

const checks = [];
function check(name, fn) {
  try {
    const ok = fn();
    checks.push(`${ok ? "PASS" : "FAIL"} ${name}`);
    return ok;
  } catch (e) {
    checks.push(`FAIL ${name} threw ${String(e && e.message)}`);
    return false;
  }
}

// --- falsifier 识别：真实仓里的写法必须被认，空话必须不被认
check('识别 "Falsifier: ..." 写法', () =>
  hasFalsifier("Body text.\nFalsifier: reverting the guard fails tests/foo.spec.ts"),
);
check('识别 "Verified red first" 写法', () =>
  hasFalsifier("Verified red first: disabling the guard fails 3 of 12 cases."),
);
check("识别中文「先红」", () => hasFalsifier("先红：注入非法值后该断言失败。"));
check("空 body 不认", () => hasFalsifier("") === false);
check('只有一句"已修复"不认', () => hasFalsifier("Fixed the bug.") === false);
check("短于门槛的关键词不认", () => hasFalsifier("falsifier") === false);

// --- 判定矩阵：热文件 + 无 falsifier 必须 needsFalsifier=true
const hot = new Map([
  ["a.ts", 30],
  ["b.ts", 12],
]);
check("热文件+无判据 => 需要判据", () => assess({ hot, paths: ["a.ts"], body: "Fixed." }).needsFalsifier === true);
check(
  "热文件+有判据 => 不需要",
  () => assess({ hot, paths: ["a.ts"], body: "Falsifier: reverting it fails x.test.ts" }).needsFalsifier === false,
);
check("冷文件+无判据 => 不需要", () => assess({ hot, paths: ["cold.ts"], body: "Fixed." }).needsFalsifier === false);
check("无改动 => 不需要", () => assess({ hot, paths: [], body: "" }).needsFalsifier === false);
check("热文件计数带出", () => {
  const r = assess({ hot, paths: ["a.ts", "cold.ts"], body: "" });
  return r.hotFilesTouched.length === 1 && r.hotFilesTouched[0].fixCommits === 30;
});

// --- 派生必须来自历史，不是手维护名单：造一个假仓，让同一个文件在 fix 提交里出现足够次
const fake = fs.mkdtempSync(path.join(os.tmpdir(), "hotfix-"));
const g = (args) => execFileSync("git", args, { cwd: fake, encoding: "utf8" });
g(["init", "-q"]);
g(["config", "user.email", "t@t"]);
g(["config", "user.name", "t"]);
fs.writeFileSync(path.join(fake, "target.ts"), "export const a = 1;\n");
g(["add", "."]);
g(["commit", "-q", "-m", "feat: initial"]);

const N = POLICY.hotFixCommits;
for (let i = 0; i < N; i += 1) {
  fs.writeFileSync(path.join(fake, `filler${i}.ts`), `export const f${i} = ${i};\n`);
  fs.appendFileSync(path.join(fake, "target.ts"), `export const x${i} = ${i};\n`);
  g(["add", "."]);
  g(["commit", "-q", "-m", `fix(x): touch target ${i}`]);
}
const derived = deriveHotFiles({ cwd: fake, windowDays: 90, hotFixCommits: N });
check(`派生把 target.ts 选为热文件（${N} 次 fix）`, () => derived.hot.get("target.ts") === N);
check("派生不把只出现一次的 filler 选进来", () => (derived.hot.get("filler0.ts") ?? 0) < N);

// --- 参数解析
check("--enforce 被解析", () => parseCli(["--enforce"]).enforce === true);
check("--range 关闭 staged", () => {
  const o = parseCli(["--range", "HEAD~1"]);
  return o.staged === false && o.range === "HEAD~1";
});
check("未知参数抛错", () => {
  try {
    parseCli(["--nope"]);
    return false;
  } catch {
    return true;
  }
});

console.log(checks.join("\n"));
const failed = checks.filter((c) => c.startsWith("FAIL"));
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
