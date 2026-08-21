#!/usr/bin/env node
import path from "node:path";
/**
 * Static, fail-closed Batch B2 contract for the M10 Museum transitions.
 * It describes the implementation and unprovisioned fixture boundary only;
 * it never launches Stardew, grants capability, invokes UI, or writes a save.
 */
import { fileURLToPath } from "node:url";
import { readContainedFile as readHardenedContainedFile } from "./lib/stardew-portfolio-m10-donate-museum-source-boundary.mjs";
import { validatePortfolioM10MuseumSourceAudit } from "./lib/stardew-portfolio-m10-museum-source-audit.mjs";

const TOPOLOGY = "single_player_native_companion";
const TARGET_VERSION = "1.6.15.24356";
const SOURCE_AUDIT = "tools/stardew-portfolio-m10-museum-source-audit.json";
const ACTION_CONTRACT_REF = "tools/stardew-portfolio-m10-museum-action-contract.json";
const FIXTURE_REF = "fixtures/stardew/portfolio-m10-museum-contract.json";
const SOURCE_ANCHOR_IDS = Object.freeze([
  "museum_item_eligibility_guard",
  "museum_donation_mutex_presentation",
  "museum_placement_guard",
  "museum_piece_commit",
  "museum_donation_item_consumption",
  "museum_reward_eligibility_guard",
  "museum_reward_collection_presentation",
  "museum_reward_claim_commit",
]);
const FORBIDDEN = Object.freeze([
  "UI automation, window/visual inspection, keyboard/mouse/XInput, or coordinate selection",
  "Game1.activeClickableMenu, MuseumMenu, ItemGrabMenu, raw menu callback, or dialogue callback invocation",
  "GameLocation.checkAction, LibraryMuseum.OpenDonationMenu, OpenRewardMenu, or any raw dispatcher string",
  "save XML editing, direct net-world-state/player/mail/inventory mutation, or fixture-written result state",
  "arbitrary native call fallback, reflection, private callback invocation, or generic method-name dispatch",
]);
const NON_CLAIMS = Object.freeze([
  "This contract does not publish donate_museum_item or claim_museum_reward.",
  "The typed Mod implementation is implementation_needed; the independent starting-state fixture is fixture_needed.",
  "This contract has no live closure, receipt evidence, target-version execution, or release evidence.",
  "This contract is not a Portfolio milestone pass and cannot be promoted from static or fixture evidence.",
]);
const FIXTURE_FIELDS = Object.freeze([
  "schemaVersion",
  "fixtureId",
  "topology",
  "targetVersion",
  "purpose",
  "status",
  "startingState",
  "freshSelectionRequirements",
  "antiFinalStepAssertions",
  "forbiddenBehavior",
  "nonClaims",
]);
const FIXTURE_FORBIDDEN = Object.freeze([
  "terminal museum completion, preloaded selected pieces, preloaded reward eligibility, or claimed reward mail",
  "save XML editing, direct museumPieces/inventory/mail mutation, or synthetic receipt/postcondition creation",
  "UI/input automation, MuseumMenu/ItemGrabMenu callback invocation, raw dispatcher, or arbitrary native fallback",
]);
const FIXTURE_NON_CLAIMS = Object.freeze([
  "This fixture contract does not provision a save, publish an action, or establish live evidence.",
  "The fixture must not contain concrete item IDs, reward IDs, opaque targets, receipts, or terminal collection state.",
]);

