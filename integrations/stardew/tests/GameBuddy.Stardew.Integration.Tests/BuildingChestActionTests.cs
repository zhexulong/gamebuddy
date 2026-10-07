using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The building-chest pair (`load_building_chest` / `collect_building_chest_output`) contract pins.
///
/// Seam decision: a building's OWN storage is declared in DATA
/// (`BuildingData.Chests`, StardewValley.GameData.Buildings/BuildingChest.cs) and reached by a click
/// on a building tile — GameLocation.checkAction (GameLocation.cs:7647-7653) → Building.doAction
/// (Building.cs:981-992) → BuildingData.GetActionAtTile (BuildingData.cs:271-291) →
/// GameLocation.performAction's BuildingChest case (:10128-10136) → Building.PerformBuildingChestAction
/// (Building.cs:746-811). Nothing on that path needs an input edge, so both actions call the TERMINAL
/// public method directly, exactly as `toggle_animal_door` calls Building.ToggleAnimalDoor.
///
/// What is pinned here are the three contracts a green receipt cannot prove by itself: the branch
/// split (the Chest type is a container menu and is refused, the Load branch is quantised, the
/// Collect branch auto-collects only a single stack and is refused BY NAME otherwise), the observed
/// two-sided postconditions, and the fact that the Load branch's three native refusals are labelled
/// rather than re-invented.
///
/// The native calls themselves, the observed world change and the negative cases belong to the
/// native-local fixture gates (scenarios native_building_chest_v1 /
/// native_building_chest_multistack_v1).
/// </summary>
public sealed class BuildingChestActionTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.buildingchestactions.cs";
    private const string FixtureFile = "ModEntry.Fixtures.BuildingChest.cs";
    private const string LoadRunnerFile = "run-stardew-native-local-player-load-building-chest-smoke.mjs";
    private const string CollectRunnerFile = "run-stardew-native-local-player-collect-building-chest-output-smoke.mjs";

    /// <summary>
    /// Every failure mode each action can produce has its own terminal code, so a receipt never
    /// collapses "this building has no such chest" into "you sent the Collect chest to the load
    /// action" into "the native call ran but the world did not move".
    /// </summary>
    private static readonly string[] LoadReasonCodes =
    {
        "building_chest_loaded",
        "building_chest_load_refused",
        "building_chest_load_postcondition_unavailable",
        "building_chest_native_exception",
        "building_chest_target_not_found",
        "building_chest_missing",
        "building_chest_target_changed",
        "building_chest_requires_menu",
        "building_chest_not_loadable",
        "building_chest_out_of_range",
        "item_not_owned_in_slot",
    };

    private static readonly string[] CollectReasonCodes =
    {
        "building_chest_output_collected",
        "building_chest_collect_refused",
        "building_chest_collect_postcondition_unavailable",
        "building_chest_native_exception",
        "building_chest_target_not_found",
        "building_chest_missing",
        "building_chest_target_changed",
        "building_chest_requires_menu",
        "building_chest_not_collectable",
        "building_chest_out_of_range",
        "building_chest_empty",
        "inventory_full",
    };

    [Fact]
    public void Handler_DrivesTheTerminalNativeSeam_AndNeverDrivesTheSelectorOrAMenu()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string load = MethodBody(source, "private LocalExecutionReceipt ExecuteLoadBuildingChest(");

        foreach (string failureCode in LoadReasonCodes)
            code.Should().Contain($"\"{failureCode}\"", $"the load action must be able to report {failureCode}");

        // The seam is the terminal public method, called on the game thread.
        load.Should().Contain("building.PerformBuildingChestAction(resolution.ChestId, Game1.player)");

        // NEGATIVE: neither the click dispatcher nor a container menu may appear in the code. The
        // action string literal "BuildingChest" DOES appear, because the discovery derives the
        // published tile from the data's own action string — that is reading the declaration, not
        // driving the selector. Asserted against CODE only: the header legitimately names what it
        // does not call.
        code.Should().NotContain("performAction(");
        code.Should().NotContain("checkAction(");
        code.Should().NotContain(".doAction(");
        code.Should().NotContain("ItemGrabMenu");
        code.Should().NotContain("activeClickableMenu =");

        // The native Load branch reads who.ActiveObject, so the requested slot is HELD for the call
        // and the actor's previous selection is restored afterwards — the machine_load precedent.
        load.Should().Contain("Game1.player.CurrentToolIndex = slot;");
        load.Should().Contain("Game1.player.CurrentToolIndex = previousSlot;");
        load.Should().Contain("finally");
    }

    [Fact]
    public void Handler_CollectsOnlyASingleStack_AndRefusesTwoOrMoreByName()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string collect = MethodBody(source, "private LocalExecutionReceipt ExecuteCollectBuildingChestOutput(");

        foreach (string failureCode in CollectReasonCodes)
            code.Should().Contain($"\"{failureCode}\"", $"the collect action must be able to report {failureCode}");

        // The owner's ruling: two or more stacks is a NAMED REFUSAL, never a menu this Mod does not
        // drive. The branch count is the native one (non-null slots, Utility.cs:2047-2065).
        collect.Should().Contain("chestSlotsBefore >= 2");
        collect.Should().Contain("\"building_chest_requires_menu\"");
        collect.Should().Contain("\"building_chest_empty\"");
        // The single-stack branch adds what it can and then opens ItemGrabMenu for the remainder
        // (Utility.cs:2080-2085), so the whole stack must fit before the call.
        collect.Should().Contain("couldInventoryAcceptThisItem(single)");
        collect.Should().Contain("\"inventory_full\"");
        collect.Should().Contain("building.PerformBuildingChestAction(resolution.ChestId, Game1.player)");

        // The refusals all precede the native call, so a refused collect cannot have moved anything.
        int refusal = collect.IndexOf("building_chest_requires_menu", StringComparison.Ordinal);
        int nativeCall = collect.IndexOf("building.PerformBuildingChestAction(", StringComparison.Ordinal);
        refusal.Should().BeGreaterThanOrEqualTo(0);
        nativeCall.Should().BeGreaterThan(refusal, "the >= 2-stack refusal must be decided before the native call");
    }

    [Fact]
    public void Handler_DecidesOnTheObservedTwoSidedTransfer()
    {
        string source = ReadHandlerSource();
        string load = MethodBody(source, "private LocalExecutionReceipt ExecuteLoadBuildingChest(");
        string collect = MethodBody(source, "private LocalExecutionReceipt ExecuteCollectBuildingChestOutput(");

        // The Load branch's bool is not the proof: the chest's count of the held item and the held
        // stack must both have moved, by the same amount, in whole RequiredCount quanta.
        int loadCall = load.IndexOf("building.PerformBuildingChestAction(", StringComparison.Ordinal);
        int loadChestReRead = load.IndexOf("chestItemAfter = ChestItemCount(chest, qualifiedItemId)", StringComparison.Ordinal);
        int loadSuccess = load.IndexOf("\"building_chest_loaded\"", StringComparison.Ordinal);
        loadCall.Should().BeGreaterThanOrEqualTo(0);
        loadChestReRead.Should().BeGreaterThan(loadCall, "the chest half must be re-read after the native call");
        loadSuccess.Should().BeGreaterThan(loadChestReRead, "success must be decided after the re-read");
        load.Should().Contain("movedCount == releasedCount");
        load.Should().Contain("movedCount % requiredCount == 0");

        // Collector: the named stack must leave the chest AND arrive, and the slot count must fall.
        int collectCall = collect.IndexOf("building.PerformBuildingChestAction(", StringComparison.Ordinal);
        int carriedReRead = collect.IndexOf("carriedAfter = CountQualifiedItem(Game1.player, single.QualifiedItemId)", StringComparison.Ordinal);
        int collectSuccess = collect.IndexOf("\"building_chest_output_collected\"", StringComparison.Ordinal);
        collectCall.Should().BeGreaterThanOrEqualTo(0);
        carriedReRead.Should().BeGreaterThan(collectCall, "the receiving half must be re-read after the native call");
        collectSuccess.Should().BeGreaterThan(carriedReRead, "success must be decided after the re-read");
        collect.Should().Contain("chestSlotsAfter < chestSlotsBefore");
        collect.Should().Contain("carriedAfter - carriedBefore == movedCount");

        // A call that ran without moving the world is Uncertain, never a success.
        load.Should().Contain("\"building_chest_load_postcondition_unavailable\"");
        collect.Should().Contain("\"building_chest_collect_postcondition_unavailable\"");
    }

    [Fact]
    public void Handler_LabelsTheLoadBranchesOwnRefusals_InsteadOfInventingReasonCodes()
    {
        string source = ReadHandlerSource();
        string evidence = MethodBody(source, "private static string DescribeNativeLoadRefusal(");

        // The three gates belong to the native branch, which posts the chest data's own
        // InvalidItemMessage / ChestFullMessage / InvalidCountMessage. The receipt names which field's
        // gate the observed facts match rather than inventing a parallel vocabulary.
        evidence.Should().Contain("\"InvalidItemMessage\"");
        evidence.Should().Contain("\"ChestFullMessage\"");
        evidence.Should().Contain("\"InvalidCountMessage\"");
        evidence.Should().Contain("\"none\"");
        string code = StripLineComments(source);
        code.Should().Contain("native_refusal=");

        // NEGATIVE: no Mod-invented code may stand in for a native message path.
        code.Should().NotContain("building_chest_item_not_accepted");
        code.Should().NotContain("building_chest_full");
        code.Should().NotContain("building_chest_required_count_not_met");
    }

    [Fact]
    public void Handler_DerivesThePublishedTileFromTheBuildingsOwnData()
    {
        string code = StripLineComments(ReadHandlerSource());

        // The anchor is the tile at which the native click reaches THIS chest: the data's action
        // string names it AND the tile is blocked — the exact pair Building.doAction requires.
        code.Should().Contain("data.GetActionAtTile(relativeX, relativeY)");
        code.Should().Contain("building.isTilePassable(new Vector2(tileX, tileY))");
        // The Chest type is never published: it can only open a menu.
        code.Should().Contain("declared.Type is not (BuildingChestType.Load or BuildingChestType.Collect)");
        // The identity binds the chest's declared type and its tile, so neither can drift silently.
        string identity = MethodBody(ReadHandlerSource(), "internal static string BuildBuildingChestTargetId(");
        identity.Should().Contain("DescribeBuildingChestBranch(type)");
        identity.Should().Contain("{tileX},{tileY}");
    }

    [Fact]
    public void Catalog_BuildingChestPair_AreExperimentalBuildingActionsWithTheirOwnShapes()
    {
        FarmhandActionRegistration? load = FarmhandActionCatalog.Registrations
            .FirstOrDefault(entry => entry.ActionId == "load_building_chest");
        FarmhandActionRegistration? collect = FarmhandActionCatalog.Registrations
            .FirstOrDefault(entry => entry.ActionId == "collect_building_chest_output");

        load.Should().NotBeNull();
        collect.Should().NotBeNull();
        foreach (FarmhandActionRegistration registration in new[] { load!, collect! })
        {
            registration.FamilyId.Should().Be("buildings_farm_management");
            // Experimental until each passes its own native-local live gate.
            registration.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
            registration.Kind.Should().Be(FarmhandOperationKind.Execution);
            registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);
            registration.Descriptor.Should().NotBeNull();
            registration.Descriptor!.Effect.Should().Be("write");
            registration.Descriptor.NativeBinding.Should().Be("Building.PerformBuildingChestAction");
        }

        // The Load branch reads who.ActiveObject, so its slot is required; collect takes none.
        load!.Descriptor!.Arguments.Select(argument => argument.Name).Should().Equal("x", "y", "slot", "expectedTargetId");
        load.Descriptor.Postcondition.Should().Be("building_chest_loaded");
        collect!.Descriptor!.Arguments.Select(argument => argument.Name).Should().Equal("x", "y", "expectedTargetId");
        collect.Descriptor.Postcondition.Should().Be("building_chest_output_collected");
    }

    [Fact]
    public void Wire_DeclaresBothExactArgumentShapes()
    {
        BridgeProtocol.ExecutionArgumentProperties("load_building_chest")
            .Should().Equal("x", "y", "slot", "expectedTargetId");
        BridgeProtocol.ExecutionArgumentProperties("collect_building_chest_output")
            .Should().Equal("x", "y", "expectedTargetId");
    }

    [Fact]
    public void Runner_LoadProvesTheQuantisedTransferAndItsThreeNegativeCases()
    {
        string runner = ReadRepositoryFile(Path.Combine("tools", LoadRunnerFile));

        runner.Should().Contain("const ACTION = \"load_building_chest\";");
        runner.Should().Contain("assertRequiredCapabilities");
        // The load's own boundary cases, each asserted by name.
        runner.Should().Contain("building_chest_not_loadable");
        runner.Should().Contain("building_chest_target_changed");
        runner.Should().Contain("item_not_owned_in_slot");
        // The world change is read from a FRESH observation after the terminal, and the identity
        // must NOT move with the contents.
        runner.Should().Contain("chestTargetAtTile(after, target.x, target.y)");
        runner.Should().Contain("building_chest_world_unchanged");
        runner.Should().Contain("building_chest_world_identity_stale");
        // Both halves and the quantum, from the receipt's own observations.
        runner.Should().Contain("building_chest_held_half_mismatch");
        runner.Should().Contain("building_chest_chest_half_mismatch");
        runner.Should().Contain("building_chest_quantum_mismatch");
        runner.Should().Contain("building_chest_loaded");
    }

    [Fact]
    public void Runner_CollectProvesTheSingleStackAndTheNamedMultiStackRefusal()
    {
        string runner = ReadRepositoryFile(Path.Combine("tools", CollectRunnerFile));

        runner.Should().Contain("const ACTION = \"collect_building_chest_output\";");
        runner.Should().Contain("assertRequiredCapabilities");
        // The wrong branch, the named multi-stack refusal, and the single-stack success.
        runner.Should().Contain("building_chest_not_collectable");
        runner.Should().Contain("building_chest_requires_menu");
        runner.Should().Contain("building_chest_output_collected");
        // The world change is read after the terminal, and a menu is never left open.
        runner.Should().Contain("chestTargetAtTile(after, target.x, target.y)");
        runner.Should().Contain("building_chest_world_unchanged");
        runner.Should().Contain("building_chest_menu_refusal_moved_world");
        runner.Should().Contain("native_menu_opened");
        runner.Should().Contain("building_chest_slot_half_mismatch");
        runner.Should().Contain("building_chest_carried_half_mismatch");
    }

    [Fact]
    public void Fixture_EstablishesOnlyTheDeclaredGiven_AndNeverPerformsTheAction()
    {
        string fixture = ReadRepositoryFile(Path.Combine("integrations", "stardew", FixtureFile));

        fixture.Should().Contain("private void InstallNativeLocalBuildingChestFixture(Farmer player, GameLocation farm, bool multiStackOutput)");
        // The Given's building and chest pair come from the building's OWN data, never a hardcoded
        // per-building list, and the accepted item is validated with the native predicate.
        fixture.Should().Contain("TryFindBuildingChestFixturePair");
        fixture.Should().Contain("IsValidObjectForChest");
        fixture.Should().Contain("ReloadBuildingData(forUpgrade: false, forConstruction: true)");
        // The chest layout is written through the game's own inventory API.
        fixture.Should().Contain("GetItemsForPlayer().Clear()");
        fixture.Should().Contain("output.Add(ItemRegistry.Create<StardewValley.Object>(itemId, 2))");
        fixture.Should().Contain("multiStackOutput");
        fixture.Should().Contain("warpFarmer(");
        // Fails loudly when a Given cannot be established.
        fixture.Should().Contain("InvalidOperationException");
        fixture.Should().Contain("fixture_native_local_building_chest_");

        // NEGATIVE: the fixture must not run the action, mint a receipt, or drive the seam itself.
        string code = StripLineComments(fixture);
        code.Should().NotContain("PerformBuildingChestAction");
        code.Should().NotContain("RequestLocalLoadBuildingChest");
        code.Should().NotContain("RequestLocalCollectBuildingChestOutput");
        code.Should().NotContain("checkAction");
        code.Should().NotContain("performAction");
        code.Should().NotContain("PublishReceipt");
    }

    [Fact]
    public void Router_BuildingChestPair_WhenWorldNotReady_Reject()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "load_building_chest", "collect_building_chest_output" });
        ExecutionManager executions = new(new DummyMonitor(), () => publication);
        ResourceToolActionHandler handler = new(executions);

        BridgeExecutionRequest load = new(
            "req_load_building_chest_1", "idemp_load_building_chest_1", "load_building_chest",
            new BridgeExecutionArgs { X = 31, Y = 20, Slot = 3, ExpectedTargetId = "building_chest_0123456789abcdef" },
            1, 5000);
        BridgeExecutionRequest collect = new(
            "req_collect_building_chest_1", "idemp_collect_building_chest_1", "collect_building_chest_output",
            new BridgeExecutionArgs { X = 32, Y = 20, ExpectedTargetId = "building_chest_fedcba9876543210" },
            1, 5000);

        foreach (BridgeExecutionRequest request in new[] { load, collect })
        {
            LocalExecutionReceipt receipt = handler.Execute(request, executions);
            receipt.Should().NotBeNull();
            receipt.State.Should().Be(ExecutionState.Rejected);
            // The scope-bound actor proof precedes every world read, so a world-less probe is
            // refused by the identity guard. The codes a real actor-less Farm returns are pinned
            // by the live gate.
            receipt.ReasonCode.Should().Be("world_not_ready");
        }
    }

    // ---------------------------------------------------------------------------------

    private static string ReadHandlerSource() =>
        ReadRepositoryFile(Path.Combine("integrations", "stardew", HandlerFile));

    /// <summary>Extract one member body by brace balance from its declaration.</summary>
    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{declaration} must exist");

        int depth = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}')
            {
                depth--;
                if (started && depth == 0)
                    return source[start..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced body for {declaration}");
    }

    /// <summary>Drop <c>//</c>/<c>///</c> comments so negative pins test code, not prose.</summary>
    private static string StripLineComments(string source)
    {
        var builder = new System.Text.StringBuilder(source.Length);
        foreach (string line in source.Split('\n'))
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            builder.AppendLine(comment >= 0 ? line[..comment] : line);
        }
        return builder.ToString();
    }

    /// <summary>Tests run from the project or its bin output; walk up to the repository root.</summary>
    private static string ReadRepositoryFile(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return File.ReadAllText(candidate);
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
