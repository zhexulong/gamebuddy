namespace GameBuddy.Stardew.Core.Policy;

public enum FarmhandActionLifecycle { Published, LiveVerified, Experimental }
public static class FarmhandActionLifecycleWire { public static string ToWireValue(this FarmhandActionLifecycle lifecycle) => lifecycle switch { FarmhandActionLifecycle.Published => "published", FarmhandActionLifecycle.LiveVerified => "live_verified", FarmhandActionLifecycle.Experimental => "experimental", _ => throw new ArgumentOutOfRangeException(nameof(lifecycle)) }; }
public enum FarmhandOperationKind { Execution, ReadOnly }
public static class FarmhandOperationKindWire { public static string ToWireValue(this FarmhandOperationKind kind) => kind switch { FarmhandOperationKind.Execution => "execution", FarmhandOperationKind.ReadOnly => "read_only", _ => throw new ArgumentOutOfRangeException(nameof(kind)) }; }
/// <summary>
/// The symbolic value half of a <see cref="FarmhandActionResourceTemplateClaim"/>. It says what the claim
/// materializes to, never a live identity: the Mod re-derives that on the game thread.
/// </summary>
public enum FarmhandResourceTemplateValue
{
    /// <summary>`embodied_actor`: the current scoped player.</summary>
    ScopePlayer = 1,

    /// <summary>
    /// `tool:&lt;category&gt;`: any upgrade level of that tool category satisfies the claim (minimum level 0).
    /// </summary>
    AnyUpgrade = 2,

    /// <summary>
    /// `tool:&lt;category&gt;`: only the level-0 (basic) tool of that category satisfies the claim. The handlers select
    /// the tool their claim names, so an upgraded one is refused by name
    /// (`tool_upgrade_insufficient:&lt;category&gt;:&lt;need&gt;:&lt;have&gt;`) rather than silently used: "any axe" would be
    /// a wrong promise.</summary>
    BasicOnly = 3,
}
public sealed record FarmhandActionArgument(string Name, string Type, IReadOnlyList<string>? Enum = null, string? Description = null);
/// <summary>Mod-owned symbolic resource claim; ScopePlayer materializes embodied_actor to the current scoped player.
/// A `tool:&lt;category&gt;` key is the SAME shape with a different subject: the tool that category names, which the
/// handler requires to be the current tool, and whose value half is the upgrade-level requirement
/// (<see cref="FarmhandResourceTemplateValue.AnyUpgrade"/> / <see cref="FarmhandResourceTemplateValue.BasicOnly"/>).</summary>
public sealed record FarmhandActionResourceTemplateClaim(string Key, FarmhandResourceTemplateValue Value);

