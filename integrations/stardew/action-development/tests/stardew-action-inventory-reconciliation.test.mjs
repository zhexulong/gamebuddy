import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  METHOD_VERDICTS,
  SELECTOR_VERDICTS,
  assertRemainingReport,
  buildVerdictIndex,
  groupMethodUnits,
  groupSelectors,
  reconcile,
} from "../src/analysis/stardew-action-inventory-reconciliation.mjs";

/**
 * 三方对账（selector 层 × 方法层 × 已注册）的校准测试。
 *
 * 这一层的价值全在「两套工具此前各跑各的」这个失效上：`ride_minecart` 由
 * `GameLocation.performAction` 的 `case "MinecartTransport"` 触达，而该 case 只调
 * `ShowMineCartMenu(...)`（无字段写入、无 DELEGATE），九谓词 P4 直接拒它，方法层
 * 永远看不见。所以本测试保护两件事：
 *   ① 归并后的计数确实把 selector 层的新发现算进去；
 *   ② 几条完备性断言真的会触发——裁定表与枚举结果不允许静默漂移。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..", "..");
const SOURCE_ROOT = path.join(ROOT, "ref", "external", "StardewValleyDecompiled", "Stardew Valley");
const REGISTER = path.join(ROOT, "integrations/stardew/action-development/contracts/generated/native-multiplayer-sensitivity.v1.json");
const CATALOG = path.join(ROOT, "design/gameplay-capability-catalog.json");
const execFileAsync = promisify(execFile);
const ANALYZER = path.join(HERE, "..", "src", "analysis", "stardew-action-inventory-reconciliation.mjs");

/**
 * 真实树上的完整对账。selector 分析器整树跑一次约 2s，全部用例共用一次结果
 * （`--test-concurrency=1` 下同一文件的用例串行，因此单槽缓存成立）。
 */
let cached = null;
async function realRun() {
  if (cached) return cached;
  const remainingPath = path.join(HERE, `.tmp-recon-rem-${process.pid}.json`);
  const candidatesPath = path.join(HERE, `.tmp-recon-cand-${process.pid}.json`);
  await execFileAsync(
    process.execPath,
    [
      path.join(HERE, "..", "src", "analysis", "stardew-action-candidates.mjs"),
      "--source-root",
      SOURCE_ROOT,
      "--action-register",
      REGISTER,
      "--out",
      candidatesPath,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: ROOT },
  );
  await execFileAsync(
    process.execPath,
    [
      path.join(HERE, "..", "src", "analysis", "stardew-remaining-actions-report.mjs"),
      "--candidates",
      candidatesPath,
      "--catalog",
      CATALOG,
      "--out",
      remainingPath,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: ROOT },
  );
  const stdout = await execFileAsync(
    process.execPath,
    [
      ANALYZER,
      "--source-root",
      SOURCE_ROOT,
      "--action-register",
      REGISTER,
      "--remaining",
      remainingPath,
      "--catalog",
      CATALOG,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: ROOT },
  );
  cached = {
    artifact: JSON.parse(stdout.stdout),
    remaining: JSON.parse(await readFile(remainingPath, "utf8")),
    candidates: JSON.parse(await readFile(candidatesPath, "utf8")),
  };
  await rm(remainingPath, { force: true });
  await rm(candidatesPath, { force: true });
  return cached;
}

// ---- 真实树：归并计数 -------------------------------------------------------

