namespace GameBuddy.Stardew.Core.Policy;

public enum FarmhandActionLifecycle { Published, Experimental }
public static class FarmhandActionLifecycleWire { public static string ToWireValue(this FarmhandActionLifecycle lifecycle) => lifecycle switch { FarmhandActionLifecycle.Published => "published", FarmhandActionLifecycle.Experimental => "experimental", _ => throw new ArgumentOutOfRangeException(nameof(lifecycle)) }; }
public enum FarmhandOperationKind { Execution, ReadOnly }
public static class FarmhandOperationKindWire { public static string ToWireValue(this FarmhandOperationKind kind) => kind switch { FarmhandOperationKind.Execution => "execution", FarmhandOperationKind.ReadOnly => "read_only", _ => throw new ArgumentOutOfRangeException(nameof(kind)) }; }
public enum FarmhandResourceTemplateValue { ScopePlayer = 1 }
public sealed record FarmhandActionArgument(string Name, string Type);
/// <summary>Mod-owned symbolic resource claim; ScopePlayer materializes embodied_actor to the current scoped player.</summary>
public sealed record FarmhandActionResourceTemplateClaim(string Key, FarmhandResourceTemplateValue Value);
/// <summary>Versioned descriptor contract owned exclusively by Mod registration.</summary>
public sealed record FarmhandActionDescriptor(IReadOnlyList<FarmhandActionArgument> Arguments, IReadOnlyDictionary<string, string> OutputFacts, IReadOnlyList<FarmhandActionResourceTemplateClaim> ResourceTemplate, string Effect, string Postcondition);
/// <summary>The only ordinary-Farmhand operation membership and descriptor source.</summary>
public sealed record FarmhandActionRegistration(string ActionId, string FamilyId, int IdentityVersion, FarmhandActionLifecycle Lifecycle, FarmhandOperationKind Kind, FarmhandActionHandlerGroup? HandlerGroup, FarmhandActionDescriptor? Descriptor = null);
public enum FarmhandActionHandlerGroup { Movement, Farming, Gathering, MachinesAndAnimals, ResourceTools }

public static class FarmhandActionCatalog
{
    private static readonly IReadOnlyList<FarmhandActionResourceTemplateClaim> EmbodiedActorResource = Array.AsReadOnly(new[]
    {
        new FarmhandActionResourceTemplateClaim("embodied_actor", FarmhandResourceTemplateValue.ScopePlayer),
    });

