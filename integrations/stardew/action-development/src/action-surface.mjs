const ERROR_PREFIX = "stardew_action_surface";

export const ACTION_SURFACE_SCHEMA = "gamebuddy-action-descriptors/v1";
export const ACTION_SURFACE_ENVELOPE_KEYS = Object.freeze([
  "schema",
  "catalogRevision",
  "actions",
]);
export const ACTION_SURFACE_ACTION_KEYS = Object.freeze([
  "actionId",
  "identityVersion",
  "argumentSchema",
  "outputFacts",
  "resourceTemplate",
  "effect",
  "postcondition",
  "lifecycle",
  "kind",
]);
export const ACTION_SURFACE_MAX_JSON_BYTES = 64 * 1024;
export const ACTION_SURFACE_MAX_REGISTRATIONS = 128;
export const ACTION_SURFACE_MAX_IDENTIFIER_LENGTH = 128;
export const ACTION_SURFACE_MAX_IDENTITY_VERSION = 2_147_483_647;
export const ACTION_SURFACE_MAX_JSON_DEPTH = 8;
export const ACTION_SURFACE_MAX_DATA_NODES = 2048;
export const ACTION_SURFACE_MAX_OBJECT_KEYS = 16;
export const ACTION_SURFACE_MAX_ARRAY_ITEMS = 128;

const IDENTIFIER = /^[a-z][a-z0-9_]{1,127}$/;
const LIFECYCLES = new Set(["published", "experimental"]);
const KINDS = new Set(["execution", "read_only"]);
const DYNAMIC_PUBLICATION_FIELDS = new Set([
  "advertised",
  "available",
  "capabilities",
  "catalogRevision",
  "enabled",
  "enabledActionIds",
  "executable",
  "launchGeneration",
  "publicationRevision",
  "publishedAt",
  "revision",
  "runtimeRole",
  "scope",
  "sessionId",
  "timestampMs",
]);

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

function isArray(value, code = "invalid_data") {
  try {
    return Array.isArray(value);
  } catch {
    fail(code);
  }
}

function assertPlainJsonData(value, state = { active: new Set(), nodes: 0 }, depth = 0) {
  if (depth > ACTION_SURFACE_MAX_JSON_DEPTH) fail("bounds");

  if (value === null) return;
  switch (typeof value) {
    case "string":
      if (value.length > ACTION_SURFACE_MAX_IDENTIFIER_LENGTH) fail("bounds");
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
  if (state.nodes > ACTION_SURFACE_MAX_DATA_NODES) fail("bounds");
  if (state.active.has(value)) fail("cyclic_data");
  state.active.add(value);

  try {
    const prototype = prototypeOf(value);
    const keys = ownKeys(value);
    if (isArray(value)) {
      if (prototype !== Array.prototype) fail("invalid_data");
      if (keys.length > ACTION_SURFACE_MAX_ARRAY_ITEMS + 1) fail("bounds");
      if (!Number.isSafeInteger(value.length) || value.length > ACTION_SURFACE_MAX_ARRAY_ITEMS) {
        fail("bounds");
      }
      if (keys.length !== value.length + 1 || !keys.includes("length")) fail("invalid_data");
      dataDescriptor(value, "length");
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        if (!keys.includes(key)) fail("invalid_data");
        const descriptor = dataDescriptor(value, key);
        if (!descriptor.enumerable) fail("invalid_data");
        assertPlainJsonData(descriptor.value, state, depth + 1);
      }
    } else {
      if (prototype !== Object.prototype) fail("invalid_data");
      if (keys.length > ACTION_SURFACE_MAX_OBJECT_KEYS) fail("bounds");
      for (const key of keys) {
        const descriptor = dataDescriptor(value, key);
        if (!descriptor.enumerable) fail("invalid_data");
        assertPlainJsonData(descriptor.value, state, depth + 1);
      }
    }
  } finally {
    state.active.delete(value);
  }

  // A plain-looking proxy is not safe to consume as a static value. Cloning
  // rejects proxies and other host values without invoking application code.
  try {
    structuredClone(value);
  } catch {
    fail("invalid_data");
  }
}

function exactKeys(value, expected, location) {
  const keys = ownKeys(value, `invalid_${location}_shape`);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    const unknown = keys.find((key) => !expected.includes(key));
    if (typeof unknown === "string" && DYNAMIC_PUBLICATION_FIELDS.has(unknown)) {
      fail("dynamic_publication_field");
    }
    fail(`invalid_${location}_shape`);
  }
  for (const key of expected) dataDescriptor(value, key, `invalid_${location}_shape`);
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
      if (value.length > ACTION_SURFACE_MAX_IDENTIFIER_LENGTH) fail("bounds");
      return { value, index: index + 1 };
    }
    if (character === "\\") {
      index += 1;
      if (index >= text.length) fail("invalid_json");
      if (text[index] === "u") {
        if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) fail("invalid_json");
        index += 4;
      } else if (!/["\\/bfnrt]/.test(text[index])) {
        fail("invalid_json");
      }
      continue;
    }
    if (character.charCodeAt(0) < 0x20) fail("invalid_json");
  }
  fail("invalid_json");
}

