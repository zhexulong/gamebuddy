import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";

const ROOT = resolve(import.meta.dirname, "..");

export function validatePromotionSources({
  farmhandActionDefinitions,
  bridgeSession,
  executionManager,
  farmhandActionRouter,
  registry,
  gameTools,
  protocol,
  schema,
  descriptors = STARDEW_PUBLISHED_ACTION_GATES,
}) {
  const failures = [];
  const definitions = parseModDefinitions(farmhandActionDefinitions);
  const hostEntries = parseHostEntries(registry);
  const routes = parseExplicitRoutes(gameTools);
  failures.push(...validateHostWrapperFactory(gameTools, routes));
  failures.push(...validateRouterBoundary(bridgeSession, farmhandActionRouter));
  const hostValidators = parseHostRequestValidators(protocol);
  const envelopeValidators = parseEnvelopeValidators(protocol);
  const executionRequestUnion = parseExecutionRequestUnion(protocol);
  const hostMessageTypes = parseHostBridgeMessageTypes(protocol);
  const schemaMessageTypes = parseSchemaBridgeMessageTypes(schema);
  const hostSemanticEventKinds = parseHostSemanticEventKinds(protocol);
  const schemaSemanticEventKinds = parseSchemaSemanticEventKinds(schema);
  const schemaActions = parseSchemaExecutionActions(schema);
  const descriptorIds = descriptors.map((descriptor) => descriptor.actionId);
  failures.push(
    ...findMissingBridgeHelloAdvertisements(
      bridgeSession,
      definitions.filter((definition) => definition.lifecycle === "published").map((definition) => definition.actionId),
    ),
  );
  if (!hasSnapshotCapabilitySurfaceProvenance(executionManager)) failures.push("snapshot_not_from_capability_surface");
  assertUnique(
    definitions.map((entry) => entry.actionId),
    "mod_definition_duplicates",
    failures,
  );
  assertUnique(
    hostEntries.map((entry) => entry.actionId),
    "host_registry_duplicates",
    failures,
  );
  assertUnique(descriptorIds, "gate_descriptor_duplicates", failures);
  for (const definition of definitions) {
    const host = hostEntries.filter((entry) => entry.actionId === definition.actionId);
    if (definition.lifecycle === "published") {
      if (host.length !== 1) failures.push(`published_host_projection:${definition.actionId}`);
      // The Host only inventories a concrete typed adapter. It deliberately
      // does not duplicate Mod-owned family, identity-version, or lifecycle.
      const descriptor = descriptors.filter((entry) => entry.actionId === definition.actionId);
      if (descriptor.length !== 1) failures.push(`published_missing_gate_descriptor:${definition.actionId}`);
      else if (descriptor[0].identityVersion !== definition.identityVersion)
        failures.push(`gate_identity_drift:${definition.actionId}`);
    } else if (host.length > 1) {
      failures.push(`experimental_adapter_duplicates:${definition.actionId}`);
    }
    if (!hostValidators.includes(definition.actionId))
      failures.push(`missing_host_request_validator:${definition.actionId}`);
    if (!envelopeValidators.includes(definition.actionId))
      failures.push(`missing_envelope_validator:${definition.actionId}`);
    if (!executionRequestUnion.includes(definition.actionId))
      failures.push(`missing_execution_request_union:${definition.actionId}`);
    if (!schemaActions.includes(definition.actionId))
      failures.push(`missing_schema_execution_action:${definition.actionId}`);
  }
  for (const actionId of hostValidators)
    if (!definitions.some((definition) => definition.actionId === actionId))
      failures.push(`host_request_validator_not_in_definition:${actionId}`);
  for (const actionId of envelopeValidators)
    if (!definitions.some((definition) => definition.actionId === actionId))
      failures.push(`envelope_validator_not_in_definition:${actionId}`);
  for (const actionId of executionRequestUnion)
    if (!definitions.some((definition) => definition.actionId === actionId))
      failures.push(`execution_request_union_not_in_definition:${actionId}`);
  for (const actionId of schemaActions)
    if (!definitions.some((definition) => definition.actionId === actionId))
      failures.push(`schema_execution_action_not_in_definition:${actionId}`);
  assertUnique(executionRequestUnion, "execution_request_union_duplicates", failures);
  assertUnique(schemaActions, "schema_execution_action_duplicates", failures);
  assertUnique(hostMessageTypes, "host_message_type_duplicates", failures);
  assertUnique(schemaMessageTypes, "schema_message_type_duplicates", failures);
  for (const type of hostMessageTypes)
    if (!schemaMessageTypes.includes(type)) failures.push(`schema_missing_message_type:${type}`);
  for (const type of schemaMessageTypes)
    if (!hostMessageTypes.includes(type)) failures.push(`schema_orphan_message_type:${type}`);
  assertUnique(hostSemanticEventKinds, "host_semantic_event_kind_duplicates", failures);
  assertUnique(schemaSemanticEventKinds, "schema_semantic_event_kind_duplicates", failures);
  for (const kind of hostSemanticEventKinds)
    if (!schemaSemanticEventKinds.includes(kind)) failures.push(`schema_missing_semantic_event_kind:${kind}`);
  for (const kind of schemaSemanticEventKinds)
    if (!hostSemanticEventKinds.includes(kind)) failures.push(`schema_orphan_semantic_event_kind:${kind}`);
  for (const host of hostEntries) {
    const definition = definitions.find((entry) => entry.actionId === host.actionId);
    if (!definition) failures.push(`host_adapter_not_in_mod:${host.actionId}`);
    const toolCount = routes.visibility.filter((actionId) => actionId === host.actionId).length;
    if (toolCount !== 1) failures.push(`host_tool_count:${host.actionId}:${toolCount}`);
  }
  for (const id of descriptorIds)
    if (!definitions.some((entry) => entry.actionId === id && entry.lifecycle === "published"))
      failures.push(`gate_descriptor_not_published:${id}`);
  return { failures, definitions, hostEntries };
}

