// check-workspace-debris.mjs — CI 工作区零残留门禁。
// 执行 git status --porcelain，任何未跟踪的临时文件使检查变红。
// CI checkout 恒绿（只含跟踪文件 + install 产物在缓存目录）；本机跑可抓散落垃圾。
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
const lines = out.split("\n").filter(Boolean);
if (lines.length === 0) {
  console.log("check-workspace-debris: 工作区零未跟踪/未提交残留 ✓");
  process.exit(0);
}
console.error("check-workspace-debris: 检测到未跟踪/未提交残留文件：");
for (const l of lines) console.error("  " + l);
console.error("\n请在提交前清理临时文件（可放入 scripts/scratch/ 或删除）。");
process.exit(1);