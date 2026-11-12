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
/// THE GATE FOR THE <c>SelfAnimation</c> FACT: the body's single-animation pause is a fact read from the engine's own
/// flag and cleared by the engine's own release write, the disposition names it while it is up, and a hold that is
/// entered and never released is a defect rather than a state we tolerate.
///
/// <para>
/// WHY THIS FAMILY FIRST. Six native sites take the body for 400-2000 ms by writing <c>CanMove = false</c> beside an
/// animation and leave no other declared fact up, so before this fact the disposition said <c>idle</c>, <c>actionable</c>
/// was false, and admission could hand work to a body that would not move (boundary:
/// <c>.tmp/boundary-self-animation.md</c>, from the residual in <c>.tmp/boundary-card-actor-holds.md</c> §2 rows 1, 2,
/// 4, 5, 6, 7).
/// </para>
///
/// <para>
/// WHAT MAKES THE RELEASE TRUSTWORTHY. The fact is the engine's own <c>FarmerSprite.PauseForSingleAnimation</c>, so it
/// clears on the tick the engine clears it - <c>doneWithAnimation</c> and <c>animateBackwardsOnce</c> write the flag
/// false and hand the body back in the same method. The first test pins exactly that: for each of the six sites the
/// entry is still an animation, and each release the fact depends on still performs both writes. A target version that
/// dropped either write fails here naming the site, instead of leaving the fact latched on a body the engine released.
/// </para>
///
/// <para>
/// THE POPULATION IS PRINTED, and an unreadable tree is a failure rather than a silent pass: the six sites are read out
/// of the decompiled source at their own lines, so a moved site is a finding, never an omission.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the release half is a pin because the engine's animation release cannot run in a headless runner and is the premise the fact depends on, while the hold half drives the real ReadFacts/Classify path on a probe farmer.
public sealed class SelfAnimationHoldTests
{
    private const string Fact = "SelfAnimation";

    private const string SpriteFile = "StardewValley/FarmerSprite.cs";

    /// <summary>
    /// The six sites the boundary card names, each with the method that must still take the body by an animation.
    /// Both Crop rows live in <c>harvest()</c>, which is why the same method appears twice - the two branches are two
    /// distinct entries into the hold.
    /// </summary>
    private static readonly (string Site, string File, int Line)[] Sites =
    {
        ("Crop.cs:541", "StardewValley/Crop.cs", 541),
        ("Crop.cs:629", "StardewValley/Crop.cs", 629),
        ("Farmer.cs:6482", "StardewValley/Farmer.cs", 6482),
        ("Farmer.cs:8448", "StardewValley/Farmer.cs", 8448),
        ("Farmer.cs:9315", "StardewValley/Farmer.cs", 9315),
        ("Object.cs:3312", "StardewValley/Object.cs", 3312),
    };

    /// <summary>
    /// The engine's two releases of the flag, named by their own declarations. Each is then required to still write
    /// both halves - clearing the flag AND giving <c>CanMove</c> back - so a deleted write is red.
    /// </summary>
    private static readonly string[] ReleaseMethods =
    {
        "private void doneWithAnimation()",
        "private void animateBackwardsOnce(GameTime time)",
    };

    [Fact]
    public void EverySiteThatTakesTheBodyByASingleAnimationHasAnEngineRelease()
    {
        var findings = new List<string>();

        foreach ((string site, string file, int line) in Sites)
        {
            string[] lines = DecompiledSource.Lines(file);
            if (line > lines.Length)
            {
                findings.Add($"hold_entry_not_found:{site}:{Fact}");
                continue;
            }

            IReadOnlyList<string> body = DecompiledSource.Code(DecompiledSource.EnclosingMethod(lines, line - 1));
            bool holdsTheBody = body.Any(text => text.Contains("anMove = false", StringComparison.Ordinal));
            bool entersByAnAnimation = body.Any(text => text.Contains("animateOnce(", StringComparison.Ordinal));
            if (!holdsTheBody || !entersByAnAnimation)
                findings.Add($"hold_entry_not_found:{site}:{Fact}");
        }

        string[] sprite = DecompiledSource.Lines(SpriteFile);
        foreach (string method in ReleaseMethods)
        {
            IReadOnlyList<string> body = DecompiledSource.Code(DecompiledSource.MethodBody(sprite, method));
            // Both writes, in one body: clearing the flag alone leaves the body held (the six sites wrote CanMove
            // themselves), and giving CanMove back alone leaves the flag up for the next animation.
            bool released =
                body.Any(text => text.Contains("PauseForSingleAnimation = false;", StringComparison.Ordinal))
                && body.Any(text => text.Contains("CanMove = true;", StringComparison.Ordinal));
            if (released)
                continue;

            foreach ((string site, _, _) in Sites)
                findings.Add($"hold_entered_without_release:{site}:{Fact}");
            findings.Add($"hold_release_missing:{SpriteFile}:{method.Split(' ')[^1].Split('(')[0]}:{Fact}");
        }

        findings.Should().BeEmpty(
            $"every site that takes the body by a single-animation pause must be released by the engine's own "
            + $"writes in {SpriteFile}, and every release must still be an animation entry; findings: "
            + string.Join(", ", findings));
    }

