#!/usr/bin/env node
/**
 * 把「未覆盖出口展开」渲染成可审查的 Markdown 表。
 *
 * 目的：让每一行都带全部证据（实现、行号、候选分支条件、写入字段、被拒谓词、
 * 关联 intent），构成可直接核对与签字的裁定底稿。本工具不产出裁定结论——
 * 「新 primitive / 已有 action 扩展 / 应排除」三选一必须由审查者填写。
 *
 * 用法：
 *   node tools/render-stardew-uncovered-exit-table.mjs \
 *     --expansion <expansion.json> [--out <file.md>]
 */

import { readFile, writeFile } from "node:fs/promises";

function fail(code, message) {
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!["--expansion", "--out"].includes(a)) fail("arguments_invalid", `Bad argument ${a}.`);
    const v = argv[++i];
    if (!v) fail("arguments_invalid", `Missing value for ${a}.`);
    out[a.slice(2)] = v;
  }
  if (!out.expansion) fail("arguments_required", "--expansion is required.");
  return out;
}

const options = parseArgs(process.argv.slice(2));
const artifact = JSON.parse(await readFile(options.expansion, "utf8"));

const esc = (s) =>
  String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
const trim = (s, n) => (String(s ?? "").length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ""));

const lines = [];
lines.push("# Stardew 未覆盖出口 —— 逐实现裁定底稿");
lines.push("");
lines.push("> 由 `tools/derive-stardew-uncovered-exit-expansion.mjs` 的产物渲染。");
lines.push("> 每行 = 一个原生实现；`候选` 列为九谓词判定的结果。");
lines.push("> **裁定列留空，须由审查者填写**：`新 primitive` / `已有 action 扩展` / `应排除`。");
lines.push("");
lines.push(
  `总计 ${artifact.counts.uncoveredExits} 个未覆盖出口 / ${artifact.counts.totalImplementors} 个实现 / ${artifact.counts.totalCandidateUnits} 个产出候选的实现。`,
);
lines.push("");
lines.push(
  "形态分布：" +
    Object.entries(artifact.counts)
      .filter(([k]) => ["singleImplementor", "multiImplementor", "interpreter"].includes(k))
      .map(([k, v]) => `\`${k}\`=${v}`)
      .join(" · "),
);
lines.push("");

// 汇总表
lines.push("## 汇总");
lines.push("");
lines.push("| 出口 | 形态 | 实现数 | 候选实现 | 菜单绑定 | 参考 intent |");
lines.push("|---|---|---|---|---|---|");
for (const e of artifact.expansions) {
  const intents = e.referenceIntents.length
    ? e.referenceIntents
        .map((i) => `${i.intentVariantId}(${i.coverageState}${i.coveredByRegisteredAction ? ",有实现" : ""})`)
        .join("; ")
    : "—";
  lines.push(
    `| \`${esc(e.nativeMember)}\` | ${esc(e.shape)} | ${e.implementorCount} | ${e.candidateUnitCount} | ${e.menuBinding.bound === true ? "是" : e.menuBinding.bound === false ? "否" : "未判定"} | ${esc(trim(intents, 120))} |`,
  );
}
lines.push("");

// 逐出口明细
for (const e of artifact.expansions) {
  lines.push(`## \`${esc(e.nativeMember)}\``);
  lines.push("");
  lines.push(`- 形态：\`${esc(e.shape)}\`（${e.implementorCount} 个实现，${e.candidateUnitCount} 个产出候选）`);
  lines.push(`- 首个定义：\`${esc(e.definedIn[0] ?? "?")}\``);
  if (e.menuBinding.signals?.length)
    lines.push(`- 菜单信号：${e.menuBinding.signals.map((s) => `\`${esc(s)}\``).join(", ")}`);
  if (e.referenceIntents.length)
    lines.push(
      `- 参考 intent：${e.referenceIntents.map((i) => `\`${esc(i.intentVariantId)}\`(${i.coverageState})`).join(", ")}`,
    );
  lines.push("");
  lines.push("| 实现 | 行 | sel | 分支 | 候选 | 被拒谓词 | 候选分支（条件 → 写入） | 裁定 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const u of e.units) {
    const branchText = u.candidateBranches.length
      ? u.candidateBranches
          .map(
            (b) =>
              `${trim(b.condition, 40)} → ${b.writes.length ? b.writes.join("/") : b.delegates.join("/") || "委托"}`,
          )
          .join("<br>")
      : u.extractionError
        ? `提取失败：${trim(u.extractionError, 40)}`
        : "—";
    lines.push(
      `| \`${esc(u.class)}\` | ${u.methodLine} | ${u.selectorCount} | ${u.branchCount} | ${u.candidateCount > 0 ? `✅ ${u.candidateCount}` : "❌"} | ${esc(u.rejectedBy.join(",") || "—")} | ${esc(trim(branchText, 160))} | |`,
    );
  }
  lines.push("");
}

lines.push("## 产物声明");
lines.push("");
for (const g of artifact.nonGuarantees) lines.push(`- \`${g}\``);
lines.push("");

const markdown = `${lines.join("\n")}\n`;
if (options.out) {
  await writeFile(options.out, markdown);
  process.stdout.write(
    `${JSON.stringify({ state: "written", out: options.out, exits: artifact.expansions.length, implementors: artifact.counts.totalImplementors })}\n`,
  );
} else {
  process.stdout.write(markdown);
}
