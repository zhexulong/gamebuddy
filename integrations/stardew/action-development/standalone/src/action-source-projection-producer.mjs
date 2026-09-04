import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Stardew-owned deterministic actual-source projection producer.
 *
 * This producer derives cross-layer facts from an explicit, fixed list of
 * current Mod/Host/protocol/schema source paths (no discovery, no globbing).
 * It never imports or executes root checker tooling; the parsing logic is a
 * package-owned port of the same assertion categories the root promotion
 * checker maintained. The emitted bytes are the canonical versioned artifact
 * checked into contracts/projection/ and are bound to it by an independent
 * producer-drift test that spawns this file with shell:false.
 */

const ERROR_PREFIX = "stardew_action_source_projection";
export const ACTION_SOURCE_PROJECTION_SCHEMA = "gamebuddy-stardew-action-source-projection/v1";
export const ACTION_SOURCE_PROJECTION_GAME_ID = "stardew";
export const ACTION_SOURCE_SNAPSHOT_RELATIVE_PATH =
  "integrations/stardew/action-development/contracts/projection/action-source-projection.v1.json";

const IDENTIFIER = /^[a-z][a-z0-9_]{1,127}$/;
const SCHEMA_PATH = /^[a-z][a-z0-9._/-]{1,199}$/;
const CATEGORY = /^[a-z][a-z0-9_]{1,63}$/;
const JSON_NAME_PATTERN = /\.json$/;
const ABSENT_ROUTE_TOKENS = Object.freeze([
  "adoption",
  "dual_read",
  "fallback",
  "legacy",
  "migration",
  "read_repair",
  "withdrawn",
]);
const HANDLER_GROUP_CLASS_NAMES = Object.freeze({
  Farming: "FarmingActionHandler",
  Gathering: "GatheringActionHandler",
  Movement: "MovementActionHandler",
  MachinesAndAnimals: "MachineAndAnimalActionHandler",
  ResourceTools: "ResourceToolActionHandler",
});
const SHARED_RUNNER_IMPORT = 'from "./lib/stardew-native-smoke-harness-v1.mjs"';
const OBSOLETE_RUNNER_FILENAMES = Object.freeze([
  "run-stardew-move-probe.mjs",
  "run-stardew-clear-debris-smoke.mjs",
  "run-stardew-collect-animal-product-smoke.mjs",
  "run-stardew-enter-exit-smoke.mjs",
  "run-stardew-equip-tool-smoke.mjs",
  "run-stardew-feed-animal-smoke.mjs",
  "run-stardew-fertilize-tile-smoke.mjs",
  "run-stardew-harvest-crop-fixture-smoke.mjs",
  "run-stardew-harvest-crop-smoke.mjs",
  "run-stardew-machine-inspect-fixture-smoke.mjs",
  "run-stardew-machine-inspect-smoke.mjs",
  "run-stardew-npc-relationship-fixture-smoke.mjs",
  "run-stardew-npc-relationship-smoke.mjs",
  "run-stardew-pet-animal-smoke.mjs",
  "run-stardew-pickup-forage-fixture-smoke.mjs",
  "run-stardew-pickup-forage-smoke.mjs",
  "run-stardew-pickup-item-fixture-smoke.mjs",
  "run-stardew-pickup-item-smoke.mjs",
  "run-stardew-plant-seed-fixture-smoke.mjs",
  "run-stardew-plant-seed-smoke.mjs",
  "run-stardew-till-soil-fixture-smoke.mjs",
  "run-stardew-till-soil-smoke.mjs",
  "run-stardew-travel-smoke.mjs",
  "run-stardew-use-item-smoke.mjs",
  "run-stardew-water-crop-smoke.mjs",
]);

/**
 * Explicit fixed source list of the current production sources. The producer
 * reads exactly these paths and rejects any unexplained read failure.
 */
