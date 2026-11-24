using System.Collections.ObjectModel;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// What one action is CALLED, the sentence a model reads about it, and the kinds of thing it acts on.
///
/// <para>
/// WHY THIS IS THE MOD'S TO DECLARE. Measured 2026-11-24: the label and the sentence existed in the HOST, twice - once in
/// `game-tools.ts`'s `DECLARED_ACTION_TOOL_PRESENTATION` (forty-eight rows, the text each mounted tool renders) and once
/// in `action-registry.ts`'s `STARDEW_ACTION_ADAPTERS` (one hundred and three rows, the text `stardew_interaction_catalog`
/// prints, which is a DIFFERENT sentence about the same action) - and `targetKinds` existed only in the second. So the
/// one consumer that has to build a tool out of a descriptor, and not out of a name it recognizes, could not: the two
/// facts it needs to say anything at all were in a Host file keyed by action id, and a Host file keyed by action id is
/// exactly the hand-list this repository keeps replacing with a declaration the owning side publishes.
/// </para>
///
/// <para>
/// WHAT IS DECLARED HERE AND WHAT IS NOT. A row states the three facts a mounted tool states for itself and nothing else:
/// the label, the description, and the target kinds (`world_object`, `modal`, `pet` - the words the adapter table used to
/// carry alone). WHICH actions have a row is a claim too: exactly the forty-eight whose tool is a projection of the
/// descriptor (`STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS` in the Host), so the two sets are held equal by
/// `FarmhandActionPresentationCoverageTests` and an action that joins one without the other fails by name. The other
/// fifty-eight actions carry NO row, and that absence is the statement rather than an empty string: their tool text is
/// still written in its own mount block, and the unit that deletes those mounts is the unit that adds their rows.
/// </para>
///
/// <para>
/// THE BOUNDS ARE THE ONES THE READERS ALREADY APPLY. `MaximumDescriptionLength` is 2,048 because the longest sentence
/// published here measures 1,437 characters (`pet_farm_animal`): the artifact's own prose ceiling was 512, which was the
/// ceiling for ONE ARGUMENT's meaning and was never going to hold a tool description, so it moved in the same edit rather
/// than truncating a sentence a model already reads. A label is a name, so it keeps the identifier bound. Both are checked
/// HERE, at the producer, because a value that passes this loop cannot be refused by the Host's validator or by the
/// artifact's - the failure belongs to the Mod build, not to a live session's hello.
/// </para>
/// </summary>
public sealed record FarmhandActionPresentation(string Label, string Description, IReadOnlyList<string> TargetKinds);

/// <summary>
/// The one declaration of what each published action is called, how it is described, and what it acts on.
///
/// <para>
/// Keyed by the action id the catalog already owns, and gated in both directions by
/// `FarmhandActionPresentationCoverageTests`: a catalog action with no row is reported with the reason its absence is
/// legitimate (it is not on the descriptor-derived list) or as a failure (it is), and a row for an action the catalog
/// does not register is reported as an entry that outlived its action. Nothing here is derived from a name, and nothing
/// here is a fallback for a missing declaration.
/// </para>
/// </summary>
public static class FarmhandActionPresentationCatalog
{
    /// <summary>A label is a NAME: the same 128 the surface's identifier rule and the Host's wire bound apply.</summary>
    public const int MaximumLabelLength = 128;

    /// <summary>
    /// How long a model-facing sentence may be, measured against what is published rather than against a round number:
    /// the longest row here is 1,437 characters.
    /// </summary>
    public const int MaximumDescriptionLength = 2048;

    /// <summary>Enough for the widest action's kinds (`mine_entrance`, `world_object`, `travel`), and a bound besides.</summary>
    public const int MaximumTargetKinds = 8;

    public const int MaximumTargetKindLength = 64;

    public static IReadOnlyDictionary<string, FarmhandActionPresentation> ByActionId { get; } = Create();

    /// <summary>The presentation of one action, or null on the actions that declare none.</summary>
    public static FarmhandActionPresentation? For(string actionId) =>
        ByActionId.TryGetValue(actionId, out FarmhandActionPresentation? declared) ? declared : null;