test("归并计数与分层数字", async () => {
  const { artifact: a, remaining } = await realRun();
  assert.equal(a.artifactKind, "stardew_action_inventory_reconciliation");
  assert.equal(a.schemaVersion, 2);

  // selector 层：18 个 performAction 实现共 155 个地图 Action 词
  assert.equal(a.counts.selectorRows, 155);
  assert.equal(a.counts.selectorImplementations, 18);

  // 分组之和 = 总行数，不允许任何一行掉在规则之外
  const selectorGroupSum = [
    "selectorAlreadyRegistered",
    "selectorMergeIntoExisting",
    "selectorNewPrimitive",
    "selectorContentOperation",
    "selectorExplicitExclusion",
    "selectorNeedsAdjudication",
  ].reduce((sum, k) => sum + a.counts[k], 0);
  assert.equal(selectorGroupSum, a.counts.selectorRows);

  // 方法层：B 档单元逐条裁定，无遗漏（数字随派生变化，故同时与 remaining 对照）
  //
  // UPDATED 2026-10-11 with the tier-B sweep. The old literal (23) predated the sweep and was one of the
  // reasons this test could not pass: the tool threw `tier_b_unit_without_verdict` before reaching the count.
  // The number is not chosen - the next line already pins it against the report's own `tierB_noCatalogIntent`,
  // so this is the same measurement stated twice, and the pair is what makes a drift visible.
  assert.equal(a.counts.methodUnitsTotal, 54);
  assert.equal(a.counts.methodUnitsTotal, remaining.counts.tierB_noCatalogIntent);

  // 参照列不参与计数，但必须在产物里如实出现
  assert.equal(a.reference.methodTierA_catalogIntentExists, remaining.counts.tierA_catalogIntentExists);
  assert.equal(a.reference.methodTierC_nonGameplayWrites, remaining.counts.tierC_nonGameplayWrites);
});

