using System.Collections.ObjectModel;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// What one action is CALLED and the kinds of thing it acts on. The sentence a model reads about it is the Host's.
///
/// <para>
/// THE BOUNDARY, IN ONE SENTENCE A SIDE. The Mod owns the FACTS a tool cannot function without - the action's name, the
/// kinds of thing it acts on, its argument schema, and the bounds on those arguments; the Host owns every SENTENCE a
/// model reads, including the description of every tool it mounts. This record is the Mod's half and it carries exactly
/// two members because exactly two of the three facts the mount loop states are facts: a label names the action, and
/// `targetKinds` names what it addresses, while a description is prose about the model's experience of the tool and
/// changes for reasons that have nothing to do with the game (`game-tools.ts` `DECLARED_ACTION_TOOL_DESCRIPTIONS`).
/// </para>
///
/// <para>
/// WHY THIS IS THE MOD'S TO DECLARE. Measured 2026-11-24: the label and the target kinds existed in the HOST, keyed by
/// action id - the label in `game-tools.ts`'s presentation table and the kinds in `action-registry.ts`'s adapter table -
/// so the one consumer that has to build a tool out of a descriptor, and not out of a name it recognizes, could not:
/// the facts it needs to say anything at all were in a Host file keyed by action id, which is the hand-list this
/// repository keeps replacing with a declaration the owning side publishes.
/// </para>
///
/// <para>
/// WHAT IS DECLARED HERE AND WHAT IS NOT. A row states the two facts and nothing else. WHICH actions have a row is a
/// claim too: exactly the forty-eight whose tool is a projection of the descriptor (`STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS`
/// in the Host), so the two sets are held equal by `FarmhandActionPresentationCoverageTests` and an action that joins one
/// without the other fails by name. The other fifty-eight actions carry NO row, and that absence is the statement rather
/// than an empty list: their tool is still written in its own mount block, and the unit that deletes those mounts is the
/// unit that adds their rows.
/// </para>
///
/// <para>
/// THE BOUND IS THE ONE THE READERS ALREADY APPLY. `MaximumLabelLength` is 128, the same bound the surface's identifier
/// rule and the Host's wire validator apply, and it is checked HERE at the producer because a value that passes this loop
/// cannot be refused by the Host's validator or by the artifact's - the failure belongs to the Mod build, not to a live
/// session's hello.
/// </para>
/// </summary>
public sealed record FarmhandActionPresentation(string Label, IReadOnlyList<string> TargetKinds);

