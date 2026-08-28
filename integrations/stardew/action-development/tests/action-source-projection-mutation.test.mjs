import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ACTION_SOURCE_PROJECTION_GAME_ID,
  ACTION_SOURCE_PROJECTION_PRODUCER_DIRECTORY,
  ACTION_SOURCE_PROJECTION_SCHEMA,
  ACTION_SOURCE_SNAPSHOT_RELATIVE_PATH,
  deriveActionSourceProjection,
  loadSources,
  serializeActionSourceProjection,
} from "../src/action-source-projection-producer.mjs";

const repositoryRoot = path.resolve(ACTION_SOURCE_PROJECTION_PRODUCER_DIRECTORY, "../../../..");
const artifactPath = path.join(repositoryRoot, ACTION_SOURCE_SNAPSHOT_RELATIVE_PATH);

// The mutation probes re-derive from the real current sources with a single
// in-memory drift injected per probe. The producer must fail closed with the
// exact category-specific code, or (for partition facts) must repartition the
// projection observably. Nothing here writes to any source file.
const sources = await loadSources(repositoryRoot);
const artifactText = await readFile(artifactPath, "utf8");

function expectRejection(callback, code) {
  assert.throws(
    callback,
    (error) => error instanceof Error && error.message === `stardew_action_source_projection_${code}`,
    `expected fail-closed code stardew_action_source_projection_${code}`,
  );
}

function deriveWith(overrides) {
  return deriveActionSourceProjection({ ...sources, ...overrides });
}

test("in-process derivation from the actual sources binds to the checked artifact", () => {
  const derived = deriveWith({});
  assert.equal(serializeActionSourceProjection(derived), artifactText);
  assert.equal(serializeActionSourceProjection(deriveWith({})), artifactText, "derivation must be idempotent");

  const artifact = JSON.parse(artifactText);
  assert.equal(artifact.schema, ACTION_SOURCE_PROJECTION_SCHEMA);
  assert.equal(artifact.gameId, ACTION_SOURCE_PROJECTION_GAME_ID);
  assert.equal(artifact.developmentOnly, true);
  assert.equal(artifact.sources.length, 15);
  assert.deepEqual(artifact.absentRoutes, [
    "adoption",
    "dual_read",
    "fallback",
    "legacy",
    "migration",
    "read_repair",
    "withdrawn",
  ]);
});

test("Host route union drift is rejected from mutated Host sources", () => {
  const registry = sources.host_registry;
  const gameTools = sources.host_game_tools;

  const adapterAdrift = registry.replace(
    'actionAdapter(\n    "equip_tool",',
    'actionAdapter(\n    "equip_tool_x",',
  );
  assert.notEqual(adapterAdrift, registry, "adapter anchor must match");
  expectRejection(() => deriveWith({ host_registry: adapterAdrift }), "host_adapter_union_mismatch");

  const toolNameAdrift = registry.replace(
    'equip_tool: "stardew_equip_tool",',
    'equip_tool: "stardew_equip_tool_x",',
  );
  assert.notEqual(toolNameAdrift, registry, "tool name anchor must match");
  expectRejection(() => deriveWith({ host_registry: toolNameAdrift }), "tool_name_identity_drift:equip_tool");

  const routeIdentityAdrift = gameTools.replace('action: "equip_tool",', 'action: "equip_tool_x",');
  assert.notEqual(routeIdentityAdrift, gameTools, "tool route action anchor must match");
  expectRejection(() => deriveWith({ host_game_tools: routeIdentityAdrift }), "tool_route_identity_drift:equip_tool");

  const routeStart = gameTools.indexOf('  if (isVisible("equip_tool")) {');
  const routeEnd = gameTools.indexOf("\n  return tools;", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart, "equip_tool route block anchor must match");
  const routeRemoved = gameTools.slice(0, routeStart) + gameTools.slice(routeEnd + 1);
  expectRejection(
    () => deriveWith({ host_game_tools: routeRemoved }),
    "host_tool_route_union_mismatch:missing=equip_tool:extra=",
  );
});

