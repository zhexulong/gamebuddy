import {
  type ActionDescriptorArgument,
  type ActionRegistration,
  type ActionRegistrationDescriptor,
  isValidActionDescriptor,
} from "./protocol.js";

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
    "place_owned_object",
    "Place an owned object",
    "Place one owned placeable object (any bigCraftable, including a tapper, or furniture) on a published world tile. Read the opaque target id, its tile, the backpack slot and the item id from the `worldObjectTargets` entries of the most recent observation. The Mod re-resolves the target on the game thread, calls the game's own Object.placementAction, and proves the object now exists on that tile; an occupied tile is refused by name rather than silently adding nothing.",
    ["world_object"],
  ),
  actionAdapter(
    "remove_placed_item",
    "Remove a placed object",
    "Remove one object occupying a world tile with the named axe or pickaxe. Read the opaque target id, its tile and the tool slot from the `worldObjectTargets` entry of the most recent observation, and equip that tool first. A tool that cannot remove that exact object is refused by name (`remove_placed_item_tool_cannot_remove_target`), never reported as a silent no-op, and the postcondition is the object being GONE from the tile.",
    ["world_object"],
  ),
  actionAdapter(
    "move_placed_furniture",
    "Pick up placed furniture",
    "Pick up one piece of already-placed furniture - a chair, a table, a rug you put there earlier - into the backpack, so it can be put down somewhere else. Read the `placed_furniture` target id and its tile from the `worldObjectTargets` entry of the most recent observation. Furniture is not an object on the tile: the Mod resolves the piece from the location's own furniture collection and re-validates the tile, the piece's id and the game's furniture reach on the game thread. Success is the piece gone from the room AND one more in the pack; if the pack has no room the piece is put back exactly where it stood and the action is refused by name (`move_placed_furniture_inventory_full`), never reported as a silent loss.",
    ["world_object"],
  ),
  actionAdapter(
    "rotate_furniture",
    "Rotate placed furniture",
    "Turn one already-placed piece of furniture one step through its own rotation cycle, in place. Read the `placed_furniture` target id and its tile from the `worldObjectTargets` entry of the most recent observation; there is no angle argument, because the piece's own `rotations` data decides whether it alternates 0 <-> 2 or steps 0 -> 1 -> 2 -> 3 -> 0. A piece with fewer than two rotations is refused by name (`furniture_rotation_unsupported`), never reported as a turn that did nothing, and the postcondition is the piece's `currentRotation` changed with the piece still standing on the same tile.",
    ["world_object"],
  ),
  actionAdapter(
    "remove_fence",
    "Remove a placed fence",
    "Take one placed fence or fence gate off its tile with the tool the game's own fence data accepts. Read the object target id, its tile and the tool slot from the `worldObjectTargets` entry of the most recent observation. The fence's own `performToolAction` returns false on every branch, including the one that destroyed it, so the postcondition is the fence GONE from the location's objects plus the drops it produced; a tool that cannot remove that exact fence is refused by name (`remove_fence_tool_cannot_remove_target`), never reported as an uncertain result after the swings.",
    ["world_object"],
  ),
  actionAdapter(
    "put_item_in_fish_tank",
    "Put an item in a fish tank",
    "Put one backpack item into a placed fish tank, letting the tank's own `CanBeDeposited` rule decide whether it may hold it. Read the tank's `placed_furniture` target id and tile, the source slot and the item's qualified id from the `worldObjectTargets` entry of the most recent observation. The postcondition is the tank holding exactly one more item, that one, while the pack lost exactly one; an item the tank will not hold is refused by name (`fish_tank_rejects_item`), and a deposit the engine took the item for but never completed is put back and reported as `fish_tank_deposit_not_observed`, never as a success.",
    ["world_object"],
  ),
  actionAdapter(
    "place_item_on_pedestal",
    "Place an item on a pedestal",
    "Place one backpack item on an empty pedestal, whose own drop-in action decides acceptance. Read the `empty_pedestal` target id, its tile, the source slot and the item's qualified id from the `worldObjectTargets` entry of the most recent observation. An occupied pedestal is refused by name (`pedestal_occupied`) before the call, because the pedestal's own branch knocks the standing item off and answers false; the postcondition is the pedestal's `heldObject` being this item while the pack lost exactly one.",
    ["world_object"],
  ),
  actionAdapter(
    "break_container",
    "Break a container",
    "Break one breakable container (a mine barrel or crate) with the equipped heavy hitter. Read the opaque target id and its tile from the `worldObjectTargets` entries of the most recent observation. The native call returns false even when it destroys the container, so the receipt's postcondition is the container being GONE plus the drops the game produced.",
    ["world_object"],
  ),
  actionAdapter(
    "open_geode",
    "Open a geode",
    "Crack one carried geode at the blacksmith's own counter, through the game's GeodeMenu, so the machine's own assignment and fee decide what comes out. `slot` and `expectedQualifiedItemId` must be copied exactly from the `inventoryItemFacts` row of the MOST RECENT observe result: the slice the geode occupies is checked against that id before anything is consumed, so a stale pair is refused rather than opening a different item. The fee is charged and the reward is placed in the backpack by the menu itself; a counter the actor cannot reach, a fee it cannot pay and a full backpack are each refused by name, and the postcondition is the geode gone and the reward in the pack.",
    ["inventory_slot", "geode"],
  ),
  actionAdapter("move_to_tile", "Move to a Stardew tile", "Move the Farmhand to a live, structured target tile.", [
    "tile",
  ]),
  actionAdapter("equip_tool", "Equip a tool", "Select a Tool already owned by the Farmhand.", ["inventory_slot"]),
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
    "select_mine_elevator_floor",
    "Use the mine elevator",
    "Select an already-reached floor on the mine elevator. The offered floors are derived by the Mod from the live lowest level reached, so a level the player has not unlocked cannot be requested.",
    ["mine_elevator_floor"],
  ),
  actionAdapter(
    "shop_purchase",
    "Buy from a shop",
    "Buy goods from a shop whose owner is standing within reach. The Mod reads the shop, its owner eligibility and its stock from the game's own content data, and the purchase runs through the game's shop menu. It does not walk: move into reach first, or the call is refused with shop_counter_out_of_reach.",
    ["shop"],
  ),
  actionAdapter(
    "ride_bus",
    "Ride the bus",
    "Ride the native bus from the Bus Stop ticket machine to the desert; the Mod checks the vault, the driver and the fare itself and drives the game's own ticket interaction.",
    ["bus_ticket_machine"],
  ),
  actionAdapter(
    "withdraw_silo_hay",
    "Take hay out of a silo",
    "Withdraw one hay from a discovered silo. The Mod re-resolves the silo from the opaque target id and asserts both halves of the move (the silo store drops and the carried hay rises), so a one-sided change is never reported as success.",
    ["silo"],
  ),
  actionAdapter(
    "toggle_animal_door",
    "Toggle an animal door",
    "Open or close a barn or coop animal door. The Mod re-resolves the building from the opaque target id and asserts the door STATE FLIPPED, reading it from the world after the call rather than trusting the native void return.",
    ["animal_door"],
  ),
  actionAdapter(
    "use_obelisk",
    "Use a warp obelisk",
    "Activate a discovered warp obelisk. The Mod chooses the destination from the target itself (a Data/Buildings obelisk, or the island farm obelisk tile), so the caller names the structure and never a destination.",
    ["obelisk"],
  ),
  actionAdapter(
    "use_raft",
    "Launch a raft",
    "Use the equipped native Raft on an adjacent water tile to begin rafting.",
    ["raft", "water_tile"],
  ),
  actionAdapter("mount_transport", "Mount a named horse", "Mount one advertised named native horse.", ["horse"]),
  actionAdapter(
    "enter_mine",
    "Enter the mine",
    "Enter the live mine entrance. The destination level comes from the entrance tile's own declaration, exactly as it does for a real click, so no client level is accepted.",
    ["mine_entrance"],
  ),
  actionAdapter(
    "use_mine_ladder",
    "Leave the mine by its ladder",
    "Leave the mine level you are standing in through its own exit ladder. Read the ladder tile and its opaque target id from the mineEntranceTargets entries of the most recent observation: the game opens its own Leave question and the warp is the game's, so nothing about the destination is client-supplied. A tile that belongs to the descending ladder is refused by name and points at stardew_enter_mine.",
    ["mine_entrance"],
  ),
  actionAdapter(
    "enter_exit",
    "Enter or exit through a discovered door",
    "Use a live native door transition from the current Stardew location.",
    ["door", "building_entrance"],
  ),
  actionAdapter("till_soil", "Till a soil tile", "Use a native Hoe on a live soil target.", ["soil_tile"]),
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
  actionAdapter("water_crop", "Water a live crop", "Use the native Watering Can on a live unwatered crop.", ["crop"]),
  actionAdapter(
    "refill_watering_can",
    "Refill a Watering Can",
    "Refill one selected, partially filled Watering Can from a live adjacent native water source.",
    ["watering_can", "water_source", "inventory_slot"],
  ),
  actionAdapter(
    "fish_here",
    "Fish a live water tile",
    "Cast at one water tile the engine itself says a rod may be cast at, wait for the engine's own bite, and let the engine's own win path credit the catch. Every refusal happens before the cast: no rod, no bait the rod needs, water the engine refuses, or too little stamina. The fish, its size, its quality and the bait and tackle consumption are all the engine's own.",
    ["water_source"],
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
  actionAdapter("harvest_crop", "Harvest a ready crop", "Use native Crop.harvest on a live ready ordinary crop.", [
    "crop",
    "inventory",
  ]),
  actionAdapter(
    "break_rock",
    "Break a rock",
    "Use one equipped basic Pickaxe swing on a live ordinary breakable stone; a rock that loses durability is progress, and drops/pickup are separate.",
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
    "chop_tree",
    "Chop a tree",
    "Chop one live ordinary mature tree: the Mod swings the equipped Axe until the tree is felled. Felling is the completion boundary, and the receipt names the health pair and the swing count.",
    ["tree_source", "tool"],
  ),
  actionAdapter("express_emote", "Express an emote", "Express a character emote in the game world.", [
    "character_emote",
  ]),
  actionAdapter("face_direction", "Face a cardinal direction", "Turn the Farmhand to face a cardinal direction.", [
    "character_facing",
  ]),
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
    "pet_farm_animal",
    "Pet a farm animal",
    "Pet one farm animal - a cow, chicken, sheep, pig, duck, rabbit or dinosaur - in the barn, coop or farm you are standing in. Read the opaque target id, its tile and its current friendship from the `farmAnimalPetTargets` entries of the MOST RECENT observation for the current location (never invent coordinates), and walk into reach first if it is far away. The Mod re-resolves the animal from its live tile and calls the game's own `FarmAnimal.pet`, so the +15 friendship, the happiness and the daily `wasPet` marker are the engine's own. Refused by name when a pet would change nothing: `farm_animal_already_petted_today`, `farm_animal_cracker_would_be_consumed` (a held Golden Animal Cracker would be spent instead of petting), `farm_animal_pet_requires_movement_after_1900` (after 19:00 only an animal that is moving can be petted), `farm_animal_target_gone`, `target_out_of_reach`. Returns `farm_animal_petted` with the friendship before and after.",
    ["farm_animal"],
  ),
  actionAdapter(
    "sleep",
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
    "break_resource_clump",
    "Break a large stump, log or boulder",
    "Use the Axe or Pickaxe this clump's own native requirement demands on a live large stump, hollow log, boulder or meteorite. x, y and expectedTargetId must be copied exactly from the debrisTargets entries of the MOST RECENT observe result (never invent or guess coordinates). The handler selects that tool and restores the actor's own selection, so the request names no slot and the actor need not be holding it; a pack that cannot supply the level the clump needs is refused clump_tool_too_weak. One call swings until the clump is gone and returns succeeded/clump_broken, or uncertain/postcondition_not_observed when the clump survived.",
    ["debris", "tool"],
  ),
  actionAdapter(
    "npc_relationship",
    "Inspect an NPC relationship",
    "Read one adjacent villager's live relationship facts without changing them.",
    ["npc"],
  ),
  actionAdapter(
    "talk_to_npc",
    "Talk to a villager",
    "Talk to an adjacent villager through the native NPC.checkAction talk branch, which mounts the game's own dialogue. The actor must be empty-handed: with an item in hand the native entry takes the gift path instead (interact_npc_with_item), and the action refuses with hands_not_empty. A villager who is asleep or out of reach is refused in the native branch's own terms.",
    ["npc", "dialogue"],
  ),

  actionAdapter(
    "equip_wearable",
    "Equip a wearable you own",
    "Put one wearable from a named backpack slot onto the farmer's own body slot, through the native Farmer.Equip<TItem> the inventory UI itself ends in. expectedTargetId must be copied exactly from the wearableTargets entries of the MOST RECENT observe result, and the named body slot must be the one that item type belongs to (a hat cannot go on the boots slot). A repeat of an already-satisfied request answers wearable_already_equipped as a success.",
    ["wearable"],
  ),
  actionAdapter(
    "unequip_wearable",
    "Unequip a wearable",
    "Take the wearable off the farmer's own body slot into a named EMPTY backpack slot. It refuses (wearable_inventory_full) when the backpack has no free slot at all, because the removed item would otherwise be dropped on the ground; it refuses (wearable_destination_slot_occupied) when the named slot is not free.",
    ["wearable"],
  ),
  actionAdapter(
    "dismount_transport",
    "Dismount the horse",
    "End the farmer's own mounted state through the native Horse.dismount terminal. It carries no arguments: the postcondition is !who.isRidingHorse(), re-read from the world after the call.",
    ["horse"],
  ),
  actionAdapter(
    "use_warp_item",
    "Use a warp totem you are holding",
    "Consume a held warp totem through the game's own object-use path and ride the warp the totem itself names. slot and expectedQualifiedItemId must come from the warpItemTargets of the most recent observation; only the arrival postcondition reports success.",
    ["totem", "travel"],
  ),
  actionAdapter(
    "pan_ore",
    "Pan a water spot for ore",
    "Pan an ore-panning spot with the Copper Pan the farmer holds, through the native Pan.DoFunction. The tile is re-checked against the game's own live panning point, so a stale site is refused rather than panned.",
    ["pan", "ore"],
  ),
  actionAdapter(
    "clear_fish_pond",
    "Empty a fish pond",
    "Empty a built fish pond of every occupant through the pond own FishPond.ClearPond settlement. The fish are NOT destroyed: the native body spawns one fish item per occupant as ground debris, and the pond is reset. Read the opaque target id, its tile and the occupant count from the `fishPondTargets` projection, and expect everything in the pond to end up on the ground.",
    ["fish_pond"],
  ),
  actionAdapter(
    "send_multiplayer_chat",
    "Say one line to the lobby",
    "Send one chat line to the whole multiplayer lobby through the game own chat egress (Multiplayer.sendChatMessage), which owns the client/server branch and the receiving side word filter. It takes exactly one string, moves nobody and touches no inventory, and its receipt proves the SEND only - never that anyone read it.",
    ["chat"],
  ),
  actionAdapter(
    "build_farm_building",
    "Commission a farm building",
    "Commission a farm building through the game own GameLocation.buildStructure settlement, which charges the Data/Buildings build cost and materials the game itself declares and leaves a freshly placed building with a durable id. Read the opaque site id, its tile and the building type from the `farmBuildingTargets` projection; a site the game no longer accepts is refused by name rather than built.",
    ["buildings"],
  ),
  actionAdapter(
    "accept_daily_quest",
    "Accept the day's posted quest",
    "Accept the help-wanted quest the town has posted for today through the game own Quest.accept settlement, which writes the quest log and the day flag. The board is only where a player reads the offer; the action names the quest by the opaque id the `dailyQuestTargets` projection published and refuses by name when there is nothing acceptable or it was already accepted.",
    ["quests"],
  ),
  actionAdapter(
    "name_entity",
    "Name your horse",
    "Give the farm's own horse its name through the game's own naming settlement (Horse.nameHorse), the very body the naming menu's callback is bound to. The subject is the ACTOR'S OWN horse - it takes no target id - and the name is its only input. A horse that already has a name is refused by name, and the receipt reports the name READ BACK from the entity.",
    ["horse", "name"],
  ),
  actionAdapter(
    "claim_mail_attachment",
    "Claim a mailbox attachment",
    "Claim whatever is waiting in a mailbox, completing a letter whose %item attachment has to be delivered rather than discarding it. The opaque target id binds the location, the tile and the pending letter.",
    ["mail", "mailbox"],
  ),
  actionAdapter(
    "load_building_chest",
    "Load a building chest",
    "Put the held item into a storage chest the BUILDING itself declares, such as a Mill's input chest, through the native Load branch. The requested slot must be the one already held.",
    ["building_chest"],
  ),
  actionAdapter(
    "collect_building_chest_output",
    "Collect building chest output",
    "Take what a building's own output chest holds. A chest holding two or more stacks is refused by name rather than opening a container menu.",
    ["building_chest"],
  ),
  actionAdapter(
    "water_pet_bowl",
    "Water the pet bowl",
    "Use the native Watering Can on the current location's completed, unwatered native Pet Bowl.",
    ["pet_bowl", "watering_can"],
  ),
  actionAdapter(
    "dismiss_modal",
    "Dismiss a dialog",
    "Clear a native menu that is holding the character, through the same close path the menu itself uses. Covers an informational dialogue with no pending question, and the day-end settlement summary (ShippingMenu) that a rollover leaves on screen - the two menus whose close commits nothing to the world. A question dialogue is `answer_dialogue`, and a level-up is `respond_level_up`.",
    ["dialogue", "modal"],
  ),
  actionAdapter(
    "answer_dialogue",
    "Answer a dialogue",
    "Choose one response from the currently displayed native question dialogue.",
    ["dialogue", "modal"],
  ),
  actionAdapter(
    "respond_level_up",
    "Settle a level-up",
    "Confirm an ordinary level-up or choose one of the two profession branches the displayed LevelUpMenu offers.",
    ["modal", "level_up"],
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
    "clear_cask",
    "Clear a cask",
    "Use an equipped Axe, Pickaxe, or Hoe on a live adjacent Cask, removing its held output or the empty Cask through the native tool path.",
    ["cask", "tool"],
  ),
  actionAdapter(
    "dress_mannequin",
    "Dress a mannequin",
    "Put a held hat, clothing item, or boots onto a live adjacent mannequin through its native drop-in path.",
    ["mannequin", "inventory_slot"],
  ),
  actionAdapter(
    "set_sign_display",
    "Set a sign display",
    "Display the held item on a live adjacent sign through its native action.",
    ["sign", "inventory_slot"],
  ),
  actionAdapter(
    "deposit_silo_hay",
    "Deposit silo hay",
    "Store held Hay in a live adjacent Farm Silo using the native hay-capacity path.",
    ["silo", "inventory_slot"],
  ),
  actionAdapter(
    "toggle_tool_light",
    "Toggle tool light",
    "Toggle the currently equipped Lantern through its native DoFunction path.",
    ["tool"],
  ),
  actionAdapter(
    "harvest_bush",
    "Harvest a berry bush",
    "Use the native berry-bush interaction on a live, ready bush and verify its fruit debris appears.",
    ["bush", "forage"],
  ),
  actionAdapter(
    "harvest_fruit_tree",
    "Harvest a fruit tree",
    "Use the native fruit-tree interaction and verify fruit debris appears.",
    ["fruit_tree", "forage"],
  ),
  actionAdapter(
    "shake_tree",
    "Shake a tree",
    "Shake one live tree that has not been shaken today and verify its seed state changes.",
    ["tree", "forage"],
  ),
  actionAdapter(
    "take_pedestal_item",
    "Take a pedestal item",
    "Take the displayed item through the native pedestal inventory transaction.",
    ["pedestal", "inventory"],
  ),
  actionAdapter(
    "toggle_fence_gate",
    "Toggle a fence gate",
    "Toggle one live fence gate through its native gate state transition.",
    ["fence_gate"],
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
  actionAdapter(
    "accept_special_order",
    "Accept an offered special order",
    "Accept one of the special orders a board is offering through the game own FarmerTeam.AddSpecialOrder settlement, and record the board as used exactly as the board own Accept button does. Read the opaque target id, the `questKey` and the `orderType` from the `specialOrderTargets` projection; the Mod re-resolves the offer against the live pool and refuses by name when it is gone, already active, or its board has already been used.",
    ["quests"],
  ),
  actionAdapter(
    "claim_museum_reward",
    "Collect the museum rewards you are owed",
    "Collect every museum donation reward this player is entitled to, through the two native members the reward menu own flow uses (`LibraryMuseum.getRewardsForPlayer`, which both lists the items and grants the non-item rewards, and `LibraryMuseum.OnRewardCollected`, the menu own grab callback). Read the opaque target id and the `rewardCount` from the `museumRewardTargets` projection; a museum with nothing to collect is refused by name.",
    ["museum", "rewards"],
  ),
  actionAdapter(
    "redeem_prize_ticket",
    "Redeem a prize ticket",
    "Redeem one prize ticket at the machine through the same public call sequence the machine own reward branch performs: the prize the game own track derives, the native delivery, the ticket reduction and the ticketPrizesClaimed stat. It takes NO arguments - the subject is your own ticket stack and the machine own track position, both native state - and the receipt proves BOTH halves: the ticket stack fell by exactly one AND the prize entered your pack. It refuses by name when you hold no ticket (prize_ticket_unavailable) or your pack cannot take the prize (prize_inventory_full).",
    ["prize_ticket"],
  ),
  actionAdapter(
    "tailor_clothing",
    "Tailor clothing from a recipe pair",
    "Consume the cloth and the reagent a live sewing-machine recipe pairs and produce that recipe's garment into your backpack through the game own `TailoringMenu.CraftItem` settlement. Read the opaque target id, the two backpack slots (`leftSlot`/`rightSlot`) and the produced item id from the `tailoringTargets` entries of the most recent observation; the Mod re-reads both named slots on the game thread and refuses by name when the pair no longer mints the published id. When the garment only partly fits, the receipt says so (`clothing_tailoring_output_dropped`) rather than claiming a full success.",
    ["tailoring", "inventory_slot"],
  ),
  actionAdapter(
    "color_placed_object",
    "Repaint a placed chest",
    "Repaint one placed chest with one of the game's own 21 palette colours. Read the opaque target id, its tile and the `color` it already carries from the `colorTargets` entries of the most recent observation, then name the palette index (`colorSelection`) the chest should carry. Only the palette colours are writable, so no RGB value is accepted; a repaint to the colour it already has is refused by name rather than reported as a change.",
    ["world_object", "container"],
  ),
  actionAdapter(
    "dye_clothing_with_item",
    "Dye clothing with one item",
    "Recolour one existing garment from one dye item through the game own `TailoringMenu.DyeItems` route. Read the opaque target id, the garment slot (`leftSlot`), the dye slot (`rightSlot`) and the garment's CURRENT `garmentColour` from the `tailoringTargets` entries of the most recent observation. The receipt proves the dye was spent AND the colour moved (or stayed where it was when the dye carries the same colour), and reports before/expected/after; a colour that did not settle is never reported as success.",
    ["tailoring", "inventory_slot"],
  ),
]) satisfies readonly StardewActionAdapter[];

