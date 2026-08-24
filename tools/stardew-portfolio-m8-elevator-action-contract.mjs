#!/usr/bin/env node
/**
 * Deterministic, fail-closed static contract for the preferred M8 elevator
 * route. This file validates metadata only: it does not grant capability,
 * invoke a menu/callback, launch Stardew, or claim live closure.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validatePortfolioM8MineSourceAudit } from "./lib/stardew-portfolio-m8-mine-source-audit.mjs";

const TOPOLOGY = "single_player_native_companion";
const TARGET = Object.freeze({
  gameVersion: "1.6.15.24356",
  assemblySha256: "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee",
});
const SOURCE_AUDIT = "tools/stardew-portfolio-m8-mine-source-audit.json";
const FIXTURE_REF = "fixtures/stardew/portfolio-m8-elevator-contract.example.json";
const ACTION = "select_mine_elevator_floor";
const ANCHORS = Object.freeze([
  "normal_player_mine_check_action_ingress",
  "mine_elevator_presentation_ingress",
  "mine_elevator_progress_guard",
  "mine_elevator_target_transition",
  "mine_ladder_target_transition",
  "mine_target_floor_warp",
  "mine_ladder_spawn_guard",
  "mine_ladder_pending_creation",
]);
const FORBIDDEN = Object.freeze([
  "UI/menu automation, keyboard/mouse/XInput, visual/input injection, or window inspection",
  "Game1.activeClickableMenu, MineElevatorMenu, raw menu callback, dialogue callback, or UI dispatcher",
  "GameLocation.checkAction, raw dispatcher string, direct callback invocation, or arbitrary native-call fallback",
  "generic mine action, generic travel action, generic warp action, or direct warp request",
  "ladder route selection or ladder/elevator route conflation",
  "direct action save mutation, direct action player/world mutation, fixture-written action result, or use of a staged-save Given fixture outside its named launcher-owned validation transaction",
  "static floor number, static elevator/target ID, debug floor, or fake target ID",
]);
const NON_CLAIMS = Object.freeze([
  "This contract does not publish select_mine_elevator_floor or any M8 route action.",
  "This contract does not establish target-version source realization, target-version live closure, receipt evidence, or Portfolio release evidence.",
  "Ladder progression, generic mine/travel/warp, combat, and route discovery remain outside this elevator primitive.",
  "The example remains unprovisioned and cannot provide a save, target, result, or terminal route state.",
]);
const FIXTURE_RULES = Object.freeze([
  "Create a new transaction-owned staged slot from a manifest-verified read-only canonical slot; never overwrite or restore canonical contents.",
  "A named launcher-owned staged-save declaration may establish only source-backed Given fields, including explicitly declared player/world/progress/inventory facts, and must not expose arbitrary XML paths or values.",
  "For the fixed validation floor-5 elevator Given, the declaration may set staged mine_lowestLevelReached to 10 only after validation of the target-version serialized shape and mine_lowestLevelReachedForOrder == -1; it must not create the elevator action result.",
  "Keep the selected checkpoint unmaterialized until a runtime request and fresh observation resolve it.",
  "Record no opaque correlation value, receipt, execution, result, action evidence, or postcondition in the fixture.",
  "The live game-thread probe must freshly observe MineShaft, elevator facility, and unlocked/non-current checkpoint before the action request; serialized setup is not action admission proof.",
  "A missing, ambiguous, contaminated, advanced, terminal, or canonical-integrity-mismatched starting state fails closed.",
]);
const ROOT_FIELDS = Object.freeze([
  "schemaVersion",
  "artifactKind",
  "contractId",
  "topology",
  "target",
  "sourceAudit",
  "routeBoundary",
  "selectedDomain",
  "action",
  "sharedRequestGuards",
  "sharedEvidenceRules",
  "fixtureStatus",
  "fixtureStartingFacts",
  "fixtureCreationRules",
  "forbiddenBehavior",
  "nonClaims",
  "fixtureRef",
]);
const HASH = /^[a-f0-9]{64}$/;

function fail(errors, code = "portfolio_m8_elevator_action_contract_invalid") {
  const error = new Error(errors.join("\n"));
  error.code = code;
  throw error;
}
function exact(value, fields, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object.`);
    return false;
  }
  const expected = new Set(fields);
  for (const field of fields) if (!Object.hasOwn(value, field)) errors.push(`${label}: missing field ${field}.`);
  for (const field of Object.keys(value)) if (!expected.has(field)) errors.push(`${label}: unknown field ${field}.`);
  return true;
}
function exactArray(value, expected, label, errors) {
  if (!Array.isArray(value)) errors.push(`${label} must be an array.`);
  else if (JSON.stringify(value) !== JSON.stringify(expected))
    errors.push(`${label} must match the approved bounded policy.`);
}
function value(value, expected, label, errors) {
  if (value !== expected) errors.push(`${label} must be ${JSON.stringify(expected)}.`);
}
function _nonEmpty(value, label, errors) {
  if (typeof value !== "string" || value.trim() === "") errors.push(`${label} must be a non-empty string.`);
}
function booleans(object, fields, label, errors) {
  for (const field of fields) value(object?.[field], true, `${label}.${field}`, errors);
}
function opaqueCorrelation(correlation, label, errors) {
  exact(correlation, ["kind", "source", "value"], label, errors);
  value(correlation?.kind, "opaque_runtime_correlation", `${label}.kind`, errors);
  value(correlation?.source, "fresh_game_thread_observation", `${label}.source`, errors);
  value(correlation?.value, null, `${label}.value`, errors);
}
function freshFact(fact, label, errors, expectedName) {
  exact(fact, ["kind", "name", "source", "value"], label, errors);
  value(fact?.kind, "fresh_native_fact", `${label}.kind`, errors);
  value(fact?.name, expectedName, `${label}.name`, errors);
  value(fact?.source, "game_thread_observation", `${label}.source`, errors);
  value(fact?.value, null, `${label}.value`, errors);
}
function rejectConcreteIds(input, label, errors) {
  if (typeof input === "string") {
    if (
      /^(?:\d+|floor[_-]?\d+|target[_-]?[a-z0-9-]+|elevator[_-]?[a-z0-9-]+)$/i.test(input) ||
      /(?:fake|placeholder|dummy)[_-]?(?:id|target)?/i.test(input)
    )
      errors.push(`${label} contains a static floor, target, or fake ID.`);
    return;
  }
  if (Array.isArray(input)) input.forEach((entry, index) => rejectConcreteIds(entry, `${label}[${index}]`, errors));
  else if (input && typeof input === "object")
    for (const [key, entry] of Object.entries(input)) rejectConcreteIds(entry, `${label}.${key}`, errors);
}

export function validateM8ElevatorActionContract(contract) {
  const errors = [];
  exact(contract, ROOT_FIELDS, "M8 elevator contract", errors);
  value(contract?.schemaVersion, 1, "schemaVersion", errors);
  value(contract?.artifactKind, "portfolio_static_action_contract", "artifactKind", errors);
  value(contract?.contractId, "portfolio_m8_elevator_action_contract_v1", "contractId", errors);
  value(contract?.topology, TOPOLOGY, "topology", errors);
  exact(contract?.target, ["gameVersion", "assemblySha256"], "target", errors);
  value(contract?.target?.gameVersion, TARGET.gameVersion, "target.gameVersion", errors);
  value(contract?.target?.assemblySha256, TARGET.assemblySha256, "target.assemblySha256", errors);
  if (!HASH.test(contract?.target?.assemblySha256 ?? ""))
    errors.push("target.assemblySha256 must be a lowercase SHA-256.");

  exact(
    contract?.sourceAudit,
    ["path", "auditId", "traceFamilyId", "anchorIds", "projectionState", "liveState"],
    "sourceAudit",
    errors,
  );
  value(contract?.sourceAudit?.path, SOURCE_AUDIT, "sourceAudit.path", errors);
  value(contract?.sourceAudit?.auditId, "portfolio_m8_mine_route_source_audit_v1", "sourceAudit.auditId", errors);
  value(contract?.sourceAudit?.traceFamilyId, "portfolio_m8_native_mine_route", "sourceAudit.traceFamilyId", errors);
  exactArray(contract?.sourceAudit?.anchorIds, ANCHORS, "sourceAudit.anchorIds", errors);
  value(contract?.sourceAudit?.projectionState, "blocked", "sourceAudit.projectionState", errors);
  value(contract?.sourceAudit?.liveState, "not_performed", "sourceAudit.liveState", errors);

  exact(
    contract?.routeBoundary,
    [
      "selectedVariant",
      "ladderRoute",
      "genericMineRoute",
      "genericTravelRoute",
      "genericWarpRoute",
      "aggregateMonitor",
      "entryBoundary",
    ],
    "routeBoundary",
    errors,
  );
  value(contract?.routeBoundary?.selectedVariant, "elevator_only", "routeBoundary.selectedVariant", errors);
  value(
    contract?.routeBoundary?.ladderRoute,
    "distinct_unselected_route_not_covered_by_this_primitive",
    "routeBoundary.ladderRoute",
    errors,
  );
  value(
    contract?.routeBoundary?.genericMineRoute,
    "prohibited_not_a_typed_action",
    "routeBoundary.genericMineRoute",
    errors,
  );
  value(
    contract?.routeBoundary?.genericTravelRoute,
    "prohibited_not_a_typed_action",
    "routeBoundary.genericTravelRoute",
    errors,
  );
  value(
    contract?.routeBoundary?.genericWarpRoute,
    "prohibited_not_a_typed_action_or_bridge_fallback",
    "routeBoundary.genericWarpRoute",
    errors,
  );
  value(
    contract?.routeBoundary?.aggregateMonitor,
    "reach_mine_floor_is_monitor_only",
    "routeBoundary.aggregateMonitor",
    errors,
  );
  value(
    contract?.routeBoundary?.entryBoundary,
    "fresh_entry_fact_is_checked; enter_mine_is separate or composed only when required",
    "routeBoundary.entryBoundary",
    errors,
  );

  exact(
    contract?.selectedDomain,
    ["kind", "selectionSource", "checkpointGranularity", "finiteDomain", "selectedCheckpoint", "selectionRule"],
    "selectedDomain",
    errors,
  );
  value(contract?.selectedDomain?.kind, "finite_runtime_selected_unlocked_checkpoint", "selectedDomain.kind", errors);
  value(
    contract?.selectedDomain?.selectionSource,
    "runtime_request_plus_fresh_observation",
    "selectedDomain.selectionSource",
    errors,
  );
  value(
    contract?.selectedDomain?.checkpointGranularity,
    "five_floor_checkpoint",
    "selectedDomain.checkpointGranularity",
    errors,
  );
  value(
    contract?.selectedDomain?.finiteDomain,
    "EnabledActions permits select_mine_elevator_floor only for one runtime-selected finite five-floor checkpoint",
    "selectedDomain.finiteDomain",
    errors,
  );
  exact(contract?.selectedDomain?.selectedCheckpoint, ["kind", "value"], "selectedDomain.selectedCheckpoint", errors);
  value(
    contract?.selectedDomain?.selectedCheckpoint?.kind,
    "unselected",
    "selectedDomain.selectedCheckpoint.kind",
    errors,
  );
  value(contract?.selectedDomain?.selectedCheckpoint?.value, null, "selectedDomain.selectedCheckpoint.value", errors);
  value(
    contract?.selectedDomain?.selectionRule,
    "A runtime request selects one finite checkpoint; game-thread revalidation requires EnabledActions permission plus fresh current-floor and unlock facts; no static floor value is accepted",
    "selectedDomain.selectionRule",
    errors,
  );

  exact(
    contract?.action,
    [
      "actionId",
      "actionClass",
      "input",
      "guards",
      "commit",
      "receiptEvidence",
      "freshPostcondition",
      "lifecycle",
      "forbiddenBehavior",
    ],
    "action",
    errors,
  );
  value(contract?.action?.actionId, ACTION, "action.actionId", errors);
  value(contract?.action?.actionClass, "primitive", "action.actionClass", errors);
  exact(
    contract?.action?.input,
    ["selectedCheckpoint", "entry", "currentFloor", "unlockedLevel", "targetResolution"],
    "action.input",
    errors,
  );
  exact(
    contract?.action?.input?.selectedCheckpoint,
    ["kind", "source", "value"],
    "action.input.selectedCheckpoint",
    errors,
  );
  value(
    contract?.action?.input?.selectedCheckpoint?.kind,
    "runtime_selected_checkpoint",
    "action.input.selectedCheckpoint.kind",
    errors,
  );
  value(
    contract?.action?.input?.selectedCheckpoint?.source,
    "bridge_request",
    "action.input.selectedCheckpoint.source",
    errors,
  );
  value(contract?.action?.input?.selectedCheckpoint?.value, null, "action.input.selectedCheckpoint.value", errors);
  freshFact(contract?.action?.input?.entry, "action.input.entry", errors, "mine_entry");
  freshFact(contract?.action?.input?.currentFloor, "action.input.currentFloor", errors, "current_floor");
  freshFact(contract?.action?.input?.unlockedLevel, "action.input.unlockedLevel", errors, "lowestMineLevel");
  opaqueCorrelation(contract?.action?.input?.targetResolution, "action.input.targetResolution", errors);

  exact(
    contract?.action?.guards,
    [
      "gameThreadRevalidation",
      "topology",
      "entry",
      "currentFloor",
      "unlockedLevel",
      "targetUnlocked",
      "enabledActions",
      "checkpointFinite",
      "checkpointMatchesRequest",
      "player",
      "world",
      "revision",
      "policy",
      "deadline",
      "idempotency",
      "cancel",
      "gameState",
    ],
    "action.guards",
    errors,
  );
  value(contract?.action?.guards?.gameThreadRevalidation, true, "action.guards.gameThreadRevalidation", errors);
  value(contract?.action?.guards?.topology, TOPOLOGY, "action.guards.topology", errors);
  value(contract?.action?.guards?.entry, "fresh_native_mine_entry_fact", "action.guards.entry", errors);
  value(
    contract?.action?.guards?.currentFloor,
    "fresh_native_current_floor_fact",
    "action.guards.currentFloor",
    errors,
  );
  value(
    contract?.action?.guards?.unlockedLevel,
    "fresh_native_lowestMineLevel_fact",
    "action.guards.unlockedLevel",
    errors,
  );
  value(contract?.action?.guards?.enabledActions, "required", "action.guards.enabledActions", errors);
  booleans(
    contract?.action?.guards,
    ["targetUnlocked", "checkpointFinite", "checkpointMatchesRequest"],
    "action.guards",
    errors,
  );
  for (const field of ["player", "world", "revision", "policy", "deadline", "idempotency", "cancel", "gameState"])
    value(contract?.action?.guards?.[field], "required", `action.guards.${field}`, errors);

  exact(
    contract?.action?.commit,
    ["transaction", "nativeEffects", "notAHeadlessWarp", "notALadderTransition", "doesNotMutateSaveDirectly"],
    "action.commit",
    errors,
  );
  value(contract?.action?.commit?.transaction, ACTION, "action.commit.transaction", errors);
  exactArray(
    contract?.action?.commit?.nativeEffects,
    ["native_elevator_transition_started", "native_current_floor_transition_observed"],
    "action.commit.nativeEffects",
    errors,
  );
  booleans(
    contract?.action?.commit,
    ["notAHeadlessWarp", "notALadderTransition", "doesNotMutateSaveDirectly"],
    "action.commit",
    errors,
  );
  exactArray(
    contract?.action?.receiptEvidence,
    [
      "entryObserved",
      "currentFloorBefore",
      "lowestMineLevelBefore",
      "opaqueElevatorCorrelationObserved",
      "nativeElevatorTransitionObserved",
      "currentFloorAfter",
      "lowestMineLevelAfter",
    ],
    "action.receiptEvidence",
    errors,
  );
  exact(
    contract?.action?.freshPostcondition,
    ["provenance", "currentFloor", "lowestMineLevel", "targetCheckpoint", "entry", "sameExecution"],
    "action.freshPostcondition",
    errors,
  );
  value(
    contract?.action?.freshPostcondition?.provenance,
    "fresh_native_observation_after_same_execution",
    "freshPostcondition.provenance",
    errors,
  );
  value(
    contract?.action?.freshPostcondition?.currentFloor,
    "matches_selected_checkpoint",
    "freshPostcondition.currentFloor",
    errors,
  );
  value(
    contract?.action?.freshPostcondition?.lowestMineLevel,
    "fresh_native_lowestMineLevel_at_or_above_selected_checkpoint",
    "freshPostcondition.lowestMineLevel",
    errors,
  );
  value(
    contract?.action?.freshPostcondition?.targetCheckpoint,
    "matches_runtime_selected_checkpoint",
    "freshPostcondition.targetCheckpoint",
    errors,
  );
  value(
    contract?.action?.freshPostcondition?.entry,
    "native_mine_entry_fact_rechecked",
    "freshPostcondition.entry",
    errors,
  );
  value(contract?.action?.freshPostcondition?.sameExecution, true, "freshPostcondition.sameExecution", errors);
  exact(
    contract?.action?.lifecycle,
    ["cancellation", "staleRevision", "replay", "saveReopen", "freshObservation"],
    "action.lifecycle",
    errors,
  );
  value(contract?.action?.lifecycle?.cancellation, "local_stop_no_success", "lifecycle.cancellation", errors);
  value(contract?.action?.lifecycle?.staleRevision, "reject", "lifecycle.staleRevision", errors);
  value(contract?.action?.lifecycle?.replay, "idempotent_native_state_or_rejected", "lifecycle.replay", errors);
  value(
    contract?.action?.lifecycle?.saveReopen,
    "not_required_for_already_unlocked_elevator_selection",
    "lifecycle.saveReopen",
    errors,
  );
  value(
    contract?.action?.lifecycle?.freshObservation,
    "required_before_and_after_transition",
    "lifecycle.freshObservation",
    errors,
  );
  exactArray(contract?.action?.forbiddenBehavior, FORBIDDEN, "action.forbiddenBehavior", errors);

  exact(
    contract?.sharedRequestGuards,
    [
      "freshObservation",
      "opaqueTarget",
      "scope",
      "gameThread",
      "revision",
      "policy",
      "deadline",
      "idempotency",
      "cancel",
      "state",
      "noUiOrRawFallback",
    ],
    "sharedRequestGuards",
    errors,
  );
  booleans(
    contract?.sharedRequestGuards,
    Object.keys(contract?.sharedRequestGuards ?? {}),
    "sharedRequestGuards",
    errors,
  );
  exact(
    contract?.sharedEvidenceRules,
    [
      "receiptState",
      "receiptEvidence",
      "postcondition",
      "sameExecution",
      "entry",
      "currentFloor",
      "lowestMineLevel",
      "saveReopen",
    ],
    "sharedEvidenceRules",
    errors,
  );
  booleans(
    contract?.sharedEvidenceRules,
    Object.keys(contract?.sharedEvidenceRules ?? {}).filter((field) => field !== "saveReopen"),
    "sharedEvidenceRules",
    errors,
  );
  value(contract?.sharedEvidenceRules?.saveReopen, false, "sharedEvidenceRules.saveReopen", errors);

  exact(
    contract?.fixtureStatus,
    ["state", "liveClosure", "publication", "provisioningState", "productionAdapterState", "successClaimAllowed"],
    "fixtureStatus",
    errors,
  );
  value(contract?.fixtureStatus?.state, "fixture_needed", "fixtureStatus.state", errors);
  value(contract?.fixtureStatus?.liveClosure, "none", "fixtureStatus.liveClosure", errors);
  value(contract?.fixtureStatus?.publication, "none", "fixtureStatus.publication", errors);
  value(contract?.fixtureStatus?.provisioningState, "unprovisioned", "fixtureStatus.provisioningState", errors);
  value(
    contract?.fixtureStatus?.productionAdapterState,
    "not_implemented",
    "fixtureStatus.productionAdapterState",
    errors,
  );
  value(contract?.fixtureStatus?.successClaimAllowed, false, "fixtureStatus.successClaimAllowed", errors);
  exact(
    contract?.fixtureStartingFacts,
    [
      "topology",
      "saveState",
      "entry",
      "currentFloor",
      "lowestMineLevel",
      "selectedCheckpoint",
      "terminalRouteResult",
      "fixtureMutatesGameplayState",
      "fixtureWritesEvidence",
      "fixtureWritesSave",
      "stagedSaveFixture",
    ],
    "fixtureStartingFacts",
    errors,
  );
  value(contract?.fixtureStartingFacts?.topology, TOPOLOGY, "fixtureStartingFacts.topology", errors);
  value(
    contract?.fixtureStartingFacts?.saveState,
    "target_version_native_only_nonterminal",
    "fixtureStartingFacts.saveState",
    errors,
  );
  value(
    contract?.fixtureStartingFacts?.entry,
    "fresh_native_observation_required",
    "fixtureStartingFacts.entry",
    errors,
  );
  value(
    contract?.fixtureStartingFacts?.currentFloor,
    "fresh_native_observation_required",
    "fixtureStartingFacts.currentFloor",
    errors,
  );
  value(
    contract?.fixtureStartingFacts?.lowestMineLevel,
    "fresh_native_observation_required",
    "fixtureStartingFacts.lowestMineLevel",
    errors,
  );
  value(
    contract?.fixtureStartingFacts?.selectedCheckpoint,
    "unselected_until_runtime_request_and_fresh_observation",
    "fixtureStartingFacts.selectedCheckpoint",
    errors,
  );
  value(
    contract?.fixtureStartingFacts?.terminalRouteResult,
    "absent",
    "fixtureStartingFacts.terminalRouteResult",
    errors,
  );
  value(
    contract?.fixtureStartingFacts?.fixtureMutatesGameplayState,
    "declared_staged_given_only",
    "fixtureStartingFacts.fixtureMutatesGameplayState",
    errors,
  );
  value(
    contract?.fixtureStartingFacts?.fixtureWritesEvidence,
    false,
    "fixtureStartingFacts.fixtureWritesEvidence",
    errors,
  );
  value(
    contract?.fixtureStartingFacts?.fixtureWritesSave,
    "declared_staged_slot_only_canonical_never_written",
    "fixtureStartingFacts.fixtureWritesSave",
    errors,
  );
  value(
    contract?.fixtureStartingFacts?.stagedSaveFixture,
    "design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md",
    "fixtureStartingFacts.stagedSaveFixture",
    errors,
  );
  exactArray(contract?.fixtureCreationRules, FIXTURE_RULES, "fixtureCreationRules", errors);
  exactArray(contract?.forbiddenBehavior, FORBIDDEN, "forbiddenBehavior", errors);
  exactArray(contract?.nonClaims, NON_CLAIMS, "nonClaims", errors);
  value(contract?.fixtureRef, FIXTURE_REF, "fixtureRef", errors);

  rejectConcreteIds(contract?.selectedDomain, "selectedDomain", errors);
  rejectConcreteIds(contract?.action?.input, "action.input", errors);
  rejectConcreteIds(contract?.fixtureStartingFacts, "fixtureStartingFacts", errors);
  return errors;
}

export async function checkM8ElevatorActionContract(contractPath = path.resolve(FIXTURE_REF), root = process.cwd()) {
  let contract;
  try {
    contract = JSON.parse(await readFile(contractPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read or parse contract ${contractPath}: ${error.message}`);
  }
  const errors = validateM8ElevatorActionContract(contract);
  if (errors.length) fail(errors);
  const audit = JSON.parse(await readFile(path.resolve(root, SOURCE_AUDIT), "utf8"));
  const sourceRoot = path.resolve(root, "ref/external/StardewValleyDecompiled/Stardew Valley");
  const sourceFiles = Object.fromEntries(
    await Promise.all(
      audit.anchors.map(async ({ relativePath }) => [
        relativePath,
        await readFile(path.resolve(sourceRoot, relativePath)),
      ]),
    ),
  );
  const auditResult = validatePortfolioM8MineSourceAudit(audit, sourceFiles);
  if (auditResult.projectionState !== "blocked" || auditResult.liveState !== "not_performed")
    fail(["M8 source audit was promoted unexpectedly."], "portfolio_m8_elevator_action_contract_boundary_invalid");
  if (audit.auditId !== contract.sourceAudit.auditId || audit.traceFamilyId !== contract.sourceAudit.traceFamilyId)
    fail(["M8 contract/source-audit identity mismatch."], "portfolio_m8_elevator_action_contract_boundary_invalid");
  return Object.freeze({
    state: "implementation_present_not_live",
    fixtureState: "fixture_needed",
    contractKind: "static_action_contract_only",
    action: ACTION,
    topology: TOPOLOGY,
    sourceAudit: auditResult,
    publication: "none",
    liveClosure: "none",
  });
}

function parseContractArg(argv) {
  const index = argv.indexOf("--contract");
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("--") || argv.slice(index + 2).length)
    throw new Error("Usage: node tools/stardew-portfolio-m8-elevator-action-contract.mjs --contract <path>");
  return argv[index + 1];
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(
        await checkM8ElevatorActionContract(path.resolve(parseContractArg(process.argv.slice(2)))),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`stardew-portfolio-m8-elevator-action-contract: ${error.message}`);
    process.exitCode = 1;
  }
}