function assertUnique(values, label, failures) {
  if (new Set(values).size !== values.length) failures.push(label);
}
function findMissingBridgeHelloAdvertisements(source, expectedActionIds) {
  // Registration identity is Mod-owned. The authenticated hello must project
  // that catalog directly rather than reproduce a Host-side action list.
  return /FarmhandActionCatalog\.Registrations\.Select\(registration\s*=>\s*new FarmhandActionRegistrationWire\(/.test(
    source,
  )
    ? []
    : expectedActionIds.map(
        (actionId) => `bridge_hello_registration_advertisement_missing:${actionId}`,
      );
}
function parseModDefinitions(source) {
  const body = source.match(/Registrations\s*=\s*Array\.AsReadOnly\(new\[\]\s*\{([\s\S]*?)\}\);/)?.[1];
  if (!body) throw new Error("mod_action_registrations_not_found");
  return [
    ...body.matchAll(
      /Registration\("([a-z0-9_]+)", "([a-z0-9_]+)", (\d+), FarmhandActionHandlerGroup\.[A-Za-z]+(?:, FarmhandActionLifecycle\.(Published|Experimental))?\)/g,
    ),
  ].map(([, actionId, familyId, identityVersion, lifecycle]) => ({
    actionId,
    familyId,
    identityVersion: Number(identityVersion),
    lifecycle: (lifecycle ?? "Published").toLowerCase(),
  }));
}
function parseHostEntries(source) {
  return [...source.matchAll(/actionAdapter\(\s*"([a-z0-9_]+)"/g)].map(([, actionId]) => ({ actionId }));
}
function hasSnapshotCapabilitySurfaceProvenance(source) {
  const body =
    source.match(
      /public BridgeSnapshot CreateBridgeSnapshot\(\)[\s\S]*?\n {4}private BridgeSnapshot CreateWorldNotReadyBridgeSnapshot/,
    )?.[0] ?? "";
  return (
    body.includes("IReadOnlyList<string> advertisedCapabilities = this.capabilitySurface.Capabilities;") &&
    /return CreateWorldNotReadyBridgeSnapshot\(advertisedCapabilities\);/.test(body) &&
    /return new BridgeSnapshot\([\s\S]*?\n {12}advertisedCapabilities,/.test(body)
  );
}
function parseHostRequestValidators(source) {
  const body =
    source.match(/export function validateExecutionRequest[\s\S]*?function validateExecutionRequestEnvelope/)?.[0] ??
    "";
  return [...new Set([...body.matchAll(/value\.action !== "([a-z0-9_]+)"/g)].map((entry) => entry[1]))];
}
function parseExecutionRequestUnion(source) {
  const body = source.match(/export type ExecutionRequest[\s\S]*?;\n}>;/)?.[0] ?? "";
  return [...body.matchAll(/\| "([a-z0-9_]+)"/g)].map((entry) => entry[1]);
}
function parseHostBridgeMessageTypes(source) {
  const body = source.match(/export const BRIDGE_MESSAGE_TYPES = \[([\s\S]*?)\] as const;/)?.[1];
  if (!body) throw new Error("host_bridge_message_types_not_found");
  return [...body.matchAll(/"([a-z0-9_]+)"/g)].map((entry) => entry[1]);
}
function parseSchemaBridgeMessageTypes(source) {
  const schema = JSON.parse(source);
  return schema.properties.type.enum;
}
function parseHostSemanticEventKinds(source) {
  const body = source.match(/export type SemanticEvent[\s\S]*?reasonCode: string;/)?.[0] ?? "";
  const explicitKinds = [...body.matchAll(/\| "([a-z0-9_]+)"/g)].map((entry) => entry[1]);
  const bodyTraceKinds = [
    ...(source.match(/export type BodyTrace[\s\S]*?;\n}>;/)?.[0] ?? "").matchAll(/\| "([a-z0-9_]+)"/g),
  ].map((entry) => entry[1]);
  return [...explicitKinds, ...bodyTraceKinds];
}
function parseSchemaSemanticEventKinds(source) {
  const schema = JSON.parse(source);
  return schema.$defs.semanticEvent.properties.kind.enum;
}
function parseSchemaExecutionActions(source) {
  const schema = JSON.parse(source);
  return schema.$defs.executionRequest.properties.action.enum;
}
function parseEnvelopeValidators(source) {
  const body = source.match(/function validateExecutionRequestEnvelope[\s\S]*?\n}\n/)?.[0] ?? "";
  return [...new Set([...body.matchAll(/value\.action === "([a-z0-9_]+)"/g)].map((entry) => entry[1]))];
}
function parseExplicitRoutes(gameTools) {
  const visibility = [...gameTools.matchAll(/if \(isVisible\("([a-z0-9_]+)"\)\)/g)].map((entry) => entry[1]);
  const tools = [
    ...gameTools.matchAll(
      /if \(isVisible\("([a-z0-9_]+)"\)\) \{\s*tools\.push\(\s*makeGameActionTool\(\{[\s\S]*?\n\s*action: "([a-z0-9_]+)",\s*\n\s*toArgs:/g,
    ),
  ].map((entry) => ({ visibleAction: entry[1], adapterAction: entry[2] }));
  return { tools, visibility };
}

function extractUniqueHostWrapperFactoryBody(gameTools) {
  const matches = [
    ...gameTools.matchAll(
      /function gameActionToolFactory\([\s\S]*?\n}\n\n\/\*\* Caller-supplied identity fields read from the preserved concrete tool schema\. \*\//g,
    ),
  ];
  if (matches.length !== 1) return null;
  return matches[0][0].slice(
    0,
    -"\n\n/** Caller-supplied identity fields read from the preserved concrete tool schema. */".length,
  );
}

function validateHostWrapperFactory(gameTools, routes) {
  const failures = [];
  const factory = extractUniqueHostWrapperFactoryBody(gameTools);
  if (factory === null) failures.push("host_wrapper_factory_boundary_invalid");
  if (
    !factory?.includes("executeGameAction(") ||
    !factory?.includes("definition.action") ||
    !factory?.includes("definition.toArgs") ||
    !factory?.includes("callerRequestIds(params)")
  )
    failures.push("host_shared_wrapper_factory_invalid");

  const visibleActionIds = routes.visibility;
  const adapterActionIds = routes.tools.map((entry) => entry.adapterAction);
  assertUnique(visibleActionIds, "host_tool_visibility_duplicates", failures);
  assertUnique(adapterActionIds, "host_tool_adapter_duplicates", failures);
  for (const route of routes.tools)
    if (route.visibleAction !== route.adapterAction)
      failures.push(`host_tool_adapter_identity_drift:${route.visibleAction}:${route.adapterAction}`);
  return failures;
}

function validateRouterBoundary(bridgeSession, router) {
  const failures = [];
  const threadGuard = router?.indexOf("if (!this.IsOnOwnerThread)") ?? -1;
  const replayLookup = router?.indexOf("if (ledger.TryGetExistingReceipt(request.RequestId") ?? -1;
  const handlerLookup = router?.indexOf("if (!this.handlers.TryGetValue(request.Action") ?? -1;
  const handlerExecution = router?.indexOf("receipt = handler.Execute(request, ledger);") ?? -1;
  if (threadGuard < 0) failures.push("router_missing_game_thread_guard");
  if (replayLookup < 0) failures.push("router_missing_replay_guard");
  if (handlerLookup < 0) failures.push("router_missing_handler_lookup");
  if (handlerExecution < 0) failures.push("router_missing_handler_execution");

  const tryExecute =
    bridgeSession.match(/internal bool TryExecute\([\s\S]*?\n {4}internal bool TryCreateReceiptEvent\(/)?.[0] ?? "";
  const structuralGuard = tryExecute.indexOf(
    "if (!IsStructurallyValidExecutionRequest(request, out reasonCode)) return false;",
  );
  const capabilityGuardInSession = tryExecute.indexOf(
    "if (!this.publishedCapabilities.ContainsGameAction(request.Action))",
  );
  const freshnessGuard = tryExecute.indexOf("if (!IsFreshExecutionRequest(request, out reasonCode)) return false;");
  const idempotencyLookup = tryExecute.indexOf("if (this.idempotency.TryGetValue(");
  const routerCall = tryExecute.indexOf("if (!this.actionRouter.TryRoute(");
  if (
    !(
      structuralGuard >= 0 &&
      structuralGuard < capabilityGuardInSession &&
      capabilityGuardInSession < freshnessGuard &&
      freshnessGuard < idempotencyLookup &&
      idempotencyLookup < routerCall
    )
  )
    failures.push("bridge_session_router_guard_order_invalid");
  return failures;
}

async function main() {
  const paths = {
    farmhandActionDefinitions: resolve(ROOT, "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs"),
    bridgeSession: resolve(ROOT, "integrations/stardew/BridgeSession.cs"),
    executionManager: resolve(ROOT, "integrations/stardew/ExecutionManager.cs"),
    farmhandActionRouter: resolve(ROOT, "integrations/stardew/src/Core/Routing/FarmhandActionRouter.cs"),
    farmingHandler: resolve(ROOT, "integrations/stardew/Handlers/FarmingActionHandler.cs"),
    gatheringHandler: resolve(ROOT, "integrations/stardew/Handlers/GatheringActionHandler.cs"),
    movementHandler: resolve(ROOT, "integrations/stardew/Handlers/MovementActionHandler.cs"),
    machineHandler: resolve(ROOT, "integrations/stardew/Handlers/MachineAndAnimalActionHandler.cs"),
    resourceHandler: resolve(ROOT, "integrations/stardew/Handlers/ResourceToolActionHandler.cs"),
    registry: resolve(ROOT, "host/src/action-registry.ts"),
    gameTools: resolve(ROOT, "host/src/game-tools.ts"),
    protocol: resolve(ROOT, "host/src/protocol.ts"),
    schema: resolve(ROOT, "protocol/bridge-v1.schema.json"),
  };
  const source = Object.fromEntries(
    await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(path, "utf8")])),
  );
  const handlerSources = [
    source.farmingHandler,
    source.gatheringHandler,
    source.movementHandler,
    source.machineHandler,
    source.resourceHandler,
  ];
  const result = validatePromotionSources({ ...source, handlerSources });
  for (const gate of STARDEW_PUBLISHED_ACTION_GATES)
    await access(resolve(ROOT, "tools", gate.runner), constants.R_OK).catch(() =>
      result.failures.push(`gate_runner_missing:${gate.actionId}:${gate.runner}`),
    );
  if (result.failures.length) {
    console.error(JSON.stringify({ state: "failed", ...result }, null, 2));
    process.exitCode = 1;
  } else
    console.log(
      JSON.stringify(
        {
          state: "passed",
          publishedCount: result.definitions.filter((entry) => entry.lifecycle === "published").length,
        },
        null,
        2,
      ),
    );
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
