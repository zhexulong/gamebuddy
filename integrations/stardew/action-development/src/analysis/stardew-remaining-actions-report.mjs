#!/usr/bin/env node
/**
 * 从「候选 action 派生」的产物生成「还需要哪些 action」的分档报告。
 *
 * 分档依据（全机械）：
 *   A  catalog 有对应 intent          → 已在计划内（planned/blocked/partial）
 *   B  有真实 gameplay 写入但无 intent → catalog 可能漏记，需裁定
 *   C  只写视觉/计时器字段             → 不构成 gameplay action
 *
 * 重要边界：本工具**不产出 action identity**，也不做语义归并。
 * 一个 (出口, 实现类) 单元不等于一个 action —— `PetBowl.performToolAction`（给碗加水）
 * 可能归入 `refill_watering_can` 的目标扩展，而不是新 action。
 * 归并需要一次人工裁定，本工具只提供有界、可复核的候选池。
 *
 * 用法：
 *   node tools/report-stardew-remaining-actions.mjs \
 *     --candidates <candidates.json> --catalog <catalog.json> [--out <file>] [--pretty]
 */

import { readFile, writeFile } from "node:fs/promises";
import { STARDEW_NON_GAMEPLAY_FIELDS, STARDEW_FIELD_ACCESSOR_SUFFIX } from "../stardew-source-analysis-vocabulary.mjs";

/**
 * Visual/timer/input-lock fields. Bare `Location` / `TileLocation` / `Position` are
 * deliberately absent: for `placementAction` those writes ARE the placement terminal.
 */
const NON_GAMEPLAY_FIELD = STARDEW_NON_GAMEPLAY_FIELDS;

function fail(code, message) {
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { pretty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--pretty") {
      out.pretty = true;
      continue;
    }
    if (!["--candidates", "--catalog", "--out"].includes(a)) fail("arguments_invalid", `Bad argument ${a}.`);
    const v = argv[++i];
    if (!v) fail("arguments_invalid", `Missing value for ${a}.`);
    out[a.slice(2)] = v;
  }
  for (const r of ["candidates", "catalog"]) if (!out[r]) fail("arguments_required", `--${r} is required.`);
  return out;
}

const options = parseArgs(process.argv.slice(2));
const candidates = JSON.parse(await readFile(options.candidates, "utf8"));
const catalog = JSON.parse(await readFile(options.catalog, "utf8"));

/** 末段字段名:先剥离属性访问器后缀(`HitTimerInstance.Milliseconds` → `HitTimerInstance`),
 * 再去掉数组下标,最后取末段。这样 deny-list 能命中被访问器的基字段,
 * 而 `readyForHarvest.Value` 仍取到 `readyForHarvest` 当作 gameplay。*/
const tailOf = (w) =>
  w
    .replace(STARDEW_FIELD_ACCESSOR_SUFFIX, "")
    .replace(/\[.*?\]/g, "")
    .split(".")
    .pop();
const isGameplayWrite = (w) => {
  const tail = tailOf(w);
  // `X.Value` 取 X 判定
  return !(NON_GAMEPLAY_FIELD.test(tail) || NON_GAMEPLAY_FIELD.test(w));
};

/**
 * intent 参考匹配。**这是参考列，不是权威**：
 * `12_STARDEW_PRIMITIVE_ACTION_BASIS.md` 明确禁止把 catalog 当发现输入。
 * 同时它按词形匹配，会失配（`toggle_animal_door` ↔ `AnimalHouse.checkAction`）。
 */
const intentIndex = catalog.records.map((r) => ({
  intentVariantId: r.intentVariantId,
  coverageState: r.coverageState,
  words: [
    ...new Set(
      [r.intentVariantId.replace(/_variant$|_lifecycle$/, ""), ...(r.basisPrimitiveIds ?? [])]
        .flatMap((s) => String(s).split(/[_\s]+/))
        .filter((w) => w.length >= 4)
        .map((w) => w.toLowerCase()),
    ),
  ],
}));

const wordsOfClass = (cls) =>
  cls
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .split(/[_\s]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 4);

function referenceIntents(cls) {
  const words = new Set(wordsOfClass(cls));
  if (words.size === 0) return [];
  return intentIndex
    .filter((i) => i.words.some((w) => words.has(w)))
    .map((i) => ({ intentVariantId: i.intentVariantId, coverageState: i.coverageState }))
    .slice(0, 4);
}

const rows = candidates.unmatchedCandidates.map((c) => {
  const gameplayWrites = c.writes.filter(isGameplayWrite);
  const intents = referenceIntents(c.class);
  let tier;
  if (gameplayWrites.length === 0) tier = "C_non_gameplay_writes";
  else if (intents.length > 0) tier = "A_catalog_intent_exists";
  else tier = "B_no_catalog_intent";
  return {
    member: c.member,
    class: c.class,
    file: c.file,
    line: c.line,
    candidateBranchCount: c.candidateBranchCount,
    gameplayWrites,
    nonGameplayWrites: c.writes.filter((w) => !isGameplayWrite(w)),
    tier,
    referenceIntents: intents,
  };
});

const byTier = { A_catalog_intent_exists: [], B_no_catalog_intent: [], C_non_gameplay_writes: [] };
for (const r of rows) byTier[r.tier].push(r);

const artifact = {
  artifactKind: "stardew_remaining_action_report",
  schemaVersion: 1,
  inputs: { candidates: options.candidates, catalog: options.catalog },
  counts: {
    unmatchedCandidateUnits: rows.length,
    tierA_catalogIntentExists: byTier.A_catalog_intent_exists.length,
    tierB_noCatalogIntent: byTier.B_no_catalog_intent.length,
    tierC_nonGameplayWrites: byTier.C_non_gameplay_writes.length,
    registeredActions: catalog.records.length > 0 ? undefined : undefined,
  },
  tiers: {
    A_catalog_intent_exists: byTier.A_catalog_intent_exists,
    B_no_catalog_intent: byTier.B_no_catalog_intent,
    C_non_gameplay_writes: byTier.C_non_gameplay_writes,
  },
  nonGuarantees: Object.freeze([
    "one_unit_is_not_one_action",
    "no_action_identity_inferred",
    "no_semantic_merge_performed",
    "catalog_is_a_reference_column_not_a_discovery_input",
    "tier_b_means_no_intent_matched_by_word_form_it_does_not_prove_the_intent_is_absent",
    "field_classification_uses_a_named_deny_list_not_a_semantic_proof",
  ]),
};
delete artifact.counts.registeredActions;

const serialized = `${JSON.stringify(artifact, null, options.pretty ? 2 : 0)}\n`;
if (options.out) {
  await writeFile(options.out, serialized);
  process.stdout.write(`${JSON.stringify({ state: "written", out: options.out, ...artifact.counts })}\n`);
} else {
  process.stdout.write(serialized);
}
