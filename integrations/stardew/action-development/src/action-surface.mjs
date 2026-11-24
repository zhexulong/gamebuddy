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

/**
 * Action fields the Mod may omit, so the action's key set is a SUBSET of `ACTION_SURFACE_ACTION_KEYS ∪ this set`.
 *
 * `approach` reached the artifact in `eea94e3f` and was never added here, so the package check has been failing on
 * the four actions that declare it - and passing on the ninety-one that do not, because `exactKeys` compares against
 * a fixed set. Measured 2026-10-29: `HEAD` fails `stardew_action_surface_invalid_action_shape` before any change of
 * this session.
 *
 * `synthetic` reached it in `f1474cff`, which regenerated the artifact and left this list behind - so the member was
 * published before its readers learned it, and the parity producer could not run at all (measured 2026-11-11:
 * `stardew_action_surface_invalid_action_shape` out of `parseActionSurface`). Same ordering as `approach` above, and
 * the same fix: the reader learns the member it was already being handed.
 *
 * `sceneTarget` LEFT in `0c7848cd`, which removed the member from `FarmhandActionDescriptorProjection` - so this list
 * kept admitting a field the record can no longer emit. The record is the authority for this vocabulary, and the
 * decision-closure drift check names any entry here that the record does not declare: a tolerance with nothing behind
 * it is a field every future reader has to re-justify.
 */
export const ACTION_SURFACE_OPTIONAL_ACTION_KEYS = Object.freeze([
  "approach",
  "targetFamily",
  "nativeBinding",
  "synthetic",
  // What the action REQUIRES of the world and what it CHANGES. Published so a consumer without a running game can answer
  // whether its next step can depend on this one - the script compiler reads nothing but this artifact, and the only
  // cross-step edge its descriptors declare today is the tile it addressed. The sentence carries no quoted phrase because
  // `audit-stardew-decision-closure.test.mjs` reads this array as a member vocabulary, and a quoted word inside a comment
  // reads as an entry the Mod does not declare.
  "effects",
]);
export const ACTION_SURFACE_MAX_REGISTRATIONS = 128;
export const ACTION_SURFACE_MAX_IDENTIFIER_LENGTH = 128;
/**
 * Longest prose the artifact may carry in one place: an argument's `description`.
 *
 * Separate from `ACTION_SURFACE_MAX_IDENTIFIER_LENGTH` because the two measure different things. An identifier is a
 * NAME and 128 characters is generous; a description is a SENTENCE, and the whole point of publishing it is that the
 * Mod's own words about an argument reach the model instead of a Host-side paragraph covering every action at once.
 * The bound still exists so a future build cannot spend the agent's context by accident; it is the same 512 the Host
 * validator and the bridge apply, so a value that passes here cannot fail later.
 */
const ACTION_SURFACE_MAX_DESCRIPTION_LENGTH = 512;
const ACTION_SURFACE_MAX_IDENTITY_VERSION = 2_147_483_647;
const ACTION_SURFACE_MAX_JSON_DEPTH = 8;
const ACTION_SURFACE_MAX_DATA_NODES = 2048;
const ACTION_SURFACE_MAX_OBJECT_KEYS = 16;
export const ACTION_SURFACE_MAX_ARRAY_ITEMS = 128;

const IDENTIFIER = /^[a-z][a-z0-9_]{1,127}$/;
/** The four classes a cross-step dependency can be built from (`FarmhandActionEffectClass`). */
const EFFECT_CLASSES = new Set(["moves_actor", "requires_place", "produces", "consumes"]);
/**
 * The reasons a row may give for having no effect (`FarmhandActionEffects.AbsenceReasons`): each names an absence, not a
 * gap - the action reads, or changes only the actor's own body, or the row it addressed, or a record the game owns.
 */