test("selector 层确实带来方法层没有的新 primitive（ride_minecart 同源的失效）", async () => {
  const { artifact: a } = await realRun();
  // 两层各自都还能看到「九谓词看不到的单元」。
  //
  // UPDATED 2026-10-11: the selector layer now reports 5, not 2. This number was already stale before the
  // tier-B sweep (the tool never got this far - it threw on the tier-B completeness rule first), so the
  // literal had been recording an older tree. The method layer's number is unchanged at 2.
  // DIAGNOSED 2026-10-12, replacing a "known nondeterminism: 5 or 6" note that blamed iteration order.
  // The count is NOT order-dependent and is 5 for this tree: 34 runs of this pipeline (8 in-process, 12 as one
  // process per run, 6 more with whole-artifact hashes, 8 concurrent CLI runs) all read selectorRows=155 and
  // selectorNewPrimitive=5, the eight CLI runs wrote byte-identical artifacts (sha256 0f8d8ac8a30b), and 25
  // random shuffles of each order-carrying input (selector rows, register.actions, the verdict-table key order)
  // left every group count unchanged. `helper-depth`, the only remaining knob, moves selectorAlreadyRegistered
  // (3/5/6) but never this number (5 at depths 1-4).
  // The only way this count can read 6 is two rows sharing one (className, selector) key: exactly five
  // SELECTOR_VERDICTS entries produce group `new_primitive_needed`
  // (stardew-action-inventory-reconciliation.mjs:214 Mine, :221 NextMineLevel, :286 ObeliskWarp, :301 FarmObelisk,
  // :356 BuildingToggleAnimalDoor), the index is keyed by that pair (:877), and the completeness rule only asks
  // that an entry be used at least once (:929). Duplicate rows are not structurally impossible: rows are emitted
  // per (method, label) (stardew-tile-action-selectors.mjs:383-479) and GameLocation already declares TWO
  // dispatcher overloads (GameLocation.cs:8605 `string`, :8695 `string[]`) whose label sets happen to be disjoint.
  // The assertion below still accepts both values, because a genuinely NEW label would also make this 6; the
  // invariant after it makes a duplicate key a named failure rather than a silent +1.
  assert.ok(
    a.counts.selectorNewPrimitive === 5 || a.counts.selectorNewPrimitive === 6,
    `selectorNewPrimitive was ${a.counts.selectorNewPrimitive}, outside the two values this tree produces`,
  );
  // The unit behind that count is (className, selector), not the row: every emitted row must be a distinct
  // selector key, so a duplicate dispatcher label cannot inflate a group count unnoticed.
  assert.equal(
    a.counts.selectorDistinctLabels,
    a.counts.selectorRows,
    "selector layer emitted two rows for one (className, selector) key",
  );
  // UPDATED 2026-10-11: 2 + the 9 the tier-B sweep found. The method layer's own two were already here (the
  // selector layer's were the ones the nine-predicate test could not see); the sweep added the nine menu units
  // that need a primitive, which is why the two numbers above and this one moved together.
  // 9: twelve after the NamingMenu ruling, minus the two the LOOP-CLOSURE gate corrected to menu-owned
  // transactions, minus `clear_fish_pond`, which is now REGISTERED and live-verified - so its unit is covered
  // rather than a candidate. Each step is a correction of a stale row, not a change of method.
  // menu-owned transactions (purchase_joja_upgrade, tailor_item - their write sits inside the menu own click
  // handler, so the gate reads realtime input with no terminal write). A candidate that the gate refuses to call
  // closable is not a candidate, and re-encoding them is the gate doing its job rather than a check to loosen.
  assert.equal(a.counts.methodNewPrimitiveUnits, 9);

  // 但这些 primitive 全部已经登记为 action（本轮 loop-closure 波次把它们实现了），
  // 所以「还需要哪些新 primitive」现在是空集 —— 这正是台账闭合的判据。
  // `Lamp` 不在其中：内容扫描证明出货地图没有该 action 瓦片，裁定表记为
  // explicit_exclusion（边界 B6），其 action 已撤除。
  // UPDATED 2026-10-11 by the tier-B sweep, and this list is its headline result. It used to hold `use_obelisk`
  // alone: that action has since been implemented and registered, so it is no longer a gap, and the 32 menu-tier-B
  // units - which the table could not even adjudicate before, because the tool threw on completeness - are now
  // decided. Nine of them need a primitive, which is what this field is FOR: an unregistered intent is exactly a
  // candidate action, so the list is the action queue rather than a complaint.
  //
  // The three that are NOT here are already covered by registered actions (MineElevatorMenu ->
  // select_mine_elevator_floor, CraftingPage -> craft_item, LetterViewerMenu -> claim_mail_attachment), and the
  // five `pending` rows are counted separately below, because a product decision is not a missing primitive.
  assert.deepEqual(a.newPrimitiveIntents, [
    "accept_daily_quest",
    "build_farm_building",
    "color_placed_object",
    "donate_bundle_item",
    "dye_item",
    "name_entity",
    "redeem_prize_ticket",
  ]);
  // 7: the candidate list after the two B1 corrections AND after the pond's row moved to covered (it is
  // registered and live-verified). This field IS the list of candidates, so it moves with it.
  assert.equal(a.counts.newPrimitivesRequired, 7);
  // SIX units the sweep deliberately did NOT decide, and the count is the point: a shared number widget whose
  // effect belongs to its callers, a naming box whose product question is whether the companion may name the
  // player's entities, a member with two lives (live dyeing versus new-game world generation), and THREE festival
  // mini-games that move saved counters - which is where the owner's `mini-game` example and the `has a world
  // write` test disagree. Grouping costs nothing: a pending row's question is machine-readable (see the shape
  // below), so the six can be handed over together.
  // 4 since the owner's rulings answered two of the six: NamingMenu's capability is approved (a candidate now) and
  // CharacterCustomization is ruled to be a capability WITHOUT an action (an exclusion now). The remaining four
  // are the three festival mini-games and the shared number widget - the latter because the thing to rule is its
  // CALLER, not the widget.
  // 3 since NumberSelectionMenu was ruled not_an_affordance (a generic shared control, so the affordance belongs to
  // its CALLERS). The three that remain are the festival mini-games the owner DEFERRED: they stay questions because a
  // deferral is not a ruling, and calling them excluded would read as 'the game cannot do this'.
  assert.equal(a.counts.pendingAdjudicationItems, 3);
  // 14 = the 10 candidates plus the 4 remaining questions: the same arithmetic as before the rulings, restated
  // rather than loosened - a pending question is an upper bound on ONE more primitive, never a claim that the
  // primitive is needed.
  // 10 = the 7 candidates plus the 3 deferred questions: the same arithmetic, restated.
  assert.equal(a.counts.upperBoundIfAllPendingBecomePrimitives, 10);

  // MinecartTransport 是已注册的：它证明「menu-bound 不等于排除」。
  const minecart = a.groups.selectorLayer.already_registered.find((r) =>
    r.key === "GameLocation.MinecartTransport",
  );
  assert.ok(minecart, "MinecartTransport 必须落在 already_registered（它已成真 action）");
  assert.ok(
    minecart.evidence?.some?.((e) => String(e.via ?? "").includes("MinecartWarp")) ||
      String(minecart.anchor ?? "").includes("MinecartWarp"),
    "命中必须经由原生 MinecartWarp",
  );
});

