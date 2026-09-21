import { deepFreeze, isPlainDataObject } from "./model.mjs";

const DESCRIPTOR_KEYS = new Set(["actionId", "identityVersion", "lifecycle", "kind", "argumentSchema", "outputFacts", "resourceTemplate", "effect", "postcondition"]);
const PROJECTION_KEYS = new Set(["schema", "catalogRevision", "actions"]);
const ARGUMENT_SCHEMA_KEYS = new Set(["type"]);
const RESOURCE_TEMPLATE_KEYS = new Set(["claims"]);
const RESOURCE_CLAIM_KEYS = new Set(["key", "value"]);
const POSTCONDITION_KEYS = new Set(["name"]);
const VALUE_TYPES = new Set(["string", "integer", "boolean", "object", "destination_selector", "destination_arrival"]);
const LIFECYCLES = new Set(["published", "experimental"]);
const KINDS = new Set(["execution", "read_only"]);
const EFFECTS = new Set(["read", "write"]);
const RESOURCE_TEMPLATE_VALUES = new Set(["ScopePlayer"]);
const MAX_ACTIONS = 128;
const MAX_ARGUMENTS = 32;
const MAX_FACTS = 32;
const MAX_RESOURCE_CLAIMS = 16;
const MAX_IDENTITY_VERSION = 2_147_483_647;
const MAX_STRING_LENGTH = 128;
const IDENTIFIER = /^[a-z][a-z0-9_]{1,127}$/;
// Argument names are producer-owned and may use the published camelCase spelling.
const ARGUMENT_IDENTIFIER = /^[a-z][A-Za-z0-9_]{0,127}$/;
const INVALID = Symbol("invalid_descriptor_value");

export function validateDescriptorProjection(projection) {
  try {
    if (!isPlainDataObject(projection) || !sameKeys(projection, PROJECTION_KEYS)) return false;
    const schema = ownValue(projection, "schema");
    const catalogRevision = ownValue(projection, "catalogRevision");
    const actions = ownValue(projection, "actions");
    if (schema !== "gamebuddy-action-descriptors/v1"
      || !Number.isSafeInteger(catalogRevision) || catalogRevision < 0
      || !isDenseArray(actions, MAX_ACTIONS)) return false;

    const ids = new Set();
    for (let index = 0; index < actions.length; index += 1) {
      const descriptor = ownValue(actions, String(index));
      if (descriptor === INVALID || !isValidDescriptor(descriptor)) return false;
      const actionId = ownValue(descriptor, "actionId");
      if (ids.has(actionId)) return false;
      ids.add(actionId);
    }
    return cloneable(projection);
  } catch {
    return false;
  }
}

/**
 * Return a detached, read-only consumer view of the validated projection.
 * The Mod projection remains the authority; this map cannot be used to publish
 * new actions or mutate the producer's descriptor objects.
 */
export function descriptorMap(projection) {
  try {
    if (!validateDescriptorProjection(projection)) return null;

    const detached = structuredClone(projection);
    const target = new Map(detached.actions.map((descriptor) => [descriptor.actionId, deepFreeze(descriptor)]));
    const readMethods = new Map([
      ["get", Map.prototype.get.bind(target)],
      ["has", Map.prototype.has.bind(target)],
      ["entries", Map.prototype.entries.bind(target)],
      ["keys", Map.prototype.keys.bind(target)],
      ["values", Map.prototype.values.bind(target)],
    ]);
    readMethods.set(Symbol.iterator, readMethods.get("entries"));
    let view;
    const forEach = (callback, thisArg) => {
      if (typeof callback !== "function") throw new TypeError("callback_must_be_callable");
      target.forEach((value, key) => callback.call(thisArg, value, key, view));
    };
    const methods = new Map(readMethods);
    methods.set("forEach", forEach);
    view = new Proxy(target, {
      get(map, property) {
        if (property === "set" || property === "delete" || property === "clear") return readOnlyMapMutation;
        if (property === "size") return map.size;
        if (methods.has(property)) return methods.get(property);
        return Reflect.get(map, property, map);
      },
    });
    Object.freeze(target);
    return Object.freeze(view);
  } catch {
    return null;
  }
}

