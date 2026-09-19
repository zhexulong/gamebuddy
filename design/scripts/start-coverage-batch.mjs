#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const inventoryPath = path.join(root, "migration/document-inventory.csv");
const coveragePath = path.join(root, "migration/semantic-coverage.csv");
const reportPath = path.join(root, "migration/coverage-batch-001-triage.md");
const selected = new Set([
  "00_CORE_PRODUCT.md",
  "03_AGENT_RUNTIME.md",
  "04_CONTEXT_MEMORY.md",
  "05_VOICE_MULTIMODAL.md",
  "10_GAME_ACTION_AUTHORIZATION_AND_DISCLOSURE.md",
  "11_GAMEPLAY_CAPABILITY_COVERAGE.md",
  "13_STARDEW_NATIVE_PROVENANCE.md",
  "16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md",
  "78_GAME_PIPELINE_RELEASE_ARCHITECTURE.md",
  "90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md",
  "97_COMMUNITY_GAME_CONNECTOR_ARCHITECTURE.md",
]);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell.replace(/\r$/, "")); if (row.some(Boolean)) rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  return rows;
}
function csvCell(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }

const inventory = parseCsv(await readFile(inventoryPath, "utf8"));
const inventoryHeader = inventory.shift();
const inventoryColumns = Object.fromEntries(inventoryHeader.map((name, index) => [name, index]));
const coverage = parseCsv(await readFile(coveragePath, "utf8"));
const coverageHeader = coverage.shift();
const columns = Object.fromEntries(coverageHeader.map((name, index) => [name, index]));
const report = [
  "---",
  "id: MIGRATION-COVERAGE-BATCH-001",
  "type: migration-record",
  "status: current",
  "owner: documentation",
  "---",
  "",
  "# Coverage Batch 001：核心长期约束初步分流",
  "",
  "> 本批次只把章节标为 `in-review`，不宣称任何章节已覆盖。每条章节必须经过逐章阅读、current owner 对照和独立 review 后，才能进入 `reviewed` 或 `accepted`。",
  "",
  "## 范围",
  "",
];
let changed = 0;
for (const row of coverage) {
  const source = row[columns.old_path];
  if (!selected.has(source)) continue;
  row[columns.review_status] = "in-review";
  row[columns.open_gap] = "章节已进入 Batch 001；保留约束、删除理由和最终 current owner 尚未完成逐章确认。";
  row[columns.review_evidence] = "migration/coverage-batch-001-triage.md；待补 current 文档章节级引用";
  changed += 1;
}
for (const source of [...selected].sort()) {
  const file = path.join(root, "archive/legacy-sources", source);
  const text = await readFile(file, "utf8");
  const sections = text.split(/\r?\n/).filter((line) => /^#{1,6}\s+/.test(line)).map((line) => line.replace(/^#+\s+/, "").trim());
  const inventoryRow = inventory.find((row) => row[inventoryColumns.old_path] === source);
  const domain = inventoryRow?.[inventoryColumns.domain] ?? "unknown";
  report.push(`### ${source}`, "", `- 领域候选：\`${domain}\``, "- 处置：`in-review`", "- 目标 current owner：待逐章确认", "- 已保留约束：待逐章核对", "- 有意删除：待判断", "- 当前 gap：不能把旧章节存在等同于新文档覆盖", "", "| 旧章节 | 审计状态 | 待核对 current owner |", "|---|---|---|");
  for (const section of sections) report.push(`| ${section.replaceAll("|", "\\|")} | in-review | 待补章节级证据 |`);
  report.push("");
}
report.push("## 本批次停止条件", "", "- 每个列出的章节都完成 current owner、保留约束、删除理由和 gap 判断；", "- 任何无法证明的内容保持 `gap`，不以摘要替代；", "- 完成后由领域 owner 和独立 reviewer 复核；", "- 仅在复核通过后更新 ledger 状态。", "");
await writeFile(coveragePath, `${[coverageHeader, ...coverage].map((row) => row.map(csvCell).join(",")).join("\n")}\n`, "utf8");
await writeFile(reportPath, report.join("\n"), "utf8");
execFileSync(process.execPath, [path.join(root, "scripts/update-coverage-summary.mjs")], { cwd: root, stdio: "inherit" });
console.log(JSON.stringify({ sources: selected.size, inReviewSections: changed, report: "migration/coverage-batch-001-triage.md" }));
