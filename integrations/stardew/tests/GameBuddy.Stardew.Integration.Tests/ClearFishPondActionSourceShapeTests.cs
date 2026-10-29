using System;
using System.IO;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// clear_fish_pond contract pins, for the action whose boundary card is
/// <c>design/tasks/active/cards/card-clear-fish-pond-boundary.md</c>.
///
/// SEAM DECISION. The clearing is <c>FishPond.ClearPond()</c> (Buildings/FishPond.cs:840) — public,
/// argument-free, and reached in-game only through the pond menu's two-click confirmation
/// (<c>PondQueryMenu.cs:161-170</c> sets <c>confirmingEmpty</c>, <c>:130-137</c> consumes it). That
/// confirmation is UI-only state with no game-logic fork, so this action calls the settlement and
/// never the input dispatcher — the same principle as <c>ride_minecart</c> (MinecartWarp) and
/// <c>toggle_animal_door</c> (Building.ToggleAnimalDoor).
///
/// WHAT THIS FILE PINS, and why these are the assertions worth having: the seam call, the ABSENCE of
/// every menu-driving or input path, the one-execution-body shape, the reach rule, the argument triple,
/// and the honest terminal when the world does not change. The native clearing itself, the ejected
/// debris and the stale-target negatives belong to the native-local fixture gate.
/// </summary>
[Trait("kind", "source-shape")]
public sealed class ClearFishPondActionSourceShapeTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.pondactions.cs";

    private static readonly string[] ClearFishPondReasonCodes =
    {
        "fish_pond_cleared",
        "clear_fish_pond_postcondition_unavailable",
        "pond_target_unavailable",
        "pond_target_moved",
        "pond_target_location_mismatch",
        "pond_under_construction",
        "pond_already_empty",
    };

    [Fact]
    public void Handler_ClearsThroughThePublicNativeSeam_AndNeverDrivesTheMenu()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string executed = MethodBody(source, "private LocalExecutionReceipt ExecuteClearFishPond(");

        foreach (string reasonCode in ClearFishPondReasonCodes)
            code.Should().Contain($"\"{reasonCode}\"", $"the action must be able to report {reasonCode}");

        // The seam is the public UI-free settlement, called on the game thread.
        executed.Should().Contain("pond.ClearPond()");

        // NEGATIVE: none of the menu path, the input path or the click flow may appear in CODE
        // (the header names what it does not call, so scanning the raw file would flag prose).
        code.Should().NotContain("PondQueryMenu");
        code.Should().NotContain("confirmingEmpty");
        code.Should().NotContain("exitThisMenu");
        code.Should().NotContain("receiveLeftClick");
        code.Should().NotContain("yesButton");
        code.Should().NotContain("didPlayerJustRightClick");
        code.Should().NotContain("performAction(");
        code.Should().NotContain("checkAction(");
        code.Should().NotContain("doAction");

        // The fish are the native body's business, not ours: if this handler spawned debris itself
        // it would be double-ejecting, and a receipt that claimed a loss would be inventing one.
        code.Should().NotContain("createItemDebris");
        code.Should().NotContain("removeItemFromInventory");
    }

    [Fact]
    public void Handler_HasOneExecutionBody_ReachedFromBothPaths()
    {
        string source = ReadHandlerSource();
        string request = MethodBody(source, "public LocalExecutionReceipt RequestLocalClearFishPond(");

        // Design 5.2: a thin request path (admission, target, geometry, then either an approach leg or
        // the shared body) and ONE execution body, so a walk cannot run a second copy of the contract.
        request.Should().Contain("TryBeginBuildingApproach(");
        request.Should().Contain("this.ExecuteClearFishPond(arrivalExecutionId, arrivalRequestId");
        request.Should().Contain("return this.ExecuteClearFishPond(executionId, requestId");

        // Reach is the shared building-contact rule of the resolved pond, the same rule the silo
        // half of the facility family admits on. The published tile is the human-door point, and a
        // pond declares no human door (HumanDoor = (-1,-1) in Data/Buildings), so measuring reach
        // against it would admit only an actor in the pond's north-west quadrant.
        request.Should().Contain("IsWithinBuildingContact(resolution.Building!, Game1.player)");

        // The seam takes no tool, no slot and no held item, so this action must not have grown any.
        string code = StripLineComments(source);
        code.Should().NotContain("args.Slot");
        code.Should().NotContain("CurrentToolIndex");
        code.Should().NotContain("beginUsing");
    }

    [Fact]
    public void Handler_ReadsThePostconditionOffThePond_AndIsUncertainWhenNothingChanged()
    {
        string source = ReadHandlerSource();
        string executed = MethodBody(source, "private LocalExecutionReceipt ExecuteClearFishPond(");

        // The decision is the POND INSTANCE after the call, never "we called the function": both
        // halves of the card's postcondition, plus the corroborating fields.
        executed.Should().Contain("pond.currentOccupants.Value");
        executed.Should().Contain("pond.fishType.Value");
        executed.Should().Contain("occupantsAfter == 0 && fishTypeAfter is null");
        executed.Should().Contain("pond.daysSinceSpawn.Value");
        executed.Should().Contain("pond.lastUnlockedPopulationGate.Value");
        executed.Should().Contain("pond.goldenAnimalCracker.Value");

        // The seam is `void` and cannot refuse, so a pond that is still occupied afterwards must be
        // Uncertain — never a success, and never a silent retry.
        executed.Should().Contain("ExecutionState.Uncertain");
        executed.Should().Contain("\"clear_fish_pond_postcondition_unavailable\"");
        executed.Should().Contain("fish_ejected");
    }

    [Fact]
    public void Handler_RefusesBeforeTheSeam_ForEveryTargetFact()
    {
        string source = ReadHandlerSource();
        string resolve = MethodBody(source, "private static FishPondTargetResolution ResolveFishPondTarget(");

        // Each refusal is decided from a LIVE read, and the stale-target case is an equality check
        // against the id discovery published rather than a re-target.
        resolve.Should().Contain("pond_target_unavailable");
        resolve.Should().Contain("pond_target_moved");
        resolve.Should().Contain("pond_target_location_mismatch");
        resolve.Should().Contain("pond_under_construction");
        resolve.Should().Contain("pond_already_empty");
        resolve.Should().Contain("GetParentLocation()");
        resolve.Should().Contain("string.Equals(liveId, expectedTargetId, StringComparison.Ordinal)");

        // The building is resolved by its HUMAN DOOR tile, the canonical anchor the facility family
        // publishes, so one pond has one interaction tile across every action that names it.
        resolve.Should().Contain("getPointForHumanDoor()");
    }

    [Fact]
    public void Action_IsRegisteredWithTheFrozenArgumentTriple()
    {
        string definitions = ReadRepositoryFile(Path.Combine("integrations", "stardew", "src", "Core", "Policy", "FarmhandActionDefinitions.cs"));
        definitions.Should().Contain("\"clear_fish_pond\"");
        definitions.Should().Contain("\"fish_pond_cleared\"", "the descriptor's terminal must be the code the handler mints");
        definitions.Should().Contain("FishPond.ClearPond", "the descriptor's seam field must name the settlement");

        // x/y/expectedTargetId: the shared building-target triple, so no new argument machinery exists.
        int at = definitions.IndexOf("\"clear_fish_pond\"", StringComparison.Ordinal);
        string entry = definitions[at..Math.Min(definitions.Length, at + 700)];
        entry.Should().Contain("\"x\"");
        entry.Should().Contain("\"y\"");
        entry.Should().Contain("\"expectedTargetId\"");

        string protocol = ReadRepositoryFile(Path.Combine("integrations", "stardew", "src", "Core", "Protocol", "BridgeProtocol.cs"));
        protocol.Should().Contain("\"clear_fish_pond\" => new[] { \"x\", \"y\", \"expectedTargetId\" }",
            "the wire argument-name list is what the parser reads before any handler sees the request");

        string router = ReadRepositoryFile(Path.Combine("integrations", "stardew", "Handlers", "ResourceToolActionHandler.cs"));
        router.Should().Contain("\"clear_fish_pond\" => this.executions.RequestLocalClearFishPond(");
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
