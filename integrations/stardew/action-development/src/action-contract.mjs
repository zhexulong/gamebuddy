const CONTRACT_SCHEMA = "gamebuddy-action-development-contract/v2";
const ALLOWED_TOP_LEVEL_KEYS = new Set(["schema", "gameId", "actionId", "familyId", "identityVersion", "lifecycle", "kind", "args", "terminal"]);
const ALLOWED_ARGS_KEYS = new Set(["requiredProperties", "toolAllowedValues", "sceneTarget"]);
const ALLOWED_TERMINAL_KEYS = new Set(["acceptableStates", "successReasonCodes", "evidenceFields", "evidenceRelation"]);
const ALLOWED_SCENE_TARGET_KEYS = new Set(["type", "version", "required", "requiredProperties"]);
const ID_PATTERN = /^[a-z][a-z0-9_]{1,127}$/;

function fail(code) {
  throw new Error(`stardew_action_contract_${code}`);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, code) {
  if (!object(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) fail(code);
}

function assertId(value, code) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail(code);
}

function assertNonEmptyString(value, code) {
  if (typeof value !== "string" || value.length === 0) fail(code);
}

function assertStringArray(value, code) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) fail(code);
}

export function validateActionDevelopmentContract(input) {
  exactKeys(input, ALLOWED_TOP_LEVEL_KEYS, "invalid_shape");
  if (input.schema !== CONTRACT_SCHEMA) fail("invalid_schema");
  if (input.gameId !== "stardew") fail("invalid_game_id");
  assertId(input.actionId, "invalid_action_id");
  assertId(input.familyId, "invalid_family_id");
  if (!Number.isInteger(input.identityVersion) || input.identityVersion < 1) fail("invalid_identity_version");
  assertNonEmptyString(input.lifecycle, "invalid_lifecycle");
  assertNonEmptyString(input.kind, "invalid_kind");

  if (!object(input.args)) fail("invalid_args_shape");
  const argKeys = Object.keys(input.args);
  const legacyArgKeys = ["requiredProperties", "toolAllowedValues"];
  const sceneArgKeys = ["requiredProperties", "sceneTarget"];
  if (argKeys.some((key) => !ALLOWED_ARGS_KEYS.has(key)) || ![legacyArgKeys, sceneArgKeys].some((keys) => argKeys.length === keys.length && keys.every((key) => argKeys.includes(key)))) fail("invalid_args_shape");
  assertStringArray(input.args.requiredProperties, "invalid_required_properties");
  if (input.args.toolAllowedValues !== null && input.args.toolAllowedValues !== undefined) assertStringArray(input.args.toolAllowedValues, "invalid_tool_allowed_values");
  if (input.args.sceneTarget !== undefined && input.args.sceneTarget !== null) {
    exactKeys(input.args.sceneTarget, ALLOWED_SCENE_TARGET_KEYS, "invalid_scene_target_shape");
    if (input.args.sceneTarget.type !== "ObservationBinding" || input.args.sceneTarget.version !== 1 || input.args.sceneTarget.required !== true) fail("invalid_scene_target");
    assertStringArray(input.args.sceneTarget.requiredProperties, "invalid_scene_target_properties");
    if (JSON.stringify(input.args.sceneTarget.requiredProperties) !== JSON.stringify(["observationId", "ref"])) fail("invalid_scene_target_properties");
  }
  exactKeys(input.terminal, ALLOWED_TERMINAL_KEYS, "invalid_terminal_shape");
  assertStringArray(input.terminal.acceptableStates, "invalid_acceptable_states");
  assertStringArray(input.terminal.successReasonCodes, "invalid_success_reason_codes");
  assertStringArray(input.terminal.evidenceFields, "invalid_evidence_fields");
  assertNonEmptyString(input.terminal.evidenceRelation, "invalid_evidence_relation");

  return Object.freeze(input);
}

export function validateActionContractPickupForage(contract) {
  const validated = validateActionDevelopmentContract(contract);
  if (validated.actionId !== "pickup_forage") fail("wrong_action_id");
  if (validated.familyId !== "resource_gathering") fail("wrong_family_id");
  if (validated.identityVersion !== 1) fail("wrong_identity_version");
  if (validated.lifecycle !== "published") fail("wrong_lifecycle");
  if (validated.kind !== "execution") fail("wrong_kind");
  if (JSON.stringify(validated.args.requiredProperties) !== JSON.stringify(["x", "y", "expectedQualifiedItemId", "expectedTargetId"])) fail("wrong_required_properties");
  if (validated.args.toolAllowedValues !== null && validated.args.toolAllowedValues !== undefined) fail("wrong_tool_allowed_values");
  if (JSON.stringify(validated.args.sceneTarget) !== JSON.stringify({ type: "ObservationBinding", version: 1, required: true, requiredProperties: ["observationId", "ref"] })) fail("wrong_scene_target");
  if (JSON.stringify(validated.terminal.acceptableStates) !== JSON.stringify(["succeeded", "uncertain"])) fail("wrong_acceptable_states");
  if (JSON.stringify(validated.terminal.successReasonCodes) !== JSON.stringify(["forage_picked_up"])) fail("wrong_reason_codes");
  if (JSON.stringify(validated.terminal.evidenceFields) !== JSON.stringify(["location", "tile", "item", "removed", "inventory_before", "inventory_after"])) fail("wrong_evidence_fields");
  if (validated.terminal.evidenceRelation !== "inventory_after_equals_inventory_before_plus_removed") fail("wrong_evidence_relation");
  return validated;
}

export function validateActionContractEquipTool(contract) {
  const validated = validateActionDevelopmentContract(contract);
  if (validated.actionId !== "equip_tool") fail("wrong_action_id");
  if (validated.familyId !== "body_tools") fail("wrong_family_id");
  if (validated.identityVersion !== 1) fail("wrong_identity_version");
  if (validated.lifecycle !== "published") fail("wrong_lifecycle");
  if (validated.kind !== "execution") fail("wrong_kind");
  if (validated.args.requiredProperties.length !== 1 || validated.args.requiredProperties[0] !== "tool") fail("wrong_required_properties");
  const allowedTools = ["axe", "pickaxe", "hoe", "watering_can", "fishing_rod", "weapon", "scythe", "shears", "milk_pail", "pan"];
  if (JSON.stringify(validated.args.toolAllowedValues) !== JSON.stringify(allowedTools)) fail("wrong_tool_allowed_values");
  if (JSON.stringify(validated.terminal.successReasonCodes) !== JSON.stringify(["tool_equipped", "already_equipped"])) fail("wrong_reason_codes");
  if (JSON.stringify(validated.terminal.evidenceFields) !== JSON.stringify(["tool", "before", "expected", "after"])) fail("wrong_evidence_fields");
  if (validated.terminal.evidenceRelation !== "after_equals_expected") fail("wrong_evidence_relation");
  return validated;
}