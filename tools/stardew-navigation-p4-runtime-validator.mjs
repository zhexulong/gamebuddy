#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const SHA256 = /^[a-f0-9]{64}$/;
const TERMINAL = new Set([
  "world_map_completed",
  "arm_config_missing_or_invalid",
  "arm_deadline_expired",
  "target_version_mismatch",
  "world_unloaded_before_attestation",
  "native_attestation_failed",
  "output_bound_exceeded",
]);
const FORBIDDEN_TEXT =
  /(?:rawLabels|queries|coordinates|routes|playerId|saveId|worldId|nonce|integrityMac|bridgePayload|receipt|destinationRef|mineDisplay(?:Text|Token)(?!Sha256))/i;
const exactRecord = (value, keys) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const ROOT_KEYS = [
  "artifactKind",
  "schemaVersion",
  "state",
  "mutationCount",
  "bridgeUsed",
  "productionRefIssued",
  "rawLabelsEmitted",
];
const GENERAL_KEYS = [
  "gameAssemblyVersion",
  "inputDigest",
  "ordinaryCurrentWorld",
  "nativeApi",
  "mineIdentity",
  "mineWorldMapNameMatchesCanonical",
  "mountainWorldMapBinding",
  "mineWorldMapTooltipBinding",
  "aggregates",
  "localeEvaluation",
  "progressiveObservation",
];
const ORDINARY_WORLD_KEYS = [
  "playerPresent",
  "currentLocationPresent",
  "currentLocationIsMineShaft",
  "canMove",
  "multiplayer",
  "masterGame",
];
const NATIVE_API_KEYS = [
  "mapRegionGetAreasInvocations",
  "mapAreaGetTooltipsInvocations",
  "mapAreaGetWorldPositionsInvocations",
  "mapRegionLocationNameInvocations",
  "tokenParserInvocations",
];
const P4A_INPUT_DIGEST = "ef2f63a15e9f528cfa70dcf8602013d241503d308b8702b846578fbf76e4876a";
const LOCALE_KEYS = [
  "currentLanguage",
  "mineDisplayTokenSha256",
  "mineDisplayTextSha256",
  "currentLocaleTokenParser",
  "fallbackLocale",
  "visibleTooltipCount",
  "hiddenOrUnknownTooltipCount",
  "unknownTooltipPresentation",
];
const LANGUAGE_CODES = new Set(["en", "ja", "ru", "zh", "pt", "es", "de", "th", "fr", "ko", "it", "tr", "hu", "mod"]);
export function validateRuntimeAttestation(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { valid: false, errors: ["artifact_invalid"] };
  if (value.artifactKind !== "stardew_navigation_p4_runtime_attestation") errors.push("artifact_kind");
  if (value.schemaVersion !== 2) errors.push("schema_version");
  if (!TERMINAL.has(value.state)) errors.push("terminal_state");
  const rootKeys =
    value.state === "world_map_completed"
      ? [...ROOT_KEYS, "detail"]
      : Object.hasOwn(value, "detail")
        ? [...ROOT_KEYS, "detail"]
        : ROOT_KEYS;
  if (!exactRecord(value, rootKeys)) errors.push("schema_shape:root");
  for (const key of ["mutationCount", "bridgeUsed", "productionRefIssued", "rawLabelsEmitted"])
    if (value[key] !== (key === "mutationCount" ? 0 : false)) errors.push(`non_mutating_invariant:${key}`);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 8192) errors.push("output_bound");
  if (FORBIDDEN_TEXT.test(serialized.replace(/rawLabelsEmitted/g, "").replace(/productionRefIssued/g, "")))
    errors.push("redaction_violation");
  if (value.state === "world_map_completed") {
    const general = value.detail?.general;
    if (!exactRecord(value.detail, ["general"]) || !exactRecord(general, GENERAL_KEYS))
      errors.push("schema_shape:detail_or_general");
    if (!general || general.gameAssemblyVersion !== "1.6.15.24356") errors.push("target_version");
    if (general?.inputDigest !== P4A_INPUT_DIGEST) errors.push("input_digest");
    if (!exactRecord(general?.ordinaryCurrentWorld, ORDINARY_WORLD_KEYS))
      errors.push("schema_shape:ordinary_current_world");
    if (!exactRecord(general?.nativeApi, NATIVE_API_KEYS)) errors.push("schema_shape:native_api");
    if (!exactRecord(general?.aggregates, ["minesTooltipAreaCount"])) errors.push("schema_shape:aggregates");
    if (!exactRecord(general?.localeEvaluation, LOCALE_KEYS)) errors.push("schema_shape:locale_evaluation");
    const observation = general?.progressiveObservation;
    const observationKeys = ["sourceCorrelation", "pageSize", "root", "areas", "tooltips", "positions", "pagination"];
    const numericRows = [observation?.root, observation?.areas, observation?.tooltips, observation?.positions];
    if (
      !exactRecord(observation, observationKeys) ||
      !exactRecord(observation?.sourceCorrelation, ["targetAssemblyInputDigestMatchesP4A", "sourceBinding"]) ||
      observation.sourceCorrelation.targetAssemblyInputDigestMatchesP4A !== true ||
      observation.sourceCorrelation.sourceBinding !== "p4a_target_digest_bound" ||
      observation.pageSize !== 8 ||
      !exactRecord(observation?.root, [
        "nativeRegionCount",
        "pageCount",
        "pagesVisited",
        "sameGenerationReplay",
        "traversalDigestSha256",
        "replayTraversalDigestSha256",
      ]) ||
      observation.root.sameGenerationReplay !== "stable" ||
      !SHA256.test(observation.root.traversalDigestSha256 ?? "") ||
      !SHA256.test(observation.root.replayTraversalDigestSha256 ?? "") ||
      observation.root.traversalDigestSha256 !== observation.root.replayTraversalDigestSha256 ||
      !exactRecord(observation?.areas, [
        "configuredCount",
        "includedCount",
        "conditionExcludedCount",
        "emptyNodeCount",
        "pagesVisited",
      ]) ||
      !exactRecord(observation?.tooltips, [
        "configuredInIncludedAreaCount",
        "visibleCount",
        "conditionExcludedCount",
        "knownVisibleCount",
        "unknownPresentationObservedCount",
        "emptyNodeCount",
        "pagesVisited",
      ]) ||
      !exactRecord(observation?.positions, [
        "configuredInIncludedAreaCount",
        "visibleCount",
        "conditionExcludedCount",
        "sourceCorrelatedUniqueLeafCandidateCount",
        "unresolvedLeafCount",
        "nonUniqueLeafCount",
        "presentationOnlyLeafCount",
        "emptyNodeCount",
        "pagesVisited",
      ]) ||
      !exactRecord(observation?.pagination, ["state", "boundedTraversalReplay"]) ||
      !["exercised", "not_exercised"].includes(observation.pagination.state) ||
      observation.pagination.boundedTraversalReplay !== "stable" ||
      !numericRows.every((row) =>
        Object.values(row)
          .filter((value) => typeof value === "number")
          .every((value) => Number.isSafeInteger(value) && value >= 0),
      ) ||
      observation.root.pageCount !== observation.root.pagesVisited ||
      observation.root.pageCount !==
        Math.max(1, Math.ceil(observation.root.nativeRegionCount / observation.pageSize)) ||
      observation.areas.configuredCount !==
        observation.areas.includedCount + observation.areas.conditionExcludedCount ||
      observation.tooltips.configuredInIncludedAreaCount !==
        observation.tooltips.visibleCount + observation.tooltips.conditionExcludedCount ||
      observation.tooltips.visibleCount !==
        observation.tooltips.knownVisibleCount + observation.tooltips.unknownPresentationObservedCount ||
      observation.positions.configuredInIncludedAreaCount !==
        observation.positions.visibleCount + observation.positions.conditionExcludedCount ||
      observation.positions.sourceCorrelatedUniqueLeafCandidateCount +
        observation.positions.unresolvedLeafCount +
        observation.positions.nonUniqueLeafCount +
        observation.positions.presentationOnlyLeafCount >
        observation.positions.visibleCount
    )
      errors.push("progressive_observation_proof");
    if (
      general?.ordinaryCurrentWorld?.playerPresent !== true ||
      general?.ordinaryCurrentWorld?.currentLocationPresent !== true ||
      general?.ordinaryCurrentWorld?.currentLocationIsMineShaft !== false ||
      general?.ordinaryCurrentWorld?.canMove !== true ||
      general?.ordinaryCurrentWorld?.multiplayer !== false ||
      general?.ordinaryCurrentWorld?.masterGame !== true
    )
      errors.push("ordinary_current_world_proof");
    if (
      !(general?.nativeApi?.mapRegionGetAreasInvocations >= 1) ||
      !(general?.nativeApi?.mapAreaGetTooltipsInvocations >= 1) ||
      !(general?.nativeApi?.mapAreaGetWorldPositionsInvocations >= 1) ||
      general?.nativeApi?.mapRegionLocationNameInvocations !== 1 ||
      general?.mineIdentity !== true ||
      general?.mineWorldMapNameMatchesCanonical !== true ||
      general?.mountainWorldMapBinding !== true ||
      general?.mineWorldMapTooltipBinding !== true ||
      general?.aggregates?.minesTooltipAreaCount !== 1
    )
      errors.push("general_world_map_proof");
    if (
      !LANGUAGE_CODES.has(general?.localeEvaluation?.currentLanguage) ||
      !SHA256.test(general?.localeEvaluation?.mineDisplayTokenSha256 ?? "") ||
      !SHA256.test(general?.localeEvaluation?.mineDisplayTextSha256 ?? "") ||
      general?.localeEvaluation?.currentLocaleTokenParser !== "resolved_redacted" ||
      general?.localeEvaluation?.fallbackLocale !== "not_attempted_global_locale_immutable" ||
      general?.nativeApi?.tokenParserInvocations !== 1 ||
      !Number.isSafeInteger(general?.localeEvaluation?.visibleTooltipCount) ||
      general.localeEvaluation.visibleTooltipCount < 0 ||
      !Number.isSafeInteger(general?.localeEvaluation?.hiddenOrUnknownTooltipCount) ||
      general.localeEvaluation.hiddenOrUnknownTooltipCount < 0 ||
      !["unknown_or_condition_excluded_present", "none_observed"].includes(
        general?.localeEvaluation?.unknownTooltipPresentation,
      ) ||
      (general?.localeEvaluation?.hiddenOrUnknownTooltipCount === 0 &&
        general?.localeEvaluation?.unknownTooltipPresentation !== "none_observed") ||
      (general?.localeEvaluation?.hiddenOrUnknownTooltipCount > 0 &&
        general?.localeEvaluation?.unknownTooltipPresentation !== "unknown_or_condition_excluded_present")
    )
      errors.push("locale_or_unknown_presentation_proof");
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze([...new Set(errors)]) });
}
export function summarizeRuntimeAttestation(value) {
  const validation = validateRuntimeAttestation(value);
  return Object.freeze({
    artifactDigest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    state: value?.state,
    validation,
  });
}
if (process.argv[1] && new URL(`file:${process.argv[1]}`).href === import.meta.url) {
  const path = process.argv[2];
  if (!path) throw new Error("usage: node tools/stardew-navigation-p4-runtime-validator.mjs <attestation.json>");
  const value = JSON.parse(await readFile(path, "utf8"));
  const report = summarizeRuntimeAttestation(value);
  console.log(JSON.stringify(report));
  if (!report.validation.valid) process.exitCode = 2;
}