export type StardewActionId = (typeof STARDEW_ACTION_ADAPTERS)[number]["actionId"];

/** A current restrictive projection: registration facts remain Mod-owned. */
export type VisibleStardewAction = StardewActionAdapter & ActionRegistration;

/**
 * Tool construction remains action-specific, but this closed projection forces
 * every Mod-published identity for which this build has an adapter to have one Host tool adapter name.
 */
export const STARDEW_ACTION_TOOL_NAMES = {
  move_to_tile: "stardew_move_to_tile",
  equip_tool: "stardew_equip_tool",
  navigate_to_destination: "stardew_navigate_to_destination",
  travel: "stardew_travel",
  shop_purchase: "stardew_shop_purchase",
  ride_minecart: "stardew_ride_minecart",
  select_mine_elevator_floor: "stardew_select_mine_elevator_floor",
  ride_bus: "stardew_ride_bus",
  use_raft: "stardew_use_raft",
  mount_transport: "stardew_mount_transport",
  enter_mine: "stardew_enter_mine",
  use_mine_ladder: "stardew_use_mine_ladder",
  enter_exit: "stardew_enter_exit",
  till_soil: "stardew_till_soil",
  pickup_forage: "stardew_pickup_forage",
  pickup_item: "stardew_pickup_item",
  water_crop: "stardew_water_crop",
  refill_watering_can: "stardew_refill_watering_can",
  fish_here: "stardew_fish_here",
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
  break_rock: "stardew_break_rock",
  clear_hoedirt: "stardew_clear_hoedirt",
  dig_artifact_spot: "stardew_dig_artifact_spot",
  chop_tree: "stardew_chop_tree",
  express_emote: "stardew_express_emote",
  face_direction: "stardew_face_direction",
  interact_npc_with_item: "stardew_interact_npc_with_item",
  talk_to_npc: "stardew_talk_to_npc",
  equip_wearable: "stardew_equip_wearable",
  unequip_wearable: "stardew_unequip_wearable",
  dismount_transport: "stardew_dismount_transport",
  use_warp_item: "stardew_use_warp_item",
  pan_ore: "stardew_pan_ore",
  claim_mail_attachment: "stardew_claim_mail_attachment",
  load_building_chest: "stardew_load_building_chest",
  collect_building_chest_output: "stardew_collect_building_chest_output",
  pet_animal: "stardew_pet_animal",
  pet_farm_animal: "stardew_pet_farm_animal",
  sleep: "stardew_sleep",
  clear_debris: "stardew_clear_debris",
  break_resource_clump: "stardew_break_resource_clump",
  open_geode: "stardew_open_geode",
  npc_relationship: "stardew_npc_relationship",
  water_pet_bowl: "stardew_water_pet_bowl",
  dismiss_modal: "stardew_dismiss_modal",
  answer_dialogue: "stardew_answer_dialogue",
  respond_level_up: "stardew_respond_level_up",
  water_slime_hutch_trough: "stardew_water_slime_hutch_trough",
  chest_store: "stardew_chest_store",
  chest_retrieve: "stardew_chest_retrieve",
  chop_stump: "stardew_chop_stump",
  plant_sapling: "stardew_plant_sapling",
  cut_weeds: "stardew_cut_weeds",
  cut_grass: "stardew_cut_grass",
  clear_cask: "stardew_clear_cask",
  dress_mannequin: "stardew_dress_mannequin",
  set_sign_display: "stardew_set_sign_display",
  deposit_silo_hay: "stardew_deposit_silo_hay",
  toggle_tool_light: "stardew_toggle_tool_light",
  scythe_crop: "stardew_scythe_crop",
  craft_item: "stardew_craft_item",
  cook_recipe: "stardew_cook_recipe",
  collect_crab_pot_output: "stardew_collect_crab_pot_output",
  ship_item: "stardew_ship_item",
  harvest_bush: "stardew_harvest_bush",
  harvest_fruit_tree: "stardew_harvest_fruit_tree",
  shake_tree: "stardew_shake_tree",
  take_pedestal_item: "stardew_take_pedestal_item",
  toggle_fence_gate: "stardew_toggle_fence_gate",
  withdraw_silo_hay: "stardew_withdraw_silo_hay",
  toggle_animal_door: "stardew_toggle_animal_door",
  clear_fish_pond: "stardew_clear_fish_pond",
  send_multiplayer_chat: "stardew_send_multiplayer_chat",
  name_entity: "stardew_name_entity",
  build_farm_building: "stardew_build_farm_building",
  accept_daily_quest: "stardew_accept_daily_quest",

  place_owned_object: "stardew_place_owned_object",
  remove_placed_item: "stardew_remove_placed_item",
  move_placed_furniture: "stardew_move_placed_furniture",
  rotate_furniture: "stardew_rotate_furniture",
  remove_fence: "stardew_remove_fence",
  put_item_in_fish_tank: "stardew_put_item_in_fish_tank",
  place_item_on_pedestal: "stardew_place_item_on_pedestal",
  break_container: "stardew_break_container",
  use_obelisk: "stardew_use_obelisk",
  accept_special_order: "stardew_accept_special_order",
  claim_museum_reward: "stardew_claim_museum_reward",
  redeem_prize_ticket: "stardew_redeem_prize_ticket",
  tailor_clothing: "stardew_tailor_clothing",
  dye_clothing_with_item: "stardew_dye_clothing_with_item",
  color_placed_object: "stardew_color_placed_object",
} as const satisfies Record<StardewActionId, `stardew_${string}`>;

