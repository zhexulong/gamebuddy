import { deepFreeze, isPlainDataObject } from "./model.mjs";

// The member vocabulary this projection admits, keyed by the shape it governs. It is the ONE spelling both the
// validator below and the drift check in `tools/audit-stardew-decision-closure.test.mjs` read: the check compares it
// with the Host's own registration whitelist (`protocol.ts` `KNOWN_ACTION_DESCRIPTOR_KEYS`), because the two describe
// the same fact - which members a published descriptor may carry - and they disagreed in silence once already.
const DESCRIPTOR_REQUIRED_KEYS = Object.freeze([
  "actionId",
  "identityVersion",
  "lifecycle",
  "kind",
  "argumentSchema",
  "outputFacts",
  "resourceTemplate",
  "effect",
  "postcondition",
]);
// The members a producer may ADD to the required set. Each is optional because the Mod's serializer omits it when an
// action declares none (`JsonIgnoreCondition.WhenWritingNull`), and each is a member the Host's own registration
// descriptor already accepts. Refusing one here only makes the published surface unreadable to the one consumer of
// this module, which then reports it as "not parseable by the Host descriptor whitelist" while the Host parses it
// happily - the drift `eff7646f` fixed for `approach` and `450c8f90` re-opened for `sceneTarget`.
//
// This list stays EXPLICIT rather than derived from the artifact it judges: deriving it would make the gateway admit
// whatever the Mod emits, including a member the Host refuses, which is the one thing it exists to prevent. The
// derivation lives one layer up, in `tools/audit-stardew-decision-closure.test.mjs`, where both directions are asserted
// against the published surface and `protocol.ts`'s `KNOWN_ACTION_DESCRIPTOR_KEYS` - so a member added to either side is
// judged and named instead of silently missed.
const DESCRIPTOR_OPTIONAL_KEYS = Object.freeze(["approach", "sceneTarget", "targetFamily", "nativeBinding"]);
// `description` is the Mod's own words for what an argument MEANS, published per argument so the companion is not told
// a Host-side sentence about a shared argument name that is false for the action it is calling. The Host's registration
// descriptor has carried it since `693c19a8`; this entry whitelist still refused it.
const ARGUMENT_SCHEMA_REQUIRED_KEYS = Object.freeze(["type"]);
const ARGUMENT_SCHEMA_OPTIONAL_KEYS = Object.freeze(["enum", "description"]);

export const DESCRIPTOR_PROJECTION_VOCABULARY = Object.freeze({
  descriptor: Object.freeze({
    required: DESCRIPTOR_REQUIRED_KEYS,
    optional: DESCRIPTOR_OPTIONAL_KEYS,
  }),
  argumentSchemaEntry: Object.freeze({
    required: ARGUMENT_SCHEMA_REQUIRED_KEYS,
    optional: ARGUMENT_SCHEMA_OPTIONAL_KEYS,
  }),
});

const DESCRIPTOR_KEYS = new Set(DESCRIPTOR_REQUIRED_KEYS);
const OPTIONAL_DESCRIPTOR_KEYS = new Set(DESCRIPTOR_OPTIONAL_KEYS);
const ARGUMENT_SCHEMA_REQUIRED_KEY_SET = new Set(ARGUMENT_SCHEMA_REQUIRED_KEYS);
const ARGUMENT_SCHEMA_OPTIONAL_KEY_SET = new Set(ARGUMENT_SCHEMA_OPTIONAL_KEYS);
const PROJECTION_KEYS = new Set(["schema", "catalogRevision", "actions"]);
const RESOURCE_TEMPLATE_KEYS = new Set(["claims"]);
const RESOURCE_CLAIM_KEYS = new Set(["key", "value"]);
const POSTCONDITION_KEYS = new Set(["name"]);
const VALUE_TYPES = new Set(["string", "integer", "boolean", "object", "destination_selector", "destination_arrival"]);
// Three-rung ladder shared with the Mod authority: experimental -> live_verified
// -> published. `live_verified` records that the action already passed a real run
// on its required topology; omitting it here rejects the Mod's own projection.
const LIFECYCLES = new Set(["published", "live_verified", "experimental"]);
const KINDS = new Set(["execution", "read_only"]);
const EFFECTS = new Set(["read", "write"]);
const RESOURCE_TEMPLATE_VALUES = new Set(["ScopePlayer", "AnyUpgrade", "BasicOnly"]);
// A relation word plus the distance it allows; the bounds are the Host's own for the identical field.
const APPROACH_KEYS = new Set(["relation"]);
const APPROACH_OPTIONAL_KEYS = new Set(["withinTiles"]);
const MAX_APPROACH_RELATION_LENGTH = 64;
// An ObservationBinding/v1 requirement: the four members the Host validates, and nothing beside them.
const SCENE_TARGET_KEYS = new Set(["type", "version", "required", "requiredProperties"]);
const MAX_SCENE_TARGET_TYPE_LENGTH = 64;
const MAX_SCENE_TARGET_PROPERTIES = 16;
const MAX_ACTIONS = 128;
const MAX_ARGUMENTS = 32;
const MAX_FACTS = 32;
const MAX_RESOURCE_CLAIMS = 16;
const MAX_IDENTITY_VERSION = 2_147_483_647;
const MAX_STRING_LENGTH = 128;
// An argument's `description` is a SENTENCE, not a name, so it is measured against the same 512 the Host applies to it.
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_VOCABULARY_VALUES = 128;
const IDENTIFIER = /^[a-z][a-z0-9_]{1,127}$/;
/**
 * A snapshot FIELD name (`toolSlots`, `warps`, `refillWateringCanTargets`), which `targetFamily` must be.
 *
 * Not `IDENTIFIER`: that is the ACTION-ID rule, and an action id is a snake_case verb phrase while a snapshot family
 * is a .NET property name the serializer publishes under camelCase. Measured 2026-10-29: `IDENTIFIER` admitted 2 of the
 * 68 families the Mod declares. Every one of the Host's 109 `SNAPSHOT_KEYS` is this shape (lower first letter, no
 * separator, no digit, longest 27), and 64 is the bound the Host applies to every other published lower-camel name, so
 * a value this gateway admits cannot be refused at registration for its length.
 *
 * Exported because `tools/audit-stardew-decision-closure.test.mjs` asserts that the three sites spelling this one fact
 * (this gateway, the producer `action-surface.mjs`, and `protocol.ts`'s `isValidActionDescriptor`) still agree.
 */
