const ERROR_PREFIX = "stardew_projection_parity";

export const PROJECTION_PARITY_SCHEMA = "gamebuddy-stardew-action-projection-parity/v1";
export const PROJECTION_PARITY_GAME_ID = "stardew";
export const PROJECTION_PARITY_SURFACE_SCHEMA = "gamebuddy-stardew-action-surface/v1";
export const PROJECTION_PARITY_ENVELOPE_KEYS = Object.freeze([
  "schema",
  "developmentOnly",
  "gameId",
  "surface",
  "lifecycle",
  "protocol",
  "ownership",
  "fixtureOwnedFiles",
  "guardOrder",
  "absentRoutes",
]);
export const PROJECTION_PARITY_SURFACE_KEYS = Object.freeze(["schema", "registrations"]);
export const PROJECTION_PARITY_REGISTRATION_KEYS = Object.freeze([
  "actionId",
  "familyId",
  "identityVersion",
  "lifecycle",
  "kind",
]);
export const PROJECTION_PARITY_LIFECYCLE_KEYS = Object.freeze([
  "admittedLifecycles",
  "executableActionIds",
  "readOnlyActionIds",
  "experimentalActionIds",
]);
export const PROJECTION_PARITY_PROTOCOL_KEYS = Object.freeze(["schemas", "fixedControls"]);
export const PROJECTION_PARITY_OWNERSHIP_KEYS = Object.freeze([
  "localFixtureOwnedActionIds",
  "nativeActionIds",
]);
export const PROJECTION_PARITY_ADMITTED_LIFECYCLES = Object.freeze(["published", "experimental"]);
export const PROJECTION_PARITY_KINDS = Object.freeze(["execution", "read_only"]);
export const PROJECTION_PARITY_FIXED_PROTOCOL_CONTROLS = Object.freeze([
  "inspect_self",
  "cancel_active_execution",
]);
// Versioned ordered guard sequence. The snapshot pins these guards in exactly
// this order; validation below executes in the same order.
export const PROJECTION_PARITY_GUARD_ORDER = Object.freeze([
  "schema",
  "development_scope",
  "game_id",
  "envelope_shape",
  "surface_registrations",
  "lifecycle_partition",
  "surface_subsets",
  "protocol_union",
  "protocol_controls",
  "ownership_partition",
  "guard_order_pinned",
  "obsolete_route_absence",
]);
// Versioned absence facts: these route/lifecycle identifiers must never appear
// as a snapshot value. The snapshot pins exactly this set.
export const PROJECTION_PARITY_ABSENT_ROUTE_TOKENS = Object.freeze([
  "adoption",
  "dual_read",
  "fallback",
  "legacy",
  "migration",
  "read_repair",
  "withdrawn",
]);
export const PROJECTION_PARITY_MAX_JSON_BYTES = 32 * 1024;
export const PROJECTION_PARITY_MAX_REGISTRATIONS = 128;
export const PROJECTION_PARITY_MAX_IDENTIFIER_LENGTH = 128;
export const PROJECTION_PARITY_MAX_IDENTITY_VERSION = 2_147_483_647;
export const PROJECTION_PARITY_MAX_IDS = 128;
export const PROJECTION_PARITY_MAX_SCHEMAS = 64;
export const PROJECTION_PARITY_MAX_FILES = 64;

const IDENTIFIER = /^[a-z][a-z0-9_]{1,127}$/;
const SCHEMA_ID = /^[a-z0-9][a-z0-9._-]*\/v[1-9][0-9]*$/;
const FIXTURE_PATH = /^tests\/fixtures\/[a-z0-9][a-z0-9._-]*\.json$/;
const ADMITTED_LIFECYCLES = new Set(PROJECTION_PARITY_ADMITTED_LIFECYCLES);
const KINDS = new Set(PROJECTION_PARITY_KINDS);
const FIXED_PROTOCOL_CONTROLS = new Set(PROJECTION_PARITY_FIXED_PROTOCOL_CONTROLS);
const GUARD_ORDER = new Set(PROJECTION_PARITY_GUARD_ORDER);
const ABSENT_ROUTE_TOKENS = [...PROJECTION_PARITY_ABSENT_ROUTE_TOKENS];

function fail(code) {
  throw new Error(`${ERROR_PREFIX}_${code}`);
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

function ownKeys(value, code = "invalid_data") {
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail(code);
  }
  if (keys.some((key) => typeof key !== "string")) fail(code);
  return keys;
}

