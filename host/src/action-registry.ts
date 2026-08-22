import type { ActionRegistration } from "./protocol.js";

export type ActionLifecycle = ActionRegistration["lifecycle"];

/** A local concrete adapter can restrict, but never publish, a Mod action. */
export type StardewActionAdapter = Readonly<{
  actionId: string;
  label: string;
  description: string;
  targetKinds: readonly string[];
  requiredCapability: string;
}>;

/**
 * Concrete TypeBox adapters available in this Host build. This is deliberately
 * not an action registry: it contains no Mod-owned membership, family,
 * identity-version, or lifecycle facts.
 */
export const STARDEW_ACTION_ADAPTERS = Object.freeze([
  actionAdapter(
    "move_to_tile",
    "Move to a Stardew tile",
    "Move the Farmhand to a live, structured target tile.",
    ["tile"],
  ),
  actionAdapter(
    "equip_tool",
    "Equip a tool",
    "Select a Tool already owned by the Farmhand.",
    ["inventory_slot"],
  ),
  actionAdapter(
    "travel",
    "Travel through a discovered warp",
    "Use a live native warp from the current Stardew location.",
    ["warp"],
  ),
  actionAdapter(
    "enter_exit",
    "Enter or exit through a discovered door",
    "Use a live native door transition from the current Stardew location.",
    ["door", "building_entrance"],
  ),
  actionAdapter(
    "till_soil",
    "Till a soil tile",
    "Use a native Hoe on a live soil target.",
    ["soil_tile"],
  ),
  actionAdapter(
    "pickup_forage",
    "Pick up a forage target",
    "Use the native forage interaction on a live target and verify the item enters the Farmhand inventory.",
    ["forage"],
  ),
  actionAdapter(
    "pickup_item",
    "Pick up a live item drop",
    "Approach a live native Debris target and verify its native magnetic collection enters the Farmhand inventory.",
    ["item_drop"],
  ),
  actionAdapter(
    "water_crop",
    "Water a live crop",
    "Use the native Watering Can on a live unwatered crop.",
    ["crop"],
  ),
  actionAdapter(
    "refill_watering_can",
    "Refill a Watering Can",
    "Refill one selected, partially filled Watering Can from a live adjacent native water source.",
    ["watering_can", "water_source", "inventory_slot"],
  ),
  actionAdapter(
    "plant_seed",
    "Plant a live seed",
    "Use the native seed placement path on a live empty HoeDirt target.",
    ["soil_tile", "inventory_slot"],
  ),
  actionAdapter(
    "fertilize_tile",
    "Apply fertilizer to a live soil tile",
    "Use the native fertilizer placement path on a live ground HoeDirt target.",
    ["soil_tile", "inventory_slot"],
  ),
  actionAdapter(
    "place_wood_fence",
    "Place a Wood Fence",
    "Place only one qualified (O)322 non-gate Fence on a fresh empty Farm tile through the native placement path.",
    ["farm_tile", "inventory_slot"],
  ),
  actionAdapter(
    "place_crab_pot",
    "Place a Crab Pot",
    "Place only one qualified (O)710 Crab Pot on a fresh valid water tile in the Farm through the native placement path.",
    ["farm_tile", "inventory_slot"],
  ),
  actionAdapter(
    "bait_crab_pot",
    "Bait a Crab Pot",
    "Attach exactly one owned (O)685 Bait to one adjacent, current-player-owned unbaited (O)710 Crab Pot through its normal native interaction.",
    ["crab_pot", "inventory_slot"],
  ),
  actionAdapter(
    "machine_inspect",
    "Inspect a machine",
    "Read a live native machine state without opening a menu or changing the machine.",
    ["machine"],
  ),
  actionAdapter(
    "machine_load",
    "Load Coffee Beans into a Keg",
    "Use the normal native machine interaction to load exactly five Coffee Beans into one idle Keg and begin Coffee processing.",
    ["machine", "inventory_slot"],
  ),
  actionAdapter(
    "machine_collect_output",
    "Collect Coffee from a Keg",
    "Use the normal native machine interaction to collect ready Coffee from the exact Keg after its native processing lifecycle completes.",
    ["machine", "inventory"],
  ),
  actionAdapter(
    "collect_animal_product",
    "Collect a ready animal product",
    "Use native MilkPail or Shears animation on a live adult animal with compatible produce.",
    ["animal", "animal_product", "tool", "inventory"],
  ),
  actionAdapter(
    "feed_animal",
    "Place Hay in a feed trough",
    "Place one owned Hay item in a live empty AnimalHouse trough; placement does not claim an animal has eaten.",
    ["feed_trough", "inventory_slot"],
  ),
  actionAdapter(
    "use_item",
    "Use or consume an owned food item",
    "Use the native Farmer eat path on a live ordinary edible inventory item.",
    ["inventory_slot", "food"],
  ),
  actionAdapter(
    "harvest_crop",
    "Harvest a ready crop",
    "Use native Crop.harvest on a live ready ordinary crop.",
    ["crop", "inventory"],
  ),
  actionAdapter(
    "break_rock_source",
    "Break a one-hit rock source",
    "Use one equipped basic Pickaxe hit on a live ordinary one-hit stone; drops and pickup are separate.",
    ["rock_source", "tool"],
  ),
  actionAdapter(
    "clear_hoedirt",
    "Clear empty HoeDirt",
    "Use one equipped Basic Pickaxe hit on live adjacent empty ground HoeDirt; crops, pots, drops, and pickup are excluded.",
    ["soil_tile", "tool"],
  ),
  actionAdapter(
    "dig_artifact_spot",
    "Dig an artifact spot",
    "Use one equipped Basic Hoe on a fresh adjacent (O)590 artifact spot; source removal and native HoeDirt creation are the completion boundary.",
    ["artifact_spot", "tool"],
  ),
  actionAdapter(
    "chop_tree_source",
    "Chop a one-hit tree source",
    "Use one equipped Axe terminal strike on a live ordinary mature one-hit tree; source transformation is the completion boundary.",
    ["tree_source", "tool"],
  ),
]) satisfies readonly StardewActionAdapter[];

