import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_SURFACE_LIFECYCLES, ACTION_SURFACE_MAX_JSON_BYTES, ACTION_SURFACE_VISIBLE_LIFECYCLES } from "./action-surface.mjs";

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
/** The Host declaration the descriptor-derived tool mounts iterate, and the shape those mounts must have. */
const DESCRIPTOR_DERIVED_DECLARATION = "STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS";
const DESCRIPTOR_DERIVED_MOUNT_MARKERS = Object.freeze([
  ["tool_pushed", "tools.push("],
  ["factory_called", "makeGameActionTool({"],
  ["tool_name_from_the_declaration", "name: STARDEW_ACTION_TOOL_NAMES[actionId],"],
  ["action_from_the_declaration", "action: actionId,"],
  ["arguments_from_the_descriptor", "toArgs:"],
]);

/** The Host declaration the execution-request envelope admits its action ids from. */
const EXECUTION_REQUEST_DECLARATION = "EXECUTION_REQUEST_ARGUMENT_RULES";
const ACTION_HANDLER_GROUPS_SCHEMA = "gamebuddy-action-handler-groups/v1";
const ACTION_HANDLER_GROUPS_RELATIVE_PATH =
  "integrations/stardew/action-development/contracts/generated/action-handler-groups.v1.json";
/**
 * The handler families this projection publishes ownership for, keyed by the section name it uses and valued by the
 * catalog's own wire spelling. The Mod dispatches eight groups and its artifact publishes all eight; these five are
 * the ones the pinned `nativeOwnership` section carries, so widening this list is a projection revision rather than a
 * reader change.
 */
const PROJECTED_HANDLER_GROUPS = Object.freeze({
  Farming: "farming",
  Gathering: "gathering",
  Movement: "movement",
  MachinesAndAnimals: "machines_and_animals",
  ResourceTools: "resource_tools",
});
/**
 * The shared native-local smoke harness, named ONCE, relative to the directory the runners live in.
 *
 * A runner reaches it directly or through the layer it shares with its siblings (`lib/native-local-runner-scaffold.mjs`
 * for the single-shot executor, `lib/native-local-runner-primitives.mjs` for the parsers), and which of the two a runner
 * is allowed to do is the runner's own business: what this file holds every action to is that a reach exists. The old
 * constant spelled the whole runner-side import line, so the day the scaffold took the import over, ten runners stopped
 * "sharing" a harness they were still driving.
 */