/**
 * Removed roadmap labels are not registry/policy identifiers. They intentionally
 * have no automatic successor: several map to different finite capabilities
 * whose implementation and live gates do not yet exist. Config migration must
 * therefore be explicit and fail closed instead of silently broadening a deny.
 */
export const RETIRED_ACTION_POLICY_MIGRATIONS = Object.freeze({
  collect_resource: Object.freeze(["chop_tree", "break_rock", "pickup_item"]),
  use_tool: Object.freeze(["tool_transform_object", "chop_tree", "break_rock", "clear_hoedirt"]),
  combat_attack: Object.freeze(["melee_attack", "ranged_attack", "weapon_special"]),
  place_item: Object.freeze([
    "place_decor_or_furniture",
    "place_fence_or_gate",
    "place_tapper",
    "place_crab_pot",
    "place_explosive",
  ]),
  transfer_item: Object.freeze(["transfer_to_container", "transfer_from_container"]),
  manage_animal: Object.freeze(["toggle_animal_door", "clear_fish_pond", "purchase_animal", "sell_or_relocate_animal"]),
  world_interact: Object.freeze(["execute_world_operation"]),
  // The one SOCIAL act that is not about an NPC in front of the actor: a line to the whole lobby.
  send_multiplayer_chat: Object.freeze(["send_multiplayer_chat"]),
  // Naming the farm's own horse: a synchronous write with no target id.
  name_entity: Object.freeze(["name_entity"]),
  special_interact: Object.freeze(["execute_world_operation"]),
  festival_interact: Object.freeze([
    "submit_festival_entry",
    "start_minigame_phase",
    "control_minigame_phase",
    "claim_minigame_or_festival_reward",
  ]),
  minigame_play: Object.freeze(["start_minigame_phase", "control_minigame_phase", "claim_minigame_or_festival_reward"]),
  end_day: Object.freeze(["sleep_ready", "sleep_after_ready"]),
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
    throw new Error("retired_action_policy_identifier_requires_explicit_migration");
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
    value.every((item) => typeof item === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item))
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
  "place_owned_object",
  "remove_placed_item",
  "move_placed_furniture",
  "rotate_furniture",
  "remove_fence",
  "put_item_in_fish_tank",
  "place_item_on_pedestal",
  "break_container",
  "break_resource_clump",
  "open_geode",
  "equip_wearable",
  "unequip_wearable",
  "dismount_transport",
  "express_emote",
  "face_direction",
  "interact_npc_with_item",
  "talk_to_npc",
  "pet_animal",
  "pet_farm_animal",
  "sleep",
  "ride_minecart",
  "dismiss_modal",
  "answer_dialogue",
  "respond_level_up",
  "shop_purchase",
  "ride_bus",
  "select_mine_elevator_floor",
  "use_mine_ladder",
  "withdraw_silo_hay",
  "use_obelisk",
  "toggle_animal_door",
  "clear_fish_pond",
  "send_multiplayer_chat",
  "name_entity",
  "load_building_chest",
  "collect_building_chest_output",
  "use_warp_item",
  "pan_ore",
  "claim_mail_attachment",
  "build_farm_building",
  "accept_daily_quest",
  "accept_special_order",
  "claim_museum_reward",
  "redeem_prize_ticket",
  "tailor_clothing",
  "dye_clothing_with_item",
  "color_placed_object",
] as const);