export const ACTION_SOURCE_PATHS = Object.freeze([
  {
    category: "canonical_action_surface",
    path: "integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
    maxBytes: 64 * 1024,
  },
  {
    category: "mod_bridge_session",
    path: "integrations/stardew/BridgeSession.cs",
    maxBytes: 256 * 1024,
  },
  {
    category: "mod_execution_controller",
    path: "integrations/stardew/farmhandexecutioncontroller.cs",
    maxBytes: 256 * 1024,
  },
  {
    category: "mod_router",
    path: "integrations/stardew/src/Core/Routing/FarmhandActionRouter.cs",
    maxBytes: 64 * 1024,
  },
  {
    category: "mod_handler_farming",
    path: "integrations/stardew/Handlers/FarmingActionHandler.cs",
    maxBytes: 256 * 1024,
  },
  {
    category: "mod_handler_gathering",
    path: "integrations/stardew/Handlers/GatheringActionHandler.cs",
    maxBytes: 256 * 1024,
  },
  {
    category: "mod_handler_movement",
    path: "integrations/stardew/Handlers/MovementActionHandler.cs",
    maxBytes: 256 * 1024,
  },
  {
    category: "mod_handler_machines_animals",
    path: "integrations/stardew/Handlers/MachineAndAnimalActionHandler.cs",
    maxBytes: 256 * 1024,
  },
  {
    category: "mod_handler_resource_tools",
    path: "integrations/stardew/Handlers/ResourceToolActionHandler.cs",
    maxBytes: 256 * 1024,
  },
  {
    category: "host_registry",
    path: "host/src/action-registry.ts",
    maxBytes: 256 * 1024,
  },
  {
    category: "host_game_tools",
    path: "host/src/game-tools.ts",
    maxBytes: 256 * 1024,
  },
  {
    category: "host_protocol",
    path: "host/src/protocol.ts",
    maxBytes: 512 * 1024,
  },
  {
    category: "protocol_schema",
    path: "protocol/bridge-v1.schema.json",
    maxBytes: 512 * 1024,
  },
  {
    category: "gate_descriptors",
    path: "tools/stardew-action-gate-descriptors.mjs",
    maxBytes: 64 * 1024,
  },
  {
    category: "runner_sources",
    path: "tools",
    maxBytes: 2 * 1024 * 1024,
    kind: "published_runner_directory",
  },
]);

function fail(code) {
  throw new Error(`${ERROR_PREFIX}_${code}`);
}

function sorted(values) {
  return [...values].sort();
}

function assertUnique(values, code) {
  if (new Set(values).size !== values.length) fail(code);
  return [...values];
}

function markerIndices(text, markers) {
  const indices = markers.map((marker) => text.indexOf(marker));
  if (indices.some((index) => index < 0)) fail("source_marker_missing");
  for (let index = 1; index < indices.length; index += 1) {
    if (indices[index - 1] >= indices[index]) fail("source_marker_order_invalid");
  }
  return indices;
}

function parseModCatalog(source) {
  let artifact;
  try { artifact = JSON.parse(source); } catch { fail("catalog_json_invalid"); }
  if (!artifact || artifact.schema !== "gamebuddy-action-descriptors/v1"
    || !Number.isSafeInteger(artifact.catalogRevision) || artifact.catalogRevision < 1
    || !Array.isArray(artifact.actions) || artifact.actions.length === 0) fail("catalog_unreadable");
  const registrations = artifact.actions.map((action) => {
    if (!action || typeof action !== "object" || !IDENTIFIER.test(action.actionId)
      || !Number.isSafeInteger(action.identityVersion) || action.identityVersion < 1
      || (action.lifecycle !== "published" && action.lifecycle !== "experimental")
      || (action.kind !== "execution" && action.kind !== "read_only")) fail("catalog_action_invalid");
    return Object.freeze({
      actionId: action.actionId,
      identityVersion: action.identityVersion,
      lifecycle: action.lifecycle,
      kind: action.kind,
      descriptor: action,
      handlerGroup: null,
    });
  });
  assertUnique(registrations.map((registration) => registration.actionId), "catalog_duplicate_action_id");
  return registrations;
}

