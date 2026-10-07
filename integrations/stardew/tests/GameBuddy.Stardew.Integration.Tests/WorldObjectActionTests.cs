using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The world-object lane's three action contracts — <c>place_owned_object</c>,
/// <c>remove_placed_item</c> and <c>break_container_source</c>.
///
/// The three are grouped because they all act on an OBJECT occupying a WORLD TILE and all
/// take that tile plus the backpack slot that acts on it. Each has its own native seam,
/// pinned here as source facts because the live behaviour belongs to the native-local
/// gates (scenario <c>native_world_object_v1</c>):
///   * <c>Utility.tryToPlaceItem</c> -&gt; <c>Object.placementAction</c>'s bigCraftable/
///     Furniture branch, for any owned placeable object (which is why a tapper is ONE
///     action here and not a second one: the tree is the item's own constraint);
///   * <c>Axe</c>/<c>Pickaxe.DoFunction</c> -&gt; <c>Object.performToolAction</c> -&gt;
///     <c>Object.performRemoveAction</c>;
///   * <c>BreakableContainer.performToolAction</c>, whose return value proves nothing.
///
/// Structural assertions run without a Game1 harness; the native mutations, the observed
/// postconditions and every negative case belong to the live gates.
/// </summary>
public sealed class WorldObjectActionTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.worldobjectactions.cs";
    private const string FixtureFile = "ModEntry.Fixtures.WorldObject.cs";
    private static readonly string[] RunnerFiles =
    {
        "run-stardew-native-local-player-place-owned-object-smoke.mjs",
        "run-stardew-native-local-player-remove-placed-item-smoke.mjs",
        "run-stardew-native-local-player-break-container-source-smoke.mjs",
    };

    private static readonly (string ActionId, string Family, string Postcondition, string NativeBinding, string[] Arguments)[] LaneActions =
    {
        ("place_owned_object", "buildings_farm_management", "owned_object_placed", "Object.placementAction",
            new[] { "x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId" }),
        ("remove_placed_item", "buildings_farm_management", "placed_item_removed", "Object.performRemoveAction",
            new[] { "x", "y", "slot", "expectedTargetId" }),
        ("break_container_source", "resource_gathering", "container_source_broken", "BreakableContainer.performToolAction",
            new[] { "x", "y", "slot", "expectedTargetId" }),
    };

    /// <summary>
    /// Every failure mode has its own terminal code, so no receipt can collapse "there is
    /// no such object here" into "the wrong tool is equipped", into "this object cannot be
    /// removed by any tool", into "the native call ran and changed nothing".
    /// </summary>
    private static readonly string[] LaneReasonCodes =
    {
        // placement
        "owned_object_placed",
        "place_owned_object_postcondition_unavailable",
        "place_owned_object_native_exception",
        "place_owned_object_not_owned_in_slot",
        "place_owned_object_unsupported_item",
        "place_owned_object_target_changed",
        "place_owned_object_tile_occupied",
        "place_owned_object_tile_not_placeable",
        // removal
        "placed_item_removed",
        "remove_placed_item_postcondition_unavailable",
        "remove_placed_item_native_exception",
        "remove_placed_item_target_not_found",
        "remove_placed_item_target_changed",
        "remove_placed_item_target_not_removable",
        "remove_placed_item_tool_not_equipped_in_requested_slot",
        "remove_placed_item_tool_not_axe_or_pickaxe",
        "remove_placed_item_tool_cannot_remove_target",
        "remove_placed_item_out_of_range",
        // containers
        "container_source_broken",
        "break_container_source_postcondition_unavailable",
        "break_container_source_native_exception",
        "break_container_source_target_not_found",
        "break_container_source_target_changed",
        "break_container_source_not_a_container",
        "break_container_source_tool_not_equipped_in_requested_slot",
        "break_container_source_tool_not_heavy_hitter",
        "break_container_source_out_of_range",
    };

    [Fact]
    public void Lane_RegistersEveryActionWithItsFamilyArgumentsPostconditionAndNativeBinding()
    {
        // This pin is EXPECTED RED until the lane's wiring manifest is applied: the three
        // actions are not in FarmhandActionCatalog yet, which is exactly what makes them
        // unreachable by any client. It is a registration pin, not a behavioural one, and
        // it must not be weakened to go green.
        foreach ((string actionId, string family, string postcondition, string nativeBinding, string[] arguments) in LaneActions)
        {
            FarmhandActionRegistration? registration = FarmhandActionCatalog.Registrations
                .SingleOrDefault(candidate => candidate.ActionId == actionId);
            registration.Should().NotBeNull($"{actionId} must be registered in the one Farmhand catalog");
            registration!.FamilyId.Should().Be(family);
            registration.Kind.Should().Be(FarmhandOperationKind.Execution);
            registration.Lifecycle.Should().Be(
                FarmhandActionLifecycle.LiveVerified,
                "these three passed their own native-local live gates on 2026-10-08, and that is the only thing which moves an action off the experimental surface");
            registration.Descriptor.Should().NotBeNull();
            registration.Descriptor!.Arguments.Select(argument => argument.Name).Should().Equal(arguments);
            registration.Descriptor.Postcondition.Should().Be(postcondition);
            registration.Descriptor.NativeBinding.Should().Be(nativeBinding);
        }
    }

    [Fact]
    public void Handler_SeparatesEveryFailureModeWithItsOwnTerminalCode()
    {
        string code = StripLineComments(ReadHandlerSource());
        foreach (string reasonCode in LaneReasonCodes)
            code.Should().Contain($"\"{reasonCode}\"", $"the lane must be able to report {reasonCode}");
    }

    [Fact]
    public void Handler_PlacesThroughTheNativeIngress_AndProvesTheObjectFromTheWorld()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string body = MethodBody(source, "public LocalExecutionReceipt RequestLocalPlaceOwnedObject(");
        string executed = MethodBody(source, "private LocalExecutionReceipt ExecutePlaceOwnedObject(");

        // The native ingress is Utility.tryToPlaceItem's own two halves.
        executed.Should().Contain("Utility.playerCanPlaceItemHere(location, source,");
        executed.Should().Contain("source.placementAction(location, targetX * 64 + 32, targetY * 64 + 32, Game1.player)");
        executed.Should().Contain("Game1.player.reduceActiveItemByOne()");

        // NEGATIVE: no selector and no synthesized input edge may appear — this action
        // drives the capability, never the input dispatcher.
        code.Should().NotContain("checkAction(");
        code.Should().NotContain("performAction(");
        code.Should().NotContain("didPlayerJustLeftClick");

        // The postcondition is the world, re-read after the call: the native branch adds a
        // COPY (never the inventory instance), so no reference comparison may decide it.
        int nativeCall = executed.IndexOf("source.placementAction(", StringComparison.Ordinal);
        int reRead = executed.IndexOf("location.objects.TryGetValue(tile, out StardewValley.Object? placed)", StringComparison.Ordinal);
        int decision = executed.IndexOf("bool succeeded = placementHandled && objectPresent && inventoryDecremented", StringComparison.Ordinal);
        nativeCall.Should().BeGreaterThanOrEqualTo(0, "the native seam must be the writer");
        reRead.Should().BeGreaterThan(nativeCall, "the placed object must be re-read after the native call");
        decision.Should().BeGreaterThan(reRead, "success must be decided after the re-read");
        executed.Should().NotContain("ReferenceEquals(source,");
        executed.Should().NotContain("ReferenceEquals(placed,");

        // Design 5.2: a thin request path plus ONE execution body reached by both the
        // in-range path and the approach leg.
        body.Should().Contain("TryBeginToolApproach(");
        body.Should().Contain("this.ExecutePlaceOwnedObject(arrivalExecutionId, arrivalRequestId");
        body.Should().Contain("return this.ExecutePlaceOwnedObject(executionId, requestId");
        body.Should().Contain("IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1)");
    }

    [Fact]
    public void Handler_RemovesWithTheNamedSeamTool_AndRefusesEveryWrongToolByName()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string body = MethodBody(source, "public LocalExecutionReceipt RequestLocalRemovePlacedItem(");
        string executed = MethodBody(source, "private LocalExecutionReceipt ExecuteRemovePlacedItem(");

        // The swing goes through the one shared native tool boundary, so the seam really is
        // the tool's DoFunction and not a Mod-side object edit.
        executed.Should().Contain("UseNativeToolOnTile(tool!, location, targetX, targetY, Game1.player, staminaBefore)");

        // NEGATIVE: the action must never reach performToolAction/performRemoveAction itself
        // or delete the object by hand — those are the seam's own steps, owned by the game.
        code.Should().NotContain("performToolAction(");
        code.Should().NotContain("performRemoveAction(");
        code.Should().NotContain("objects.Remove(");

        // The named slot must really hold the equipped seam tool, and the object must really
        // be removable by it: two separate questions, two separate terminal codes. The
        // 2026-10-06 break_rock_source regression (a missing CurrentToolIndex check) is why
        // the equipped-slot half is asserted explicitly.
        code.Should().Contain("Game1.player.CurrentToolIndex != slot");
        code.Should().Contain("ReferenceEquals(Game1.player.CurrentTool, candidate)");
        code.Should().Contain("\"remove_placed_item_tool_not_axe_or_pickaxe\"");
        executed.Should().Contain("\"remove_placed_item_tool_cannot_remove_target\"");
        executed.Should().Contain("\"remove_placed_item_target_not_removable\"");

        // The postcondition is the object being GONE, re-read from the world.
        int nativeCall = executed.IndexOf("UseNativeToolOnTile(tool!", StringComparison.Ordinal);
        int reRead = executed.IndexOf("bool removed = !location.objects.TryGetValue(tile,", StringComparison.Ordinal);
        int success = executed.IndexOf("\"placed_item_removed\"", StringComparison.Ordinal);
        nativeCall.Should().BeGreaterThanOrEqualTo(0, "the native swing must be the writer");
        reRead.Should().BeGreaterThan(nativeCall, "the tile must be re-read after the swing");
        success.Should().BeGreaterThan(reRead, "success must be decided after the re-read");

        body.Should().Contain("TryBeginToolApproach(");
        body.Should().Contain("return this.ExecuteRemovePlacedItem(executionId, requestId");
    }

    [Fact]
    public void Handler_BreaksContainersOnTheirObservedPostcondition_NotOnTheNativeReturn()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string executed = MethodBody(source, "private LocalExecutionReceipt ExecuteBreakContainerSource(");

        executed.Should().Contain("UseNativeToolOnTile(tool!, location, targetX, targetY, Game1.player, staminaBefore)");
        executed.Should().Contain("bool gone = !location.objects.TryGetValue(tile,");
        executed.Should().Contain("\"container_source_broken\"");
        executed.Should().Contain("\"break_container_source_postcondition_unavailable\"");
        // The drops are observed where the game really puts them, filtered to item drops so
        // the cosmetic radial chunks cannot be mistaken for them.
        executed.Should().Contain("ItemDropDebrisSince(location, debrisBefore)");
        code.Should().Contain("!string.IsNullOrEmpty(debris?.itemId.Value)");
        // A container is this action's subject only when it IS one, and the tool must satisfy
        // the seam's own precondition rather than a Mod list.
        executed.Should().Contain("probe is not BreakableContainer");
        code.Should().Contain("\"break_container_source_tool_not_heavy_hitter\"");
        code.Should().Contain("candidate.isHeavyHitter()");
    }

    [Fact]
    public void Handler_KeepsNoContentList_SoAModOrFurnitureObjectWorksToo()
    {
        // Requirement: whatever the lane advertises must come from the game's own data, not
        // from an item-id list in this Mod. The handler therefore carries no qualified item
        // id literal at all — the placeability question is `Utility.playerCanPlaceItemHere`
        // plus the item's own `canBePlacedHere`, and the removability question is the native
        // branch's own guards.
        string code = StripLineComments(ReadHandlerSource());
        code.Should().NotContain("(BC)");
        code.Should().NotContain("(O)");
        code.Should().NotContain("(T)");
        code.Should().Contain("owned.canBePlacedHere(location, tile)");
        code.Should().Contain("candidate.bigCraftable.Value && candidate is not Furniture");
        code.Should().Contain("target.IsTwig()");
        code.Should().Contain("Contains(\"SupplyCrate\", StringComparison.Ordinal)");
    }

    [Fact]
    public void Fixture_EstablishesOnlyTheDeclaredGivens_AndNeverCallsAnAction()
    {
        string fixture = ReadRepositoryFile(Path.Combine("integrations", "stardew", FixtureFile));
        // The fixture's prose legitimately names the seams it does NOT call, so the negative
        // pins read code only — exactly as the handler pins do.
        string code = StripLineComments(fixture);

        // No action is called, no receipt is minted, no postcondition is claimed.
        code.Should().NotContain("RequestLocal");
        code.Should().NotContain("new LocalExecutionReceipt");
        code.Should().NotContain("placementAction");
        code.Should().NotContain("performToolAction");

        // Each Given is asserted loudly with a named failure, and the two facts the native
        // removal branch reads are asserted rather than assumed.
        fixture.Should().Contain("fixture_native_local_world_object_tiles_missing");
        fixture.Should().Contain("fixture_native_local_world_object_tree_not_tappable");
        fixture.Should().Contain("fixture_native_local_world_object_tapper_missing_after_add");
        fixture.Should().Contain("fixture_native_local_world_object_placed_item_missing_after_add");
        fixture.Should().Contain("fixture_native_local_world_object_container_missing_after_add");
        fixture.Should().Contain("fixture_native_local_world_object_twig_missing");
        fixture.Should().Contain("placed.Type != \"Crafting\" || placed.Fragility == 2");
        fixture.Should().Contain("!twig.IsTwig()");
        fixture.Should().Contain("nativeLocalPlayerFixtureInitialized = true");
    }

    [Fact]
    public void Runner_FilesExistAndUseTheTestLoaderAndAcceptEitherReceiptShape()
    {
        foreach (string runnerFile in RunnerFiles)
        {
            string runner = ReadRepositoryFile(Path.Combine("tools", runnerFile));
            // The production Host generation is unavailable here; omitting the test loader
            // fails before the game is ever reached.
            runner.Should().Contain("loadModule: loadHostTestModule");
            // The native work can settle inside the request, so the immediate response may BE
            // the terminal: the runner must accept either shape and then assert the terminal.
            runner.Should().Contain("waitForTerminal(receipts, accepted, terminalTimeoutMs)");
            runner.Should().NotContain("accepted.state !== \"accepted\"");
            // Loose optional-member comparison: the Mod omits null members, so an absent
            // member arrives as undefined and `undefined !== null` would fail a correct run.
            runner.Should().Contain("== null");
            // Failure messages carry the observed facts, never a clause name alone.
            runner.Should().Contain("describeCandidates(");
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
