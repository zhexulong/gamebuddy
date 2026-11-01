using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The declaration that joins the two halves of every action: `Discover*` publishes rows, the per-action preflight
/// refuses them, and until now nothing in this assembly connected the two.
///
/// <para>
/// Eight shipped defects are that one shape. `treeChopSourceTargets` published `tree:Farm:10,12:Oak` while the chop
/// preflight wanted a SHA-256 id (`c6cdbed4`); `forageTargets` published a ref and a name while the action wanted
/// `observationId` (14 refusals, `3c6611ba`); `shippingBinTargets` was organised by pack slot while `ship_item` wanted
/// an item id (`b06161e8`); `rockSourceTargets` filtered `health == 1` so every full-health ore was invisible
/// (`def2fb07`); `cropTargets` counted a season-killed crop the harvest action judged unharvestable (`24d8168e`);
/// `enter_exit` consulted only `location.doors` while the snapshot also published edge warps (`round19`).
/// </para>
/// <para>
/// THE POPULATION IS DERIVED, NEVER LISTED. Every assertion below starts from
/// <see cref="FarmhandActionCatalog.Registrations"/> and the `TargetFamily` each descriptor declares, so an action
/// added with a family is covered without editing this file - and fails BY NAME when nothing drives it.
/// </para>
/// <para>
/// THREE COUNTS, THREE DIFFERENT FACTS, deliberately not one list:
/// </para>
/// <list type="bullet">
/// <item><b>Driven</b> - the world builds candidates, the REAL `Discover*` publishes rows, and the action's own
/// preflight accepts them. A driven pair that stops passing is a failure.</item>
/// <item><b>KnownDrift</b> - the pair fails TODAY on a real defect. Asserted to STILL fail, so a repair without
/// removing the entry is red rather than quietly absorbed.</item>
/// <item><b>Undriven</b> - the headless world cannot construct the family, with a concrete blocker a reader could
/// falsify. Ratcheted: the driven count may not fall and the undriven count may not rise without a new named blocker.</item>
/// </list>
/// </summary>
public sealed class TargetFamilyRoundTripTests
{
    /// <summary>
    /// One action whose declared family this file drives through its own preflight.
    ///
    /// The row is (action, family); the family is asserted EQUAL to the descriptor's own declaration, so an action
    /// re-pointed at a different family cannot keep a stale driver that passes.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> DrivenFamilies = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["chop_tree_source"] = "treeChopSourceTargets",
        ["break_rock_source"] = "rockSourceTargets",
        ["chop_stump"] = "treeStumpTargets",
        ["cut_weeds"] = "weedTargets",
        ["cut_grass"] = "grassTargets",
        ["chest_store"] = "chests",
        ["chest_retrieve"] = "chests",
        ["npc_relationship"] = "npcRelationshipTargets",
        ["talk_to_npc"] = "npcRelationshipTargets",
        ["interact_npc_with_item"] = "npcRelationshipTargets",
        ["water_crop"] = "cropTargets",
        ["pickup_item"] = "itemTargets",
        ["pickup_forage"] = "forageTargets",
        ["equip_tool"] = "toolSlots",
        ["travel"] = "warps",
        ["enter_exit"] = "warps",
    };

    /// <summary>
    /// Pairs that FAIL their round trip today, each naming the real defect it fails on.
    ///
    /// Asserted to STILL fail. Removing an entry is the act of fixing the defect; fixing the defect without removing
    /// its entry fails here, which is what stops a repair from being silently absorbed into a green suite.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> KnownDrift = new Dictionary<string, string>(StringComparer.Ordinal)
    {
    };

    /// <summary>
    /// Pairs the headless world cannot construct, each with the CONCRETE blocker.
    ///
    /// A blocker is a missing `Game1` field, a `Data/*` asset this process does not load, or native state only a save
    /// carries - something a reader could falsify by teaching the harness. "Not implemented yet" is not a blocker and
    /// does not belong here: that is a driver owed, not a world that cannot exist.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> Undriven = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["animalDoorTargets"] = "a Building whose Data/Buildings row declares an animal door; the asset is not loaded here",
        ["animalProductTargets"] = "a FarmAnimal with produce data from Data/FarmAnimals; the asset is not loaded here",
        ["artifactSpotTargets"] = "an Object (O)590 on a map tile that isTilePassable on one side; the harness map declares no passability properties",
        ["baitCrabPotTargets"] = "a placed CrabPot (O)710 object plus a (O)685 bait stack; the pot's rules come from Data/BigCraftables",
        ["buildingChestTargets"] = "a Building whose Data/Buildings row declares Chests; the asset is not loaded here",
        ["bushTargets"] = "a Bush terrain feature whose size/health come from Data/WildTrees; the asset is not loaded here",
        ["caskTargets"] = "a Cask object whose ageing rules come from Data/BigCraftables; the asset is not loaded here",
        ["clearHoeDirtTargets"] = "a HoeDirt with no crop that isTilePassable; the harness map declares no passability properties",
        ["colorTargets"] = "a Chest carrying a DiscreteColorPicker colour; Chest.owner/playerChest are set, the palette state is not",
        ["cookingRecipeTargets"] = "Data/CookingRecipes; the asset is not loaded here",
        ["crabPotCollectTargets"] = "a placed CrabPot holding harvested output; the pot's rules come from Data/BigCraftables",
        ["crabPotTargets"] = "a currentLocation of type Farm holding a (O)710 stack; TargetFamilyWorld builds a plain GameLocation",
        ["craftingRecipeTargets"] = "Data/CraftingRecipes; the asset is not loaded here",
        ["dailyQuestTargets"] = "Game1.questOfTheDay, which only a save load populates",
        ["debrisTargets"] = "a ResourceClump in the location's resourceClumps layer; its kind comes from Data/Objects",
        ["farmBuildingTargets"] = "Data/Buildings (every buildable type, cost and material); the asset is not loaded here",
        ["feedTroughTargets"] = "an AnimalHouse location with a Trough map property; the harness builds no interior location",
        ["fenceGateTargets"] = "a Fence in the location's fences layer, which is built by Fence.reload from save data",
        ["fertilizerTargets"] = "a fertilizer stack plus a tillable tile (map `Diggable` property); the harness map declares none",
        ["fishPondTargets"] = "a FishPond building whose fish population comes from save data",
        ["foodTargets"] = "Data/Objects (edibility and stamina fields); the asset is not loaded here",
        ["fruitTreeTargets"] = "a FruitTree whose fruit comes from Data/FruitTrees; the asset is not loaded here",
        ["horseTargets"] = "a Horse, which Utility.findHorseForPlayer resolves from Game1.player.mount or the farm's characters",
        ["lanternSlots"] = "a Lantern in the pack with its `on`/`fuelLeft` NetFields; the Tool constructor loads content",
        ["machineTargets"] = "a machine Object whose output rules come from Data/Machines; the asset is not loaded here",
        ["harvestTargets"] = "DiscoverHarvestTargets calls ItemRegistry.Create for the harvest item, which needs the item type-definition registry (Data/Objects) this process never loads",
        ["mailboxTargets"] = "a map Action tile `Mailbox` plus Game1.player.mailbox; the harness map declares no Action tiles",
        ["mannequinTargets"] = "a Mannequin object whose slots come from Data/Objects; the asset is not loaded here",
        ["mineElevatorFloorTargets"] = "Game1.mine.lowestLevelReached, which only a loaded save or an entered mine carries",
        ["mineEntranceTargets"] = "a mine entrance Action tile on the map plus Game1.mine; the harness map declares no Action tiles",
        ["minecartTargets"] = "a minecart station network, which GameLocation declares per map rather than in code",
        ["museumRewardTargets"] = "a LibraryMuseum location with donated items, i.e. a loaded save",
        ["obeliskTargets"] = "Data/Buildings rows for the obelisk types plus a standing Building; the asset is not loaded here",
        ["panSites"] = "Game1.player.orePanPoint / the location's pan point, which the engine writes from map data",
        ["pedestalTargets"] = "an ItemPedestal object holding an item; its slot rules come from Data/Objects",
        ["petTargets"] = "a Pet in the farm's characters, which a save load creates",
        ["raftTargets"] = "a raft on a water tile, which GameLocation creates from map tile properties",
        ["refillWateringCanTargets"] = "a water-source landmark, which GameLocation derives from map tile properties",
        ["seedTargets"] = "a seed stack plus a tillable tile (map `Diggable` property); the harness map declares none",
        ["scytheCropTargets"] = "ScytheCropTarget's own predicate over a HoeDirt crop whose harvest method comes from Data/Crops",
        ["shakeTreeTargets"] = "a Tree whose shake output comes from Data/WildTrees; the asset is not loaded here",
        ["shippingBinTargets"] = "a Farm holding a ShippingBin building; TargetFamilyWorld builds a plain GameLocation",
        ["shopTargets"] = "Data/Shops plus an owner NPC whose eligibility condition the game evaluates; the asset is not loaded here",
        ["signTargets"] = "a Sign object whose display slot rules come from Data/Objects; the asset is not loaded here",
        ["siloTargets"] = "a Silo Building; Building's own constructor loads Data/Buildings",
        ["slimeHutchTroughTargets"] = "a SlimeHutch location with a Trough map property; the harness builds no interior location",
        ["soilTiles"] = "a map tile carrying the `Diggable` Back property; the harness map declares no tile properties",
        ["specialOrderTargets"] = "Game1.team.specialOrders, which only a loaded save populates",
        ["tailoringTargets"] = "Data/TailoringRecipes and the sewing machine's two-slot pair; the asset is not loaded here",
        ["treeSaplingTargets"] = "a sapling in the pack plus a plantable tile (map `Diggable` property); the harness map declares none",
        ["warpItemTargets"] = "a warp-totem stack whose destination table comes from Data/Objects; the asset is not loaded here",
        ["wearableTargets"] = "Farmer wardrobe slots, whose occupants come from Data/Objects and a loaded save",
        ["woodFenceTargets"] = "a currentLocation of type Farm plus a (O)322 stack; TargetFamilyWorld builds a plain GameLocation",
        ["pendingLevelUpChoices"] = "Game1.player.newLevels, which only Game1.showEndOfNightStuff populates at the night boundary",
        ["petBowlTargets"] = "a PetBowl Building; Building's own constructor loads Data/Buildings",
        ["worldObjectTargets"] = "a placeable owned Object whose placement rules (canBePlacedHere/placementAction) come from Data/Objects",
    };

    [Fact]
    public void EveryDeclaredFamilyIsPublishedByTheSnapshotOnBothSides()
    {
        IReadOnlyList<FarmhandActionRegistration> declared = DeclaredActions();
        declared.Should().NotBeEmpty(
            "every executing action that addresses a published target must declare the family it comes from");

        string models = Read("src/Core/Models/BridgeProtocolModels.cs");
        IReadOnlySet<string> modFamilies = BridgeSnapshotListFamilies(models);
        IReadOnlySet<string> hostFamilies = HostSnapshotFamilyRules();

        var offenders = new List<string>();
        foreach (FarmhandActionRegistration registration in declared)
        {
            string family = registration.Descriptor!.TargetFamily!;
            if (!modFamilies.Contains(family))
                offenders.Add($"{registration.ActionId}: the Mod's BridgeSnapshot publishes no `{family}`");
            if (!hostFamilies.Contains(family))
                offenders.Add($"{registration.ActionId}: the Host's SNAPSHOT_FAMILY_RULES validates no `{family}`");
        }

        offenders.Should().BeEmpty(
            "a family an action declares must exist on BOTH sides of the wire, or the declaration names a field no "
            + "snapshot carries and no refusal can point at: " + string.Join(" | ", offenders));
    }

    /// <summary>
    /// The three counts, printed and ratcheted.
    ///
    /// The numbers are pinned because a gap that shrinks to an absence is how a gate stops working: if the driven
    /// count falls, a driver was lost; if the undriven count rises, a family was parked instead of driven or named
    /// with a blocker. Both are failures here rather than a quiet edit to a list.
    /// </summary>
    [Fact]
    public void TheCountsAreRatchetedAndEveryPairIsAccountedFor()
    {
        IReadOnlyList<FarmhandActionRegistration> declared = DeclaredActions();
        IReadOnlyList<string> declaredFamilies = declared
            .Select(registration => registration.Descriptor!.TargetFamily!)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(family => family, StringComparer.Ordinal)
            .ToArray();

        int driven = DrivenFamilies.Count;
        int knownDrift = KnownDrift.Count;
        int undriven = declaredFamilies.Count(family => Undriven.ContainsKey(family));

        // Every declared family is accounted for EXACTLY once. A family that is neither driven nor named is the
        // silent narrowing this file exists to prevent.
        string[] accountedFor = DrivenFamilies.Values
            .Concat(Undriven.Keys)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(family => family, StringComparer.Ordinal)
            .ToArray();
        accountedFor.Should().BeEquivalentTo(
            declaredFamilies,
            "every family the definitions declare is either driven by this file or named with a blocker; a family in "
            + "neither list is one nothing checks");

        DrivenFamilies.Keys.Should().BeSubsetOf(
            declared.Select(registration => registration.ActionId),
            "a driver for an action that no longer declares a family is a driver of nothing");

        // The driver's family must be the descriptor's own, so an action re-pointed at another family cannot keep a
        // stale driver that still passes.
        var repointed = new List<string>();
        foreach ((string actionId, string family) in DrivenFamilies)
        {
            FarmhandActionRegistration registration = declared.Single(candidate => candidate.ActionId == actionId);
            if (!string.Equals(registration.Descriptor!.TargetFamily, family, StringComparison.Ordinal))
                repointed.Add($"{actionId}: driver reads `{family}`, the descriptor declares `{registration.Descriptor.TargetFamily}`");
        }

        repointed.Should().BeEmpty("a driver must read the family its action declares: " + string.Join(" | ", repointed));

        KnownDrift.Keys.Should().BeSubsetOf(
            declared.Select(registration => registration.ActionId),
            "a known-drift entry for an action that no longer declares a family is drift of nothing");

        undriven.Should().Be(
            Undriven.Count,
            "every Undriven entry names a family the definitions actually declare");

        // THE RATCHET, stated as the two directions that matter.
        driven.Should().BeGreaterThanOrEqualTo(
            16,
            "the driven count may not fall: 16 pairs are driven today (the seven families TargetFamilyWorld already "
            + "builds, plus crop/item/forage/chest/npc/transition/tool-slot pairs on top of them)");
        undriven.Should().BeLessThanOrEqualTo(
            56,
            "the undriven count may not rise without a new named blocker: 56 of the 68 declared families cannot be "
            + "constructed headlessly today, and each one says why");

        // Printed so the gap is a NUMBER on every run rather than an absence a reader has to reconstruct.
        string report =
            $"driven {driven} of {declaredFamilies.Count} families, known-drift {knownDrift}, undriven {undriven}";
        report.Should().Be(
            $"driven 16 of {declaredFamilies.Count} families, known-drift 0, undriven 56",
            "the counts are the ratchet; a change here is a change to what this gate covers");
    }

    /// <summary>
    /// THE ASSERTION THAT WOULD HAVE CAUGHT SIX OF THE EIGHT: for every driven pair, every row the REAL `Discover*`
    /// publishes must be accepted by the action's own preflight.
    ///
    /// Non-vacuity is asserted per pair: an empty family makes this pass while publishing nothing, which is exactly
    /// how `def2fb07` hid every ore node.
    /// </summary>
    [Fact]
    public void EveryDrivenFamilyRoundTripsThroughTheActionsOwnPreflight()
    {
        var failures = new List<string>();
        var vacuous = new List<string>();
        var harnessLimited = new List<string>();

        foreach ((string actionId, string family) in DrivenFamilies.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            using var world = TargetFamilyWorld.Create();
            world.PopulateFor(family);
            TargetRoundTripProbe.Outcome outcome = TargetRoundTripProbe.Run(world, actionId, family);

            if (outcome.HarnessLimit.Length > 0)
            {
                harnessLimited.Add($"{actionId}/{family}: {outcome.Refusal} (row: {outcome.FirstRow})");
                continue;
            }

            if (outcome.Rows == 0)
            {
                vacuous.Add($"{actionId}/{family}: {world.Describe(family)}");
                continue;
            }

            if (!outcome.Accepted)
                failures.Add($"{actionId}/{family}: {outcome.Refusal} (row: {outcome.FirstRow})");
        }

        harnessLimited.Should().BeEmpty(
            "a pair whose REAL projection or preflight needs content this process cannot load is a harness gap, not a "
            + "round trip: it must be taught to TargetFamilyWorld or named in Undriven, never silently skipped: "
            + string.Join(" | ", harnessLimited));

        vacuous.Should().BeEmpty(
            "a family that publishes nothing makes this assertion pass while proving nothing - the shape `def2fb07` "
            + "hid behind when `rockSourceTargets` filtered out every full-health ore: " + string.Join(" | ", vacuous));

        failures.Should().BeEmpty(
            "every row the Mod's own discovery publishes must be one its own preflight accepts, or discovery is "
            + "advertising targets execution refuses: " + string.Join(" | ", failures));
    }

    /// <summary>
    /// Each known-drift pair must STILL fail. A repair without removing the entry is red, which is what stops a fix
    /// from being absorbed into a green suite without anyone noticing the gate stopped watching it.
    /// </summary>
    [Fact]
    public void EveryKnownDriftEntryStillFails()
    {
        var repaired = new List<string>();
        foreach ((string actionId, string expected) in KnownDrift.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            FarmhandActionRegistration registration = DeclaredActions().Single(candidate => candidate.ActionId == actionId);
            string family = registration.Descriptor!.TargetFamily!;
            using var world = TargetFamilyWorld.Create();
            world.PopulateFor(family);
            TargetRoundTripProbe.Outcome outcome = TargetRoundTripProbe.Run(world, actionId, family);
            if (outcome.Rows == 0)
                repaired.Add($"{actionId}/{family}: publishes nothing at all, so the recorded drift is not observable");
            else if (outcome.Accepted)
                repaired.Add($"{actionId}/{family}: now PASSES - remove its KnownDrift entry ({expected})");
        }

        repaired.Should().BeEmpty(string.Join(" | ", repaired));
    }

    /// <summary>
    /// Every executing action that declares a family, derived from the definitions. A new action with a family and no
    /// driver fails <see cref="TheCountsAreRatchetedAndEveryPairIsAccountedFor"/> by name.
    /// </summary>
    private static IReadOnlyList<FarmhandActionRegistration> DeclaredActions() =>
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.Kind == FarmhandOperationKind.Execution)
            .Where(registration => !string.IsNullOrEmpty(registration.Descriptor?.TargetFamily))
            .ToArray();

    /// <summary>
    /// The nullable list families `BridgeSnapshot` declares, read from the Mod's own record rather than listed here.
    /// </summary>
    private static IReadOnlySet<string> BridgeSnapshotListFamilies(string models)
    {
        int declaration = models.IndexOf("public sealed record BridgeSnapshot(", StringComparison.Ordinal);
        declaration.Should().BeGreaterThanOrEqualTo(0, "BridgeSnapshot must be findable by its declaration");
        int end = models.IndexOf("\n)", declaration, StringComparison.Ordinal);
        string parameters = models[(declaration + "public sealed record BridgeSnapshot(".Length)..end];

        var families = new HashSet<string>(StringComparer.Ordinal);
        foreach (string raw in parameters.Split(','))
        {
            // Comments inside the parameter list carry commas; strip each line's tail first.
            string parameter = string.Join(" ", raw.Split('\n').Select(line => line.Split("//")[0].Trim()));
            int open = parameter.IndexOf("IReadOnlyList<", StringComparison.Ordinal);
            if (open < 0) continue;
            int close = parameter.IndexOf(">? ", open, StringComparison.Ordinal);
            if (close < 0) continue;
            string name = parameter[(close + 3)..].Split(' ', '=', ',')[0].Trim();
            if (name.Length == 0) continue;
            families.Add(char.ToLowerInvariant(name[0]) + name[1..]);
        }

        families.Should().NotBeEmpty("BridgeSnapshot declares its target families as nullable list parameters");
        return families;
    }

    /// <summary>The array families the Host validates, read from `SNAPSHOT_FAMILY_RULES` itself.</summary>
    private static IReadOnlySet<string> HostSnapshotFamilyRules()
    {
        string protocol = File.ReadAllText(
            Path.Combine(RepositoryRoot(), "host", "src", "protocol.ts"));
        int start = protocol.IndexOf("export const SNAPSHOT_FAMILY_RULES", StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, "SNAPSHOT_FAMILY_RULES must be findable in host/src/protocol.ts");
        int end = protocol.IndexOf("]);", start, StringComparison.Ordinal);
        end.Should().BeGreaterThan(start, "SNAPSHOT_FAMILY_RULES must close with `]);`");

        var families = new HashSet<string>(
            Regex.Matches(protocol[start..end], "\\{ field: \"([A-Za-z]+)\"")
                .Select(match => match.Groups[1].Value),
            StringComparer.Ordinal);
        families.Should().NotBeEmpty("SNAPSHOT_FAMILY_RULES declares the array families the Host validates");
        return families;
    }

    private static string Read(string relative) =>
        File.ReadAllText(Path.Combine(RepositoryRoot(), "integrations", "stardew", relative));

    internal static string RepositoryRoot()
    {
        string? directory = AppContext.BaseDirectory;
        while (directory is not null && !Directory.Exists(Path.Combine(directory, "integrations")))
            directory = Path.GetDirectoryName(directory);
        return directory ?? throw new InvalidOperationException("repository_root_not_found");
    }
}
