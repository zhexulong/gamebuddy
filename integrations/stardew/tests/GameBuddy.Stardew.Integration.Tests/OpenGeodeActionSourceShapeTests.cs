using System;
using System.IO;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// <c>open_geode</c> contract pins: the menu lifecycle, the two engine outcomes and the refusals.
///
/// SEAM DECISION, and the reason this file pins SOURCE. The subject is <c>GeodeMenu</c>
/// (Menus/GeodeMenu.cs): the geode is the CURSOR item (:133 <c>Utility.IsGeode(base.heldItem)</c>), the
/// smash is <c>startGeodeCrack</c> (:102-119, fee <c>Game1.player.Money -= 25</c>, timer 2700), the
/// treasure is minted inside the menu's own <c>update</c> when Clint's animation reaches frame 11
/// (:373-385) and delivered when the timer expires (:222-236 <c>addItemToInventoryBool(geodeTreasure)</c>).
/// None of that can be executed in a headless runner - it needs the live game thread, a loaded content
/// set and a real farmer - so the lifecycle, the ordering constraints and the NEGATIVE claims (what this
/// body must NOT re-implement) are asserted on the handler source, while the registration side is
/// asserted against the real catalog objects. The live numbers belong to a live gate, which this lane
/// deliberately did not run.
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the registration pins read the real catalog objects; keeping both in one file keeps each pin beside the behaviour it protects.
[Trait("kind", "source-shape")]
public sealed class OpenGeodeActionSourceShapeTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.geodeactions.cs";
    private const string ExecuteDeclaration = "private LocalExecutionReceipt ExecuteOpenGeode(";
    private const string CrackDeclaration = "private LocalExecutionReceipt CrackGeode(";
    private const string PumpLoopDeclaration = "while (menu.geodeAnimationTimer > 0";

    /// <summary>
    /// The menu is opened, loaded, clicked and closed through its own members, in the one order the
    /// native class allows. The pick-up is a RIGHT click: <c>InventoryMenu.rightClick</c> takes exactly
    /// one unit (InventoryMenu.cs:405-424), which is what makes <c>readyToClose</c> reachable afterwards
    /// (:84-91 requires <c>heldItem == null</c>); a left click would take the whole stack and leave the
    /// menu unable to close.
    /// </summary>
    [Fact]
    public void Handler_DrivesTheGamesOwnMenuThroughItsOwnClicks()
    {
        string source = ReadHandlerSource();
        string executed = MethodBody(source, ExecuteDeclaration);
        string cracked = MethodBody(source, CrackDeclaration);

        executed.Should().Contain("answerDialogueAction(\"Blacksmith_Process\"",
            "the native open is the blacksmith counter's own answer (GameLocation.cs:12345-12346), so the location "
                + "constructs the menu rather than this body");
        executed.Should().Contain("menu.receiveRightClick(",
            "the geode reaches the anvil as the CURSOR item, one unit at a time");
        cracked.Should().Contain("menu.receiveLeftClick(spotCenter.X, spotCenter.Y, playSound: true);",
            "the smash is the menu's own click handler at the spot's own coordinates");
        cracked.Should().Contain("menu.update(new GameTime(",
            "the treasure only exists after the menu's own update advances the animation and the timer");
        cracked.Should().Contain("CloseGeodeMenu(menu)");
        source.Should().Contain("Game1.exitActiveMenu();", "the close is the native step, not a hand-rolled teardown");
    }

    /// <summary>
    /// NEGATIVE, and the point of the whole seam: the drop table, the fee and the delivery belong to the
    /// engine. A body that reproduced any of them would be a second spelling of a fact the game owns, and
    /// the first balance patch would silently disagree with it.
    /// </summary>
    [Fact]
    public void Handler_NeverReimplementsTheDropTableFeeOrDelivery()
    {
        string code = StripLineComments(ReadHandlerSource());

        code.Should().NotContain("getTreasureFromGeode", "the drop table is the engine's");
        code.Should().NotContain("addItemToInventoryBool", "the delivery is the menu's own exit branch");
        code.Should().NotContain("ItemRegistry.Create", "the result is minted by the engine, never by this body");
        code.Should().NotContain("Money -", "the fee is taken by startGeodeCrack, not by this body");
        code.Should().NotContain("geodeSpot.item", "the spot's own item is the menu's private bookkeeping");
    }

    /// <summary>
    /// The pump is what makes the result exist, so its step size is a correctness requirement: a single
    /// large step would expire the timer on an animation that never reached frame 11 and the engine would
    /// deliver nothing. The "before" count for the delivery is read BEFORE the update that delivers.
    /// </summary>
    [Fact]
    public void Handler_PumpsTheMenuAtFrameSizedSteps_AndSnapshotsTheResultFirst()
    {
        string source = ReadHandlerSource();
        string loop = MethodBody(source, PumpLoopDeclaration);

        source.Should().Contain("internal const int GeodeAnimationStepMs = 16;",
            "one frame at the engine's own 60 Hz step");
        source.Should().Contain("internal const int GeodeAnimationPumpCeilingMs = 15000;",
            "a suspension must be reported, not looped forever");

        int snapshot = loop.IndexOf("treasureOwnedBeforeDelivery = player.Items.CountId(treasureItemId);", StringComparison.Ordinal);
        int update = loop.IndexOf("menu.update(", StringComparison.Ordinal);
        snapshot.Should().BeGreaterThanOrEqualTo(0, "the delivery count needs a before");
        update.Should().BeGreaterThan(snapshot, "the snapshot must be taken before the update that delivers");

        string cracked = MethodBody(source, CrackDeclaration);
        cracked.Should().Contain("if (!crackSettled)");
        cracked.Should().Contain("ExecutionState.Uncertain", "a crack that never settled is unknown, not empty");
    }

    /// <summary>
    /// The modal this action opens is its own. The owner lease is taken before the menu exists and released
    /// after it is gone, exactly as the mine exit does; without it the world-change arbitration reads the
    /// menu as an external interruption of the action that opened it
    /// (farmhandexecutioncontroller.cs:1956-1970).
    /// </summary>
    [Fact]
    public void Handler_OwnsTheModalItOpens_AndReleasesTheLeaseInAFinally()
    {
        string executed = MethodBody(ReadHandlerSource(), ExecuteDeclaration);

        int register = executed.IndexOf("this.RegisterModalOwner(executionId);", StringComparison.Ordinal);
        int open = executed.IndexOf("answerDialogueAction(", StringComparison.Ordinal);
        int release = executed.IndexOf("this.ReleaseModalOwner(executionId);", StringComparison.Ordinal);

        register.Should().BeGreaterThanOrEqualTo(0);
        register.Should().BeLessThan(open, "the lease must exist before the menu does");
        release.Should().BeGreaterThan(open, "the lease is released only after the menu work ends");
        executed.Should().Contain("finally");
    }

    /// <summary>
    /// BOTH engine outcomes, and the empty one is never success-with-empty: a consumed geode the menu
    /// minted nothing for is its own visible terminal, naming what is missing.
    /// </summary>
    [Fact]
    public void Handler_ReportsBothEngineOutcomes_AndNeverSuccessWithAnEmptyResult()
    {
        string cracked = MethodBody(ReadHandlerSource(), CrackDeclaration);

        cracked.Should().Contain("if (treasureItemId is null)");
        cracked.Should().Contain("reason=treasure_not_minted",
            "consumed-with-nothing-to-show must say which half is missing");
        cracked.Should().Contain("if (delivered <= 0)");
        cracked.Should().Contain("reason=result_not_delivered");
        cracked.Should().Contain("ExecutionState.PartiallySucceeded",
            "a pack that took part of the result stack is neither a full success nor a loss");
        cracked.Should().Contain("\"geode_result_partially_delivered\"");

        // Success requires the WHOLE conjunction, so a delivered treasure with a geode still in the pack
        // cannot be reported as an opening.
        cracked.Should().Contain("if (geodeOwnedAfter == geodeOwnedBefore - 1 && feeTaken == GeodeProcessingFee)");
        cracked.Should().Contain("\"geode_opened\"");
        cracked.Should().Contain("reason=world_disagrees_with_menu");
    }

    /// <summary>
    /// Every refusal names its own live fact, and the postcondition read happens AFTER the close, because
    /// "no menu is open" is half of it.
    /// </summary>
    [Fact]
    public void Handler_NamesEveryRefusal_AndClosesBeforeReadingThePostcondition()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string cracked = MethodBody(source, CrackDeclaration);

        foreach (string reason in new[]
                 {
                     "geode_not_owned",
                     "geode_spot_not_reached",
                     "geode_menu_not_opened",
                     "geode_result_not_observed",
                     "menu_left_open",
                 })
        {
            code.Should().Contain($"\"{reason}\"", $"{reason} is a declared terminal of this action");
        }

        // The two facts that stop the native click from starting the crack are read from the menu's own
        // refusal state instead of being re-derived here.
        code.Should().Contain("menu.alertTimer > 0");
        code.Should().Contain("Game1.dayTimeMoneyBox?.moneyShakeTimer");
        code.Should().Contain("\"geode_smash_not_started\"");

        int close = cracked.IndexOf("bool menuClosed = CloseGeodeMenu(menu);", StringComparison.Ordinal);
        int read = cracked.IndexOf("int geodeOwnedAfter = player.Items.CountId(geodeItemId);", StringComparison.Ordinal);
        close.Should().BeGreaterThanOrEqualTo(0);
        read.Should().BeGreaterThan(close, "the postcondition is read after the menu is gone");

        // The admission is the engine's own counter seam, not a bare distance: the map's counter tile, the blacksmith
        // in the room's character list, and the two spatial conditions the counter case applies.
        string counter = MethodBody(source, "internal static bool TryLocateGeodeCounter(");
        counter.Should().Contain("FindGeodeCounterTiles(", "the counter tile is read out of the map");
        counter.Should().Contain("GeodeCounterOwnerName");
        counter.Should().Contain("IsWithinRangeOfRequest(", "the reach on that tile is the engine's own call");
        counter.Should().Contain("player.TilePoint.Y > counter.Y", "the counter case runs only from below it (:9874)");
        counter.Should().NotContain("GeodeCounterInteractionRadius", "no radius of ours may gate the counter");
        counter.Should().NotContain("owner.TilePoint", "the blacksmith's tile is not what has to be reached");
    }

    /// <summary>
    /// The registration side, on the real objects: the catalog owns membership and the wire list owns the
    /// arguments, and this action is Experimental because no live game was run for it.
    /// </summary>
    [Fact]
    public void Action_IsRegisteredWithTheGeodeSlotAndItsItemId()
    {
        var registration = Core.Policy.FarmhandActionCatalog.Registrations
            .Should().ContainSingle(entry => entry.ActionId == "open_geode").Subject;

        registration.Lifecycle.Should().Be(Core.Policy.FarmhandActionLifecycle.Experimental);
        registration.HandlerGroup.Should().Be(Core.Policy.FarmhandActionHandlerGroup.ResourceTools);
        registration.Descriptor!.Arguments.Select(argument => argument.Name)
            .Should().Equal("slot", "expectedQualifiedItemId");
        registration.Descriptor.NativeBinding.Should().Be("GeodeMenu.receiveLeftClick");

        string handler = ReadRepositoryFile(Path.Combine("integrations", "stardew", "Handlers", "ResourceToolActionHandler.cs"));
        handler.Should().Contain("\"open_geode\" => this.executions.RequestLocalOpenGeode(");
        handler.Should().Contain("request.Args.ExpectedQualifiedItemId");
    }

    /// <summary>
    /// The Host's own wire contract, so the Mod's argument set and the Host's parser cannot drift: the
    /// action is in the request union, in both admission whitelists, in the per-action argument switch and
    /// in the published schema, with the same two names.
    /// </summary>
    [Fact]
    public void HostWire_AcceptsTheSameArgumentSet()
    {
        string protocol = ReadRepositoryFile(Path.Combine("host", "src", "protocol.ts"));
        protocol.Should().Contain("| \"open_geode\"");
        protocol.Should().Contain("value.action !== \"open_geode\" &&");
        protocol.Should().Contain("value.action === \"open_geode\" ||");
        protocol.Should().Contain("if (!hasExactKeys(value.args, [\"slot\", \"expectedQualifiedItemId\"])) return \"invalid_execution_request\";");

        string schema = ReadRepositoryFile(Path.Combine("protocol", "bridge-v1.schema.json"));
        schema.Should().Contain("\"open_geode\"", "the published action enum must name it");
        schema.Should().Contain("\"openGeodeArgs\"");
        schema.Should().Contain("\"const\": \"open_geode\"", "the args schema is selected by the action value");
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

    private static string ReadHandlerSource() => ReadRepositoryFile(Path.Combine("integrations", "stardew", HandlerFile));

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
