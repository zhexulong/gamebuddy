const ERROR_PREFIX = "stardew_static_projection";

export const STATIC_PROJECTION_SCHEMA = "gamebuddy-stardew-static-action-projection/v1";
export const STATIC_PROJECTION_GAME_ID = "stardew";
export const STATIC_PROJECTION_ENVELOPE_KEYS = Object.freeze([
  "schema",
  "developmentOnly",
  "gameId",
  "actions",
]);
export const STATIC_PROJECTION_ACTION_KEYS = Object.freeze([
  "actionId",
  "kind",
  "lifecycle",
  "advertised",
  "executable",
]);
export const STATIC_PROJECTION_FIXED_PROTOCOL_CONTROL_IDS = Object.freeze([
  "inspect_self",
  "cancel_active_execution",
]);
export const STATIC_PROJECTION_MAX_JSON_BYTES = 64 * 1024;
export const STATIC_PROJECTION_MAX_ACTIONS = 128;
export const STATIC_PROJECTION_MAX_ACTION_ID_LENGTH = 128;

const ACTION_ID = /^[a-z][a-z0-9_]{1,127}$/;
const ACTION_KINDS = new Set(["execution", "read_only"]);
const ACTION_LIFECYCLES = new Set(["published"]);
const FIXED_PROTOCOL_CONTROLS = new Set(
  STATIC_PROJECTION_FIXED_PROTOCOL_CONTROL_IDS,
);
const FORBIDDEN_KEY = /(?:secret|raw|endpoint|token|credential|password|url|pipe|socket|host|port)/i;
const FORBIDDEN_VALUE = /(?:https?:\/\/|wss?:\/\/|file:\/\/|\\\\|(?:^|[^a-z0-9])(?:secret|raw|endpoint|token|credential|password|url|pipe|socket)(?:$|[^a-z0-9]))/i;
const MAX_DATA_DEPTH = 16;
const MAX_DATA_NODES = 2048;
const MAX_STRING_LENGTH = 256;
const MAX_ARRAY_ITEMS = 128;
const MAX_OBJECT_KEYS = 16;

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

function descriptorOf(value, key, code = "invalid_data") {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail(code);
  }
  if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) {
    fail(code);
  }
  return descriptor;
}

function isArray(value, code) {
  try {
    return Array.isArray(value);
  } catch {
    fail(code);
  }
}

function isFrozen(value, code) {
  try {
    return Object.isFrozen(value);
  } catch {
    fail(code);
  }
}

function isSet(value, code) {
  try {
    return value instanceof Set;
  } catch {
    fail(code);
  }
}

function assertPlainJsonData(value, state = { active: new Set(), nodes: 0 }, depth = 0) {
  if (depth > MAX_DATA_DEPTH) fail("bounds");

  if (value === null) return;
  switch (typeof value) {
    case "string":
      if (value.length > MAX_STRING_LENGTH) fail("bounds");
      return;
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) fail("invalid_data");
      return;
    case "object":
      break;
    default:
      fail("invalid_data");
  }

  state.nodes += 1;
  if (state.nodes > MAX_DATA_NODES) fail("bounds");
  if (state.active.has(value)) fail("cyclic_data");
  state.active.add(value);

  try {
    const prototype = prototypeOf(value);
    const keys = ownKeys(value);
    if (isArray(value, "invalid_data")) {
      if (prototype !== Array.prototype || keys.length > MAX_ARRAY_ITEMS + 1) {
        fail("invalid_data");
      }
      if (!Number.isSafeInteger(value.length) || value.length > MAX_ARRAY_ITEMS) {
        fail("bounds");
      }
      if (keys.length !== value.length + 1 || !keys.includes("length")) {
        fail("invalid_data");
      }
      descriptorOf(value, "length");
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        if (!keys.includes(key)) fail("invalid_data");
        const descriptor = descriptorOf(value, key);
        if (!descriptor.enumerable) fail("invalid_data");
        assertPlainJsonData(descriptor.value, state, depth + 1);
      }
    } else {
      if (prototype !== Object.prototype || keys.length > MAX_OBJECT_KEYS) {
        fail("invalid_data");
      }
      for (const key of keys) {
        const descriptor = descriptorOf(value, key);
        if (!descriptor.enumerable) fail("invalid_data");
        assertPlainJsonData(descriptor.value, state, depth + 1);
      }
    }
  } finally {
    state.active.delete(value);
  }

  // A proxy can satisfy ordinary prototype checks while still changing what a
  // later read observes. It must not cross this data-only boundary. Cloning is
  // also a final rejection for host objects, functions, symbols, and cycles.
  try {
    structuredClone(value);
  } catch {
    fail("invalid_data");
  }
}