function parseHostAdapters(source) {
  const ids = [...source.matchAll(/actionAdapter\(\s*\n\s*"([a-z0-9_]+)",/g)].map((entry) => entry[1]);
  if (ids.length === 0) fail("adapters_empty");
  return assertUnique(ids, "adapter_duplicates");
}

function parseHostToolNames(source) {
  const body = source.match(/STARDEW_ACTION_TOOL_NAMES = \{([\s\S]*?)\} as const/)?.[1];
  if (!body) fail("tool_names_unreadable");
  const entries = [];
  for (const match of body.matchAll(/([a-z0-9_]+): "([a-z0-9_]+)",/g)) {
    const [, actionId, toolName] = match;
    if (toolName !== `stardew_${actionId}`) fail(`tool_name_identity_drift:${actionId}`);
    entries.push(actionId);
  }
  if (entries.length === 0) fail("tool_names_empty");
  return assertUnique(entries, "tool_name_duplicates");
}

function parseHostToolRoutes(source) {
  const openings = [...source.matchAll(/if \(isVisible\("([a-z0-9_]+)"\)\) \{/g)];
  if (openings.length === 0) fail("tool_routes_empty");
  const routes = [];
  for (let index = 0; index < openings.length; index += 1) {
    const opening = openings[index];
    const visible = opening[1];
    const start = opening.index + opening[0].length;
    const end = index + 1 < openings.length ? openings[index + 1].index : source.length;
    const block = source.slice(start, end);
    const name = block.match(/name: STARDEW_ACTION_TOOL_NAMES\.([a-z0-9_]+),/)?.[1];
    const action = block.match(/\n\s*action: "([a-z0-9_]+)",/)?.[1];
    if (!name || !action || name !== visible || action !== visible) {
      fail(`tool_route_identity_drift:${visible}`);
    }
    routes.push(visible);
  }
  return assertUnique(routes, "tool_route_duplicates");
}

function parseLiteralChecks(source, functionName, operator) {
  const body = source.match(
    new RegExp(`function ${functionName}[\\s\\S]*?(?:^|\\n)\\}`),
  )?.[0];
  if (!body) fail(`${functionName}_unreadable`);
  const ids = [...body.matchAll(new RegExp(`value\\.action ${operator} "([a-z0-9_]+)"`, "g"))].map((entry) => entry[1]);
  if (ids.length === 0) fail(`${functionName}_empty`);
  return assertUnique(ids, `${functionName}_duplicates`);
}

function parseExecutionRequestUnion(source) {
  const body = source.match(/export type ExecutionRequest[\s\S]*?;\n}>;/)?.[0];
  if (!body) fail("execution_request_union_unreadable");
  const ids = [...body.matchAll(/\| "([a-z0-9_]+)"/g)].map((entry) => entry[1]);
  if (ids.length === 0) fail("execution_request_union_empty");
  return assertUnique(ids, "execution_request_union_duplicates");
}

function parseBridgeMessageTypes(source) {
  const body = source.match(/export const BRIDGE_MESSAGE_TYPES = \[([\s\S]*?)\] as const;/)?.[1];
  if (!body) fail("bridge_message_types_unreadable");
  const types = [...body.matchAll(/"([a-z0-9_]+)"/g)].map((entry) => entry[1]);
  if (types.length === 0) fail("bridge_message_types_empty");
  return assertUnique(types, "bridge_message_types_duplicates");
}

function parseSemanticEventKinds(source) {
  const explicit = source.match(/export type SemanticEvent[\s\S]*?reasonCode: string;/)?.[0] ?? "";
  const kinds = [...explicit.matchAll(/\| "([a-z0-9_]+)"/g)].map((entry) => entry[1]);
  const bodyTrace = source.match(/export type BodyTrace[\s\S]*?;\n}>;/)?.[0] ?? "";
  const bodyTraceKinds = [...bodyTrace.matchAll(/\| "([a-z0-9_]+)"/g)].map((entry) => entry[1]);
  const all = [...kinds, ...bodyTraceKinds];
  if (all.length === 0) fail("semantic_event_kinds_empty");
  return assertUnique(all, "semantic_event_kinds_duplicates");
}

function parseSchema(text) {
  let schema;
  try {
    schema = JSON.parse(text);
  } catch {
    fail("schema_json_invalid");
  }
  return schema;
}

