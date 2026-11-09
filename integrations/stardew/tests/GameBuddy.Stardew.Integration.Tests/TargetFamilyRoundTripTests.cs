using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text.Json;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;
using Xunit.Abstractions;
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
    private readonly ITestOutputHelper output;

    public TargetFamilyRoundTripTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>
    /// One action whose declared family this file drives through its own preflight, and whose target check therefore
    /// RUNS.
    ///
    /// The row is (action, family); the family is asserted EQUAL to the descriptor's own declaration, so an action
    /// re-pointed at a different family cannot keep a stale driver that passes.
    ///
    /// <para>
    /// THE FLOOR WAS MEASURED AGAINST A VACUOUS PROBE AND IS NOW TRUE. This list held nineteen pairs and reported every
    /// one of them as a pass on 2026-11-01; none reached a target check. Two gates sat in front of every target read -
    /// `AdmitExecution` refusing `player_not_actionable` because `Farmer.canMove` was false on an uninitialized instance,
    /// and the body's own `!Context.IsWorldReady` opening line - and neither code was named in either refusal list, so
    /// both fell through the "not a target disagreement" branch and the pair returned Accepted. When the probe was then
    /// made to print what each receipt actually said, THIRTEEN of the nineteen were passing on a swallowed
    /// `NullReferenceException` from a missing `Farmer`/`Tool` NetField and FIVE more on a refusal code that fell through
    /// the same gap (`chest_empty`, `item_not_owned_in_slot`, `observation_binding_precondition_failed`,
    /// `already_equipped`). Seven pairs remain, and each one now passes only by reaching its target check. The rest are
    /// in <see cref="Undriven"/> or <see cref="UndrivenPairs"/> with the concrete native surface each one needs, and the
    /// two promoted on 2026-11-08 are the reason to read those blockers with suspicion: both had been blamed on the
    /// engine while the real cause was four missing facts on the probe farmer.
    /// </para>
    /// </summary>
    internal static readonly IReadOnlyDictionary<string, string> DrivenFamilies = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["chest_store"] = "chests",
        ["npc_relationship"] = "npcRelationshipTargets",
        ["talk_to_npc"] = "npcRelationshipTargets",
        ["pickup_item"] = "itemTargets",
        ["equip_tool"] = "toolSlots",
        // PROMOTED 2026-11-08, and the reason both sat in `Undriven` is the finding: neither was an engine limit.
        //
        // `rockSourceTargets` was recorded as "a rock break drops native debris through Game1.createRadialDebris, which
        // needs the item type-definition registry". The registry was never reached. The probe farmer had a ZERO maximum
        // stamina (Farmer.maxStamina is a NetInt field initializer an uninitialized instance never runs), so the first
        // swing clamped stamina to 0 and `Farmer.checkForExhaustion` took its exhausted branch, which reads
        // `Game1.content`; and `Game1.recentMultiplayerRandom` - the static every native debris chunk is built from
        // (`Debris.InitializeChunks`) - was null. Two one-line fixture facts had been reported as "the engine cannot do
        // this" for a week.
        //
        // `clearHoeDirtTargets` was recorded as "the hoe swing ends in Farmer.checkForExhaustion, which reads
        // Game1.content strings" - which was TRUE and was still the zero-max-stamina defect above, not the action.
        //
        // Both now pass by reaching their own target check and their own native body, and each is also measured under a
        // held state in `HeldStatePerturbationTests` (`succeeded/rock_source_damaged`, `succeeded/hoedirt_cleared`).
        ["break_rock"] = "rockSourceTargets",
        ["clear_hoedirt"] = "clearHoeDirtTargets",
    };

    /// <summary>
    /// Pairs that FAIL their round trip today, each naming the real defect it fails on.
    ///
    /// Asserted to STILL fail. Removing an entry is the act of fixing the defect; fixing the defect without removing
    /// its entry fails here, which is what stops a repair from being silently absorbed into a green suite.
    ///
    /// <para>
    /// EMPTY, AND THAT IS A FINDING. Every pair this file can no longer drive failed on the HARNESS running out of a
    /// native surface (a content manager, a `Game1` static only the game's own constructor creates, the item
    /// type-definition registry), not on discovery and execution disagreeing about a target. A harness gap parked here
    /// would invent a product defect; the entries below are where those belong.
    /// </para>
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> KnownDrift = new Dictionary<string, string>(StringComparer.Ordinal)
    {
    };

    /// <summary>
    /// Pairs this file cannot drive, in a family that ANOTHER action's pair does drive.
    ///
    /// A third shape is unavoidable here because <see cref="Undriven"/> is keyed by family and cannot say "`chest_store`
    /// drives `chests`, and `chest_retrieve` cannot": both name the same family, and the family is genuinely driven.
    /// Collapsing them would either lose the passing pair or park a harness gap in `KnownDrift` as a product defect.
    /// </summary>
    internal static readonly IReadOnlyDictionary<string, string> UndrivenPairs = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["chest_retrieve"] = "the `chests` row publishes the container's CONTENTS and moving one out reads the item type-definition registry (Data/Objects), which this process never loads; `chest_store` drives the same family because storing needs no registry read",
        ["interact_npc_with_item"] = "the `npcRelationshipTargets` row publishes no pack slot and no item, and this action declares both; a gift driver would have to place the item itself, which is a driver owed rather than a world that cannot exist",
    };

    /// <summary>
    /// Pairs the headless world cannot construct, each with the CONCRETE blocker.
    ///
    /// A blocker is a missing `Game1` field, a `Data/*` asset this process does not load, or native state only a save
    /// carries - something a reader could falsify by teaching the harness. "Not implemented yet" is not a blocker and
    /// does not belong here: that is a driver owed, not a world that cannot exist.
    ///
    /// <para>
    /// EVERY REASON HERE IS RE-CHECKED AGAINST THE PROBE'S OWN CONTRACT. <see cref="ProbeWorldContract"/> states the
    /// values a complete world owns - the field initializers and startup statics `FormatterServices.GetUninitializedObject`
    /// skips - and <see cref="ProbeWorldContractTests"/> fails, naming the family, when a reason here blames one of them:
    /// that is a HARNESS omission recorded as an engine limit, and it has to be re-measured or rewritten rather than left
    /// to stand. The five causes the contract was written for (`Farmer.maxStamina`, `Game1.recentMultiplayerRandom`,
    /// `Game1.currentLocation`, `Farmer.experiencePoints`, `Crop.raisedSeeds`) cost two families a week of being reported
    /// as "the engine cannot do this".
    /// </para>
    /// </summary>
    /// <summary>
    /// Undriven families the only recorded payload measurement cannot cover, each with the reason it is genuinely
    /// NOT MEASURED rather than known to be cheap.
    ///
    /// <para>
    /// This is the third answer the cost gate otherwise cannot give. `waterTargets` arrived with `fish_here` and no live
    /// run has observed a snapshot containing it, so no share of the payload exists to check. Every entry expires by
    /// itself: the gate fails when a family named here IS measured, so the blocker is re-argued instead of standing.
    /// </para>
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> UnmeasuredFamilies = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["waterTargets"] = "newer than the recorded measurement: no live run has published it yet, so its share of the observation payload is not measured",
    };

    internal static readonly IReadOnlyDictionary<string, string> Undriven = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["animalDoorTargets"] = "a Building whose Data/Buildings row declares an animal door; the asset is not loaded here",
        ["animalProductTargets"] = "a FarmAnimal with produce data from Data/FarmAnimals; the asset is not loaded here",
        ["artifactSpotTargets"] = "an Object (O)590 on a map tile that isTilePassable on one side; the harness map declares no passability properties",
        ["baitCrabPotTargets"] = "a placed CrabPot (O)710 object plus a (O)685 bait stack; the pot's rules come from Data/BigCraftables",
        ["buildingChestTargets"] = "a Building whose Data/Buildings row declares Chests; the asset is not loaded here",
        ["bushTargets"] = "a Bush terrain feature; re-measured 2026-11-08, `harvest_bush` publishes its row and passes its own target check, and the body that follows throws in `InstanceGame.IsMainInstance` - the XNA `GameRunner.instance` this process cannot construct - so the `Data/WildTrees` load the reason used to name is not reached before that, and the remaining blocker is the game object rather than the asset",
        ["caskTargets"] = "a Cask object whose ageing rules come from Data/BigCraftables; the asset is not loaded here",
        ["colorTargets"] = "a Chest carrying a DiscreteColorPicker colour; Chest.owner/playerChest are set, the palette state is not",
        ["cookingRecipeTargets"] = "Data/CookingRecipes; the asset is not loaded here",
        ["crabPotCollectTargets"] = "a placed CrabPot holding harvested output; the pot's rules come from Data/BigCraftables",
        ["crabPotTargets"] = "a currentLocation of type Farm holding a (O)710 stack; TargetFamilyWorld builds a plain GameLocation",
        ["craftingRecipeTargets"] = "Data/CraftingRecipes; the asset is not loaded here",
        ["dailyQuestTargets"] = "Game1.questOfTheDay, which only a save load populates",
        ["debrisTargets"] = "a ResourceClump in the location's resourceClumps layer is CONSTRUCTIBLE now (TargetFamilyWorld.PlaceResourceClump) and both its actions reach the native swing; what stops the round trip is the drop: `ResourceClump.destroy` calls `ItemRegistry.Create(\"(O)709\")`, and the item type-definition registry is populated from the game's Data/Objects at startup, so a process without it throws RequireTypeDefinition(\"(O)\"); measured 2026-11-08 as KeyNotFoundException after the target check",
        ["farmAnimalPetTargets"] = "a FarmAnimal in the location's animals dictionary; its type, behaviour and edibility come from Data/FarmAnimals, which this process never loads",
        ["farmBuildingTargets"] = "Data/Buildings (every buildable type, cost and material); the asset is not loaded here - it is 4.6% of the payload, just under the threshold, and will cross it on a heavier run",
        ["feedTroughTargets"] = "an AnimalHouse location with a Trough map property; the harness builds no interior location",
        ["fenceGateTargets"] = "a Fence in the location's fences layer, which is built by Fence.reload from save data",
        ["fertilizerTargets"] = "a fertilizer stack plus a tillable tile (map `Diggable` property); the harness map declares none",
        ["fishPondTargets"] = "a FishPond building whose fish population comes from save data",
        ["foodTargets"] = "Data/Objects (edibility and stamina fields); the asset is not loaded here",
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
        ["petTargets"] = "a Pet; the world already builds one headlessly (TargetFamilyWorld.PlacePet) with the `Dog` row Game1.petData carries, so this is not a save-only family - re-measured 2026-11-08, the round trip then throws ArgumentOutOfRangeException from Netcode.NetList.get_Item, an empty list the petting path indexes, and that harness fact is still to be narrowed",
        ["raftTargets"] = "a raft on a water tile, which GameLocation creates from map tile properties",
        ["refillWateringCanTargets"] = "a water-source landmark, which GameLocation derives from map tile properties",
        ["seedTargets"] = "plant_seed is owed a driver: a seed stack plus a tillable tile (map `Diggable` property); the harness map declares none",
        ["shakeTreeTargets"] = "Tree.shake() calls _LoadWildTreeData(), which loads Data/WildTrees from a content manager this process does not have; measured 2026-11-01 as a NullReferenceException inside DataLoader.Load, not a refusal",
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
        ["waterTargets"] = "a water tile the engine's own `isTileFishable` accepts; `TargetFamilyWorld`'s map declares Back/Buildings/Front layers with no tile PROPERTIES, so `isWaterTile` is false on every tile it can build (the same blocker `refillWateringCanTargets` names), and `FishingActionTests` exercises the refusal vocabulary instead",
        ["wearableTargets"] = "equip_wearable is owed a driver: Farmer wardrobe slots, whose occupants come from Data/Objects and a loaded save",
        ["woodFenceTargets"] = "a currentLocation of type Farm plus a (O)322 stack; TargetFamilyWorld builds a plain GameLocation",
        ["pendingLevelUpChoices"] = "Game1.player.newLevels, which only Game1.showEndOfNightStuff populates at the night boundary",
        ["petBowlTargets"] = "a PetBowl Building; Building's own constructor loads Data/Buildings",
        ["worldObjectTargets"] = "a `Furniture` in `location.furniture` is what `MovePlacedFurnitureActionTests.FurnitureWorld` already builds headlessly, but this family's row builder reads `placed.DisplayName` UNGUARDED (`string.IsNullOrEmpty(placed.DisplayName)`), which resolves through `ItemRegistry.GetDataOrErrorItem` -> `RequireTypeDefinition(\"(O)\")`; the item type-definition registry is populated from the game's Data/Objects at startup, so no object or furniture row can be published here at all - measured 2026-11-08, and the guarded `RequireDisplayName` every other family uses is what would make the family publishable",
        // ---- measured 2026-11-01, when the probe stopped reporting refusals as passes -------------------------
        // Every family below WAS reported as driven. Its row came from the real `Discover*` and the action's own
        // preflight then refused, threw, or answered a code the probe could not read - and the pair was counted green.
        // Each blocker names the native surface the handler reaches AFTER the target check, which is why the target
        // check itself is proven and the pair still cannot be a round trip.
        //
        // RE-MEASURED 2026-11-08. Four of these blockers were the PROBE FARMER, not the engine: zero `maxStamina`,
        // null `Game1.recentMultiplayerRandom`, null `Game1.currentLocation` and a zero-length `experiencePoints`.
        // `rockSourceTargets` and `clearHoeDirtTargets` were that shape and are now driven (see `DrivenFamilies`); the
        // entries still here were re-run against the repaired world and each now names the surface it really reaches.
        ["treeChopSourceTargets"] = "a chop that fells a tree reaches Tree._LoadWildTreeData -> DataLoader.Load(Data/WildTrees) and this process has no content manager; measured 2026-11-08 as ContentLoadException, after the target check",
        ["treeStumpTargets"] = "a stump chop reaches the same Tree._LoadWildTreeData content load; measured 2026-11-08 as ContentLoadException, after the target check",
        ["weedTargets"] = "Object.cutWeed spawns a TemporaryAnimatedSprite from a game texture; measured 2026-11-08 as NullReferenceException in TemporaryAnimatedSprite.loadTexture, after the target check",
        ["grassTargets"] = "a scythe swing spawns the same TemporaryAnimatedSprite texture; measured 2026-11-08 as NullReferenceException in TemporaryAnimatedSprite.loadTexture, after the target check",
        ["scytheCropTargets"] = "the scythe body calls ItemRegistry.Create for the harvest id, which needs Data/Objects; measured 2026-11-08 as KeyNotFoundException in ItemRegistry.RequireTypeDefinition, after the target check",
        ["cropTargets"] = "the watering swing ends in HoeDirt.shake, whose billboard is a TemporaryAnimatedSprite built from a game texture; measured 2026-11-08 as NullReferenceException in TemporaryAnimatedSprite.loadTexture, after the target check",
        ["warps"] = "travel and enter_exit are owed a driver: a warp fades the screen through Game1.fadeScreenToBlack, whose ScreenFade is created only by the game's own constructor; measured 2026-11-01 as NullReferenceException after the target check, so the pair needs a fade surface rather than a different world",
        ["forageTargets"] = "pickup_forage refuses `observation_binding_precondition_failed` unless the Mod's scene-target resolver is wired, and that resolver is a Mod wiring slot rather than game state; the row's own binding is therefore never consulted by this harness",
        ["fruitTreeTargets"] = "DiscoverFruitTreeTargets itself throws: FruitTree.IsInSeasonHere reads GetData() -> Game1.fruitTreeData (Data/FruitTrees), which this process never loads; measured 2026-11-01 as NullReferenceException before any row exists",
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

        UndrivenPairs.Keys.Should().BeSubsetOf(
            declared.Select(registration => registration.ActionId),
            "an undriven-pair entry for an action that no longer declares a family is a pair of nothing");

        // A pair is accounted for exactly once: driven, known-drift, or undriven-pair. A pair in two of them would
        // let a real pass and a named gap describe the same action.
        string[] overlapping = DrivenFamilies.Keys
            .Concat(KnownDrift.Keys)
            .Concat(UndrivenPairs.Keys)
            .GroupBy(actionId => actionId, StringComparer.Ordinal)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key)
            .OrderBy(actionId => actionId, StringComparer.Ordinal)
            .ToArray();
        overlapping.Should().BeEmpty(
            "an action is driven, known-drift, or undriven for a named reason, never two of them: "
            + string.Join(" | ", overlapping));

        undriven.Should().Be(
            Undriven.Count,
            "every Undriven entry names a family the definitions actually declare");

        // THE RATCHET, stated as the two directions that matter.
        //
        // MEASURED 2026-11-01 AGAINST AN HONEST PROBE. The previous floor was 19, and it was measured against a probe
        // that could not fail: two admission gates sat in front of every target read and neither code was in either
        // refusal list, so a refusal fell through as a pass, and a swallowed NullReferenceException counted as one too.
        // A ratchet set from a false reading is worse than none - it locks in the fiction - so the floor is the number
        // that survives when a pair may only pass by reaching its target check.
        driven.Should().BeGreaterThanOrEqualTo(
            7,
            "the driven count may not fall: seven pairs reach their action's own target check and pass it today "
            + "(`chest_store`, `npc_relationship`, `talk_to_npc`, `pickup_item`, `equip_tool`, `break_rock`, "
            + "`clear_hoedirt`). The previous floor of 19 was measured against a vacuous probe and proved nothing; the "
            + "floor of 5 was the honest reading of 2026-11-01, and `break_rock`/`clear_hoedirt` joined it on 2026-11-08 "
            + "when four missing facts on the probe farmer were fixed");
        undriven.Should().BeLessThanOrEqualTo(
            64,
            "the undriven count may not rise without a new named blocker: the eleven families this file used to call "
            + "driven moved here when the probe stopped counting refusals as passes, and each one names the native "
            + "surface its handler reaches after the target check - `waterTargets` is the one rise, added with "
            + "`fish_here` and blocked by the harness map declaring no tile properties");

        // Printed so the gap is a NUMBER on every run rather than an absence a reader has to reconstruct. The two
        // counts are of DIFFERENT things and are labelled as such: a pair is an (action, family) row this file drives,
        // a family is a published snapshot list. Two pairs can share one family (`npc_relationship` and `talk_to_npc`
        // both drive `npcRelationshipTargets`), so reporting the pair count as a family count would overstate the gap
        // closed - which is precisely how "driven 16 of 68" was read as sixteen families' worth of coverage.
        int drivenFamilies = DrivenFamilies.Values.Distinct(StringComparer.Ordinal).Count();
        string report =
            $"driven {driven} pairs over {drivenFamilies} of {declaredFamilies.Count} families, "
            + $"known-drift {knownDrift}, undriven {undriven} families, undriven pairs {UndrivenPairs.Count}";
        report.Should().Be(
            $"driven 7 pairs over {drivenFamilies} of {declaredFamilies.Count} families, known-drift 0, "
            + "undriven 64 families, undriven pairs 2",
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
        var unreadable = new List<string>();

        foreach ((string actionId, string family) in DrivenFamilies.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            using var world = TargetFamilyWorld.Create();
            world.PopulateFor(family);
            TargetRoundTripProbe.Outcome outcome = TargetRoundTripProbe.Run(world, actionId, family);

            output.WriteLine(
                $"{actionId}/{family}: accepted={outcome.Accepted} rows={outcome.Rows} "
                + $"refusal={outcome.Refusal} harness={outcome.HarnessLimit} codes=[{outcome.Detail}]");

            if (outcome.UnreadableRefusal.Length > 0)
            {
                unreadable.Add($"{actionId}/{family}: {outcome.Refusal} (codes: {outcome.Detail})");
                continue;
            }

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

        unreadable.Should().BeEmpty(
            "a refusal code this probe can classify as neither a target disagreement nor a pre-target gate is one nobody "
            + "has said whether it reads the target; name it in one of the two lists rather than letting it pass: "
            + string.Join(" | ", unreadable));

        vacuous.Should().BeEmpty(
            "a family that publishes nothing makes this assertion pass while proving nothing - the shape `def2fb07` "
            + "hid behind when `rockSourceTargets` filtered out every full-health ore: " + string.Join(" | ", vacuous));

        failures.Should().BeEmpty(
            "every row the Mod's own discovery publishes must be one its own preflight accepts, or discovery is "
            + "advertising targets execution refuses: " + string.Join(" | ", failures));
    }

    /// <summary>
    /// THE GATE'S OWN GATE: an injected target-identity mismatch must turn every driven pair red.
    ///
    /// <para>
    /// This exists because the assertion above was GREEN FOR A DAY WHILE PROVING NOTHING. Two admission gates sat in
    /// front of every target read, neither of their codes was in either refusal list, and the pair reported a pass; a
    /// swallowed `NullReferenceException` counted as a pass too. Nothing in the suite could tell the difference, because
    /// a gate that only ever runs on real product state cannot distinguish "the product agrees with itself" from "the
    /// probe never asked".
    /// </para>
    /// <para>
    /// So each pair is re-driven with its OWN identity argument corrupted - the target id, the container id, or the
    /// tool selector, whichever the descriptor declares - and the refusal MUST be reported. A pair that still passes
    /// with a corrupted identity is a pair whose target check does not run, which is exactly the defect this file was
    /// written to catch and did not.
    /// </para>
    /// </summary>
    [Fact]
    public void AnInjectedTargetMismatchTurnsEveryDrivenPairRed()
    {
        var blind = new List<string>();
        foreach ((string actionId, string family) in DrivenFamilies.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            // One world at a time, disposed before the next is built: `TargetFamilyWorld` owns the game statics, so two
            // live instances would each capture the other's actor and the second Dispose would restore a dead world.
            TargetRoundTripProbe.Outcome honest = Drive(actionId, family, corruptIdentity: false);
            if (!honest.Accepted) continue;

            TargetRoundTripProbe.Outcome injected = Drive(actionId, family, corruptIdentity: true);
            output.WriteLine($"{actionId}/{family}: honest=[{honest.Detail}] injected=[{injected.Detail}]");

            // The one thing that must be true: the corrupted request was NOT accepted. How it was refused is the
            // product's business (a target-identity code, an invalid selector, a throw); that it was refused at all is
            // the proof that this pair reads the identity it was handed.
            if (injected.Accepted)
                blind.Add($"{actionId}/{family}: still {injected.Refusal} with a corrupted identity (codes: {injected.Detail})");
        }

        blind.Should().BeEmpty(
            "a pair that passes with a corrupted target identity never read its target, so its green is not evidence: "
            + string.Join(" | ", blind));
    }

    /// <summary>One probe run against a fresh world, with the world disposed before the next is built.</summary>
    private static TargetRoundTripProbe.Outcome Drive(string actionId, string family, bool corruptIdentity)
    {
        using var world = TargetFamilyWorld.Create();
        world.PopulateFor(family);
        return TargetRoundTripProbe.Run(world, actionId, family, corruptIdentity);
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
    /// A family whose share of the measured observation payload exceeds this is EXPENSIVE: leaving it undriven is a
    /// decision, so its blocker has to be one too.
    /// </summary>
    private const double ExpensiveSharePercent = 5.0;

    /// <summary>
    /// The literal a blocker uses to claim the companion should not consume the family at all, e.g.
    /// `not consumed: &lt;why the action surface never offers it&gt;`. The claim is checked against the catalog's own
    /// lifecycle below; nothing else in it is machine-readable.
    /// </summary>
    private const string NotConsumedMarker = "not consumed:";

    /// <summary>
    /// THE WEIGHTED GAP. `Undriven` is a flat list, so a family that costs 5.5% of every observation and a family
    /// that costs a hundredth of a percent sit side by side looking equally cheap.
    ///
    /// <para>
    /// The numbers come from `target-family-payload.json`, derived from a real run's own session jsonl (the file's
    /// `measurement` block states the run and the method, so it can be re-derived rather than trusted). Above
    /// <see cref="ExpensiveSharePercent"/> the blocker has to answer the cost in one of exactly two ways: name the
    /// driver that is owed (an action id the catalog declares for that family) and what it still needs, or claim the
    /// companion should not consume the family at all. "The harness cannot construct it" is exactly the shape this
    /// rejects: true of nearly every entry below the threshold, and no answer at all to "so what do we do about the
    /// 5.5%?".
    /// </para>
    /// <para>
    /// THE `not consumed:` CLAIM IS NOT FREE. It is the shape `villagerWhereabouts` has - a perception family read by
    /// the fact line and addressed by no target id - so it is only available where the catalog itself says nothing on
    /// the Agent surface consumes the family: every action declaring it is <see cref="FarmhandActionLifecycle.Experimental"/>,
    /// which the catalog keeps off the default Agent surface until it passes its own live gate. A family with any
    /// `Published` or `LiveVerified` consumer IS consumed, and `uses: 0` in one run is not evidence otherwise - it says
    /// the run never equipped a hat, not that nothing reads the hat family.
    /// </para>
    /// <para>
    /// THE RATCHET IS UNTOUCHED: this reads `Undriven` and asserts nothing about its size. A family cannot leave the
    /// list by becoming expensive, only by gaining a driver or by someone writing down that it should not have one.
    /// </para>
    /// </summary>
    [Fact]
    public void ExpensiveUndrivenFamiliesCarryADriverOrAReason()
    {
        PayloadMeasurement measurement = ReadPayloadMeasurement();
        IReadOnlyList<FarmhandActionRegistration> declared = DeclaredActions();

        var unmeasured = new List<string>();
        var unanswered = new List<string>();

        foreach (string family in Undriven.Keys.OrderBy(candidate => candidate, StringComparer.Ordinal))
        {
            if (!measurement.Families.TryGetValue(family, out PayloadFamily? cost))
            {
                unmeasured.Add(family);
                continue;
            }

            if (cost.Share <= ExpensiveSharePercent) continue;

            string blocker = Undriven[family];
            string weight =
                $"{family} costs {cost.Share:0.0}% of the observation payload ({cost.Bytes} B of {measurement.TotalBytes} B)";

            FarmhandActionRegistration[] consumers = declared
                .Where(registration => string.Equals(registration.Descriptor!.TargetFamily, family, StringComparison.Ordinal))
                .ToArray();

            // The claim is read BEFORE the driver-name check, because a blocker that says "not consumed: equip_wearable
            // is off the Agent surface" contains an action id and would otherwise satisfy the branch that demands one.
            if (blocker.Contains(NotConsumedMarker, StringComparison.Ordinal))
            {
                // `not consumed:` says nothing on the Agent surface reads this family. The catalog is what decides
                // that, not the blocker: a Published or LiveVerified consumer contradicts the claim by existing.
                FarmhandActionRegistration[] onSurface = consumers
                    .Where(registration => registration.Lifecycle != FarmhandActionLifecycle.Experimental)
                    .ToArray();
                if (onSurface.Length == 0) continue;

                unanswered.Add(
                    $"{weight} and `{NotConsumedMarker}` is refused: {string.Join(", ", onSurface.Select(registration => registration.ActionId))} "
                    + $"consumes it on the Agent surface, so name one of those and what the driver still needs");
                continue;
            }

            if (consumers.Any(registration => blocker.Contains(registration.ActionId, StringComparison.Ordinal))) continue;

            unanswered.Add(
                $"{weight}, and the catalog gives it {string.Join(", ", consumers.Select(registration => registration.ActionId))}, "
                + $"yet its blocker is \"{blocker}\". Name one of those and what the driver still needs, or say "
                + $"`{NotConsumedMarker} <why no action should consume it>`");
        }

        // Printed BEFORE the assertions: a red run is the one that most needs the weighted gap in front of it, and a
        // line that only appears on green would be missing exactly when someone is looking for it.
        double undrivenShare = Undriven.Keys.Sum(family => measurement.Families.TryGetValue(family, out PayloadFamily? cost) ? cost.Share : 0);
        output.WriteLine(
            $"driven {DrivenFamilies.Count} of {DeclaredFamilyCount()} families, known-drift {KnownDrift.Count}, "
            + $"undriven {Undriven.Count}, undriven payload share {undrivenShare:0.0}%");

        // The expensive entries, printed by name and weight so the line above is falsifiable rather than a total.
        foreach (string family in Undriven.Keys.Where(candidate => IsExpensive(measurement, candidate)).OrderByDescending(candidate => measurement.Families[candidate].Share))
        {
            PayloadFamily cost = measurement.Families[family];
            output.WriteLine($"  {family}: {cost.Share:0.0}% ({cost.Bytes} B), uses {cost.Uses}");
        }

        output.WriteLine(
            $"  measured over {measurement.Run}: {measurement.Observations} observations, {measurement.TotalBytes} B");

        unmeasured.Should().BeSubsetOf(
            UnmeasuredFamilies.Keys,
            "an undriven family the measurement does not cover is one whose cost nobody knows, so it must say so here: "
            + string.Join(" | ", unmeasured));
        foreach (string family in UnmeasuredFamilies.Keys)
            unmeasured.Should().Contain(family,
                $"the `{UnmeasuredFamilies[family]}` entry expires by itself: once the measurement covers `{family}`, the "
                + "blocker has to be re-argued instead of standing");

        unanswered.Should().BeEmpty(
            $"a family above {ExpensiveSharePercent:0.#}% of the observation payload must answer its cost by naming the "
            + "driver it is owed or why no action should consume it: " + string.Join(" | ", unanswered));
    }

    private static int DeclaredFamilyCount() =>
        DeclaredActions().Select(registration => registration.Descriptor!.TargetFamily!).Distinct(StringComparer.Ordinal).Count();

    private static bool IsExpensive(PayloadMeasurement measurement, string family) =>
        measurement.Families.TryGetValue(family, out PayloadFamily? cost) && cost.Share > ExpensiveSharePercent;

    /// <summary>
    /// The measured payload shares, read from the committed file rather than listed here.
    /// </summary>
    private static PayloadMeasurement ReadPayloadMeasurement()
    {
        string path = Path.Combine(
            RepositoryRoot(), "integrations", "stardew", "tests", "GameBuddy.Stardew.Integration.Tests", "target-family-payload.json");
        File.Exists(path).Should().BeTrue(
            "the weighted gate needs the measured payload shares; `target-family-payload.json` states the run and the "
            + "method that produced them");

        using var document = JsonDocument.Parse(File.ReadAllText(path));
        JsonElement root = document.RootElement;
        JsonElement measured = root.GetProperty("measurement");

        var families = new Dictionary<string, PayloadFamily>(StringComparer.Ordinal);
        foreach (JsonProperty entry in root.GetProperty("families").EnumerateObject())
        {
            families[entry.Name] = new PayloadFamily(
                entry.Value.GetProperty("bytes").GetInt64(),
                entry.Value.GetProperty("share").GetDouble(),
                entry.Value.GetProperty("uses").GetInt32());
        }

        families.Should().NotBeEmpty("a measurement with no families measures nothing");
        return new PayloadMeasurement(
            measured.GetProperty("run").GetString() ?? string.Empty,
            measured.GetProperty("observations").GetInt32(),
            measured.GetProperty("totalBytes").GetInt64(),
            families);
    }

    /// <summary>One run's measured observation payload, per top-level snapshot key.</summary>
    private sealed record PayloadMeasurement(
        string Run,
        int Observations,
        long TotalBytes,
        IReadOnlyDictionary<string, PayloadFamily> Families);

    /// <summary>One family's cost in that payload: bytes, its share of the whole, and how often it was used.</summary>
    private sealed record PayloadFamily(long Bytes, double Share, int Uses);

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