export const TARGET_FAMILY_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;
// A tool requirement's claim key is `tool:<category>`: the category is the KEY half of the claim and the
// upgrade-level requirement is its VALUE (see the Mod's `FarmhandActionDefinitions` / `BodyProgramModels`
// `IsResourceClaimKey`). It is admitted as one fixed prefix plus an identifier rather than as a general
// `a:b` chain, so a producer cannot smuggle a free-form subject through the claim map.
const TOOL_CLAIM_KEY = /^tool:[a-z][a-z0-9_]{1,127}$/;
// Argument names are producer-owned and may use the published camelCase spelling.
const ARGUMENT_IDENTIFIER = /^[a-z][A-Za-z0-9_]{0,127}$/;
// A `requiredProperties` entry is bounded at 64 by the Host's own scene-target rule, so it is bounded at 64 here: a value
// this gateway admits and the Host refuses is the drift this module exists to prevent.
const SCENE_TARGET_PROPERTY = /^[a-z][A-Za-z0-9_]{0,63}$/;
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
  if (!sameKeysOrOptional(descriptor, DESCRIPTOR_KEYS, OPTIONAL_DESCRIPTOR_KEYS)) return false;
  const actionId = ownValue(descriptor, "actionId");
  const identityVersion = ownValue(descriptor, "identityVersion");
  const lifecycle = ownValue(descriptor, "lifecycle");
  const kind = ownValue(descriptor, "kind");
  const argumentSchema = ownValue(descriptor, "argumentSchema");
  const outputFacts = ownValue(descriptor, "outputFacts");
  const resourceTemplate = ownValue(descriptor, "resourceTemplate");
  const effect = ownValue(descriptor, "effect");
  const postcondition = ownValue(descriptor, "postcondition");
  // `sameKeysOrOptional` proved every present member is a data property, so INVALID here means ABSENT rather than
  // unreadable: the Mod omits the declaration entirely instead of sending a null one.
  const approach = ownValue(descriptor, "approach");
  const sceneTarget = ownValue(descriptor, "sceneTarget");
  // Admitting the MEMBER is not enough, exactly as for `approach` and `sceneTarget`: this module is the gateway the
  // Host-side catalog is built from, so a value it admits and the Host refuses is a descriptor that parses here and dies
  // at registration. The value rule is `TARGET_FAMILY_NAME`, the Host's own.
  const targetFamily = ownValue(descriptor, "targetFamily");
  // The engine member this action drives (`Farmer.doEmote`), bounded exactly as the Host bounds it. It reached the
  // artifact when the Host's mount arms needed the field they require: the two actions the Game prompt names for body
  // language were published, planned for, and unmountable from the only descriptor a consumer without a running game
  // can read.
  const nativeBinding = ownValue(descriptor, "nativeBinding");
  return typeof actionId === "string" && IDENTIFIER.test(actionId)
    && Number.isSafeInteger(identityVersion) && identityVersion >= 1
    && identityVersion <= MAX_IDENTITY_VERSION
    && LIFECYCLES.has(lifecycle)
    && KINDS.has(kind)
    && validArgumentSchema(argumentSchema)
    && validOutputFacts(outputFacts)
    && validResourceTemplate(resourceTemplate)
    && EFFECTS.has(effect)
    && validPostcondition(postcondition)
    && (approach === INVALID || validApproach(approach))
    && (sceneTarget === INVALID || validSceneTarget(sceneTarget))
    && (targetFamily === INVALID || (typeof targetFamily === "string" && TARGET_FAMILY_NAME.test(targetFamily)))
    && (nativeBinding === INVALID
      || (typeof nativeBinding === "string" && nativeBinding.length > 0 && nativeBinding.length <= MAX_STRING_LENGTH));
}

