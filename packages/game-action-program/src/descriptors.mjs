import { isPlainDataObject } from "./model.mjs";

const DESCRIPTOR_KEYS = new Set(["actionId", "identityVersion", "lifecycle", "kind", "argumentSchema", "outputFacts", "resourceTemplate", "effect", "postcondition"]);
const PROJECTION_KEYS = new Set(["schema", "catalogRevision", "actions"]);
const ARGUMENT_SCHEMA_KEYS = new Set(["type"]);
const RESOURCE_TEMPLATE_KEYS = new Set(["claims"]);
const RESOURCE_CLAIM_KEYS = new Set(["key", "value"]);
const POSTCONDITION_KEYS = new Set(["name"]);
const VALUE_TYPES = new Set(["string", "integer", "boolean", "object"]);
const LIFECYCLES = new Set(["published", "experimental"]);
const RESOURCE_TEMPLATE_VALUES = new Set(["ScopePlayer"]);
const MAX_RESOURCE_CLAIMS = 16;
const MAX_STRING_LENGTH = 128;
const IDENTIFIER = /^[a-z][a-z0-9_]{1,127}$/;

export function validateDescriptorProjection(projection) {
  if (!isPlainDataObject(projection) || !sameKeys(projection, PROJECTION_KEYS)
    || projection.schema !== "gamebuddy-action-descriptors/v1"
    || !Number.isSafeInteger(projection.catalogRevision) || projection.catalogRevision < 0
    || !Array.isArray(projection.actions)) return false;
  const ids = new Set();
  return projection.actions.every((descriptor) => {
    if (!isPlainDataObject(descriptor) || !sameKeys(descriptor, DESCRIPTOR_KEYS)
      || typeof descriptor.actionId !== "string" || !IDENTIFIER.test(descriptor.actionId) || ids.has(descriptor.actionId)
      || !Number.isSafeInteger(descriptor.identityVersion) || descriptor.identityVersion < 1
      || !LIFECYCLES.has(descriptor.lifecycle)
      || !["execution", "read_only"].includes(descriptor.kind)
       || !validArgumentSchema(descriptor.argumentSchema)
       || !validOutputFacts(descriptor.outputFacts)
       || !validResourceTemplate(descriptor.resourceTemplate)
       || !["read", "write"].includes(descriptor.effect)
       || !validPostcondition(descriptor.postcondition)) return false;
    ids.add(descriptor.actionId);
    return true;
  });
}

export function descriptorMap(projection) {
  if (!validateDescriptorProjection(projection)) return null;
  return new Map(projection.actions.map((descriptor) => [descriptor.actionId, descriptor]));
}

function validArgumentSchema(value) {
  return isPlainDataObject(value) && Object.values(value).every((entry) => isPlainDataObject(entry)
    && sameKeys(entry, ARGUMENT_SCHEMA_KEYS) && VALUE_TYPES.has(entry.type));
}

function validOutputFacts(value) {
  return isPlainDataObject(value) && Object.values(value).every((type) => VALUE_TYPES.has(type));
}

function validResourceTemplate(value) {
  return isPlainDataObject(value) && sameKeys(value, RESOURCE_TEMPLATE_KEYS)
    && Array.isArray(value.claims) && value.claims.length <= MAX_RESOURCE_CLAIMS
    && resourceClaimsAreUnique(value.claims)
    && value.claims.every((claim) => isPlainDataObject(claim)
      && sameKeys(claim, RESOURCE_CLAIM_KEYS)
      && typeof claim.key === "string" && IDENTIFIER.test(claim.key)
      && typeof claim.value === "string" && RESOURCE_TEMPLATE_VALUES.has(claim.value));
}

function resourceClaimsAreUnique(claims) {
  const identities = new Set();
  return claims.every((claim) => {
    if (!isPlainDataObject(claim) || typeof claim.key !== "string" || typeof claim.value !== "string") return false;
    const identity = `${claim.key}:${claim.value}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}

function validPostcondition(value) {
  return isPlainDataObject(value) && sameKeys(value, POSTCONDITION_KEYS)
    && typeof value.name === "string" && value.name.length > 0 && value.name.length <= MAX_STRING_LENGTH;
}

function sameKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}
