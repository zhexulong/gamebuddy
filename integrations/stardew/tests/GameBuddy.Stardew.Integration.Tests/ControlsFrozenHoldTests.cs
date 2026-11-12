using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using Netcode;
using StardewValley;
using StardewValley.Events;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE GATE FOR THE <c>ControlsFrozen</c> FACT: the engine's control freeze is a fact read from the engine's own flag
/// (<c>Game1.freezeControls</c>) and cleared by the engine's own release, and a freeze that can no longer be left is a
/// defect rather than a state we tolerate.
///
/// <para>
/// WHY THIS FAMILY FOURTH. Two native sites hold the body for a bus ride and leave no other declared fact up
/// (boundary: <c>.tmp/boundary-controls-frozen.md</c>, from the residual in <c>.tmp/boundary-card-actor-holds.md</c>
/// §2 rows 12 and 13). The flag is not a <c>CanMove</c> write: while it is up the engine does not poll the player's
/// controls at all - <c>UpdateControlInput</c> runs only when <c>!globalFade &amp;&amp; !freezeControls &amp;&amp;
/// activeClickableMenu == null</c> (<c>Game1.cs:4286</c>) - and <c>shouldTimePass()</c> returns false for it
/// (<c>:9295</c>), so the clock stops too.
/// </para>
///
/// <para>
/// WHAT MAKES THE RELEASE TRUSTWORTHY. The freeze is cleared by the engine's universal body release,
/// <c>Farmer.forceCanMove()</c>, in the same method that gives <c>CanMove</c>, <c>freezePause</c> and the animation
/// pause back (<c>Farmer.cs:7090-7105</c>). The bus paths reach it from <c>doorOpenAfterReturn</c> once the door has
/// opened on arrival (<c>BusStop.cs:296</c>, <c>Desert.cs:446</c>) - the DEPARTING side's freeze is released by the
/// ARRIVING side's door, so neither handler is tied to one site here and both must still call it.
/// </para>
///
/// <para>
/// THE POPULATION IS PRINTED, and an unreadable tree is a failure rather than a silent pass: the sites are read out of
/// the decompiled source at their own declarations, so a moved site is a finding, never an omission.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the release half is a pin because the bus ride cannot run in a headless runner and is the premise the fact depends on, while the hold half drives the real ReadFacts path on a probe actor.
public sealed class ControlsFrozenHoldTests
{
    private const string Fact = "ControlsFrozen";

    private const string BusStopFile = "StardewValley.Locations/BusStop.cs";

    private const string DesertFile = "StardewValley.Locations/Desert.cs";

    private const string FarmerFile = "StardewValley/Farmer.cs";

    /// <summary>The drive loop that re-asserts <c>CanMove = false</c> every tick while the bus is moving (<c>BusStop.cs:309-323</c>).</summary>
    private const string BusDriveLoop = "public override void UpdateWhenCurrentLocation(GameTime time)";

    /// <summary>The bus starting its way back in, which raises the same freeze (<c>BusStop.cs:260-269</c>).</summary>
    private const string BusDriveBack = "public void busDriveBack()";

    /// <summary>The valley side's ticket answer, where the walk to the bus starts with a freeze (<c>BusStop.cs:132-148</c>).</summary>
    private const string BusDepart = "public override bool answerDialogue(Response answer)";

    /// <summary>The desert side's drop-off: the question is answered, then the body is taken (<c>Desert.cs:112-120</c>).</summary>
    private const string DesertBusDoor = "private void playerReachedBusDoor(Character c, GameLocation l)";

    /// <summary>Both doors open through this one, on arrival (<c>BusStop.cs:283-300</c>, <c>Desert.cs:432-450</c>).</summary>
    private const string DoorOpened = "private void doorOpenAfterReturn(int extraInfo)";

    /// <summary>The engine's universal body release, which is the only writer of <c>freezeControls = false</c> on this path (<c>Farmer.cs:7090-7105</c>).</summary>
    private const string ForceCanMove = "public void forceCanMove()";

    /// <summary>
    /// The sites the boundary card names, each with the engine path that keeps the body on its way through the ride.
    /// A hop that moved or was deleted is reported against the site rather than silently dropped.
    /// </summary>
    private static readonly (string Site, (string File, string Declaration, string Contains)[] Path)[] Sites =
    {
        ("BusStop.cs:316", new[]
        {
            (BusStopFile, BusDriveLoop, "drivingBack || drivingOff"),
            (BusStopFile, BusDriveLoop, "Game1.player.CanMove = false;"),
            (BusStopFile, BusDriveBack, "Game1.freezeControls = true;"),
            (BusStopFile, BusDepart, "Game1.freezeControls = true;"),
        }),
        ("Desert.cs:117", new[]
        {
            (DesertFile, DesertBusDoor, "Game1.freezeControls = true;"),
            (DesertFile, DesertBusDoor, "Game1.player.CanMove = false;"),
        }),
    };

    /// <summary>
    /// The engine's own writes that end the fact. The freeze itself is cleared inside <c>forceCanMove</c>, beside the
    /// three other flags it gives back - a body that got <c>CanMove</c> but kept the control freeze is still a body no
    /// input reaches, so both halves are required - and both arrival doors must still call it.
    /// </summary>
    private static readonly (string File, string Declaration, string Contains)[] Releases =
    {
        (FarmerFile, ForceCanMove, "Game1.freezeControls = false;"),
        (FarmerFile, ForceCanMove, "CanMove = true;"),
        (BusStopFile, DoorOpened, "Game1.player.forceCanMove();"),
        (DesertFile, DoorOpened, "Game1.player.forceCanMove();"),
    };