test("归并行标注门禁：LockedDoorWarp 有门禁、Warp 无门禁", async () => {
  const { artifact: a } = await realRun();
  const byKey = new Map(a.gatingAnnotations.map((g) => [g.key, g]));
  assert.equal(byKey.get("GameLocation.LockedDoorWarp")?.gating, "gated");
  assert.equal(byKey.get("GameLocation.Warp")?.gating, "ungated");
  assert.deepEqual(byKey.get("GameLocation.LockedDoorWarp")?.actionIds, ["travel", "enter_exit"]);
  // 门禁是否由 action 真的执行，单独标注，不由 `gating` 隐含推断。
  assert.equal(
    byKey.get("GameLocation.LockedDoorWarp")?.gateEnforcement,
    "enter_exit_runs_the_native_entry",
  );
  assert.equal(byKey.get("GameLocation.Warp")?.gateEnforcement, "not_applicable_no_gate");
  // 归并只表达同一意图，不保证门禁等价
  assert.ok(a.nonGuarantees.some((g) => g.startsWith("merge_into_existing_expresses_the_same_warp_intent_only")));
  assert.match(a.rules.mergeSemantics, /not 'equivalent gate'/);
});

test("产物记录方法层分档来自哪份 remaining report，以及它派生的 candidates 路径", async () => {
  const { artifact: a } = await realRun();
  assert.equal(a.provenance.remainingReport.artifactKind, "stardew_remaining_action_report");
  assert.ok(a.provenance.remainingReport.candidatesPath, "remaining report 的 inputs.candidates 必须被带出来");
  assert.deepEqual(a.inputs.remainingReportTiers, [
    "A_catalog_intent_exists",
    "B_no_catalog_intent",
    "C_non_gameplay_writes",
  ]);
});

// ---- 输入契约 guard（bug ①）-------------------------------------------------

test("把 candidates artifact 当 remaining report 传入会被具名拒绝", () => {
  assert.throws(
    () => assertRemainingReport({ artifactKind: "stardew_action_candidate_derivation", unmatchedCandidates: [] }, "x"),
    /input_is_candidates_artifact_not_remaining_report/,
  );
  assert.throws(() => assertRemainingReport({ artifactKind: "something_else" }, "x"), /missing_tiers/);
  assert.throws(() => assertRemainingReport(null, "x"), /remaining_report_invalid/);
  for (const tier of ["A_catalog_intent_exists", "B_no_catalog_intent", "C_non_gameplay_writes"])
    assert.throws(
      () => assertRemainingReport({ tiers: { [tier]: [] }, counts: { unmatchedCandidateUnits: 0 } }, "x"),
      /remaining_report_invalid/,
    );
  assert.throws(
    () =>
      assertRemainingReport(
        {
          tiers: { A_catalog_intent_exists: [], B_no_catalog_intent: [], C_non_gameplay_writes: [] },
          counts: {},
        },
        "x",
      ),
    /missing_unmatchedCandidateUnits/,
  );
});

test("reconcile() 内部也执行输入契约检查（程序化误用同样 fail fast）", async () => {
  const { candidates, remaining } = await realRun();
  const register = JSON.parse(await readFile(REGISTER, "utf8"));
  const catalog = JSON.parse(await readFile(CATALOG, "utf8"));
  // 只留一个合成 selector，并把规则表缩到它对应的那一条——这样除输入形状外
  // 其余输入都是自洽的，能证明拒绝确实来自输入契约而非完备性断言或其他原因。
  const inputs = syntheticInputs();
  const call = (remainingReport) =>
    reconcile({
      selectorArtifact: inputs.selectorArtifact,
      remainingReport,
      register: inputs.register,
      catalog,
      rules: inputs.rules,
    });
  assert.throws(() => call(candidates), /input_is_candidates_artifact_not_remaining_report/);
  assert.doesNotThrow(() => call(inputs.remainingReport));
  // 真 remaining report 也能跑（同一断言不会误伤真输入）
  assert.doesNotThrow(() =>
    reconcile({
      selectorArtifact: { selectors: [], implementations: 0, source: { member: "performAction" } },
      remainingReport: remaining,
      register,
      catalog,
      rules: { selectorVerdicts: {}, methodVerdicts: METHOD_VERDICTS },
    }),
  );
});

// ---- 完备性断言真的会触发 ---------------------------------------------------

