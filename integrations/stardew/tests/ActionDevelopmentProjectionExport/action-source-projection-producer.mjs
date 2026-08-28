import { readFile } from "node:fs/promises";
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

/**
 * Explicit fixed source list of the current production sources. The producer
 * reads exactly these paths and rejects any unexplained read failure.
 */
export const ACTION_SOURCE_PATHS = Object.freeze([
  {
    category: "mod_catalog",
    path: "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs",
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
  const body = source.match(/Registrations\s*=\s*Array\.AsReadOnly\(new\[\]\s*\{([\s\S]*?)\n    \}\);?\n/)?.[1];
  if (!body) fail("catalog_unreadable");
  const registrations = [];
  for (const match of body.matchAll(
    /(Registration|ReadOnlyRegistration)\("([a-z0-9_]+)", "([a-z0-9_]+)", (\d+)(?:, FarmhandActionHandlerGroup\.([A-Za-z]+))?(?:, FarmhandActionLifecycle\.([A-Za-z]+))?\)/g,
  )) {
    const [, kindCall, actionId, familyId, identityVersion, handlerGroup, lifecycle] = match;
    if (kindCall === "Registration" && !handlerGroup) fail("catalog_handler_group_missing");
    if (kindCall === "ReadOnlyRegistration" && handlerGroup) fail("catalog_readonly_handler_group");
    registrations.push(Object.freeze({
      actionId,
      familyId,
      identityVersion: Number(identityVersion),
      lifecycle: (lifecycle ?? "Published").toLowerCase(),
      kind: kindCall === "Registration" ? "execution" : "read_only",
      handlerGroup: handlerGroup ?? null,
    }));
  }
  if (registrations.length === 0) fail("catalog_empty");
  assertUnique(registrations.map((registration) => registration.actionId), "catalog_duplicate_action_id");
  for (const registration of registrations) {
    if (!IDENTIFIER.test(registration.actionId)) fail("catalog_action_id_invalid");
    if (!IDENTIFIER.test(registration.familyId)) fail("catalog_family_id_invalid");
    if (!Number.isSafeInteger(registration.identityVersion) || registration.identityVersion < 1) {
      fail("catalog_identity_version_invalid");
    }
    if (registration.lifecycle !== "published" && registration.lifecycle !== "experimental") {
      fail("catalog_lifecycle_invalid");
    }
    if (registration.kind !== "execution" && registration.kind !== "read_only") fail("catalog_kind_invalid");
    if (
      registration.handlerGroup !== null
      && !Object.prototype.hasOwnProperty.call(HANDLER_GROUP_CLASS_NAMES, registration.handlerGroup)
    ) {
      fail("catalog_handler_group_invalid");
    }
  }
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
  const body = bridgeSession.match(/internal bool TryExecute\([\s\S]*?\n    internal bool TryQueryExecutionReceipt\(/)?.[0];
  if (!body) fail("try_execute_unreadable");
  markerIndices(body, [
    'IsValidEnvelope(envelope, "execution_request"',
    "if (!IsStructurallyValidExecutionRequest(request, out reasonCode)) return false;",
    'if (!this.actionRouter.IsOnOwnerThread) { reasonCode = "game_thread_required"; return false; }',
    "!this.capabilityPublicationProvider().CapabilitySet.AllowsExecutionAction(request.Action)",
    "if (!IsFreshExecutionRequest(request, out reasonCode)) return false;",
    "if (this.idempotency.TryGetValue(request.IdempotencyKey, out IdempotentExecution? existing))",
    "if (!this.actionRouter.TryRoute(request, this.executions, out LocalExecutionReceipt receipt, out reasonCode))",
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
    "ledger.BindAction(request.RequestId, request.Action);",
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
  for (const [group, className] of Object.entries(HANDLER_GROUP_CLASS_NAMES)) {
    const source = handlerSources[group];
    const declaration = source.match(new RegExp(`class ${className}\\s*:\\s*IFarmhandActionHandler`));
    if (!declaration) fail(`handler_declaration_missing:${group}`);
  }
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

  const registrations = parseModCatalog(sources.mod_catalog);
  const publishedExecutionActionIds = assertUnique(
    registrations
      .filter((registration) => registration.lifecycle === "published" && registration.kind === "execution")
      .map((registration) => registration.actionId),
    "published_partition_duplicates",
  );
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

  const executableUnion = assertUnique(
    [...publishedExecutionActionIds, ...experimentalActionIds],
    "executable_union_duplicates",
  );
  if (JSON.stringify(sorted(adapterActionIds)) !== JSON.stringify(sorted(publishedExecutionActionIds))) {
    fail("host_adapter_union_mismatch");
  }
  if (JSON.stringify(sorted(toolActionIds)) !== JSON.stringify(sorted(publishedExecutionActionIds))) {
    fail("host_tool_name_union_mismatch");
  }
  if (JSON.stringify(sorted(toolRouteActionIds)) !== JSON.stringify(sorted(publishedExecutionActionIds))) {
    const routeSet = new Set(toolRouteActionIds);
    const publishedSet = new Set(publishedExecutionActionIds);
    const missing = sorted(publishedExecutionActionIds.filter((actionId) => !routeSet.has(actionId)));
    const extra = sorted(toolRouteActionIds.filter((actionId) => !publishedSet.has(actionId)));
    fail(`host_tool_route_union_mismatch:missing=${missing.join(",")}:extra=${extra.join(",")}`);
  }
  for (const union of [requestValidatorActionIds, envelopeValidatorActionIds, executionRequestUnionActionIds]) {
    if (JSON.stringify(sorted(union)) !== JSON.stringify(sorted(executableUnion))) fail("host_request_union_mismatch");
  }

  // Schema cross-layer union
  const schema = parseSchema(sources.protocol_schema);
  const schemaMessageTypes = requireStringArray(schema?.properties?.type?.enum, "schema_message_types");
  const schemaSemanticEventKinds = requireStringArray(schema?.$defs?.semanticEvent?.properties?.kind?.enum, "schema_semantic_event_kinds");
  const schemaExecutionActionIds = requireStringArray(
    schema?.$defs?.executionRequest?.properties?.action?.enum,
    "schema_execution_actions",
  );
  if (JSON.stringify(schemaMessageTypes) !== JSON.stringify(bridgeMessageTypes)) fail("schema_message_type_union_mismatch");
  if (JSON.stringify(sorted(schemaSemanticEventKinds)) !== JSON.stringify(sorted(semanticEventKinds))) {
    fail("schema_semantic_event_union_mismatch");
  }
  if (JSON.stringify(sorted(schemaExecutionActionIds)) !== JSON.stringify(sorted(executableUnion))) {
    fail("schema_execution_action_union_mismatch");
  }

  // Router guard order facts
  const tryExecuteGuardOrder = parseTryExecuteGuardOrder(sources.mod_bridge_session);
  const tryRouteGuardOrder = parseTryRouteGuardOrder(sources.mod_router);

  // Native route ownership: handler groups partition every execution-capable
  // registration; read-only registrations never own a native route.
  const provenance = parseModProvenance(sources.mod_bridge_session, sources.mod_execution_controller);
  parseNativeHandlers({
    Farming: sources.mod_handler_farming,
    Gathering: sources.mod_handler_gathering,
    Movement: sources.mod_handler_movement,
    MachinesAndAnimals: sources.mod_handler_machines_animals,
    ResourceTools: sources.mod_handler_resource_tools,
  });
  const nativeOwnership = {};
  for (const registration of registrations) {
    if (registration.kind !== "execution") continue;
    const group = registration.handlerGroup;
    if (group === null) fail("native_ownership_group_missing");
    (nativeOwnership[group] ??= []).push(registration.actionId);
  }
  const ownedCount = Object.values(nativeOwnership).reduce((total, ids) => total + ids.length, 0);
  if (ownedCount !== publishedExecutionActionIds.length + experimentalActionIds.length) {
    fail("native_ownership_partition_mismatch");
  }
  for (const [group, ids] of Object.entries(nativeOwnership)) nativeOwnership[group] = sorted(ids);

  // Guard-order composition is a derived, not consumer-invented, fact. The
  // consumer executes exactly the order published in the artifact.
  const guardOrder = Object.freeze([
    "schema",
    "development_scope",
    "game_id",
    "sources_pinned",
    "mod_registrations",
    "lifecycle_partition",
    "host_union",
    "protocol_union",
    "router_guard_order",
    "native_ownership",
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
  const repositoryRoot = path.resolve(ACTION_SOURCE_PROJECTION_PRODUCER_DIRECTORY, "../../../..");
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