export type StardewDescriptorDerivedActionId = (typeof STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS)[number];

export function isDescriptorDerivedActionId(actionId: string): actionId is StardewDescriptorDerivedActionId {
  return (STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS as readonly string[]).includes(actionId);
}

/**
 * The published arguments of either legal shape, read once for every question the Host asks about them.
 *
 * Two shapes reach this gate and both must be read: the hello_ack wire form — `arguments`, an array of
 * {name,type} — and the action-surface form — `argumentSchema`, keyed by name (BridgeProtocolModels.cs:150-158).
 * A reader per question is how a completeness gate came to accept one shape while the mount could only use the
 * other, so every reader below goes through this one and nothing restates the shapes.
 */
function publishedArguments(descriptor: ActionRegistrationDescriptor): readonly ActionDescriptorArgument[] {
  if (descriptor.arguments !== undefined) return descriptor.arguments;
  const schema = descriptor.argumentSchema;
  if (schema === undefined) return [];
  return Object.entries(schema).map(([name, argument]) => ({
    name,
    type: argument.type,
    ...(argument.enum === undefined ? {} : { enum: argument.enum }),
    ...(argument.description === undefined ? {} : { description: argument.description }),
  }));
}

export function getDescriptorArgument(
  descriptor: ActionRegistration["descriptor"],
  argumentName: string,
): ActionDescriptorArgument | undefined {
  if (!descriptor) return undefined;
  return publishedArguments(descriptor).find((argument) => argument.name === argumentName);
}