const EFFECT_NONE_REASONS = new Set([
  "observation_only",
  "actor_body_only",
  "addressed_row_only",
  "game_owned_ledger",
]);
/**
 * The gap marker, and the rule that it must name the resource: `resource_unproven_by_the_receipt:<resource>`.
 *
 * A BARE MARKER IS THE SAME HOLE WEARING A WORD. It says something is unproven and not what, so two rows that fail for
 * different reasons read as one, and the next reader cannot tell which receipt change would close either. The resource is
 * the lower-snake word an effect's `subject` uses (`pack_item`, `crop_produce`, `watering_can_water`), so the marker is
 * answered by declaring the resource once the receipt names it.
 *
 * The authority is `FarmhandActionEffects.IsAdmitted`; this is the producer-side reading of the same rule, kept to the one
 * line the wire value can be checked against.
 */
const UNPROVEN_BY_THE_RECEIPT = "resource_unproven_by_the_receipt:";
const RESOURCE_WORD = /^[a-z][a-z0-9_]{1,63}$/;
function isAdmittedNoneReason(value) {
  if (EFFECT_NONE_REASONS.has(value)) return true;
  return value.startsWith(UNPROVEN_BY_THE_RECEIPT) && RESOURCE_WORD.test(value.slice(UNPROVEN_BY_THE_RECEIPT.length));
}
const MAX_EFFECTS = 8;
/** A subject word (`actor_position`, `watering_can_water`) or the dotted symbol / reason code a seam is spelled as. */
const EFFECT_WORD = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
/**
 * The artifact's byte allowance, DERIVED from what it publishes - never typed.
 *
 * WHY IT MOVED (2026-11-22). It was a flat `64 * 1024`, and by the time `effects` was added the artifact stood at 64,435
 * bytes: 1,100 bytes under a cap it could no longer grow into. A flat number made every future member a decision about
 * THIS constant, and a literal raise buys one member and fails the next one the same way. The allowance is therefore a
 * DESCRIPTOR allowance times the registration bound, plus the envelope:
 *
 *   - `MAX_DESCRIPTOR_MEMBER_BYTES` per published member, counted from the member vocabulary this module owns
 *     (`ACTION_SURFACE_ACTION_KEYS` + `ACTION_SURFACE_OPTIONAL_ACTION_KEYS`), so a new member raises the allowance by
 *     construction rather than by an argument;
 *   - `MAX_EFFECT_BYTES` per declared effect, times the effect bound, so a raised effect bound raises it too;
 *   - 256 bytes for the envelope (`schema`, `catalogRevision`, `actions`).
 *
 * Measured at that date: 106 descriptors in 73,258 bytes, 691 each on average. The allowance is deliberately above the
 * measurement - it bounds an ACCIDENT (a build that starts spending the agent's context), which is what the flat number
 * was for, and `2026-11-22 effect vocabulary` is the incident that shows the flat one had stopped meaning that.
 */
const MAX_DESCRIPTOR_MEMBER_BYTES = 64;
const MAX_EFFECT_BYTES = 64;
const ACTION_SURFACE_MAX_ENVELOPE_BYTES = 256;
const ACTION_SURFACE_MAX_DESCRIPTOR_BYTES =
  MAX_DESCRIPTOR_MEMBER_BYTES * (ACTION_SURFACE_ACTION_KEYS.length + ACTION_SURFACE_OPTIONAL_ACTION_KEYS.length)
  + MAX_EFFECTS * MAX_EFFECT_BYTES;
export const ACTION_SURFACE_MAX_JSON_BYTES =
  ACTION_SURFACE_MAX_REGISTRATIONS * ACTION_SURFACE_MAX_DESCRIPTOR_BYTES + ACTION_SURFACE_MAX_ENVELOPE_BYTES;