function fail(message, code = "portfolio_m10_museum_action_contract_invalid") {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object.`);
  return value;
}
function exact(value, fields, name) {
  object(value, name);
  const expected = new Set(fields);
  const actual = Object.keys(value);
  for (const field of fields) if (!Object.hasOwn(value, field)) fail(`${name} is missing field ${field}.`);
  for (const field of actual) if (!expected.has(field)) fail(`${name} has unknown field ${field}.`);
}
function exactArray(value, expected, name) {
  if (JSON.stringify(value) !== JSON.stringify(expected)) fail(`${name} must match the approved bounded policy.`);
}
function nonEmpty(value, name) {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} must be a non-empty string.`);
}
function noConcreteIds(value, name) {
  if (typeof value === "string") {
    if (/^(?:\(O\)|\(BC\)|\(F\))/.test(value) || /(?:fake|placeholder|dummy|test)[_-]?id/i.test(value))
      fail(`${name} contains a concrete or fake item/reward ID.`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((entry, i) => noConcreteIds(entry, `${name}[${i}]`));
  if (value && typeof value === "object")
    for (const [key, entry] of Object.entries(value)) noConcreteIds(entry, `${name}.${key}`);
}
function validateOpaque(value, name, kind) {
  exact(value, ["kind", "source", "value"], name);
  if (value.kind !== kind || value.source !== "fresh_observation" || value.value !== null)
    fail(`${name} must be an unmaterialized fresh opaque runtime value.`);
}
function validateDomain(value) {
  exact(value, ["kind", "selection", "values", "placeholder", "minCount", "maxCount"], "pieceDomain");
  if (value.kind !== "finite_dsm_piece_domain" || value.selection !== "frozen_dsm_plus_fresh_observation")
    fail("pieceDomain must be a finite DSM domain resolved from fresh observation.");
  if (!Array.isArray(value.values) || value.values.length !== 0)
    fail("pieceDomain.values must stay empty until fresh selection; static IDs are forbidden.");
  exact(value.placeholder, ["kind", "value"], "pieceDomain.placeholder");
  if (value.placeholder.kind !== "unselected" || value.placeholder.value !== null)
    fail("pieceDomain placeholder must be explicit unselected/null.");
  if (
    !Number.isInteger(value.minCount) ||
    value.minCount !== 1 ||
    !Number.isInteger(value.maxCount) ||
    value.maxCount !== 40
  )
    fail("pieceDomain cardinality must be the bounded 1..40 domain.");
}
function validateGuards(value, name) {
  exact(
    value,
    [
      "gameThreadRevalidation",
      "topology",
      "player",
      "world",
      "revision",
      "policy",
      "deadline",
      "idempotency",
      "cancel",
      "gameState",
    ],
    name,
  );
  if (value.gameThreadRevalidation !== true || value.topology !== TOPOLOGY)
    fail(`${name} must require game-thread topology revalidation.`);
  for (const field of ["player", "world", "revision", "policy", "deadline", "idempotency", "cancel", "gameState"])
    if (value[field] !== "required") fail(`${name}.${field} must be required.`);
}
function validateAction(action, expectedId) {
  exact(
    action,
    [
      "actionId",
      "actionClass",
      "target",
      "input",
      "guards",
      "commit",
      "repeatedSemantics",
      "terminalReceipt",
      "freshPostcondition",
      "lifecycle",
      "forbiddenBehavior",
    ],
    `${expectedId} action`,
  );
  if (action.actionId !== expectedId || action.actionClass !== "primitive")
    fail(`${expectedId} action identity/class is invalid.`);
  validateGuards(action.guards, `${expectedId}.guards`);
  exactArray(action.forbiddenBehavior, FORBIDDEN, `${expectedId}.forbiddenBehavior`);
  exact(
    action.input,
    expectedId === "donate_museum_item"
      ? ["piece", "placement", "quantity", "selection"]
      : ["reward", "selection", "delivery"],
    `${expectedId}.input`,
  );
  if (expectedId === "donate_museum_item") {
    validateOpaque(action.input.piece, `${expectedId}.input.piece`, "opaque_runtime_museum_piece");
    validateOpaque(action.input.placement, `${expectedId}.input.placement`, "opaque_runtime_museum_placement");
    if (action.input.quantity !== "exactly_one" || action.input.selection !== "finite_dsm_piece_domain")
      fail("donate_museum_item input must select exactly one fresh DSM piece and placement.");
    exact(action.target, ["piece", "placement"], `${expectedId}.target`);
    validateOpaque(action.target.piece, `${expectedId}.target.piece`, "opaque_runtime_museum_piece");
    validateOpaque(action.target.placement, `${expectedId}.target.placement`, "opaque_runtime_museum_placement");
    exact(
      action.commit,
      ["transaction", "effects", "inventoryEffect", "collectionEffect", "rewardEffect", "separateFromRewardClaim"],
      `${expectedId}.commit`,
    );
    if (
      action.commit.transaction !== "native_museum_donation" ||
      action.commit.inventoryEffect !== "one_item_consumed" ||
      action.commit.collectionEffect !== "one_piece_added" ||
      action.commit.rewardEffect !== "none" ||
      action.commit.separateFromRewardClaim !== true
    )
      fail("donate_museum_item must distinguish inventory/collection changes from reward claim.");
    exactArray(
      action.commit.effects,
      ["piece_placement_committed", "one_inventory_item_consumed", "one_collection_piece_added"],
      `${expectedId}.commit.effects`,
    );
    exact(
      action.repeatedSemantics,
      ["mode", "onePiecePerExecution", "finiteDomain", "freshSelectionEachExecution", "samePieceRejectedAfterCommit"],
      `${expectedId}.repeatedSemantics`,
    );
    if (
      action.repeatedSemantics.mode !== "repeat_single_piece_donation" ||
      action.repeatedSemantics.onePiecePerExecution !== true ||
      action.repeatedSemantics.finiteDomain !== "pieceDomain" ||
      action.repeatedSemantics.freshSelectionEachExecution !== true ||
      action.repeatedSemantics.samePieceRejectedAfterCommit !== true
    )
      fail("donate_museum_item repeated semantics are invalid.");
    exact(
      action.freshPostcondition,
      ["provenance", "inventoryDelta", "collectionDelta", "rewardDelta", "placement", "freshObservation"],
      `${expectedId}.freshPostcondition`,
    );
    if (
      action.freshPostcondition.provenance !== "fresh_native_observation" ||
      action.freshPostcondition.inventoryDelta !== "minus_one_exact_item" ||
      action.freshPostcondition.collectionDelta !== "plus_one_piece" ||
      action.freshPostcondition.rewardDelta !== "unchanged" ||
      action.freshPostcondition.placement !== "new_native_museum_piece_placement" ||
      action.freshPostcondition.freshObservation !== true
    )
      fail("donate_museum_item postcondition must prove inventory and collection, not reward delivery.");
  } else {
    exact(action.target, ["reward"], `${expectedId}.target`);
    validateOpaque(action.target.reward, `${expectedId}.target.reward`, "opaque_runtime_museum_reward");
    validateOpaque(action.input.reward, `${expectedId}.input.reward`, "opaque_runtime_museum_reward");
    if (action.input.selection !== "finite_dsm_reward_domain" || action.input.delivery !== "native_reward_delivery")
      fail("claim_museum_reward input must select a fresh DSM reward and native delivery.");
    exact(
      action.commit,
      ["transaction", "effects", "inventoryEffect", "collectionEffect", "rewardEffect", "separateFromDonation"],
      `${expectedId}.commit`,
    );
    if (
      action.commit.transaction !== "native_museum_reward_claim" ||
      action.commit.inventoryEffect !== "reward_delivery_only" ||
      action.commit.collectionEffect !== "unchanged" ||
      action.commit.rewardEffect !== "one_reward_claimed" ||
      action.commit.separateFromDonation !== true
    )
      fail("claim_museum_reward must remain separate from donation and collection progress.");
    exactArray(
      action.commit.effects,
      ["reward_eligibility_consumed", "native_reward_delivered"],
      `${expectedId}.commit.effects`,
    );
    exact(
      action.repeatedSemantics,
      ["mode", "oneClaimPerEligibleReward", "finiteDomain", "donationExecutionIndependent", "alreadyClaimedRejected"],
      `${expectedId}.repeatedSemantics`,
    );
    if (
      action.repeatedSemantics.mode !== "independent_reward_claim" ||
      action.repeatedSemantics.oneClaimPerEligibleReward !== true ||
      action.repeatedSemantics.finiteDomain !== "rewardDomain" ||
      action.repeatedSemantics.donationExecutionIndependent !== true ||
      action.repeatedSemantics.alreadyClaimedRejected !== true
    )
      fail("claim_museum_reward repeated semantics are invalid.");
    exact(
      action.freshPostcondition,
      ["provenance", "inventoryDelta", "collectionDelta", "rewardDelta", "eligibility", "freshObservation"],
      `${expectedId}.freshPostcondition`,
    );
    if (
      action.freshPostcondition.provenance !== "fresh_native_observation" ||
      action.freshPostcondition.inventoryDelta !== "plus_one_reward_or_native_delivery" ||
      action.freshPostcondition.collectionDelta !== "unchanged" ||
      action.freshPostcondition.rewardDelta !== "plus_one_claim" ||
      action.freshPostcondition.eligibility !== "consumed" ||
      action.freshPostcondition.freshObservation !== true
    )
      fail("claim_museum_reward postcondition must prove reward delivery, not donation progress.");
  }
  exact(
    action.terminalReceipt,
    ["state", "evidence", "sameExecution", "actionSpecific"],
    `${expectedId}.terminalReceipt`,
  );
  if (
    action.terminalReceipt.state !== "succeeded" ||
    action.terminalReceipt.evidence !== "non_empty_action_specific" ||
    action.terminalReceipt.sameExecution !== true ||
    action.terminalReceipt.actionSpecific !== true
  )
    fail(`${expectedId} terminal receipt is not strict.`);
  exact(action.lifecycle, ["cancellation", "saveReopen"], `${expectedId}.lifecycle`);
  if (
    action.lifecycle.cancellation !== "local_stop_no_success" ||
    action.lifecycle.saveReopen !== "required_when_composed"
  )
    fail(`${expectedId} lifecycle policy is invalid.`);
  noConcreteIds(action, `${expectedId}.action`);
}

export function validateMuseumFixtureContract(fixture) {
  exact(fixture, FIXTURE_FIELDS, "M10 museum fixture contract");
  if (
    fixture.schemaVersion !== 1 ||
    fixture.fixtureId !== "portfolio_m10_museum_nonterminal_v1" ||
    fixture.topology !== TOPOLOGY ||
    fixture.targetVersion !== TARGET_VERSION
  )
    fail("M10 museum fixture identity/topology/version is invalid.");
  nonEmpty(fixture.purpose, "fixture.purpose");
  exact(fixture.status, ["state", "provisioningState", "liveClosure", "successClaimAllowed"], "fixture.status");
  if (
    fixture.status.state !== "fixture_needed" ||
    fixture.status.provisioningState !== "unprovisioned" ||
    fixture.status.liveClosure !== "none" ||
    fixture.status.successClaimAllowed !== false
  )
    fail("M10 fixture must remain unprovisioned with no live closure.");
  exact(
    fixture.startingState,
    ["saveCreatedBy", "museumPieces", "playerInventory", "rewardMail", "terminalFacts"],
    "fixture.startingState",
  );
  if (
    fixture.startingState.saveCreatedBy !== "target_version_native_only" ||
    fixture.startingState.museumPieces !== "nonterminal_empty_or_unselected" ||
    fixture.startingState.playerInventory !== "ordinary_native_inventory" ||
    fixture.startingState.rewardMail !== "no_museum_reward_claims" ||
    fixture.startingState.terminalFacts !== "absent"
  )
    fail("M10 fixture starting state is terminal, synthetic, or otherwise invalid.");
  exact(
    fixture.freshSelectionRequirements,
    [
      "pieceSet",
      "placementSet",
      "itemEligibility",
      "inventoryDeltaBaseline",
      "collectionDeltaBaseline",
      "rewardEligibilityBaseline",
    ],
    "fixture.freshSelectionRequirements",
  );
  if (
    fixture.freshSelectionRequirements.pieceSet !== "select_from_fresh_observation_with_finite_dsm_domain" ||
    fixture.freshSelectionRequirements.placementSet !== "select_from_fresh_observation_with_finite_dsm_domain" ||
    fixture.freshSelectionRequirements.itemEligibility !== "native_revalidated" ||
    fixture.freshSelectionRequirements.inventoryDeltaBaseline !== "capture_before_each_donation" ||
    fixture.freshSelectionRequirements.collectionDeltaBaseline !== "capture_before_each_donation" ||
    fixture.freshSelectionRequirements.rewardEligibilityBaseline !== "capture_before_claim"
  )
    fail("M10 fixture selection requirements are invalid.");
  exactArray(
    fixture.antiFinalStepAssertions,
    [
      "No donation or reward claim request, receipt, postcondition, or final-result script occurs during fixture creation.",
      "The selected piece and placement domains remain unmaterialized; no fake item ID substitutes for an unselected value.",
      "The fixture contains no terminal collection count, completion flag, reward eligibility, reward inventory delta, or reward mail.",
    ],
    "fixture.antiFinalStepAssertions",
  );
  exactArray(fixture.forbiddenBehavior, FIXTURE_FORBIDDEN, "fixture.forbiddenBehavior");
  exactArray(fixture.nonClaims, FIXTURE_NON_CLAIMS, "fixture.nonClaims");
  noConcreteIds(fixture, "fixture");
  return Object.freeze({
    fixtureId: fixture.fixtureId,
    state: "fixture_needed",
    provisioningState: "unprovisioned",
    liveClosure: "none",
  });
}

export function validateMuseumActionContract(contract) {
  exact(
    contract,
    [
      "schemaVersion",
      "artifactKind",
      "contractId",
      "milestone",
      "topology",
      "targetVersion",
      "sourceAudit",
      "pieceDomain",
      "actions",
      "stateDomains",
      "sharedRequestGuards",
      "sharedEvidenceRules",
      "status",
      "forbiddenBehavior",
      "nonClaims",
      "fixtureContractRef",
    ],
    "M10 museum action contract",
  );
  if (
    contract.schemaVersion !== 1 ||
    contract.artifactKind !== "portfolio_static_action_contract" ||
    contract.contractId !== "portfolio_m10_museum_actions_v1" ||
    contract.milestone !== "M10"
  )
    fail("M10 museum action contract identity is invalid.");
  if (contract.topology !== TOPOLOGY || contract.targetVersion !== TARGET_VERSION)
    fail("M10 topology/target version is invalid.");
  exact(contract.sourceAudit, ["path", "auditId", "anchorIds", "projectionState", "liveState"], "sourceAudit");
  if (
    contract.sourceAudit.path !== SOURCE_AUDIT ||
    contract.sourceAudit.auditId !== "portfolio_m10_museum_source_audit_v1"
  )
    fail("source audit binding is invalid.");
  exactArray(contract.sourceAudit.anchorIds, SOURCE_ANCHOR_IDS, "sourceAudit.anchorIds");
  if (contract.sourceAudit.projectionState !== "blocked" || contract.sourceAudit.liveState !== "not_performed")
    fail("source audit identity/state is invalid.");
  validateDomain(contract.pieceDomain);
  exactArray(
    contract.actions.map((action) => action.actionId),
    ["donate_museum_item", "claim_museum_reward"],
    "actions.actionId",
  );
  validateAction(contract.actions[0], "donate_museum_item");
  validateAction(contract.actions[1], "claim_museum_reward");
  exact(
    contract.stateDomains,
    ["inventory", "collection", "reward", "donationReceipt", "claimReceipt"],
    "stateDomains",
  );
  if (
    contract.stateDomains.inventory !==
      "donation consumes one ordinary native inventory item; reward claim delivery is recorded separately" ||
    contract.stateDomains.collection !== "donation adds one native MuseumPieces entry; reward claim does not" ||
    contract.stateDomains.reward !==
      "claim consumes native reward eligibility and delivers the selected reward; donation does not claim it" ||
    contract.stateDomains.donationReceipt !==
      "same execution succeeded with non-empty donation-specific evidence and fresh inventory/collection deltas" ||
    contract.stateDomains.claimReceipt !==
      "same execution succeeded with non-empty claim-specific evidence and fresh reward delivery/eligibility delta"
  )
    fail("M10 inventory/collection/reward state domains are not explicit.");
  exact(
    contract.sharedRequestGuards,
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
  );
  for (const field of Object.keys(contract.sharedRequestGuards))
    if (contract.sharedRequestGuards[field] !== true) fail(`sharedRequestGuards.${field} must be true.`);
  exact(
    contract.sharedEvidenceRules,
    [
      "receiptState",
      "receiptEvidence",
      "postcondition",
      "sameExecution",
      "inventoryDelta",
      "collectionDelta",
      "rewardEligibility",
      "saveReopen",
    ],
    "sharedEvidenceRules",
  );
  for (const field of Object.keys(contract.sharedEvidenceRules))
    if (contract.sharedEvidenceRules[field] !== true) fail(`sharedEvidenceRules.${field} must be true.`);
  exact(contract.status, ["implementation", "fixture", "liveClosure", "publication"], "status");
  if (
    contract.status.implementation !== "implementation_needed" ||
    contract.status.fixture !== "fixture_needed" ||
    contract.status.liveClosure !== "none" ||
    contract.status.publication !== "none"
  )
    fail("M10 contract status must remain implementation_needed/fixture_needed/no live closure.");
  exactArray(contract.forbiddenBehavior, FORBIDDEN, "forbiddenBehavior");
  exactArray(contract.nonClaims, NON_CLAIMS, "nonClaims");
  if (contract.fixtureContractRef !== FIXTURE_REF) fail("fixtureContractRef is invalid.");
  noConcreteIds(contract, "contract");
  return Object.freeze({
    state: "implementation_needed",
    fixtureState: "fixture_needed",
    contractKind: "static_action_contract_only",
    liveClosure: "none",
    publication: "none",
    actions: ["donate_museum_item", "claim_museum_reward"],
  });
}

function safeRelativePath(value, name) {
  if (typeof value !== "string" || !value || value.includes("\0") || path.isAbsolute(value))
    fail(`${name} must be a non-empty safe relative path.`);
  const parts = value.replaceAll("\\", "/").split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    fail(`${name} must be a non-empty safe relative path.`);
  return value;
}
async function readContainedFile(root, target, name) {
  const bytes = await readHardenedContainedFile(root, target, {
    missingCode: "m10_contract_input_missing",
    reparseCode: "m10_contract_reparse_detected",
  });
  if (!Buffer.isBuffer(bytes)) fail(`Unsafe non-byte read for ${name}.`);
  return bytes;
}
function validateAuditAnchorManifest(audit) {
  if (!audit || typeof audit !== "object" || Array.isArray(audit) || !Array.isArray(audit.anchors))
    fail("M10 source audit anchor manifest is invalid.");
  for (const anchor of audit.anchors) {
    exact(
      anchor,
      ["anchorId", "relativePath", "startByte", "endByte", "fileSha256", "sliceSha256", "needle", "semanticRole"],
      "M10 source audit anchor manifest",
    );
    safeRelativePath(anchor.relativePath, "M10 source audit anchor relativePath");
  }
}

export async function checkMuseumActionContract(
  contractPath = path.resolve(ACTION_CONTRACT_REF),
  root = path.resolve("."),
) {
  const approvedRoot = path.resolve(root);
  const contractTarget = path.resolve(contractPath instanceof URL ? fileURLToPath(contractPath) : contractPath);
  let contract;
  try {
    contract = JSON.parse(
      (await readContainedFile(approvedRoot, contractTarget, "M10 action contract")).toString("utf8"),
    );
  } catch (error) {
    throw new Error(`Unable to read or parse M10 action contract ${contractTarget}: ${error.message}`);
  }
  const result = validateMuseumActionContract(contract);
  const fixturePath = path.resolve(approvedRoot, FIXTURE_REF);
  let fixture;
  try {
    fixture = JSON.parse((await readContainedFile(approvedRoot, fixturePath, "M10 fixture contract")).toString("utf8"));
  } catch (error) {
    throw new Error(`Unable to read or parse M10 fixture contract ${fixturePath}: ${error.message}`);
  }
  const fixtureResult = validateMuseumFixtureContract(fixture);
  const auditPath = path.resolve(approvedRoot, SOURCE_AUDIT);
  let audit;
  try {
    audit = JSON.parse((await readContainedFile(approvedRoot, auditPath, "M10 source audit")).toString("utf8"));
  } catch (error) {
    throw new Error(`Unable to read or parse M10 source audit ${auditPath}: ${error.message}`);
  }
  validateAuditAnchorManifest(audit);
  const sourceRoot = path.resolve(approvedRoot, "ref/external/StardewValleyDecompiled/Stardew Valley");
  const files = Object.fromEntries(
    await Promise.all(
      audit.anchors.map(async ({ relativePath }) => {
        const sourcePath = path.resolve(
          sourceRoot,
          safeRelativePath(relativePath, "M10 source audit anchor relativePath"),
        );
        return [relativePath, await readContainedFile(sourceRoot, sourcePath, `M10 source anchor ${relativePath}`)];
      }),
    ),
  );
  const auditResult = validatePortfolioM10MuseumSourceAudit(audit, files);
  if (
    auditResult.auditId !== contract.sourceAudit.auditId ||
    auditResult.projectionState !== "blocked" ||
    auditResult.liveState !== "not_performed"
  )
    fail("M10 source audit identity or boundary changed.");
  return Object.freeze({
    ...result,
    fixture: fixtureResult,
    sourceAudit: {
      auditId: auditResult.auditId,
      anchorCount: auditResult.anchorCount,
      projectionState: auditResult.projectionState,
      liveState: auditResult.liveState,
    },
    fixtureContract: contract.fixtureContractRef,
  });
}

function parseContractArg(argv) {
  const index = argv.indexOf("--contract");
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("--") || argv.slice(index + 2).length)
    throw new Error("Usage: node tools/stardew-portfolio-m10-museum-action-contract.mjs --contract <path>");
  return argv[index + 1];
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await checkMuseumActionContract(parseContractArg(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(`stardew-portfolio-m10-museum-action-contract: ${error.message}`);
    process.exitCode = 1;
  }
}