/** The published argument names in wire order, or `undefined` when the descriptor states no argument shape. */
function publishedArgumentNames(descriptor: ActionRegistration["descriptor"]): readonly string[] | undefined {
  if (!descriptor) return undefined;
  if (descriptor.arguments === undefined && descriptor.argumentSchema === undefined) return undefined;
  return publishedArguments(descriptor).map((argument) => argument.name);
}

function hasExactPublishedArgumentNames(
  descriptor: ActionRegistration["descriptor"],
  expected: readonly string[],
): boolean {
  const names = publishedArgumentNames(descriptor);
  return names !== undefined && JSON.stringify(names) === JSON.stringify(expected);
}

/** The postcondition is published as a record with a `name`; older shapes carry a bare string. */
function publishedPostconditionName(descriptor: ActionRegistration["descriptor"]): string | undefined {
  const postcondition: unknown = descriptor?.postcondition;
  if (typeof postcondition === "string") return postcondition;
  if (isRecord(postcondition) && typeof postcondition.name === "string") return postcondition.name;
  return undefined;
}

export function getArgumentEnum(
  argument: { enum?: readonly string[]; boundedEnumValues?: readonly string[] } | undefined,
): readonly string[] | undefined {
  if (!argument) return undefined;
  if (Array.isArray(argument.enum) && argument.enum.length > 0) return argument.enum;
  if (Array.isArray(argument.boundedEnumValues) && argument.boundedEnumValues.length > 0)
    return argument.boundedEnumValues;
  return undefined;
}

