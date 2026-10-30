// commit-msg hook: 提交正文写完之后才有"判据"可读，所以热文件 falsifier 的提示放在这里。
//
// 只报告、不阻断：这个仓里 68 个文件在过去 90 天各被 fix 提交触及 10 次以上，
// 而那 75.9% 的 feat→72h 内被 fix 的比率几乎全落在这一撮文件上（只碰冷文件的 feat 是 23.3%）。
// 报告的问题是"你改了这批一直在漏的文件，这次手里有没有一个能让它变红的判据"，
// 不是"你有没有按格式写提交信息"。先用报告让它暴露，等误报率被真实使用压下来再谈强制。
//
// 逃避方式是 git 自己的：`git commit --no-verify`。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const messageFile = process.argv[2];
if (!messageFile) process.exit(0);

let body = "";
try {
  body = readFileSync(messageFile, "utf8");
} catch {
  process.exit(0);
}

// 只取正文：首行是标题，标题里出现关键词不算判据（否则 "fix: falsifier gate" 会自我满足）。
const lines = body.split(/\r?\n/);
const subject = lines[0] ?? "";
const rest = lines.slice(1).join("\n");

try {
  const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  })
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);

  if (staged.length === 0) process.exit(0);

  const out = execFileSync("node", ["tools/check-hot-file-falsifier.mjs", "--json"], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  const report = JSON.parse(out);

  if (!report.hotFilesTouched || report.hotFilesTouched.length === 0) process.exit(0);

  // 用正文判定，不用标题。
  const FALSIFIER_KEYS =
    /(falsifier|seen red|red first|verified red|变红|先红|可证伪|regression proof|failing test|fails without|fails when|reverting .* fails|disabling .* fails|removing .* fails)/i;
  const present = rest.split("\n").some((line) => FALSIFIER_KEYS.test(line) && line.trim().length >= 12);

  console.log("");
  console.log(`commit-msg: 本次提交触及 ${report.hotFilesTouched.length} 个"反复修复"文件`);
  for (const h of report.hotFilesTouched.slice(0, 8)) {
    console.log(`  ${String(h.fixCommits).padStart(3)}x fix  ${h.path}`);
  }
  if (report.hotFilesTouched.length > 8) {
    console.log(`  …以及 ${report.hotFilesTouched.length - 8} 个`);
  }
  if (!present) {
    console.log("");
    console.log("commit-msg: 正文里没有可证伪的判据。");
    console.log("  补一行「哪个测试/gate 会因为这个改动变红」，例如：");
    console.log("  Falsifier: reverting the guard fails tests/foo.spec.ts (3 pass / 1 fail)");
    console.log(`  （这是报告，不阻断；标题 "${subject.slice(0, 40)}" 里的关键词不算）`);
  }
  console.log("");
} catch (error) {
  console.log(`commit-msg: 热文件报告跳过（${String(error && error.message).slice(0, 120)}）`);
}

process.exit(0);