/**
 * A snapshot FIELD name, which is a different kind of name from `IDENTIFIER` and must not borrow its rule.
 *
 * `targetFamily` names the `BridgeSnapshot` array an action's targets come from (`toolSlots`, `warps`,
 * `refillWateringCanTargets`), and the Mod's serializer publishes every such array under the .NET camelCase
 * policy: lower first letter, then the C# property's own words, no separators. All 109 keys of the Host's
 * `SNAPSHOT_KEYS` are that shape and the longest is 27 characters. `IDENTIFIER` is the ACTION-ID rule
 * (`move_to_tile`, `equip_tool`), so applying it here accepted 2 of the 68 families the Mod declares (measured
 * 2026-10-29) - it is the reuse, not the values, that was wrong.
 *
 * 64 is the bound every other published lower-camel name carries (the Host's argument names, its scene-target
 * property names), so a value this producer admits cannot be refused for its length later. A bad value looks
 * like `ToolSlots` (the C# property name, which no snapshot response carries), `tool-slots` or `tool_slots` (a
 * spelling the serializer never emits), the empty string, or a name longer than 64 characters.
 */
const TARGET_FAMILY = /^[a-z][A-Za-z0-9]{0,63}$/;
/** A `tool:<category>` claim key: a symbolic resource whose subject is a tool category. */
const TOOL_CLAIM_KEY = /^tool:[a-z][a-z0-9_]{1,63}$/;
/**
 * The values a resource claim may carry.
 *
 * `ScopePlayer` is the actor claim, and it is the ONLY value an `embodied_actor` key takes. `AnyUpgrade` and
 * `BasicOnly` are the upgrade-level halves of a `tool:<category>` claim, added when a tool requirement started
 * travelling the pipeline (`987e3587`). This set was not widened then, so the package check has been failing on every
 * tool action since - measured 2026-10-29 on `HEAD`, before any change of this session.
 */
const RESOURCE_CLAIM_VALUES = new Set(["ScopePlayer", "AnyUpgrade", "BasicOnly"]);
// Three-rung ladder: experimental -> live_verified -> published.
// `live_verified` means the action passed a real live run on its required
// topology; `published` additionally requires independent review.
// Exported so every consumer in this layer validates against one vocabulary
// instead of restating a subset (which is how `live_verified` used to be
// silently rejected in several places).
export const ACTION_SURFACE_LIFECYCLES = Object.freeze(["published", "live_verified", "experimental"]);
// The rungs that make an action player-visible. `experimental` is deliberately
// absent: it can never enter a visible subset.
export const ACTION_SURFACE_VISIBLE_LIFECYCLES = Object.freeze(["published", "live_verified"]);
const LIFECYCLES = new Set(ACTION_SURFACE_LIFECYCLES);
const KINDS = new Set(["execution", "read_only"]);
const ACTION_VALUE_TYPES = new Set(["integer", "string", "boolean", "object", "destination_selector", "destination_arrival"]);
// One argument entry: its declared type, plus the descriptor's own value vocabulary when the
// argument is a closed set (`FarmhandActionArgumentSchema.Enum`). The vocabulary is projected
// with the type because a consumer that cannot read a closed set can only guess it.
const ARGUMENT_SCHEMA_ENTRY_KEYS = Object.freeze(["type"]);
const ARGUMENT_SCHEMA_ENUM_ENTRY_KEYS = Object.freeze(["type", "enum"]);
// The value range the Mod's own acceptance validator enforces, from ONE declaration (`FarmhandArgumentBounds`). They are
// optional and independent: `maximum` alone is absent for an argument whose ceiling the Mod does not state, and the
// length pair is the same fact for a bounded string. A consumer that builds a tool schema reads them instead of
// PROBING its own predicates for a range, which is what this artifact had no way to answer before.
const ARGUMENT_SCHEMA_RANGE_KEYS = Object.freeze(["minimum", "maximum", "minLength", "maxLength"]);
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