function requireStringArray(value, code, allowEmpty = false) {
  if (!Array.isArray(value) || (value.length === 0 && !allowEmpty) || value.some((entry) => typeof entry !== "string")) {
    fail(code);
  }
  const ids = [...value];
  return assertUnique(ids, `${code}_duplicates`);
}

function parseModProvenance(bridgeSession, executionController) {
  const hello = /FarmhandActionCatalog\.Registrations\.Select\(registration\s*=>\s*new FarmhandActionRegistrationWire\(/.test(
    bridgeSession,
  );
  if (!hello) fail("hello_advertisement_missing");
  const capabilityIndex = executionController.indexOf(
    "IReadOnlyList<string> advertisedCapabilities = capabilityPublication.CapabilitySet.AdvertisedCapabilityIds;",
  );
  const fallbackIndex = executionController.indexOf("return CreateWorldNotReadyBridgeSnapshot(capabilityPublication);");
  const snapshotIndex = executionController.indexOf("return new BridgeSnapshot(");
  if (capabilityIndex < 0 || fallbackIndex < 0 || snapshotIndex < 0) fail("capability_provenance_missing");
  if (!(capabilityIndex < fallbackIndex && fallbackIndex < snapshotIndex)) fail("capability_provenance_order_invalid");
  const capabilityMarker =
    "IReadOnlyList<string> advertisedCapabilities = capabilityPublication.CapabilitySet.AdvertisedCapabilityIds;";
  const secondCapabilityIndex = executionController.indexOf(
    capabilityMarker,
    capabilityIndex + capabilityMarker.length,
  );
  const worldNotReadyMethodIndex = executionController.indexOf(
    "private BridgeSnapshot CreateWorldNotReadyBridgeSnapshot(FarmhandCapabilityPublication capabilityPublication)",
  );
  if (
    worldNotReadyMethodIndex < 0
    || secondCapabilityIndex < worldNotReadyMethodIndex
    || executionController.indexOf(capabilityMarker, secondCapabilityIndex + capabilityMarker.length) >= 0
  ) {
    fail("capability_provenance_branch_mismatch");
  }
  return Object.freeze({ hello, capabilityProvenance: Object.freeze({
    snapshotCapabilitiesFromCapabilitySet: true,
    worldNotReadyFallback: true,
  }) });
}

function parseTryExecuteGuardOrder(bridgeSession) {
  const body = bridgeSession.slice(bridgeSession.indexOf("internal bool TryExecute("), bridgeSession.indexOf("internal bool TryQueryExecutionReceipt("));
  if (!body) fail("try_execute_unreadable");
  markerIndices(body, [
    'IsAuthenticated(generation, out reasonCode) || !IsValidEnvelope(envelope, "execution_request"',
    "if (!IsStructurallyValidExecutionRequest(request, out reasonCode)) return false;",
    'if (!this.actionRouter.IsOnOwnerThread) { reasonCode = "game_thread_required"; return false; }',
    "!this.capabilityPublicationProvider().CapabilitySet.AllowsExecutionAction(request.Action)",
    "if (!IsFreshExecutionRequest(request, out reasonCode)) return false;",
    "if (this.idempotency.TryGetValue(request.IdempotencyKey, out IdempotentExecution? existing))",
    "if (!this.actionRouter.TryRoute(request, this.executions, executionId, out LocalExecutionReceipt receipt, out reasonCode))",
  ]);
  return Object.freeze([
    "envelope_auth",
    "structural",
    "game_thread",
    "capability",
    "freshness",
    "idempotency",
    "router_route",
  ]);
}

function parseTryRouteGuardOrder(router) {
  markerIndices(router, [
    "if (!this.IsOnOwnerThread)",
    "if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))",
    "if (!this.handlers.TryGetValue(request.Action, out IFarmhandActionHandler? handler))",
     "dispatchLedger.TryBindDispatch(request.RequestId, request.Action, executionId, out bindingReason)",
     "receipt = handler.Execute(request, ledger);",
  ]);
  if (!router.includes("registration.Kind != FarmhandOperationKind.Execution || registration.HandlerGroup is null")) {
    fail("router_readonly_registration_guard_missing");
  }
  if (!router.includes("this.handlers.TryAdd(registration.ActionId, handler)")) fail("router_duplicate_handler_guard_missing");
  return Object.freeze([
    "game_thread",
    "replay_lookup",
    "handler_lookup",
    "action_bind",
    "handler_execute",
  ]);
}

function parseNativeHandlers(handlerSources) {
  const ownership = {};
  for (const [group, className] of Object.entries(HANDLER_GROUP_CLASS_NAMES)) {
    const source = handlerSources[group];
    if (!source.match(new RegExp(`class ${className}\\s*:\\s*IFarmhandActionHandler`))) {
      fail(`handler_declaration_missing:${group}`);
    }
    const matches = [...source.matchAll(/"([a-z][a-z0-9_]*)"\s*=>/g)].map((entry) => entry[1]);
    ownership[group] = assertUnique(matches, `handler_action_duplicates:${group}`);
  }
  return ownership;
}

function parseGateDescriptors(source) {
  const body = source.match(/STARDEW_PUBLISHED_ACTION_GATES\s*=\s*Object\.freeze\(\[([\s\S]*?)\n\]\);/)?.[1];
  if (!body) fail("gate_descriptors_unreadable");
  const gates = [...body.matchAll(
    /gate\(\s*"([a-z0-9_]+)"\s*,\s*(\d+)\s*,\s*"([a-z0-9-]+\.mjs)"\s*,\s*"([a-z0-9_]+)"(?:\s*,\s*"([a-z0-9_]+)")?\s*,?\s*\)/g,
  )].map((match) => Object.freeze({
    actionId: match[1],
    runner: match[3],
    fixtureScenario: match[5] ?? null,
  }));
  if (gates.length === 0) fail("gate_descriptors_empty");
  assertUnique(gates.map((gate) => gate.actionId), "gate_descriptor_action_duplicates");
  assertUnique(gates.map((gate) => gate.runner), "gate_descriptor_runner_duplicates");
  return gates;
}

function parseRunnerSources(source, gates) {
  let runners;
  try {
    runners = JSON.parse(source);
  } catch {
    fail("runner_sources_unreadable");
  }
  if (runners === null || typeof runners !== "object" || Array.isArray(runners)
    || !Array.isArray(runners.entries) || runners.files === null || typeof runners.files !== "object"
    || Array.isArray(runners.files)) fail("runner_sources_invalid");
  const entries = assertUnique(runners.entries, "runner_directory_entry_duplicates");
  for (const obsolete of OBSOLETE_RUNNER_FILENAMES) {
    if (entries.includes(obsolete)) fail(`obsolete_runner_present:${obsolete}`);
  }
  for (const gate of gates) {
    if (!entries.includes(gate.runner) || typeof runners.files[gate.runner] !== "string") {
      fail(`runner_missing:${gate.actionId}`);
    }
    const runnerSource = runners.files[gate.runner];
    if (!runnerSource.includes(SHARED_RUNNER_IMPORT)) fail(`runner_shared_harness_import_missing:${gate.actionId}`);
    if (runnerSource.includes("host-production-module")) fail(`runner_legacy_host_route_present:${gate.actionId}`);
  }
  return Object.freeze({
    actions: Object.freeze(gates.map((gate) => Object.freeze({ ...gate }))),
    sharedHarnessImport: SHARED_RUNNER_IMPORT,
    obsoleteRunnerFilenamesAbsent: Object.freeze([...OBSOLETE_RUNNER_FILENAMES]),
  });
}

function collectStringValues(value, out, excluded = new Set()) {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (value === null || typeof value !== "object" || excluded.has(value)) return;
  excluded.add(value);
  for (const key of Object.keys(value)) collectStringValues(value[key], out, excluded);
}

function scanAbsence(snapshot) {
  const values = [];
  collectStringValues(snapshot, values, new Set([snapshot.absentRoutes]));
  for (const token of snapshot.absentRoutes) {
    for (const value of values) {
      if (typeof value === "string" && value.toLowerCase().includes(token)) fail(`obsolete_route_present:${token}`);
    }
  }
}

/**
 * Derive the canonical actual-source projection from explicit source texts.
 * `sources` maps the fixed source categories (see ACTION_SOURCE_PATHS) to the
 * raw current file contents. Every category is mandatory and every coherence
 * assertion is fail-closed: any source mutation that breaks a cross-layer fact
 * rejects the whole projection.
 */
export function deriveActionSourceProjection(sources) {
  if (sources === null || typeof sources !== "object" || Array.isArray(sources)) fail("sources_invalid");
  for (const entry of ACTION_SOURCE_PATHS) {
    if (typeof sources[entry.category] !== "string") fail(`source_missing:${entry.category}`);
  }

  const registrations = parseModCatalog(sources.canonical_action_surface);
  const publishedExecutionActionIds = assertUnique(
    registrations
      .filter((registration) => registration.lifecycle === "published" && registration.kind === "execution")
      .map((registration) => registration.actionId),
    "published_partition_duplicates",
  );
  const publishedEmbodiedExecutionActionIds = publishedExecutionActionIds.filter((actionId) => {
    const registration = registrations.find((candidate) => candidate.actionId === actionId);
    return registration?.descriptor?.resourceTemplate?.claims?.some((claim) => claim.key === "embodied_actor");
  });
  const readOnlyActionIds = assertUnique(
    registrations.filter((registration) => registration.kind === "read_only").map((registration) => registration.actionId),
    "readonly_partition_duplicates",
  );
  const experimentalActionIds = assertUnique(
    registrations.filter((registration) => registration.lifecycle === "experimental").map((registration) => registration.actionId),
    "experimental_partition_duplicates",
  );
  const partitionIds = new Set([...publishedExecutionActionIds, ...readOnlyActionIds, ...experimentalActionIds]);
  if (
    partitionIds.size !== publishedExecutionActionIds.length + readOnlyActionIds.length + experimentalActionIds.length
    || partitionIds.size !== registrations.length
    || registrations.some((registration) => !partitionIds.has(registration.actionId))
  ) {
    fail("lifecycle_partition_mismatch");
  }

  // Host registry / tool / request union
  const adapterActionIds = assertUnique(parseHostAdapters(sources.host_registry), "adapter_duplicates");
  const toolActionIds = assertUnique(parseHostToolNames(sources.host_registry), "tool_name_duplicates");
  const toolRouteActionIds = parseHostToolRoutes(sources.host_game_tools);
  const requestValidatorActionIds = assertUnique(
    parseLiteralChecks(sources.host_protocol, "validateExecutionRequest", "!=="),
    "request_validator_duplicates",
  );
  const envelopeValidatorActionIds = assertUnique(
    parseLiteralChecks(sources.host_protocol, "validateExecutionRequestEnvelope", "==="),
    "envelope_validator_duplicates",
  );
  const executionRequestUnionActionIds = assertUnique(
    parseExecutionRequestUnion(sources.host_protocol),
    "execution_request_union_duplicates",
  );
  const bridgeMessageTypes = parseBridgeMessageTypes(sources.host_protocol);
  const semanticEventKinds = assertUnique(parseSemanticEventKinds(sources.host_protocol), "semantic_event_kind_duplicates");
  const schema = parseSchema(sources.protocol_schema);
  const schemaMessageTypes = requireStringArray(schema?.properties?.type?.enum, "schema_message_types");
  const schemaSemanticEventKinds = requireStringArray(schema?.$defs?.semanticEvent?.properties?.kind?.enum, "schema_semantic_event_kinds");
  const schemaExecutionActionIds = requireStringArray(
    schema?.$defs?.executionRequest?.properties?.action?.enum,
    "schema_execution_actions",
  );
  const gates = parseGateDescriptors(sources.gate_descriptors);

  // The executable projection is the restrictive intersection of canonical
  // published embodied execution metadata and every existing Host/protocol
  // support surface. Gate descriptors are integrity evidence only; they do not
  // grant or suppress executable membership.
  const publishedHostActionIds = publishedEmbodiedExecutionActionIds.filter((actionId) =>
    adapterActionIds.includes(actionId)
    && toolActionIds.includes(actionId)
    && toolRouteActionIds.includes(actionId)
    && requestValidatorActionIds.includes(actionId)
    && envelopeValidatorActionIds.includes(actionId)
    && executionRequestUnionActionIds.includes(actionId)
     && schemaExecutionActionIds.includes(actionId),
  );
  const executableUnion = assertUnique([...publishedHostActionIds], "executable_union_duplicates");
  if (executableUnion.some((actionId) => !adapterActionIds.includes(actionId))) fail("host_adapter_union_mismatch");
  if (executableUnion.some((actionId) => !toolActionIds.includes(actionId))) fail("host_tool_name_union_mismatch");
  if (executableUnion.some((actionId) => !toolRouteActionIds.includes(actionId))) {
    fail("host_tool_route_union_mismatch");
  }
  for (const union of [requestValidatorActionIds, envelopeValidatorActionIds, executionRequestUnionActionIds]) {
    if (executableUnion.some((actionId) => !union.includes(actionId))) fail("host_request_union_mismatch");
  }

  // Schema cross-layer support.
  if (bridgeMessageTypes.filter((type) => !type.startsWith("program_")).some((type) => !schemaMessageTypes.includes(type))) fail("schema_message_type_union_mismatch");
  if (JSON.stringify(sorted(schemaSemanticEventKinds)) !== JSON.stringify(sorted(semanticEventKinds))) {
    fail("schema_semantic_event_union_mismatch");
  }
  if (executableUnion.some((actionId) => !schemaExecutionActionIds.includes(actionId))) {
    fail("schema_execution_action_union_mismatch");
  }

  // Runner and fixture parity is derived from the package's actual descriptor
  // source and actual runner files, never from a duplicated action mapping.
  if (gates.some((gate) => !publishedExecutionActionIds.includes(gate.actionId))) {
    fail("gate_descriptor_published_union_mismatch");
  }
  const runnerFixtureParity = parseRunnerSources(sources.runner_sources, gates);

  // Router guard order facts
  const tryExecuteGuardOrder = parseTryExecuteGuardOrder(sources.mod_bridge_session);
  const tryRouteGuardOrder = parseTryRouteGuardOrder(sources.mod_router);

  // Native handler declarations are source-integrity evidence only. They must
  // name canonical execution actions, but do not expand the executable set or
  // impose ownership requirements on experimental/read-only/Navigation IDs.
  const provenance = parseModProvenance(sources.mod_bridge_session, sources.mod_execution_controller);
  const nativeOwnership = parseNativeHandlers({
    Farming: sources.mod_handler_farming,
    Gathering: sources.mod_handler_gathering,
    Movement: sources.mod_handler_movement,
    MachinesAndAnimals: sources.mod_handler_machines_animals,
    ResourceTools: sources.mod_handler_resource_tools,
  });
  const canonicalExecutionIds = new Set(
    registrations.filter((registration) => registration.kind === "execution").map((registration) => registration.actionId),
  );
  const declaredHandlerIds = Object.values(nativeOwnership).flat();
  if (declaredHandlerIds.some((actionId) => !canonicalExecutionIds.has(actionId))) {
    fail("native_handler_non_execution_action");
  }
  assertUnique(declaredHandlerIds, "native_handler_action_duplicates");
  for (const [group, ids] of Object.entries(nativeOwnership)) nativeOwnership[group] = sorted(ids);

  // Guard-order composition is a derived, not consumer-invented, fact. The
  // consumer executes exactly the order published in the artifact.
  const guardOrder = Object.freeze([
    "schema",
    "development_scope",
    "game_id",
    "sources_pinned",
      "canonical_action_metadata",
    "lifecycle_partition",
    "host_union",
    "protocol_union",
    "router_guard_order",
    "native_ownership",
    "runner_fixture_parity",
    "guard_order_pinned",
    "obsolete_route_absence",
  ]);
  const snapshot = Object.freeze({
    schema: ACTION_SOURCE_PROJECTION_SCHEMA,
    developmentOnly: true,
    gameId: ACTION_SOURCE_PROJECTION_GAME_ID,
    sources: ACTION_SOURCE_PATHS.map((entry) => ({ category: entry.category, path: entry.path })),
    mod: Object.freeze({
      registrations,
      publishedExecutionActionIds: Object.freeze([...publishedExecutionActionIds]),
      executableActionIds: Object.freeze([...executableUnion]),
      readOnlyActionIds: Object.freeze([...readOnlyActionIds]),
      experimentalActionIds: Object.freeze([...experimentalActionIds]),
      helloAdvertisement: "catalog_projection",
      capabilityProvenance: provenance.capabilityProvenance,
    }),
    host: Object.freeze({
      adapterActionIds: Object.freeze(sorted(adapterActionIds)),
      toolActionIds: Object.freeze(sorted(toolActionIds)),
      toolRouteActionIds: Object.freeze(sorted(toolRouteActionIds)),
      requestValidatorActionIds: Object.freeze(sorted(requestValidatorActionIds)),
      envelopeValidatorActionIds: Object.freeze(sorted(envelopeValidatorActionIds)),
      executionRequestUnionActionIds: Object.freeze(sorted(executionRequestUnionActionIds)),
      bridgeMessageTypes: Object.freeze([...bridgeMessageTypes]),
      semanticEventKinds: Object.freeze(sorted(semanticEventKinds)),
    }),
    protocol: Object.freeze({
      schemaMessageTypes: Object.freeze([...schemaMessageTypes]),
      schemaSemanticEventKinds: Object.freeze(sorted(schemaSemanticEventKinds)),
      schemaExecutionActionIds: Object.freeze(sorted(schemaExecutionActionIds)),
    }),
    router: Object.freeze({
      tryExecuteGuardOrder,
      tryRouteGuardOrder,
    }),
    nativeOwnership: Object.freeze(Object.fromEntries(
      Object.entries(nativeOwnership).map(([group, ids]) => [group, Object.freeze(ids)]),
    )),
    runnerFixtureParity,
    guardOrder,
    absentRoutes: [...ABSENT_ROUTE_TOKENS],
  });

  scanAbsence(snapshot);
  return snapshot;
}

export async function loadSources(repositoryRoot) {
  const sources = {};
  for (const entry of ACTION_SOURCE_PATHS) {
    const absolute = path.join(repositoryRoot, entry.path);
    if (entry.kind === "published_runner_directory") {
      const entries = (await readdir(absolute, { withFileTypes: true }))
        .filter((candidate) => candidate.isFile())
        .map((candidate) => candidate.name)
        .sort();
      const descriptorSource = sources.gate_descriptors;
      if (typeof descriptorSource !== "string") fail("gate_descriptors_source_order_invalid");
      const gates = parseGateDescriptors(descriptorSource);
      const files = {};
      let totalBytes = 0;
      for (const runner of gates.map((gate) => gate.runner)) {
        if (!entries.includes(runner)) continue;
        const bytes = await readFile(path.join(absolute, runner));
        totalBytes += bytes.length;
        files[runner] = bytes.toString("utf8");
      }
      if (totalBytes > entry.maxBytes) fail(`source_too_large:${entry.category}`);
      sources[entry.category] = JSON.stringify({ entries, files });
      continue;
    }
    const bytes = await readFile(absolute);
    if (bytes.length === 0) fail(`source_empty:${entry.category}`);
    if (bytes.length > entry.maxBytes) fail(`source_too_large:${entry.category}`);
    if (entry.path.endsWith(".json") && !JSON_NAME_PATTERN.test(entry.path)) fail("source_path_invalid");
    sources[entry.category] = bytes.toString("utf8");
  }
  return sources;
}

export function serializeActionSourceProjection(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export const ACTION_SOURCE_PROJECTION_PRODUCER_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repositoryRoot = path.resolve(ACTION_SOURCE_PROJECTION_PRODUCER_DIRECTORY, "../inputs/action-projection-source");
  loadSources(repositoryRoot)
    .then((sources) => {
      const snapshot = deriveActionSourceProjection(sources);
      process.stdout.write(serializeActionSourceProjection(snapshot));
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}