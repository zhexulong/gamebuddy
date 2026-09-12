const KEYS = new Set(["schema", "developmentOnly", "gameId", "actionId", "identityVersion", "familyId", "effect", "target", "terminal"]);
const TARGET_KEYS = new Set(["kind", "property", "type", "allowedValues"]);
const TERMINAL_KEYS = new Set(["state", "successReasonCodes", "evidenceFields", "requiredRelation"]);

function fail(code) { throw new Error(`stardew_static_descriptor_${code}`); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys, code) { if (!object(value) || Object.keys(value).length !== keys.size || Object.keys(value).some((key) => !keys.has(key))) fail(code); }

export function validateEquipToolStaticDescriptor(descriptor) {
  exact(descriptor, KEYS, "shape");
  if (descriptor.schema !== "gamebuddy-stardew-static-action-descriptor/v2" || descriptor.developmentOnly !== true) fail("scope");
  if (descriptor.gameId !== "stardew" || descriptor.actionId !== "equip_tool" || descriptor.identityVersion !== 1 || descriptor.familyId !== "body_tools" || descriptor.effect !== "mutation") fail("identity");
  exact(descriptor.target, TARGET_KEYS, "target_shape");
  const allowedTools = ["axe", "pickaxe", "hoe", "watering_can", "fishing_rod", "weapon", "scythe", "shears", "milk_pail", "pan"];
  if (descriptor.target.kind !== "semantic_selector" || descriptor.target.property !== "tool" || descriptor.target.type !== "string" || JSON.stringify(descriptor.target.allowedValues) !== JSON.stringify(allowedTools)) fail("target");
  exact(descriptor.terminal, TERMINAL_KEYS, "terminal_shape");
  const fields = descriptor.terminal.evidenceFields;
  if (descriptor.terminal.state !== "succeeded" || JSON.stringify(descriptor.terminal.successReasonCodes) !== JSON.stringify(["tool_equipped", "already_equipped"]) || descriptor.terminal.requiredRelation !== "after_equals_expected" || !Array.isArray(fields) || fields.length !== 4 || new Set(fields).size !== 4 || fields.join(",") !== "tool,before,expected,after") fail("terminal");
  return Object.freeze(descriptor);
}


export function validatePickupForageStaticDescriptor(descriptor) {
  const keys = new Set(["schema", "developmentOnly", "gameId", "actionId", "identityVersion", "familyId", "effect", "target", "arguments", "terminal"]);
  exact(descriptor, keys, "shape");
  if (descriptor.schema !== "gamebuddy-stardew-static-action-descriptor/v2" || descriptor.developmentOnly !== true) fail("scope");
  if (descriptor.gameId !== "stardew" || descriptor.actionId !== "pickup_forage" || descriptor.identityVersion !== 1 || descriptor.familyId !== "resource_gathering" || descriptor.effect !== "mutation") fail("identity");
  exact(descriptor.target, new Set(["kind", "property", "type", "required", "requiredProperties"]), "target_shape");
  if (descriptor.target.kind !== "semantic_selector" || descriptor.target.property !== "sceneTarget" || descriptor.target.type !== "ObservationBinding/v1" || descriptor.target.required !== true || JSON.stringify(descriptor.target.requiredProperties) !== JSON.stringify(["observationId", "ref"])) fail("target");
  exact(descriptor.arguments, new Set(["requiredProperties"]), "arguments_shape");
  if (JSON.stringify(descriptor.arguments.requiredProperties) !== JSON.stringify(["x", "y", "expectedQualifiedItemId", "expectedTargetId"])) fail("arguments");
  exact(descriptor.terminal, TERMINAL_KEYS, "terminal_shape");
  if (descriptor.terminal.state !== "succeeded" || JSON.stringify(descriptor.terminal.successReasonCodes) !== JSON.stringify(["forage_picked_up"]) || descriptor.terminal.requiredRelation !== "inventory_after_equals_inventory_before_plus_removed" || JSON.stringify(descriptor.terminal.evidenceFields) !== JSON.stringify(["location", "tile", "item", "removed", "inventory_before", "inventory_after"])) fail("terminal");
  return Object.freeze(descriptor);
}
