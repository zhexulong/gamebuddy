using System;
using System.Collections.Generic;
using System.IO;
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

    /// <summary>The engine source root, relative to the repository root (the tree is gitignored, so it is found by walking up).</summary>
    private const string DecompiledRelativeRoot = "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley";

    private const string SpriteFile = "FarmerSprite.cs";

    /// <summary>
    /// The six sites the boundary card names, each with the method that must still take the body by an animation.
    /// Both Crop rows live in <c>harvest()</c>, which is why the same method appears twice - the two branches are two
    /// distinct entries into the hold.
    /// </summary>
    private static readonly (string Site, string File, int Line)[] Sites =
    {
        ("Crop.cs:541", "Crop.cs", 541),
        ("Crop.cs:629", "Crop.cs", 629),
        ("Farmer.cs:6482", "Farmer.cs", 6482),
        ("Farmer.cs:8448", "Farmer.cs", 8448),
        ("Farmer.cs:9315", "Farmer.cs", 9315),
        ("Object.cs:3312", "Object.cs", 3312),
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
        string root = DecompiledRoot();
        var findings = new List<string>();

        foreach ((string site, string file, int line) in Sites)
        {
            string[] lines = File.ReadAllLines(Path.Combine(root, file));
            if (line > lines.Length)
            {
                findings.Add($"hold_entry_not_found:{site}:{Fact}");
                continue;
            }

            IReadOnlyList<string> body = Code(EnclosingMethod(lines, line - 1));
            bool holdsTheBody = body.Any(text => text.Contains("anMove = false", StringComparison.Ordinal));
            bool entersByAnAnimation = body.Any(text => text.Contains("animateOnce(", StringComparison.Ordinal));
            if (!holdsTheBody || !entersByAnAnimation)
                findings.Add($"hold_entry_not_found:{site}:{Fact}");
        }

        string[] sprite = File.ReadAllLines(Path.Combine(root, SpriteFile));
        foreach (string method in ReleaseMethods)
        {
            IReadOnlyList<string> body = Code(MethodBody(sprite, method));
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

    /// <summary>The Game1 statics <c>ReadFacts</c> reads, saved and restored around the probe (the suite convention).</summary>
    private static void RunWithGameState(Action action)
    {
        System.Reflection.FieldInfo menuField = typeof(Game1).GetField(
            "_activeClickableMenu",
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!;        object? menuBefore = menuField.GetValue(null);
        bool eventUpBefore = Game1.eventUp;
        int timeOfDayBefore = Game1.timeOfDay;
        try
        {
            menuField.SetValue(null, null);
            Game1.eventUp = false;
            Game1.timeOfDay = 600;
            action();
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
            Game1.eventUp = eventUpBefore;
            Game1.timeOfDay = timeOfDayBefore;
        }
    }

    /// <summary>
    /// The lines with their <c>//</c> comments removed, so a sentence ABOUT a write is never read as the write.
    ///
    /// This is not decoration: with the comment left in place, commenting <c>owner.CanMove = true;</c> out of
    /// <c>doneWithAnimation</c> left this gate green, because the commented line still CONTAINS the text it looks for.
    /// The engine writes no <c>/* */</c> block and no brace or <c>//</c> inside a string literal in either release, so
    /// the bound is exact for them rather than approximate.
    /// </summary>
    private static IReadOnlyList<string> Code(IReadOnlyList<string> lines) =>
        lines.Select(WithoutComment).ToList();

    private static string WithoutComment(string line)
    {
        int at = line.IndexOf("//", StringComparison.Ordinal);
        return at < 0 ? line : line[..at];
    }

    /// <summary>The body of the method declared by <paramref name="declaration"/>, or no lines when it is absent.</summary>
    private static IReadOnlyList<string> MethodBody(string[] lines, string declaration)
    {
        int start = Array.FindIndex(lines, line => line.Contains(declaration, StringComparison.Ordinal));
        return start < 0 ? Array.Empty<string>() : BraceBlock(lines, start);
    }

    /// <summary>
    /// The body of the method that encloses <paramref name="index"/>: the nearest preceding declaration whose brace
    /// block actually contains that line. Requiring containment is what keeps a site that lost its method - or moved
    /// under a declaration this reader does not recognise - reported by name instead of silently attributed to the
    /// method above it.
    /// </summary>
    private static IReadOnlyList<string> EnclosingMethod(string[] lines, int index)
    {
        for (int candidate = index; candidate >= 0; candidate--)
        {
            string text = lines[candidate].Trim();
            if (!text.EndsWith(")", StringComparison.Ordinal))
                continue;
            if (!Declarations.Any(prefix => text.StartsWith(prefix, StringComparison.Ordinal)))
                continue;
            IReadOnlyList<string> body = BraceBlock(lines, candidate);
            if (body.Count > index - candidate)
                return body;
        }

        return Array.Empty<string>();
    }

    /// <summary>The access modifiers the decompiled methods are declared with, in this tree all on one line.</summary>
    private static readonly string[] Declarations = { "public ", "private ", "protected ", "internal " };

    /// <summary>From <paramref name="start"/> to the line closing its first brace block, inclusive.</summary>
    private static IReadOnlyList<string> BraceBlock(string[] lines, int start)
    {
        var body = new List<string>();
        int depth = 0;
        bool opened = false;
        for (int index = start; index < lines.Length; index++)
        {
            body.Add(lines[index]);
            foreach (char character in lines[index])
            {
                if (character == '{')
                {
                    depth++;
                    opened = true;
                }
                else if (character == '}')
                {
                    depth--;
                }
            }

            if (opened && depth == 0)
                return body;
        }

        return body;
    }

    private static string DecompiledRoot()
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            string candidate = Path.Combine(directory.FullName, DecompiledRelativeRoot);
            if (Directory.Exists(candidate))
                return candidate;
        }

        throw new DirectoryNotFoundException($"{DecompiledRelativeRoot} is not reachable from {AppContext.BaseDirectory}");
    }
}