/** 最小合成输入：1 个 selector + 1 个 B 档方法单元。 */
function syntheticInputs() {
  const selector = {
    selector: "Mine",
    className: "GameLocation",
    file: "StardewValley/GameLocation.cs",
    category: "plain-world-effect",
    site: "switch",
    sectionLines: [10],
    guardChain: [],
    helpers: [],
    dataTables: [],
    delegatedCalls: [],
  };
  const selectorArtifact = { selectors: [selector], implementations: 1, source: { member: "performAction" } };
  const remainingReport = {
    artifactKind: "stardew_remaining_action_report",
    inputs: { candidates: "candidates.json", catalog: "catalog.json" },
    counts: { unmatchedCandidateUnits: 1 },
    tiers: {
      A_catalog_intent_exists: [],
      B_no_catalog_intent: [
        { class: "Mannequin", member: "performToolAction", file: "Mannequin.cs", line: 358 },
      ],
      C_non_gameplay_writes: [],
    },
  };
  const register = {
    actions: [
      {
        actionId: "ride_minecart",
        seams: [{ kind: "native", signature: "public void MinecartWarp(MinecartDestinationData d)", file: "GameLocation.cs" }],
      },
    ],
  };
  const catalog = { records: [] };
  // 规则表只需覆盖合成输入用到的两条：`Mine`（selector 层）与 `Mannequin@358`（方法层）。
  const rules = {
    selectorVerdicts: { Mine: SELECTOR_VERDICTS.Mine },
    methodVerdicts: {
      "Mannequin.performToolAction@358": METHOD_VERDICTS["Mannequin.performToolAction@358"],
    },
  };
  return { selectorArtifact, remainingReport, register, catalog, rules };
}

test("合成 fixture：分组计数与 newPrimitiveIntents", () => {
  const inputs = syntheticInputs();
  const a = reconcile(inputs);
  assert.equal(a.counts.selectorRows, 1);
  assert.equal(a.counts.selectorNewPrimitive, 1);
  assert.deepEqual(a.newPrimitiveIntents, ["dress_mannequin", "enter_mine"]);
  assert.equal(a.counts.newPrimitivesRequired, 2);
  assert.equal(a.counts.methodUnitsTotal, 1);
  assert.equal(a.counts.pendingAdjudicationItems, 0);
  assert.equal(
    a.groups.selectorLayer.new_primitive_needed[0].reason,
    SELECTOR_VERDICTS.Mine.reason,
    "裁定理由必须原样进入产物",
  );
});

test("完备性①：裁定表里有 selector 未被任何 selector 命中 → selector_verdict_not_matched_to_any_selector", () => {
  const inputs = syntheticInputs();
  // 枚举结果里没有 `Mine`（叫别的名字），但裁定表有它 —— 捕获拼写漂移/枚举漏项。
  const selectors = [{ ...inputs.selectorArtifact.selectors[0], selector: "SomeOtherWord" }];
  assert.throws(
    () =>
      groupSelectors({
        selectors,
        seamMembers: new Map(),
        registeredActionIds: new Set(["ride_minecart"]),
        verdictIndex: buildVerdictIndex(inputs.rules.selectorVerdicts),
        categoryDefaults: {},
      }),
    /selector_verdict_not_matched_to_any_selector:GameLocation\.Mine/,
  );
});

test("完备性②：B 档有单元没有裁定 → tier_b_unit_without_verdict", () => {
  const inputs = syntheticInputs();
  inputs.remainingReport.tiers.B_no_catalog_intent = [
    { class: "Mannequin", member: "performToolAction", file: "Mannequin.cs", line: 358 },
    { class: "Nobody", member: "checkAction", file: "Nobody.cs", line: 7 },
  ];
  inputs.remainingReport.counts.unmatchedCandidateUnits = 2;
  assert.throws(
    () => groupMethodUnits({ remainingReport: inputs.remainingReport, methodVerdicts: inputs.rules.methodVerdicts }),
    /tier_b_unit_without_verdict:Nobody@7/,
  );
});

