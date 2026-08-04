export type ActionLifecycle = "published" | "experimental" | "diagnostic" | "planned";

export type PublishedAction = Readonly<{
  actionId: string;
  familyId: string;
  lifecycle: ActionLifecycle;
  label: string;
  description: string;
  targetKinds: readonly string[];
  requiredCapability: string;
}>;

/**
 * The registry is deliberately broader than the currently published surface.
 * Planned entries document the product roadmap but are never materialized into
 * an Agent tool or interaction catalog.
 */
export const STARDEW_ACTION_REGISTRY: readonly PublishedAction[] = Object.freeze([
  publishedAction("move_to_tile", "movement_navigation", "Move to a Stardew tile", "Move the Farmhand to a live, structured target tile.", ["tile"]),
  publishedAction("equip_tool", "body_tools", "Equip a tool", "Select a Tool already owned by the Farmhand.", ["inventory_slot"]),
  publishedAction("travel", "transport_warps", "Travel through a discovered warp", "Use a live native warp from the current Stardew location.", ["warp"]),
  publishedAction("enter_exit", "movement_navigation", "Enter or exit through a discovered door", "Use a live native door transition from the current Stardew location.", ["door", "building_entrance"]),
  publishedAction("till_soil", "farming_crops", "Till a soil tile", "Use a native Hoe on a live soil target.", ["soil_tile"]),
  publishedAction("pickup_forage", "resource_gathering", "Pick up a forage target", "Use the native forage interaction on a live target and verify the item enters the Farmhand inventory.", ["forage"]),
  publishedAction("pickup_item", "inventory_items", "Pick up a live item drop", "Approach a live native Debris target and verify its native magnetic collection enters the Farmhand inventory.", ["item_drop"]),
  publishedAction("water_crop", "farming_crops", "Water a live crop", "Use the native Watering Can on a live unwatered crop.", ["crop"]),
  publishedAction("plant_seed", "farming_crops", "Plant a live seed", "Use the native seed placement path on a live empty HoeDirt target.", ["soil_tile", "inventory_slot"]),
  publishedAction("fertilize_tile", "farming_crops", "Apply fertilizer to a live soil tile", "Use the native fertilizer placement path on a live ground HoeDirt target.", ["soil_tile", "inventory_slot"]),
  experimentalAction("clear_debris", "resource_gathering", "Clear a resource clump", "Use a native tool on a live ResourceClump target.", ["debris"]),
  publishedAction("machine_inspect", "machines_processing", "Inspect a machine", "Read a live native machine state without opening a menu or changing the machine.", ["machine"]),
  experimentalAction("collect_resource", "resource_gathering", "Chop a mature tree stump (collection remains unproven)", "Use one native Axe hit on a live mature Tree stump; a hit or tree removal is not a completed resource collection.", ["tree", "resource"]),
  experimentalAction("npc_relationship", "npc_social", "Inspect NPC relationship facts", "Read live Farmhand relationship facts for a nearby NPC without opening dialogue or changing relationship state.", ["npc"]),
  experimentalAction("pet_animal", "animals_pets", "Pet an animal", "Use native Pet.checkAction on a live unpetted Pet while the Farmhand has empty hands.", ["animal", "pet"]),
  publishedAction("collect_animal_product", "animals_pets", "Collect a ready animal product", "Use native MilkPail or Shears animation on a live adult animal with compatible produce.", ["animal", "animal_product", "tool", "inventory"]),
  publishedAction("feed_animal", "animals_pets", "Place Hay in a feed trough", "Place one owned Hay item in a live empty AnimalHouse trough; placement does not claim an animal has eaten.", ["feed_trough", "inventory_slot"]),
  publishedAction("use_item", "inventory_items", "Use or consume an owned food item", "Use the native Farmer eat path on a live ordinary edible inventory item.", ["inventory_slot", "food"]),
  publishedAction("harvest_crop", "farming_crops", "Harvest a ready crop", "Use native Crop.harvest on a live ready ordinary crop.", ["crop", "inventory"]),
  ...[
    ["mount_transport", "transport_warps", "Mount available transport", ["horse", "transport"]],
    ["use_tool", "body_tools", "Use a selected tool on a structured target", ["tool_target"]],
    ["combat_attack", "body_tools", "Attack a live combat target", ["monster"]],
    ["fish", "body_tools", "Complete a fishing interaction", ["fishing_spot"]],
    ["place_item", "inventory_items", "Place an owned item", ["placement"]],
    ["transfer_item", "inventory_items", "Transfer an item to a discovered container", ["container", "inventory_slot"]],
    ["craft_item", "crafting_cooking", "Craft an unlocked recipe", ["recipe"]],
    ["cook_recipe", "crafting_cooking", "Cook an unlocked recipe", ["recipe", "cooking_station"]],
    ["machine_load", "machines_processing", "Load a machine", ["machine"]],
    ["milk_animal", "animals_pets", "Milk an animal", ["animal"]],
    ["shear_animal", "animals_pets", "Shear an animal", ["animal"]],
    ["manage_animal", "animals_pets", "Manage an animal", ["animal", "animal_shop"]],
    ["npc_talk", "npc_social", "Talk to an NPC", ["npc"]],
    ["npc_gift", "npc_social", "Give an item to an NPC", ["npc", "inventory_slot"]],
    ["npc_event", "npc_social", "Participate in an NPC event", ["npc", "event"]],
    ["shop_buy", "shops_economy", "Buy an available item", ["shop_item", "shop"]],
    ["shop_sell", "shops_economy", "Sell an owned item", ["shop", "inventory_slot"]],
    ["ship_item", "shops_economy", "Ship an owned item", ["shipping_bin", "inventory_slot"]],
    ["tool_upgrade", "shops_economy", "Upgrade a tool", ["shop", "tool"]],
    ["building_construct", "buildings_farm_management", "Construct a building", ["building_site"]],
    ["building_upgrade", "buildings_farm_management", "Upgrade a building", ["building"]],
    ["building_move", "buildings_farm_management", "Move a building", ["building"]],
    ["building_demolish", "buildings_farm_management", "Demolish a building", ["building"]],
    ["quest_accept", "quests_progression", "Accept a quest", ["quest"]],
    ["quest_submit", "quests_progression", "Submit a quest", ["quest", "inventory_slot"]],
    ["bundle_donate", "quests_progression", "Donate to a bundle", ["bundle", "inventory_slot"]],
    ["museum_donate", "quests_progression", "Donate to the museum", ["museum", "inventory_slot"]],
    ["world_interact", "story_world_scripts", "Interact with a published world target", ["world_target"]],
    ["event_choice", "story_world_scripts", "Choose a published event option", ["event"]],
    ["special_interact", "story_world_scripts", "Interact with a published special target", ["special_target"]],
    ["festival_enter", "festivals_minigames", "Enter a festival activity", ["festival"]],
    ["festival_interact", "festivals_minigames", "Interact with a festival target", ["festival_target"]],
    ["minigame_play", "festivals_minigames", "Play a published minigame phase", ["minigame"]],
    ["end_day", "calendar_day_progression", "End the Stardew day", ["bed", "sleep_target"]],
  ].map(([actionId, familyId, label, targetKinds]) => plannedAction(actionId as string, familyId as string, label as string, `Planned Stardew action: ${label}.`, targetKinds as readonly string[])),
]);

