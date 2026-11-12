using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using Netcode;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE GATE FOR THE <c>Warping</c> FACT: the body's location transition is a fact read from the engine's own flag
/// (<c>Game1.isWarping</c>) and cleared by the engine's own release write, and a warp that takes the body without that
/// release is a defect rather than a state we tolerate.
///
/// <para>
/// WHY THIS FAMILY SECOND, AND WHY IT IS NOT ONLY A NEW READ. Two native sites take the body for the whole warp and
/// leave no other declared fact up (boundary: <c>.tmp/boundary-warping.md</c>, from the residual in
/// <c>.tmp/boundary-card-actor-holds.md</c> §2 rows 9 and 16). More than that, the state-space docstring in
/// <c>WorldModel.cs</c> argued the opposite - that a location change does not lock the actor - and the engine
/// contradicts it: every warp goes <c>_isWarping = true; fadeScreenToBlack();</c> (<c>Game1.cs:10031-10033</c>), and
/// the default <c>stopMovement</c> of that fade writes <c>Game1.player.CanMove = false</c> (<c>ScreenFade.cs:86-89</c>).
/// </para>
///
/// <para>
/// WHAT MAKES THE RELEASE TRUSTWORTHY. The fact is the engine's own <c>_isWarping</c>, so it clears on the tick the
/// engine clears it - <c>onFadeToBlackComplete</c> writes it false once the screen is black (<c>Game1.cs:6271</c>,
/// reached from <c>ScreenFade.UpdateFade</c> at <c>ScreenFade.cs:38-41</c>). The first test pins that: each of the two
/// sites still reaches the warp through the exact method bodies named, and the release still exists. A target version
/// that dropped the release fails here naming the site, instead of leaving the fact latched on a body the engine
/// released.
/// </para>
///
/// <para>
/// THE POPULATION IS PRINTED, and an unreadable tree is a failure rather than a silent pass: the sites are read out of
/// the decompiled source at their own lines, so a moved site is a finding, never an omission.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the release half is a pin because the engine's fade cannot run in a headless runner and is the premise the fact depends on, while the hold half drives the real ReadFacts path on a probe farmer.
public sealed class WarpingHoldTests
{
    private const string Fact = "Warping";

    private const string Game1File = "StardewValley/Game1.cs";

    /// <summary>The engine's warp entry, and the writes that make it one (<c>Game1.cs:10005</c>, <c>:10031</c>, <c>:10033</c>).</summary>
    private const string WarpEntry = "private static void performWarpFarmer(";

    /// <summary><c>Game1.fadeScreenToBlack</c>, the static wrapper the warp handler calls (<c>Game1.cs:6147-6150</c>).</summary>
    private const string FadeEntry = "public static void fadeScreenToBlack(";

    /// <summary>The fade that takes the body: <c>stopMovement</c> defaults to true and writes <c>CanMove = false</c> (<c>ScreenFade.cs:80-90</c>).</summary>
    private const string FadeToBlack = "public void FadeScreenToBlack(";

    /// <summary>The engine's one release of the flag (<c>Game1.cs:6271</c>, declared <c>:6157</c>).</summary>
    private const string WarpRelease = "private bool onFadeToBlackComplete(";

    /// <summary>The volcano shortcut's own warp (<c>VolcanoDungeon.cs:282-289</c>).</summary>
    private const string VolcanoShortcut = "public void UseVolcanoShortcut(";

    /// <summary>
    /// The sites the boundary card names, each with the engine path that takes the body on its way into the warp, as
    /// the exact texts that must still sit in the exact method bodies. A hop that moved or was deleted is reported
    /// against the site rather than silently dropped, which is what keeps the population honest.
    ///
    /// <para>
    /// The first path is why the fade site belongs to the warp at all: <c>FadeScreenToBlack</c> is also reached by the
    /// new-day sequence and by events, so the site is tied to the warp by its WARP caller
    /// (<c>Game1.cs:10031-10033</c>), never by itself.
    /// </para>
    /// </summary>
    private static readonly (string Site, (string File, string Declaration, string Contains)[] Path)[] Sites =
    {
        ("ScreenFade.cs:88", new[]
        {
            (Game1File, WarpEntry, "_isWarping = true;"),
            (Game1File, WarpEntry, "fadeScreenToBlack()"),
            (Game1File, FadeEntry, "screenFade.FadeScreenToBlack()"),
            ("StardewValley.BellsAndWhistles/ScreenFade.cs", FadeToBlack, "Game1.player.CanMove = false;"),
        }),
        ("VolcanoDungeon.cs:286", new[]
        {
            ("StardewValley.Locations/VolcanoDungeon.cs", VolcanoShortcut, "Game1.player.CanMove = false;"),
            ("StardewValley.Locations/VolcanoDungeon.cs", VolcanoShortcut, "Game1.warpFarmer("),
            (Game1File, WarpEntry, "_isWarping = true;"),
        }),
    };