test("protocol/schema union drift is rejected from mutated Host/protocol sources", () => {
  const protocol = sources.host_protocol;

  const requestValidatorAdrift = protocol.replaceAll(
    'value.action !== "equip_tool"',
    'value.action !== "equip_tool_x"',
  );
  assert.notEqual(requestValidatorAdrift, protocol, "request validator anchor must match");
  expectRejection(() => deriveWith({ host_protocol: requestValidatorAdrift }), "host_request_union_mismatch");

  const envelopeValidatorAdrift = protocol.replace(
    'value.action === "equip_tool" ||',
    'value.action === "equip_tool_x" ||',
  );
  assert.notEqual(envelopeValidatorAdrift, protocol, "envelope validator anchor must match");
  expectRejection(() => deriveWith({ host_protocol: envelopeValidatorAdrift }), "host_request_union_mismatch");

  const unionMemberRemoved = protocol.replace('    | "equip_tool"\n', "");
  assert.notEqual(unionMemberRemoved, protocol, "execution request union anchor must match");
  expectRejection(() => deriveWith({ host_protocol: unionMemberRemoved }), "host_request_union_mismatch");

  const messageTypeRemoved = protocol.replace('  "hello",\n', "");
  assert.notEqual(messageTypeRemoved, protocol, "bridge message types anchor must match");
  expectRejection(() => deriveWith({ host_protocol: messageTypeRemoved }), "schema_message_type_union_mismatch");

  const withoutExecutionAction = JSON.parse(sources.protocol_schema);
  withoutExecutionAction["$defs"].executionRequest.properties.action.enum =
    withoutExecutionAction["$defs"].executionRequest.properties.action.enum.filter(
      (actionId) => actionId !== "equip_tool",
    );
  expectRejection(
    () => deriveWith({ protocol_schema: JSON.stringify(withoutExecutionAction) }),
    "schema_execution_action_union_mismatch",
  );

  const withoutMessageType = JSON.parse(sources.protocol_schema);
  withoutMessageType.properties.type.enum = withoutMessageType.properties.type.enum.filter(
    (type) => type !== "hello",
  );
  expectRejection(
    () => deriveWith({ protocol_schema: JSON.stringify(withoutMessageType) }),
    "schema_message_type_union_mismatch",
  );

  const withoutSemanticKind = JSON.parse(sources.protocol_schema);
  withoutSemanticKind["$defs"].semanticEvent.properties.kind.enum =
    withoutSemanticKind["$defs"].semanticEvent.properties.kind.enum.filter(
      (kind) => kind !== "stop_all",
    );
  expectRejection(
    () => deriveWith({ protocol_schema: JSON.stringify(withoutSemanticKind) }),
    "schema_semantic_event_union_mismatch",
  );
});

test("runner and fixture parity drift is rejected from mutated actual sources", () => {
  const descriptor = sources.gate_descriptors;
  const runnerSources = JSON.parse(sources.runner_sources);

  const fixtureDrift = descriptor.replace("native_till_soil_v1", "native_till_soil_v2");
  assert.notEqual(fixtureDrift, descriptor, "fixture scenario anchor must match");
  const fixtureProjection = deriveWith({ gate_descriptors: fixtureDrift });
  assert.equal(
    fixtureProjection.runnerFixtureParity.actions.find((entry) => entry.actionId === "till_soil").fixtureScenario,
    "native_till_soil_v2",
  );
  assert.notEqual(serializeActionSourceProjection(fixtureProjection), artifactText);

  const missingRunner = structuredClone(runnerSources);
  delete missingRunner.files["run-stardew-native-local-player-equip-tool-smoke.mjs"];
  expectRejection(
    () => deriveWith({ runner_sources: JSON.stringify(missingRunner) }),
    "runner_missing:equip_tool",
  );

  const wrongImport = structuredClone(runnerSources);
  wrongImport.files["run-stardew-native-local-player-equip-tool-smoke.mjs"] = wrongImport.files[
    "run-stardew-native-local-player-equip-tool-smoke.mjs"
  ].replace("./lib/stardew-native-smoke-harness-v1.mjs", "./lib/wrong-harness.mjs");
  expectRejection(
    () => deriveWith({ runner_sources: JSON.stringify(wrongImport) }),
    "runner_shared_harness_import_missing:equip_tool",
  );

  const legacyRoute = structuredClone(runnerSources);
  legacyRoute.files["run-stardew-native-local-player-equip-tool-smoke.mjs"] += "\n// host-production-module\n";
  expectRejection(
    () => deriveWith({ runner_sources: JSON.stringify(legacyRoute) }),
    "runner_legacy_host_route_present:equip_tool",
  );

  const obsoleteRoute = structuredClone(runnerSources);
  obsoleteRoute.entries.push("run-stardew-equip-tool-smoke.mjs");
  expectRejection(
    () => deriveWith({ runner_sources: JSON.stringify(obsoleteRoute) }),
    "obsolete_runner_present:run-stardew-equip-tool-smoke.mjs",
  );
});