/**
 * Where the body must stand before the action can happen: a relation word and, optionally, the distance it allows.
 *
 * The rules are the Host's own (`protocol.ts` `isValidActionDescriptor`), deliberately not looser: a descriptor this
 * gateway admits and the Host then refuses would be the same drift seen from the other side. One non-empty relation of
 * at most 64 characters, an optional `withinTiles` that is a positive safe integer, and no third field - a member
 * beside them would be a precondition nobody enforces. `withinTiles` is ABSENT when the Mod states no distance, which
 * is never the same statement as zero tiles.
 */
function validApproach(value) {
  const keys = dataKeys(value);
  if (keys === null) return false;
  if (!keys.every((key) => APPROACH_KEYS.has(key) || APPROACH_OPTIONAL_KEYS.has(key))) return false;
  if (!keys.includes("relation")) return false;
  const relation = ownValue(value, "relation");
  if (typeof relation !== "string" || relation.length === 0 || relation.length > MAX_APPROACH_RELATION_LENGTH) {
    return false;
  }
  if (!keys.includes("withinTiles")) return true;
  const withinTiles = ownValue(value, "withinTiles");
  return Number.isSafeInteger(withinTiles) && withinTiles > 0;
}

/**
 * The ObservationBinding/v1 requirement the Mod publishes when an action needs a scene reference first.
 *
 * The rules are the Host's own (`protocol.ts` `isValidActionDescriptor`): exactly `type`, `version`, `required` and
 * `requiredProperties`; a non-empty type of at most 64 characters; a version of at least 1; a boolean `required`; and up to
 * 16 property names of the published property shape. No fifth member, because a field beside them would be a requirement
 * nobody enforces - and a descriptor this gateway admits while the Host refuses is the identical drift seen from the other
 * side.
 */
function validSceneTarget(value) {
  if (!isPlainDataObject(value) || !sameKeys(value, SCENE_TARGET_KEYS)) return false;
  const type = ownValue(value, "type");
  const version = ownValue(value, "version");
  const required = ownValue(value, "required");
  const requiredProperties = ownValue(value, "requiredProperties");
  return typeof type === "string" && type.length > 0 && type.length <= MAX_SCENE_TARGET_TYPE_LENGTH
    && Number.isSafeInteger(version) && version >= 1
    && typeof required === "boolean"
    && isDenseArray(requiredProperties, MAX_SCENE_TARGET_PROPERTIES)
    && requiredProperties.every((property) => typeof property === "string" && SCENE_TARGET_PROPERTY.test(property));
}

function validArgumentSchema(value) {
  const keys = dataKeys(value);
  return keys !== null && keys.length <= MAX_ARGUMENTS
    && keys.every((key) => ARGUMENT_IDENTIFIER.test(key))
    && keys.every((key) => validArgumentSchemaEntry(ownValue(value, key)));
}

/**
 * One argument entry: its declared type plus the producer's own value vocabulary when the argument is a
 * closed set (`FarmhandActionArgumentSchema.Enum`). The vocabulary is part of the descriptor, so a consumer
 * that rejects it cannot read the domain it is supposed to project.
 */
function validArgumentSchemaEntry(entry) {
  if (entry === INVALID || !sameKeysOrOptional(entry, ARGUMENT_SCHEMA_REQUIRED_KEY_SET, ARGUMENT_SCHEMA_OPTIONAL_KEY_SET)) {
    return false;
  }
  if (!VALUE_TYPES.has(ownValue(entry, "type"))) return false;
  const description = ownValue(entry, "description");
  if (description !== INVALID && !validArgumentDescription(description)) return false;
  const vocabulary = ownValue(entry, "enum");
  if (vocabulary === INVALID) return true;
  return isDenseArray(vocabulary, MAX_VOCABULARY_VALUES)
    && vocabulary.length > 0
    && vocabulary.every((member) => typeof member === "string" && member.length > 0 && member.length <= MAX_STRING_LENGTH);
}

/**
 * What an argument means, in the words of the handler that enforces it. The Host applies the identical rule to the
 * same field when it arrives as an `arguments` entry: a present-but-empty description is a label that says nothing,
 * and an absent one is how the surface says "the name is the whole story".
 */
function validArgumentDescription(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_DESCRIPTION_LENGTH;
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
    if (!IDENTIFIER.test(key) && !TOOL_CLAIM_KEY.test(key)) return false;
    if (!RESOURCE_TEMPLATE_VALUES.has(value)) return false;
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

/** The required set, plus members a producer may add. Nothing outside the two sets is admitted. */
function sameKeysOrOptional(value, required, optional) {
  if (!isPlainDataObject(value)) return false;
  const actual = dataKeys(value);
  return actual !== null
    && actual.every((key) => required.has(key) || optional.has(key))
    && [...required].every((key) => actual.includes(key));
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
