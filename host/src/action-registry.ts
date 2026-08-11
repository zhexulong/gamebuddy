import { type ActionClass } from "./action-class.js";

export type ActionLifecycle = "published" | "experimental" | "diagnostic" | "planned";

export type PublishedAction = Readonly<{
  actionId: string;
  familyId: string;
  actionClass: ActionClass;
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
  publishedAction("refill_watering_can", "farming_crops", "Refill a Watering Can", "Refill one selected, partially filled Watering Can from a live adjacent native water source.", ["watering_can", "water_source", "inventory_slot"]),
  publishedAction("plant_seed", "farming_crops", "Plant a live seed", "Use the native seed placement path on a live empty HoeDirt target.", ["soil_tile", "inventory_slot"]),
  publishedAction("fertilize_tile", "farming_crops", "Apply fertilizer to a live soil tile", "Use the native fertilizer placement path on a live ground HoeDirt target.", ["soil_tile", "inventory_slot"]),
  publishedAction("place_wood_fence", "buildings_farm_management", "Place a Wood Fence", "Place only one qualified (O)322 non-gate Fence on a fresh empty Farm tile through the native placement path.", ["farm_tile", "inventory_slot"]),
  publishedAction("place_crab_pot", "buildings_farm_management", "Place a Crab Pot", "Place only one qualified (O)710 Crab Pot on a fresh valid water tile in the Farm through the native placement path.", ["farm_tile", "inventory_slot"]),
  experimentalAction("clear_debris", "resource_gathering", "Clear a resource clump", "Use a native tool on a live ResourceClump target.", ["debris"]),
  publishedAction("machine_inspect", "machines_processing", "Inspect a machine", "Read a live native machine state without opening a menu or changing the machine.", ["machine"]),
  publishedAction("machine_load", "machines_processing", "Load Coffee Beans into a Keg", "Use the normal native machine interaction to load exactly five Coffee Beans into one idle Keg and begin Coffee processing.", ["machine", "inventory_slot"]),
  publishedAction("machine_collect_output", "machines_processing", "Collect Coffee from a Keg", "Use the normal native machine interaction to collect ready Coffee from the exact Keg after its native processing lifecycle completes.", ["machine", "inventory"]),
  experimentalAction("npc_relationship", "npc_social", "Inspect NPC relationship facts", "Read live Farmhand relationship facts for a nearby NPC without opening dialogue or changing relationship state.", ["npc"]),
  experimentalAction("pet_animal", "animals_pets", "Pet an animal", "Use native Pet.checkAction on a live unpetted Pet while the Farmhand has empty hands.", ["animal", "pet"]),
  publishedAction("collect_animal_product", "animals_pets", "Collect a ready animal product", "Use native MilkPail or Shears animation on a live adult animal with compatible produce.", ["animal", "animal_product", "tool", "inventory"]),
  publishedAction("feed_animal", "animals_pets", "Place Hay in a feed trough", "Place one owned Hay item in a live empty AnimalHouse trough; placement does not claim an animal has eaten.", ["feed_trough", "inventory_slot"]),
  publishedAction("use_item", "inventory_items", "Use or consume an owned food item", "Use the native Farmer eat path on a live ordinary edible inventory item.", ["inventory_slot", "food"]),
  publishedAction("harvest_crop", "farming_crops", "Harvest a ready crop", "Use native Crop.harvest on a live ready ordinary crop.", ["crop", "inventory"]),
  publishedAction("break_rock_source", "resource_gathering", "Break a one-hit rock source", "Use one equipped basic Pickaxe hit on a live ordinary one-hit stone; drops and pickup are separate.", ["rock_source", "tool"]),
  publishedAction("clear_hoedirt", "farming_crops", "Clear empty HoeDirt", "Use one equipped Basic Pickaxe hit on live adjacent empty ground HoeDirt; crops, pots, drops, and pickup are excluded.", ["soil_tile", "tool"]),
  publishedAction("dig_artifact_spot", "resource_gathering", "Dig an artifact spot", "Use one equipped Basic Hoe on a fresh adjacent (O)590 artifact spot; source removal and native HoeDirt creation are the completion boundary.", ["artifact_spot", "tool"]),
  publishedAction("chop_tree_source", "resource_gathering", "Chop a one-hit tree source", "Use one equipped Axe terminal strike on a live ordinary mature one-hit tree; source transformation is the completion boundary.", ["tree_source", "tool"]),
]);