test("TryExecute/TryRoute guard-order drift is rejected from mutated Mod sources", () => {
  const bridgeSession = sources.mod_bridge_session;
  const router = sources.mod_router;

  const ownerThreadLine =
    '        if (!this.actionRouter.IsOnOwnerThread) { reasonCode = "game_thread_required"; return false; }';
  const capabilityLine =
    '        if (!this.capabilityPublicationProvider().CapabilitySet.AllowsExecutionAction(request.Action)) { reasonCode = "action_not_available"; return false; }';
  const swappedTryExecute = bridgeSession.replace(
    `${ownerThreadLine}\n${capabilityLine}`,
    `${capabilityLine}\n${ownerThreadLine}`,
  );
  assert.notEqual(swappedTryExecute, bridgeSession, "TryExecute swap anchor must match");
  expectRejection(() => deriveWith({ mod_bridge_session: swappedTryExecute }), "source_marker_order_invalid");

  const capabilityRemoved = bridgeSession.replace(`${capabilityLine}\n`, "");
  assert.notEqual(capabilityRemoved, bridgeSession, "TryExecute removal anchor must match");
  expectRejection(() => deriveWith({ mod_bridge_session: capabilityRemoved }), "source_marker_missing");

  const replayLookupLine =
    "        if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))";
  const handlerLookupLine =
    "        if (!this.handlers.TryGetValue(request.Action, out IFarmhandActionHandler? handler))";
  const swappedTryRoute = router
    .replace(replayLookupLine, "        if (STARDew_REPLAY_LOOKUP_PLACEHOLDER)")
    .replace(handlerLookupLine, replayLookupLine)
    .replace("        if (STARDew_REPLAY_LOOKUP_PLACEHOLDER)", handlerLookupLine);
  assert.notEqual(swappedTryRoute, router, "TryRoute swap anchor must match");
  expectRejection(() => deriveWith({ mod_router: swappedTryRoute }), "source_marker_order_invalid");

  const readonlyGuardLine =
    "        if (registration.Kind != FarmhandOperationKind.Execution || registration.HandlerGroup is null)";
  const readonlyGuardRemoved = router.replace(`${readonlyGuardLine}\n`, "");
  assert.notEqual(readonlyGuardRemoved, router, "read-only registration guard anchor must match");
  expectRejection(
    () => deriveWith({ mod_router: readonlyGuardRemoved }),
    "router_readonly_registration_guard_missing",
  );

  const duplicateGuardLine = "        if (!this.handlers.TryAdd(registration.ActionId, handler))";
  const duplicateGuardRemoved = router.replace(`${duplicateGuardLine}\n`, "");
  assert.notEqual(duplicateGuardRemoved, router, "duplicate handler guard anchor must match");
  expectRejection(
    () => deriveWith({ mod_router: duplicateGuardRemoved }),
    "router_duplicate_handler_guard_missing",
  );
});

