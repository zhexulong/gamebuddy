using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Netcode;
using StardewValley;
using StardewValley.Enchantments;
using StardewValley.Inventories;
using StardewValley.Tools;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// AN <c>equip_tool</c> STEP WRITTEN BEFORE A TOOL ACTION BUYS NOTHING: the action takes the tool its own registration
/// declares, when it runs, whatever the hand was holding.
///
/// <para>
/// Two gates already answered half of this question each and neither one joined them to the prelude.
/// <see cref="DeclaredToolSelectionTests"/> proves a pack answers with its own tool whatever the hand holds;
/// <see cref="ToolPreconditionUniformityTests"/> proves every tool handler takes the tool its
/// <c>tool:&lt;category&gt;</c> claim declares before it swings. Put together they say the prelude is ceremony, and this
/// file says it once, with both selectors driven for real over the same pack: the slot <c>equip_tool</c> would put in
/// the hand is the slot the action takes anyway.
/// </para>
///
/// <para>
/// <b>Instrument.</b> The two selectors are the production ones - <c>ExecutionManager.SelectToolSlot</c>, which
/// <c>equip_tool</c> resolves its request with, and <c>ExecutionManager.ResolveDeclaredTool</c>, which every tool
/// handler selects with. The switch and its restore are the engine's own <c>Farmer.CurrentToolIndex</c> setter, so the
/// actor is a headless <see cref="Farmer"/> whose netfields are seeded through reflection - the standing pattern of
/// <see cref="HeldToolProjectionTests"/> and <see cref="ChestStoreCarriedItemTests"/> - because <c>new Axe()</c> and
/// <c>new Farmer()</c> both load game content. What no headless case can answer is the swing itself: the native half
/// (a wrong tool held, the swing landing) belongs to the native-local fixture lane.
/// </para>
/// </summary>
public sealed class EquipPreludeTests
{
    /// <summary>
    /// The five actions the <c>round99</c> preludes preceded, and the tool each one's own registration declares. Each is
    /// read back off the catalog below rather than trusted: a handler that stopped declaring its tool fails that check.
    /// </summary>
    private static readonly (string ActionId, string Category)[] MeasuredPreludes =
    {
        ("cut_weeds", "scythe"),
        ("break_rock", "pickaxe"),
        ("chop_tree", "axe"),
        ("till_soil", "hoe"),
        ("water_crop", "watering_can"),
    };

    [Fact]
    public void TheToolThePreludeWouldTakeIsTheToolTheActionTakesItself()
    {
        // The population is the catalog: every registration whose `tool:` claim names one category word. A tool action
        // added tomorrow is enrolled without touching this file.
        FarmhandActionRegistration[] claimed = FarmhandActionCatalog.Registrations
            .Where(registration => ClaimCategory(registration) is not null)
            .ToArray();
        claimed.Should().NotBeEmpty("the catalog must declare tool actions, or this test reads nothing");

        var disagreements = new List<string>();
        foreach (FarmhandActionRegistration registration in claimed)
        {
            string category = ClaimCategory(registration)!;
            var other = Representative(category == "axe" ? "hoe" : "axe", upgradeLevel: 0);
            var required = Representative(category, upgradeLevel: 0);
            // Two packs, because the interesting case is not "the only tool wins": with two tiers of the required tool
            // owned, BOTH selectors rank by the tier - so a prelude that ranked differently would be one the plan could
            // not have relied on.
            foreach (IList<Item?> pack in new IList<Item?>[]
            {
                new List<Item?> { other, required },
                new List<Item?> { required, other, Representative(category, upgradeLevel: 2) },
            })
            {
                DeclaredToolResolution taken = ExecutionManager.ResolveDeclaredTool(pack, registration.ActionId);
                taken.RefusalCode.Should().BeNull($"{registration.ActionId} owns the {category} its claim declares here");

                int prelude = SelectToolSlot(pack, category);
                if (prelude != taken.Slot)
                    disagreements.Add($"{registration.ActionId}: equip_tool would hold slot {prelude}, the action takes slot {taken.Slot}");
            }
        }

        disagreements.Should().BeEmpty(
            "an equip step written before a tool action cannot change which tool that action uses - the selector the "
                + "prelude drives and the selector the handler drives must answer the same slot from the same pack:\n  "
                + string.Join("\n  ", disagreements));
    }