/** Only published primitive contracts are materializable Agent actions. */
export const PUBLISHED_STARDEW_ACTIONS = Object.freeze(
  STARDEW_ACTION_REGISTRY.filter(isMaterializablePublishedAction),
);

/**
 * Removed roadmap labels are not registry/policy identifiers. They intentionally
 * have no automatic successor: several map to different finite capabilities
 * whose implementation and live gates do not yet exist. Config migration must
 * therefore be explicit and fail closed instead of silently broadening a deny.
 */
export const RETIRED_ACTION_POLICY_MIGRATIONS = Object.freeze({
  collect_resource: Object.freeze(["chop_tree_source", "break_rock_source", "pickup_item"]),
  use_tool: Object.freeze(["tool_transform_object", "chop_tree_source", "break_rock_source", "clear_hoedirt"]),
  combat_attack: Object.freeze(["melee_attack", "ranged_attack", "weapon_special"]),
  place_item: Object.freeze(["place_decor_or_furniture", "place_fence_or_gate", "place_tapper", "place_crab_pot", "place_explosive"]),
  transfer_item: Object.freeze(["transfer_to_container", "transfer_from_container"]),
  manage_animal: Object.freeze(["toggle_animal_door", "purchase_animal", "sell_or_relocate_animal"]),
  world_interact: Object.freeze(["execute_world_operation"]),
  special_interact: Object.freeze(["execute_world_operation"]),
  festival_interact: Object.freeze(["submit_festival_entry", "start_minigame_phase", "control_minigame_phase", "claim_minigame_or_festival_reward"]),
  minigame_play: Object.freeze(["start_minigame_phase", "control_minigame_phase", "claim_minigame_or_festival_reward"]),
  end_day: Object.freeze(["sleep_ready", "advance_day_after_ready"]),
  milk_animal: Object.freeze(["collect_animal_product"]),
  shear_animal: Object.freeze(["collect_animal_product"]),
  tool_upgrade: Object.freeze(["request_tool_upgrade", "claim_tool_upgrade"]),
  npc_talk: Object.freeze(["talk_to_npc"]),
  npc_gift: Object.freeze(["give_npc_gift"]),
  npc_event: Object.freeze(["select_event_choice"]),
});

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
  if (deniedActions.some((id) => id in RETIRED_ACTION_POLICY_MIGRATIONS)) {
    throw new Error("retired_action_policy_identifier_requires_explicit_migration");
  }
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
  return PUBLISHED_STARDEW_ACTIONS.filter((entry) => isMaterializablePublishedAction(entry)
    && capabilitySet.has(entry.requiredCapability)
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

export function isMaterializablePublishedAction(entry: PublishedAction): boolean {
  return entry.actionClass === "primitive" && entry.lifecycle === "published";
}

function publishedAction(actionId: string, familyId: string, label: string, description: string, targetKinds: readonly string[]): PublishedAction {
  return action(actionId, familyId, "primitive", "published", label, description, targetKinds);
}

function experimentalAction(actionId: string, familyId: string, label: string, description: string, targetKinds: readonly string[]): PublishedAction {
  return action(actionId, familyId, "primitive", "experimental", label, description, targetKinds);
}

function action(
  actionId: string,
  familyId: string,
  actionClass: ActionClass,
  lifecycle: ActionLifecycle,
  label: string,
  description: string,
  targetKinds: readonly string[],
): PublishedAction {
  return Object.freeze({
    actionId,
    familyId,
    actionClass,
    lifecycle,
    label,
    description,
    targetKinds: Object.freeze([...targetKinds]),
    requiredCapability: actionId,
  });
}
