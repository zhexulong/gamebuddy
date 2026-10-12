using System;
using System.IO;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// build_farm_building contract pins, for the action whose boundary card is
/// <c>design/tasks/active/cards/card-build-farm-building-boundary.md</c>.
///
/// SEAM DECISION. The carpenter menu has FOUR branches behind
/// <c>CarpenterMenu.receiveLeftClick</c>: build (<c>:898</c> -&gt; <c>setUpForBuildingPlacement</c>
/// -&gt; the second click's <c>tryToBuild</c> at <c>:1083</c>), demolish (<c>:858</c>), move
/// (<c>:865</c>) and paint (<c>:872</c>). Only the BUILD branch is this action's subject; the
/// other three change different world state with different preconditions and are deferred. The
/// settlement the build branch reaches is the public
/// <c>GameLocation.buildStructure(string, Vector2, Farmer, out Building, bool)</c>
/// (GameLocation.cs:16926, delegating to the data overload at :16800 which does
/// <c>buildings.Add(building)</c> and fires <c>SendBuildingConstructedEvent</c>).
///
/// WHAT THIS FILE PINS, and why these are the assertions worth having: the seam call, the
/// ABSENCE of every menu-driving or input path, the one-execution-body shape, the reach rule, the
/// argument quadruple, the single admission, the cost debit (which the seam does NOT perform), and
/// the honest terminal when the world does not change. The native construction itself and the
/// stale-target negative belong to the native-local fixture gate.
/// </summary>
public sealed class BuildFarmBuildingActionTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.buildfarmbuildingactions.cs";

    private static readonly string[] BuildFarmBuildingReasonCodes =
    {
        "farm_building_built",
        "build_farm_building_postcondition_unavailable",
        "build_farm_building_unknown_type",
        "build_farm_building_upgrade_only",
        "build_farm_building_not_buildable_here",
        "build_farm_building_site_blocked",
        "build_farm_building_target_changed",
        "build_farm_building_insufficient_funds",
        "build_farm_building_insufficient_materials",
        "build_farm_building_out_of_range",
        "build_farm_building_placement_refused",
        "build_farm_building_native_exception",
    };

    [Fact]
    public void Handler_BuildsThroughThePublicNativeSeam_AndNeverDrivesTheMenu()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string executed = MethodBody(source, "private LocalExecutionReceipt ExecuteBuildFarmBuilding(");

        foreach (string reasonCode in BuildFarmBuildingReasonCodes)
            code.Should().Contain($"\"{reasonCode}\"", $"the action must be able to report {reasonCode}");

        // The seam is the public UI-free settlement, called on the game thread with the building
        // data's own MagicalConstruction flag (the value the menu passes at CarpenterMenu.cs:1087).
        executed.Should().Contain("location.buildStructure(buildingType, new Vector2(x, y), Game1.player, out constructed, data.MagicalConstruction)");

        // NEGATIVE: none of the menu path, the input path or the other three branches may appear
        // in CODE (the header names what it does not call, so scanning the raw file would flag prose).
        code.Should().NotContain("CarpenterMenu");
        code.Should().NotContain("receiveLeftClick");
        code.Should().NotContain("setUpForBuildingPlacement");
        code.Should().NotContain("tryToBuild");
        code.Should().NotContain("okButton");
        code.Should().NotContain("demolishButton");
        code.Should().NotContain("moveButton");
        code.Should().NotContain("paintButton");
        code.Should().NotContain("globalFadeToBlack");
        code.Should().NotContain("exitThisMenu");
        code.Should().NotContain("ConsumeResources");
        code.Should().NotContain("createQuestionDialogue");
    }

    [Fact]
    public void Handler_HasOneExecutionBody_ReachedFromBothPaths_AndAdmitsOnceWithTheGeneralProfile()
    {
        string source = ReadHandlerSource();
        string request = MethodBody(source, "public LocalExecutionReceipt RequestLocalBuildFarmBuilding(");

        // Design 5.2: a thin request path (admission, target, geometry, then either an approach leg
        // or the shared body) and ONE execution body, so a walk cannot run a second copy of the
        // contract. The approach leg is the family's own TryBeginToolApproach.
        request.Should().Contain("TryBeginToolApproach(");
        request.Should().Contain("this.ExecuteBuildFarmBuilding(arrivalExecutionId, arrivalRequestId");
        request.Should().Contain("return this.ExecuteBuildFarmBuilding(executionId, requestId");

        // Reach is Chebyshev-1 of the named footprint tile, the facility family's own rule.
        request.Should().Contain("IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1)");

        // General, not Physical: the seam drives no tool lifecycle and starts no swing.
        request.Should().Contain("AdmissionActionabilityProfile.General");
        request.Should().Contain("this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General)");
        request.Should().NotContain("AdmissionActionabilityProfile.Physical");

        // The seam takes no tool, no slot and no held item, so this action must not have grown any.
        string code = StripLineComments(source);
        code.Should().NotContain("args.Slot");
        code.Should().NotContain("CurrentToolIndex");
        code.Should().NotContain("beginUsing");
    }

    [Fact]
    public void Handler_ReadsThePostconditionOffTheWorld_AndIsUncertainWhenNothingChanged()
    {
        string source = ReadHandlerSource();
        string executed = MethodBody(source, "private LocalExecutionReceipt ExecuteBuildFarmBuilding(");

        // The decision is the WORLD after the call, never "we called the function": the building
        // resolved at the tile, the money, the materials and the construction days.
        executed.Should().Contain("location.getBuildingAt(new Vector2(x, y))");
        executed.Should().Contain("placed.tileX.Value == x");
        executed.Should().Contain("money_before=");
        executed.Should().Contain("money_after=");
        executed.Should().Contain("materials_required=");
        executed.Should().Contain("days_of_construction_left=");

        // The seam returns bool and refuses, so a false return is a REJECTED receipt; a build that
        // ran but whose fresh postcondition cannot be read is Uncertain - never a success.
        executed.Should().Contain("ExecutionState.Rejected");
        executed.Should().Contain("\"build_farm_building_placement_refused\"");
        executed.Should().Contain("ExecutionState.Uncertain");
        executed.Should().Contain("\"build_farm_building_postcondition_unavailable\"");
    }

    [Fact]
    public void Handler_DebitsTheDeclaredCostItself_BecauseTheSeamDoesNotCharge()
    {
        string source = ReadHandlerSource();
        string executed = MethodBody(source, "private LocalExecutionReceipt ExecuteBuildFarmBuilding(");

        // `buildStructure` writes the structure only; the player pays through the menu's own
        // ConsumeResources. There is no non-menu settlement for the debit, so the handler performs
        // the same two native statements against the building's OWN Data/Buildings entry.
        executed.Should().Contain("Game1.player.Money -= data.BuildCost");
        executed.Should().Contain("Game1.player.Items.ReduceId(qualifiedItemId, amount)");
        MethodBody(source, "private static IReadOnlyList<(string QualifiedItemId, int Amount)> BuildFarmBuildingMaterials(")
            .Should().Contain("ItemRegistry.Create(material.ItemId, material.Amount)");
    }

    [Fact]
    public void Handler_RefusesBeforeTheSeam_ForEveryTargetFact()
    {
        string source = ReadHandlerSource();
        string resolve = MethodBody(source, "private static BuildFarmBuildingSiteResolution ResolveBuildFarmBuildingSite(");

        // Each refusal is decided from a LIVE read, and the stale-target case is an equality check
        // against the id discovery published rather than a re-target.
        resolve.Should().Contain("build_farm_building_unknown_type");
        resolve.Should().Contain("build_farm_building_upgrade_only");
        resolve.Should().Contain("build_farm_building_not_buildable_here");
        resolve.Should().Contain("build_farm_building_site_blocked");
        resolve.Should().Contain("build_farm_building_insufficient_funds");
        resolve.Should().Contain("build_farm_building_insufficient_materials");
        resolve.Should().Contain("IsBuildableLocation()");
        resolve.Should().Contain("IsFarmBuildingFootprintFree(");
        resolve.Should().Contain("string.Equals(liveId, expectedTargetId, StringComparison.Ordinal)");
    }

    [Fact]
    public void Action_IsRegisteredWithTheFrozenArgumentQuadruple()
    {
        string definitions = ReadRepositoryFile(Path.Combine("integrations", "stardew", "src", "Core", "Policy", "FarmhandActionDefinitions.cs"));
        definitions.Should().Contain("\"build_farm_building\"");
        definitions.Should().Contain("\"farm_building_built\"", "the descriptor's terminal must be the code the handler mints");
        definitions.Should().Contain("GameLocation.buildStructure", "the descriptor's seam field must name the settlement");

        int at = definitions.IndexOf("\"build_farm_building\"", StringComparison.Ordinal);
        string entry = definitions[at..Math.Min(definitions.Length, at + 800)];
        entry.Should().Contain("\"buildingType\"");
        entry.Should().Contain("\"x\"");
        entry.Should().Contain("\"y\"");
        entry.Should().Contain("\"expectedTargetId\"");
        entry.Should().Contain("FarmhandActionLifecycle.Experimental", "the action has no live gate yet");

        string protocol = ReadRepositoryFile(Path.Combine("integrations", "stardew", "src", "Core", "Protocol", "BridgeProtocol.cs"));
        protocol.Should().Contain("\"build_farm_building\" => new[] { \"buildingType\", \"x\", \"y\", \"expectedTargetId\" }",
            "the wire argument-name list is what the parser reads before any handler sees the request");

        string router = ReadRepositoryFile(Path.Combine("integrations", "stardew", "Handlers", "ResourceToolActionHandler.cs"));
        router.Should().Contain("\"build_farm_building\" => this.executions.RequestLocalBuildFarmBuilding(");
    }

    [Fact]
    public void Snapshot_PublishesTheSiteProjectionUnderItsOwnCapabilityGate()
    {
        string publication = ReadRepositoryFile(Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.cs"));
        publication.Should().Contain(
            "advertisedCapabilities.Contains(\"build_farm_building\", StringComparer.Ordinal) ? DiscoverBuildFarmBuildingTargets(player) : null");
    }

    [Fact]
    public void Fixture_EstablishesTheGivenThroughTheProductPredicate_AndIsWiredIn()
    {
        string fixture = ReadRepositoryFile(Path.Combine("integrations", "stardew", "ModEntry.Fixtures.BuildFarmBuilding.cs"));
        fixture.Should().Contain("ExecutionManager.TryDescribeBuildFarmBuildingSite(",
            "the fixture's Given must be asserted through the product's own admission predicate");
        fixture.Should().Contain("ExecutionManager.DiscoverBuildFarmBuildingTargets(",
            "and through the same discovery the snapshot publishes");
        fixture.Should().NotContain("RequestLocalBuildFarmBuilding",
            "the fixture must never call the action");

        string config = ReadRepositoryFile(Path.Combine("integrations", "stardew", "ModConfig.cs"));
        config.Should().Contain("\"native_build_farm_building_v1\"");

        string dispatcher = ReadRepositoryFile(Path.Combine("integrations", "stardew", "ModEntry.Fixtures.cs"));
        dispatcher.Should().Contain("\"native_build_farm_building_v1\"");
        dispatcher.Should().Contain("InitializeNativeLocalBuildFarmBuildingFixture(player, farm);");
    }

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

    private static string ReadHandlerSource() =>
        ReadRepositoryFile(Path.Combine("integrations", "stardew", HandlerFile));

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