function scanJsonValue(text, start, depth) {
  if (depth > ACTION_SURFACE_MAX_JSON_DEPTH) fail("bounds");
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
      if (count > ACTION_SURFACE_MAX_OBJECT_KEYS) fail("bounds");
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
      if (count > ACTION_SURFACE_MAX_ARRAY_ITEMS) fail("bounds");
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
  if (Buffer.byteLength(text, "utf8") > ACTION_SURFACE_MAX_JSON_BYTES) fail("bounds");
  const end = scanJsonValue(text, 0, 0);
  if (skipWhitespace(text, end) !== text.length) fail("invalid_json");
  try {
    return JSON.parse(text);
  } catch {
    fail("invalid_json");
  }
}

function validateIdentifier(value, code) {
  if (typeof value !== "string" || value.length > ACTION_SURFACE_MAX_IDENTIFIER_LENGTH || !IDENTIFIER.test(value)) {
    fail(code);
  }
  return value;
}

function validateAction(value, seenActionIds) {
  if (!isObject(value) || isArray(value) || prototypeOf(value) !== Object.prototype) {
    fail("invalid_action");
  }
  exactKeys(value, ACTION_SURFACE_ACTION_KEYS, "action");

  const actionId = validateIdentifier(dataDescriptor(value, "actionId").value, "invalid_action_id");
  const identityVersion = dataDescriptor(value, "identityVersion").value;
  const lifecycle = dataDescriptor(value, "lifecycle").value;
  const kind = dataDescriptor(value, "kind").value;

  if (seenActionIds.has(actionId)) fail("duplicate_action_id");
  seenActionIds.add(actionId);

  const argumentSchema = dataDescriptor(value, "argumentSchema").value;
  const outputFacts = dataDescriptor(value, "outputFacts").value;
  const resourceTemplate = dataDescriptor(value, "resourceTemplate").value;
  const effect = dataDescriptor(value, "effect").value;
  const postcondition = dataDescriptor(value, "postcondition").value;
  if (!isObject(argumentSchema) || isArray(argumentSchema) || !isObject(outputFacts) || isArray(outputFacts)
    || !isObject(resourceTemplate) || isArray(resourceTemplate) || !isObject(postcondition) || isArray(postcondition)
    || !Array.isArray(resourceTemplate.claims) || resourceTemplate.claims.length > ACTION_SURFACE_MAX_ARRAY_ITEMS
    || resourceTemplate.claims.some((claim) => !isObject(claim) || isArray(claim)
      || ownKeys(claim).length !== 2 || !ownKeys(claim).includes("key") || !ownKeys(claim).includes("value")
      || typeof dataDescriptor(claim, "key").value !== "string" || typeof dataDescriptor(claim, "value").value !== "string")
    || (effect !== "read" && effect !== "write") || typeof postcondition.name !== "string") {
    fail("invalid_action");
  }
  if (
    !Number.isSafeInteger(identityVersion)
    || identityVersion < 1
    || identityVersion > ACTION_SURFACE_MAX_IDENTITY_VERSION
  ) {
    fail("invalid_identity_version");
  }
  if (typeof lifecycle !== "string" || !LIFECYCLES.has(lifecycle)) fail("invalid_lifecycle");
  if (typeof kind !== "string" || !KINDS.has(kind)) fail("invalid_kind");

  return Object.freeze({ actionId, identityVersion, lifecycle, kind, argumentSchema, outputFacts, resourceTemplate, effect, postcondition });
}

/**
 * Validate a plain parsed action-surface artifact. The result is a fresh,
 * immutable consumer view; it is never an authority or a publication input.
 */
export function validateActionSurface(input) {
  assertPlainJsonData(input);
  if (!isObject(input) || isArray(input) || prototypeOf(input) !== Object.prototype) {
    fail("invalid_envelope");
  }
  exactKeys(input, ACTION_SURFACE_ENVELOPE_KEYS, "envelope");

  const schema = dataDescriptor(input, "schema").value;
  const catalogRevision = dataDescriptor(input, "catalogRevision").value;
  const actions = dataDescriptor(input, "actions").value;
  if (schema !== ACTION_SURFACE_SCHEMA) fail("invalid_schema");
  if (!Number.isSafeInteger(catalogRevision) || catalogRevision < 0) fail("invalid_catalog_revision");
  if (!isArray(actions)) fail("invalid_actions");
  if (actions.length === 0 || actions.length > ACTION_SURFACE_MAX_REGISTRATIONS) {
    fail("bounds");
  }

  const seenActionIds = new Set();
  const validatedActions = actions.map((action) => validateAction(action, seenActionIds));

  return Object.freeze({
    schema: ACTION_SURFACE_SCHEMA,
    catalogRevision,
    actions: Object.freeze(validatedActions),
  });
}

/** Parse and validate JSON text, including duplicate-key rejection. */
export function parseActionSurface(text) {
  return validateActionSurface(parseJsonText(text));
}

export const parseActionSurfaceJson = parseActionSurface;

export function isActionSurfaceIdentifier(value) {
  return typeof value === "string" && value.length <= ACTION_SURFACE_MAX_IDENTIFIER_LENGTH && IDENTIFIER.test(value);
}

export function actionSurfaceErrorCode(error) {
  if (!(error instanceof Error)) return null;
  const match = new RegExp(`^${ERROR_PREFIX}_(.+)$`).exec(error.message);
  return match?.[1] ?? null;
}
