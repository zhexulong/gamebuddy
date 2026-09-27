import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * 裁定底稿渲染的测试。
 *
 * 保护两点：
 *   1. 每个实现一行，且带全部证据（文件、行号、selector 数、被拒谓词、候选分支）
 *   2. 「裁定」列必须留空 —— 本工具不产出结论
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..", "..");
const execFileAsync = promisify(execFile);

async function render(expansion) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(HERE, "..", "src", "analysis", "stardew-uncovered-exit-table.mjs"), "--expansion", expansion],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, cwd: ROOT },
  );
  return stdout;
}

const EXPANSION = path.join(HERE, ".tmp-render-expansion.test.json");

// 最小可控输入：2 个出口，3 个实现
const FIXTURE = {
  artifactKind: "stardew_uncovered_exit_expansion",
  schemaVersion: 1,
  counts: {
    uncoveredExits: 2,
    singleImplementor: 1,
    multiImplementor: 0,
    interpreter: 1,
    totalImplementors: 3,
    totalCandidateUnits: 1,
  },
  expansions: [
    {
      nativeMember: "rotate",
      depth: 1,
      definedIn: ["StardewValley.Objects/Furniture.cs:1157"],
      menuBinding: { bound: false, signals: [] },
      referenceIntents: [
        {
          intentVariantId: "move_or_rotate_furniture_variant",
          coverageState: "planned",
          coveredByRegisteredAction: false,
        },
      ],
      shape: "single_implementor",
      implementorCount: 1,
      candidateUnitCount: 1,
      units: [
        {
          class: "Furniture",
          file: "StardewValley.Objects/Furniture.cs",
          methodLine: 1157,
          isOverride: false,
          isVirtual: true,
          selectorCount: 0,
          branchCount: 1,
          candidateCount: 1,
          rejectedBy: [],
          candidateBranches: [
            { key: "L1159/then", condition: "(int)rotations >= 2", writes: ["currentRotation.Value"], delegates: [] },
          ],
          extractionError: null,
        },
      ],
    },
    {
      nativeMember: "checkForAction",
      depth: 2,
      definedIn: ["StardewValley/Fence.cs:300"],
      menuBinding: { bound: false, signals: [] },
      referenceIntents: [],
      shape: "interpreter",
      implementorCount: 2,
      candidateUnitCount: 0,
      units: [
        {
          class: "Fence",
          file: "StardewValley/Fence.cs",
          methodLine: 300,
          isOverride: true,
          isVirtual: false,
          selectorCount: 0,
          branchCount: 4,
          candidateCount: 0,
          rejectedBy: ["P4"],
          candidateBranches: [],
          extractionError: null,
        },
        {
          class: "Object",
          file: "StardewValley/Object.cs",
          methodLine: 3784,
          isOverride: false,
          isVirtual: true,
          selectorCount: 25,
          branchCount: 20,
          candidateCount: 0,
          rejectedBy: ["P2", "P4", "P6"],
          candidateBranches: [],
          extractionError: null,
        },
      ],
    },
  ],
  nonGuarantees: [
    "no_action_identity_inferred",
    "one_implementor_does_not_imply_one_action",
    "selector_count_is_a_heuristic_for_interpreter_shape_not_a_proof",
    "candidate_branch_is_a_derivation_input_not_a_publishable_action",
  ],
};

test("渲染每个实现一行，并保留全部证据", async () => {
  await writeFile(EXPANSION, JSON.stringify(FIXTURE));
  try {
    const md = await render(EXPANSION);
    // 三行实现
    assert.ok(md.includes("| `Furniture` | 1157 | 0 | 1 | ✅ 1 |"), "rotate 的证据行");
    assert.ok(md.includes("| `Fence` | 300 | 0 | 4 | ❌ | P4 |"), "Fence 的证据行（含被拒谓词）");
    assert.ok(md.includes("| `Object` | 3784 | 25 | 20 | ❌ | P2,P4,P6 |"), "Object 的 selector 数必须保留");
    // 候选分支条件与写入
    assert.ok(md.includes("(int)rotations >= 2"), "候选分支条件必须出现");
    assert.ok(md.includes("currentRotation.Value"), "写入字段必须出现");
    // 参考 intent 与形态
    assert.ok(md.includes("move_or_rotate_furniture_variant(planned)"));
    assert.ok(md.includes("`interpreter`=1"));
    assert.ok(md.includes("`singleImplementor`=1"));
    // 产物声明
    for (const g of FIXTURE.nonGuarantees) assert.ok(md.includes(`\`${g}\``), `应声明 ${g}`);
  } finally {
    await rm(EXPANSION, { force: true });
  }
});

test("裁定列必须留空——本工具不产出结论", async () => {
  await writeFile(EXPANSION, JSON.stringify(FIXTURE));
  try {
    const md = await render(EXPANSION);
    // 表头必须存在裁定列
    assert.ok(md.includes("| 裁定 |"), "必须有裁定列");
    // 任何数据行的最后一格都必须为空（除表头与分隔行）
    const dataRows = md.split("\n").filter((l) => l.startsWith("| `") && /^\| `(Furniture|Fence|Object)`/.test(l));
    assert.ok(dataRows.length >= 3, "应至少有 3 个实现数据行");
    for (const row of dataRows) assert.ok(row.trim().endsWith("| |"), `裁定格必须为空: ${row.slice(0, 60)}`);
  } finally {
    await rm(EXPANSION, { force: true });
  }
});

test("渲染的是产物内容，不重新读取源码（纯函数式）", async () => {
  await writeFile(EXPANSION, JSON.stringify(FIXTURE));
  try {
    const a = await render(EXPANSION);
    const b = await render(EXPANSION);
    assert.equal(a, b, "同一输入必须产出同一输出");
  } finally {
    await rm(EXPANSION, { force: true });
  }
});

test("声明文档必须提示裁定须由审查者填写", async () => {
  await writeFile(EXPANSION, JSON.stringify(FIXTURE));
  try {
    const md = await render(EXPANSION);
    assert.ok(md.includes("裁定列留空"), "必须说明裁定列留空");
    assert.ok(md.includes("新 primitive"), "必须列出可选裁定值");
    assert.ok(md.includes("应排除"), "必须列出可选裁定值");
  } finally {
    await rm(EXPANSION, { force: true });
  }
});