/**
 * One fact a mounted tool requires of the descriptor its Mod owner published.
 *
 * `field` and `shape` are what a refusal points at, and `refusal` is the sentence it prints: a reader told "the
 * published descriptor's `nativeBinding` must be the non-empty name of the engine member the action drives" knows
 * which member of the Mod's record to look at, which is the whole value of the gate. `violated` is the same
 * descriptor with that one fact removed, so a test can walk the table instead of trusting it.
 */
export type DescriptorRequirement = Readonly<{
  field: string;
  shape: string;
  refusal: string;
  isMet: (descriptor: ActionRegistrationDescriptor) => boolean;
  violated: (descriptor: ActionRegistrationDescriptor) => ActionRegistrationDescriptor;
}>;

function requirement(
  field: string,
  shape: string,
  because: string,
  isMet: DescriptorRequirement["isMet"],
  violated: DescriptorRequirement["violated"],
): DescriptorRequirement {
  return Object.freeze({
    field,
    shape,
    refusal: `the published descriptor's \`${field}\` must be ${shape}, because ${because}`,
    isMet,
    violated,
  });
}

/** `arguments`: the exact published names, in wire order — the shape the mount forwards. */
function publishesArguments(...names: readonly string[]): DescriptorRequirement {
  return requirement(
    "arguments",
    names.length === 0 ? "no arguments at all" : `exactly [${names.join(", ")}], in that order`,
    "the mount forwards those names in that order and the Mod validates the request against them",
    (descriptor) => hasExactPublishedArgumentNames(descriptor, names),
    // Dropping one name is the smallest faithful violation: an extra name is refused too, but it would prove the
    // other half of the rule.
    (descriptor) => {
      const { argumentSchema: _schema, ...wire } = descriptor;
      return {
        ...wire,
        arguments:
          names.length === 0
            ? [{ name: "unexpected", type: "string" }]
            : names.slice(1).map((name) => ({ name, type: "string" })),
      };
    },
  );
}

/** One published argument declared as the type the Mod validates the request against. */
function publishesArgumentType(name: string, type: string): DescriptorRequirement {
  return requirement(
    name,
    `published as the argument \`${name}\` of type "${type}"`,
    "the Mod validates the request against the type its descriptor declares",
    (descriptor) => getDescriptorArgument(descriptor, name)?.type === type,
    (descriptor) =>
      withPublishedArgument(descriptor, name, (argument) => ({
        ...argument,
        type: type === "string" ? "integer" : "string",
      })),
  );
}

/** One argument's closed vocabulary: the values the Mod's own acceptance admits, and refuses everything outside of. */
function publishesArgumentEnum(name: string): DescriptorRequirement {
  return requirement(
    name,
    `an argument \`${name}\` carrying a non-empty enum`,
    "the Mod's registry acceptance refuses every value outside the published vocabulary, so a descriptor that publishes none describes an argument nothing can satisfy",
    (descriptor) => getArgumentEnum(getDescriptorArgument(descriptor, name)) !== undefined,
    (descriptor) =>
      withPublishedArgument(descriptor, name, ({ enum: _enum, boundedEnumValues: _bounded, ...argument }) => argument),
  );
}

/**
 * The descriptor rewritten into the wire shape with exactly one published argument changed.
 *
 * The rewrite lands in `arguments` because that is the shape both readers consult first: a violated copy that kept
 * its `argumentSchema` could go on satisfying the requirement through a shape the requirement never looked at.
 */
function withPublishedArgument(
  descriptor: ActionRegistrationDescriptor,
  name: string,
  rewrite: (argument: ActionDescriptorArgument) => ActionDescriptorArgument,
): ActionRegistrationDescriptor {
  const { argumentSchema: _schema, ...wire } = descriptor;
  return {
    ...wire,
    arguments: publishedArguments(descriptor).map((argument) =>
      argument.name === name ? rewrite(argument) : argument,
    ),
  };
}

/** `effect`: every mounted action performs a native write. */
const WRITES_EFFECT = requirement(
  "effect",
  'the string "write"',
  "a mounted action performs a native write, and the Host does not advertise an effect it cannot see",
  (descriptor) => descriptor.effect === "write",
  (descriptor) => ({ ...descriptor, effect: "read" }),
);

/** `postcondition`: the receipt the Mod mints for this action, by name. */
function mintsPostcondition(name: string): DescriptorRequirement {
  return requirement(
    "postcondition",
    `the name "${name}"`,
    "that is the receipt this action's Mod owner mints when the write landed",
    (descriptor) => publishedPostconditionName(descriptor) === name,
    (descriptor) => ({
      ...descriptor,
      postcondition: {
        name: name === "native_action_postcondition" ? "unspecified_postcondition" : "native_action_postcondition",
      },
    }),
  );
}

/** `postcondition`: only its presence, on the actions whose receipt name the Host does not pin. */
const PUBLISHES_POSTCONDITION = requirement(
  "postcondition",
  "some published postcondition name",
  "the mount offers an action only where the Mod can prove the write it performed",
  (descriptor) => publishedPostconditionName(descriptor) !== undefined,
  (descriptor) => {
    const { postcondition: _postcondition, ...rest } = descriptor;
    return rest;
  },
);