/// <summary>
/// Where the actor's body must be before an action can happen.
///
/// Declared beside the claims but deliberately NOT a claim: `embodied_actor` and `tool:&lt;category&gt;` say what the
/// action OCCUPIES for its duration, and a spatial precondition says where the body must already be. Folding the
/// second into the first would give a resource claim two meanings, and the Host's projection reads claims as
/// resources.
///
/// Why it exists: measured 2026-10-25, the companion submitted a one-node program `enter_exit(3,12)` while it was in
/// bed at `FarmHouse(9,9)`. The Mod refused with `door_out_of_range` - correctly - and the companion learned the
/// precondition only by being refused, then added `move_to_tile(3,11)` on its second attempt and succeeded. A
/// refusal that teaches is worse than a shape that says so.
/// </summary>
/// <param name="Relation">The surface's own word for the relationship, e.g. `adjacent`.</param>
/// <param name="WithinTiles">How far away that relationship allows, or null when the surface states no distance.</param>
public sealed record FarmhandActionApproachRequirement(string Relation, int? WithinTiles);
/// <summary>Action-specific typed binding metadata owned exclusively by Mod registration.</summary>
public sealed record FarmhandActionObservationBindingDescriptor(string Type, int Version, bool Required, IReadOnlyList<string> RequiredProperties);
/// <summary>Versioned descriptor contract owned exclusively by Mod registration.</summary>
/// <remarks><see cref="WatchdogMs"/> is the descriptor-owned static execution
/// budget for Body Program nodes of this action (default 60s). It is a Mod
/// registration fact, not an Agent-facing field: the Mod derives a fresh
/// absolute deadline at admission time (watchdog authority decision
/// 2026-09-20). `navigate_to_destination` declares an action-specific 10-minute
/// budget matching its ordinary-pipeline deadline ceiling.</remarks>
public sealed record FarmhandActionDescriptor(IReadOnlyList<FarmhandActionArgument> Arguments, IReadOnlyDictionary<string, string> OutputFacts, IReadOnlyList<FarmhandActionResourceTemplateClaim> ResourceTemplate, string Effect, string Postcondition, string? NativeBinding = null, FarmhandActionObservationBindingDescriptor? SceneTarget = null, FarmhandExecutionAcceptanceFacts? Acceptance = null, FarmhandActionApproachRequirement? Approach = null, long WatchdogMs = FarmhandActionCatalog.DefaultWatchdogMs);
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
    /// <summary>
    /// One native chat line's worth of text. The native ingress is a single 896-px line (ChatBox.cs:91) that stops
    /// accepting input once the text would overrun it (ChatTextBox.cs:39), so a longer payload is not a chat line at
    /// all. It lives HERE, on the Core side, because both the wire validator and the Mod handler must read the same
    /// number - an argument the wire accepts but the handler refuses (or the reverse) is a registered capability that
    /// cannot be invoked, which is the defect `quantity` once was.
    /// </summary>
    public const int ChatMessageMaximumLength = 256;

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

    /// <summary>
    /// The two ways a displayed <c>LevelUpMenu</c> can be settled, plus the ordinary confirmation.
    ///
    /// <c>confirm</c> is legal only for an ordinary level and <c>branch_a</c>/<c>branch_b</c> only for a
    /// profession milestone; the Mod refuses the other pairings by name. There is deliberately no "pick the
    /// first branch" value: which professions level 10 offers depends on the level-5 choice
    /// (<c>LevelUpMenu.cs:428-436</c>), so a default would decide the companion's growth path for it.
    /// </summary>
    public static readonly IReadOnlyList<string> LevelUpChoiceEnum = Array.AsReadOnly(new[]
        {
            "confirm", "branch_a", "branch_b"
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

    /// <summary>
    /// The SAME claim shape as <see cref="EmbodiedActorResource"/>, with the TOOL the handler requires the actor to be
    /// holding as its subject: `tool:&lt;category&gt;` plus the upgrade-level requirement that handler enforces. It is a
    /// resource claim and not a new descriptor field because it names a native resource the action needs; the one
    /// fact the Host cannot derive from the world and therefore could not plan around (it used to guess, then eat a
    /// `*_not_equipped_in_requested_slot` refusal). Category vocabulary is <see cref="FarmhandActionCatalog.ToolEnum"/>,
    /// the same one `equip_tool` selects on, so a planner can satisfy the claim with the action it already has.
    /// </summary>
    private static IReadOnlyList<FarmhandActionResourceTemplateClaim> ToolResource(string category, FarmhandResourceTemplateValue upgrade) => Array.AsReadOnly(new[]
    {
        new FarmhandActionResourceTemplateClaim("embodied_actor", FarmhandResourceTemplateValue.ScopePlayer),
        new FarmhandActionResourceTemplateClaim($"tool:{category}", upgrade),
    });

    /// <summary>Descriptor-owned static watchdog for ordinary short actions</summary>
    /// (hang protection, not ETA; watchdog authority decision 2026-09-20).</summary>
    public const long DefaultWatchdogMs = 60_000;

    /// <summary>Action-specific Body Program watchdog for navigate_to_destination, matching its own published ceiling.</summary>
    /// <summary>
    /// The ceiling for an ORDINARY action's declared deadline: one minute. It is the FALLBACK for an action whose
    /// registration publishes no watchdog, and it is the same number the Host uses when it sizes a dispatch deadline
    /// (`DEFAULT_DISPATCH_DEADLINE_MS`), so the two sides fall back identically.
    ///
    /// Both sides otherwise read the action's OWN published watchdog: `BridgeSession.IsFreshExecutionRequest` accepts
    /// a deadline up to `descriptor.WatchdogMs`, and the Host sizes the deadline from that same number. The two used to
    /// disagree - the text below records that this ceiling "was the reason `advance_day` could not converge", while
    /// `IsFreshExecutionRequest` kept its own hard-coded split beside the parameterised ceiling, so a multi-day run's
    /// own `advance_day` was refused by name (`invalid_deadline`).
    /// </summary>
    public const long OrdinaryActionCeilingMs = 60_000;

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
        E("ride_minecart", "transport_warps", FarmhandActionHandlerGroup.Movement, MinecartRide() with { Approach = new FarmhandActionApproachRequirement("adjacent", 1) }, FarmhandActionLifecycle.LiveVerified),
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
        E("use_raft", "water_travel", FarmhandActionHandlerGroup.Movement, Described(new[] { new FarmhandActionArgument("slot", "integer", null, ToolSlotMeaning), new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer") }, "raft_launched"), FarmhandActionLifecycle.LiveVerified),
        // approachRequirement is NOT declared: both handlers walk the actor in themselves
        // (`TryBeginToolApproach`), so "you must already stand beside this" would be false.
        //
        // Stated precisely: the declaration lives on `FarmhandActionCatalog` and `FarmhandActionSurfacePublication`
        // (the `action-surface.v1.json` artifact), and `BridgeSession` also publishes it on the `hello_ack`
        // `FarmhandActionDescriptorWire` so `plan_shape` can answer with it.
        E("mount_transport", "animal_transport", FarmhandActionHandlerGroup.Movement, A(null, null, "horse_mounted", ("x", "integer"), ("y", "integer"), ("expectedTargetId", "string")), FarmhandActionLifecycle.LiveVerified),
        E("enter_mine", "world_navigation", FarmhandActionHandlerGroup.Movement, A(null, null, "mine_entered", ("x", "integer"), ("y", "integer"), ("expectedTargetId", "string")), FarmhandActionLifecycle.LiveVerified),
        // `enter_exit` resolves a warp from (x,y) and refuses when the actor is more than one tile from it
// (`Utility.tileWithinRadiusOfPlayer(sourceX, sourceY, 1, player)`), so the body must already stand beside the
// door. Measured 2026-10-25: the companion submitted this as a one-node program from its bed six tiles away and
// learned the precondition only by being refused. Declared here so `plan_shape` can say it instead.
E("enter_exit", "movement_navigation", FarmhandActionHandlerGroup.Movement, A(null, null, "native_action_postcondition", ("x","integer"),("y","integer")) with { Approach = new FarmhandActionApproachRequirement("adjacent", 1) }),
        E("till_soil", "farming_crops", FarmhandActionHandlerGroup.Farming, A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"))),
        E("pickup_forage", "resource_gathering", FarmhandActionHandlerGroup.Gathering, PickupForage() with { Approach = new FarmhandActionApproachRequirement("adjacent", 1) }), E("pickup_item", "inventory_items", FarmhandActionHandlerGroup.Gathering, TargetItem()),
        // water_crop drives the actor's own WateringCan: the handler selects the can its claim names before watering
        // (`tool_not_owned:watering_can` when the pack holds none), so the can is an unconditional requirement.
        // Which can is NOT declared: the handler accepts any upgrade level (its `watering_can_empty` refusal is about
        // the can's water, runtime state a planner cannot read from the surface).
        E("water_crop", "farming_crops", FarmhandActionHandlerGroup.Farming, TargetWith("watering_can", FarmhandResourceTemplateValue.AnyUpgrade)), E("plant_seed", "farming_crops", FarmhandActionHandlerGroup.Farming, SlotItemTarget()), E("fertilize_tile", "farming_crops", FarmhandActionHandlerGroup.Farming, SlotItemTarget()),
        E("machine_inspect", "machines_processing", FarmhandActionHandlerGroup.MachinesAndAnimals, MachineInspect()), E("machine_load", "machines_processing", FarmhandActionHandlerGroup.MachinesAndAnimals, SlotItemTarget("(O)433")), E("machine_collect_output", "machines_processing", FarmhandActionHandlerGroup.MachinesAndAnimals, Target()),
        E("collect_animal_product", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, SlotTarget()), E("feed_animal", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, SlotTarget()), E("use_item", "inventory_items", FarmhandActionHandlerGroup.MachinesAndAnimals, Described(new[] { new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedQualifiedItemId", "string") })),
        E("harvest_crop", "farming_crops", FarmhandActionHandlerGroup.Farming, TargetItem()), E("place_wood_fence", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SlotItemTarget("(O)322")), E("place_crab_pot", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SlotItemTarget("(O)710")), E("bait_crab_pot", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SlotItemTarget("(O)685")),

        E("place_owned_object", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedQualifiedItemId", "string"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "owned_object_placed", "Object.placementAction"), FarmhandActionLifecycle.LiveVerified),
        E("remove_placed_item", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "placed_item_removed", "Object.performRemoveAction"), FarmhandActionLifecycle.LiveVerified),
        E("break_container_source", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "container_source_broken", "BreakableContainer.performToolAction"), FarmhandActionLifecycle.LiveVerified),
        // Declares the axe its handler requires, like break_rock_source declares its pickaxe. Without the claim there was
        // nothing for the handler to select from, so it demanded the caller pre-equip - the one asymmetry between
        // chopping and the three actions that had already moved to declared tool selection.
        E("chop_tree_source", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SlotTargetWith("axe", FarmhandResourceTemplateValue.BasicOnly)),
        E("break_rock_source", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SlotTargetWith("pickaxe", FarmhandResourceTemplateValue.BasicOnly)), E("clear_hoedirt", "farming_crops", FarmhandActionHandlerGroup.Farming, SlotTarget()), E("dig_artifact_spot", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SlotTarget()), E("refill_watering_can", "farming_crops", FarmhandActionHandlerGroup.ResourceTools, SlotTarget()),
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
        // Talking is the OTHER half of NPC.checkAction (NPC.cs:2464) and is its own
        // action rather than an optional argument on the gift action, because the
        // protocol has no optional arguments and the two intents are orthogonal
        // (owner ruling: method-layer verdict NPC.checkAction@2464 ->
        // newPrimitive("talk_to_npc"), stardew-action-inventory-reconciliation.mjs:406).
        // Same {x,y,expectedTargetId} shape as npc_relationship: the actor names the
        // villager through the NPC family's opaque target id and the Mod re-resolves
        // the person on the game thread. Experimental: it stays off the default Agent
        // surface until it passes its own native-local live gate, and the promotion to
        // LiveVerified is a separate catalog edit owned by the parent.
        E("talk_to_npc", "npc_social", FarmhandActionHandlerGroup.MachinesAndAnimals, A(null, null, "npc_talked", ("x", "integer"), ("y", "integer"), ("expectedTargetId", "string")), FarmhandActionLifecycle.LiveVerified),
        E("express_emote", "expression", FarmhandActionHandlerGroup.Expression, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("emote", "string", EmoteEnum) }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "emote_started", "Farmer.doEmote"), FarmhandActionLifecycle.LiveVerified),
        E("face_direction", "movement_navigation", FarmhandActionHandlerGroup.Movement, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("direction", "string", DirectionEnum) }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "actor_facing_matches", "Farmer.faceDirection"), FarmhandActionLifecycle.LiveVerified),
        E("chest_store", "inventory_items", FarmhandActionHandlerGroup.MachinesAndAnimals, SlotItemTarget(), FarmhandActionLifecycle.LiveVerified),
        E("chest_retrieve", "inventory_items", FarmhandActionHandlerGroup.MachinesAndAnimals, SlotItemTarget(), FarmhandActionLifecycle.LiveVerified),
        E("chop_stump", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SlotTargetWith("axe", FarmhandResourceTemplateValue.BasicOnly), FarmhandActionLifecycle.LiveVerified),
        E("plant_sapling", "farming_crops", FarmhandActionHandlerGroup.Farming, SlotItemTarget(), FarmhandActionLifecycle.LiveVerified),
        // Scythe actions: the handler selects the actor's own scythe before swinging, from the `tool:scythe` claim
        // below. A scythe has no upgrade ladder, so "any" is exact.
        E("cut_weeds", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SlotTargetWith("scythe", FarmhandResourceTemplateValue.AnyUpgrade), FarmhandActionLifecycle.LiveVerified),
        E("cut_grass", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SlotTargetWith("scythe", FarmhandResourceTemplateValue.AnyUpgrade), FarmhandActionLifecycle.LiveVerified),
        E("clear_cask", "facility_storage_lighting", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "cask_cleared", "Cask.performToolAction"), FarmhandActionLifecycle.LiveVerified),
        E("dress_mannequin", "facility_storage_lighting", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "mannequin_dressed", "Mannequin.performObjectDropInAction"), FarmhandActionLifecycle.LiveVerified),
        E("set_sign_display", "facility_storage_lighting", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "sign_display_set", "Sign.checkForAction"), FarmhandActionLifecycle.LiveVerified),
        E("deposit_silo_hay", "facility_storage_lighting", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "silo_hay_deposited", "GameLocation.tryToAddHay"), FarmhandActionLifecycle.LiveVerified),
        E("toggle_tool_light", "facility_storage_lighting", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("slot", "integer", null, ToolSlotMeaning), new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "tool_light_toggled", "Lantern.DoFunction"), FarmhandActionLifecycle.LiveVerified),
        E("withdraw_silo_hay", "facility_storage_lighting", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "silo_hay_taken", "GameLocation.GetHayFromAnySilo"), FarmhandActionLifecycle.LiveVerified),
        E("use_obelisk", "transport_warps", FarmhandActionHandlerGroup.Movement, A(null, null, "obelisk_arrived", ("x", "integer"), ("y", "integer"), ("expectedTargetId", "string")) with { Approach = new FarmhandActionApproachRequirement("adjacent", 1) }, FarmhandActionLifecycle.LiveVerified),
        E("toggle_animal_door", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "animal_door_toggled", "Building.ToggleAnimalDoor"), FarmhandActionLifecycle.LiveVerified),
        // Item/tile lane. use_warp_item is the native object branch plus the consumption the
        // action-button dispatch pairs with it; pan_ore is the one-use panning lifecycle; the
        // mailbox claim is the TALK/claim verb on a map Action tile. All three stay
        // Experimental until each passes its own native-local live gate.
        E("use_warp_item", "inventory_items", FarmhandActionHandlerGroup.MachinesAndAnimals, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("slot", "integer", null, ToolSlotMeaning), new FarmhandActionArgument("expectedQualifiedItemId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "warp_item_arrived", "Object.performUseAction"), FarmhandActionLifecycle.LiveVerified),
        E("pan_ore", "body_tools", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("slot", "integer", null, ToolSlotMeaning), new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "ore_panned", "Pan.DoFunction"), FarmhandActionLifecycle.LiveVerified),
        E("claim_mail_attachment", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "mail_claimed", "GameLocation.mailbox"), FarmhandActionLifecycle.LiveVerified),
        // The building-chest pair. Some buildings declare their OWN storage in Data/Buildings
        // (BuildingData.Chests: the Mill's Input/Output, the Junimo Hut's Output), reached by
        // a click on a building tile rather than by any C# class, so neither
        // chest_store/chest_retrieve (player-owned Chests and the fridge) nor
        // machine_load/machine_collect_output (one machine's heldObject) can serve them.
        // Both drive the terminal public `Building.PerformBuildingChestAction`
        // (Building.cs:746) that the native click path ends in, and both prove their
        // postcondition from the world afterwards. Experimental: they stay off the default
        // Agent surface until each passes its own native-local live gate, and the promotion
        // to LiveVerified is a separate catalog edit owned by the parent.
        E("load_building_chest", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, BuildingChestLoad(), FarmhandActionLifecycle.LiveVerified),
        E("collect_building_chest_output", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, BuildingChestCollect(), FarmhandActionLifecycle.LiveVerified),
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
        // Buying is the mirror of ship_item and lives in the same economy family. Its
        // declared shape is (expectedTargetId, expectedQualifiedItemId, quantity): the
        // target is an opaque shop identity, the item is the wire identity of the good,
        // and quantity is clamped against live stock and the purse on the game thread.
        E("shop_purchase", "shops_economy", FarmhandActionHandlerGroup.MachinesAndAnimals, ShopPurchase(), FarmhandActionLifecycle.LiveVerified),
        E("ship_item", "shops_economy", FarmhandActionHandlerGroup.MachinesAndAnimals, SlotItemTarget(), FarmhandActionLifecycle.LiveVerified),

        // The actor's OWN attachment state. All three change what the farmer is wearing or
        // riding rather than a world tile, so every postcondition is an ACTOR fact and the opaque
        // target id names a body slot of the actor (hat/boots/shirt/pants/left_ring/right_ring)
        // instead of a coordinate. Both wearable actions drive Farmer.Equip<TItem>, the method the
        // native InventoryPage click path ends in; dismount_transport drives the Horse.dismount
        // terminal the game's own non-interactive callers use. Experimental: each stays off the
        // default Agent surface until it passes its own native-local live gate, and promotion to
        // LiveVerified is a separate catalog edit owned by the parent.
        E("equip_wearable", "body_tools", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("slot", "integer", null, "Backpack slot HOLDING the wearable to equip. `snapshot.toolSlots` lists tools only, so this is NOT a tool slot."), new FarmhandActionArgument("expectedQualifiedItemId", "string"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "wearable_equipped", "Farmer.Equip"), FarmhandActionLifecycle.LiveVerified),
        E("unequip_wearable", "body_tools", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("slot", "integer", null, "Backpack slot the wearable is taken OFF into. It must be EMPTY: an occupied destination is refused by name (`wearable_destination_slot_occupied`)."), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "wearable_unequipped", "Farmer.Equip"), FarmhandActionLifecycle.LiveVerified),
        E("dismount_transport", "animal_transport", FarmhandActionHandlerGroup.Movement, new FarmhandActionDescriptor(Array.Empty<FarmhandActionArgument>(), new Dictionary<string, string>(), EmbodiedActorResource, "write", "transport_dismounted", "Horse.dismount"), FarmhandActionLifecycle.LiveVerified),
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
        "DialogueBox.closeDialogue"), FarmhandActionLifecycle.LiveVerified),
            E("answer_dialogue", "modal_handling", FarmhandActionHandlerGroup.Modal, new FarmhandActionDescriptor(
                new[] { new FarmhandActionArgument("responseKey", "string") },
                new Dictionary<string, string>(),
                EmbodiedActorResource,
                "write",
                "answer_dialogue_answered",
                "GameLocation.answerDialogue"), FarmhandActionLifecycle.LiveVerified),
            // respond_level_up settles the pending level-up the actor is being shown: an ordinary level through
            // the menu's own `okButtonClicked` (LevelUpMenu.cs:637-643), or one of the two profession branches at
            // levels 5/10, which the engine only offers inside a mouse handler (:485-506) - a public call sequence,
            // the same shape color_placed_object and ride_minecart accepted.
            //
            // It is NOT dismiss_modal: an ACTIVE LevelUpMenu grants its perk when it closes
            // (cleanupBeforeExit -> okButtonClicked, :629-635), so the menu has no pure-cancel path, and the
            // profession branch writes `Farmer.professions` (a persisted, synced field).
            //
            // `choice` is the game's own input domain and `expectedSkill`/`expectedLevel` are the binding: the Mod
            // refuses unless the displayed menu is about that exact pair.
            E("respond_level_up", "modal_handling", FarmhandActionHandlerGroup.Modal, new FarmhandActionDescriptor(
                new[]
                {
                    new FarmhandActionArgument("choice", "string", LevelUpChoiceEnum),
                    new FarmhandActionArgument("expectedSkill", "integer"),
                    new FarmhandActionArgument("expectedLevel", "integer"),
                },
                new Dictionary<string, string>(),
                EmbodiedActorResource,
                "write",
                "level_up_resolved",
                "LevelUpMenu.okButtonClicked"), FarmhandActionLifecycle.LiveVerified),
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
        // The one SOCIAL act that is not about an NPC in front of the actor: say a line to the whole lobby
        // through the game's own chat egress (`Multiplayer.sendChatMessage`, Multiplayer.cs:1127). No body, no
        // geometry, no target, no world write - it takes exactly one string and its terminal proves the SEND.
        E("send_multiplayer_chat", "npc_social", FarmhandActionHandlerGroup.Expression, A(null, null, "chat_message_sent", ("text", "string")), FarmhandActionLifecycle.LiveVerified),
        // Empties a built fish pond through `FishPond.ClearPond()` (Buildings/FishPond.cs:840) -
        // public, no arguments, and reached in-game only through the pond menu's two-click
        // confirmation, which is UI-only state with no game-logic fork. The body DROPS the fish as
        // ground debris and resets the pond, which is the destructiveness the boundary card names.
        E("color_placed_object", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("expectedTargetId", "string"), new FarmhandActionArgument("colorSelection", "integer") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "placed_object_recolored", "DiscreteColorPicker.getColorFromSelection"), FarmhandActionLifecycle.LiveVerified),
      E("clear_fish_pond", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "fish_pond_cleared", "FishPond.ClearPond"), FarmhandActionLifecycle.LiveVerified),
        // Commission a NEW farm building through `GameLocation.buildStructure` (GameLocation.cs:16926
        // -> :16800), the exact settlement `CarpenterMenu.tryToBuild` calls at :1087. Only the BUILD
        // branch of the carpenter menu is this action; demolish, move and paint are separate world
        // changes and are deferred. The cost the seam does NOT charge (the Data/Buildings BuildCost
        // and BuildMaterials) is debited by the handler itself, because the only native debit lives
        // on the menu (CarpenterMenu.ConsumeResources) and driving the menu is forbidden.
        E("build_farm_building", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("buildingType", "string"), new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "farm_building_built", "GameLocation.buildStructure"), FarmhandActionLifecycle.LiveVerified),
        // Accepting the day's help-wanted quest. The handler carries ONLY the write half of
        // Billboard.receiveLeftClick's acceptQuestButton branch (Menus/Billboard.cs:363-374): the
        // daily/accepted/daysLeft fields on Game1.questOfTheDay, the quest-log entry and
        // Farmer.acceptedDailyQuest. The branch's click sound and button refresh are presentation
        // and are not reproduced. Experimental: it has no live gate yet, and promotion to
        // LiveVerified is a separate catalog edit owned by the parent.
        E("accept_daily_quest", "quests_journal", FarmhandActionHandlerGroup.WorldLifecycle, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "daily_quest_accepted", "Quest.accept"), FarmhandActionLifecycle.LiveVerified),
        // accept_special_order takes one offered special order through the creation half's public,
        // menu-free face (FarmerTeam.AddSpecialOrder, FarmerTeam.cs:681). The board's own Accept branch also
        // writes the board marker, which the handler reproduces; see
        // farmhandexecutioncontroller.specialorders.cs.
        E("accept_special_order", "quests_journal", FarmhandActionHandlerGroup.WorldLifecycle, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "special_order_accepted", "FarmerTeam.AddSpecialOrder"), FarmhandActionLifecycle.LiveVerified),
        // claim_museum_reward collects the museum's computed reward set through the two native members the
        // reward menu's own flow uses (LibraryMuseum.getRewardsForPlayer + LibraryMuseum.OnRewardCollected);
        // see farmhandexecutioncontroller.museumrewards.cs.
        E("claim_museum_reward", "quests_journal", FarmhandActionHandlerGroup.WorldLifecycle, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "museum_rewards_collected", "LibraryMuseum.getRewardsForPlayer"), FarmhandActionLifecycle.LiveVerified),
        // Give the actor's OWN horse its name through the game's own naming settlement
        // (`Horse.nameHorse`, Characters/Horse.cs:570): public, UI-free, and the body the naming
        // menu's own callback binding (Horse.cs:637) ends in. The subject is the actor's own
        // horse (`Utility.findHorseForPlayer`), so it carries the wire's one free-text argument
        // and NO target id - an unnamed horse is published by no projection.
        E("name_entity", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, A(null, null, "entity_named", ("text", "string")), FarmhandActionLifecycle.LiveVerified),
        // Redeeming one prize ticket at the machine. The exchange is the timed branch inside
        // `PrizeTicketMenu.update` (Menus/PrizeTicketMenu.cs:180-185): the prize the machine's own track
        // head derives, the native `addItemToInventoryBool` delivery, `Items.ReduceId("PrizeTicket", 1)`
        // and `stats.Increment("ticketPrizesClaimed")`. There is no single settlement to call and the
        // click handler only arms UI state (:145-160), so the handler reproduces that PUBLIC CALL
        // SEQUENCE and re-derives the choice from the game's own public faces
        // (`PrizeTicketMenu.getPrizeItem` + the live `ticketPrizesClaimed` stat) - the B1b form
        // `design/domains/stardew/menu-bound-and-ui-boundary.md` 2.1 already ruled on.
        // No arguments: the subject is the actor's own ticket stack and the machine's own track
        // position, both native state that no projection publishes. Experimental: it has no live gate
        // yet, and promotion to LiveVerified is a separate catalog edit owned by the parent.
        E("redeem_prize_ticket", "shops_economy", FarmhandActionHandlerGroup.WorldLifecycle, new FarmhandActionDescriptor(Array.Empty<FarmhandActionArgument>(), new Dictionary<string, string>(), EmbodiedActorResource, "write", "prize_ticket_redeemed", "PrizeTicketMenu.getPrizeItem"), FarmhandActionLifecycle.LiveVerified),
        // The sewing machine. Both actions are backpack transactions: the actor names TWO slots and the
        // opaque pair identity discovery published. `tailor_clothing` consumes the cloth and the reagent a
        // live recipe pairs and produces that recipe's garment (`TailoringMenu.CraftItem`);
        // `dye_clothing_with_item` recolours one existing garment from one dye item
        // (`TailoringMenu.DyeItems`). Neither carries a coordinate: the subject is the actor's own backpack,
        // not a world tile. Experimental: each stays off the default Agent surface until it passes its own
        // native-local live gate, and promotion to LiveVerified is a separate catalog edit owned by the
        // parent. See farmhandexecutioncontroller.tailoringactions.cs.
        E("tailor_clothing", "body_tools", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("leftSlot", "integer"), new FarmhandActionArgument("rightSlot", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "clothing_tailored", "TailoringMenu.CraftItem"), FarmhandActionLifecycle.LiveVerified),
        E("dye_clothing_with_item", "body_tools", FarmhandActionHandlerGroup.ResourceTools, new FarmhandActionDescriptor(new[] { new FarmhandActionArgument("leftSlot", "integer"), new FarmhandActionArgument("rightSlot", "integer"), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "clothing_dyed", "TailoringMenu.DyeItems"), FarmhandActionLifecycle.LiveVerified),
    });
    static FarmhandActionCatalog() { if (Registrations.Select(x => x.ActionId).Distinct(StringComparer.Ordinal).Count() != Registrations.Count) throw new InvalidOperationException("Farmhand action registrations must have unique action IDs."); }
    private static FarmhandActionRegistration E(string id, string family, FarmhandActionHandlerGroup group, FarmhandActionDescriptor descriptor, FarmhandActionLifecycle lifecycle = FarmhandActionLifecycle.Published) => new(id, family, 1, lifecycle, FarmhandOperationKind.Execution, group, descriptor);
    private static FarmhandActionRegistration R(string id, string family) => new(id, family, 1, FarmhandActionLifecycle.Published, FarmhandOperationKind.ReadOnly, null, A(null, Array.Empty<FarmhandActionResourceTemplateClaim>(), "observation_complete"));
    private static FarmhandActionDescriptor A(IReadOnlyDictionary<string,string>? facts = null, IReadOnlyList<FarmhandActionResourceTemplateClaim>? resources = null, string postcondition = "native_action_postcondition", params (string,string)[] args) => new(args.Select(x => new FarmhandActionArgument(x.Item1,x.Item2)).ToArray(), facts ?? new Dictionary<string,string>(), resources ?? EmbodiedActorResource, resources is { Count: 0 } ? "read" : "write", postcondition);

    /// <summary>
    /// The same descriptor with each argument carrying a MEANING.
    ///
    /// A separate entry point because `A` takes `(name, type)` pairs, and passing a description as the second element
    /// of a pair silently writes a sentence into `type` - measured 2026-10-29, `use_raft` published
    /// `"slot": {"type": "The TOOL's backpack slot..."}`. A signature that cannot express the mistake is worth more
    /// than a comment warning about it.
    /// </summary>
    private static FarmhandActionDescriptor Described(FarmhandActionArgument[] arguments, string postcondition = "native_action_postcondition") => new(arguments, new Dictionary<string,string>(), EmbodiedActorResource, "write", postcondition);

    /// <summary>
    /// What `slot` means on an action that consumes a held tool.
    ///
    /// Published per ARGUMENT rather than as one Host-side paragraph, because the families disagree: a tool action's
    /// slot must equal `Farmer.CurrentToolIndex` and hold that exact tool (`resourcetoolactions.cs:27`), while an item
    /// action's slot is any pack index. One sentence covering both was false for one of them - measured 2026-10-29, the
    /// Host carried exactly such a sentence ("never a backpack index") that is false for all four of them.
    /// </summary>
    private const string ToolSlotMeaning = "The TOOL's backpack slot, which must also be `snapshot.currentToolSlot`: the tool family validates `CurrentToolIndex == slot` and the tool's own type. `equipFor` writes the equip step and answers this slot for you.";

    /// <summary>What `slot` means on an action that consumes an inventory item: any backpack index, no tool rule.</summary>
    private const string ItemSlotMeaning = "The item's backpack slot. Unlike a tool action's slot this need not be the held one - `snapshot.toolSlots` lists tools only, so an item's slot is never published there.";
    private static FarmhandActionDescriptor Target() => A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"),("expectedTargetId","string"));

    private static FarmhandActionDescriptor TargetWith(string toolCategory, FarmhandResourceTemplateValue toolUpgrade) => A(null, ToolResource(toolCategory, toolUpgrade), "native_action_postcondition", ("x","integer"),("y","integer"),("expectedTargetId","string"));

    private static FarmhandActionDescriptor SlotTargetWith(string toolCategory, FarmhandResourceTemplateValue toolUpgrade) => new(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, ToolSlotMeaning), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), ToolResource(toolCategory, toolUpgrade), "write", "native_action_postcondition");
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
    private static FarmhandActionDescriptor SlotTarget() => new(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedTargetId", "string") }, new Dictionary<string, string>(), EmbodiedActorResource, "write", "native_action_postcondition");

    /// <summary>
    /// load_building_chest carries a required `slot` because the native Load branch reads
    /// `who.ActiveObject` (Building.cs:764) — the HELD item, which is `Items[CurrentToolIndex]`
    /// — and not "some item in the pack", unlike chest_store. The slot names the inventory
    /// slot to HOLD for the call, which is what the branch reads; this action selects it around
    /// the call and restores the previous selection afterwards, refusing with
    /// item_not_owned_in_slot when the slot holds no Object. x,y is the building chest's
    /// published interaction tile and expectedTargetId the opaque "which building's which
    /// chest" id.
    /// </summary>
    private static FarmhandActionDescriptor BuildingChestLoad() => new(
        new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, "The backpack slot holding the item to load. This action SELECTS that slot for the native call and restores the previous selection after, so it need not be the held one now - but it is not a tool slot."), new FarmhandActionArgument("expectedTargetId", "string") },
        new Dictionary<string, string>(),
        EmbodiedActorResource,
        "write",
        "building_chest_loaded",
        "Building.PerformBuildingChestAction");

    /// <summary>
    /// collect_building_chest_output takes no slot: the native Collect branch takes whatever
    /// single stack the chest holds, and a chest holding two or more stacks is refused by name
    /// (building_chest_requires_menu) rather than handed to the container menu the branch would
    /// otherwise open.
    /// </summary>
    private static FarmhandActionDescriptor BuildingChestCollect() => new(
        new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("expectedTargetId", "string") },
        new Dictionary<string, string>(),
        EmbodiedActorResource,
        "write",
        "building_chest_output_collected",
        "Building.PerformBuildingChestAction");

    /// <summary>
    /// ride_minecart carries the station tile plus the opaque published ride
    /// selector, and names the ride's own terminal so the Host can map exactly
    /// this action's postcondition instead of a bare coordinate pair.
    /// </summary>
    /// <summary>shop_purchase carries an opaque shop target, the good's wire identity and a
    /// quantity. It deliberately has no coordinates: it buys from a shop the actor already
    /// stands next to, and refuses with shop_counter_out_of_reach otherwise, because
    /// walking is move_to_tile's job — so a walk failure is never reported as a trade
    /// failure.</summary>
    private static FarmhandActionDescriptor ShopPurchase() => A(
        null,
        null,
        "item_purchased",
        ("expectedTargetId", "string"), ("expectedQualifiedItemId", "string"), ("quantity", "integer"));

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
            ? Described(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedQualifiedItemId", "string"), new FarmhandActionArgument("expectedTargetId", "string") })
            : Described(new[] { new FarmhandActionArgument("x", "integer"), new FarmhandActionArgument("y", "integer"), new FarmhandActionArgument("slot", "integer", null, ItemSlotMeaning), new FarmhandActionArgument("expectedQualifiedItemId", "string"), new FarmhandActionArgument("expectedTargetId", "string") }) with
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
