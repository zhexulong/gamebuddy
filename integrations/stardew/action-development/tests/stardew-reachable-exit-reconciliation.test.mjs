import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * 三方对账的校准测试。
 *
 * 保护三条规则与它们各自的边界：
 *   R2 出口承载：直接命中 native seam、或已核实的语义等价（必须带理由）
 *   R3 catalog 参考：只在未覆盖且属 gameplay 域时给出
 *   R4 菜单绑定：固定信号清单，含无 `Menu` 后缀的开放器（Utility.TryOpenShopMenu）
 *   +  语义域分类：menu/event/query_helper 不进入「还缺哪些 action」的计数
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..", "..");
const SOURCE_ROOT = path.join(ROOT, "ref", "external", "StardewValleyDecompiled", "Stardew Valley");
const execFileAsync = promisify(execFile);

async function runExits() {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      path.join(HERE, "..", "src", "analysis", "stardew-player-reachable-exits.mjs"),
      "--source-root",
      SOURCE_ROOT,
      "--action-register",
      "integrations/stardew/action-development/contracts/generated/native-multiplayer-sensitivity.v1.json",
      "--max-depth",
      "4",
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, cwd: ROOT },
  );
  return JSON.parse(stdout);
}

let artifact = null;
async function reconcile() {
  if (artifact) return artifact;
  const exits = await runExits();
  const exitsPath = path.join(ROOT, "tools", ".tmp-reconcile-exits.test.json");
  const { writeFile, rm } = await import("node:fs/promises");
  await writeFile(exitsPath, JSON.stringify(exits));
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.join(HERE, "..", "src", "analysis", "stardew-reachable-exit-reconciliation.mjs"),
        "--exits",
        exitsPath,
        "--action-register",
        "integrations/stardew/action-development/contracts/generated/native-multiplayer-sensitivity.v1.json",
        "--catalog",
        "design/gameplay-capability-catalog.json",
        "--game-source-root",
        SOURCE_ROOT,
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, cwd: ROOT },
    );
    artifact = JSON.parse(stdout);
  } finally {
    await rm(exitsPath, { force: true });
  }
  return artifact;
}

test("对账产出各语义域的计数，且只有 gameplay 域参与承载统计", async () => {
  const a = await reconcile();
  assert.equal(a.artifactKind, "stardew_reachable_exit_reconciliation");
  const domains = Object.keys(a.counts.byDomain).sort();
  assert.deepEqual(domains, ["event_and_dialogue", "gameplay_mutation", "menu_and_ui", "query_helper"]);
  assert.equal(
    a.counts.gameplayMutationExits,
    a.counts.coveredDirect + a.counts.coveredSemanticEquivalent + a.counts.uncovered,
    "gameplay 出口计数必须等于三档之和",
  );
  assert.ok(a.counts.coveredDirect >= 13, `直接承载应 >=13，实测 ${a.counts.coveredDirect}`);
});

test("R2：每个语义等价条目必须带理由，且指向已注册 action", async () => {
  const a = await reconcile();
  const equiv = a.rows.filter((r) => r.coverage.kind === "semantic_equivalent");
  assert.ok(equiv.length > 0, "应存在语义等价条目");
  for (const r of equiv) {
    assert.ok(r.coverage.why && r.coverage.why.length > 10, `${r.nativeMember} 必须给出等价的理由`);
    assert.ok(r.coverage.actions.length > 0, `${r.nativeMember} 必须指向 action`);
  }
  // 已核实的三个
  const names = equiv.map((r) => r.nativeMember).sort();
  assert.ok(names.includes("CheckPetAnimal") && names.includes("CheckInspectAnimal") && names.includes("pet"));
});

test("R4：菜单绑定必须捕获无 Menu 后缀的开放器", async () => {
  const a = await reconcile();
  const performAction = a.rows.find((r) => r.nativeMember === "performAction");
  assert.ok(performAction, "performAction 应在对账行里");
  assert.equal(performAction.menuBinding.bound, true);
  const signals = performAction.menuBinding.signals;
  assert.ok(
    signals.includes("Utility.TryOpenShopMenu"),
    "必须捕获 Utility.TryOpenShopMenu——它名字里没有 Menu 后缀，只查 new *Menu( 会漏",
  );
  assert.ok(signals.some((s) => /^new (ForgeMenu|TailoringMenu|QuestContainerMenu)$/.test(s)));
});

