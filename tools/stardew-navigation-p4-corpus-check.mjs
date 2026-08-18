#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { evaluateMatcherCorpus, findDestination, findDestinationWithPolicy, normalizeDestinationText, P4A_TARGET_BINDING_V1, SEARCH_POLICY_V1 } from "./stardew-navigation-p4-characterization.mjs";

// Synthetic fixtures only: never product locations or target-version labels.
const entries = Object.freeze([
  {
    id: "synthetic-alpha",
    labels: { "en-US": "Alpha Hall", "zh-CN": "阿尔法厅", "ja-JP": "アルファホール" },
    aliases: ["alpha"],
  },
  {
    id: "synthetic-beta",
    labels: { "en-US": "Beta Hall", "zh-CN": "贝塔厅", "ja-JP": "ベータホール" },
    aliases: ["beta"],
  },
  { id: "synthetic-close-a", labels: { "en-US": "North Hall" }, aliases: [] },
  { id: "synthetic-close-b", labels: { "en-US": "North Hail" }, aliases: [] },
  { id: "synthetic-tie-a", labels: { "en-US": "Stone" }, aliases: [] },
  { id: "synthetic-tie-b", labels: { "en-US": "Stone" }, aliases: [] },
]);
const rejected = () => ({ kind: "not_found", stage: "fuzzy_below_threshold", candidates: [] });
export const CORPUS_SELECTION_RECORD_V1 = Object.freeze({
  artifactKind: "stardew_navigation_p4c_redacted_corpus_selection",
  schemaVersion: 1,
  selectionVersion: "p4c-real-selection-v1",
  targetVersion: "1.6.15.24356",
  inputDigest: "sha256:selection-input-withheld",
  provenance: "target-version-derived labels are private checker input only",
  localeCategoryCaseCounts: Object.freeze({
    "en-US": { exact: 0, fuzzy: 0, ambiguous: 0 },
    "zh-CN": { exact: 0, fuzzy: 0, ambiguous: 0 },
    "ja-JP": { exact: 0, fuzzy: 0, ambiguous: 0 },
  }),
  comparisonAggregates: Object.freeze({ belowThreshold: 0, thresholdPassLowMargin: 0, thresholdPassClearMargin: 0 }),
  policy: "threshold_not_found_then_low_margin_candidates",
  rationale: "avoid resolving a threshold-passing result without sufficient separation",
  syntheticPolicyCases: true,
  nonClaim:
    "Synthetic cases validate lexical policy only; they do not prove product search. Private target-derived labels are required for real-selection evidence.",
});
const LOCALES = Object.freeze(["en-US", "zh-CN", "ja-JP"]);
const CATEGORIES = Object.freeze(["exact", "natural_paraphrase", "case_whitespace_punctuation", "zh", "fallback", "explicit_alias", "typo", "short_query", "duplicate_name", "near_name", "control_path_shaped", "below_threshold", "tie"]);
const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_ENTRY_ID = /^p4c-entry-[a-z0-9-]{1,64}$/;
const OPAQUE_CASE_ID = /^p4c-case-[a-z0-9-]{1,64}$/;
const CATEGORY_SEMANTICS = Object.freeze({
  exact: ["resolved", "current_locale_exact"], natural_paraphrase: ["resolved", "fuzzy"], case_whitespace_punctuation: ["resolved", "current_locale_exact"], zh: ["resolved", "current_locale_exact"], fallback: ["resolved", "fallback_locale_exact"], explicit_alias: ["resolved", "alias_exact"], typo: ["resolved", "fuzzy"], short_query: ["not_found", "short_query"], duplicate_name: ["ambiguous", "current_locale_exact"], near_name: ["candidates", "fuzzy_low_margin"], control_path_shaped: ["invalid_query", null], below_threshold: ["not_found", "fuzzy_below_threshold"], tie: ["ambiguous", "current_locale_exact"],
});
const fail = () => { throw new Error("private_real_selection_input_invalid"); };
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stats = () => ({ total: 0, correct: 0, falseAccept: 0, falseReject: 0, ambiguity: 0, misresolved: 0 });
function verify(input) {
  if (!exactKeys(input, ["artifactKind", "schemaVersion", "targetVersion", "p4aInputDigest", "claimedTargetContentDigest", "claimedTargetProvenanceDigest", "callerClaimedLabelProvenance", "entries", "cases", "expectedPolicy"]) || input.artifactKind !== "stardew_navigation_p4c_private_corpus" || input.schemaVersion !== 2 || input.targetVersion !== P4A_TARGET_BINDING_V1.gameAssemblyVersion || input.p4aInputDigest !== P4A_TARGET_BINDING_V1.inputDigest || !SHA256.test(input.claimedTargetContentDigest) || !SHA256.test(input.claimedTargetProvenanceDigest) || input.callerClaimedLabelProvenance !== "target_private" || !Array.isArray(input.entries) || !Array.isArray(input.cases) || !input.entries.length || !input.cases.length || input.entries.length > 128 || input.cases.length > 512 || !exactKeys(input.expectedPolicy, ["fuzzyThreshold", "fuzzyMargin"]) || !Number.isFinite(input.expectedPolicy.fuzzyThreshold) || !Number.isFinite(input.expectedPolicy.fuzzyMargin)) fail();
  const keys = new Set(), labelLocales = new Set(), caseLocales = new Set(), categories = new Set(); let aliases = 0;
  for (const entry of input.entries) {
    if (!exactKeys(entry, ["key", "labels", "aliases"]) || typeof entry.key !== "string" || !OPAQUE_ENTRY_ID.test(entry.key) || keys.has(entry.key) || !exactKeys(entry.labels, LOCALES) || !Array.isArray(entry.aliases)) fail(); keys.add(entry.key);
    for (const locale of LOCALES) { if (!normalizeDestinationText(entry.labels[locale])) fail(); labelLocales.add(locale); }
    for (const alias of entry.aliases) { if (++aliases > 256 || !exactKeys(alias, ["text", "provenance"]) || !["explicit_content_alias", "explicit_content_former_name"].includes(alias.provenance) || !normalizeDestinationText(alias.text)) fail(); }
  }
  const ids = new Set();
  for (const item of input.cases) {
    const validExpected = exactKeys(item?.expected, ["kind", "stage", "canonicalKey", "candidates"]);
    if (!exactKeys(item, ["id", "category", "query", "currentLocale", "fallbackLocale", "expected"]) || typeof item.id !== "string" || !OPAQUE_CASE_ID.test(item.id) || ids.has(item.id) || !CATEGORIES.includes(item.category) || !LOCALES.includes(item.currentLocale) || !LOCALES.includes(item.fallbackLocale) || typeof item.query !== "string" || [...item.query].length > 128 || (!normalizeDestinationText(item.query) && item.category !== "control_path_shaped") || !validExpected || !["resolved", "ambiguous", "candidates", "not_found", "invalid_query"].includes(item.expected.kind) || !Array.isArray(item.expected.candidates) || new Set(item.expected.candidates).size !== item.expected.candidates.length || item.expected.candidates.some((key) => typeof key !== "string" || !keys.has(key)) || (item.expected.kind === "resolved" && (typeof item.expected.canonicalKey !== "string" || !keys.has(item.expected.canonicalKey) || !item.expected.candidates.includes(item.expected.canonicalKey))) || (item.expected.kind !== "resolved" && item.expected.canonicalKey !== null)) fail();
    const semantic = CATEGORY_SEMANTICS[item.category]; if (item.expected.kind !== semantic[0] || item.expected.stage !== semantic[1] || (item.category === "zh" && item.currentLocale !== "zh-CN") || (item.category === "fallback" && item.currentLocale === item.fallbackLocale)) fail(); ids.add(item.id); categories.add(item.category); caseLocales.add(item.currentLocale);
  }
  if (labelLocales.size !== 3 || caseLocales.size !== 3 || categories.size !== CATEGORIES.length || !input.cases.some((item) => item.category === "fallback" && item.currentLocale !== item.fallbackLocale)) fail();
}
export async function checkPrivateRealSelection(inputPath) {
  if (!inputPath) throw new Error("private_real_selection_input_unavailable"); let raw;
  try { raw = await readFile(inputPath, "utf8"); } catch { throw new Error("private_real_selection_input_unavailable"); }
  if (Buffer.byteLength(raw) > 262144) fail(); let input; try { input = JSON.parse(raw); } catch { fail(); } verify(input);
  const entries = input.entries.map((entry) => ({ id: entry.key, labels: entry.labels, aliases: entry.aliases.map((alias) => alias.text) }));
  const fixedPolicy = SEARCH_POLICY_V1;
  const evaluate = (policy) => {
    const metrics = stats(), partitions = { locale: {}, category: {} };
    for (const item of input.cases) {
      const actual = findDestinationWithPolicy(entries, item.query, item.currentLocale, item.fallbackLocale, policy), expected = item.expected;
      const correct = actual.kind === expected.kind && (actual.stage ?? null) === expected.stage && (actual.destinationId ?? null) === expected.canonicalKey && same(actual.candidates, expected.candidates);
      for (const row of [metrics, partitions.locale[item.currentLocale] ??= stats(), partitions.category[item.category] ??= stats()]) { row.total++; if (correct) row.correct++; if (actual.kind === "resolved" && expected.kind !== "resolved") row.falseAccept++; if (actual.kind !== "resolved" && expected.kind === "resolved") row.falseReject++; if (["ambiguous", "candidates"].includes(actual.kind)) row.ambiguity++; if (actual.kind === "resolved" && expected.kind === "resolved" && actual.destinationId !== expected.canonicalKey) row.misresolved++; }
    }
    return { metrics, partitions };
  };
  const grid = [.78, .8, .82, .84, .86].flatMap((fuzzyThreshold) => [.04, .06, .08, .1].map((fuzzyMargin) => ({ ...SEARCH_POLICY_V1, fuzzyThreshold, fuzzyMargin })));
  // Objective: minimize false accepts, then misresolutions, false rejects, ambiguity, and total failures; ties prefer the nearest frozen policy, then lower threshold and margin.
  const candidates = grid.map((policy) => ({ policy, ...evaluate(policy) }));
  const selected = candidates.sort((a, b) => a.metrics.falseAccept - b.metrics.falseAccept || a.metrics.misresolved - b.metrics.misresolved || a.metrics.falseReject - b.metrics.falseReject || a.metrics.ambiguity - b.metrics.ambiguity || (a.metrics.total - a.metrics.correct) - (b.metrics.total - b.metrics.correct) || (Math.abs(a.policy.fuzzyThreshold - fixedPolicy.fuzzyThreshold) + Math.abs(a.policy.fuzzyMargin - fixedPolicy.fuzzyMargin)) - (Math.abs(b.policy.fuzzyThreshold - fixedPolicy.fuzzyThreshold) + Math.abs(b.policy.fuzzyMargin - fixedPolicy.fuzzyMargin)) || a.policy.fuzzyThreshold - b.policy.fuzzyThreshold || a.policy.fuzzyMargin - b.policy.fuzzyMargin)[0];
  const fixed = candidates.find((candidate) => candidate.policy.fuzzyThreshold === fixedPolicy.fuzzyThreshold && candidate.policy.fuzzyMargin === fixedPolicy.fuzzyMargin);
  if (fixed.metrics.correct !== fixed.metrics.total || input.expectedPolicy.fuzzyThreshold !== fixedPolicy.fuzzyThreshold || input.expectedPolicy.fuzzyMargin !== fixedPolicy.fuzzyMargin || selected.policy.fuzzyThreshold !== fixedPolicy.fuzzyThreshold || selected.policy.fuzzyMargin !== fixedPolicy.fuzzyMargin) throw new Error("private_real_selection_policy_or_match_mismatch");
  return Object.freeze({ artifactKind: "stardew_navigation_p4c_redacted_corpus_report", schemaVersion: 2, targetVersion: input.targetVersion, p4aInputDigest: input.p4aInputDigest, inputDigest: `sha256:${createHash("sha256").update(raw).digest("hex")}`, claims: Object.freeze({ claimedTargetContentDigest: `sha256:${input.claimedTargetContentDigest}`, claimedTargetProvenanceDigest: `sha256:${input.claimedTargetProvenanceDigest}`, callerClaimedLabelProvenance: input.callerClaimedLabelProvenance }), provenanceStatus: "caller_unverified_requires_independent_attestation", policy: { selected: { fuzzyThreshold: selected.policy.fuzzyThreshold, fuzzyMargin: selected.policy.fuzzyMargin }, matchesSearchPolicyV1: true, candidateMetrics: candidates.map((candidate) => ({ fuzzyThreshold: candidate.policy.fuzzyThreshold, fuzzyMargin: candidate.policy.fuzzyMargin, metrics: candidate.metrics })) }, metrics: fixed.metrics, partitions: fixed.partitions, privateInputAvailable: true, nonClaim: "Caller claims are unverified and do not establish a producer, target/private corpus provenance, target data, or Agent consumption." });
}
export const CORPUS_V1 = Object.freeze({
  entries,
  cases: Object.freeze([
    {
      id: "current",
      query: "阿尔法厅",
      currentLocale: "zh-CN",
      fallbackLocale: "en-US",
      expected: {
        kind: "resolved",
        stage: "current_locale_exact",
        destinationId: "synthetic-alpha",
        candidates: ["synthetic-alpha"],
      },
    },
    {
      id: "fallback",
      query: "Alpha Hall",
      currentLocale: "zh-CN",
      fallbackLocale: "en-US",
      expected: {
        kind: "resolved",
        stage: "fallback_locale_exact",
        destinationId: "synthetic-alpha",
        candidates: ["synthetic-alpha"],
      },
    },
    {
      id: "alias",
      query: "alpha",
      currentLocale: "zh-CN",
      fallbackLocale: "en-US",
      expected: {
        kind: "resolved",
        stage: "alias_exact",
        destinationId: "synthetic-alpha",
        candidates: ["synthetic-alpha"],
      },
    },
    {
      id: "fuzzy-accepted",
      query: "Alpha Hal",
      currentLocale: "en-US",
      fallbackLocale: "en-US",
      expected: { kind: "resolved", stage: "fuzzy", destinationId: "synthetic-alpha", candidates: ["synthetic-alpha"] },
    },
    {
      id: "fuzzy-margin",
      query: "North Hal",
      currentLocale: "en-US",
      fallbackLocale: "en-US",
      expected: {
        kind: "candidates",
        stage: "fuzzy_low_margin",
        candidates: ["synthetic-close-a", "synthetic-close-b", "synthetic-beta"],
      },
    },
    { id: "fuzzy-below", query: "zzzz", currentLocale: "en-US", fallbackLocale: "en-US", expected: rejected() },
    {
      id: "exact-ambiguity",
      query: "Stone",
      currentLocale: "en-US",
      fallbackLocale: "en-US",
      expected: {
        kind: "ambiguous",
        stage: "current_locale_exact",
        candidates: ["synthetic-tie-a", "synthetic-tie-b"],
      },
    },
  ]),
});
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = evaluateMatcherCorpus(CORPUS_V1);
  if (report.counts.correct !== report.counts.total) throw new Error(`corpus_mismatch:${JSON.stringify(report)}`);
  const selection = await checkPrivateRealSelection(process.env.P4C_PRIVATE_REAL_SELECTION_INPUT);
  console.log(
    JSON.stringify({ selection, policy: report.policy, counts: report.counts, localeMatrix: report.localeMatrix }),
  );
}
