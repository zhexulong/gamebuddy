import { type ActionRegistration, isValidActionDescriptor } from "./protocol.js";

export type ActionLifecycle = ActionRegistration["lifecycle"];

/** A local concrete adapter can restrict, but never publish, a Mod action. */
export type StardewActionAdapter = Readonly<{
  actionId: string;
  label: string;
  description: string;
  targetKinds: readonly string[];
  requiredCapability: string;
  /** Identity versions understood by this concrete Host adapter. */
  supportedIdentityVersions: readonly number[];
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
    "navigate_to_destination",
    "Navigate to a Stardew destination",
    "Navigate through the live native multi-hop route to a discovered destination.",
    ["destination"],
  ),
  actionAdapter(
    "travel",
    "Travel through a discovered warp",
    "Use a live native warp from the current Stardew location.",
    ["warp"],
  ),
  actionAdapter(
    "ride_minecart",
    "Ride a native minecart",
    "Ride one advertised native minecart objective from a live station tile; the Mod re-resolves the network, destination and price on the game thread.",
    ["minecart_station"],
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
    "Use one equipped Basic Hoe on a fresh adjacent diggable artifact spot; source removal and native HoeDirt creation are the completion boundary.",
    ["artifact_spot", "tool"],
  ),
  actionAdapter(
    "chop_tree_source",
    "Chop a one-hit tree source",
    "Use one equipped Axe terminal strike on a live ordinary mature one-hit tree; source transformation is the completion boundary.",
    ["tree_source", "tool"],
  ),
  actionAdapter(
    "express_emote",
    "Express an emote",
    "Express a character emote in the game world.",
    ["character_emote"],
  ),
  actionAdapter(
    "face_direction",
    "Face a cardinal direction",
    "Turn the Farmhand to face a cardinal direction.",
    ["character_facing"],
  ),
  actionAdapter(
    "interact_npc_with_item",
    "Offer an item to an NPC",
    "Offer one carried inventory item to an adjacent villager; a matching quest delivery completes first.",
    ["npc", "inventory_slot"],
  ),
  actionAdapter(
    "pet_animal",
    "Pet a nearby animal",
    "Pet one fresh adjacent pet target; the native interaction requires the pet to still be within one tile at dispatch.",
    ["pet"],
  ),
  actionAdapter(
    "advance_day",
    "Sleep and advance the day",
    "Walk the Farmhand to its own bed, let the native sleep path run, declare local sleep-ready through that same native path, and observe the native save/new-day pipeline. In a shared world the night completes only when every required player is ready, so a barrier that never completes is reported honestly rather than forced.",
    ["own_bed", "day_lifecycle"],
  ),
  actionAdapter(
    "clear_debris",
    "Clear a debris clump",
    "Use the equipped Axe or Pickaxe on a live adjacent ResourceClump; each hit returns its own receipt and only clump removal completes the action.",
    ["debris", "tool"],
  ),
  actionAdapter(
    "npc_relationship",
    "Inspect an NPC relationship",
    "Read one adjacent villager's live relationship facts without changing them.",
    ["npc"],
  ),
  actionAdapter(
    "water_pet_bowl",
    "Water the pet bowl",
    "Use the native Watering Can on the current location's completed, unwatered native Pet Bowl.",
    ["pet_bowl", "watering_can"],
  ),
  actionAdapter(
    "water_slime_hutch_trough",
    "Water a Slime Hutch trough",
    "Use the native Watering Can on an unwatered trough tile inside the current Slime Hutch.",
    ["slime_hutch_trough", "watering_can"],
  ),
  actionAdapter(
    "chest_store",
    "Store an item in a chest",
    "Move one carried inventory stack into a live adjacent chest through the native container path, with no ItemGrabMenu opened.",
    ["chest", "inventory_slot"],
  ),
  actionAdapter(
    "chest_retrieve",
    "Take an item from a chest",
    "Move one observed chest slot's item into the Farmhand inventory through the native container path, bound to the observed qualified item id.",
    ["chest", "inventory"],
  ),
  actionAdapter(
    "chop_stump",
    "Chop a tree stump",
    "Use the equipped Axe on a live ordinary mature tree that is already a stump until the native stump removal completes.",
    ["tree_stump", "tool"],
  ),
  actionAdapter(
    "plant_sapling",
    "Plant a tree sapling",
    "Use the native wild-tree-seed placement path to plant one observed tree sapling on a live lawful tile.",
    ["farm_tile", "inventory_slot"],
  ),
  actionAdapter(
    "cut_weeds",
    "Cut a weed",
    "Use the equipped scythe on a live adjacent Weed through its native tool action until the weed is removed.",
    ["weed", "tool"],
  ),
  actionAdapter(
    "cut_grass",
    "Cut grass",
    "Use the equipped scythe on a live adjacent Grass tuft (a TerrainFeature, distinct from weeds) through its native tool action until the tuft is removed; grassType 1/7 feeds Hay into a silo, grassType 6 drops rare items.",
    ["grass", "tool"],
  ),
  actionAdapter(
    "scythe_crop",
    "Scythe a crop",
    "Use the equipped scythe on a live ready Scythe-method crop; the native harvest leaves the crop removed and the produce on the ground.",
    ["crop", "tool"],
  ),
  actionAdapter(
    "craft_item",
    "Craft an item",
    "Craft one learned recipe from the Farmhand's own inventory through the native recipe path, with honest item conservation evidence.",
    ["recipe", "crafting"],
  ),
  actionAdapter(
    "cook_recipe",
    "Cook a recipe",
    "Cook one learned cooking recipe at a live adjacent cooking station through the native recipe path, with honest item conservation evidence.",
    ["recipe", "cooking"],
  ),
  actionAdapter(
    "collect_crab_pot_output",
    "Collect crab pot output",
    "Collect the ready output of one live adjacent baited Crab Pot through its native interaction.",
    ["crab_pot"],
  ),
  actionAdapter(
    "ship_item",
    "Ship an item",
    "Move one shippable carried inventory stack into the current player's live shipping bin through the native shipping settlement.",
    ["shipping_bin", "inventory_slot"],
  ),
]) satisfies readonly StardewActionAdapter[];