const SHARED_HARNESS_MODULE = "lib/stardew-native-smoke-harness-v1.mjs";
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
const ACTION_SOURCE_PATHS = Object.freeze([
  {
    category: "canonical_action_surface",
    path: "integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
    // The allowance is the surface's OWN derived bound, imported rather than typed: two spellings of one limit is exactly
    // how the artifact outgrew this one while `ACTION_SURFACE_MAX_JSON_BYTES` said it still fitted.
    maxBytes: ACTION_SURFACE_MAX_JSON_BYTES,
  },
  {
    category: "mod_bridge_session",
    path: "integrations/stardew/BridgeSession.cs",
    maxBytes: 256 * 1024,
  },
  {
    category: "mod_execution_controller",
    path: "integrations/stardew/farmhandexecutioncontroller.cs",
    maxBytes: 512 * 1024,
  },
  {
    category: "mod_router",
    path: "integrations/stardew/src/Core/Routing/FarmhandActionRouter.cs",
    maxBytes: 64 * 1024,
  },
  {
    category: "canonical_handler_groups",
    path: ACTION_HANDLER_GROUPS_RELATIVE_PATH,
    maxBytes: 64 * 1024,
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
      || !ACTION_SURFACE_LIFECYCLES.includes(action.lifecycle)
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
  // The anchor keys on the CALL, not on the formatter's line breaking: a short
  // registration is written on one line while it fits and broken across lines
  // when it does not, and the Host surface must not lose an action because the
  // sheet decided it was narrow enough to keep on one line.
  const ids = [...source.matchAll(/actionAdapter\(\s*"([a-z0-9_]+)",/g)].map((entry) => entry[1]);
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

/**
 * The Host's own declaration of the actions whose tool is a projection of the Mod's descriptor, and the proof it is mounted.
 *
 * 39da4ec4 ("forty-eight mounts become one projection of the Mod's declaration") replaced forty-eight hand-written
 * `makeGameActionTool` blocks with one loop, so those mounts spell no action id at all and the two readers below cannot
 * see them. The DECLARATION the loop iterates is the authority - not the loop's text - because a reader keyed on the loop
 * reports a smaller Host surface the day the loop is refactored, and a smaller surface narrows `executableActionIds`
 * without failing anything: measured 2026-11-21, forty-eight routes went missing and the projection published 53
 * executable actions while the Host mounted 94.
 */
function parseDescriptorDerivedMounts(registry, gameTools) {
  const body = registry.match(
    new RegExp(`export const ${DESCRIPTOR_DERIVED_DECLARATION} = Object\\.freeze\\(\\[([\\s\\S]*?)\\] as const\\);`, "u"),
  )?.[1];
  if (!body) fail("descriptor_derived_declaration_unreadable");
  const actionIds = [...body.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
  if (actionIds.length === 0) fail("descriptor_derived_declaration_empty");
  assertUnique(actionIds, "descriptor_derived_declaration_duplicates");
  const at = gameTools.indexOf(`for (const actionId of ${DESCRIPTOR_DERIVED_DECLARATION}) {`);
  if (at < 0) fail("descriptor_derived_mount_missing");
  const block = gameTools.slice(at, gameTools.indexOf("\n  }\n", at));
  for (const [name, marker] of DESCRIPTOR_DERIVED_MOUNT_MARKERS) {
    if (!block.includes(marker)) fail(`descriptor_derived_mount_shape:${name}`);
  }
  return actionIds;
}

/**
 * The mounted tool routes, as the two things they are: the mounts that name their action, and the projection over the
 * declaration. Both halves are published, so "the Host mounts N tools" always arrives with how N was reached.
 */
function parseHostToolRoutes(source, registry) {
  // Constant mount (36608fa): Host mounts every Game Action tool unconditionally
  // and per-action authority is decided at execution time, so the mounted set is
  // exactly the defined tool set (tool name id == action id). The previous
  // \`if (isVisible("x")) {\` shape no longer exists in game-tools.ts and made this
  // parser report tool_routes_empty for the whole Host surface.
  const routes = [];
  for (const entry of source.matchAll(
    /name: STARDEW_ACTION_TOOL_NAMES\.([a-z0-9_]+),[\s\S]*?\n\s*action: "([a-z0-9_]+)",\s*(?:\n\s*)?toArgs:/g,
  )) {
    const name = entry[1];
    const action = entry[2];
    if (name !== action) fail(`tool_route_identity_drift:${name}`);
    routes.push(action);
  }
  // Loop-mounted families (for example the facility actions built with
  // \`for (const action of ["dress_mannequin", ...] as const)\`) mount one tool per
  // id from the loop header and use \`action: action\` in the body.
  for (const loop of source.matchAll(
    /for \(const action of (\[[a-z0-9_"\s,]+\]) as const\) \{[\s\S]*?makeGameActionTool\(\{/g,
  )) {
    for (const id of loop[1].matchAll(/"([a-z0-9_]+)"/g)) routes.push(id[1]);
  }
  if (routes.length === 0) fail("tool_routes_empty");
  const handMounted = assertUnique(routes, "tool_route_duplicates");
  const descriptorDerived = parseDescriptorDerivedMounts(registry, source);
  // `assertUnique` over the union fails on an id both halves claim: one action with two mounts is a duplicate tool, and it
  // would also make the two published counts add up to more than the routes they describe.
  return Object.freeze({
    handMounted: Object.freeze([...handMounted]),
    descriptorDerived: Object.freeze([...descriptorDerived]),
    actionIds: Object.freeze(assertUnique([...handMounted, ...descriptorDerived], "tool_route_duplicates")),
  });
}

/**
 * The action ids the Host's execution-request declaration carries argument rows for.
 *
 * `validateExecutionRequest` used to be a chain of `value.action !== "<id>"` comparisons and this producer harvested the
 * ids out of that text. 0dfea04b ("the execution-request ladder is a declaration, and protocol.ts shrinks") replaced the
 * chain with `EXECUTION_REQUEST_ARGUMENT_RULES`, whose key set is held to `ExecutionRequest["action"]` by `satisfies`.
 * The ladder stopped existing, so this reader reported `validateExecutionRequest_empty` and took the whole projection
 * down with it: both drift tests have been red since that commit, and the checked-in artifact predates it.
 */
function parseExecutionRequestDeclaration(source) {
  const at = source.indexOf(`export const ${EXECUTION_REQUEST_DECLARATION} = Object.freeze({`);
  if (at < 0) fail("execution_request_declaration_unreadable");
  const end = source.indexOf("\n} satisfies Record<", at);
  if (end < 0) fail("execution_request_declaration_unterminated");
  // A row list starts at exactly two spaces under the object literal, so `^ {2}<id>: ` is the key line and nothing a
  // row contains can spell it.
  const ids = [...source.slice(at, end).matchAll(/^ {2}([a-z0-9_]+): /gmu)].map((match) => match[1]);
  if (ids.length === 0) fail("execution_request_declaration_empty");
  return assertUnique(ids, "execution_request_declaration_duplicates");
}

/**
 * The ids `validateExecutionRequestEnvelope` admits, read as the CONSTRUCTION that makes them the declaration's own.
 *
 * 777bc797 ("an execution envelope answers to one requirement set, whatever action it names") replaced the per-action
 * comparisons with one requirement list whose `unknown_action` row asks `isExecutionAction`, over a set built from the
 * argument-rules declaration. A set that stops being that declaration's keys - or an envelope that stops refusing an id
 * it does not carry - is a different shape, and this reader fails closed instead of reading it as a narrower surface.
 */
function parseEnvelopeAdmission(source, declarationActionIds) {
  const derivedSet = new RegExp(
    `const EXECUTION_ACTIONS\\b[^=\\n]*=\\s*new Set\\(Object\\.keys\\(${EXECUTION_REQUEST_DECLARATION}\\)\\)`,
    "u",
  );
  if (!derivedSet.test(source)) fail("execution_request_envelope_action_set_not_declaration_derived");
  const body = source.match(/function validateExecutionRequestEnvelope[\s\S]*?\n\}\n/u)?.[0] ?? "";
  if (body.length === 0) fail("execution_request_envelope_unreadable");
  if (!body.includes("isExecutionAction(value.action)") || !body.includes('return "unknown_action";'))
    fail("execution_request_envelope_not_declaration_derived");
  return [...declarationActionIds];
}

function parseExecutionRequestUnion(source) {
  const body = source.match(/export type ExecutionRequest[\s\S]*?;\n}>;/)?.[0];
  if (!body) fail("execution_request_union_unreadable");
  const ids = [...body.matchAll(/\| "([a-z0-9_]+)"/g)].map((entry) => entry[1]);
  if (ids.length === 0) fail("execution_request_union_empty");
  return assertUnique(ids, "execution_request_union_duplicates");
}

function parseBridgeMessageTypes(source) {
  // This protocol list is deliberately module-private: BridgeMessage is its
  // public boundary. Parse the literal list regardless of export visibility.
  const body = source.match(/(?:export )?const BRIDGE_MESSAGE_TYPES = \[([\s\S]*?)\] as const;/)?.[1];
  if (!body) fail("bridge_message_types_unreadable");
  const types = [...body.matchAll(/"([a-z0-9_]+)"/g)].map((entry) => entry[1]);
  if (types.length === 0) fail("bridge_message_types_empty");
  return assertUnique(types, "bridge_message_types_duplicates");
}

function parseSemanticEventKinds(source) {
  const explicit = source.match(/(?:export )?type SemanticEvent[\s\S]*?reasonCode: string;/)?.[0] ?? "";
  const kinds = [...explicit.matchAll(/\| "([a-z0-9_]+)"/g)].map((entry) => entry[1]);
  const bodyTrace = source.match(/(?:export )?type BodyTrace[\s\S]*?;\r?\n}>;/)?.[0] ?? "";
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

/**
 * The registration catalogs the hello's projection names, or null when the projection cannot be read.
 *
 * READ AS CATALOGS, NOT AS A SENTENCE. This used to test one literal line
 * (`Registrations.Concat(Forms.Registrations).Select(registration => new FarmhandActionRegistrationWire(`), which is a
 * reading that can only say "somebody wrote this sentence": it cannot tell a hello that offers the action catalog from
 * a hello that offers a catalog of forms. That is how the plan-form registration stayed advertised for as long as the
 * Host declared no form. The operands are read instead, so what is checked is which catalogs are offered - and a
 * reformat of the projection, which changes the sentence but not the offer, is no longer a finding.
 */
export function helloProjectedRegistrationCatalogs(source) {
  const expression =
    /((?:[\w.]+\.Registrations)(?:\s*\.Concat\(\s*[\w.]+\.Registrations\s*\))*)\s*\.Select\(\s*registration\s*=>\s*new\s+FarmhandActionRegistrationWire\(/u.exec(
      source,
    )?.[1];
  return expression === undefined
    ? null
    : Object.freeze(
        expression
          .replace(/\s/gu, "")
          .split(".Concat(")
          .map((part) => part.replace(/\)+$/u, "")),
      );
}

function parseModProvenance(bridgeSession, executionController) {
  // THE HELLO ADVERTISES THE MOD'S ACTION CATALOG, projected through the one `FarmhandActionRegistrationWire` shape,
  // which is what `helloAdvertisement: "catalog_projection"` means - never a hand-written list of ids in the Mod or in
  // this producer. A per-id assertion here would agree with itself: the ids this producer knows are the action
  // catalog's ids, because the surface artifact is generated from that catalog, so the readable fact is the CATALOG the
  // projection names. The plan forms are registered for the Body Program catalog and deliberately not offered - a form
  // no Host declares has no frame that could name it.
  const catalogs = helloProjectedRegistrationCatalogs(bridgeSession);
  if (catalogs === null) fail("hello_advertisement_missing:unreadable_projection");
  if (!catalogs.includes("FarmhandActionCatalog.Registrations"))
    fail("hello_advertisement_missing:" + sorted(catalogs).join("+"));
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
  return Object.freeze({ capabilityProvenance: Object.freeze({
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

/**
 * Which actions each handler family owns, read from the Mod's own registration catalog.
 *
 * The catalog is the authority `ModEntry`'s router switches on, and `ActionDefinitionRoutingParityTests` proves from
 * the handlers' IL that every `Execute` switch covers exactly the group its registration declares. This reader used to
 * match the arm labels of `Handlers/*.cs` as text (`"<actionId>" =>`), which meant a family respelled as a dictionary
 * - or a handler file that moved - emptied the family out of the projection without raising anything: the projection
 * recorded a smaller population and every coherence assertion around it still passed.
 */
function parseHandlerGroups(source) {
  let artifact;
  try { artifact = JSON.parse(source); } catch { fail("handler_groups_json_invalid"); }
  if (!artifact || artifact.schema !== ACTION_HANDLER_GROUPS_SCHEMA
    || !Number.isSafeInteger(artifact.catalogRevision) || artifact.catalogRevision < 1
    || !Array.isArray(artifact.actions) || artifact.actions.length === 0) fail("handler_groups_unreadable");
  const wireToGroup = new Map(Object.entries(PROJECTED_HANDLER_GROUPS).map(([group, wire]) => [wire, group]));
  const ownership = Object.fromEntries(Object.keys(PROJECTED_HANDLER_GROUPS).map((group) => [group, []]));
  for (const row of artifact.actions) {
    if (!row || typeof row !== "object" || !IDENTIFIER.test(row.actionId) || typeof row.handlerGroup !== "string") {
      fail("handler_groups_row_invalid");
    }
    const group = wireToGroup.get(row.handlerGroup);
    if (group !== undefined) ownership[group].push(row.actionId);
  }
  for (const [group, ids] of Object.entries(ownership)) {
    if (ids.length === 0) fail(`handler_group_empty:${group}`);
  }
  return ownership;
}

/**
 * The row table the live gates are declared in: one row per action, whatever route its gate takes.
 *
 * A row names its gate either as a runner in `tools/` or as `contracts/smoke/<actionId>.json` (`null` in the runner
 * position, `"contract"` in the route position). This reader used to match only rows whose third argument was quoted,
 * so a row that moved to the contract route fell out of the projection with nothing to see: nine actions left the
 * population and every assertion around it still passed. The count of `gate(` calls in the table is now the authority on
 * how many rows there are, and a row this reader cannot account for is refused by name instead of skipped.
 */
function parseGateDescriptors(source) {
  const body = source.match(/STARDEW_PUBLISHED_ACTION_GATES\s*=\s*Object\.freeze\(\[([\s\S]*?)\n\]\);/)?.[1];
  if (!body) fail("gate_descriptors_unreadable");
  const gates = [...body.matchAll(
    /gate\(\s*"([a-z0-9_]+)"\s*,\s*(\d+)\s*,\s*(?:"([a-z0-9-]+\.mjs)"|null)\s*,\s*"([a-z0-9_]+)"(?:\s*,\s*(?:"([a-z0-9_]+)"|null))?(?:\s*,\s*"([a-z]+)")?\s*,?\s*\)/g,
  )].map((match) => Object.freeze({
    actionId: match[1],
    runner: match[3] ?? null,
    fixtureScenario: match[5] ?? null,
    gateRoute: match[6] ?? "runner",
  }));
  if (gates.length === 0) fail("gate_descriptors_empty");
  const declaredRowCount = (body.match(/\n\s*gate\s*\(/gu) ?? []).length;
  if (declaredRowCount !== gates.length) fail(`gate_descriptor_row_unreadable:${declaredRowCount - gates.length}`);
  assertUnique(gates.map((gate) => gate.actionId), "gate_descriptor_action_duplicates");
  for (const gate of gates) {
    if (gate.gateRoute !== "runner" && gate.gateRoute !== "contract") fail(`gate_descriptor_route_unknown:${gate.actionId}`);
    if (gate.gateRoute === "contract" && gate.runner !== null) fail(`gate_descriptor_contract_row_names_a_runner:${gate.actionId}`);
    if (gate.gateRoute === "runner" && gate.runner === null) fail(`gate_descriptor_runner_row_names_no_runner:${gate.actionId}`);
  }
  // One runner may legitimately prove several actions: the experimental map already shares a runner between actions that
  // differ only by target surface (chest/fridge, ship_item/island). Requiring runner uniqueness here would reject that
  // established shape, so only the action id must be unique.
  return gates;
}

/**
 * The relative module specifiers a source imports, in source order and without repeats.
 *
 * Read as SPECIFIERS rather than as one expected line, because a runner's harness edge is an edge in a graph: whether a
 * module is reached does not depend on which file spells the specifier or how it is indented.
 */
function localImportSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(/(?:from|import)\s+["']((?:\.\/|\.\.\/)[^"']+\.mjs)["']/gu)) specifiers.push(match[1]);
  return [...new Set(specifiers)];
}

/** A specifier resolved against the importing module's own directory, or `null` when it leaves the runner directory. */
function resolveLocalImport(fromModule, specifier) {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromModule), specifier));
  return resolved === ".." || resolved.startsWith("../") ? null : resolved;
}

/** Whether a runner reaches the shared harness, through its own imports or through the modules it shares with them. */
function sharesTheHarness(runner, { files, shared }) {
  const reached = new Set();
  const pending = [runner];
  while (pending.length > 0) {
    const modulePath = pending.pop();
    if (reached.has(modulePath)) continue;
    reached.add(modulePath);
    const moduleSource = modulePath === runner ? files[runner] : (shared[modulePath] ?? files[modulePath]);
    if (typeof moduleSource !== "string") continue;
    for (const specifier of localImportSpecifiers(moduleSource)) {
      const resolved = resolveLocalImport(modulePath, specifier);
      if (resolved === SHARED_HARNESS_MODULE) return true;
      if (resolved !== null) pending.push(resolved);
    }
  }
  return false;
}

/** The census a green run publishes and a red one prints, so "nothing missing" always arrives with what was examined. */
function describeRunnerSharing({ examined, runnerFound, sharesHarness, missing, contractRoute }) {
  return `actions examined ${examined} · runner found ${runnerFound} · shares the harness ${sharesHarness}`
    + ` · missing ${missing} (gate route contract: ${contractRoute})`;
}

/**
 * Every action the gate table declares, against the runner that must reach the shared harness on its behalf.
 *
 * The population is the TABLE, not a list kept here: a row added tomorrow is examined without this file changing, and a
 * row whose gate is a contract is counted by route rather than reported as a runner that lost its import. Two findings,
 * because they are two mistakes with two fixes - a runner that is not there at all, and a runner that is there and no
 * longer reaches the harness.
 */
function parseRunnerSources(source, gates) {
  let runners;
  try {
    runners = JSON.parse(source);
  } catch {
    fail("runner_sources_unreadable");
  }
  if (runners === null || typeof runners !== "object" || Array.isArray(runners)
    || !Array.isArray(runners.entries) || runners.files === null || typeof runners.files !== "object"
    || Array.isArray(runners.files) || runners.shared === null || typeof runners.shared !== "object"
    || Array.isArray(runners.shared)) fail("runner_sources_invalid");
  const entries = assertUnique(runners.entries, "runner_directory_entry_duplicates");
  for (const obsolete of OBSOLETE_RUNNER_FILENAMES) {
    if (entries.includes(obsolete)) fail(`obsolete_runner_present:${obsolete}`);
  }
  // The harness is one file: when it is not there, say so once instead of naming ninety-one actions that suddenly share
  // nothing.
  if (typeof runners.shared[SHARED_HARNESS_MODULE] !== "string") fail("shared_harness_missing");

  const actions = [];
  const problems = [];
  let runnerFound = 0;
  let sharesHarness = 0;
  for (const gate of gates) {
    if (gate.gateRoute === "contract") {
      actions.push(Object.freeze({ actionId: gate.actionId, runner: null, fixtureScenario: gate.fixtureScenario }));
      continue;
    }
    const runnerSource = entries.includes(gate.runner) ? runners.files[gate.runner] : undefined;
    if (typeof runnerSource !== "string") {
      problems.push(`a_runner_missing:${gate.actionId}`);
      continue;
    }
    runnerFound += 1;
    if (!sharesTheHarness(gate.runner, runners)) {
      problems.push(`a_runner_shares_the_harness:${gate.actionId}`);
      continue;
    }
    sharesHarness += 1;
    if (runnerSource.includes("host-production-module")) fail(`runner_legacy_host_route_present:${gate.actionId}`);
    actions.push(Object.freeze({ actionId: gate.actionId, runner: gate.runner, fixtureScenario: gate.fixtureScenario }));
  }
  const contractRoute = actions.filter((action) => action.runner === null).length;
  const sharing = Object.freeze({
    examined: gates.length,
    runnerFound,
    sharesHarness,
    missing: gates.length - sharesHarness - contractRoute,
    contractRoute,
  });
  if (problems.length > 0) fail(`${problems.join(", ")} · ${describeRunnerSharing(sharing)}`);
  return Object.freeze({
    actions: Object.freeze(actions),
    sharedHarnessModule: SHARED_HARNESS_MODULE,
    sharing,
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
      .filter((registration) => ACTION_SURFACE_VISIBLE_LIFECYCLES.includes(registration.lifecycle) && registration.kind === "execution")
      .map((registration) => registration.actionId),
    "published_partition_duplicates",
  );
  const publishedEmbodiedExecutionActionIds = publishedExecutionActionIds.filter((actionId) => {
    const registration = registrations.find((candidate) => candidate.actionId === actionId);
    return registration?.descriptor?.resourceTemplate?.claims?.some((claim) => claim.key === "embodied_actor");
  });
  const readOnlyActionIds = assertUnique(
    registrations
      .filter((registration) => ACTION_SURFACE_VISIBLE_LIFECYCLES.includes(registration.lifecycle) && registration.kind === "read_only")
      .map((registration) => registration.actionId),
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
  const toolRoute = parseHostToolRoutes(sources.host_game_tools, sources.host_registry);
  const toolRouteActionIds = toolRoute.actionIds;
  // The declaration and the mount are one fact: an id the projection names has no tool to mount when
  // `STARDEW_ACTION_TOOL_NAMES` - the table the mount indexes - does not carry it, and the projection would then publish a
  // Host surface narrower than the one the Host builds. Refused by name, never published as a smaller set.
  //
  // NOT the same rule as a mount that really is gone: a route the Host stops building is a fact the projection must report
  // (it narrows `executableActionIds`, which is the restrictive intersection doing its job), and the surface parity gate
  // names the action that lost its route. What must never be published is the reader's own blindness.
  for (const actionId of toolRoute.descriptorDerived) {
    if (!toolActionIds.includes(actionId)) fail(`descriptor_derived_id_not_projected:${actionId}`);
  }
  const requestValidatorActionIds = parseExecutionRequestDeclaration(sources.host_protocol);
  const envelopeValidatorActionIds = parseEnvelopeAdmission(sources.host_protocol, requestValidatorActionIds);
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

  // Handler ownership is integrity evidence only. Every row must name a canonical
  // execution action, and it does not expand the executable set or impose ownership
  // requirements on experimental/read-only/Navigation IDs.
  const provenance = parseModProvenance(sources.mod_bridge_session, sources.mod_execution_controller);
  const nativeOwnership = parseHandlerGroups(sources.canonical_handler_groups);
  const canonicalExecutionIds = new Set(
    registrations.filter((registration) => registration.kind === "execution").map((registration) => registration.actionId),
  );
  const declaredHandlerIds = Object.values(nativeOwnership).flat();
  const unmatchedHandlerIds = declaredHandlerIds.filter((actionId) => !canonicalExecutionIds.has(actionId));
  if (unmatchedHandlerIds.length > 0) fail("native_handler_non_execution_action:" + [...new Set(unmatchedHandlerIds)].sort().join(","));
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
      // How the route set was reached, published beside it: the mounts that name their action, and the ones the Host builds
      // from its own declaration. A reader who only sees the total cannot tell a Host that mounts 103 tools from a reader
      // that can see 55 of them.
      toolRouteProvenance: Object.freeze({
        namedMounts: toolRoute.handMounted.length,
        descriptorDerived: toolRoute.descriptorDerived.length,
      }),
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
      // The runners AND the modules they share: a runner that reaches the harness through
      // `lib/native-local-runner-scaffold.mjs` is driven by that harness exactly as one that imports it itself, so the
      // reader follows the imports instead of expecting one line of text to survive a refactor. Files with a directory
      // separator are the shared layer, bare names are the runners; the walk is bounded by the runner directory, so a
      // specifier pointing at `host/` is not read here at all.
      const files = {};
      const shared = {};
      const read = new Set();
      const pending = gates.filter((gate) => gate.runner !== null).map((gate) => gate.runner);
      let totalBytes = 0;
      while (pending.length > 0) {
        const modulePath = pending.pop();
        if (read.has(modulePath)) continue;
        read.add(modulePath);
        let bytes;
        try {
          bytes = await readFile(path.join(absolute, modulePath));
        } catch {
          continue;
        }
        totalBytes += bytes.length;
        const text = bytes.toString("utf8");
        if (modulePath.includes("/")) shared[modulePath] = text;
        else files[modulePath] = text;
        for (const specifier of localImportSpecifiers(text)) {
          const resolved = resolveLocalImport(modulePath, specifier);
          if (resolved !== null) pending.push(resolved);
        }
      }
      if (totalBytes > entry.maxBytes) fail(`source_too_large:${entry.category}:${totalBytes}>${entry.maxBytes}`);
      sources[entry.category] = JSON.stringify({
        entries,
        files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => (left < right ? -1 : 1))),
        shared: Object.fromEntries(Object.entries(shared).sort(([left], [right]) => (left < right ? -1 : 1))),
      });
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