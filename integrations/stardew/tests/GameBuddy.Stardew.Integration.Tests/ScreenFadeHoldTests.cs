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
/// THE GATE FOR THE <c>ScreenFade</c> FACT: the engine's global fade is a fact read from the engine's own flag
/// (<c>Game1.globalFade</c>) and cleared by the engine at both ends of the fade, and a fade that can no longer end is a
/// defect rather than a state we tolerate.
///
/// <para>
/// WHY THIS FAMILY SIXTH, AND WHY IT IS NOT THE STATE <c>Warping</c> ALREADY COVERS. One native site fades the screen
/// and takes the body while no other declared fact is up - the mine's fall (boundary:
/// <c>.tmp/boundary-screen-fade.md</c>, from the residual in <c>.tmp/boundary-card-actor-holds.md</c> §2 row 15). The
/// warp's fade is a DIFFERENT flag and the engine keeps them mutually exclusive: <c>FadeScreenToBlack</c> - the site
/// <c>WarpingHoldTests</c> pins - writes <c>globalFade = false; fadeToBlack = true;</c> (<c>ScreenFade.cs:82-83</c>),
/// while <c>GlobalFadeToBlack</c> writes <c>fadeToBlack = false; globalFade = true;</c> (<c>:106-107</c>). Reading
/// <c>fadeToBlack</c> here would also invent a hold for the fade BACK IN, which the engine runs after it has already
/// released the body (<c>Game1.cs:6269-6271</c>, <c>ScreenFade.cs:55-59</c>).
/// </para>
///
/// <para>
/// WHY THE FLAG IS THE HOLD: it is the engine's own control-input gate, beside the freeze -
/// <c>UpdateControlInput</c> runs only when <c>!globalFade &amp;&amp; !freezeControls &amp;&amp; activeClickableMenu == null</c>
/// (<c>Game1.cs:4286</c>).
/// </para>
///
/// <para>
/// WHAT MAKES THE RELEASE TRUSTWORTHY. The fact is the engine's own flag, and the engine clears it at BOTH ends of the
/// fade inside <c>ScreenFade.UpdateGlobalFade</c>: when the fade-in has finished (<c>:134</c>) and when the fade-out
/// has (<c>:154</c>). One write is therefore not enough to believe - a version that kept only one would leave the fact
/// latched at the other end - so the gate requires both, and names the method when either is gone.
/// </para>
///
/// <para>
/// THE POPULATION IS PRINTED, and an unreadable tree is a failure rather than a silent pass.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the release half is a pin because the engine's fade cannot run in a headless runner and is the premise the fact depends on, while the hold half drives the real ReadFacts path on a probe actor.
public sealed class ScreenFadeHoldTests
{
    private const string Fact = "ScreenFade";

    private const string Game1File = "StardewValley/Game1.cs";

    private const string FadeFile = "StardewValley.BellsAndWhistles/ScreenFade.cs";

    private const string MineShaftFile = "StardewValley.Locations/MineShaft.cs";

    /// <summary>The mine's fall, which starts a global fade and takes the body on the next line (<c>MineShaft.cs:3007-3035</c>).</summary>
    private const string MineFall = "public void enterMineShaft()";

    /// <summary>The engine's static door to the fade (<c>Game1.cs:3574-3577</c>).</summary>
    private const string Game1FadeEntry = "public static void globalFadeToBlack(";

    /// <summary>The fade state machine's own entry, which is where the flag is actually raised (<c>ScreenFade.cs:100-112</c>).</summary>
    private const string FadeEntry = "public void GlobalFadeToBlack(";

    /// <summary>The engine's one method that advances and ends a global fade (<c>ScreenFade.cs:128-170</c>).</summary>
    private const string UpdateGlobalFade = "public void UpdateGlobalFade()";

    /// <summary>Both ends clear the flag; a single write leaves the other end latched.</summary>
    private const int ReleaseWriteCount = 2;

    private const string ReleaseWrite = "globalFade = false;";

    /// <summary>
    /// The site the boundary card names, with the engine path that takes the body: the fall starts the fade, the static
    /// door forwards it to the fence, and the fence raises the flag the fact reads.
    /// </summary>
    private static readonly (string Site, (string File, string Declaration, string Contains)[] Path)[] Sites =
    {
        ("MineShaft.cs:3025", new[]
        {
            (MineShaftFile, MineFall, "Game1.globalFadeToBlack(afterFall"),
            (MineShaftFile, MineFall, "Game1.player.CanMove = false;"),
            (Game1File, Game1FadeEntry, "screenFade.GlobalFadeToBlack(afterFade, fadeSpeed);"),
            (FadeFile, FadeEntry, "globalFade = true;"),
        }),
    };

    [Fact]
    public void EverySiteThatTakesTheBodyForAScreenFadeIsReleasedByTheEnginesOwnWrites()
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