export const PUBLISHED_STARDEW_ACTIONS = Object.freeze(
  STARDEW_ACTION_REGISTRY.filter((entry) => entry.lifecycle === "published"),
);

export type ActionPolicy = Readonly<{
  policyVersion: 1;
  deniedActions: readonly string[];
  deniedFamilies: readonly string[];
}>;

export const DEFAULT_ACTION_POLICY: ActionPolicy = Object.freeze({
  policyVersion: 1,
  deniedActions: Object.freeze([]),
  deniedFamilies: Object.freeze([]),
});

export function parseActionPolicy(value: unknown): ActionPolicy {
  if (!isRecord(value) || value.policyVersion !== 1 || !boundedIdentifierArray(value.deniedActions) || !boundedIdentifierArray(value.deniedFamilies)) {
    throw new Error("invalid_action_policy");
  }
  const actionIds = new Set(STARDEW_ACTION_REGISTRY.map((entry) => entry.actionId));
  const familyIds = new Set(STARDEW_ACTION_REGISTRY.map((entry) => entry.familyId));
  const deniedActions = [...(value.deniedActions as string[])];
  const deniedFamilies = [...(value.deniedFamilies as string[])];
  if (deniedActions.some((id) => !actionIds.has(id)) || deniedFamilies.some((id) => !familyIds.has(id))) {
    throw new Error("invalid_action_policy_identifier");
  }
  return Object.freeze({
    policyVersion: 1 as const,
    deniedActions: Object.freeze([...new Set(deniedActions)]),
    deniedFamilies: Object.freeze([...new Set(deniedFamilies)]),
  });
}

function boundedIdentifierArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 128 && value.every((item) => typeof item === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function visiblePublishedActions(
  capabilities: readonly string[],
  policy: ActionPolicy = DEFAULT_ACTION_POLICY,
): readonly PublishedAction[] {
  const capabilitySet = new Set(capabilities);
  const deniedActions = new Set(policy.deniedActions);
  const deniedFamilies = new Set(policy.deniedFamilies);
  return PUBLISHED_STARDEW_ACTIONS.filter((entry) => capabilitySet.has(entry.requiredCapability)
    && !deniedActions.has(entry.actionId)
    && !deniedFamilies.has(entry.familyId));
}

export function searchVisibleActions(
  capabilities: readonly string[],
  query: string,
  policy: ActionPolicy = DEFAULT_ACTION_POLICY,
): readonly PublishedAction[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return visiblePublishedActions(capabilities, policy);
  return visiblePublishedActions(capabilities, policy).filter((entry) =>
    `${entry.actionId} ${entry.familyId} ${entry.label} ${entry.description}`.toLocaleLowerCase().includes(normalized));
}

function publishedAction(actionId: string, familyId: string, label: string, description: string, targetKinds: readonly string[]): PublishedAction {
  return action(actionId, familyId, "published", label, description, targetKinds);
}

function experimentalAction(actionId: string, familyId: string, label: string, description: string, targetKinds: readonly string[]): PublishedAction {
  return action(actionId, familyId, "experimental", label, description, targetKinds);
}

function plannedAction(actionId: string, familyId: string, label: string, description: string, targetKinds: readonly string[]): PublishedAction {
  return action(actionId, familyId, "planned", label, description, targetKinds);
}

function action(
  actionId: string,
  familyId: string,
  lifecycle: ActionLifecycle,
  label: string,
  description: string,
  targetKinds: readonly string[],
): PublishedAction {
  return Object.freeze({
    actionId,
    familyId,
    lifecycle,
    label,
    description,
    targetKinds: Object.freeze([...targetKinds]),
    requiredCapability: actionId,
  });
}