export type StardewActionId =
  (typeof STARDEW_ACTION_ADAPTERS)[number]["actionId"];

/** A current restrictive projection: registration facts remain Mod-owned. */
export type VisibleStardewAction = StardewActionAdapter & ActionRegistration;

/**
 * Tool construction remains action-specific, but this closed projection forces
 * every Mod-published identity for which this build has an adapter to have one Host tool adapter name.
 */
export const STARDEW_ACTION_TOOL_NAMES = {
  move_to_tile: "stardew_move_to_tile",
  equip_tool: "stardew_equip_tool",
  travel: "stardew_travel",
  enter_exit: "stardew_enter_exit",
  till_soil: "stardew_till_soil",
  pickup_forage: "stardew_pickup_forage",
  pickup_item: "stardew_pickup_item",
  water_crop: "stardew_water_crop",
  refill_watering_can: "stardew_refill_watering_can",
  plant_seed: "stardew_plant_seed",
  fertilize_tile: "stardew_fertilize_tile",
  place_wood_fence: "stardew_place_wood_fence",
  place_crab_pot: "stardew_place_crab_pot",
  bait_crab_pot: "stardew_bait_crab_pot",
  machine_inspect: "stardew_machine_inspect",
  machine_load: "stardew_machine_load",
  machine_collect_output: "stardew_machine_collect_output",
  collect_animal_product: "stardew_collect_animal_product",
  feed_animal: "stardew_feed_animal",
  use_item: "stardew_use_item",
  harvest_crop: "stardew_harvest_crop",
  break_rock_source: "stardew_break_rock_source",
  clear_hoedirt: "stardew_clear_hoedirt",
  dig_artifact_spot: "stardew_dig_artifact_spot",
  chop_tree_source: "stardew_chop_tree_source",
} as const satisfies Record<StardewActionId, `stardew_${string}`>;

/**
 * Removed roadmap labels are not registry/policy identifiers. They intentionally
 * have no automatic successor: several map to different finite capabilities
 * whose implementation and live gates do not yet exist. Config migration must
 * therefore be explicit and fail closed instead of silently broadening a deny.
 */