function assertPlainJsonData(value, state = { active: new Set(), nodes: 0 }, depth = 0, stringLimit = ACTION_SURFACE_MAX_IDENTIFIER_LENGTH) {
  if (depth > ACTION_SURFACE_MAX_JSON_DEPTH) fail("bounds");

  if (value === null) return;
  switch (typeof value) {
    case "string":
      if (value.length > stringLimit) fail("bounds");
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
        // `description` is the one field that carries a SENTENCE rather than a name, so it is measured against the
        // prose bound. Every other key keeps the identifier bound, which is what stops a future field from quietly
        // becoming a place to store paragraphs.
        assertPlainJsonData(
          descriptor.value,
          state,
          depth + 1,
          key === "description" ? ACTION_SURFACE_MAX_DESCRIPTION_LENGTH : stringLimit,
        );
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

/**
 * The action shape: the required keys, plus any OPTIONAL key the Mod actually sent.
 *
 * A separate function rather than a flag on `exactKeys`, because the two answer different questions. `exactKeys` is
 * for maps whose key set is fixed; an action has a fixed CORE and a set of fields a surface may omit. Checking them
 * with one rule made every action without `approach` fail and every action WITH it pass, which is the inverse of what
 * the check is for.
 */
function actionKeys(value) {
  const keys = ownKeys(value, "invalid_action_shape");
  const required = ACTION_SURFACE_ACTION_KEYS;
  for (const key of required) {
    if (!keys.includes(key)) fail("invalid_action_shape");
    dataDescriptor(value, key, "invalid_action_shape");
  }
  for (const key of keys) {
    if (required.includes(key)) continue;
    if (!ACTION_SURFACE_OPTIONAL_ACTION_KEYS.includes(key)) {
      if (DYNAMIC_PUBLICATION_FIELDS.has(key)) fail("dynamic_publication_field");
      fail("invalid_action_shape");
    }
    dataDescriptor(value, key, "invalid_action_shape");
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
      // The TOKENIZER bounds one string token; which KEYS may hold a long string is decided afterwards by
      // `assertPlainJsonData`, where `description` is the only field measured against the prose bound. Keeping the two
      // limits apart here would mean this pass had to understand the schema, which is exactly the coupling the
      // structure pass exists to avoid.
      if (value.length > ACTION_SURFACE_MAX_DESCRIPTION_LENGTH) fail("bounds");
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
  const bytes = Buffer.byteLength(text, "utf8");
  // The numbers travel with the refusal: a reader whose artifact outgrew the allowance needs the measurement and the
  // allowance it derived, not the word "bounds".
  if (bytes > ACTION_SURFACE_MAX_JSON_BYTES) fail(`bounds:${bytes}>${ACTION_SURFACE_MAX_JSON_BYTES}`);
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

function validateEnumVocabulary(value) {
  if (!isArray(value) || value.length === 0) fail("invalid_argument_schema_enum");
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) fail("invalid_argument_schema_enum");
  }
}

function validateTypedMap(value, location, entriesAreObjects) {
  if (!isObject(value) || isArray(value) || prototypeOf(value) !== Object.prototype) fail("invalid_action");
  for (const key of ownKeys(value, "invalid_action")) {
    const entry = dataDescriptor(value, key, "invalid_action").value;
    if (entriesAreObjects) {
      if (!isObject(entry) || isArray(entry) || prototypeOf(entry) !== Object.prototype) fail("invalid_action");
      const hasEnum = ownKeys(entry, "invalid_action").includes("enum");
      const hasDescription = ownKeys(entry, "invalid_action").includes("description");
      // `resolvedAtExecution` is OPTIONAL too, and published only by an action that DECLARES it
      // (`FarmhandActionArgument.ResolvedAtExecution`): the member says the body answers for a value the caller may
      // leave out, so it is a claim about one argument of one action and never a property of a shared shape.
      const hasResolved = ownKeys(entry, "invalid_action").includes("resolvedAtExecution");
      const ranges = ARGUMENT_SCHEMA_RANGE_KEYS.filter((key) => ownKeys(entry, "invalid_action").includes(key));
      // `description` is OPTIONAL, so the exact-key set is the base set plus it only when present. Anything else is
      // still refused by name: an unrecognised key would be a field a consumer silently ignores.
      const base = hasEnum ? ARGUMENT_SCHEMA_ENUM_ENTRY_KEYS : ARGUMENT_SCHEMA_ENTRY_KEYS;
      exactKeys(
        entry,
        [
          ...base,
          ...(hasDescription ? ["description"] : []),
          ...(hasResolved ? ["resolvedAtExecution"] : []),
          ...ranges,
        ],
        `${location}_entry`,
      );
      if (!ACTION_VALUE_TYPES.has(dataDescriptor(entry, "type").value)) fail("invalid_action");
      if (hasResolved && dataDescriptor(entry, "resolvedAtExecution").value !== true) fail("invalid_action");
      for (const key of ranges) {
        if (!Number.isSafeInteger(dataDescriptor(entry, key).value)) fail("invalid_action");
      }
      if (hasDescription) {
        // The argument's MEANING, in the Mod's own words. Bounded like every other published string: an unbounded one
        // would let a future build spend the agent's context by accident, and empty is refused because a present-but-
        // empty description says nothing while an ABSENT one means "the name is the whole story".
        const description = dataDescriptor(entry, "description").value;
        if (typeof description !== "string" || description.length === 0 || description.length > 512)
          fail("invalid_action");
      }
      if (hasEnum) validateEnumVocabulary(dataDescriptor(entry, "enum").value);
    } else if (!ACTION_VALUE_TYPES.has(entry)) {
      fail("invalid_action");
    }
  }
}

function validateResourceTemplate(value) {
  if (!isObject(value) || isArray(value) || prototypeOf(value) !== Object.prototype) fail("invalid_action");
  exactKeys(value, ["claims"], "resource_template");
  const claims = dataDescriptor(value, "claims").value;
  if (!isArray(claims) || claims.length > ACTION_SURFACE_MAX_ARRAY_ITEMS) fail("invalid_action");
  for (const claim of claims) {
    if (!isObject(claim) || isArray(claim) || prototypeOf(claim) !== Object.prototype) fail("invalid_action");
    exactKeys(claim, ["key", "value"], "resource_claim");
    const claimKey = dataDescriptor(claim, "key").value;
    // A tool claim's key names a tool CATEGORY after `tool:`, so the plain identifier rule refuses it. Both shapes are
    // validated rather than the prefix being stripped unchecked: an unrecognised key is exactly what this code is for.
    if (typeof claimKey !== "string" || (!IDENTIFIER.test(claimKey) && !TOOL_CLAIM_KEY.test(claimKey))) {
      fail("invalid_resource_claim_key");
    }
    const claimValue = dataDescriptor(claim, "value").value;
    if (!RESOURCE_CLAIM_VALUES.has(claimValue)) fail("invalid_resource_claim_value");
  }
}

/**
 * One action's declared effects, or the reason it has none.
 *
 * THE PAIR IS EXCLUSIVE: `declared` empty with no `none` is the silence this member replaces, and a row that declares
 * effects AND a reason they are absent is one row saying two things. `declared` is always present because it is the count
 * a consumer reads; `none` is present only when it holds the claim.
 */
function validateEffects(value) {
  if (!isObject(value) || isArray(value) || prototypeOf(value) !== Object.prototype) fail("invalid_action");
  const keys = ownKeys(value, "invalid_action");
  exactKeys(value, keys.includes("none") ? ["declared", "none"] : ["declared"], "effects");
  const declared = dataDescriptor(value, "declared").value;
  if (!isArray(declared) || declared.length > MAX_EFFECTS) fail("invalid_action");
  const hasNone = keys.includes("none");
  if (hasNone && !isAdmittedNoneReason(dataDescriptor(value, "none").value)) fail("invalid_effect_none_reason");
  if (declared.length === 0) {
    if (!hasNone) fail("invalid_effect_none_reason");
    return;
  }
  if (hasNone) fail("invalid_effect_none_reason");
  for (const effect of declared) {
    if (!isObject(effect) || isArray(effect) || prototypeOf(effect) !== Object.prototype) fail("invalid_action");
    exactKeys(effect, ["class", "subject", "observedBy"], "effect");
    if (!EFFECT_CLASSES.has(dataDescriptor(effect, "class").value)) fail("invalid_effect_class");
    for (const member of ["subject", "observedBy"]) {
      const seam = dataDescriptor(effect, member).value;
      if (typeof seam !== "string" || !EFFECT_WORD.test(seam)) fail("invalid_effect_seam");
    }
  }
}

function validateAction(value, seenActionIds) {
  if (!isObject(value) || isArray(value) || prototypeOf(value) !== Object.prototype) {
    fail("invalid_action");
  }
  actionKeys(value);

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
  if (!isObject(postcondition) || isArray(postcondition) || prototypeOf(postcondition) !== Object.prototype)
    fail("invalid_action");
  validateTypedMap(argumentSchema, "argument_schema", true);
  validateTypedMap(outputFacts, "output_facts", false);
  validateResourceTemplate(resourceTemplate);
  exactKeys(postcondition, ["name"], "postcondition");
  if ((effect !== "read" && effect !== "write") || typeof dataDescriptor(postcondition, "name").value !== "string") {
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

  if (value.targetFamily !== undefined) {
    // The snapshot family this action's targets come from: a snapshot FIELD name, so `TARGET_FAMILY` and not
    // `IDENTIFIER` (see its comment). An empty string is refused because a present-but-empty family says nothing
    // while an ABSENT one means "this action addresses no published family".
    if (typeof value.targetFamily !== "string" || !TARGET_FAMILY.test(value.targetFamily)) fail("invalid_target_family");
  }

  if (value.nativeBinding !== undefined) {
    // The engine member this action drives, in the Mod's own spelling (`Farmer.doEmote`). Measured 2026-11-11: this
    // field never reached the artifact, so the Host's mount arms - which require it - closed on the only descriptor a
    // consumer outside a running game can read, and the two actions the Game prompt tells the companion to use for body
    // language could not be mounted at all. Bounded exactly as the Host's own wire validator bounds it (a non-empty
    // string of at most 128 characters), so a value that passes here cannot be refused on the other side.
    if (typeof value.nativeBinding !== "string" || value.nativeBinding.length === 0 || value.nativeBinding.length > 128)
      fail("invalid_native_binding");
  }

  // `synthetic` is admitted by the key set AND forwarded below, because admitting a member and dropping it are the same
  // defect wearing two faces: the artifact would pass the reader and then vanish from every consumer view of it. The
  // Mod publishes the member only on the action that bypasses the NPC counter owning it (`build_farm_building` places a
  // structure through `GameLocation.buildStructure` instead of opening Robin's menu), so an absent member means "no
  // claim" and a published `false` would be a second spelling of absent - refused rather than forwarded.
  if (value.synthetic !== undefined && value.synthetic !== true) fail("invalid_synthetic");

  if (value.effects !== undefined) validateEffects(value.effects);

  return Object.freeze({ actionId, identityVersion, lifecycle, kind, argumentSchema, outputFacts, resourceTemplate, effect, postcondition, ...(value.sceneTarget === undefined ? {} : { sceneTarget: value.sceneTarget }), ...(value.targetFamily === undefined ? {} : { targetFamily: value.targetFamily }), ...(value.nativeBinding === undefined ? {} : { nativeBinding: value.nativeBinding }), ...(value.synthetic === undefined ? {} : { synthetic: value.synthetic }), ...(value.effects === undefined ? {} : { effects: value.effects }) });
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


export function isActionSurfaceIdentifier(value) {
  return typeof value === "string" && value.length <= ACTION_SURFACE_MAX_IDENTIFIER_LENGTH && IDENTIFIER.test(value);
}
