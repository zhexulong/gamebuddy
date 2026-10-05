namespace GameBuddy.Stardew.Core.Policy;

public enum FarmhandActionLifecycle { Published, LiveVerified, Experimental }
public static class FarmhandActionLifecycleWire { public static string ToWireValue(this FarmhandActionLifecycle lifecycle) => lifecycle switch { FarmhandActionLifecycle.Published => "published", FarmhandActionLifecycle.LiveVerified => "live_verified", FarmhandActionLifecycle.Experimental => "experimental", _ => throw new ArgumentOutOfRangeException(nameof(lifecycle)) }; }
public enum FarmhandOperationKind { Execution, ReadOnly }
public static class FarmhandOperationKindWire { public static string ToWireValue(this FarmhandOperationKind kind) => kind switch { FarmhandOperationKind.Execution => "execution", FarmhandOperationKind.ReadOnly => "read_only", _ => throw new ArgumentOutOfRangeException(nameof(kind)) }; }
public enum FarmhandResourceTemplateValue { ScopePlayer = 1 }
public sealed record FarmhandActionArgument(string Name, string Type, IReadOnlyList<string>? Enum = null);
/// <summary>Mod-owned symbolic resource claim; ScopePlayer materializes embodied_actor to the current scoped player.</summary>
public sealed record FarmhandActionResourceTemplateClaim(string Key, FarmhandResourceTemplateValue Value);
/// <summary>Action-specific typed binding metadata owned exclusively by Mod registration.</summary>
public sealed record FarmhandActionObservationBindingDescriptor(string Type, int Version, bool Required, IReadOnlyList<string> RequiredProperties);
/// <summary>Versioned descriptor contract owned exclusively by Mod registration.</summary>
/// <remarks><see cref="WatchdogMs"/> is the descriptor-owned static execution
/// budget for Body Program nodes of this action (default 60s). It is a Mod
/// registration fact, not an Agent-facing field: the Mod derives a fresh
/// absolute deadline at admission time (watchdog authority decision
/// 2026-09-20). `navigate_to_destination` declares an action-specific 10-minute
/// budget matching its ordinary-pipeline deadline ceiling.</remarks>
public sealed record FarmhandActionDescriptor(IReadOnlyList<FarmhandActionArgument> Arguments, IReadOnlyDictionary<string, string> OutputFacts, IReadOnlyList<FarmhandActionResourceTemplateClaim> ResourceTemplate, string Effect, string Postcondition, string? NativeBinding = null, FarmhandActionObservationBindingDescriptor? SceneTarget = null, FarmhandExecutionAcceptanceFacts? Acceptance = null, long WatchdogMs = FarmhandActionCatalog.DefaultWatchdogMs);
/// <summary>The only ordinary-Farmhand operation membership and descriptor source.</summary>
public sealed record FarmhandActionRegistration(string ActionId, string FamilyId, int IdentityVersion, FarmhandActionLifecycle Lifecycle, FarmhandOperationKind Kind, FarmhandActionHandlerGroup? HandlerGroup, FarmhandActionDescriptor? Descriptor = null);
public enum FarmhandActionHandlerGroup { Movement, Farming, Gathering, MachinesAndAnimals, ResourceTools, Expression, WorldLifecycle, Modal }
public static class FarmhandActionHandlerGroupWire
{
    public static string ToWireValue(this FarmhandActionHandlerGroup group) => group switch
    {
        FarmhandActionHandlerGroup.Movement => "movement",
        FarmhandActionHandlerGroup.Farming => "farming",
        FarmhandActionHandlerGroup.Gathering => "gathering",
        FarmhandActionHandlerGroup.MachinesAndAnimals => "machines_and_animals",
        FarmhandActionHandlerGroup.ResourceTools => "resource_tools",
        FarmhandActionHandlerGroup.Expression => "expression",
        FarmhandActionHandlerGroup.WorldLifecycle => "world_lifecycle",
        FarmhandActionHandlerGroup.Modal => "modal",
        _ => throw new ArgumentOutOfRangeException(nameof(group)),
    };
}

public static class FarmhandActionCatalog
{
    public static readonly IReadOnlyList<string> EmoteEnum = Array.AsReadOnly(new[]
    {
        "happy", "sad", "heart", "exclamation", "note", "sleep", "game", "question",
        "x", "pause", "blush", "angry", "yes", "no", "sick", "laugh", "surprised",
        "hi", "taunt", "uh", "music"
    });