    private static ReadOnlyDictionary<string, FarmhandActionPresentation> Create()
    {
        Dictionary<string, FarmhandActionPresentation> byActionId = new(StringComparer.Ordinal)
        {
            ["send_multiplayer_chat"] = new FarmhandActionPresentation(
                @"Say one line to the lobby",
                @"Send one chat line to the whole multiplayer lobby through the game own chat egress. It takes exactly one string (`text`), moves nobody, opens nothing and touches no inventory, and it is REFUSED when there is no lobby (chat_multiplayer_only), when the text is blank or longer than one native chat line (chat_message_invalid), or when you send again inside the minimum interval (chat_rate_limited, with retry_after_ms). The receipt proves the SEND only: it never claims that anyone read the line.",
                ["chat"]),
            ["name_entity"] = new FarmhandActionPresentation(
                @"Name your horse",
                @"Give your own horse its name through the game own naming settlement. It takes exactly one string (`text`) and no target: the subject is YOUR horse, found live. It is REFUSED when you own no horse (name_entity_target_unavailable), when the horse already carries a name (name_entity_target_already_named), or when the name is blank, longer than 64 characters, or carries a `;` or `=` (name_entity_name_invalid). The receipt reports the name READ BACK from the entity, never the call itself.",
                ["horse", "name"]),
            ["express_emote"] = new FarmhandActionPresentation(
                @"Express Stardew Emote",
                @"Show a native overhead emote balloon for the companion actor. A gesture is one step by nature, so this tool is mounted on its own beside the plan builder and is NOT a step inside `stardew_plan_work`: one call is the whole gesture, it never queues behind the work in front of it, and its settlement is its own. It takes exactly one `emote` word, and this parameter list carries the closed set of words the Mod accepts.",
                ["character_emote"]),
            ["face_direction"] = new FarmhandActionPresentation(
                @"Face Stardew Direction",
                @"Turn the companion actor to face a cardinal direction (up, right, down, left). Mounted on its own beside the plan builder for the same reason as `stardew_express_emote` - a turn is one step by nature and is NOT a step inside `stardew_plan_work` - and it takes exactly one `direction` word, whose closed set this parameter list carries.",
                ["character_facing"]),
            ["interact_npc_with_item"] = new FarmhandActionPresentation(
                @"Offer Item to NPC",
                @"Offer one carried inventory item to an adjacent villager. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the npcRelationshipTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). A matching native quest delivery completes first and returns quest_item_delivered; the ordinary gift path returns gift_given.",
                ["npc", "inventory_slot"]),
            ["talk_to_npc"] = new FarmhandActionPresentation(
                @"Talk to Villager",
                @"Talk to an adjacent villager: the Mod drives the game's own NPC.checkAction talk branch, so the villager's real dialogue is what appears. x, y and expectedTargetId must be copied exactly from the npcRelationshipTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Empty your hands first: with an item in hand the game takes the gift path instead and the action refuses with hands_not_empty, and a villager who is asleep or out of reach is refused too. Returns talk_to_npc_talked when the dialogue is open; the actor stays inside that dialogue until it is closed (stardew_dismiss_modal, or stardew_answer_dialogue for a question).",
                ["npc", "dialogue"]),
            ["pet_animal"] = new FarmhandActionPresentation(
                @"Pet Animal",
                @"Pet a nearby pet. x, y and expectedTargetId must be copied exactly from the petTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The pet target is bound by identity: if it has moved away, the native interaction returns a rejection instead of petting a different pet. A pet that is stationary right now is the reliable target; a moving one may leave before dispatch returns. Returns pet_completed.",
                ["pet"]),
            ["pet_farm_animal"] = new FarmhandActionPresentation(
                @"Pet Farm Animal",
                @"Pet one of your own farm animals - a cow, chicken, sheep, pig, duck, rabbit or dinosaur - in the barn, coop or pasture you are standing in. This is NOT stardew_pet_animal: that one pets the household cat/dog, this one pets barn and coop stock through the game's own FarmAnimal.pet, and the two read different day markers. x, y and expectedTargetId must be copied exactly from the farmAnimalPetTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates): x and y are only the tile the animal was published at, and the animal is named by the opaque id, so the Mod re-resolves it from its live tile and walks the actor into reach when it has wandered, while an animal that is no longer in the building is refused as farm_animal_target_gone instead of petting a different one. A second pet attempt in the same day is refused as farm_animal_already_petted_today, because the game's pet would open the animal menu and change no friendship at all. Also refused by name: farm_animal_cracker_would_be_consumed (a held Golden Animal Cracker would be spent instead of petting) and farm_animal_pet_requires_movement_after_1900 (after 19:00 only a moving animal answers a pet). Returns farm_animal_petted with the friendship before and after; an animal whose friendship and wasPet marker did not move comes back as farm_animal_pet_postcondition_not_observed rather than as a pet that never happened.",
                ["farm_animal"]),
            ["sleep"] = new FarmhandActionPresentation(
                @"Sleep and Advance the Day",
                @"End the day the way the player does: the Farmhand walks to its own bed, lets the native bedtime path run, declares bedtime-ready through that same native path, and then observes the native save and new-day transition. In a shared world the night completes only when every required player is ready; the Farmhand never marks another player ready and never forces the day. Takes no arguments. Returns day_advanced when the native save and day transition are observed, blocked with requires_other_player when the ready barrier is still waiting on someone else.",
                ["own_bed", "day_lifecycle"]),
            ["dismiss_modal"] = new FarmhandActionPresentation(
                @"Dismiss a Dialog",
                @"Close the informational native dialogue currently on screen (a DialogueBox with no pending question) through the native closeDialogue path. The dialog must have been opened by the world (a villager, a door gate, an event) and must not be a question that requires choosing an answer.",
                ["dialogue", "modal"]),
            ["ride_bus"] = new FarmhandActionPresentation(
                @"Ride the Bus",
                @"Ride the native bus from the Bus Stop ticket machine to the desert. Stand next to the ticket machine first (otherwise the action refuses with bus_ticket_machine_out_of_reach). The Mod verifies the vault, the driver and the fare itself, then drives the game's own ticket interaction: the receipt arrives as bus_arrived when the actor is in the desert, or bus_arrival_unconfirmed if the ride never completes.",
                ["bus_ticket_machine"]),
            ["withdraw_silo_hay"] = new FarmhandActionPresentation(
                @"Take hay from a silo",
                @"Withdraw one hay from a discovered silo. Stand within reach of the silo first. Read the opaque target id, its tile and the stored `hay` count from the `siloTargets` entries of the most recent observation (the same list `stardew_deposit_silo_hay` reads). The Mod re-resolves the silo from the opaque target id and asserts BOTH halves of the move (the silo store drops by one and the carried hay rises by one), so a one-sided change is never reported as success.",
                ["silo"]),
            ["clear_fish_pond"] = new FarmhandActionPresentation(
                @"Empty a fish pond",
                @"Empty a built fish pond of every occupant through the pond own clearing settlement. Read the opaque target id, its tile, the pond type, the occupant count and the fish type from the `fishPondTargets` projection. The fish are NOT destroyed: each one is put on the ground as debris for you to collect, and the pond itself is reset and must be restocked from scratch. An empty pond is never advertised, and one that was already emptied refuses by name (pond_already_empty) rather than clearing nothing and calling it a success.",
                ["fish_pond"]),
            ["build_farm_building"] = new FarmhandActionPresentation(
                @"Commission a farm building",
                @"Commission a farm building at a site the game itself accepts. Read the opaque target id, its tile, the `buildingType`, the `buildCost` and the `buildDays` from the `farmBuildingTargets` entries of the most recent observation - the site carries the type, so name the site and never a bare structure. The commission charges the build cost and the materials the game declares, and the terminal is a building standing on that site with a durable id; a site the game no longer accepts, or that you cannot afford or supply, is refused by name rather than built.",
                ["buildings"]),
            ["accept_daily_quest"] = new FarmhandActionPresentation(
                @"Accept the day's posted quest",
                @"Accept the help-wanted quest the town has posted for today. Read the opaque target id, the `questType` and the `title` from the `dailyQuestTargets` entries of the most recent observation, and check `acceptedDailyQuest`: it is the day flag the accept turns true, so a day that already accepted one refuses by name instead of accepting twice. The board is only where a player reads the offer; naming the quest is what this does.",
                ["quests"]),
            ["accept_special_order"] = new FarmhandActionPresentation(
                @"Accept an offered special order",
                @"Accept one of the special orders a board is offering. Read the opaque target id, the `questKey` and the `orderType` from the `specialOrderTargets` entries of the most recent observation, and expect the order to appear in the snapshot's `activeSpecialOrderKeys` afterwards; an order that is already active, or whose board has already been used for an accept, is refused by name.",
                ["quests"]),
            ["claim_museum_reward"] = new FarmhandActionPresentation(
                @"Collect the museum rewards you are owed",
                @"Collect every museum donation reward this player is entitled to. Read the opaque target id and the `rewardCount` from the `museumRewardTargets` entries of the most recent observation; the reward items are delivered into the backpack and recorded as collected. A museum with nothing to collect is refused by name rather than reporting an empty success.",
                ["museum", "rewards"]),
            ["redeem_prize_ticket"] = new FarmhandActionPresentation(
                @"Redeem a prize ticket",
                @"Redeem one prize ticket at the machine. It takes NO arguments: the prize is whatever the machine own track head offers you right now, derived by the game from your own ticketPrizesClaimed stat, so there is nothing to choose and nothing to name. The receipt proves BOTH halves - the ticket stack fell by exactly one AND the prize entered your pack - and it refuses by name when you hold no ticket (prize_ticket_unavailable) or your pack cannot take the prize (prize_inventory_full) rather than dropping it on the ground.",
                ["prize_ticket"]),
            ["tailor_clothing"] = new FarmhandActionPresentation(
                @"Tailor clothing from a recipe pair",
                @"Consume the cloth and the reagent a live sewing-machine recipe pairs and produce that recipe's garment into your backpack. Read the opaque target id, the two backpack slots (`leftSlot`/`rightSlot`) and the produced item id from the `tailoringTargets` entries of the most recent observation; the Mod re-reads both named slots on the game thread and refuses by name when the pair no longer mints the published id. A garment only part of which fits is reported as `clothing_tailoring_output_dropped`, never as a full success.",
                ["tailoring", "inventory_slot"]),
            ["color_placed_object"] = new FarmhandActionPresentation(
                @"Repaint a placed chest",
                @"Repaint one placed chest with one of the game's own 21 palette colours. Read the opaque target id, its tile (`x`, `y`) and the `color` it already carries from the `colorTargets` entries of the most recent observation, then name the palette index (`colorSelection`) it should carry. Only palette colours are writable, so no RGB value is accepted, and a repaint to the colour it already carries is refused by name instead of being reported as a change.",
                ["world_object", "container"]),
            ["dye_clothing_with_item"] = new FarmhandActionPresentation(
                @"Dye clothing with one item",
                @"Recolour one existing garment from one dye item. Read the opaque target id, the garment slot (`leftSlot`), the dye slot (`rightSlot`) and the garment's CURRENT `garmentColour` from the `tailoringTargets` entries of the most recent observation. The receipt proves the dye was spent AND the colour settled, and reports before/expected/after; a colour that did not move is never reported as success.",
                ["tailoring", "inventory_slot"]),
            ["toggle_animal_door"] = new FarmhandActionPresentation(
                @"Toggle an animal door",
                @"Open or close a barn or coop animal door. Stand within reach of the building first. Read the opaque target id, its tile and the current `isOpen` state from the `animalDoorTargets` entries of the most recent observation. The Mod re-resolves the building from the opaque target id and asserts the door state flipped; the receipt carries the observed before/after state.",
                ["animal_door"]),
            ["use_obelisk"] = new FarmhandActionPresentation(
                @"Use a warp obelisk",
                @"Activate a discovered warp obelisk. Stand within reach of it first. Read the opaque target id, `route`, tile and `destination` from the `obeliskTargets` entries of the most recent observation. The Mod chooses the destination from the target itself (a Data/Buildings obelisk building, or the island farm obelisk tile), so name the structure and never a destination; the arrival is the terminal, not the dispatch.",
                ["obelisk"]),
            ["shop_purchase"] = new FarmhandActionPresentation(
                @"Buy from a shop",
                @"Buy goods from a shop the game says is open here. Read the opaque target id, `shopId`, the owner tile and `stockItemIds` from the `shopTargets` entries of the most recent observation; `stockItemIds` lists what this shop actually sells, so do not request an item it does not name. A shop may be opened by an eligible owner (an NPC) OR by its own tile or object, which is why a target can exist with no owner standing nearby; the Mod reads owner eligibility and stock from the game's own content data, and the purchase runs through the game's own shop menu. Only a counter whose own TILE is the shop has to be reached before it can be used; a counter an eligible owner NPC runs opens from anywhere in that room, so no walk is required for it. The action never walks.",
                ["shop"]),
            ["select_mine_elevator_floor"] = new FarmhandActionPresentation(
                @"Use the Mine Elevator",
                @"Select an already-reached floor on the mine elevator. Read the opaque target id, `floor` and `isCurrentFloor` from the `mineElevatorFloorTargets` entries of the most recent observation. The offered floors come from the Mod reading the live lowest level reached, so a level the player has not unlocked cannot be requested. Floor 0 returns to the mine entrance and is only valid from inside the mine.",
                ["mine_elevator_floor"]),
            ["answer_dialogue"] = new FarmhandActionPresentation(
                @"Answer a Dialogue",
                @"Choose one response from the currently displayed native question dialogue. responseKey must exactly match a response offered by the live DialogueBox.",
                ["dialogue", "modal"]),
            ["respond_level_up"] = new FarmhandActionPresentation(
                @"Settle a Level-up",
                @"Settle the level-up the actor is being shown: choice ""confirm"" for an ordinary level, or ""branch_a""/""branch_b"" for one of the two professions a level-5 or level-10 menu offers. Pass the skill and level the menu is about, so a persistent choice can never be applied to the wrong level-up.",
                ["modal", "level_up"]),
            ["ride_minecart"] = new FarmhandActionPresentation(
                @"Ride a Native Minecart",
                @"Ride one advertised native minecart objective from a live station tile. x, y and expectedTargetId must be copied exactly from the minecartTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates); x,y is the STATION tile, not the destination. The Mod re-derives the network, its unlock, the destination condition and the ticket price on the game thread from the live map tile and Data/Minecarts, then performs the native ride. Only the minecart_ride_completed receipt, which names the ridden objective and the exact arrival tile, reports success.",
                ["minecart_station"]),
            ["sweep_scythe"] = new FarmhandActionPresentation(
                @"Sweep the Scythe Arc",
                @"Swing the scythe ONCE at a tile arc. x and y are only the tile the Farmhand must FACE, copied from the MOST RECENT observe result for the current location (never invent or guess coordinates) - there is no target id, because one swing covers a SET of tiles the engine itself samples, and the scythe comes from the action's own `tool:scythe` claim rather than a slot you name. The receipt is that arc's own measurement: arc_tiles, arc_sweepable and arc_clear count what it sampled, and changed names the tiles that moved with what stood on each before the swing. Completion is the NAMED tile moving (scythe_sweep_cut); a swing that left it alone comes back as scythe_sweep_partial rather than as a completed sweep, and nothing here claims a monster hit.",
                ["tool", "weed", "grass"]),
            ["use_mine_ladder"] = new FarmhandActionPresentation(
                @"Leave the mine by its ladder",
                @"Leave the mine level you are inside through its own exit ladder, so you are not trapped when nothing can be mined. x, y and expectedTargetId must be copied exactly from the mineEntranceTargets entries of the most recent observe result: inside a mine level that family publishes the ladder tiles, and the exit ladder is the one this action owns. The game opens its own Leave question and performs the warp, so no destination is accepted here. A row that belongs to the DESCENDING ladder is refused by name and points at stardew_enter_mine; to choose a floor you have already reached, use stardew_select_mine_elevator_floor.",
                ["mine_entrance"]),
            ["load_building_chest"] = new FarmhandActionPresentation(
                @"Load a building chest",
                @"Put the held item into a storage chest the BUILDING itself declares, such as a Mill's input chest. Stand within reach of the building first. Read the opaque target id, its tile, the chest id and the load hint from the buildingChestTargets entries of the most recent observation. Only the native Load branch is driven; a chest the game exposes only through a menu is refused by name.",
                ["building_chest"]),
            ["collect_building_chest_output"] = new FarmhandActionPresentation(
                @"Collect building chest output",
                @"Take what a building's OWN output chest holds, such as a Mill's flour or a Junimo Hut's crops. Stand within reach of the building first. Read the opaque target id, its tile and `stackCount` from the `buildingChestTargets` entries of the most recent observation. A chest holding two or more stacks is refused by name (building_chest_requires_menu), because the native branch would open a container menu this action does not drive; otherwise the Mod asserts the stack left the chest AND arrived in the pack.",
                ["building_chest"]),
            ["use_warp_item"] = new FarmhandActionPresentation(
                @"Use a held warp totem",
                @"Use a held warp totem (farm, mountain, beach, desert or island) through the game's own object-use path, consuming the totem and warping the Farmhand. slot and expectedQualifiedItemId must be copied exactly from the warpItemTargets entry of the MOST RECENT observe result. The destination comes from the totem itself; only the arrival postcondition can report success.",
                ["totem", "travel"]),
            ["pan_ore"] = new FarmhandActionPresentation(
                @"Pan the water for ore",
                @"Pan an ore-panning spot with the Copper Pan the Farmhand is holding. slot, x and y must be copied exactly from the panSites entry of the MOST RECENT observe result; the tile is re-checked against the game's own live panning point, so a stale site is refused rather than panned. Only the observed point change plus the panning counter can report success.",
                ["pan", "ore"]),
            ["claim_mail_attachment"] = new FarmhandActionPresentation(
                @"Claim a mailbox attachment",
                @"Claim whatever is waiting in a mailbox. x, y and expectedTargetId must be copied exactly from the mailboxTargets entry of the MOST RECENT observe result; the target id binds the location, the tile and the pending letter, so a stale id is refused rather than claiming the next letter. A letter whose %item attachment has to be delivered is completed with the native letter exit, not discarded.",
                ["mail", "mailbox"]),
            ["equip_wearable"] = new FarmhandActionPresentation(
                @"Equip a wearable",
                @"Put a wearable Farmhand inventory item into the body slot it belongs to. expectedTargetId must be copied exactly from the wearableTargets entry of the MOST RECENT observe result: it names the BODY slot (hat, shirt, pants, boots, left_ring, right_ring), so a stale id is refused. slot and expectedQualifiedItemId must be copied from the inventoryItemFacts entry of that same result: that is the pack slot holding the item to wear. A repeat of the same equip is an idempotent success, not an error.",
                ["wearable"]),
            ["unequip_wearable"] = new FarmhandActionPresentation(
                @"Unequip a wearable",
                @"Take the wearable out of a body slot and put it into a free pack slot. expectedTargetId must be copied exactly from the wearableTargets entry of the MOST RECENT observe result: it names the BODY slot to empty, so a stale id is refused. slot is the DESTINATION pack slot and must be a slot that the same result does not list in inventoryItemFacts (that list holds only OCCUPIED slots) and that is below inventorySlots. The action refuses when the pack is full rather than losing the item, and emptying an already-empty body slot is an idempotent success.",
                ["wearable"]),
            ["dismount_transport"] = new FarmhandActionPresentation(
                @"Dismount the ridden transport",
                @"Get off the horse or other mount the Farmhand is currently riding. This action takes NO arguments. It is a pure state assertion: it refuses when the actor is not riding anything, and only the observed end state (!isRidingHorse) can report success.",
                ["horse"]),
            ["place_owned_object"] = new FarmhandActionPresentation(
                @"Place an owned object",
                @"Place a big-craftable the Farmhand owns onto a live lawful tile. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the worldObjectTargets entry of the MOST RECENT observe result; the target id names the exact placement candidate, so a stale id is refused rather than placed somewhere else. Only the observed new object on the tile can report success.",
                ["world_object"]),
            ["remove_placed_item"] = new FarmhandActionPresentation(
                @"Remove a placed object",
                @"Remove a placed object from the world with the tool that can remove it: the action takes an Axe or Pickaxe out of the pack (the object itself decides which one removes it) and puts the actor's previous selection back, so slot is the number from toolSlots in the MOST RECENT observe result and need not be the held one. x, y and expectedTargetId must be copied exactly from the worldObjectTargets entry. A pack with neither tool, or a tool that cannot remove THIS object, is refused by name rather than silently doing nothing, and success is the object being GONE from the tile.",
                ["world_object"]),
            ["move_placed_furniture"] = new FarmhandActionPresentation(
                @"Pick up placed furniture",
                @"Pick up a piece of furniture that is already placed in the room, so it can be put down somewhere else. x, y and expectedTargetId must be copied exactly from the `placed_furniture` entry of the worldObjectTargets list in the MOST RECENT observe result; a stale id is refused rather than lifting a different piece that now stands there. There is no slot to name: the game chooses which backpack slot receives it. If the pack is full the piece goes back exactly where it stood and the action is refused by name - it is never silently lost - and success is the piece gone from the room AND one more in the pack.",
                ["world_object"]),
            ["break_container"] = new FarmhandActionPresentation(
                @"Break a container",
                @"Break a breakable container on the map, such as a crate or barrel. The action takes a tool the container accepts (any heavy hitter) out of the pack and puts the actor's previous selection back, so slot is the number from toolSlots in the MOST RECENT observe result and need not be the held one; x, y and expectedTargetId must be copied exactly from the worldObjectTargets entry. Success is the container being GONE and its drops accounted for, not the tool's return value.",
                ["world_object"]),
            ["rotate_furniture"] = new FarmhandActionPresentation(
                @"Rotate placed furniture",
                @"Turn one already-placed piece of furniture one step through its own rotation cycle, in place. x, y and expectedTargetId must be copied exactly from the `placed_furniture` entry of the worldObjectTargets list in the MOST RECENT observe result; there is no angle to name, because the piece's own `rotations` data decides whether it alternates or steps. A piece with fewer than two rotations is refused by name (`furniture_rotation_unsupported`), never reported as a turn that did nothing, and success is the piece's rotation changed while it still stands on the same tile.",
                ["world_object"]),
            ["remove_fence"] = new FarmhandActionPresentation(
                @"Remove a placed fence",
                @"Take one placed fence or fence gate off its tile with the tool the fence's own data accepts. x, y, expectedTargetId and the TOOL's slot must be copied exactly from the worldObjectTargets entry of the MOST RECENT observe result. Fence.performToolAction answers false on every branch, including the one that destroyed the fence, so success is the fence GONE from the location plus the drops it produced; a tool that cannot remove that exact fence is refused by name (`remove_fence_tool_cannot_remove_target`).",
                ["world_object"]),
            ["put_item_in_fish_tank"] = new FarmhandActionPresentation(
                @"Put an item in a fish tank",
                @"Put one backpack item into a placed fish tank, letting the tank's own CanBeDeposited rule decide whether it may hold it. slot, the item's expectedQualifiedItemId, x, y and expectedTargetId must be copied exactly from the worldObjectTargets entry of the MOST RECENT observe result. Success is the tank holding exactly one more item, that one, while the pack lost exactly one; an item the tank will not hold is refused by name (`fish_tank_rejects_item`), and a deposit the engine took the item for but never completed is put back and reported, never as a success.",
                ["world_object"]),
            ["place_item_on_pedestal"] = new FarmhandActionPresentation(
                @"Place an item on a pedestal",
                @"Place one backpack item on an empty pedestal, whose own drop-in action decides acceptance. slot, the item's expectedQualifiedItemId, x, y and expectedTargetId must be copied exactly from the worldObjectTargets entry of the MOST RECENT observe result; the id names the `empty_pedestal` row, because a pedestal already holding something has no such row. An occupied pedestal is refused by name (`pedestal_occupied`) before the call, because its own branch would knock the standing item off, and success is the pedestal's heldObject being this item while the pack lost exactly one.",
                ["world_object"]),
            ["break_resource_clump"] = new FarmhandActionPresentation(
                @"Break a large stump, log or boulder",
                @"Use the Axe or Pickaxe a large stump, hollow log, boulder or meteorite demands on it, one call swinging until the clump is gone. x, y and expectedTargetId must be copied exactly from the debrisTargets entries of the MOST RECENT observe result - never invent or guess coordinates. There is no slot to name: the handler selects the tool the clump's own switch requires and restores the previous selection, and a pack that cannot supply the level it needs is refused by name (`clump_tool_too_weak`). Success is the clump GONE, not the swing's return value.",
                ["debris", "tool"]),
            ["open_geode"] = new FarmhandActionPresentation(
                @"Open a geode",
                @"Crack one carried geode at the blacksmith's own counter, through the game's GeodeMenu, so the machine's assignment and fee decide what comes out. slot and expectedQualifiedItemId must be copied exactly from the `inventoryItemFacts` row of the MOST RECENT observe result, and the slice is checked against that id before anything is consumed, so a stale pair is refused rather than opening a different item. There is no target id and no tile: the counter is the location's own. A counter out of reach, a fee the actor cannot pay and a full backpack are each refused by name, and success is the geode gone and the reward in the pack.",
                ["inventory_slot", "geode"]),
                };

        foreach (KeyValuePair<string, FarmhandActionPresentation> row in byActionId)
            Validate(row.Key, row.Value);
        return new ReadOnlyDictionary<string, FarmhandActionPresentation>(byActionId);
    }