    [Fact]
    public void AHandHoldingAnotherToolDoesNotStopTheActionTakingTheOneItDeclares()
    {
        // The property that makes the prelude unnecessary, driven through the production selection: a hand holding
        // something else is not a refusal, and the actor's own selection comes back afterwards - which is also why an
        // equip step's effect would not survive the very action it preceded.
        foreach ((string actionId, string category) in MeasuredPreludes)
        {
            DeclaredToolWord(actionId).Should().Be(category, $"{actionId}'s own registration declares the tool this case holds out");

            string otherCategory = category == "axe" ? "hoe" : "axe";
            using var hand = Hand.Holding(Representative(otherCategory, upgradeLevel: 0), Representative(category, upgradeLevel: 0));

            bool selected = SelectDeclaredTool(hand.Actor, actionId, out DeclaredToolSelection selection, out string refusal);

            selected.Should().BeTrue(
                $"{actionId} takes the {category} its claim declares even though the hand holds a {otherCategory}, "
                    + $"which is why a plan needs no equip step for it: {refusal}");
            selection.Category.Should().Be(category);
            selection.Slot.Should().Be(1, "the declared tool is in the pack, one slot after the tool the hand holds");
            selection.PreviousSlot.Should().Be(0);
            ExecutionManager.DescribeToolCategory(hand.Actor.CurrentTool).Should().Be(
                category, "the swing that follows the selection runs with the tool the handler just took");

            RestoreToolSelection(hand.Actor, selection);

            hand.Actor.CurrentToolIndex.Should().Be(0, $"{actionId} puts the actor's own selection back on every exit");
            ExecutionManager.DescribeToolCategory(hand.Actor.CurrentTool).Should().Be(
                otherCategory, "and the hand an equip step would have left behind is not what the actor holds after it");
        }
    }

    // ---- the two selectors, driven through the production methods -----------------------

    /// <summary>
    /// The category an action's own registration declares, or null when its claim names a predicate
    /// (<c>axe_or_pickaxe</c>, <c>heavy_hitter</c>) or nothing at all - a word one category cannot say, named by
    /// <see cref="ToolPreconditionUniformityTests"/> rather than absorbed here.
    /// </summary>
    private static string? ClaimCategory(FarmhandActionRegistration registration)
    {
        FarmhandActionResourceTemplateClaim? claim = registration.Descriptor?.ResourceTemplate
            .FirstOrDefault(candidate => candidate.Key.StartsWith("tool:", StringComparison.Ordinal));
        if (claim is null)
            return null;
        string word = claim.Key["tool:".Length..];
        return FarmhandActionCatalog.ToolEnum.Contains(word, StringComparer.Ordinal) ? word : null;
    }

    /// <summary>The claim word one registered action declares, read through the catalog.</summary>
    private static string? DeclaredToolWord(string actionId) =>
        FarmhandActionCatalog.Registrations
            .First(registration => string.Equals(registration.ActionId, actionId, StringComparison.Ordinal))
            .Descriptor?.ResourceTemplate
            .FirstOrDefault(claim => claim.Key.StartsWith("tool:", StringComparison.Ordinal))?.Key["tool:".Length..];

    /// <summary>The slot <c>equip_tool</c> would put in the hand, from the pack it is given.</summary>
    private static int SelectToolSlot(IList<Item?> pack, string category)
    {
        var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
        var inventory = new Inventory();
        foreach (Item? item in pack)
            inventory.Add(item!);
        Seed(actor, typeof(Farmer), "netItems", new NetRef<Inventory> { Value = inventory });
        object? slot = PrivateStatic("SelectToolSlot", typeof(Farmer), typeof(string)).Invoke(null, new object?[] { actor, category });
        return (int)slot!;
    }

    /// <summary>The one switch every tool handler runs before it swings, and the restore it runs after.</summary>
    private static bool SelectDeclaredTool(Farmer actor, string actionId, out DeclaredToolSelection selection, out string refusalCode)
    {
        MethodInfo method = typeof(ExecutionManager)
            .GetMethods(BindingFlags.NonPublic | BindingFlags.Static)
            .Single(candidate => candidate.Name == "TrySelectDeclaredTool" && candidate.GetParameters().Length == 4);
        var arguments = new object?[] { actor, actionId, null, null };
        bool selected = (bool)method.Invoke(null, arguments)!;
        selection = selected ? (DeclaredToolSelection)arguments[2]! : default;
        refusalCode = (string)arguments[3]!;
        return selected;
    }

    private static void RestoreToolSelection(Farmer actor, DeclaredToolSelection selection) =>
        PrivateStatic("RestoreToolSelection", typeof(Farmer), typeof(DeclaredToolSelection))
            .Invoke(null, new object?[] { actor, selection });