    [Fact]
    public void TheFactIsTheEnginesFlagAndClearsOnTheEnginesOwnRelease()
    {
        Farmer actor = CreateActor(selfAnimation: true, canMove: false);

        RunWithGameState(() =>
        {
            WorldModel.ReadFacts(actor).SelfAnimation.Should().BeTrue(
                "the engine has the body: PauseForSingleAnimation is raised by FarmerSprite.animateOnce");

            // The engine's release: doneWithAnimation lowers the flag (FarmerSprite.cs:792) in the same method that
            // gives CanMove back (:789). Nothing else in the world changes.
            actor.FarmerSprite.PauseForSingleAnimation = false;
            WorldModel.ReadFacts(actor).SelfAnimation.Should().BeFalse(
                "the fact clears on the engine's own release, not on a duration of ours");
            WorldModel.Classify(WorldModel.ReadFacts(actor)).Kind.Should().Be(ActorDispositionKind.Idle);
        });
    }

    [Fact]
    public void TheHoldIsNamedWhileTheEnginePausesTheBody()
    {
        Farmer actor = CreateActor(selfAnimation: true, canMove: false);

        RunWithGameState(() =>
        {
            ActorDisposition held = WorldModel.Classify(WorldModel.ReadFacts(actor));
            held.Kind.Should().Be(ActorDispositionKind.Transient);
            held.TransientKind.Should().Be("selfAnimation",
                "the hold must arrive with the word that tells the caller what holds the body, not as movement_lock");
        });
    }

    [Fact]
    public void TheHoldDoesNotNeedCanMoveToBeTaken()
    {
        // Farmer.IsBusyDoingSomething() counts the pause in its own right (Farmer.cs:7964), beside `!CanMove` (:7960),
        // so a body the engine calls busy must not read as free just because nothing has taken CanMove away yet.
        Farmer actor = CreateActor(selfAnimation: true, canMove: true);

        RunWithGameState(() =>
        {
            WorldModel.Classify(WorldModel.ReadFacts(actor)).TransientKind.Should().Be("selfAnimation");
        });
    }

    /// <summary>
    /// A probe farmer whose only hold is the one under test: no menu, no event, no eating, no tool. The sprite is the
    /// object the fact reads, so it is seeded with the skill's own shared helper; the NetFields are the ones
    /// <c>WorldModel.ReadFacts</c> dereferences, the same completeness every admission probe supplies.
    /// </summary>
    private static Farmer CreateActor(bool selfAnimation, bool canMove)
    {
        Farmer actor = (Farmer)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(Farmer));
        actor.CanMove = canMove;
        actor.freezePause = 0;
        Seed(actor, "usingTool", new NetBool(false));
        Seed(actor, "netStamina", new NetFloat(270f));
        Seed(actor, "toolPower", new NetInt(0));
        ProbeFarmerSprite.Attach(actor, pausedForSingleAnimation: selfAnimation);
        return actor;
    }

    private static void Seed(Farmer actor, string field, object value) =>
        typeof(Farmer)
            .GetField(field, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, value);

    /// <summary>
    /// The Game1 statics <c>ReadFacts</c> reads, saved and restored around the probe (the suite convention) - including
    /// the engine's warp flag, which another suite can leave raised and which would otherwise classify this body as held.
    /// </summary>
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
        try
        {
            menuField.SetValue(null, null);
            warpingField.SetValue(null, false);
            Game1.eventUp = false;
            Game1.timeOfDay = 600;
            action();
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
            warpingField.SetValue(null, warpingBefore);
            Game1.eventUp = eventUpBefore;
            Game1.timeOfDay = timeOfDayBefore;
        }
    }
}