    [Fact]
    public void EverySiteThatTakesTheBodyForAWarpIsReleasedByTheEnginesOwnWrite()
    {
        var findings = new List<string>();
        IReadOnlyList<string> release = DecompiledSource.Code(DecompiledSource.MethodBody(
            DecompiledSource.Lines(Game1File),
            WarpRelease));
        bool released = release.Any(text => text.Contains("_isWarping = false;", StringComparison.Ordinal));

        foreach ((string site, (string File, string Declaration, string Contains)[] path) in Sites)
        {
            bool entered = path.All(hop => DecompiledSource
                .Code(DecompiledSource.MethodBody(DecompiledSource.Lines(hop.File), hop.Declaration))
                .Any(text => text.Contains(hop.Contains, StringComparison.Ordinal)));
            if (!entered)
                findings.Add($"hold_entry_not_found:{site}:{Fact}");
            if (!released)
                findings.Add($"hold_entered_without_release:{site}:{Fact}");
        }

        if (!released)
            findings.Add($"hold_release_missing:{Game1File}:onFadeToBlackComplete:{Fact}");

        // The population is printed, and an empty one fails: "0 findings" over "0 sites" would agree with itself.
        Sites.Should().NotBeEmpty($"the warp sites are read from {Game1File} and the fade, and this gate checked none");
        findings.Should().BeEmpty(
            $"every site that takes the body for a warp must still reach the warp, and its release must still be the "
            + $"engine's own `_isWarping = false` write in `onFadeToBlackComplete` ({Game1File}); examined "
            + $"{Sites.Length} site(s): " + string.Join(", ", Sites.Select(site => site.Site))
            + $"; findings: {string.Join(", ", findings)}");
    }

    [Fact]
    public void TheFactIsTheEnginesFlagAndClearsOnTheEnginesOwnRelease()
    {
        Farmer actor = CreateActor(canMove: false);

        RunWithGameState(() =>
        {
            SetWarping(true);
            WorldModel.ReadFacts(actor).Warping.Should().BeTrue(
                "the engine is warping: `_isWarping` is raised by performWarpFarmer (Game1.cs:10031)");

            // The engine's release: onFadeToBlackComplete clears the flag (Game1.cs:6271) when the screen is black,
            // which is what clears the body hold as well - no duration of ours.
            SetWarping(false);
            WorldModel.ReadFacts(actor).Warping.Should().BeFalse(
                "the fact clears on the engine's own release, not on a timer");
            WorldModel.Classify(WorldModel.ReadFacts(actor)).Kind.Should().Be(ActorDispositionKind.Idle);
        });
    }

    [Fact]
    public void TheHoldDoesNotNeedCanMoveToBeTaken()
    {
        // Farmer.IsBusyDoingSomething() counts the warp in its own right (Farmer.cs:7944), beside `!CanMove` (:7960),
        // so a body the engine calls busy must not read as free just because nothing has taken CanMove away yet.
        Farmer actor = CreateActor(canMove: true);

        RunWithGameState(() =>
        {
            SetWarping(true);
            WorldModel.ReadFacts(actor).Warping.Should().BeTrue();
        });
    }

    [Fact]
    public void TheHoldIsNamedWhileTheEngineWarpsTheBody()
    {
        Farmer actor = CreateActor(canMove: false);

        RunWithGameState(() =>
        {
            SetWarping(true);
            ActorDisposition held = WorldModel.Classify(WorldModel.ReadFacts(actor));
            held.Kind.Should().Be(ActorDispositionKind.Transient);
            held.TransientKind.Should().Be("warping",
                "the hold must arrive with the word that tells the caller what holds the body, not as movement_lock");

            // The refusal says WAIT, not retry: the same `transient_busy` vocabulary the animation fact publishes, with
            // the window the engine's own fade actually takes.
            (string reasonCode, string evidence) =
                WorldModel.DescribeCurrentBodyHold(held, WorldModel.ReadFacts(actor), canMove: false);
            reasonCode.Should().Be("transient_busy");
            evidence.Should().Contain("transient_kind=warping");
            evidence.Should().Contain($"retry_window_ms={WorldModel.TransientRetryWindowMs}");
        });
    }

    /// <summary>
    /// A probe farmer whose only hold is the one under test: no menu, no event, no eating, no tool. The sprite is
    /// seeded because <c>ReadFacts</c> dereferences it, and the NetFields are the ones it reads.
    /// </summary>
    private static Farmer CreateActor(bool canMove)
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

    /// <summary>The engine's own flag, which the case moves exactly as <c>performWarpFarmer</c> / <c>onFadeToBlackComplete</c> do.</summary>
    private static void SetWarping(bool warping) =>
        typeof(Game1).GetField("_isWarping", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, warping);

    /// <summary>The Game1 statics <c>ReadFacts</c> reads, saved and restored around the probe (the suite convention).</summary>
    private static void RunWithGameState(Action action)
    {
        FieldInfo menuField = typeof(Game1).GetField(
            "_activeClickableMenu",
            BindingFlags.NonPublic | BindingFlags.Static)!;
        object? menuBefore = menuField.GetValue(null);
        bool warpingBefore = Game1.isWarping;
        bool eventUpBefore = Game1.eventUp;
        int timeOfDayBefore = Game1.timeOfDay;
        try
        {
            menuField.SetValue(null, null);
            SetWarping(false);
            Game1.eventUp = false;
            Game1.timeOfDay = 600;
            action();
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
            SetWarping(warpingBefore);
            Game1.eventUp = eventUpBefore;
            Game1.timeOfDay = timeOfDayBefore;
        }
    }
}
