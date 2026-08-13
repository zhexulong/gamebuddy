import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateNativeTransitionLedger } from "./lib/stardew-native-transition-ledger.mjs";

const sourceText = "class Fixture { void Route() {} void Commit() {} void Resume() {} void Gap() {} }";
const sourcePath = "StardewValley/Fixture.cs";
const sourceFileSha256 = createHash("sha256").update(sourceText).digest("hex");
const sourceFiles = { [sourcePath]: { sha256: sourceFileSha256, text: sourceText } };
const expectedMechanismIds = ["mechanism:fixture"];
const expectedMechanismRecords = [
  {
    mechanismId: "mechanism:fixture",
    sourcePath,
    sourceLocator: {
      startByte: sourceText.indexOf("Route"),
      endByte: sourceText.indexOf("Route") + "Route".length,
      sliceSha256: createHash("sha256").update("Route").digest("hex"),
    },
  },
];
const attestation = { targetAssemblySha256: "a".repeat(64), sourceManifestSha256: "b".repeat(64) };
const scopeManifest = {
  schemaVersion: 1,
  artifactKind: "native_transition_scope_manifest",
  attestation,
  scope: "normal_player_vanilla",
  exclusionBoundaries: [
    {
      boundaryId: "scope:fixture",
      boundaryKind: "test-boundary",
      scopeReason: "Fixture excludes this native host.",
      sourceAnchor: null,
    },
  ],
};
function anchor(member) {
  const identifier = member.split(/[.#]/).filter(Boolean).at(-1);
  const startByte = sourceText.indexOf(identifier);
  const endByte = startByte + identifier.length;
  return {
    sourcePath,
    member,
    startByte,
    endByte,
    sourceSliceSha256: createHash("sha256").update(Buffer.from(sourceText).subarray(startByte, endByte)).digest("hex"),
    sourceFileSha256,
  };
}
function observation(stateSyntax, member = "Fixture.Commit") {
  return { ownerSyntax: "Fixture", stateSyntax, anchor: anchor(member) };
}
function handoff(toTransitionId, sequence = 0, condition = "always", phase = "after_commit") {
  return { toTransitionId, kind: "direct_call", phase, sequence, handoffAnchor: anchor("Fixture.Route"), condition };
}
function ledger(overrides = {}) {
  const result = {
    schemaVersion: 2,
    artifactKind: "native_transition_continuation_ledger",
    attestation: { ...attestation },
    closureState: "partial",
    scopedMechanismIds: expectedMechanismIds,
    transitions: [
      {
        transitionId: "transition:router",
        kind: "source_router",
        incomingMechanismIds: ["mechanism:fixture"],
        handoffs: [handoff("transition:commit")],
        exitCoverage: "exhaustive",
        ownerAnchor: anchor("Fixture.Route"),
        routerReason: "Forwards to owned commit.",
        possiblyGameplayBearing: true,
      },
      {
        transitionId: "transition:commit",
        kind: "source_owned_transition",
        incomingMechanismIds: [],
        handoffs: [handoff("transition:resume")],
        exitCoverage: "exhaustive",
        ownerAnchor: anchor("Fixture.Commit"),
        commitAnchor: anchor("Fixture.Commit"),
        postStateObservations: [observation("fixtureState")],
        pendingNativeContinuationState: [],
        possiblyGameplayBearing: true,
      },
      {
        transitionId: "transition:resume",
        kind: "owner_managed_continuation",
        incomingMechanismIds: [],
        handoffs: [handoff("transition:out-of-scope")],
        exitCoverage: "exhaustive",
        ownerAnchor: anchor("Fixture.Resume"),
        registrationAnchor: anchor("Fixture.Commit"),
        terminalAnchor: anchor("Fixture.Resume"),
        postStateObservations: [],
        pendingNativeContinuationState: [observation("pendingPhase", "Fixture.Resume")],
        possiblyGameplayBearing: true,
      },
      {
        transitionId: "transition:out-of-scope",
        kind: "scope_exclusion_boundary",
        incomingMechanismIds: [],
        handoffs: [],
        exitCoverage: "exhaustive",
        boundaryAnchor: anchor("Fixture.Gap"),
        boundaryKind: "test-boundary",
        scopeDisposition: "out_of_scope",
        scopeReason: "Fixture excludes this native host.",
        possiblyGameplayBearing: false,
        nonGameplayReason: "Explicitly excluded by fixture scope.",
        nonGameplayReasonAnchor: anchor("Fixture.Gap"),
      },
    ],
    rootBindings: [{ mechanismId: "mechanism:fixture", transitionId: "transition:router" }],
    ...overrides,
  };
  for (const node of result.transitions)
    node.exitInventory ??= (node.handoffs ?? []).map((item) => ({
      exitId: `exit:${item.sequence}`,
      kind: "handoff",
      handoffSequence: item.sequence,
      anchor: item.handoffAnchor,
    }));
  const boundary = result.transitions.find((node) => node.kind === "scope_exclusion_boundary");
  if (boundary) {
    boundary.scopeManifestBoundaryId ??= "scope:fixture";
    scopeManifest.exclusionBoundaries[0].sourceAnchor = boundary.boundaryAnchor;
  }
  return result;
}
function validate(value) {
  return validateNativeTransitionLedger(value, {
    expectedMechanismIds,
    expectedMechanismRecords,
    sourceFiles,
    expectedAttestation: attestation,
    scopeManifest,
  });
}

test("requires source-owned post-state and pending native continuation observations", () => {
  assert.deepEqual(validate(ledger()), {
    transitionCount: 4,
    rootBindingCount: 1,
    scopedMechanismCount: 1,
    blockingNodeCount: 0,
    closureState: "partial",
  });
});
test("verifies source byte spans and hashes against the exact source manifest", () => {
  const attestationMismatch = ledger();
  attestationMismatch.attestation.targetAssemblySha256 = "c".repeat(64);
  assert.throws(() => validate(attestationMismatch), { code: "transition_ledger_attestation_mismatch" });
  const stale = ledger();
  stale.transitions[1].commitAnchor.sourceSliceSha256 = "c".repeat(64);
  assert.throws(() => validate(stale), { code: "transition_ledger_anchor_slice_stale" });
  const fake = ledger();
  fake.transitions[1].commitAnchor.member = "NotARealMember";
  assert.throws(() => validate(fake), { code: "transition_ledger_anchor_member_unproven" });
});
test("rejects empty routers, missing continuation registration/resume, and partial exits without a gap", () => {
  const empty = ledger();
  empty.transitions[0].handoffs = [];
  assert.throws(() => validate(empty), { code: "transition_ledger_empty_nonterminal" });
  const noRegistration = ledger();
  delete noRegistration.transitions[2].registrationAnchor;
  assert.throws(() => validate(noRegistration), { code: "transition_ledger_invalid" });
  const partial = ledger();
  partial.transitions[1].exitCoverage = "partial";
  assert.throws(() => validate(partial), { code: "transition_ledger_partial_exit_without_gap" });
  const fakeExhaustive = ledger();
  fakeExhaustive.transitions[0].exitInventory = [];
  assert.throws(() => validate(fakeExhaustive), { code: "transition_ledger_exit_inventory_incomplete" });
});
test("rejects unordered/dangling handoffs and unscoped mechanism injection", () => {
  const bindingMismatch = ledger();
  bindingMismatch.transitions[1].incomingMechanismIds = ["mechanism:fixture"];
  bindingMismatch.rootBindings[0].transitionId = "transition:commit";
  assert.throws(() => validate(bindingMismatch), { code: "transition_ledger_root_anchor_mismatch" });
  const duplicatedIncoming = ledger();
  duplicatedIncoming.transitions[0].incomingMechanismIds.push("mechanism:fixture");
  assert.throws(() => validate(duplicatedIncoming), { code: "transition_ledger_duplicate_incoming_mechanism" });
  const rootAnchorMismatch = ledger();
  rootAnchorMismatch.transitions[0].ownerAnchor = anchor("Fixture.Commit");
  assert.throws(() => validate(rootAnchorMismatch), { code: "transition_ledger_root_anchor_mismatch" });
  const dangling = ledger();
  dangling.transitions[0].handoffs[0].toTransitionId = "transition:missing";
  assert.throws(() => validate(dangling), { code: "transition_ledger_dangling_handoff" });
  const duplicateSequence = ledger();
  duplicateSequence.transitions[0].handoffs.push(handoff("transition:commit", 0));
  assert.throws(() => validate(duplicateSequence), { code: "transition_ledger_duplicate_handoff_sequence" });
  const unscoped = ledger();
  unscoped.rootBindings.push({ mechanismId: "mechanism:outside", transitionId: "transition:commit" });
  assert.throws(() => validate(unscoped), { code: "transition_ledger_unscoped_mechanism" });
});
test("prevents boundary laundering and public API vocabulary", () => {
  const nonBlockingGap = ledger();
  nonBlockingGap.transitions[3] = {
    transitionId: "transition:gap",
    kind: "unresolved_gap",
    incomingMechanismIds: [],
    handoffs: [],
    exitCoverage: "exhaustive",
    boundaryAnchor: anchor("Fixture.Gap"),
    gapOrBoundaryReason: "dynamic receiver",
    possiblyGameplayBearing: false,
    nonGameplayReason: "not reviewed",
    nonGameplayReasonAnchor: anchor("Fixture.Gap"),
  };
  nonBlockingGap.transitions[2].handoffs = [handoff("transition:gap")];
  assert.throws(() => validate(nonBlockingGap), { code: "transition_ledger_gap_must_block" });
  const gap = ledger();
  gap.transitions[3] = {
    transitionId: "transition:gap",
    kind: "unresolved_gap",
    incomingMechanismIds: [],
    handoffs: [],
    exitCoverage: "exhaustive",
    boundaryAnchor: anchor("Fixture.Gap"),
    gapOrBoundaryReason: "dynamic receiver",
    possiblyGameplayBearing: true,
  };
  gap.transitions[2].handoffs = [handoff("transition:gap")];
  gap.closureState = "native_transition_closure_complete";
  assert.throws(() => validate(gap), { code: "transition_ledger_blocking_gap" });
  const wrongBoundary = ledger();
  wrongBoundary.transitions[3].scopeDisposition = "in_scope_dependency";
  assert.throws(() => validate(wrongBoundary), { code: "transition_ledger_boundary_not_excluded" });
  const unapprovedBoundary = ledger();
  unapprovedBoundary.transitions[3].scopeManifestBoundaryId = "missing";
  assert.throws(() => validate(unapprovedBoundary), { code: "transition_ledger_scope_boundary_unapproved" });
  assert.throws(() => validate({ ...ledger(), publicActionId: "forbidden" }), {
    code: "transition_ledger_forbidden_field",
  });
});
