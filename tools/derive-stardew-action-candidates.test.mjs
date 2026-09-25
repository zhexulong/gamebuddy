import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * 候选 action 派生的测试。
 *
 * 保护三件事：
 *   1. 单位是 (出口, 实现类)：`placementAction` 有 10 个实现类，
 *      它们对账到 4 个不同 action —— 方法级单位做不到这一点。
 *   2. 已注册 seam 必须全部进入枚举（早期版本手写方法名漏了 12/36）。
 *   3. 三类输出的划分正确，且候选不被当成"要做的 action"。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SOURCE_ROOT = path.join(ROOT, "ref", "external", "StardewValleyDecompiled", "Stardew Valley");
const REGISTER = path.join(
  ROOT,
  "integrations",
  "stardew",
  "action-development",
  "contracts",
  "generated",
  "native-multiplayer-sensitivity.v1.json",
);
const execFileAsync = promisify(execFile);

let cached = null;
async function derive() {
  if (cached) return cached;
  const out = path.join(HERE, `.tmp-candidates-${process.pid}.json`);
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      path.join(HERE, "derive-stardew-action-candidates.mjs"),
      "--source-root",
      SOURCE_ROOT,
      "--action-register",
      REGISTER,
      "--out",
      out,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: ROOT },
  );
  cached = JSON.parse(await readFile(out, "utf8"));
  assert.ok(JSON.parse(stdout).state === "written");
  await rm(out, { force: true });
  return cached;
}

test("单位是 (出口, 实现类)，不是原生方法", async () => {
  const a = await derive();
  assert.equal(a.artifactKind, "stardew_action_candidate_derivation");
  assert.equal(a.unit, "(native_exit, implementing_class)");
  // placementAction 有多个实现类，正是"一个方法不等于一个 action"的证据
  const placement = a.matched.filter((c) => c.member === "placementAction");
  assert.ok(placement.length >= 1, "placementAction 应出现在已匹配里");
  const allPlacementUnits = [...a.matched, ...a.unmatchedCandidates, ...a.rejectedUnits].filter(
    (c) => c.member === "placementAction",
  );
  assert.equal(
    allPlacementUnits.length,
    10,
    `placementAction 应对应 10 个实现类（Object/CrabPot/Furniture/WoodChipper/Torch/BedFurniture/Chest/FishTankFurniture/Mannequin/Wallpaper），实测 ${allPlacementUnits.length}`,
  );
  // 其中 6 个是候选、4 个被拒 —— 证明方法级单位会把它们混为一谈
  const placementCandidates = [...a.matched, ...a.unmatchedCandidates].filter((c) => c.member === "placementAction");
  const placementRejected = a.rejectedUnits.filter((c) => c.member === "placementAction");
  assert.equal(placementCandidates.length, 6);
  assert.equal(placementRejected.length, 4);
});

test("已注册的 36 个 native seam 全部进入枚举（不得再漏）", async () => {
  const a = await derive();
  const register = JSON.parse(await readFile(REGISTER, "utf8"));
  const memberOf = (sig) => {
    const p = sig.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
    return p ? p[p.length - 1].replace(/\s*\($/, "") : sig.trim().split(/\s+/).pop();
  };
  const seams = new Set();
  for (const action of register.actions)
    for (const seam of action.seams ?? []) if (seam.kind === "native") seams.add(memberOf(seam.signature));

  const considered = new Set([
    ...a.matched.map((c) => c.member),
    ...a.unmatchedCandidates.map((c) => c.member),
    ...a.rejectedUnits.map((c) => c.member),
    ...a.registeredWithoutCandidateSeam.map((c) => c.member),
  ]);
  const missing = [...seams].filter((m) => !considered.has(m));
  assert.deepEqual(missing, [], `这些已注册 seam 未进入枚举：${missing.join(", ")}`);
});

test("三类输出互斥且覆盖全部被考虑的实现", async () => {
  const a = await derive();
  const { counts } = a;
  assert.equal(
    counts.matchedWithRegistered + counts.unmatchedCandidateUnits,
    counts.candidatesAfterNinePredicates,
    "候选必须恰好分为已匹配 / 未匹配两类",
  );
  assert.equal(
    counts.candidatesAfterNinePredicates + counts.rejectedByPredicates,
    counts.implementationsConsidered,
    "全部被考虑的实现 = 候选 + 被拒",
  );
});

test("已注册但九谓词拒的 seam 都被列出，供解释而非当作缺陷", async () => {
  const a = await derive();
  assert.ok(a.registeredWithoutCandidateSeam.length > 0, "应存在此类条目");
  const ids = a.registeredWithoutCandidateSeam.map((r) => r.actionId);
  // 已知的内部方法直调型 action
  for (const expected of ["till_soil", "chop_tree_source", "pet_animal"])
    assert.ok(ids.includes(expected), `${expected} 应在此列（终态跨委托或 Mod 直调内部方法）`);
  // 每个都要带 member 与 file，便于打开核对
  for (const r of a.registeredWithoutCandidateSeam) {
    assert.ok(r.member && r.file, `${r.actionId} 必须有 member 与 file`);
  }
});

test("被拒单元都带可追溯的理由（谓词或 no_branch）", async () => {
  const a = await derive();
  for (const r of a.rejectedUnits) {
    const hasReason = r.rejectedBy.length > 0 || r.rejectedByFallback !== null || r.extractionError !== null;
    assert.ok(hasReason, `${r.member}@${r.class} 必须有被拒谓词、no_branch 或提取错误`);
  }
  // 单表达式方法（无分支）必须用 no_branch 标记，而不是静默无理由
  const noBranch = a.rejectedUnits.filter((r) => r.rejectedByFallback === "no_branch");
  assert.ok(noBranch.length > 0, "应存在无分支的单表达式方法");
  for (const r of noBranch) assert.deepEqual(r.rejectedBy, []);
});

test("未匹配候选带源码锚点与写入字段，供审查", async () => {
  const a = await derive();
  for (const c of a.unmatchedCandidates) {
    assert.ok(c.file.endsWith(".cs"), `${c.member} 必须有源码文件`);
    assert.ok(c.line > 0, `${c.member} 必须有行号`);
    assert.ok(c.candidateBranchCount > 0, `${c.member} 必须有候选分支`);
  }
  // 抽查：PetBowl 给宠物碗加水是真实候选
  const petBowl = a.unmatchedCandidates.find((c) => c.class === "PetBowl");
  assert.ok(petBowl, "PetBowl.performToolAction 应在未匹配候选里");
  assert.ok(
    petBowl.writes.some((w) => /watered/.test(w)),
    "PetBowl 的候选分支应写 watered.Value",
  );
});

test("产物声明候选不是要做的 action", async () => {
  const a = await derive();
  for (const g of [
    "no_action_identity_inferred",
    "unit_is_exit_x_class_not_player_intent",
    "nine_predicates_reject_but_do_not_authorize",
    "unmatched_candidate_is_a_review_input_not_a_required_action",
    "registered_without_candidate_usually_means_mod_calls_the_internal_method_directly",
  ])
    assert.ok(a.nonGuarantees.includes(g), `产物必须声明 ${g}`);
});