test("native handler ownership drift is rejected or observably repartitioned", () => {
  const artifact = JSON.parse(artifactText);

  const handlerDeclarationRemoved = sources.mod_handler_farming.replace(
    "class FarmingActionHandler : IFarmhandActionHandler",
    "class FarmingActionHandler",
  );
  assert.notEqual(handlerDeclarationRemoved, sources.mod_handler_farming, "handler declaration anchor must match");
  expectRejection(
    () => deriveWith({ mod_handler_farming: handlerDeclarationRemoved }),
    "handler_declaration_missing:Farming",
  );

  const regroupedCatalog = sources.mod_catalog.replace(
    'Registration("equip_tool", "body_tools", 1, FarmhandActionHandlerGroup.ResourceTools)',
    'Registration("equip_tool", "body_tools", 1, FarmhandActionHandlerGroup.Movement)',
  );
  assert.notEqual(regroupedCatalog, sources.mod_catalog, "registration regroup anchor must match");
  const repartitioned = deriveWith({ mod_catalog: regroupedCatalog });
  assert.notDeepEqual(repartitioned.nativeOwnership, artifact.nativeOwnership);
  assert.ok(repartitioned.nativeOwnership.Movement.includes("equip_tool"));
  assert.ok(!repartitioned.nativeOwnership.ResourceTools.includes("equip_tool"));
});

test("obsolete-route absence drift is rejected from mutated Mod sources", () => {
  const tokenizedCatalog = sources.mod_catalog.replace(
    'Registration("equip_tool", "body_tools", 1, FarmhandActionHandlerGroup.ResourceTools)',
    'Registration("equip_tool", "legacy_body_tools", 1, FarmhandActionHandlerGroup.ResourceTools)',
  );
  assert.notEqual(tokenizedCatalog, sources.mod_catalog, "family id anchor must match");
  expectRejection(() => deriveWith({ mod_catalog: tokenizedCatalog }), "obsolete_route_present:legacy");
});

test("every actual-source-derived category is observable as checked-artifact drift", () => {
  const artifact = JSON.parse(artifactText);
  const mutate = (transform) => {
    const changed = structuredClone(artifact);
    transform(changed);
    return changed;
  };
  const drifted = [
    mutate((changed) => { changed.host.adapterActionIds = [...changed.host.adapterActionIds, "extra_adapter"]; }),
    mutate((changed) => { changed.host.toolRouteActionIds = changed.host.toolRouteActionIds.slice(1); }),
    mutate((changed) => { changed.host.bridgeMessageTypes = changed.host.bridgeMessageTypes.slice(1); }),
    mutate((changed) => { changed.protocol.schemaExecutionActionIds = changed.protocol.schemaExecutionActionIds.slice(1); }),
    mutate((changed) => { changed.protocol.schemaSemanticEventKinds = changed.protocol.schemaSemanticEventKinds.slice(1); }),
    mutate((changed) => { changed.router.tryExecuteGuardOrder = [...changed.router.tryExecuteGuardOrder].reverse(); }),
    mutate((changed) => { changed.router.tryRouteGuardOrder = [...changed.router.tryRouteGuardOrder].reverse(); }),
    mutate((changed) => { changed.nativeOwnership.Movement = changed.nativeOwnership.Movement.slice(1); }),
    mutate((changed) => { changed.runnerFixtureParity.actions[0].runner = "wrong-runner.mjs"; }),
    mutate((changed) => { changed.runnerFixtureParity.actions[4].fixtureScenario = "native_till_soil_v2"; }),
    mutate((changed) => { changed.guardOrder = [...changed.guardOrder].reverse(); }),
    mutate((changed) => { changed.mod.registrations[1].handlerGroup = "Movement"; }),
    mutate((changed) => { changed.absentRoutes = ["legacy"]; }),
  ];
  drifted.forEach((candidate, index) => {
    assert.notDeepEqual(candidate, artifact, `drift case ${index} must differ from the checked artifact`);
  });
});