    [Fact]
    public void EverySiteThatTakesTheBodyForAControlFreezeIsReleasedByTheEnginesOwnBodyRelease()
    {
        var findings = new List<string>();

        foreach ((string site, (string File, string Declaration, string Contains)[] path) in Sites)
        {
            bool entered = path.All(hop => DecompiledSource
                .Code(DecompiledSource.MethodBody(DecompiledSource.Lines(hop.File), hop.Declaration))
                .Any(text => text.Contains(hop.Contains, StringComparison.Ordinal)));
            if (!entered)
                findings.Add($"hold_entry_not_found:{site}:{Fact}");
        }

        foreach ((string file, string declaration, string contains) in Releases)
        {
            bool released = DecompiledSource
                .Code(DecompiledSource.MethodBody(DecompiledSource.Lines(file), declaration))
                .Any(text => text.Contains(contains, StringComparison.Ordinal));
            if (released)
                continue;

            foreach ((string site, _) in Sites)
                findings.Add($"hold_entered_without_release:{site}:{Fact}");
            findings.Add($"hold_release_missing:{file}:{DecompiledSource.MethodName(declaration)}:{Fact}");
        }

        Sites.Should().NotBeEmpty($"the control-freeze sites are read from the two bus locations, and this gate checked none");
        findings.Should().BeEmpty(
            $"every site that takes the body for a control freeze must still reach the engine's own release - "
            + $"`Farmer.forceCanMove` clearing `freezeControls` beside `CanMove`, called from the door that opens on "
            + $"arrival; examined {Sites.Length} site(s): "
            + string.Join(", ", Sites.Select(site => site.Site))
            + $"; findings: {string.Join(", ", findings)}");
    }

    [Fact]
    public void TheFactIsTheEnginesOwnFreezeAndClearsOnTheEnginesOwnRelease()
    {
        Farmer actor = CreateActor();

        RunWithGameState(() =>
        {
            SetFreezeControls(true);
            WorldModel.ReadFacts(actor).ControlsFrozen.Should().BeTrue(
                "the engine is withholding control input: `freezeControls` is raised by the bus and by pauseThenDoFunction");

            // The engine's release: Farmer.forceCanMove writes `Game1.freezeControls = false;` (Farmer.cs:7096). Nothing
            // else in the world changes.
            SetFreezeControls(false);
            WorldModel.ReadFacts(actor).ControlsFrozen.Should().BeFalse(
                "the fact clears on the engine's own release, not on a duration of ours");
            WorldModel.Classify(WorldModel.ReadFacts(actor)).Kind.Should().Be(ActorDispositionKind.Idle);
        });
    }

    [Fact]
    public void TheFreezeHoldsTheBodyWithCanMoveStillTrue()
    {
        // `pauseThenDoFunction` raises the freeze with no `CanMove` write anywhere near it (Game1.cs:3925-3933), and the
        // engine's own guard (:4286) is what makes that a hold: the controls are not polled at all.
        Farmer actor = CreateActor(canMove: true);

        RunWithGameState(() =>
        {
            SetFreezeControls(true);
            WorldModel.ReadFacts(actor).ControlsFrozen.Should().BeTrue(
                "the flag is the hold, not the CanMove write the bus happens to make beside it");
        });
    }

    /// <summary>
    /// A probe farmer whose no other fact is up. The sprite and the NetFields are the ones <c>ReadFacts</c> dereferences.
    /// </summary>
    private static Farmer CreateActor(bool canMove = false)
    {
        Farmer actor = (Farmer)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(Farmer));
        actor.CanMove = canMove;
        actor.freezePause = 0;
        Seed(actor, "usingTool", new NetBool(false));
        Seed(actor, "netStamina", new NetFloat(270f));
        Seed(actor, "toolPower", new NetInt(0));
        ProbeFarmerSprite.Attach(actor);
        return actor;
    }

    private static void Seed(Farmer actor, string field, object value) =>
        typeof(Farmer)
            .GetField(field, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, value);

    /// <summary>The engine's own flag, which the case moves exactly as <c>forceCanMove</c> does.</summary>
    private static void SetFreezeControls(bool frozen) => Game1.freezeControls = frozen;

    /// <summary>The Game1 statics <c>ReadFacts</c> reads, saved and restored around the probe (the suite convention).</summary>
    private static void RunWithGameState(Action action)
    {
        FieldInfo menuField = typeof(Game1).GetField(
            "_activeClickableMenu",
            BindingFlags.NonPublic | BindingFlags.Static)!;
        FieldInfo warpingField = typeof(Game1).GetField("_isWarping", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? menuBefore = menuField.GetValue(null);
        object? warpingBefore = warpingField.GetValue(null);
        bool eventUpBefore = Game1.eventUp;
        int timeOfDayBefore = Game1.timeOfDay;
        bool newDayBefore = Game1.newDay;
        FarmEvent? farmEventBefore = Game1.farmEvent;
        bool freezeControlsBefore = Game1.freezeControls;
        try
        {
            menuField.SetValue(null, null);
            warpingField.SetValue(null, false);
            Game1.eventUp = false;
            Game1.timeOfDay = 600;
            Game1.newDay = false;
            Game1.farmEvent = null!;
            SetFreezeControls(false);
            action();
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
            warpingField.SetValue(null, warpingBefore);
            Game1.eventUp = eventUpBefore;
            Game1.timeOfDay = timeOfDayBefore;
            Game1.newDay = newDayBefore;
            Game1.farmEvent = farmEventBefore!;
            SetFreezeControls(freezeControlsBefore);
        }
    }
}