    public static readonly IReadOnlyList<string> DirectionEnum = Array.AsReadOnly(new[]
    {
        "up", "right", "down", "left"
    });

    /// <summary>Semantic tool selector for equip_tool/v2. Mod resolves a canonical
    /// category to the deterministically best owned item; slot stays private.</summary>
    public static readonly IReadOnlyList<string> ToolEnum = Array.AsReadOnly(new[]
    {
        "axe", "pickaxe", "hoe", "watering_can", "fishing_rod", "weapon", "scythe", "shears", "milk_pail", "pan"
    });

    private static readonly IReadOnlyList<FarmhandActionResourceTemplateClaim> EmbodiedActorResource = Array.AsReadOnly(new[]
    {
        new FarmhandActionResourceTemplateClaim("embodied_actor", FarmhandResourceTemplateValue.ScopePlayer),
    });

    /// <summary>Descriptor-owned static watchdog for ordinary short actions</summary>
    /// (hang protection, not ETA; watchdog authority decision 2026-09-20).</summary>
    public const long DefaultWatchdogMs = 60_000;

    /// <summary>Action-specific Body Program watchdog for navigate_to_destination,</summary>
    /// matching its ordinary-pipeline 10-minute deadline ceiling
    /// (BridgeSession.IsFreshExecutionRequest; action-specific coarse upper bound).</summary>
    public const long NavigationWatchdogMs = 600_000;

    /// <summary>
    /// Action-specific watchdog for the cross-day lifecycle. A co-op night waits
    /// on other players' native ready state, a save, and a new-day transition, so
    /// it cannot fit the 60s ordinary-action ceiling; 10 minutes matches the
    /// navigation ceiling and the lifecycle's own ready-barrier budget.
    /// </summary>
    public const long LifecycleWatchdogMs = 600_000;