    private static MethodInfo PrivateStatic(string name, params Type[] parameters) =>
        typeof(ExecutionManager).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static, null, parameters, null)!;

    // ---- the headless actor -------------------------------------------------------------

    /// <summary>
    /// An actor whose pack holds exactly what a case puts there, with the netfields the engine's
    /// <c>CurrentToolIndex</c> setter reads on the way through: <c>Items</c>, <c>CurrentItem</c>, <c>UsingTool</c> and the
    /// stow flags, plus the identity that decides whether the actor counts as the local player.
    ///
    /// <para>
    /// THE ACTOR IS THE INSTALLED <c>Game1.player</c> FOR THE DURATION, and that is a requirement rather than a
    /// convenience: the setter hands the tool it is leaving to <c>Item.actionWhenStopBeingHeld</c>, and
    /// <c>Tool</c>'s override asks <c>IsLocalPlayer</c> before it reports the unequip to each enchantment - a question that
    /// reads the installed location through <c>Game1.CurrentEvent</c> for anyone else, and there is no location here. With
    /// the actor installed, the identity comparison answers itself and the enchantment list is the only thing the branch
    /// then reads (seeded empty in <see cref="SeedTool{T}"/>).
    /// </para>
    /// </summary>
    private sealed class Hand : IDisposable
    {
        private static readonly FieldInfo Installed = typeof(Game1)
            .GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!;

        private readonly Farmer? previous;

        private Hand(Farmer actor)
        {
            this.previous = Game1.player;
            this.Actor = actor;
            Installed.SetValue(null, actor);
        }

        internal Farmer Actor { get; }

        /// <summary>A pack whose FIRST tool is the one in the actor's hand.</summary>
        internal static Hand Holding(params Tool[] pack)
        {
            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            var inventory = new Inventory();
            foreach (Tool tool in pack)
                inventory.Add(tool);
            Seed(actor, typeof(Farmer), "netItems", new NetRef<Inventory> { Value = inventory });
            Seed(actor, typeof(Farmer), "currentToolIndex", new NetInt(0));
            Seed(actor, typeof(Farmer), "temporaryItem", new NetRef<Item>());
            Seed(actor, typeof(Farmer), "netItemStowed", new NetBool(false));
            Seed(actor, typeof(Farmer), "usingTool", new NetBool(false));
            Seed(actor, typeof(Farmer), "uniqueMultiplayerID", new NetLong(1));
            return new Hand(actor);
        }

        public void Dispose() => Installed.SetValue(null, this.previous);
    }

    // ---- one seed per published category -----------------------------------------------

    /// <summary>
    /// One tool per word of <see cref="FarmhandActionCatalog.ToolEnum"/>; a word with no tool here would silently narrow
    /// the populations above, so the vocabulary is covered rather than trusted.
    /// </summary>
    private static Tool Representative(string category, int upgradeLevel) => category switch
    {
        "axe" => SeedTool<Axe>("(T)Axe", upgradeLevel),
        "pickaxe" => SeedTool<Pickaxe>("(T)Pickaxe", upgradeLevel),
        "hoe" => SeedTool<Hoe>("(T)Hoe", upgradeLevel),
        "watering_can" => SeedTool<WateringCan>("(T)WateringCan", upgradeLevel),
        "fishing_rod" => SeedTool<FishingRod>("(T)FishingRod", upgradeLevel),
        "scythe" => SeedTool<MeleeWeapon>("(W)47", upgradeLevel),
        "weapon" => SeedTool<MeleeWeapon>("(W)4", upgradeLevel),
        "shears" => SeedTool<Shears>("(T)Shears", upgradeLevel),
        "milk_pail" => SeedTool<MilkPail>("(T)MilkPail", upgradeLevel),
        "pan" => SeedTool<Pan>("(T)Pan", upgradeLevel),
        "lantern" => SeedTool<Lantern>("(T)Lantern", upgradeLevel),
        "raft" => SeedTool<Raft>("(T)Raft", upgradeLevel),
        _ => throw new ArgumentOutOfRangeException(nameof(category), category, "no representative for a published tool word"),
    };

    /// <summary>A tool whose identity, level and (empty) enchantment list are the only things the selection reads.</summary>
    private static T SeedTool<T>(string qualifiedItemId, int upgradeLevel)
        where T : Tool
    {
        var tool = (T)FormatterServices.GetUninitializedObject(typeof(T));
        Seed(tool, typeof(Item), "_qualifiedItemId", qualifiedItemId);
        Seed(tool, typeof(Tool), "upgradeLevel", new NetInt(upgradeLevel));
        Seed(tool, typeof(Tool), "enchantments", new NetList<BaseEnchantment, NetRef<BaseEnchantment>>());
        return tool;
    }

    private static void Seed(object target, Type owner, string field, object value) =>
        owner.GetField(field, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(target, value);
}