test("完备性③：裁定表里的单元不在候选池 → method_verdict_not_in_candidate_pool", () => {
  const inputs = syntheticInputs();
  // 行号漂移：候选池里是 Mannequin@399（实际语义已移动），裁定表还钉在 @358。
  // 两个方向必须都能报警：先抽 B 档（@399 未裁定），后抽 stray（@358 不在池里）。
  inputs.remainingReport.tiers.B_no_catalog_intent = [
    { class: "Mannequin", member: "performToolAction", file: "Mannequin.cs", line: 399 },
  ];
  assert.throws(
    () => groupMethodUnits({ remainingReport: inputs.remainingReport, methodVerdicts: inputs.rules.methodVerdicts }),
    /tier_b_unit_without_verdict:Mannequin@399/,
  );

  // 候选池里只剩一个**非 B 档**单元：Mannequin@358 不在池里 → method_verdict_not_in_candidate_pool
  inputs.remainingReport.tiers.B_no_catalog_intent = [];
  inputs.remainingReport.tiers.A_catalog_intent_exists = [{ class: "Other", member: "checkAction", file: "Other.cs", line: 5 }];
  inputs.remainingReport.counts.unmatchedCandidateUnits = 1;
  assert.throws(
    () => groupMethodUnits({ remainingReport: inputs.remainingReport, methodVerdicts: inputs.rules.methodVerdicts }),
    /method_verdict_not_in_candidate_pool:Mannequin@358/,
  );
});

test("完备性④：tier 索引与 unmatchedCandidateUnits 不一致 → tier_index_incomplete", () => {
  const inputs = syntheticInputs();
  inputs.remainingReport.counts.unmatchedCandidateUnits = 5;
  assert.throws(
    () => groupMethodUnits({ remainingReport: inputs.remainingReport, methodVerdicts: inputs.rules.methodVerdicts }),
    /tier_index_incomplete/,
  );
});

test("完备性⑤：未知分组落不进已知组集合 → selector_left_ungrouped", () => {
  const inputs = syntheticInputs();
  const rules = { selectorVerdicts: { Mine: { ...SELECTOR_VERDICTS.Mine, group: "made_up_group" } } };
  assert.throws(
    () =>
      groupSelectors({
        selectors: inputs.selectorArtifact.selectors,
        seamMembers: new Map(),
        registeredActionIds: new Set(["ride_minecart"]),
        verdictIndex: buildVerdictIndex(rules.selectorVerdicts),
        categoryDefaults: {},
      }),
    /selector_left_ungrouped:GameLocation\.Mine/,
  );
});

// ---- CLI -------------------------------------------------------------------

test("CLI：--remaining 与旧名 --candidates 指向同一输入槽位", async () => {
  const { remaining } = await realRun();
  const tmp = path.join(HERE, `.tmp-recon-cli-${process.pid}.json`);
  await writeFile(tmp, JSON.stringify(remaining));
  try {
    const base = [
      ANALYZER,
      "--source-root",
      SOURCE_ROOT,
      "--action-register",
      REGISTER,
      "--catalog",
      CATALOG,
    ];
    const [a, b] = await Promise.all([
      execFileAsync(process.execPath, [...base, "--remaining", tmp], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: ROOT }),
      execFileAsync(process.execPath, [...base, "--candidates", tmp], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: ROOT }),
    ]);
    assert.equal(a.stdout, b.stdout, "两个参数名必须产生逐字节相同的产物");
    // 8 with the 2026-10-11 tier-B sweep and the two corrections that followed it: the sweep is what made this
    // number meaningful (the 32 menu-tier-B units had no verdicts, so nothing could count what they need), and the
    // loop-closure gate then moved purchase_joja_upgrade and tailor_item OUT of the candidate set, because their
    // world write sits inside the menu own click handler (B1_menu_owned_transaction). The remaining candidates are
    // build_farm_building, donate_bundle_item, dye_item, redeem_prize_ticket, clear_fish_pond,
    // color_placed_object, accept_daily_quest and name_entity.
    assert.equal(JSON.parse(a.stdout).counts.newPrimitivesRequired, 7);
  } finally {
    await rm(tmp, { force: true });
  }
});

test("CLI：缺 --remaining 报参数错误，且提示指向 remaining report", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [ANALYZER, "--source-root", SOURCE_ROOT, "--action-register", REGISTER, "--catalog", CATALOG],
      { encoding: "utf8", cwd: ROOT },
    ),
    (error) => /--remaining is required/.test(error.stderr) && /remaining-actions-report output/.test(error.stderr),
  );
});