function isValidDescriptor(descriptor) {
  if (!isPlainDataObject(descriptor) || !sameKeys(descriptor, DESCRIPTOR_KEYS)) return false;
  const actionId = ownValue(descriptor, "actionId");
  const identityVersion = ownValue(descriptor, "identityVersion");
  const lifecycle = ownValue(descriptor, "lifecycle");
  const kind = ownValue(descriptor, "kind");
  const argumentSchema = ownValue(descriptor, "argumentSchema");
  const outputFacts = ownValue(descriptor, "outputFacts");
  const resourceTemplate = ownValue(descriptor, "resourceTemplate");
  const effect = ownValue(descriptor, "effect");
  const postcondition = ownValue(descriptor, "postcondition");
  return typeof actionId === "string" && IDENTIFIER.test(actionId)
    && Number.isSafeInteger(identityVersion) && identityVersion >= 1
    && identityVersion <= MAX_IDENTITY_VERSION
    && LIFECYCLES.has(lifecycle)
    && KINDS.has(kind)
    && validArgumentSchema(argumentSchema)
    && validOutputFacts(outputFacts)
    && validResourceTemplate(resourceTemplate)
    && EFFECTS.has(effect)
    && validPostcondition(postcondition);
}

function validArgumentSchema(value) {
  const keys = dataKeys(value);
  return keys !== null && keys.length <= MAX_ARGUMENTS
    && keys.every((key) => ARGUMENT_IDENTIFIER.test(key))
    && keys.every((key) => {
      const entry = ownValue(value, key);
      const type = ownValue(entry, "type");
      return entry !== INVALID && isPlainDataObject(entry)
        && sameKeys(entry, ARGUMENT_SCHEMA_KEYS) && VALUE_TYPES.has(type);
    });
}

function validOutputFacts(value) {
  const keys = dataKeys(value);
  return keys !== null && keys.length <= MAX_FACTS
    && keys.every((key) => IDENTIFIER.test(key))
    && keys.every((key) => {
      const type = ownValue(value, key);
      return type !== INVALID && VALUE_TYPES.has(type);
    });
}

function validResourceTemplate(value) {
  if (!isPlainDataObject(value) || !sameKeys(value, RESOURCE_TEMPLATE_KEYS)) return false;
  const claims = ownValue(value, "claims");
  return claims !== INVALID && isDenseArray(claims, MAX_RESOURCE_CLAIMS)
    && resourceClaimsAreUnique(claims)
    && resourceClaimsAreValid(claims);
}

function resourceClaimsAreUnique(claims) {
  const identities = new Set();
  for (let index = 0; index < claims.length; index += 1) {
    const claim = ownValue(claims, String(index));
    if (!validResourceClaimShape(claim)) return false;
    const key = ownValue(claim, "key");
    const value = ownValue(claim, "value");
    const identity = `${key}:${value}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  return true;
}

function resourceClaimsAreValid(claims) {
  for (let index = 0; index < claims.length; index += 1) {
    const claim = ownValue(claims, String(index));
    if (!validResourceClaimShape(claim)) return false;
    const key = ownValue(claim, "key");
    const value = ownValue(claim, "value");
    if (!IDENTIFIER.test(key) || !RESOURCE_TEMPLATE_VALUES.has(value)) return false;
  }
  return true;
}

function validResourceClaimShape(claim) {
  if (claim === INVALID || !isPlainDataObject(claim) || !sameKeys(claim, RESOURCE_CLAIM_KEYS)) return false;
  return typeof ownValue(claim, "key") === "string" && typeof ownValue(claim, "value") === "string";
}

function validPostcondition(value) {
  if (!isPlainDataObject(value) || !sameKeys(value, POSTCONDITION_KEYS)) return false;
  const name = ownValue(value, "name");
  return typeof name === "string" && name.length > 0 && name.length <= MAX_STRING_LENGTH;
}

function sameKeys(value, keys) {
  if (!isPlainDataObject(value)) return false;
  const actual = dataKeys(value);
  return actual !== null && actual.length === keys.size && actual.every((key) => keys.has(key));
}

function dataKeys(value) {
  if (!isPlainDataObject(value)) return null;
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (keys.some((key) => typeof key !== "string" || !isDataProperty(value, key))) return null;
  return keys;
}

function ownValue(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") && !descriptor.get && !descriptor.set
      ? descriptor.value
      : INVALID;
  } catch {
    return INVALID;
  }
}

function isDataProperty(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") && !descriptor.get && !descriptor.set
      && descriptor.enumerable;
  } catch {
    return false;
  }
}

function isDenseArray(value, maximum) {
  if (!Array.isArray(value) || !Number.isSafeInteger(value.length) || value.length > maximum) return false;
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  if (keys.length !== value.length + 1 || !keys.includes("length") || ownValue(value, "length") !== value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = ownValue(value, key);
    if (descriptor === INVALID || !Object.prototype.propertyIsEnumerable.call(value, key)) return false;
  }
  return keys.every((key) => key === "length" || (typeof key === "string" && isArrayIndexKey(key) && Number(key) < value.length));
}

function isArrayIndexKey(key) {
  if (typeof key !== "string" || key === "") return false;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
}

function cloneable(value) {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

function readOnlyMapMutation() {
  throw new TypeError("descriptor_map_read_only");
}