function exactKeys(value, expected, code) {
  const keys = ownKeys(value, code);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    fail(code);
  }
  for (const key of expected) descriptorOf(value, key, code);
}

function rejectForbiddenContent(value, active = new Set()) {
  if (typeof value === "string") {
    if (FORBIDDEN_VALUE.test(value)) fail("forbidden_content");
    return;
  }
  if (!isObject(value)) return;
  if (active.has(value)) fail("cyclic_data");
  active.add(value);
  try {
    for (const key of ownKeys(value)) {
      if (FORBIDDEN_KEY.test(key)) fail("forbidden_field");
      const descriptor = descriptorOf(value, key);
      rejectForbiddenContent(descriptor.value, active);
    }
  } finally {
    active.delete(value);
  }
}

function skipWhitespace(text, index) {
  while (index < text.length && /[\u0020\u0009\u000a\u000d]/.test(text[index])) index += 1;
  return index;
}

function parseStringEnd(text, start) {
  if (text[start] !== '"') fail("invalid_json");
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      const raw = text.slice(start, index + 1);
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        fail("invalid_json");
      }
      if (value.length > MAX_STRING_LENGTH) fail("bounds");
      return { value, index: index + 1 };
    }
  }
  fail("invalid_json");
}

function scanJsonValue(text, start, depth) {
  if (depth > MAX_DATA_DEPTH) fail("bounds");
  const index = skipWhitespace(text, start);
  const character = text[index];

  if (character === '"') return parseStringEnd(text, index).index;
  if (character === "{") {
    let cursor = skipWhitespace(text, index + 1);
    const keys = new Set();
    let count = 0;
    if (text[cursor] === "}") return cursor + 1;
    while (true) {
      const key = parseStringEnd(text, cursor);
      if (keys.has(key.value)) fail("duplicate_key");
      keys.add(key.value);
      count += 1;
      if (count > MAX_OBJECT_KEYS) fail("bounds");
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
      if (count > MAX_ARRAY_ITEMS) fail("bounds");
      cursor = scanJsonValue(text, cursor, depth + 1);
      cursor = skipWhitespace(text, cursor);
      if (text[cursor] === "]") return cursor + 1;
      if (text[cursor] !== ",") fail("invalid_json");
      cursor = skipWhitespace(text, cursor + 1);
    }
  }

  const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
    text.slice(index),
  );
  if (!literal) fail("invalid_json");
  return index + literal[0].length;
}

function parseJsonText(text) {
  if (typeof text !== "string") fail("invalid_json_input");
  if (Buffer.byteLength(text, "utf8") > STATIC_PROJECTION_MAX_JSON_BYTES) fail("bounds");
  const end = scanJsonValue(text, 0, 0);
  if (skipWhitespace(text, end) !== text.length) fail("invalid_json");
  try {
    return JSON.parse(text);
  } catch {
    fail("invalid_json");
  }
}

function validateAllowedActionIds(options) {
  if (!isObject(options) || isArray(options, "invalid_options") || prototypeOf(options, "invalid_options") !== Object.prototype) {
    fail("invalid_options");
  }
  // Inspect descriptors before cloning so accessors are rejected without
  // invoking them. Cloning then rejects proxies that impersonate plain data.
  exactKeys(options, ["allowedActionIds"], "invalid_options_shape");
  try {
    structuredClone(options);
  } catch {
    fail("invalid_options");
  }
  const allowed = descriptorOf(options, "allowedActionIds", "invalid_options_shape").value;
  let ids;
  if (isArray(allowed, "invalid_allowed_action_ids")) {
    if (!isFrozen(allowed, "invalid_allowed_action_ids")) fail("invalid_allowed_action_ids");
    assertPlainJsonData(allowed);
    ids = [...allowed];
  } else if (isSet(allowed, "invalid_allowed_action_ids")) {
    if (prototypeOf(allowed, "invalid_allowed_action_ids") !== Set.prototype || !isFrozen(allowed, "invalid_allowed_action_ids")) {
      fail("invalid_allowed_action_ids");
    }
    if (ownKeys(allowed, "invalid_allowed_action_ids").length !== 0) {
      fail("invalid_allowed_action_ids");
    }
    try {
      ids = [...Set.prototype.values.call(allowed)];
    } catch {
      fail("invalid_allowed_action_ids");
    }
  } else {
    fail("invalid_allowed_action_ids");
  }

  if (ids.length > STATIC_PROJECTION_MAX_ACTIONS) fail("bounds");
  const seen = new Set();
  for (const actionId of ids) {
    if (typeof actionId !== "string" || !ACTION_ID.test(actionId) || FORBIDDEN_VALUE.test(actionId)) {
      fail("invalid_allowed_action_ids");
    }
    if (seen.has(actionId)) fail("invalid_allowed_action_ids");
    seen.add(actionId);
  }
  return seen;
}

