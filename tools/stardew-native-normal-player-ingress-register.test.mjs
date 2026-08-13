import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateNativeNormalPlayerIngressRegister } from "./lib/stardew-native-normal-player-ingress-register.mjs";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const source = "void Entry() { if (input) Target(); } void Target() {}";
const fileSha = sha(source);
const at = (needle) => {
  const startByte = Buffer.from(source).indexOf(Buffer.from(needle));
  return {
    relativePath: "Fixture.cs",
    startByte,
    endByte: startByte + Buffer.byteLength(needle),
    sliceSha256: sha(needle),
    sourceFileSha256: fileSha,
  };
};
const attestation = { targetAssemblySha256: "a".repeat(64), sourceManifestSha256: "b".repeat(64) };
function valid(overrides = {}) {
  const entry = {
    entrypointId: "entry",
    declaration: at("void Entry()"),
    entrypointKind: "framework_override",
    callerFact: "external_runtime_invocation",
    inputWitnesses: [{ kind: "input_state_read", locator: at("input") }],
  };
  const edge = {
    edgeId: "edge",
    callerDeclaration: at("void Entry()"),
    callsite: at("Target()"),
    dispatchKind: "direct",
    targetDeclaration: at("void Target()"),
    inputProvenance: "input_derived_branch",
    guardLocators: [at("if (input)")],
    targetResolutionState: "resolved",
  };
  return {
    schemaVersion: 1,
    artifactKind: "native_normal_player_ingress_and_caller_register",
    attestation: { ...attestation, decompilerConfigurationDigest: "c".repeat(64) },
    scope: {
      actor: "current_normal_local_player",
      inputMode: "native_game_input",
      excludedModes: ["test_or_debug_only"],
    },
    entrypoints: [entry],
    callerEdges: [edge],
    routerExitInventories: [
      {
        routerId: "router",
        routerDeclaration: at("void Entry()"),
        edgeIdsInSourceOrder: ["edge"],
        inventoryState: "exhaustive",
        gapIds: [],
      },
    ],
    roots: [
      {
        rootId: "root",
        declaration: at("void Target()"),
        rootKind: "direct_input_dispatch_target",
        predecessorEdgeIds: ["edge"],
        ingressPath: { entrypointId: "entry", orderedEdgeIds: ["edge"] },
        selectionWitness: { firstInputDispatchEdgeId: "edge", dispatchGuardLocators: [at("if (input)")] },
        incomingCallerInventory: "complete_for_attested_ingress_region",
        disposition: "normal_player_root",
      },
    ],
    gaps: [],
    ...overrides,
  };
}
const options = { expectedAttestation: attestation, sourceFiles: { "Fixture.cs": { sha256: fileSha, text: source } } };
test("validates a source-attested normal-player root through exact caller and input witnesses", () =>
  assert.equal(validateNativeNormalPlayerIngressRegister(valid(), options).rootCount, 1));
test("fails closed for dynamic dispatch and partial inventory without a blocking gap", () => {
  const dynamic = valid();
  dynamic.callerEdges[0] = {
    ...dynamic.callerEdges[0],
    dispatchKind: "virtual",
    targetResolutionState: "unresolved_gap",
    targetDeclaration: null,
  };
  assert.throws(() => validateNativeNormalPlayerIngressRegister(dynamic, options), {
    code: "normal_player_ingress_unresolved_edge_missing_gap",
  });
  const partial = valid({
    routerExitInventories: [{ ...valid().routerExitInventories[0], inventoryState: "partial", gapIds: [] }],
  });
  assert.throws(() => validateNativeNormalPlayerIngressRegister(partial, options), {
    code: "normal_player_ingress_partial_inventory_missing_gap",
  });
});
test("rejects public product vocabulary and arbitrary non-invocation caller anchors", () => {
  const product = valid({ primitiveId: "nope" });
  assert.throws(() => validateNativeNormalPlayerIngressRegister(product, options), {
    code: "normal_player_ingress_forbidden_field",
  });
  const malformed = valid();
  malformed.callerEdges[0].callsite = at("input");
  assert.throws(() => validateNativeNormalPlayerIngressRegister(malformed, options), {
    code: "normal_player_ingress_callsite_not_invocation",
  });
});
test("requires the partial inventory gap to be exactly router-anchored and rejects a gap on exhaustive inventory", () => {
  const partial = valid();
  partial.routerExitInventories[0] = {
    ...partial.routerExitInventories[0],
    inventoryState: "partial",
    gapIds: ["gap"],
  };
  partial.gaps = [
    { gapId: "gap", kind: "uninventoried_router_exit", blocksRootClosure: true, sourceLocator: at("void Target()") },
  ];
  assert.throws(() => validateNativeNormalPlayerIngressRegister(partial, options), {
    code: "normal_player_ingress_partial_inventory_missing_gap",
  });
  const exhaustive = valid();
  exhaustive.routerExitInventories[0].gapIds = ["gap"];
  exhaustive.gaps = [
    { gapId: "gap", kind: "uninventoried_router_exit", blocksRootClosure: true, sourceLocator: at("void Entry()") },
  ];
  assert.throws(() => validateNativeNormalPlayerIngressRegister(exhaustive, options), {
    code: "normal_player_ingress_exhaustive_inventory_has_gap",
  });
});
test("rejects a root that is only reachable through unresolved or non-input dispatch", () => {
  const unresolved = valid();
  unresolved.callerEdges[0] = {
    ...unresolved.callerEdges[0],
    dispatchKind: "virtual",
    targetResolutionState: "unresolved_gap",
    targetDeclaration: null,
    gapId: "gap",
  };
  unresolved.gaps = [
    { gapId: "gap", kind: "unresolved_virtual_target", blocksRootClosure: true, sourceLocator: at("Target()") },
  ];
  assert.throws(() => validateNativeNormalPlayerIngressRegister(unresolved, options), {
    code: "normal_player_ingress_root_invalid",
  });
  const noInput = valid();
  noInput.callerEdges[0].inputProvenance = "not_proven";
  assert.throws(() => validateNativeNormalPlayerIngressRegister(noInput, options), {
    code: "normal_player_ingress_root_invalid",
  });
});
