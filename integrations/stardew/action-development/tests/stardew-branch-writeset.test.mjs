import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createParser, extractBranches } from "../src/analysis/stardew-branch-writeset.mjs";

/**
 * Golden test：用「已注册 action 的 native seam 映射」校准分支级提取。
 *
 * 校准对象是 `integrations/stardew/action-development/contracts/generated/
 * native-multiplayer-sensitivity.v1.json` 的 `actionId → {file, signature}`——即产品
 * 实际注册的 45 个 action 及其目标版本原生入口，不是人工挑选的方法清单。
 *
 * 本测试要证明两件事：
 *   1. 提取器能对全部 45 个已注册 action 的 native seam 跑通（覆盖率断言）。
 *   2. 提取结果与已知的产品事实一致：哪些 action 的终态在原生调用内、
 *      哪些跨委托、哪些原生入口同时服务多个 action。
 *
 * 若失败：要么提取规则退化，要么产品事实变了；两者都必须人工确认，不能放宽断言。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.join(HERE, "..", "..", "..", "..", "ref", "external", "StardewValleyDecompiled", "Stardew Valley");
const REGISTER = path.join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "integrations",
  "stardew",
  "action-development",
  "contracts",
  "generated",
  "native-multiplayer-sensitivity.v1.json",
);

const parser = await createParser();
const register = JSON.parse(await readFile(REGISTER, "utf8"));

/** 注册表签名有时带完整参数表，有时只有一个方法名 */
function memberOf(signature) {
  const withParens = signature.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
  if (withParens) return withParens[withParens.length - 1].replace(/\s*\($/, "");
  return signature.trim().split(/\s+/).pop();
}

/** 对某个 action 的全部 native seam 跑提取 */
async function extractForAction(actionId) {
  const action = register.actions.find((a) => a.actionId === actionId);
  assert.ok(action, `${actionId} must be registered`);
  const seams = (action.seams ?? []).filter((s) => s.kind === "native");
  const results = [];
  for (const seam of seams) {
    const member = memberOf(seam.signature);
    const methods = await extractBranches({
      sourceRoot: SOURCE_ROOT,
      relPath: seam.file,
      memberName: member,
      parser,
    });
    results.push({
      file: seam.file,
      member,
      seamKey: `${seam.file}::${member}`,
      method: methods[0] ?? null,
    });
  }
  return { action, seams, results };
}

const candidatesOf = (r) => r.method?.branches.filter((b) => b.candidate) ?? [];

// ---- 覆盖率：全部 45 个 action 都必须可解析 ---------------------------------

test("全部已注册 action 的 native seam 都能被定位与解析", async () => {
  const failures = [];
  let nativeSeamActions = 0;
  for (const action of register.actions) {
    const seams = (action.seams ?? []).filter((s) => s.kind === "native");
    if (seams.length === 0) continue; // mod_owned seam 不在本工具范围
    nativeSeamActions += 1;
    for (const seam of seams) {
      const member = memberOf(seam.signature);
      const methods = await extractBranches({
        sourceRoot: SOURCE_ROOT,
        relPath: seam.file,
        memberName: member,
        parser,
      });
      if (methods.length === 0) failures.push(`${action.actionId}: ${seam.file}::${member}`);
    }
  }
  assert.ok(nativeSeamActions >= 34, `expected >=34 actions with native seams, got ${nativeSeamActions}`);
  assert.deepEqual(failures, [], `these seams could not be resolved: ${failures.join(", ")}`);
});

test("mod_owned seam 的 action 明确不在本工具范围（11 个）", async () => {
  const modOwned = register.actions.filter((a) => !(a.seams ?? []).some((s) => s.kind === "native"));
  // machine_inspect 在 2026-09 加入此列：其描述符声明 read-only，handler 不调任何 native，
  // 原先记录的 `GameLocation.checkAction` 断言了一个不存在的调用（由 checker 的 seam-call 轴抓获）。
  assert.equal(modOwned.length, 11, "mod_owned-only actions must be counted explicitly so coverage is not overstated");
  assert.ok(modOwned.some((a) => a.actionId === "machine_inspect"));
});

// ---- 一个 native seam 服务多个 action：action identity 不由 seam 决定 -------

test("GameLocation.checkAction 承载 5 个已注册 action（machine_inspect 已移出）", async () => {
  const users = [];
  for (const action of register.actions)
    for (const seam of (action.seams ?? []).filter((s) => s.kind === "native"))
      if (seam.file === "StardewValley/GameLocation.cs" && memberOf(seam.signature) === "checkAction")
        users.push(action.actionId);
  assert.equal(users.length, 5, `expected 5 actions on checkAction, got ${users.length}: ${users.join(", ")}`);
  assert.ok(users.includes("machine_load") && users.includes("collect_crab_pot_output"));
  // machine_inspect 不再在此列：它读机器状态、不调 native，故记为 mod_owned
  assert.ok(!users.includes("machine_inspect"));
});

test("Object.placementAction 同时服务 5 个已注册 action", async () => {
  const users = [];
  for (const action of register.actions)
    for (const seam of (action.seams ?? []).filter((s) => s.kind === "native"))
      if (seam.file === "StardewValley/Object.cs" && memberOf(seam.signature) === "placementAction")
        users.push(action.actionId);
  // place_wood_fence 于本次修复中加入：原先引用纯判断的 canBePlacedHere，
  // 现引用真实变异点 placementAction（见 audit-stardew-action-seam-terminals.test.mjs）。
  assert.deepEqual(users.sort(), [
    "fertilize_tile",
    "place_crab_pot",
    "place_wood_fence",
    "plant_sapling",
    "plant_seed",
  ]);
});

// ---- 终态直写：refill 与 ship_item 应产出候选分支 --------------------------

test("refill_watering_can：终态直写，产出候选分支", async () => {
  const { results } = await extractForAction("refill_watering_can");
  const r = results[0];
  const cands = candidatesOf(r);
  assert.equal(cands.length, 1, "refill 应有且仅有一个候选分支");
  /** 属性名在重反编译后可能是 WaterLeft（属性）或 waterLeft（字段） */
  assert.ok(
    cands[0].writes.some((w) => /waterLeft/i.test(w)),
    `refill 的终态应写 waterLeft/WaterLeft，实测 ${JSON.stringify(cands[0].writes)}`,
  );
});

test("ship_item：终态直写，产出候选分支", async () => {
  const { results } = await extractForAction("ship_item");
  const withCandidate = results.filter((r) => candidatesOf(r).length > 0);
  assert.ok(withCandidate.length >= 1, "ship_item 应至少有一个 seam 产出候选分支");
});

// ---- 终态跨委托：工具类动作的 native 入口不写世界终态 ----------------------

test("till_soil：Hoe.DoFunction 不写世界终态，委托异质 → 无候选", async () => {
  const { results } = await extractForAction("till_soil");
  assert.equal(candidatesOf(results[0]).length, 0, "Hoe.DoFunction 不应产出候选分支");
  const reasons = new Set(results[0].method.branches.flatMap((b) => b.rejectedBy));
  assert.ok(reasons.has("P9"), "应因异质委托被拒");
});

test("chop_tree_source / chop_stump 共用 Axe.DoFunction 且都不产出候选", async () => {
  for (const id of ["chop_tree_source", "chop_stump"]) {
    const { results } = await extractForAction(id);
    assert.equal(results[0].seamKey, "StardewValley.Tools/Axe.cs::DoFunction");
    assert.equal(candidatesOf(results[0]).length, 0, `${id} 不应产出候选（含 stump 是另一轮生命周期）`);
  }
});

test("harvest_crop / scythe_crop：HoeDirt 侧入口不产出候选（输入或委托约束）", async () => {
  for (const [id, member] of [
    ["harvest_crop", "performUseAction"],
    ["scythe_crop", "performToolAction"],
  ]) {
    const { results } = await extractForAction(id);
    assert.equal(results[0].member, member);
    assert.equal(candidatesOf(results[0]).length, 0, `${id} 不应产出候选`);
  }
});

test("pet_animal：Pet.checkAction 的抚摸分支被 RNG 拒；戴帽分支是另一个候选", async () => {
  const { results } = await extractForAction("pet_animal");
  const m = results[0].method;
  const reasons = new Set(m.branches.flatMap((b) => b.rejectedBy));
  // 抚摸分支：lastPetDay 写入受 P7（grantedFriendshipForPet 的 RNG 语义）拒绝
  assert.ok(reasons.has("P7"), `抚摸分支应因随机性被拒，实测 ${[...reasons].join(",")}`);
  assert.ok(reasons.has("P4"), "无终态的 routing 分支应被拒");
  // 修正 P1（手持物消耗不算多持有）后，`hat.Value + who.Items[...]` 的戴帽分支成为候选
  // —— 这是真实动作（给宠物戴帽），不是 pet_animal 的抚摸语义
  const hatBranch = m.branches.find((b) => b.candidate && b.writes.some((w) => /hat\.Value/.test(w)));
  assert.ok(hatBranch, "给宠物戴帽的分支应成为候选（P1 修正后）");
});

// ---- 18_ 工具 ledger 八条：保留为回归子集 ---------------------------------

test("回归子集：18_ ledger 的八条工具 source summary 仍复现其裁定方向", async () => {
  const cases = [
    ["StardewValley.Tools/Hoe.cs", "DoFunction", 0],
    ["StardewValley.Tools/Axe.cs", "DoFunction", 0],
    ["StardewValley.Tools/Pickaxe.cs", "DoFunction", 0],
    ["StardewValley.Tools/Pan.cs", "DoFunction", 0],
    ["StardewValley.Tools/FishingRod.cs", "DoFunction", 0],
    ["StardewValley.Tools/MeleeWeapon.cs", "animateSpecialMove", 0],
  ];
  for (const [relPath, member, expected] of cases) {
    const methods = await extractBranches({ sourceRoot: SOURCE_ROOT, relPath, memberName: member, parser });
    assert.equal(methods.length, 1, `${relPath}::${member} must exist`);
    assert.equal(
      methods[0].branches.filter((b) => b.candidate).length,
      expected,
      `${relPath}::${member} 应被拒（18_ ledger 裁定）`,
    );
  }
});

// ---- WateringCan 的分支切分：一个方法两个 action --------------------------

test("WateringCan.DoFunction 切出 refill 与 apply 两个极大分支区域", async () => {
  const methods = await extractBranches({
    sourceRoot: SOURCE_ROOT,
    relPath: "StardewValley.Tools/WateringCan.cs",
    memberName: "DoFunction",
    parser,
  });
  const m = methods[0];
  assert.ok(m.maximalRegions >= 2, `refill / apply 应至少切分为两个分支区域，实测 ${m.maximalRegions}`);
  assert.ok(m.nestedRegions > 0, "apply 内部细节应被识别为嵌套而非独立动作");
  /** 按条件（而非行号）定位 refill —— 源码树会被并行工作流重新反编译 */
  const refill = m.branches.find((b) => b.candidate && /CanRefillWateringCanOnTile/.test(b.condition));
  assert.equal(refill?.candidate, true, "refill 是独立互斥分支");
  assert.ok(refill.writes.some((w) => /waterLeft/i.test(w)));
  assert.ok(
    refill.cosmetic.some((w) => /jitterStrength/i.test(w)),
    "who.jitterStrength 是视觉字段，应与 gameplay 写入分开（18_ 未列出该字段）",
  );
});

// ---- 产物自我约束 ---------------------------------------------------------

test("提取产物声明它不做什么", async () => {
  const source = await readFile(new URL("../src/analysis/stardew-branch-writeset-cli.mjs", import.meta.url), "utf8");
  for (const nonGuarantee of [
    "no_action_identity_inferred",
    "no_postcondition_inferred_across_delegation",
    "no_content_or_rng_effect_inferred",
    "not_a_publishable_action_catalog",
  ])
    assert.ok(source.includes(nonGuarantee), `产物必须声明 ${nonGuarantee}`);
});
