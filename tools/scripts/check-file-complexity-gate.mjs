// check-file-complexity-gate.mjs — 复杂度棘轮：核心文件只许瘦身、禁止膨胀。
// 行数上限取"当前基线 + 少量余量"：新变更一旦超过上限（意味着核心文件仍在
// 膨胀而非收敛）门禁立即红。上限只随文件实际瘦身而下调，永不因膨胀上调。
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// 基线（行，含尾行）：2026-10-03 冻结。调低许可文件；调高必须先经架构 owner
// 批准并在本文件注释记录理由。
const CEILINGS = new Map([
  ["integrations/stardew/ModEntry.cs", 2800], // 夹具剥离后生产区（原 6943；夹具已至 Fixtures.cs）
  ["integrations/stardew/ModEntry.Fixtures.cs", 4500], // 夹具搬移区（机械切分，禁止再加业务）
  ["host/src/continuity-semantic-store/continuity-semantic-production-store.ts", 4400], // 单调收紧目标 ≤4000
  ["host/src/protocol.ts", 4400], // 表驱动重构目标 ≤3000
  ["dialogue-web/src/components/ComposedReferenceGameApp.tsx", 1450], // 状态机收敛目标 ≤1200
]);

let failed = false;
for (const [rel, ceiling] of CEILINGS) {
  const full = join(root, rel);
  let lines;
  try {
    lines = readFileSync(full, "utf8").split("\n").length;
  } catch {
    console.error(`✖ ${rel}: 文件不存在（被删除应确认是否仍有引用）`);
    failed = true;
    continue;
  }
  const verdict = lines <= ceiling ? "✓" : "✖";
  if (lines > ceiling) failed = true;
  console.log(`${verdict} ${rel}: ${lines} 行 / 上限 ${ceiling}`);
}
if (failed) {
  console.error("\n复杂度棘轮失败：核心文件行数超上限。只允许瘦身；膨胀需架构 owner 批准。");
  process.exit(1);
}
console.log("\n复杂度棘轮通过：全部核心文件未超基线。");