export const RETIRED_ACTION_POLICY_MIGRATIONS = Object.freeze({
  collect_resource: Object.freeze([
    "chop_tree_source",
    "break_rock_source",
    "pickup_item",
  ]),
  use_tool: Object.freeze([
    "tool_transform_object",
    "chop_tree_source",
    "break_rock_source",
    "clear_hoedirt",
  ]),
  combat_attack: Object.freeze([
    "melee_attack",
    "ranged_attack",
    "weapon_special",
  ]),
  place_item: Object.freeze([
    "place_decor_or_furniture",
    "place_fence_or_gate",
    "place_tapper",
    "place_crab_pot",
    "place_explosive",
  ]),
  transfer_item: Object.freeze([
    "transfer_to_container",
    "transfer_from_container",
  ]),
  manage_animal: Object.freeze([
    "toggle_animal_door",
    "purchase_animal",
    "sell_or_relocate_animal",
  ]),
  world_interact: Object.freeze(["execute_world_operation"]),
  special_interact: Object.freeze(["execute_world_operation"]),
  festival_interact: Object.freeze([
    "submit_festival_entry",
    "start_minigame_phase",
    "control_minigame_phase",
    "claim_minigame_or_festival_reward",
  ]),
  minigame_play: Object.freeze([
    "start_minigame_phase",
    "control_minigame_phase",
    "claim_minigame_or_festival_reward",
  ]),
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
  if (
    !isRecord(value) ||
    value.policyVersion !== 1 ||
    !boundedIdentifierArray(value.deniedActions) ||
    !boundedIdentifierArray(value.deniedFamilies)
  ) {
    throw new Error("invalid_action_policy");
  }
  const deniedActions = [...(value.deniedActions as string[])];
  const deniedFamilies = [...(value.deniedFamilies as string[])];
  if (deniedActions.some((id) => id in RETIRED_ACTION_POLICY_MIGRATIONS)) {
    throw new Error(
      "retired_action_policy_identifier_requires_explicit_migration",
    );
  }
  // Policy is restrictive: IDs are checked against the authenticated Mod
  // catalog only when tools are materialized. A Host-local registry must not
  // decide whether a future or currently unavailable Mod action is valid.
  return Object.freeze({
    policyVersion: 1 as const,
    deniedActions: Object.freeze([...new Set(deniedActions)]),
    deniedFamilies: Object.freeze([...new Set(deniedFamilies)]),
  });
}

function boundedIdentifierArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every(
      (item) => typeof item === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Intersect local typed-adapter availability with the authenticated Mod
 * registration catalog, fresh capabilities, and a restrictive policy. The
 * Mod owns registration identity, family, version, and lifecycle; the Host
 * contributes presentation plus the concrete TypeBox adapter only.
 */
export function visibleActionsFromModCatalog(
  registrations: readonly ActionRegistration[],
  liveCapabilities: readonly string[],
  policy: ActionPolicy = DEFAULT_ACTION_POLICY,
): readonly VisibleStardewAction[] {
  if (registrations.length === 0 || liveCapabilities.length === 0)
    return Object.freeze([]);

  const adapters = new Map<string, StardewActionAdapter>(
    STARDEW_ACTION_ADAPTERS.map((entry) => [entry.actionId, entry]),
  );
  const live = new Set(liveCapabilities);
  const deniedActions = new Set(policy.deniedActions);
  const deniedFamilies = new Set(policy.deniedFamilies);
  const visible: VisibleStardewAction[] = [];

  for (const registration of registrations) {
    const adapter = adapters.get(registration.actionId);
    if (
      adapter === undefined ||
      registration.lifecycle !== "published" ||
      !live.has(adapter.requiredCapability) ||
      deniedActions.has(registration.actionId) ||
      deniedFamilies.has(registration.familyId)
    ) {
      continue;
    }
    visible.push(
      Object.freeze({
        ...adapter,
        familyId: registration.familyId,
        identityVersion: registration.identityVersion,
        lifecycle: registration.lifecycle,
      }),
    );
  }
  return Object.freeze(visible);
}

export function searchActionsFromModCatalog(
  registrations: readonly ActionRegistration[],
  capabilities: readonly string[],
  query: string,
  policy: ActionPolicy = DEFAULT_ACTION_POLICY,
): readonly VisibleStardewAction[] {
  const normalized = query.trim().toLocaleLowerCase();
  const visible = visibleActionsFromModCatalog(
    registrations,
    capabilities,
    policy,
  );
  if (normalized.length === 0) return visible;
  return visible.filter((entry) =>
    `${entry.actionId} ${entry.familyId} ${entry.label} ${entry.description}`
      .toLocaleLowerCase()
      .includes(normalized),
  );
}

function actionAdapter<const TActionId extends string>(
  actionId: TActionId,
  label: string,
  description: string,
  targetKinds: readonly string[],
): StardewActionAdapter & Readonly<{ actionId: TActionId }> {
  return Object.freeze({
    actionId,
    label,
    description,
    targetKinds: Object.freeze([...targetKinds]),
    requiredCapability: actionId,
  });
}