function validateActionDescriptor(action, allowedActionIds, seenActionIds) {
  if (!isObject(action) || isArray(action, "invalid_action") || prototypeOf(action) !== Object.prototype) {
    fail("invalid_action");
  }
  exactKeys(action, STATIC_PROJECTION_ACTION_KEYS, "invalid_action_shape");

  if (typeof action.actionId !== "string" || !ACTION_ID.test(action.actionId)) {
    fail("invalid_action_id");
  }
  if (seenActionIds.has(action.actionId)) fail("duplicate_action_id");
  seenActionIds.add(action.actionId);
  if (!allowedActionIds.has(action.actionId)) fail("action_not_allowed");
  if (typeof action.kind !== "string" || !ACTION_KINDS.has(action.kind)) fail("invalid_kind");
  if (typeof action.lifecycle !== "string" || !ACTION_LIFECYCLES.has(action.lifecycle)) {
    fail("invalid_lifecycle");
  }
  if (typeof action.advertised !== "boolean") fail("invalid_advertised");
  if (typeof action.executable !== "boolean") fail("invalid_executable");

  const isControl = FIXED_PROTOCOL_CONTROLS.has(action.actionId);
  if (isControl && action.executable) fail("control_executable");
  if (action.kind === "read_only" && action.executable) fail("readonly_executable");
  if (isControl && action.kind !== "read_only") fail("control_kind");
  if (action.kind === "execution" && action.executable && !action.advertised) {
    fail("execution_not_advertised");
  }

  return Object.freeze({
    actionId: action.actionId,
    kind: action.kind,
    lifecycle: action.lifecycle,
    advertised: action.advertised,
    executable: action.executable,
  });
}

/**
 * Validate a development-only descriptor snapshot supplied as JSON text or as
 * plain parsed JSON data. `allowedActionIds` is deliberately caller-owned and
 * must be supplied as a frozen array or frozen Set; the snapshot cannot add to
 * or replace that restrictive set.
 */
export function validateStaticActionDescriptorSnapshot(input, options) {
  const parsed = typeof input === "string" ? parseJsonText(input) : input;
  assertPlainJsonData(parsed);
  rejectForbiddenContent(parsed);

  const allowedActionIds = validateAllowedActionIds(options);
  if (!isObject(parsed) || isArray(parsed, "invalid_envelope") || prototypeOf(parsed) !== Object.prototype) {
    fail("invalid_envelope");
  }
  exactKeys(parsed, STATIC_PROJECTION_ENVELOPE_KEYS, "invalid_envelope_shape");
  if (parsed.schema !== STATIC_PROJECTION_SCHEMA) fail("invalid_schema");
  if (parsed.developmentOnly !== true) fail("invalid_scope");
  if (parsed.gameId !== STATIC_PROJECTION_GAME_ID) fail("invalid_game_id");
  if (!isArray(parsed.actions, "invalid_actions")) fail("invalid_actions");
  if (parsed.actions.length > STATIC_PROJECTION_MAX_ACTIONS) fail("bounds");

  const seenActionIds = new Set();
  const actions = parsed.actions.map((action) =>
    validateActionDescriptor(action, allowedActionIds, seenActionIds),
  );
  return Object.freeze({
    schema: STATIC_PROJECTION_SCHEMA,
    developmentOnly: true,
    gameId: STATIC_PROJECTION_GAME_ID,
    actions: Object.freeze(actions),
  });
}

export function parseStaticActionDescriptorSnapshot(text, options) {
  if (typeof text !== "string") fail("invalid_json_input");
  return validateStaticActionDescriptorSnapshot(text, options);
}
