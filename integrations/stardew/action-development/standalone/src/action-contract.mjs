const CONTRACT_SCHEMA = "gamebuddy-action-development-contract/v1";
const ALLOWED_TOP_LEVEL_KEYS = new Set(["schema", "gameId", "actionId", "familyId", "identityVersion", "lifecycle", "kind", "args", "terminal"]);
const ALLOWED_ARGS_KEYS = new Set(["requiredProperties", "slotMinimum", "slotMaximum"]);
const ALLOWED_TERMINAL_KEYS = new Set(["acceptableStates", "successReasonCode", "evidenceFields", "evidenceRelation"]);
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

  exactKeys(input.args, ALLOWED_ARGS_KEYS, "invalid_args_shape");
  assertStringArray(input.args.requiredProperties, "invalid_required_properties");
  if (input.args.slotMinimum !== null && (!Number.isInteger(input.args.slotMinimum) || input.args.slotMinimum < 0)) fail("invalid_slot_minimum");
  if (input.args.slotMaximum !== null && (!Number.isInteger(input.args.slotMaximum) || input.args.slotMaximum < 0)) fail("invalid_slot_maximum");
  if (input.args.slotMinimum !== null && input.args.slotMaximum !== null && input.args.slotMinimum > input.args.slotMaximum) fail("invalid_slot_range");

  exactKeys(input.terminal, ALLOWED_TERMINAL_KEYS, "invalid_terminal_shape");
  assertStringArray(input.terminal.acceptableStates, "invalid_acceptable_states");
  assertNonEmptyString(input.terminal.successReasonCode, "invalid_success_reason_code");
  assertStringArray(input.terminal.evidenceFields, "invalid_evidence_fields");
  assertNonEmptyString(input.terminal.evidenceRelation, "invalid_evidence_relation");

  return Object.freeze(input);
}

export function validateActionContractEquipTool(contract) {
  const validated = validateActionDevelopmentContract(contract);
  if (validated.actionId !== "equip_tool") fail("wrong_action_id");
  if (validated.familyId !== "body_tools") fail("wrong_family_id");
  if (validated.identityVersion !== 1) fail("wrong_identity_version");
  if (validated.lifecycle !== "published") fail("wrong_lifecycle");
  if (validated.kind !== "execution") fail("wrong_kind");
  if (validated.terminal.successReasonCode !== "tool_selected") fail("wrong_reason_code");
  if (validated.terminal.evidenceRelation !== "after_equals_expected") fail("wrong_evidence_relation");
  return validated;
}