/** `nativeBinding`: the engine member the action drives, which is what the mount hands the request to. */
const PUBLISHES_NATIVE_BINDING = requirement(
  "nativeBinding",
  "the non-empty name of the engine member the action drives",
  "the mount can only offer an action whose engine member the Mod names",
  (descriptor) => typeof descriptor.nativeBinding === "string" && descriptor.nativeBinding.length > 0,
  (descriptor) => {
    const { nativeBinding: _nativeBinding, ...rest } = descriptor;
    return rest;
  },
);

// The argument shapes the Mod publishes, each named once: a row that repeated a shape by hand would be a second
// spelling of it, and the refusal printed beside it would drift from the one next door.
const NO_ARGUMENTS = publishesArguments();
const TILE_AND_TARGET = publishesArguments("x", "y", "expectedTargetId");
const TILE_SLOT_AND_TARGET = publishesArguments("x", "y", "slot", "expectedTargetId");
const TILE_ITEM_AND_TARGET = publishesArguments("x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId");

/**
 * What the Host requires of a descriptor before it mounts that capability, per action id.
 *
 * This is the admission rule as a DECLARATION rather than a ladder of comparisons: each row lists the facts its
 * mounted tool needs, and every fact carries the sentence a refusal prints. `satisfies` holds the table to
 * `STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS` in BOTH directions - an enrolled id without a row, or a row for an id the
 * list does not enrol, is a compile error rather than a silent shortfall in a chain - which is strictly stronger
 * than the per-action `if (actionId === …)` arms this replaces, and the reason those arms must not be restored. The
 * rows are read, not restated, by `action-registry-consistency.test.ts`, which walks each one against the Mod's own
 * published artifact.
 */
