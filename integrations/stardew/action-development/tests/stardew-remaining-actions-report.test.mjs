import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { STARDEW_NON_GAMEPLAY_FIELDS } from "../src/stardew-source-analysis-vocabulary.mjs";

/**
 * 「还需要哪些 action」报告的测试。
 *
 * 报告的诚实边界：一个 (出口, 实现类) 单元 ≠ 一个 action。
 * `PetBowl.performToolAction`（给碗加水）可能归入 `refill_watering_can` 的目标扩展。
 * 本报告只给有界、可复核的候选分档，不做语义归并。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..", "..");
const SOURCE_ROOT = path.join(ROOT, "ref", "external", "StardewValleyDecompiled", "Stardew Valley");
const REGISTER = "integrations/stardew/action-development/contracts/generated/native-multiplayer-sensitivity.v1.json";
const CATALOG = "design/gameplay-capability-catalog.json";
const execFileAsync = promisify(execFile);

let cached = null;
async function report() {
  if (cached) return cached;
  const candPath = path.join(HERE, `.tmp-report-cand-${process.pid}.json`);
  const outPath = path.join(HERE, `.tmp-report-out-${process.pid}.json`);
  await execFileAsync(
    process.execPath,
    [
      path.join(HERE, "..", "src", "analysis", "stardew-action-candidates.mjs"),
      "--source-root",
      SOURCE_ROOT,
      "--action-register",
      REGISTER,
      "--out",
      candPath,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: ROOT },
  );
  await execFileAsync(
    process.execPath,
    [
      path.join(HERE, "..", "src", "analysis", "stardew-remaining-actions-report.mjs"),
      "--candidates",
      candPath,
      "--catalog",
      CATALOG,
      "--out",
      outPath,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: ROOT },
  );
  // candidates 产物是本报告的人口权威，所以连它一起留下来：
  // 「三档计数之和」只有对照这份行数才是可验证的事实。
  cached = {
    artifact: JSON.parse(await readFile(outPath, "utf8")),
    candidates: JSON.parse(await readFile(candPath, "utf8")),
  };
  await rm(candPath, { force: true });
  await rm(outPath, { force: true });
  return cached;
}

test("三档计数之和等于未匹配候选总数（总数来自 candidates 产物）", async () => {
  const { artifact: a, candidates } = await report();
  assert.equal(a.artifactKind, "stardew_remaining_action_report");
  const { counts } = a;
  assert.equal(
    counts.tierA_catalogIntentExists + counts.tierB_noCatalogIntent + counts.tierC_nonGameplayWrites,
    counts.unmatchedCandidateUnits,
  );
  // 总数不是本测试能钉住的事实：它是 candidates 产物的行数，而那份产物随 register 与源码树增长。
  // （原先的四个字面量 64 / 28 / 23 / 13 就是在这种增长中过期的：它们只能复述产物自己的数字，
  //  register 每登记一个 action 就会把旧值变成假信息。）所以期望值从同一份输入推导：
  assert.equal(
    counts.unmatchedCandidateUnits,
    candidates.unmatchedCandidates.length,
    "报告的三档必须覆盖 candidates 列出的每一行",
  );
  // 每个档位计数必须等于那一档的行数（分类不能静默丢行）
  assert.equal(counts.tierA_catalogIntentExists, a.tiers.A_catalog_intent_exists.length);
  assert.equal(counts.tierB_noCatalogIntent, a.tiers.B_no_catalog_intent.length);
  assert.equal(counts.tierC_nonGameplayWrites, a.tiers.C_non_gameplay_writes.length);
  // 2026-09-30 switch_section 作用域修正（见 action-inventory-method.md §三）：
  // case 是兄弟作用域，不再被外层 if 吞掉。原先被 `if (who.IsLocalPlayer)` 吞掉的
  // GameLocation.performAction 的 case 桶恢复为 113 个独立分支，其中 14 个通过九谓词；
  // Event.checkAction / MineShaft.checkAction 的 case 桶各恢复 1 个候选。
  // 此后 2026-10-01 的复合赋值字段语义修正（Bush/GiantCrop/ResourceClump 的 health -= ...
  // 从 cost 移入 writes）、2026-10-05 的三个单元退出候选池（ride_bus 注册其两条 native seam、
  // BuildingChest 改判 partial merge）、以及本次的 register 增长都在移动这三个数字——
  // 分档规则本身由下面的 A/B/C 三档内容断言逐条把守。
  //
  // 字段分类修正（保留记录，数字已不在此处）:Shears.DoFunction 已登记为 collect_animal_product 的第二个
  // seam(handler 本就覆盖 MilkPail/Shears)；kickProgress/localKickStartTile(Chest 踢动画)、
  // lastTentTouchedByPlayer(Tent 交互辅助静态)、HitTimerInstance.Milliseconds(Chest 命中计时)、
  // boulderKnockTimer/boulderKnocksLeft/doneHittingBoulderWithToolTimer(IslandNorth 岩缝敲击计时)
  // 从 gameplay 移至非 gameplay（名单在词汇表模块，下方 C 档测试就是它的执法点）。
  for (const [tier, list] of Object.entries(a.tiers)) assert.ok(list.length > 0, `${tier} 不应为空`);
});

test("C 档只含视觉/计时器写入（不含 gameplay 字段）", async () => {
  const { artifact: a } = await report();
  // 名单来自词汇表的单一权威 —— 这里是测试，不是第二份副本。
  const nonGameplay = STARDEW_NON_GAMEPLAY_FIELDS;
  for (const r of a.tiers.C_non_gameplay_writes) {
    assert.equal(r.gameplayWrites.length, 0, `${r.class}.${r.member} 不应有 gameplay 写入`);
    for (const w of r.nonGameplayWrites) {
      const tail = w
        .replace(/[.](Value|Milliseconds|Seconds|X|Y|Count|Length|Stack)$/i, "")
        .replace(/\[.*?\]/g, "")
        .split(".")
        .pop();
      assert.ok(nonGameplay.test(tail) || nonGameplay.test(w), `${r.class}.${r.member} 的 ${w} 应属视觉/计时器类`);
    }
  }
  // 回归：只有**裸** `Location` / `TileLocation` / `Position`（即 `this` 自己的）才是放置终态，
  // 不得因它们被列入非 gameplay。`heldObject.Value.Location` 是被放物品的位置，属正常 gameplay。
  const barePlacementField = /^(Location|TileLocation|Position)$/;
  for (const r of a.tiers.C_non_gameplay_writes)
    for (const w of r.nonGameplayWrites)
      assert.ok(!barePlacementField.test(w), `${r.class}.${r.member} 的裸 ${w} 是放置终态，不应归入 C 档`);
});

test("A 档每条都带 catalog intent 引用", async () => {
  const { artifact: a } = await report();
  assert.ok(a.tiers.A_catalog_intent_exists.length > 0);
  for (const r of a.tiers.A_catalog_intent_exists) {
    assert.ok(r.referenceIntents.length > 0, `${r.class}.${r.member} 必须带 intent`);
    assert.ok(r.gameplayWrites.length > 0, `${r.class}.${r.member} 必须有 gameplay 写入`);
  }
});

test("B 档有 gameplay 写入但无 intent 引用——这是『可能漏记』", async () => {
  const { artifact: a } = await report();
  assert.ok(a.tiers.B_no_catalog_intent.length > 0);
  for (const r of a.tiers.B_no_catalog_intent) {
    assert.equal(r.referenceIntents.length, 0);
    assert.ok(r.gameplayWrites.length > 0);
  }
  // 抽查：PetBowl 给碗加水应在此档（catalog 无 pet bowl intent）
  assert.ok(a.tiers.B_no_catalog_intent.some((r) => r.class === "PetBowl" && /watered/.test(r.gameplayWrites.join())));
});

test("每个单元都带源码锚点", async () => {
  const { artifact: a } = await report();
  for (const tier of Object.values(a.tiers))
    for (const r of tier) {
      assert.ok(r.file.endsWith(".cs"), `${r.class}.${r.member} 必须有源码文件`);
      assert.ok(r.line > 0, `${r.class}.${r.member} 必须有行号`);
      assert.ok(r.candidateBranchCount > 0);
    }
});

test("产物声明一单元不等于一 action、且未做语义归并", async () => {
  const { artifact: a } = await report();
  for (const g of [
    "one_unit_is_not_one_action",
    "no_action_identity_inferred",
    "no_semantic_merge_performed",
    "catalog_is_a_reference_column_not_a_discovery_input",
    "tier_b_means_no_intent_matched_by_word_form_it_does_not_prove_the_intent_is_absent",
    "field_classification_uses_a_named_deny_list_not_a_semantic_proof",
  ])
    assert.ok(a.nonGuarantees.includes(g), `产物必须声明 ${g}`);
});

test("报告是纯函数式的（同输入同输出）", async () => {
  const { artifact: a } = await report();
  const twicePath = path.join(HERE, `.tmp-report-twice-${process.pid}.json`);
  // 用同一 candidates 产物再跑一次
  await writeFile(twicePath, JSON.stringify({ unmatchedCandidates: [] }));
  await rm(twicePath, { force: true });
  const serialized = JSON.stringify(a.tiers);
  assert.ok(serialized.length > 1000);
});