    public static readonly IReadOnlyList<FarmhandActionRegistration> Registrations = Array.AsReadOnly(new[]
    {
        E("move_to_tile", "movement_navigation", FarmhandActionHandlerGroup.Movement, A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"))),
        E("equip_tool", "body_tools", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("tool", "string", ToolEnum) }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "native_action_postcondition", "Game1.player.CurrentToolIndex")),
        E("travel", "transport_warps", FarmhandActionHandlerGroup.Movement, A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"))),
        // Native 1.6 minecart travel is a distinct action, not a `travel`
        // objective family. Both the Mod's execution parser and
        // FarmhandExecutionAcceptance are exact-shape allow-lists with no
        // optional-argument concept, so a second argument shape means a second
        // action: `travel` stays {x,y} (one native warp at the source tile) and
        // `ride_minecart` declares {x,y,expectedTargetId} where x,y is the
        // minecart STATION tile and expectedTargetId selects one advertised
        // (station, destination) ride. LiveVerified: the target-version
        // native-local gate passed (fixtures/stardew/RUNBOOK.md) on the repaired
        // fixture (scenario name + real UnlockCondition); publication review is
        // still owed for the final `published` rung.
        E("ride_minecart", "transport_warps", FarmhandActionHandlerGroup.Movement, MinecartRide(), FarmhandActionLifecycle.LiveVerified),
        // The bus has no reusable UI-free warp seam: its fare, the driver check,
        // the control freeze and the cutscene all live inside
        // BusStop.answerDialogue("Bus_Yes"). This action therefore drives the
        // native ticket interaction and waits for the arrival the game itself
        // produces (see farmhandexecutioncontroller.busactions.cs).
        E("ride_bus", "transport_warps", FarmhandActionHandlerGroup.Movement, new FarmhandActionDescriptor(
            Array.Empty<FarmhandActionArgument>(),
            new Dictionary<string, string>(),
            EmbodiedActorResource,
            "write",
            "bus_arrived",
            "BusStop.checkAction+answerDialogue"), FarmhandActionLifecycle.LiveVerified),
        E("select_mine_elevator_floor", "world_navigation", FarmhandActionHandlerGroup.Movement, ElevatorFloor(), FarmhandActionLifecycle.LiveVerified),
        E("use_raft", "water_travel", FarmhandActionHandlerGroup.Movement, A(null, null, "raft_launched", ("slot", "integer"), ("x", "integer"), ("y", "integer")), FarmhandActionLifecycle.LiveVerified),
        E("mount_transport", "animal_transport", FarmhandActionHandlerGroup.Movement, A(null, null, "horse_mounted", ("x", "integer"), ("y", "integer"), ("expectedTargetId", "string")), FarmhandActionLifecycle.LiveVerified),
        E("enter_mine", "world_navigation", FarmhandActionHandlerGroup.Movement, A(null, null, "mine_entered", ("x", "integer"), ("y", "integer"), ("expectedTargetId", "string")), FarmhandActionLifecycle.LiveVerified),
        E("enter_exit", "movement_navigation", FarmhandActionHandlerGroup.Movement, A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"))),
        E("till_soil", "farming_crops", FarmhandActionHandlerGroup.Farming, A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"))),
        E("pickup_forage", "resource_gathering", FarmhandActionHandlerGroup.Gathering, PickupForage()), E("pickup_item", "inventory_items", FarmhandActionHandlerGroup.Gathering, TargetItem()),
        E("water_crop", "farming_crops", FarmhandActionHandlerGroup.Farming, Target()), E("plant_seed", "farming_crops", FarmhandActionHandlerGroup.Farming, SlotItemTarget()), E("fertilize_tile", "farming_crops", FarmhandActionHandlerGroup.Farming, SlotItemTarget()),
        E("machine_inspect", "machines_processing", FarmhandActionHandlerGroup.MachinesAndAnimals, MachineInspect()), E("machine_load", "machines_processing", FarmhandActionHandlerGroup.MachinesAndAnimals, SlotItemTarget("(O)433")), E("machine_collect_output", "machines_processing", FarmhandActionHandlerGroup.MachinesAndAnimals, Target()),
        E("collect_animal_product", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, SlotTarget()), E("feed_animal", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, SlotTarget()), E("use_item", "inventory_items", FarmhandActionHandlerGroup.MachinesAndAnimals, A(null, null, "native_action_postcondition", ("slot","integer"),("expectedQualifiedItemId","string"))),
        E("harvest_crop", "farming_crops", FarmhandActionHandlerGroup.Farming, TargetItem()), E("place_wood_fence", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SlotItemTarget("(O)322")), E("place_crab_pot", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SlotItemTarget("(O)710")), E("bait_crab_pot", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SlotItemTarget("(O)685")),
        E("chop_tree_source", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SlotTarget()), E("break_rock_source", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SlotTarget()), E("clear_hoedirt", "farming_crops", FarmhandActionHandlerGroup.Farming, SlotTarget()), E("dig_artifact_spot", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SlotTarget()), E("refill_watering_can", "farming_crops", FarmhandActionHandlerGroup.ResourceTools, SlotTarget()),
        R("inspect_world_map", "world_navigation"), R("find_destination", "world_navigation"), R("observe_scene", "world_perception"),
        E("navigate_to_destination", "world_navigation", FarmhandActionHandlerGroup.Movement, new FarmhandActionDescriptor(
            new[] { new FarmhandActionArgument("destination", "destination_selector") },
            new Dictionary<string, string> { ["arrival"] = "destination_arrival" },
            EmbodiedActorResource, "write", "arrived_at_destination",
            WatchdogMs: NavigationWatchdogMs)),
        E("clear_debris", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SlotTarget(), FarmhandActionLifecycle.LiveVerified),
        E("npc_relationship", "npc_social", FarmhandActionHandlerGroup.MachinesAndAnimals, Target(), FarmhandActionLifecycle.LiveVerified),
        E("pet_animal", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, Target(), FarmhandActionLifecycle.LiveVerified),
        E("water_pet_bowl", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, Target(), FarmhandActionLifecycle.LiveVerified),
        E("water_slime_hutch_trough", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, Target(), FarmhandActionLifecycle.LiveVerified),
        E("interact_npc_with_item", "npc_social", FarmhandActionHandlerGroup.MachinesAndAnimals, SlotItemTarget(), FarmhandActionLifecycle.LiveVerified),
        E("express_emote", "expression", FarmhandActionHandlerGroup.Expression, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("emote", "string", EmoteEnum) }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "emote_started", "Farmer.doEmote"), FarmhandActionLifecycle.LiveVerified),
        E("face_direction", "movement_navigation", FarmhandActionHandlerGroup.Movement, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("direction", "string", DirectionEnum) }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "actor_facing_matches", "Farmer.faceDirection"), FarmhandActionLifecycle.LiveVerified),
        E("chest_store", "inventory_items", FarmhandActionHandlerGroup.MachinesAndAnimals, SlotItemTarget(), FarmhandActionLifecycle.LiveVerified),
        E("chest_retrieve", "inventory_items", FarmhandActionHandlerGroup.MachinesAndAnimals, SlotItemTarget(), FarmhandActionLifecycle.LiveVerified),
        E("chop_stump", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SlotTarget(), FarmhandActionLifecycle.LiveVerified),
        E("plant_sapling", "farming_crops", FarmhandActionHandlerGroup.Farming, SlotItemTarget(), FarmhandActionLifecycle.LiveVerified),
        E("cut_weeds", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SlotTarget(), FarmhandActionLifecycle.LiveVerified),
        E("cut_grass", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SlotTarget(), FarmhandActionLifecycle.LiveVerified),
        E("clear_cask", "facility_storage_lighting", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "cask_cleared", "Cask.performToolAction"), FarmhandActionLifecycle.LiveVerified),
        E("dress_mannequin", "facility_storage_lighting", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "mannequin_dressed", "Mannequin.performObjectDropInAction"), FarmhandActionLifecycle.LiveVerified),
        E("set_sign_display", "facility_storage_lighting", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "sign_display_set", "Sign.checkForAction"), FarmhandActionLifecycle.LiveVerified),
        E("deposit_silo_hay", "facility_storage_lighting", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "silo_hay_deposited", "GameLocation.tryToAddHay"), FarmhandActionLifecycle.LiveVerified),
        E("toggle_tool_light", "facility_storage_lighting", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("slot", "integer"), new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "tool_light_toggled", "Lantern.DoFunction"), FarmhandActionLifecycle.LiveVerified),
        E("scythe_crop", "farming_crops", FarmhandActionHandlerGroup.Farming, SlotTarget(), FarmhandActionLifecycle.LiveVerified),
        E("harvest_bush", "resource_gathering", FarmhandActionHandlerGroup.Farming, Target(), FarmhandActionLifecycle.LiveVerified),
        E("harvest_fruit_tree", "resource_gathering", FarmhandActionHandlerGroup.Farming, Target(), FarmhandActionLifecycle.LiveVerified),
        E("shake_tree", "resource_gathering", FarmhandActionHandlerGroup.Farming, Target(), FarmhandActionLifecycle.LiveVerified),
        E("take_pedestal_item", "inventory_items", FarmhandActionHandlerGroup.MachinesAndAnimals, Target(), FarmhandActionLifecycle.LiveVerified),
        E("toggle_fence_gate", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, Target(), FarmhandActionLifecycle.LiveVerified),
        // Loop-closure W0a pre-registration. W0a owns registration and routing;
        // the native bodies are lane-owned partials
        // (farmhandexecutioncontroller.{crafting,cooking,crabpot,shipping}actions.cs)
        // whose placeholder terminals are replaced by lanes B/C/D/E.
        // craft_item and cook_recipe share one shape: both carry the opaque recipe
        // content identity in expectedTargetId, which the Mod re-validates against
        // the live craftingRecipes/cookingRecipes table on the game thread (an
        // unknown or unlearned recipe fails closed). cook_recipe's W-rule cooking
        // station adjacency is derived and re-checked Mod-side from the live world,
        // exactly like the other action-level game-thread re-validations, rather
        // than trusting a client-supplied station coordinate.
        // collect_crab_pot_output reuses the machine-collect target shape;
        // ship_item reuses the slot+target shape so its canBeShipped admission
        // guard can still resolve the exact slot item.
        E("craft_item", "crafting_cooking", FarmhandActionHandlerGroup.MachinesAndAnimals, A(null, null, "native_action_postcondition", ("expectedTargetId", "string")), FarmhandActionLifecycle.LiveVerified),
        E("cook_recipe", "crafting_cooking", FarmhandActionHandlerGroup.MachinesAndAnimals, A(null, null, "native_action_postcondition", ("expectedTargetId", "string")), FarmhandActionLifecycle.LiveVerified),
        E("collect_crab_pot_output", "buildings_farm_management", FarmhandActionHandlerGroup.MachinesAndAnimals, Target(), FarmhandActionLifecycle.LiveVerified),
        E("ship_item", "shops_economy", FarmhandActionHandlerGroup.MachinesAndAnimals, SlotItemTarget(), FarmhandActionLifecycle.LiveVerified),
    // WIA §4.2 modal-handling family: the ONE action that may run while the
    // world holds a modal. `dismiss_modal` only closes an informational native
    // dialogue (a DialogueBox with no pending question); answering a question
    // dialogue is answer_dialogue's future seam (design 7.4.2) and is refused
    // here. It carries no arguments: the target is the currently open modal
    // itself, and readiness is native state. The receipt is minted by the one
    // execution ledger and the Modal admission profile (AdmitExecution) is the
    // only profile that grants it admission.
    E("dismiss_modal", "modal_handling", FarmhandActionHandlerGroup.Modal, new FarmhandActionDescriptor(
        Array.Empty<FarmhandActionArgument>(),
        new Dictionary<string, string>(),
        EmbodiedActorResource,
        "write",
        "modal_dismissed",
        "DialogueBox.closeDialogue"), FarmhandActionLifecycle.Experimental),
        E("answer_dialogue", "modal_handling", FarmhandActionHandlerGroup.Modal, new FarmhandActionDescriptor(
            new[] { new FarmhandActionArgument("responseKey", "string") },
            new Dictionary<string, string>(),
            EmbodiedActorResource,
            "write",
            "answer_dialogue_answered",
            "GameLocation.answerDialogue"), FarmhandActionLifecycle.Experimental),
        // M2 cross-day lifecycle wiring. The catalog contract
        // (single_player_sleep_and_advance_day / end_day_with_all_players_ready)
        // is coordinated, but the AI's own share of it is one bounded native
        // lifecycle: walk to the actor's own bed, let the native sleep path run
        // exactly as the keyboard/mouse paths do, declare local ready through
        // that same native path, then OBSERVE the native Saving/Saved/DayStarted
        // pipeline. It carries no arguments because the target is the actor's own
        // bed and the ready state is native; nothing about it is client-supplied.
        // The receipt is minted by the one execution ledger, so a coordinated
        // terminal (requires_other_player) is traceable rather than a second
        // receipt authority.
        E("advance_day", "world_lifecycle", FarmhandActionHandlerGroup.WorldLifecycle, Lifecycle(), FarmhandActionLifecycle.LiveVerified),
    });
    static FarmhandActionCatalog() { if (Registrations.Select(x => x.ActionId).Distinct(StringComparer.Ordinal).Count() != Registrations.Count) throw new InvalidOperationException("Farmhand action registrations must have unique action IDs."); }
    private static FarmhandActionRegistration E(string id, string family, FarmhandActionHandlerGroup group, FarmhandActionDescriptor descriptor, FarmhandActionLifecycle lifecycle = FarmhandActionLifecycle.Published) => new(id, family, 1, lifecycle, FarmhandOperationKind.Execution, group, descriptor);
    private static FarmhandActionRegistration R(string id, string family) => new(id, family, 1, FarmhandActionLifecycle.Published, FarmhandOperationKind.ReadOnly, null, A(null, Array.Empty<FarmhandActionResourceTemplateClaim>(), "observation_complete"));
    private static FarmhandActionDescriptor A(IReadOnlyDictionary<string,string>? facts = null, IReadOnlyList<FarmhandActionResourceTemplateClaim>? resources = null, string postcondition = "native_action_postcondition", params (string,string)[] args) => new(args.Select(x => new FarmhandActionArgument(x.Item1,x.Item2)).ToArray(), facts ?? new Dictionary<string,string>(), resources ?? EmbodiedActorResource, resources is { Count: 0 } ? "read" : "write", postcondition);
    private static FarmhandActionDescriptor Target() => A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"),("expectedTargetId","string"));
    private static FarmhandActionDescriptor TargetItem() => A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"),("expectedQualifiedItemId","string"),("expectedTargetId","string"));
    private static FarmhandActionDescriptor PickupForage() => new(
        new[]
        {
            new FarmhandActionArgument("x", "integer"),
            new FarmhandActionArgument("y", "integer"),
            new FarmhandActionArgument("expectedQualifiedItemId", "string"),
            new FarmhandActionArgument("expectedTargetId", "string"),
        },
        new Dictionary<string, string>(),
        EmbodiedActorResource,
        "write",
        "native_action_postcondition",
        null,
        new FarmhandActionObservationBindingDescriptor("ObservationBinding", 1, true, new[] { "observationId", "ref" }));
    private static FarmhandActionDescriptor SlotTarget() => A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"),("slot","integer"),("expectedTargetId","string"));

    /// <summary>
    /// ride_minecart carries the station tile plus the opaque published ride
    /// selector, and names the ride's own terminal so the Host can map exactly
    /// this action's postcondition instead of a bare coordinate pair.
    /// </summary>
    private static FarmhandActionDescriptor MinecartRide() => A(
        null,
        null,
        "minecart_ride_completed",
        ("x", "integer"), ("y", "integer"), ("expectedTargetId", "string"));

    /// <summary>
    /// The mine elevator has no client coordinate: its whole intent is WHICH
    /// already-reached floor to select, and the native floor set is a pure function
    /// of the live <c>MineShaft.lowestLevelReached</c> (floor 0, plus every multiple
    /// of 5 up to min(lowestLevelReached, 120) — the exact enumeration
    /// <c>MineElevatorMenu</c> builds at MineElevatorMenu.cs:16/37). The Mod
    /// re-derives that set on the game thread and refuses an unadvertised floor, so a
    /// client cannot use this action to teleport to a level the player has not
    /// reached.
    ///
    /// Terminal: the selection the menu itself performs —
    /// <c>Game1.enterMine(floor)</c> after setting the public
    /// <c>Farmer.ridingMineElevator</c> flag (the mine entrance reads it to place the
    /// actor on the elevator tile rather than the ladder), or for floor 0 the
    /// <c>Game1.warpFarmer("Mine", 17, 4)</c> return. Both are public; the floor
    /// SELECTION only exists inside the menu's receiveLeftClick, which is why this is
    /// an action rather than a travel target. See
    /// farmhandexecutioncontroller.mineelevatoractions.cs.
    /// </summary>
    private static FarmhandActionDescriptor ElevatorFloor() => A(
        null,
        null,
        "mine_elevator_floor_selected",
        ("expectedTargetId", "string"));

    /// <summary>advance_day carries no arguments: its target is the actor's own bed and its
    /// readiness is native state, so no client coordinate, slot, or target identity is trusted.</summary>
    private static FarmhandActionDescriptor Lifecycle() => new FarmhandActionDescriptor(
        Array.Empty<FarmhandActionArgument>(),
        new Dictionary<string, string>(),
        EmbodiedActorResource,
        "write",
        "day_advanced",
        null) with
    {
        WatchdogMs = FarmhandActionCatalog.LifecycleWatchdogMs,
    };
    private static FarmhandActionDescriptor SlotItemTarget(string? exactQualifiedItemId = null) => exactQualifiedItemId is null
        ? A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"),("slot","integer"),("expectedQualifiedItemId","string"),("expectedTargetId","string"))
        : A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"),("slot","integer"),("expectedQualifiedItemId","string"),("expectedTargetId","string")) with
        {
            Acceptance = new FarmhandExecutionAcceptanceFacts(ExactExpectedQualifiedItemId: exactQualifiedItemId),
        };
    /// <summary>
    /// Frozen Body Program read-only source descriptor: machine_inspect is a
    /// read-only observation whose declared output fact machine_target_id:string
    /// carries the action-validated opaque machine target identity that
    /// machine_load's expectedTargetId binds via RFC 6901 on the exact
    /// producing {programId,nodeId,nodeAttempt}.
    /// </summary>
    private static FarmhandActionDescriptor MachineInspect() => new(
        new[] { new FarmhandActionArgument("x","integer"), new FarmhandActionArgument("y","integer"), new FarmhandActionArgument("expectedTargetId","string") },
        new Dictionary<string, string> { ["machine_target_id"] = "string" },
        EmbodiedActorResource, "read", "native_action_postcondition");
}
