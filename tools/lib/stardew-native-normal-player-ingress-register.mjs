import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const ENTRYPOINT_KINDS = new Set(["framework_override", "native_external_callback", "source_called_input_router"]);
const CALLER_FACTS = new Set(["external_runtime_invocation", "exact_source_callsite"]);
const INPUT_WITNESS_KINDS = new Set(["input_state_read", "edge_or_repeat_test", "active_player_or_game_state_guard"]);
const DISPATCH_KINDS = new Set([
  "direct",
  "virtual",
  "interface",
  "delegate",
  "content_selected",
  "external_unresolved",
]);
const PROVENANCE_KINDS = new Set([
  "direct_input_value",
  "input_derived_branch",
  "input_selected_receiver",
  "not_proven",
]);
const RESOLUTION_STATES = new Set(["resolved", "partially_resolved", "unresolved_gap"]);
const ROOT_KINDS = new Set([
  "framework_player_input_entry",
  "direct_input_dispatch_target",
  "polymorphic_input_dispatch_target",
  "content_selected_input_dispatch_target",
]);
const GAP_KINDS = new Set([
  "parse_gap",
  "unresolved_virtual_target",
  "unresolved_delegate_target",
  "unresolved_content_target",
  "external_caller_unknown",
  "uninventoried_router_exit",
]);

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
function text(value, field, details) {
  if (typeof value !== "string" || !value.trim())
    fail("normal_player_ingress_invalid", `Expected non-empty ${field}.`, details);
  return value;
}
function locator(value, field, details) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.relativePath !== "string" ||
    !Number.isInteger(value.startByte) ||
    !Number.isInteger(value.endByte) ||
    value.endByte <= value.startByte ||
    !SHA256.test(value.sliceSha256 ?? "") ||
    !SHA256.test(value.sourceFileSha256 ?? "")
  )
    fail("normal_player_ingress_locator_invalid", `Expected exact ${field} locator.`, details);
  return value;
}
function sameLocator(left, right) {
  return (
    left &&
    right &&
    left.relativePath === right.relativePath &&
    left.startByte === right.startByte &&
    left.endByte === right.endByte &&
    left.sliceSha256 === right.sliceSha256 &&
    left.sourceFileSha256 === right.sourceFileSha256
  );
}
function exactSlice(anchor, sourceFiles, field, details) {
  locator(anchor, field, details);
  const source = sourceFiles[anchor.relativePath];
  if (!source || typeof source.text !== "string" || source.sha256 !== anchor.sourceFileSha256)
    fail("normal_player_ingress_source_missing", `Exact source for ${field} is absent or stale.`, details);
  const bytes = Buffer.from(source.text, "utf8");
  if (
    anchor.endByte > bytes.length ||
    createHash("sha256").update(bytes.subarray(anchor.startByte, anchor.endByte)).digest("hex") !== anchor.sliceSha256
  )
    fail("normal_player_ingress_locator_stale", `${field} does not match exact source bytes.`, details);
  return bytes.subarray(anchor.startByte, anchor.endByte).toString("utf8");
}
function noProductTerms(value, at = "$") {
  const forbidden = new Set([
    "action",
    "actionId",
    "primitive",
    "primitiveId",
    "operation",
    "operationId",
    "contract",
    "receipt",
    "evidence",
    "policy",
    "capability",
    "publicActionId",
    "projection",
    "semanticFamily",
  ]);
  if (Array.isArray(value)) return value.forEach((child, index) => noProductTerms(child, `${at}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key))
      fail("normal_player_ingress_forbidden_field", `Ingress register must not infer ${key}.`, { at: `${at}.${key}` });
    noProductTerms(child, `${at}.${key}`);
  }
}

export function validateNativeNormalPlayerIngressRegister(register, { expectedAttestation, sourceFiles } = {}) {
  noProductTerms(register);
  if (
    !register ||
    register.schemaVersion !== 1 ||
    register.artifactKind !== "native_normal_player_ingress_and_caller_register"
  )
    fail(
      "normal_player_ingress_schema_invalid",
      "Expected native normal-player ingress/caller register schema version 1.",
    );
  if (
    register.scope?.actor !== "current_normal_local_player" ||
    register.scope?.inputMode !== "native_game_input" ||
    !Array.isArray(register.scope?.excludedModes)
  )
    fail("normal_player_ingress_scope_invalid", "Register must use the fixed normal-player native-input scope.");
  if (
    !expectedAttestation ||
    register.attestation?.targetAssemblySha256 !== expectedAttestation.targetAssemblySha256 ||
    register.attestation?.sourceManifestSha256 !== expectedAttestation.sourceManifestSha256 ||
    !SHA256.test(register.attestation?.decompilerConfigurationDigest ?? "")
  )
    fail(
      "normal_player_ingress_attestation_mismatch",
      "Register must attest the exact target/source/decompiler configuration.",
    );
  if (
    !Array.isArray(register.entrypoints) ||
    !Array.isArray(register.callerEdges) ||
    !Array.isArray(register.routerExitInventories) ||
    !Array.isArray(register.roots) ||
    !Array.isArray(register.gaps)
  )
    fail(
      "normal_player_ingress_invalid",
      "Register needs entrypoints, callerEdges, routerExitInventories, roots, and gaps arrays.",
    );
  const gaps = new Map();
  for (const gap of register.gaps) {
    const details = { gapId: gap?.gapId };
    text(gap?.gapId, "gaps[].gapId", details);
    if (gaps.has(gap.gapId) || !GAP_KINDS.has(gap.kind) || gap.blocksRootClosure !== true)
      fail("normal_player_ingress_gap_invalid", "Every dynamic/root gap must block closure.", details);
    exactSlice(gap.sourceLocator, sourceFiles, "gaps[].sourceLocator", details);
    gaps.set(gap.gapId, gap);
  }
  const entrypoints = new Map();
  for (const entry of register.entrypoints) {
    const details = { entrypointId: entry?.entrypointId };
    text(entry?.entrypointId, "entrypoints[].entrypointId", details);
    if (
      entrypoints.has(entry.entrypointId) ||
      !ENTRYPOINT_KINDS.has(entry.entrypointKind) ||
      !CALLER_FACTS.has(entry.callerFact)
    )
      fail("normal_player_ingress_entrypoint_invalid", "Invalid/duplicate entrypoint kind or caller fact.", details);
    exactSlice(entry.declaration, sourceFiles, "entrypoints[].declaration", details);
    if (entry.callerFact === "exact_source_callsite")
      exactSlice(entry.callerLocator, sourceFiles, "entrypoints[].callerLocator", details);
    if (!Array.isArray(entry.inputWitnesses) || !entry.inputWitnesses.length)
      fail("normal_player_ingress_entrypoint_invalid", "Entrypoint needs at least one exact input witness.", details);
    for (const witness of entry.inputWitnesses) {
      if (!INPUT_WITNESS_KINDS.has(witness?.kind))
        fail("normal_player_ingress_entrypoint_invalid", "Invalid input witness kind.", details);
      exactSlice(witness.locator, sourceFiles, "entrypoints[].inputWitnesses[].locator", details);
    }
    entrypoints.set(entry.entrypointId, entry);
  }
  const edges = new Map();
  for (const edge of register.callerEdges) {
    const details = { edgeId: edge?.edgeId };
    text(edge?.edgeId, "callerEdges[].edgeId", details);
    if (
      edges.has(edge.edgeId) ||
      !DISPATCH_KINDS.has(edge.dispatchKind) ||
      !PROVENANCE_KINDS.has(edge.inputProvenance) ||
      !RESOLUTION_STATES.has(edge.targetResolutionState)
    )
      fail("normal_player_ingress_edge_invalid", "Invalid/duplicate caller edge.", details);
    exactSlice(edge.callerDeclaration, sourceFiles, "callerEdges[].callerDeclaration", details);
    const callSyntax = exactSlice(edge.callsite, sourceFiles, "callerEdges[].callsite", details);
    if (!callSyntax.includes("("))
      fail(
        "normal_player_ingress_callsite_not_invocation",
        "Caller edge callsite must be anchored to invocation-shaped syntax.",
        details,
      );
    if (edge.targetResolutionState === "resolved") {
      if (!edge.targetDeclaration)
        fail("normal_player_ingress_resolved_target_missing", "Resolved edge needs exact target declaration.", details);
      exactSlice(edge.targetDeclaration, sourceFiles, "callerEdges[].targetDeclaration", details);
    }
    if (edge.targetResolutionState === "partially_resolved" && !edge.gapId)
      fail(
        "normal_player_ingress_partially_resolved_edge_missing_gap",
        "Partially resolved edge needs a blocking gap reference.",
        details,
      );
    if (edge.targetResolutionState === "unresolved_gap" && !edge.gapId)
      fail(
        "normal_player_ingress_unresolved_edge_missing_gap",
        "Unresolved edge needs a blocking gap reference.",
        details,
      );
    if (edge.targetResolutionState === "unresolved_gap" && edge.targetDeclaration)
      fail(
        "normal_player_ingress_unresolved_edge_has_target",
        "An unresolved edge must not claim a target declaration.",
        details,
      );
    if (!Array.isArray(edge.guardLocators))
      fail("normal_player_ingress_edge_invalid", "Caller edge needs guardLocators array.", details);
    edge.guardLocators.forEach((item) => exactSlice(item, sourceFiles, "callerEdges[].guardLocators[]", details));
    edges.set(edge.edgeId, edge);
  }
  for (const edge of edges.values())
    if (edge.gapId && !gaps.has(edge.gapId))
      fail("normal_player_ingress_dangling_gap", "Caller edge references missing gap.", {
        edgeId: edge.edgeId,
        gapId: edge.gapId,
      });
  const inventories = new Map();
  for (const inventory of register.routerExitInventories) {
    const details = { routerId: inventory?.routerId };
    text(inventory?.routerId, "routerExitInventories[].routerId", details);
    if (inventories.has(inventory.routerId) || !["exhaustive", "partial"].includes(inventory.inventoryState))
      fail("normal_player_ingress_inventory_invalid", "Invalid/duplicate router exit inventory.", details);
    exactSlice(inventory.routerDeclaration, sourceFiles, "routerExitInventories[].routerDeclaration", details);
    if (
      !Array.isArray(inventory.edgeIdsInSourceOrder) ||
      !inventory.edgeIdsInSourceOrder.length ||
      inventory.edgeIdsInSourceOrder.some((id) => !edges.has(id))
    )
      fail("normal_player_ingress_inventory_invalid", "Router inventory needs existing ordered edge IDs.", details);
    const orderedEdges = inventory.edgeIdsInSourceOrder.map((id) => edges.get(id));
    for (let index = 1; index < orderedEdges.length; index += 1)
      if (
        orderedEdges[index - 1].callsite.relativePath !== orderedEdges[index].callsite.relativePath ||
        orderedEdges[index - 1].callsite.startByte >= orderedEdges[index].callsite.startByte
      )
        fail(
          "normal_player_ingress_inventory_order_invalid",
          "Router exit edges must appear in strict source order.",
          details,
        );
    const gapIds = inventory.gapIds ?? [];
    if (!Array.isArray(gapIds) || gapIds.some((id) => !gaps.has(id)))
      fail("normal_player_ingress_inventory_invalid", "Router inventory references an unknown gap.", details);
    if (inventory.inventoryState === "partial") {
      if (
        !gapIds.length ||
        !gapIds.some(
          (id) =>
            gaps.get(id).kind === "uninventoried_router_exit" &&
            sameLocator(gaps.get(id).sourceLocator, inventory.routerDeclaration),
        )
      )
        fail(
          "normal_player_ingress_partial_inventory_missing_gap",
          "Partial router inventory must keep an exact router-anchored un-inventoried blocking gap.",
          details,
        );
    }
    if (inventory.inventoryState === "exhaustive" && gapIds.length)
      fail(
        "normal_player_ingress_exhaustive_inventory_has_gap",
        "Exhaustive router inventory cannot retain gaps.",
        details,
      );
    inventories.set(inventory.routerId, inventory);
  }
  if (!register.entrypoints.length && !gaps.size)
    fail(
      "normal_player_ingress_no_entrypoints_or_gaps",
      "A non-empty ingress proof needs an entrypoint or an explicit blocking entrypoint gap.",
    );
  const roots = new Set();
  for (const root of register.roots) {
    const details = { rootId: root?.rootId };
    const rootId = text(root?.rootId, "roots[].rootId", details);
    if (roots.has(rootId) || !ROOT_KINDS.has(root.rootKind) || root.disposition !== "normal_player_root")
      fail("normal_player_ingress_root_invalid", "Invalid/duplicate root kind/disposition.", details);
    roots.add(rootId);
    exactSlice(root.declaration, sourceFiles, "roots[].declaration", details);
    if (
      !entrypoints.has(root.ingressPath?.entrypointId) ||
      !Array.isArray(root.ingressPath?.orderedEdgeIds) ||
      !root.ingressPath.orderedEdgeIds.length ||
      root.ingressPath.orderedEdgeIds.some((id) => !edges.has(id))
    )
      fail("normal_player_ingress_root_invalid", "Root requires an attested ingress path.", details);
    const firstDispatch = edges.get(root.selectionWitness?.firstInputDispatchEdgeId);
    if (
      !firstDispatch ||
      firstDispatch.targetResolutionState === "unresolved_gap" ||
      firstDispatch.inputProvenance === "not_proven"
    )
      fail(
        "normal_player_ingress_root_invalid",
        "Root needs a resolved input-provenanced first exact dispatch edge.",
        details,
      );
    if (root.rootKind === "direct_input_dispatch_target" && firstDispatch.dispatchKind !== "direct")
      fail(
        "normal_player_ingress_root_dispatch_kind_mismatch",
        "Direct root must have a direct first dispatch edge.",
        details,
      );
    (root.selectionWitness.dispatchGuardLocators ?? []).forEach((item) =>
      exactSlice(item, sourceFiles, "roots[].selectionWitness.dispatchGuardLocators[]", details),
    );
  }
  return Object.freeze({
    entrypointCount: entrypoints.size,
    edgeCount: edges.size,
    rootCount: register.roots.length,
    gapCount: gaps.size,
    closureState: gaps.size ? "partial" : "not_claimed",
  });
}