    public static readonly IReadOnlyList<FarmhandActionRegistration> Registrations = Array.AsReadOnly(new[]
    {
        E("move_to_tile", "movement_navigation", FarmhandActionHandlerGroup.Movement, A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"))),
        E("equip_tool", "body_tools", FarmhandActionHandlerGroup.ResourceTools, A(null, null, "native_action_postcondition", ("slot","integer"))),
        E("travel", "transport_warps", FarmhandActionHandlerGroup.Movement, A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"))),
        E("enter_exit", "movement_navigation", FarmhandActionHandlerGroup.Movement, A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"))),
        E("till_soil", "farming_crops", FarmhandActionHandlerGroup.Farming, A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"))),
        E("pickup_forage", "resource_gathering", FarmhandActionHandlerGroup.Gathering, TargetItem()), E("pickup_item", "inventory_items", FarmhandActionHandlerGroup.Gathering, TargetItem()),
        E("water_crop", "farming_crops", FarmhandActionHandlerGroup.Farming, Target()), E("plant_seed", "farming_crops", FarmhandActionHandlerGroup.Farming, SlotItemTarget()), E("fertilize_tile", "farming_crops", FarmhandActionHandlerGroup.Farming, SlotItemTarget()),
        E("machine_inspect", "machines_processing", FarmhandActionHandlerGroup.MachinesAndAnimals, Target()), E("machine_load", "machines_processing", FarmhandActionHandlerGroup.MachinesAndAnimals, SlotItemTarget()), E("machine_collect_output", "machines_processing", FarmhandActionHandlerGroup.MachinesAndAnimals, Target()),
        E("collect_animal_product", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, SlotTarget()), E("feed_animal", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, SlotTarget()), E("use_item", "inventory_items", FarmhandActionHandlerGroup.MachinesAndAnimals, A(null, null, "native_action_postcondition", ("slot","integer"),("expectedQualifiedItemId","string"))),
        E("harvest_crop", "farming_crops", FarmhandActionHandlerGroup.Farming, TargetItem()), E("place_wood_fence", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SlotItemTarget()), E("place_crab_pot", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SlotItemTarget()), E("bait_crab_pot", "buildings_farm_management", FarmhandActionHandlerGroup.ResourceTools, SlotItemTarget()),
        E("chop_tree_source", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SlotTarget()), E("break_rock_source", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SlotTarget()), E("clear_hoedirt", "farming_crops", FarmhandActionHandlerGroup.Farming, SlotTarget()), E("dig_artifact_spot", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SlotTarget()), E("refill_watering_can", "farming_crops", FarmhandActionHandlerGroup.ResourceTools, SlotTarget()),
        R("inspect_world_map", "world_navigation"), R("find_destination", "world_navigation"),
        E("navigate_to_destination", "world_navigation", FarmhandActionHandlerGroup.Movement, A(new Dictionary<string,string>{{"arrival","object"}}, null, "arrived_at_destination", ("destination","object"))),
        E("clear_debris", "resource_gathering", FarmhandActionHandlerGroup.ResourceTools, SlotTarget(), FarmhandActionLifecycle.Experimental), E("npc_relationship", "npc_social", FarmhandActionHandlerGroup.MachinesAndAnimals, Target(), FarmhandActionLifecycle.Experimental), E("pet_animal", "animals_pets", FarmhandActionHandlerGroup.MachinesAndAnimals, Target(), FarmhandActionLifecycle.Experimental),
    });
    static FarmhandActionCatalog() { if (Registrations.Select(x => x.ActionId).Distinct(StringComparer.Ordinal).Count() != Registrations.Count) throw new InvalidOperationException("Farmhand action registrations must have unique action IDs."); }
    private static FarmhandActionRegistration E(string id, string family, FarmhandActionHandlerGroup group, FarmhandActionDescriptor descriptor, FarmhandActionLifecycle lifecycle = FarmhandActionLifecycle.Published) => new(id, family, 1, lifecycle, FarmhandOperationKind.Execution, group, descriptor);
    private static FarmhandActionRegistration R(string id, string family) => new(id, family, 1, FarmhandActionLifecycle.Published, FarmhandOperationKind.ReadOnly, null, A(null, Array.Empty<FarmhandActionResourceTemplateClaim>(), "observation_complete"));
    private static FarmhandActionDescriptor A(IReadOnlyDictionary<string,string>? facts = null, IReadOnlyList<FarmhandActionResourceTemplateClaim>? resources = null, string postcondition = "native_action_postcondition", params (string,string)[] args) => new(args.Select(x => new FarmhandActionArgument(x.Item1,x.Item2)).ToArray(), facts ?? new Dictionary<string,string>(), resources ?? EmbodiedActorResource, resources is { Count: 0 } ? "read" : "write", postcondition);
    private static FarmhandActionDescriptor Target() => A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"),("expectedTargetId","string"));
    private static FarmhandActionDescriptor TargetItem() => A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"),("expectedQualifiedItemId","string"),("expectedTargetId","string"));
    private static FarmhandActionDescriptor SlotTarget() => A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"),("slot","integer"),("expectedTargetId","string"));
    private static FarmhandActionDescriptor SlotItemTarget() => A(null, null, "native_action_postcondition", ("x","integer"),("y","integer"),("slot","integer"),("expectedQualifiedItemId","string"),("expectedTargetId","string"));
}