        int releases = DecompiledSource
            .Code(DecompiledSource.MethodBody(DecompiledSource.Lines(FadeFile), UpdateGlobalFade))
            .Count(text => text.Contains(ReleaseWrite, StringComparison.Ordinal));
        if (releases != ReleaseWriteCount)
        {
            foreach ((string site, _) in Sites)
                findings.Add($"hold_entered_without_release:{site}:{Fact}");
            findings.Add(
                $"hold_release_missing:{FadeFile}:{DecompiledSource.MethodName(UpdateGlobalFade)}:{Fact}"
                + $":expected_{ReleaseWriteCount}_ends_got_{releases}");
        }

        Sites.Should().NotBeEmpty($"the fade site is read from {MineShaftFile} and the fence, and this gate checked none");
        findings.Should().BeEmpty(
            $"the site that takes the body for a screen fade must still reach the engine's own fade, and both ends of "
            + $"that fade must still clear the flag in {FadeFile}; examined {Sites.Length} site(s): "
            + string.Join(", ", Sites.Select(site => site.Site))
            + $"; findings: {string.Join(", ", findings)}");
    }

    [Fact]
    public void TheFactIsTheEnginesGlobalFadeAndClearsOnTheEnginesOwnRelease()
    {
        Farmer actor = CreateActor();

        RunWithGameState(() =>
        {
            SetGlobalFade(true);
            WorldModel.ReadFacts(actor).ScreenFade.Should().BeTrue(
                "the engine is fading the screen: `globalFade` is raised by GlobalFadeToBlack (ScreenFade.cs:107)");

            // The engine's release: `UpdateGlobalFade` writes `globalFade = false;` when the fade completes (ScreenFade.cs:134,
            // :154). Nothing else in the world changes.
            SetGlobalFade(false);
            WorldModel.ReadFacts(actor).ScreenFade.Should().BeFalse(
                "the fact clears on the engine's own write, not on a duration of ours");
            WorldModel.Classify(WorldModel.ReadFacts(actor)).Kind.Should().Be(ActorDispositionKind.Idle);
        });
    }

    [Fact]
    public void TheWarpFadeIsNotThisFact()
    {
        // The two flags are mutually exclusive by the engine's own writes (ScreenFade.cs:82-83, :106-107), so one fact
        // cannot be the other observed twice. A warp is named by `Warping` and must not read as a screen fade...
        Farmer actor = CreateActor(canMove: true);

        RunWithGameState(() =>
        {
            SetWarping(true);
            ActorWorldFacts warping = WorldModel.ReadFacts(actor);
            warping.Warping.Should().BeTrue();
            warping.ScreenFade.Should().BeFalse("a warp raises `fadeToBlack` and clears `globalFade` (ScreenFade.cs:82-83)");

            // ...and a global fade is not a warp, which is the shape the mine's fall has.
            SetWarping(false);
            SetGlobalFade(true);
            ActorWorldFacts fading = WorldModel.ReadFacts(actor);
            fading.ScreenFade.Should().BeTrue();
            fading.Warping.Should().BeFalse("a mine fall fades the screen without ever warping the body");
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

    /// <summary>The engine's own flags, which the cases move exactly as the fade and the warp handler do.</summary>
    private static void SetGlobalFade(bool fading) => Game1.globalFade = fading;

    private static void SetWarping(bool warping) =>
        typeof(Game1).GetField("_isWarping", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, warping);

    /// <summary>The Game1 statics <c>ReadFacts</c> reads, saved and restored around the probe (the suite convention).</summary>
    private static void RunWithGameState(Action action)
    {
        FieldInfo menuField = typeof(Game1).GetField(
            "_activeClickableMenu",
            BindingFlags.NonPublic | BindingFlags.Static)!;
        FieldInfo minigameField = typeof(Game1).GetField("_currentMinigame", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? menuBefore = menuField.GetValue(null);
        object? minigameBefore = minigameField.GetValue(null);
        bool warpingBefore = Game1.isWarping;
        bool globalFadeBefore = Game1.globalFade;
        bool eventUpBefore = Game1.eventUp;
        int timeOfDayBefore = Game1.timeOfDay;
        bool newDayBefore = Game1.newDay;
        FarmEvent? farmEventBefore = Game1.farmEvent;
        bool freezeControlsBefore = Game1.freezeControls;
        try
        {
            menuField.SetValue(null, null);
            minigameField.SetValue(null, null);
            SetWarping(false);
            SetGlobalFade(false);
            Game1.eventUp = false;
            Game1.timeOfDay = 600;
            Game1.newDay = false;
            Game1.farmEvent = null!;
            Game1.freezeControls = false;
            action();
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
            minigameField.SetValue(null, minigameBefore);
            SetWarping(warpingBefore);
            SetGlobalFade(globalFadeBefore);
            Game1.eventUp = eventUpBefore;
            Game1.timeOfDay = timeOfDayBefore;
            Game1.newDay = newDayBefore;
            Game1.farmEvent = farmEventBefore!;
            Game1.freezeControls = freezeControlsBefore;
        }
    }
}