/// <summary>
/// The one declaration of what each published action is called and what it acts on.
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
                ["chat"]),
            ["name_entity"] = new FarmhandActionPresentation(
                @"Name your horse",
                ["horse", "name"]),
            ["express_emote"] = new FarmhandActionPresentation(
                @"Express Stardew Emote",
                ["character_emote"]),
            ["face_direction"] = new FarmhandActionPresentation(
                @"Face Stardew Direction",
                ["character_facing"]),
            ["interact_npc_with_item"] = new FarmhandActionPresentation(
                @"Offer Item to NPC",
                ["npc", "inventory_slot"]),
            ["talk_to_npc"] = new FarmhandActionPresentation(
                @"Talk to Villager",
                ["npc", "dialogue"]),
            ["pet_animal"] = new FarmhandActionPresentation(
                @"Pet Animal",
                ["pet"]),
            ["pet_farm_animal"] = new FarmhandActionPresentation(
                @"Pet Farm Animal",
                ["farm_animal"]),
            ["sleep"] = new FarmhandActionPresentation(
                @"Sleep and Advance the Day",
                ["own_bed", "day_lifecycle"]),
            ["dismiss_modal"] = new FarmhandActionPresentation(
                @"Dismiss a Dialog",
                ["dialogue", "modal"]),
            ["ride_bus"] = new FarmhandActionPresentation(
                @"Ride the Bus",
                ["bus_ticket_machine"]),
            ["withdraw_silo_hay"] = new FarmhandActionPresentation(
                @"Take hay from a silo",
                ["silo"]),
            ["clear_fish_pond"] = new FarmhandActionPresentation(
                @"Empty a fish pond",
                ["fish_pond"]),
            ["build_farm_building"] = new FarmhandActionPresentation(
                @"Commission a farm building",
                ["buildings"]),
            ["accept_daily_quest"] = new FarmhandActionPresentation(
                @"Accept the day's posted quest",
                ["quests"]),
            ["accept_special_order"] = new FarmhandActionPresentation(
                @"Accept an offered special order",
                ["quests"]),
            ["claim_museum_reward"] = new FarmhandActionPresentation(
                @"Collect the museum rewards you are owed",
                ["museum", "rewards"]),
            ["redeem_prize_ticket"] = new FarmhandActionPresentation(
                @"Redeem a prize ticket",
                ["prize_ticket"]),
            ["tailor_clothing"] = new FarmhandActionPresentation(
                @"Tailor clothing from a recipe pair",
                ["tailoring", "inventory_slot"]),
            ["color_placed_object"] = new FarmhandActionPresentation(
                @"Repaint a placed chest",
                ["world_object", "container"]),
            ["dye_clothing_with_item"] = new FarmhandActionPresentation(
                @"Dye clothing with one item",
                ["tailoring", "inventory_slot"]),
            ["toggle_animal_door"] = new FarmhandActionPresentation(
                @"Toggle an animal door",
                ["animal_door"]),
            ["use_obelisk"] = new FarmhandActionPresentation(
                @"Use a warp obelisk",
                ["obelisk"]),
            ["shop_purchase"] = new FarmhandActionPresentation(
                @"Buy from a shop",
                ["shop"]),
            ["select_mine_elevator_floor"] = new FarmhandActionPresentation(
                @"Use the Mine Elevator",
                ["mine_elevator_floor"]),
            ["answer_dialogue"] = new FarmhandActionPresentation(
                @"Answer a Dialogue",
                ["dialogue", "modal"]),
            ["respond_level_up"] = new FarmhandActionPresentation(
                @"Settle a Level-up",
                ["modal", "level_up"]),
            ["ride_minecart"] = new FarmhandActionPresentation(
                @"Ride a Native Minecart",
                ["minecart_station"]),
            ["sweep_scythe"] = new FarmhandActionPresentation(
                @"Sweep the Scythe Arc",
                ["tool", "weed", "grass"]),
            ["use_mine_ladder"] = new FarmhandActionPresentation(
                @"Leave the mine by its ladder",
                ["mine_entrance"]),
            ["load_building_chest"] = new FarmhandActionPresentation(
                @"Load a building chest",
                ["building_chest"]),
            ["collect_building_chest_output"] = new FarmhandActionPresentation(
                @"Collect building chest output",
                ["building_chest"]),
            ["use_warp_item"] = new FarmhandActionPresentation(
                @"Use a held warp totem",
                ["totem", "travel"]),
            ["pan_ore"] = new FarmhandActionPresentation(
                @"Pan the water for ore",
                ["pan", "ore"]),
            ["claim_mail_attachment"] = new FarmhandActionPresentation(
                @"Claim a mailbox attachment",
                ["mail", "mailbox"]),
            ["equip_wearable"] = new FarmhandActionPresentation(
                @"Equip a wearable",
                ["wearable"]),
            ["unequip_wearable"] = new FarmhandActionPresentation(
                @"Unequip a wearable",
                ["wearable"]),
            ["dismount_transport"] = new FarmhandActionPresentation(
                @"Dismount the ridden transport",
                ["horse"]),
            ["place_owned_object"] = new FarmhandActionPresentation(
                @"Place an owned object",
                ["world_object"]),
            ["remove_placed_item"] = new FarmhandActionPresentation(
                @"Remove a placed object",
                ["world_object"]),
            ["move_placed_furniture"] = new FarmhandActionPresentation(
                @"Pick up placed furniture",
                ["world_object"]),
            ["break_container"] = new FarmhandActionPresentation(
                @"Break a container",
                ["world_object"]),
            ["rotate_furniture"] = new FarmhandActionPresentation(
                @"Rotate placed furniture",
                ["world_object"]),
            ["remove_fence"] = new FarmhandActionPresentation(
                @"Remove a placed fence",
                ["world_object"]),
            ["put_item_in_fish_tank"] = new FarmhandActionPresentation(
                @"Put an item in a fish tank",
                ["world_object"]),
            ["place_item_on_pedestal"] = new FarmhandActionPresentation(
                @"Place an item on a pedestal",
                ["world_object"]),
            ["break_resource_clump"] = new FarmhandActionPresentation(
                @"Break a large stump, log or boulder",
                ["debris", "tool"]),
            ["open_geode"] = new FarmhandActionPresentation(
                @"Open a geode",
                ["inventory_slot", "geode"])
        };

        foreach (KeyValuePair<string, FarmhandActionPresentation> row in byActionId)
            Validate(row.Key, row.Value);
        return new ReadOnlyDictionary<string, FarmhandActionPresentation>(byActionId);
    }

    /// <summary>
    /// Refuses at the Mod build what a reader could not use: a blank label or a kinds list that names no word. The
    /// bounds are the ones the wire validator and the artifact's validator apply, so a row that passes here cannot be
    /// refused on the other side of either boundary.
    /// </summary>
    private static void Validate(string actionId, FarmhandActionPresentation presentation)
    {
        FarmhandActionSurfacePublication.ValidateIdentity(actionId, nameof(actionId));
        if (presentation.Label.Length is < 1 or > MaximumLabelLength || presentation.Label.Trim().Length == 0)
            throw new InvalidOperationException($"Farmhand action '{actionId}' must publish a non-blank label of at most {MaximumLabelLength} characters.");
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