function prototypeOf(value, code = "invalid_data") {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    fail(code);
  }
}

function dataDescriptor(value, key, code = "invalid_data") {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail(code);
  }
  if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.get || descriptor.set) {
    fail(code);
  }
  return descriptor;
}

function exactKeys(value, expected, code) {
  const keys = ownKeys(value, code);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    fail(code);
  }
  for (const key of expected) dataDescriptor(value, key, code);
}

function isArray(value, code) {
  try {
    return Array.isArray(value);
  } catch {
    fail(code);
  }
}

function assertPlainJsonObject(value, code) {
  if (!isObject(value) || isArray(value, code) || prototypeOf(value, code) !== Object.prototype) {
    fail(code);
  }
}

function identifierOf(value, code) {
  if (typeof value !== "string" || value.length > PROJECTION_PARITY_MAX_IDENTIFIER_LENGTH || !IDENTIFIER.test(value)) {
    fail(code);
  }
  return value;
}

function idList(value, key, code, max) {
  const list = dataDescriptor(value, key, code).value;
  if (!isArray(list, code) || list.length === 0 || list.length > max) fail(code);
  const seen = new Set();
  for (let index = 0; index < list.length; index += 1) {
    const id = identifierOf(dataDescriptor(list, String(index), code).value, code);
    if (seen.has(id)) fail(code);
    seen.add(id);
  }
  return [...seen];
}

function boundedStringList(value, key, code, max, pattern) {
  const list = dataDescriptor(value, key, code).value;
  if (!isArray(list, code) || list.length === 0 || list.length > max) fail(code);
  const seen = new Set();
  for (let index = 0; index < list.length; index += 1) {
    const entry = dataDescriptor(list, String(index), code).value;
    if (typeof entry !== "string" || entry.length > PROJECTION_PARITY_MAX_IDENTIFIER_LENGTH || !pattern.test(entry)) {
      fail(code);
    }
    if (seen.has(entry)) fail(code);
    seen.add(entry);
  }
  return [...seen];
}

function collectStringValues(value, out, excluded = new Set()) {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (!isObject(value) || excluded.has(value)) return;
  excluded.add(value);
  for (const key of ownKeys(value)) {
    collectStringValues(dataDescriptor(value, key).value, out, excluded);
  }
}

function skipWhitespace(text, index) {
  while (index < text.length && /[\u0020\u0009\u000a\u000d]/.test(text[index])) index += 1;
  return index;
}

function parseStringEnd(text, start) {
  if (text[start] !== '"') fail("invalid_json");
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      const raw = text.slice(start, index + 1);
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        fail("invalid_json");
      }
      if (value.length > PROJECTION_PARITY_MAX_IDENTIFIER_LENGTH) fail("bounds");
      return { value, index: index + 1 };
    }
    if (character === "\\") {
      index += 1;
      if (index >= text.length || !/["\\/bfnrtu]/.test(text[index])) fail("invalid_json");
    } else if (character.charCodeAt(0) < 0x20) {
      fail("invalid_json");
    }
  }
  fail("invalid_json");
}

function scanJsonValue(text, start, depth) {
  if (depth > 8) fail("bounds");
  const index = skipWhitespace(text, start);
  const character = text[index];

  if (character === '"') return parseStringEnd(text, index).index;
  if (character === "{") {
    let cursor = skipWhitespace(text, index + 1);
    const keys = new Set();
    let count = 0;
    if (text[cursor] === "}") return cursor + 1;
    while (true) {
      if (text[cursor] !== '"') fail("invalid_json");
      const key = parseStringEnd(text, cursor);
      if (keys.has(key.value)) fail("duplicate_key");
      keys.add(key.value);
      count += 1;
      if (count > 16) fail("bounds");
      cursor = skipWhitespace(text, key.index);
      if (text[cursor] !== ":") fail("invalid_json");
      cursor = scanJsonValue(text, cursor + 1, depth + 1);
      cursor = skipWhitespace(text, cursor);
      if (text[cursor] === "}") return cursor + 1;
      if (text[cursor] !== ",") fail("invalid_json");
      cursor = skipWhitespace(text, cursor + 1);
    }
  }
  if (character === "[") {
    let cursor = skipWhitespace(text, index + 1);
    let count = 0;
    if (text[cursor] === "]") return cursor + 1;
    while (true) {
      count += 1;
      if (count > PROJECTION_PARITY_MAX_REGISTRATIONS + 1) fail("bounds");
      cursor = scanJsonValue(text, cursor, depth + 1);
      cursor = skipWhitespace(text, cursor);
      if (text[cursor] === "]") return cursor + 1;
      if (text[cursor] !== ",") fail("invalid_json");
      cursor = skipWhitespace(text, cursor + 1);
    }
  }

  const literal = /^(?:true|false|null)/.exec(text.slice(index));
  if (literal) return index + literal[0].length;
  const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
  if (number) return index + number[0].length;
  fail("invalid_json");
}