export const MOD_DESCRIPTOR_REQUIREMENTS = Object.freeze({
  // The lane's placement shape: the tile, the backpack slot holding the item, the item's own wire identity and the
  // opaque placement target, all mandatory.
  place_owned_object: [TILE_ITEM_AND_TARGET, WRITES_EFFECT, mintsPostcondition("owned_object_placed")],
  remove_placed_item: [TILE_SLOT_AND_TARGET, WRITES_EFFECT, mintsPostcondition("placed_item_removed")],
  // Furniture is picked up by its own opaque target only: which backpack slot receives the piece is the game's own
  // decision, so there is no slot argument to admit.
  move_placed_furniture: [TILE_AND_TARGET, WRITES_EFFECT, mintsPostcondition("placed_furniture_picked_up")],
  // The rotation the call lands on is the piece's own cycle, so there is no angle argument either.
  rotate_furniture: [TILE_AND_TARGET, WRITES_EFFECT, mintsPostcondition("furniture_rotated")],
  remove_fence: [TILE_SLOT_AND_TARGET, WRITES_EFFECT, mintsPostcondition("fence_removed")],
  place_item_on_pedestal: [TILE_ITEM_AND_TARGET, WRITES_EFFECT, mintsPostcondition("pedestal_item_placed")],
  put_item_in_fish_tank: [TILE_ITEM_AND_TARGET, WRITES_EFFECT, mintsPostcondition("fish_tank_item_deposited")],
  break_container: [TILE_SLOT_AND_TARGET, WRITES_EFFECT, mintsPostcondition("container_source_broken")],
  // A clump is cleared with a tool its own native switch picks, so the request names no slot: the identity-locked
  // target plus the tile it was published at is the whole input.
  break_resource_clump: [TILE_AND_TARGET, WRITES_EFFECT, mintsPostcondition("native_action_postcondition")],
  // A backpack transaction with no tile: the slot the geode occupies and that geode's own wire identity.
  open_geode: [
    publishesArguments("slot", "expectedQualifiedItemId"),
    WRITES_EFFECT,
    mintsPostcondition("native_action_postcondition"),
  ],
  equip_wearable: [
    publishesArguments("slot", "expectedQualifiedItemId", "expectedTargetId"),
    WRITES_EFFECT,
    mintsPostcondition("wearable_equipped"),
  ],
  unequip_wearable: [
    publishesArguments("slot", "expectedTargetId"),
    WRITES_EFFECT,
    mintsPostcondition("wearable_unequipped"),
  ],
  dismount_transport: [NO_ARGUMENTS, WRITES_EFFECT, mintsPostcondition("transport_dismounted")],
  // The two body-language actions the Game prompt names: a closed vocabulary of one argument each, a receipt the
  // Host only requires to be published, and the engine member the mount hands them to.
  express_emote: [
    publishesArgumentType("emote", "string"),
    publishesArgumentEnum("emote"),
    WRITES_EFFECT,
    PUBLISHES_POSTCONDITION,
    PUBLISHES_NATIVE_BINDING,
  ],
  face_direction: [
    publishesArgumentType("direction", "string"),
    publishesArgumentEnum("direction"),
    WRITES_EFFECT,
    PUBLISHES_POSTCONDITION,
    PUBLISHES_NATIVE_BINDING,
  ],
  // The offer routes through the native GameLocation.checkAction ingress (not a single method binding), so the row
  // covers the exact five-argument shape and the write receipt instead.
  interact_npc_with_item: [TILE_ITEM_AND_TARGET, WRITES_EFFECT, PUBLISHES_POSTCONDITION],
  // x/y is only the tile the villager was published at; the person is named by the opaque family target id and
  // re-resolved on the Mod's game thread.
  talk_to_npc: [TILE_AND_TARGET, WRITES_EFFECT, mintsPostcondition("npc_talked")],
  // Both animal families move between observation and dispatch, so the target is bound by identity and x/y is only
  // the tile it was published at.
  pet_animal: [TILE_AND_TARGET, WRITES_EFFECT, PUBLISHES_POSTCONDITION],
  pet_farm_animal: [TILE_AND_TARGET, WRITES_EFFECT, PUBLISHES_POSTCONDITION],
  // The night carries no arguments at all: the bed and the ready state are native facts.
  sleep: [NO_ARGUMENTS, WRITES_EFFECT, mintsPostcondition("day_advanced")],
  // `ride_minecart` has no plain-warp form, unlike `travel`: the station tile plus one advertised ride selector.
  ride_minecart: [TILE_AND_TARGET, WRITES_EFFECT, mintsPostcondition("minecart_ride_completed")],
  dismiss_modal: [NO_ARGUMENTS, WRITES_EFFECT, mintsPostcondition("modal_dismissed")],
  answer_dialogue: [
    publishesArguments("responseKey"),
    publishesArgumentType("responseKey", "string"),
    WRITES_EFFECT,
    mintsPostcondition("answer_dialogue_answered"),
  ],
  // The choice (a closed set, so its enum is part of the contract) plus the pair the Mod validates against the menu
  // it is holding.
  respond_level_up: [
    publishesArguments("choice", "expectedSkill", "expectedLevel"),
    publishesArgumentType("choice", "string"),
    publishesArgumentEnum("choice"),
    publishesArgumentType("expectedSkill", "integer"),
    publishesArgumentType("expectedLevel", "integer"),
    WRITES_EFFECT,
    mintsPostcondition("level_up_resolved"),
  ],
  // Deliberately no coordinate: walking is move_to_tile's job, and a walk failure must never be reported as a trade
  // failure.
  shop_purchase: [
    publishesArguments("expectedTargetId", "expectedQualifiedItemId", "quantity"),
    WRITES_EFFECT,
    mintsPostcondition("item_purchased"),
  ],
  // The ticket machine of the current location is the whole target, so the exact wire shape is the EMPTY set.
  ride_bus: [NO_ARGUMENTS, WRITES_EFFECT, mintsPostcondition("bus_arrived")],
  // One opaque already-reached floor and nothing else: a coordinate would be a second source of truth for the one
  // fact the selector already carries.
  select_mine_elevator_floor: [
    publishesArguments("expectedTargetId"),
    WRITES_EFFECT,
    mintsPostcondition("mine_elevator_floor_selected"),
  ],
  // The ladder KIND is re-derived on the game thread from the level's own Buildings layer, so a wrong id can never
  // select the other ladder.
  use_mine_ladder: [TILE_AND_TARGET, WRITES_EFFECT, mintsPostcondition("mine_left")],
  // The silo tile plus the opaque silo selector: the Mod re-resolves the silo from the target id and refuses on its
  // own hay and capacity preconditions.
  withdraw_silo_hay: [TILE_AND_TARGET, WRITES_EFFECT, mintsPostcondition("silo_hay_taken")],
  use_obelisk: [TILE_AND_TARGET, WRITES_EFFECT, mintsPostcondition("obelisk_arrived")],
  toggle_animal_door: [TILE_AND_TARGET, WRITES_EFFECT, mintsPostcondition("animal_door_toggled")],
  // The facility family's building shape: the Agent names the structure and never its internal state.
  clear_fish_pond: [TILE_AND_TARGET, WRITES_EFFECT, mintsPostcondition("fish_pond_cleared")],
  send_multiplayer_chat: [publishesArguments("text"), WRITES_EFFECT, mintsPostcondition("chat_message_sent")],
  // The subject is the actor's own horse, so one string and nothing else.
  name_entity: [publishesArguments("text"), WRITES_EFFECT, mintsPostcondition("entity_named")],
  load_building_chest: [TILE_SLOT_AND_TARGET, WRITES_EFFECT, mintsPostcondition("building_chest_loaded")],
  collect_building_chest_output: [
    TILE_AND_TARGET,
    WRITES_EFFECT,
    mintsPostcondition("building_chest_output_collected"),
  ],
  use_warp_item: [
    publishesArguments("slot", "expectedQualifiedItemId"),
    WRITES_EFFECT,
    mintsPostcondition("warp_item_arrived"),
  ],
  pan_ore: [publishesArguments("slot", "x", "y"), WRITES_EFFECT, mintsPostcondition("ore_panned")],
  claim_mail_attachment: [TILE_AND_TARGET, WRITES_EFFECT, mintsPostcondition("mail_claimed")],
  // The exterior tile the building is raised from and the opaque tile target: the cost and the placement legality
  // are re-derived on the game thread.
  build_farm_building: [
    publishesArguments("buildingType", "x", "y", "expectedTargetId"),
    WRITES_EFFECT,
    mintsPostcondition("farm_building_built"),
  ],
  // The day's posted help-wanted quest, named by the opaque target id alone: the offer is native world state.
  accept_daily_quest: [
    publishesArguments("expectedTargetId"),
    WRITES_EFFECT,
    mintsPostcondition("daily_quest_accepted"),
  ],
  // The player team's own offered order, likewise named by the opaque target id alone.
  accept_special_order: [
    publishesArguments("expectedTargetId"),
    WRITES_EFFECT,
    mintsPostcondition("special_order_accepted"),
  ],
  // The museum's whole reward set is computed state, not a tile.
  claim_museum_reward: [
    publishesArguments("expectedTargetId"),
    WRITES_EFFECT,
    mintsPostcondition("museum_rewards_collected"),
  ],
  // The prize track head is the game's own state and the subject is the actor's own ticket stack, so there is no
  // published target a caller could name.
  redeem_prize_ticket: [NO_ARGUMENTS, WRITES_EFFECT, mintsPostcondition("prize_ticket_redeemed")],
  // The sewing machine's two-slot recipe pair, named by BOTH backpack slots plus the opaque pair identity.
  tailor_clothing: [
    publishesArguments("leftSlot", "rightSlot", "expectedTargetId"),
    WRITES_EFFECT,
    mintsPostcondition("clothing_tailored"),
  ],
  color_placed_object: [
    publishesArguments("x", "y", "expectedTargetId", "colorSelection"),
    WRITES_EFFECT,
    mintsPostcondition("placed_object_recolored"),
  ],
  // The same two-slot shape over the dye route: the garment slot, the dye slot and the opaque pair identity.
  dye_clothing_with_item: [
    publishesArguments("leftSlot", "rightSlot", "expectedTargetId"),
    WRITES_EFFECT,
    mintsPostcondition("clothing_dyed"),
  ],
} satisfies Record<StardewDescriptorDerivedActionId, readonly DescriptorRequirement[]>);

/**
 * Whether the Mod's published descriptor carries everything the Host mounts for this action.
 *
 * A lookup and a fold over `MOD_DESCRIPTOR_REQUIREMENTS`, so the rule lives in one declaration. `false` covers both
 * "no such capability" and "its descriptor is short of a requirement": to every caller those are the same fact,
 * that the action is not offered, and which fact was missing is the row's own refusal rather than a sentence made
 * here.
 */
export function isModDescriptorComplete(actionId: string, descriptor: ActionRegistration["descriptor"]): boolean {
  if (!descriptor || !isValidActionDescriptor(descriptor)) return false;
  if (!isDescriptorDerivedActionId(actionId)) return false;
  return MOD_DESCRIPTOR_REQUIREMENTS[actionId].every((required) => required.isMet(descriptor));
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
  if (registrations.length === 0 || liveCapabilities.length === 0) return Object.freeze([]);

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
      deniedFamilies.has(registration.familyId)
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
        ...(registration.descriptor !== undefined ? { descriptor: registration.descriptor } : {}),
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
  const visible = visibleActionsFromModCatalog(registrations, capabilities, policy);
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
