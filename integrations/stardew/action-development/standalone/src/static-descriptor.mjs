const KEYS = new Set(["schema", "developmentOnly", "gameId", "actionId", "identityVersion", "familyId", "effect", "target", "terminal"]);
const TARGET_KEYS = new Set(["kind", "property", "type", "minimum", "maximum"]);
const TERMINAL_KEYS = new Set(["state", "reasonCode", "evidenceFields", "requiredRelation"]);

function fail(code) { throw new Error(`stardew_static_descriptor_${code}`); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys, code) { if (!object(value) || Object.keys(value).length !== keys.size || Object.keys(value).some((key) => !keys.has(key))) fail(code); }

export function validateEquipToolStaticDescriptor(descriptor) {
  exact(descriptor, KEYS, "shape");
  if (descriptor.schema !== "gamebuddy-stardew-static-action-descriptor/v1" || descriptor.developmentOnly !== true) fail("scope");
  if (descriptor.gameId !== "stardew" || descriptor.actionId !== "equip_tool" || descriptor.identityVersion !== 1 || descriptor.familyId !== "body_tools" || descriptor.effect !== "mutation") fail("identity");
  exact(descriptor.target, TARGET_KEYS, "target_shape");
  if (descriptor.target.kind !== "inventory_slot" || descriptor.target.property !== "slot" || descriptor.target.type !== "integer" || descriptor.target.minimum !== 0 || descriptor.target.maximum !== 36) fail("target");
  exact(descriptor.terminal, TERMINAL_KEYS, "terminal_shape");
  const fields = descriptor.terminal.evidenceFields;
  if (descriptor.terminal.state !== "succeeded" || descriptor.terminal.reasonCode !== "tool_selected" || descriptor.terminal.requiredRelation !== "after_equals_expected" || !Array.isArray(fields) || fields.length !== 4 || new Set(fields).size !== 4 || fields.join(",") !== "slot,before,expected,after") fail("terminal");
  return Object.freeze(descriptor);
}