export type StardewActionId =
  (typeof STARDEW_ACTION_ADAPTERS)[number]["actionId"];

/** A current restrictive projection: registration facts remain Mod-owned. */
export type VisibleStardewAction = StardewActionAdapter & ActionRegistration;

/**
 * The Mod must explicitly opt this action into ObservationBinding/v1. A Host
 * schema cannot add that capability when the authenticated registration omits it.
 */
export function acceptsObservationBindingV1(
  registration: ActionRegistration,
): boolean {
  const sceneTarget = registration.descriptor?.sceneTarget;
  return registration.actionId === "pickup_forage" &&
    sceneTarget?.type === "ObservationBinding" &&
    sceneTarget.version === 1 &&
    sceneTarget.required === true &&
    sceneTarget.requiredProperties.length === 2 &&
    sceneTarget.requiredProperties[0] === "observationId" &&
    sceneTarget.requiredProperties[1] === "ref";
}

/**
 * Tool construction remains action-specific, but this closed projection forces
 * every Mod-published identity for which this build has an adapter to have one Host tool adapter name.
 */
export const STARDEW_ACTION_TOOL_NAMES = {
  move_to_tile: "stardew_move_to_tile",
  equip_tool: "stardew_equip_tool",
  navigate_to_destination: "stardew_navigate_to_destination",
  travel: "stardew_travel",
  ride_minecart: "stardew_ride_minecart",
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
  express_emote: "stardew_express_emote",
  face_direction: "stardew_face_direction",
  interact_npc_with_item: "stardew_interact_npc_with_item",
  pet_animal: "stardew_pet_animal",
  advance_day: "stardew_advance_day",
  clear_debris: "stardew_clear_debris",
  npc_relationship: "stardew_npc_relationship",
  water_pet_bowl: "stardew_water_pet_bowl",
  water_slime_hutch_trough: "stardew_water_slime_hutch_trough",
  chest_store: "stardew_chest_store",
  chest_retrieve: "stardew_chest_retrieve",
  chop_stump: "stardew_chop_stump",
  plant_sapling: "stardew_plant_sapling",
  cut_weeds: "stardew_cut_weeds",
  cut_grass: "stardew_cut_grass",
  scythe_crop: "stardew_scythe_crop",
  craft_item: "stardew_craft_item",
  cook_recipe: "stardew_cook_recipe",
  collect_crab_pot_output: "stardew_collect_crab_pot_output",
  ship_item: "stardew_ship_item",
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

// Actions whose Host tool schema is derived from the Mod-owned descriptor rather
// than a static Host adapter. Membership is about how the arguments are built,
// not about lifecycle: a member may be Experimental (admitted through the
// candidate carve-out) or already live_verified.
export const STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS = Object.freeze([
  "express_emote",
  "face_direction",
  "interact_npc_with_item",
  "pet_animal",
  "advance_day",
  "ride_minecart",
] as const);

export type StardewDescriptorDerivedActionId = (typeof STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS)[number];

export function isDescriptorDerivedActionId(actionId: string): actionId is StardewDescriptorDerivedActionId {
  return (STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS as readonly string[]).includes(actionId);
}

export function getDescriptorArgument(
  descriptor: ActionRegistration["descriptor"],
  argumentName: string,
): { name: string; type: string; enum?: readonly string[]; boundedEnumValues?: readonly string[] } | undefined {
  if (!descriptor) return undefined;
  if (Array.isArray(descriptor.arguments)) {
    const found = descriptor.arguments.find((arg) => arg.name === argumentName);
    if (found) return found;
  }
  if (descriptor.argumentSchema && isRecord(descriptor.argumentSchema)) {
    const schema = descriptor.argumentSchema[argumentName];
    if (schema) {
      return {
        name: argumentName,
        type: schema.type,
        ...(schema.enum === undefined ? {} : { enum: schema.enum }),
      };
    }
  }
  return undefined;
}

export function getArgumentEnum(
  argument: { enum?: readonly string[]; boundedEnumValues?: readonly string[] } | undefined,
): readonly string[] | undefined {
  if (!argument) return undefined;
  if (Array.isArray(argument.enum) && argument.enum.length > 0) return argument.enum;
  if (Array.isArray(argument.boundedEnumValues) && argument.boundedEnumValues.length > 0) return argument.boundedEnumValues;
  return undefined;
}

export function isModDescriptorComplete(
  actionId: string,
  descriptor: ActionRegistration["descriptor"],
): boolean {
  if (!descriptor || !isValidActionDescriptor(descriptor)) return false;
  if (actionId === "express_emote") {
    const arg = getDescriptorArgument(descriptor, "emote");
    if (!arg || arg.type !== "string") return false;
    const enumVals = getArgumentEnum(arg);
    if (!enumVals || enumVals.length === 0) return false;
    if (descriptor.effect !== "write") return false;
    if (!descriptor.postcondition) return false;
    if (!descriptor.nativeBinding) return false;
    return true;
  }
  if (actionId === "face_direction") {
    const arg = getDescriptorArgument(descriptor, "direction");
    if (!arg || arg.type !== "string") return false;
    const enumVals = getArgumentEnum(arg);
    if (!enumVals || enumVals.length === 0) return false;
    if (descriptor.effect !== "write") return false;
    if (!descriptor.postcondition) return false;
    if (!descriptor.nativeBinding) return false;
    return true;
  }
  if (actionId === "interact_npc_with_item") {
    // The offer routes through the native GameLocation.checkAction ingress
    // (not a single method binding), so the complete-descriptor gate covers
    // the exact five-argument shape and the write postcondition instead.
    const argumentNames = (descriptor.arguments ?? []).map((argument) => argument.name);
    const expected = ["x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId"];
    if (JSON.stringify(argumentNames) !== JSON.stringify(expected)) return false;
    if (descriptor.effect !== "write") return false;
    if (!descriptor.postcondition) return false;
    return true;
  }
  if (actionId === "pet_animal") {
    // An animal moves between observation and dispatch, so the pet target is
    // bound by identity (expectedTargetId) with live coordinates as geometry,
    // matching the Mod's identity-locked admission.
    const argumentNames = (descriptor.arguments ?? []).map((argument) => argument.name);
    const expected = ["x", "y", "expectedTargetId"];
    if (JSON.stringify(argumentNames) !== JSON.stringify(expected)) return false;
    if (descriptor.effect !== "write") return false;
    if (!descriptor.postcondition) return false;
    return true;
  }
  if (actionId === "ride_minecart") {
    // The station tile plus one opaque advertised ride selector, both mandatory:
    // `ride_minecart` has no "plain warp" form, unlike `travel`.
    const argumentNames = (descriptor.arguments ?? []).map((argument) => argument.name);
    const expected = ["x", "y", "expectedTargetId"];
    if (JSON.stringify(argumentNames) !== JSON.stringify(expected)) return false;
    if (descriptor.effect !== "write") return false;
    if (descriptor.postcondition !== "minecart_ride_completed") return false;
    return true;
  }
  if (actionId === "advance_day") {
    // The night carries no arguments at all: the bed and the ready state are
    // native facts, so the complete-descriptor gate is the empty argument list
    // plus the declared day-advanced postcondition.
    if ((descriptor.arguments ?? []).length !== 0) return false;
    if (descriptor.effect !== "write") return false;
    if (descriptor.postcondition !== "day_advanced") return false;
    return true;
  }
  return false;
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
    // Two admission paths. The ordinary one is lifecycle: `published` or
    // `live_verified` means the action already proved itself, either with a live
    // run (live_verified) or with the full publication process behind it. The
    // other is the descriptor-derived carve-out, which lets a still-Experimental
    // action out only once its Mod-owned descriptor is complete.
    const isAdmittedDescriptorDerived =
      isDescriptorDerivedActionId(registration.actionId) &&
      isModDescriptorComplete(registration.actionId, registration.descriptor);
    if (
      adapter === undefined ||
      !adapter.supportedIdentityVersions.includes(registration.identityVersion) ||
      (registration.lifecycle !== "published" &&
        registration.lifecycle !== "live_verified" &&
        !isAdmittedDescriptorDerived) ||
      registration.kind !== "execution" ||
      !live.has(adapter.requiredCapability) ||
      deniedActions.has(registration.actionId) ||
      deniedFamilies.has(registration.familyId) ||
      (registration.actionId === "pickup_forage" && !acceptsObservationBindingV1(registration))
    ) {
      continue;
    }
    // A descriptor-derived action is always subject to the completeness gate,
    // whichever path admitted it: live_verified records that a run succeeded, it
    // does not guarantee the Mod still sends a usable argument shape.
    if (
      isDescriptorDerivedActionId(registration.actionId) &&
      !isModDescriptorComplete(registration.actionId, registration.descriptor)
    ) {
      continue;
    }
    visible.push(
      Object.freeze({
        ...adapter,
        familyId: registration.familyId,
        identityVersion: registration.identityVersion,
        lifecycle: registration.lifecycle,
        kind: registration.kind,
        ...(registration.descriptor !== undefined
          ? { descriptor: registration.descriptor }
          : {}),
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
  // Match the words, not the whole phrase. A caller searching the surface asks
  // in words - a live trace shows "Jodi npc gift" and "npc gift" - and a single
  // substring test matched none of those whole strings, so the search reported
  // an empty surface and the caller stopped believing the capability existed.
  // Every word must appear (AND); matching is against the action's own identity,
  // label, description and the target kinds the adapter itself declares.
  const words = normalized.split(/\s+/u).filter((word) => word.length > 0);
  return visible.filter((entry) => {
    const haystack = [entry.actionId, entry.familyId, entry.label, entry.description, ...entry.targetKinds]
      .join(" ")
      .toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  });
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
    supportedIdentityVersions: Object.freeze([1]),
  });
}