    /// <summary>
    /// Refuses at the Mod build what a reader could not use: a blank label, a sentence past the published bound, or a
    /// kinds list that names no word. The bounds are the ones the wire validator and the artifact's validator apply, so
    /// a row that passes here cannot be refused on the other side of either boundary.
    /// </summary>
    private static void Validate(string actionId, FarmhandActionPresentation presentation)
    {
        FarmhandActionSurfacePublication.ValidateIdentity(actionId, nameof(actionId));
        if (presentation.Label.Length is < 1 or > MaximumLabelLength || presentation.Label.Trim().Length == 0)
            throw new InvalidOperationException($"Farmhand action '{actionId}' must publish a non-blank label of at most {MaximumLabelLength} characters.");
        if (presentation.Description.Length is < 1 or > MaximumDescriptionLength || presentation.Description.Trim().Length == 0)
            throw new InvalidOperationException($"Farmhand action '{actionId}' must publish a non-blank description of at most {MaximumDescriptionLength} characters.");
        if (presentation.TargetKinds.Count is < 1 or > MaximumTargetKinds)
            throw new InvalidOperationException($"Farmhand action '{actionId}' must publish between one and {MaximumTargetKinds} target kinds.");
        foreach (string kind in presentation.TargetKinds)
        {
            if (kind.Length is < 1 or > MaximumTargetKindLength || !IsLowerSnakeWord(kind))
                throw new InvalidOperationException($"Farmhand action '{actionId}' target kind '{kind}' is not a bounded lower_snake word.");
        }
    }

    private static bool IsLowerSnakeWord(string value)
    {
        if (value[0] < 'a' || value[0] > 'z') return false;
        foreach (char character in value)
        {
            if (!((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '_'))
                return false;
        }

        return true;
    }
}