test("域分类把 query helper / 菜单 / 事件出口排除出 gameplay 计数", async () => {
  const a = await reconcile();
  const checkConditions = a.rows.find((r) => r.nativeMember === "CheckConditions");
  assert.equal(checkConditions?.domain, "query_helper", "GameStateQuery.CheckConditions 不是玩家出口");
  const exitThisMenu = a.rows.find((r) => r.nativeMember === "exitThisMenu");
  assert.equal(exitThisMenu?.domain, "menu_and_ui");
  const answerDialogue = a.rows.find((r) => r.nativeMember === "answerDialogueAction");
  assert.equal(answerDialogue?.domain, "event_and_dialogue");
});

test("R3：catalog 只作为参考列，且仅在未覆盖的 gameplay 出口上出现", async () => {
  const a = await reconcile();
  for (const r of a.rows) {
    if (r.coverage.kind === "direct" || r.domain !== "gameplay_mutation")
      assert.deepEqual(r.referenceIntents, [], `${r.nativeMember} 不应带参考 intent`);
  }
  const uncovered = a.rows.filter((r) => r.domain === "gameplay_mutation" && r.coverage.kind === "uncovered");
  assert.ok(uncovered.length > 0, "应存在未覆盖的 gameplay 出口");
  // 每个参考 intent 必须标注它是否已被已注册 action 覆盖
  for (const r of uncovered)
    for (const i of r.referenceIntents)
      assert.ok(typeof i.coveredByRegisteredAction === "boolean", `${i.intentVariantId} 缺 coveredByRegisteredAction`);
});

test("未覆盖的 gameplay 出口是 4 个，且每个都有源码锚点", async () => {
  const a = await reconcile();
  const uncovered = a.rows.filter((r) => r.domain === "gameplay_mutation" && r.coverage.kind === "uncovered");
  // `canBePlacedHere` 在 2e9e13e 之前被误认为是 place_wood_fence 的 seam，因而被算作"已覆盖"。
  // 该引用就是纯判断方法（0 写入），修正为真实变异点 placementAction 后，它诚实地
  // 回到未覆盖集。数量从 5 变 6 是修复的结果，不是新增缺口。
  //
  // 6 → 4（2026-10-05）：`checkForAction` 与 `performObjectDropInAction` 随其他 lane 的
  // action 注册被承载，于是退出未覆盖集。它们是**被覆盖**而不是被丢弃：保留两条出口
  // 的源码锚点断言，以证明剩下这四个仍然可追。
  assert.equal(uncovered.length, 4, `实测未覆盖应为 4，得到 ${uncovered.length}`);
  const names = uncovered.map((r) => r.nativeMember).sort();
  assert.deepEqual(names, ["animateSpecialMove", "canBePlacedHere", "performAction", "rotate"]);
  for (const r of uncovered) assert.ok(r.definedIn.length > 0, `${r.nativeMember} 必须有源码锚点`);
  // 已覆盖的两条仍然在场（只是不再未覆盖），否则它们就是被静默丢掉了。
  const all = a.rows.filter((r) => r.domain === "gameplay_mutation").map((r) => r.nativeMember);
  assert.ok(all.includes("checkForAction"), "checkForAction 应仍在出口集合里");
  assert.ok(all.includes("performObjectDropInAction"), "performObjectDropInAction 应仍在出口集合里");
});

test("产物声明 catalog 不是发现输入，且菜单判定不是 UI 排他性证明", async () => {
  const a = await reconcile();
  for (const g of [
    "catalog_is_a_reference_column_not_a_discovery_input",
    "menu_signal_detection_is_a_bounded_pattern_match_not_a_proof_of_ui_exclusivity",
    "domain_classification_is_a_named_deny_list_not_a_semantic_proof",
    "no_action_identity_inferred",
  ])
    assert.ok(a.nonGuarantees.includes(g), `产物必须声明 ${g}`);
});
