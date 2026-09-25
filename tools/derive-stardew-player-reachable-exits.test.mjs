import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * 玩家可达出口枚举的校准测试。
 *
 * 校准对象：已注册 action 的 native seam 与「玩家输入根的控制流」的关系。
 *
 * 这个测试保护一个被两次踩中的缺陷：
 *   v1 手写 10 个方法名 → 漏掉 12/36 已注册 seam
 *   v2 用 HOST_MEMBER_NAMES（deliberately-broad discovery family）→ 310 个假候选
 * 正确来源只能是控制流根 + 有界展开。
 *
 * 测试还固定一个**产品事实**：3 个已注册 seam 从玩家输入根不可达，因为 Mod 直接
 * 调用内部方法而不是模拟玩家按键（见 registerReconciliation.unreachable）。
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

/** register 是权威；本测试用它推导预期的 seam 成员集，而不是硬编码数量。 */
const register = JSON.parse(await readFile(REGISTER, "utf8"));

/** 从 native 签名里取出方法名（签名未以 `(` 结尾时取最后一个词）。 */
function memberOf(signature) {
  const matches = signature.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
  return matches ? matches[matches.length - 1].replace(/\s*\($/, "") : signature.trim().split(/\s+/).pop();
}

async function run(maxDepth = "4") {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      path.join(HERE, "derive-stardew-player-reachable-exits.mjs"),
      "--source-root",
      SOURCE_ROOT,
      "--action-register",
      REGISTER,
      "--max-depth",
      maxDepth,
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

const artifact = await run("4");

test("覆盖 17_ atlas 的 9 个 normal-player ingress roots", () => {
  assert.equal(artifact.artifactKind, "stardew_player_reachable_exits");
  const groupIds = Object.keys(artifact.rootGroups);
  assert.equal(groupIds.length, 9, "应覆盖全部 9 个 ingress root");
  for (const id of groupIds) {
    const g = artifact.rootGroups[id];
    assert.ok(g.members.length > 0, `${id} 应有成员方法`);
    assert.equal(g.resolved.length, g.members.length);
  }
  // 索引是唯一昂贵步骤（~7.5s）；每多一个根只增毫秒级 BFS
  assert.ok(artifact.indexedMethodCount > 5000, "应索引大量方法");
  assert.ok(artifact.reachableExits.length >= 25, `可达出口应 >=25，实测 ${artifact.reachableExits.length}`);
  for (const e of artifact.reachableExits) {
    assert.ok(e.depth >= 0 && e.depth <= 4, `${e.nativeMember} 深度应在 0..4`);
    assert.ok(e.definedIn.length > 0, `${e.nativeMember} 应记录定义位置`);
    assert.ok(typeof e.root === "string", `${e.nativeMember} 应记录最早到达的根`);
  }
});

test("深度 1 的出口必须包含输入根的直接 gameplay 分派", () => {
  const d1 = new Set(artifact.reachableExits.filter((e) => e.depth === 1).map((e) => e.nativeMember));
  assert.ok(d1.has("DoFunction"), "pressUseToolButton → t.DoFunction");
  assert.ok(d1.has("performToolAction"), "pressUseToolButton → o.performToolAction");
  assert.ok(d1.has("checkAction"), "pressActionButton/pressUseToolButton → checkAction");
  assert.ok(d1.has("rotate"), "pressActionButton → furniture.rotate");
  assert.ok(d1.has("CheckPetAnimal"), "pressActionButton → CheckPetAnimal（路由层真实入口，未进 register）");
  assert.ok(d1.has("CheckInspectAnimal"), "pressActionButton → CheckInspectAnimal");
  // 加入 menu_semantic_selection 后才出现的出口（只取 2 个根时会被误判为不可达）
  assert.ok(d1.has("createItem"), "clickCraftingRecipe → CraftingRecipe.createItem（菜单入口）");
  assert.ok(d1.has("eatObject"), "receiveLeftClick → Farmer.eatObject（库存菜单）");
  assert.ok(d1.has("getShippingBin"), "receiveLeftClick → Farm.getShippingBin");
});

test("tryToCheckAt 既是根也是 seam，深度为 0", () => {
  const root = artifact.reachableExits.find((e) => e.nativeMember === "tryToCheckAt");
  assert.ok(root, "tryToCheckAt 应在可达出口里");
  assert.equal(root.depth, 0, "它本身就是 world_action_interaction 根之一");
});

test("已注册 native seam 的 13/15 从玩家输入根可达", () => {
  const r = artifact.registerReconciliation;
  assert.ok(r, "应产出 register 对账");
  // 不硬编码数量：register 是权威，对账必须覆盖它列出的每个唯一 native seam 成员。
  // （曾硬编码 16；那个数字包含 canBePlacedHere —— 一个只被 place_wood_fence 引用、
  //  且无任何写入的纯判断方法。它在 2e9e13e 中被修为真实变异点 placementAction，
  //  于是该成员不再存在，唯一成员数降为 15。硬编码会让这个正确的修复看起来像回归。）
  const declared = new Set();
  for (const action of register.actions)
    for (const seam of (action.seams ?? []).filter((s) => s.kind === "native")) declared.add(memberOf(seam.signature));
  assert.equal(r.seamCount, declared.size, `对账应覆盖 register 的全部 ${declared.size} 个唯一 native seam 成员`);
  assert.equal(r.reachableCount + r.unreachableCount, r.seamCount);
  // 修正后的成员集：placementAction 在，canBePlacedHere 不在
  const reachableNames = new Set(r.reachable.map((x) => x.nativeMember));
  assert.ok(reachableNames.has("placementAction"), "placementAction 应是可达 seam");
  assert.ok(
    !reachableNames.has("canBePlacedHere"),
    "canBePlacedHere 是纯判断方法，不应再作为 seam 成员参与对账",
  );
  assert.ok(
    r.reachableCount >= 13,
    `可达 seam 应 >=13，实测 ${r.reachableCount}：${r.reachable.map((x) => x.nativeMember).join(", ")}`,
  );
  // 每个可达项都要有 action 归属，不能是空映射
  for (const x of r.reachable) assert.ok(x.actionIds.length > 0, `${x.nativeMember} 应有 action 归属`);
});

test("不可达 seam 只剩 2 个内部方法（createItem 经菜单入口已可达）", () => {
  const r = artifact.registerReconciliation;
  const names = r.unreachable.map((x) => x.nativeMember).sort();
  assert.deepEqual(names, ["collect", "shipItem"], "只有这两个内部方法不在玩家输入闭包里（产品事实，不是枚举缺陷）");
  const byName = new Map(r.unreachable.map((x) => [x.nativeMember, x.actionIds]));
  assert.deepEqual(byName.get("collect"), ["pickup_item"]);
  assert.deepEqual(byName.get("shipItem"), ["ship_item"]);
  // createItem 现在可达（经 menu_semantic_selection），必须出现在 reachable 里
  const createItem = r.reachable.find((x) => x.nativeMember === "createItem");
  assert.ok(createItem, "CraftingRecipe.createItem 应已可达");
  assert.deepEqual(createItem.actionIds, ["cook_recipe", "craft_item"]);
});

test("产物声明它不推断 action identity，也不声称穷尽闭包", () => {
  for (const g of [
    "no_action_identity_inferred",
    "no_dynamic_dispatch_resolution_virtual_calls_are_followed_by_name_only",
    "reachability_is_bounded_by_max_depth_and_is_not_a_proof_of_exhaustive_closure",
    "transition_ledger_closure_state_is_partial_and_remains_the_authority_for_transitions",
  ])
    assert.ok(artifact.nonGuarantees.includes(g), `产物必须声明 ${g}`);
});

test("max-depth 是有界的：深度扩大只增不减", async () => {
  const shallow = await run("1");
  const deep = artifact;
  const s = new Set(shallow.reachableExits.map((e) => e.nativeMember));
  const d = new Set(deep.reachableExits.map((e) => e.nativeMember));
  for (const m of s) assert.ok(d.has(m), `${m} 在 depth=1 可达，depth=4 必须仍可达`);
  assert.ok(d.size >= s.size, "扩大深度不应减少可达集合");
});