function parseJsonText(text) {
  if (typeof text !== "string") fail("invalid_json_input");
  if (Buffer.byteLength(text, "utf8") > PROJECTION_PARITY_MAX_JSON_BYTES) fail("bounds");
  const end = scanJsonValue(text, 0, 0);
  if (skipWhitespace(text, end) !== text.length) fail("invalid_json");
  try {
    return JSON.parse(text);
  } catch {
    fail("invalid_json");
  }
}

/**
 * Validate the versioned projection-parity snapshot. The snapshot is the sole
 * input; this checker never reads producers, root Host/Mod files, or tools.
 * The guard sequence below is the exact order pinned by the snapshot itself.
 */
export function validateActionProjectionParity(input) {
  const parsed = typeof input === "string" ? parseJsonText(input) : input;
  try {
    structuredClone(parsed);
  } catch {
    fail("invalid_data");
  }

  // guard: schema
  if (!isObject(parsed) || isArray(parsed, "invalid_envelope") || prototypeOf(parsed, "invalid_envelope") !== Object.prototype) {
    fail("invalid_envelope");
  }
  exactKeys(parsed, PROJECTION_PARITY_ENVELOPE_KEYS, "invalid_envelope_shape");
  const schema = dataDescriptor(parsed, "schema", "invalid_envelope_shape").value;
  if (schema !== PROJECTION_PARITY_SCHEMA) fail("invalid_schema");

  // guard: development_scope
  if (dataDescriptor(parsed, "developmentOnly", "invalid_envelope_shape").value !== true) {
    fail("invalid_scope");
  }

  // guard: game_id
  if (dataDescriptor(parsed, "gameId", "invalid_envelope_shape").value !== PROJECTION_PARITY_GAME_ID) {
    fail("invalid_game_id");
  }

  // guard: surface_registrations — registration identity/lifecycle/kind facts
  const surface = dataDescriptor(parsed, "surface", "invalid_envelope_shape").value;
  assertPlainJsonObject(surface, "invalid_surface");
  exactKeys(surface, PROJECTION_PARITY_SURFACE_KEYS, "invalid_surface_shape");
  if (dataDescriptor(surface, "schema", "invalid_surface_shape").value !== PROJECTION_PARITY_SURFACE_SCHEMA) {
    fail("invalid_surface_schema");
  }
  const registrations = dataDescriptor(surface, "registrations", "invalid_surface_shape").value;
  if (!isArray(registrations, "invalid_registrations") || registrations.length === 0 || registrations.length > PROJECTION_PARITY_MAX_REGISTRATIONS) {
    fail("bounds");
  }
  const seenActionIds = new Set();
  const normalizedRegistrations = registrations.map((registration) => {
    assertPlainJsonObject(registration, "invalid_registration");
    exactKeys(registration, PROJECTION_PARITY_REGISTRATION_KEYS, "invalid_registration_shape");
    const actionId = identifierOf(dataDescriptor(registration, "actionId", "invalid_registration_shape").value, "invalid_action_id");
    const familyId = identifierOf(dataDescriptor(registration, "familyId", "invalid_registration_shape").value, "invalid_family_id");
    const identityVersion = dataDescriptor(registration, "identityVersion", "invalid_registration_shape").value;
    const lifecycle = dataDescriptor(registration, "lifecycle", "invalid_registration_shape").value;
    const kind = dataDescriptor(registration, "kind", "invalid_registration_shape").value;
    if (seenActionIds.has(actionId)) fail("duplicate_action_id");
    seenActionIds.add(actionId);
    if (!Number.isSafeInteger(identityVersion) || identityVersion < 1 || identityVersion > PROJECTION_PARITY_MAX_IDENTITY_VERSION) {
      fail("invalid_identity_version");
    }
    if (typeof lifecycle !== "string" || !ADMITTED_LIFECYCLES.has(lifecycle)) fail("invalid_lifecycle");
    if (typeof kind !== "string" || !KINDS.has(kind)) fail("invalid_kind");
    return Object.freeze({ actionId, familyId, identityVersion, lifecycle, kind });
  });
  const registrationById = new Map(normalizedRegistrations.map((registration) => [registration.actionId, registration]));

  // guard: lifecycle_partition — published-vs-withdrawn as an exact partition
  const lifecycle = dataDescriptor(parsed, "lifecycle", "invalid_envelope_shape").value;
  assertPlainJsonObject(lifecycle, "invalid_lifecycle_facts");
  exactKeys(lifecycle, PROJECTION_PARITY_LIFECYCLE_KEYS, "invalid_lifecycle_shape");
  const admitted = dataDescriptor(lifecycle, "admittedLifecycles", "invalid_lifecycle_shape").value;
  if (!isArray(admitted, "invalid_lifecycle_shape") || admitted.length !== PROJECTION_PARITY_ADMITTED_LIFECYCLES.length || PROJECTION_PARITY_ADMITTED_LIFECYCLES.some((value, index) => admitted[index] !== value)) {
    fail("invalid_admitted_lifecycles");
  }
  const executableIds = idList(lifecycle, "executableActionIds", "invalid_lifecycle_shape", PROJECTION_PARITY_MAX_IDS);
  const readOnlyIds = idList(lifecycle, "readOnlyActionIds", "invalid_lifecycle_shape", PROJECTION_PARITY_MAX_IDS);
  const experimentalIds = idList(lifecycle, "experimentalActionIds", "invalid_lifecycle_shape", PROJECTION_PARITY_MAX_IDS);
  const lifecycleIds = new Set([...executableIds, ...readOnlyIds, ...experimentalIds]);
  if (lifecycleIds.size !== executableIds.length + readOnlyIds.length + experimentalIds.length) {
    fail("lifecycle_overlap");
  }
  if (lifecycleIds.size !== registrationById.size) fail("lifecycle_partition_mismatch");
  for (const actionId of registrationById.keys()) {
    if (!lifecycleIds.has(actionId)) fail("lifecycle_partition_mismatch");
  }

  // guard: surface_subsets — each subset matches registration identity facts
  for (const actionId of executableIds) {
    const registration = registrationById.get(actionId);
    if (registration.lifecycle !== "published" || registration.kind !== "execution") {
      fail("executable_subset_invalid");
    }
  }
  for (const actionId of readOnlyIds) {
    const registration = registrationById.get(actionId);
    if (registration.lifecycle !== "published" || registration.kind !== "read_only") {
      fail("readonly_subset_invalid");
    }
  }
  for (const actionId of experimentalIds) {
    if (registrationById.get(actionId).lifecycle !== "experimental") fail("experimental_subset_invalid");
  }

  // guard: protocol_union — sorted unique schema-id union, format-bounded
  const protocol = dataDescriptor(parsed, "protocol", "invalid_envelope_shape").value;
  assertPlainJsonObject(protocol, "invalid_protocol");
  exactKeys(protocol, PROJECTION_PARITY_PROTOCOL_KEYS, "invalid_protocol_shape");
  const schemas = boundedStringList(protocol, "schemas", "invalid_protocol_shape", PROJECTION_PARITY_MAX_SCHEMAS, SCHEMA_ID);
  for (let index = 1; index < schemas.length; index += 1) {
    if (schemas[index - 1] >= schemas[index]) fail("protocol_union_unsorted");
  }

  // guard: protocol_controls — fixed control IDs are pinned and never registrations
  const fixedControls = dataDescriptor(protocol, "fixedControls", "invalid_protocol_shape").value;
  if (!isArray(fixedControls, "invalid_protocol_shape") || fixedControls.length !== PROJECTION_PARITY_FIXED_PROTOCOL_CONTROLS.length || PROJECTION_PARITY_FIXED_PROTOCOL_CONTROLS.some((value, index) => fixedControls[index] !== value)) {
    fail("invalid_fixed_controls");
  }
  for (const controlId of PROJECTION_PARITY_FIXED_PROTOCOL_CONTROLS) {
    if (registrationById.has(controlId)) fail("control_in_surface");
  }

  // guard: ownership_partition — native-local runner and fixture ownership
  const ownership = dataDescriptor(parsed, "ownership", "invalid_envelope_shape").value;
  assertPlainJsonObject(ownership, "invalid_ownership");
  exactKeys(ownership, PROJECTION_PARITY_OWNERSHIP_KEYS, "invalid_ownership_shape");
  const localFixtureOwnedIds = idList(ownership, "localFixtureOwnedActionIds", "invalid_ownership_shape", PROJECTION_PARITY_MAX_IDS);
  const nativeIds = idList(ownership, "nativeActionIds", "invalid_ownership_shape", PROJECTION_PARITY_MAX_IDS);
  const executableSet = new Set(executableIds);
  const nativeSet = new Set(nativeIds);
  for (const actionId of localFixtureOwnedIds) {
    if (!executableSet.has(actionId)) fail("local_ownership_widened");
    if (nativeSet.has(actionId)) fail("ownership_overlap");
  }
  if (nativeSet.size + localFixtureOwnedIds.length !== executableIds.length) fail("ownership_partition_mismatch");
  for (const actionId of executableIds) {
    if (!nativeSet.has(actionId) && !localFixtureOwnedIds.includes(actionId)) fail("ownership_partition_mismatch");
  }
  const fixtureOwnedFiles = boundedStringList(parsed, "fixtureOwnedFiles", "invalid_envelope_shape", PROJECTION_PARITY_MAX_FILES, FIXTURE_PATH);

  // guard: guard_order_pinned — the snapshot pins this exact ordered guard sequence
  const guardOrder = dataDescriptor(parsed, "guardOrder", "invalid_envelope_shape").value;
  if (!isArray(guardOrder, "invalid_guard_order") || guardOrder.length !== PROJECTION_PARITY_GUARD_ORDER.length || PROJECTION_PARITY_GUARD_ORDER.some((value, index) => guardOrder[index] !== value)) {
    fail("guard_order_drift");
  }
  if (GUARD_ORDER.size !== PROJECTION_PARITY_GUARD_ORDER.length) fail("guard_order_drift");

  // guard: obsolete_route_absence — absent routes are pinned and never values
  const absentRoutes = dataDescriptor(parsed, "absentRoutes", "invalid_envelope_shape").value;
  if (!isArray(absentRoutes, "invalid_absent_routes") || absentRoutes.length !== ABSENT_ROUTE_TOKENS.length || ABSENT_ROUTE_TOKENS.some((value, index) => absentRoutes[index] !== value)) {
    fail("obsolete_route_drift");
  }
  const values = [];
  collectStringValues(parsed, values, new Set([absentRoutes]));
  for (const value of values) {
    const lowered = value.toLowerCase();
    for (const token of ABSENT_ROUTE_TOKENS) {
      if (lowered.includes(token)) fail("obsolete_route_present");
    }
  }

  return Object.freeze({
    schema: PROJECTION_PARITY_SCHEMA,
    developmentOnly: true,
    gameId: PROJECTION_PARITY_GAME_ID,
    surface: Object.freeze({
      schema: PROJECTION_PARITY_SURFACE_SCHEMA,
      registrations: Object.freeze(normalizedRegistrations),
    }),
    lifecycle: Object.freeze({
      admittedLifecycles: Object.freeze([...PROJECTION_PARITY_ADMITTED_LIFECYCLES]),
      executableActionIds: Object.freeze(executableIds),
      readOnlyActionIds: Object.freeze(readOnlyIds),
      experimentalActionIds: Object.freeze(experimentalIds),
    }),
    protocol: Object.freeze({
      schemas: Object.freeze(schemas),
      fixedControls: Object.freeze([...PROJECTION_PARITY_FIXED_PROTOCOL_CONTROLS]),
    }),
    ownership: Object.freeze({
      localFixtureOwnedActionIds: Object.freeze(localFixtureOwnedIds),
      nativeActionIds: Object.freeze(nativeIds),
    }),
    fixtureOwnedFiles: Object.freeze(fixtureOwnedFiles),
    guardOrder: Object.freeze([...PROJECTION_PARITY_GUARD_ORDER]),
    absentRoutes: Object.freeze([...ABSENT_ROUTE_TOKENS]),
  });
}

export function parseActionProjectionParity(text) {
  return validateActionProjectionParity(parseJsonText(text));
}