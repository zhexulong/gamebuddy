using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using Netcode;
using StardewValley;
using StardewValley.Events;
using StardewValley.Minigames;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE GATE FOR THE <c>Minigame</c> FACT: a mounted minigame is a fact read from the engine's own property
/// (<c>Game1.currentMinigame</c>) and cleared only when the minigame's own <c>tick</c> says it is finished, and a
/// minigame that can never unload is a defect rather than a state we tolerate.
///
/// <para>
/// WHY THIS FAMILY FIFTH, AND WHY IT SETTLES THE RETRY QUESTION. One native site holds the body for the fishing
/// minigame's result screen alone - 11 100 ms (boundary: <c>.tmp/boundary-minigame.md</c>, from the residual in
/// <c>.tmp/boundary-card-actor-holds.md</c> §2 row 17) - which is 5.5x the 2000 ms a <c>transient_busy</c> refusal
/// promises the caller can retry in. The engine also counts the minigame in its own right and lists it FIRST among
/// the holds: <c>if (Game1.currentMinigame != null) return true;</c> sits ahead of the menu, the warp, the tool, the
/// freeze and the animation in <c>Farmer.IsBusyDoingSomething()</c> (<c>Farmer.cs:7936-7964</c>).
/// </para>
///
/// <para>
/// WHAT MAKES THE RELEASE TRUSTWORTHY. The fact is the engine's own property, so it clears on the tick the engine
/// clears it: <c>Game1._update</c> ticks <c>currentMinigame.tick(gameTime)</c> and, when that returns true, writes
/// <c>currentMinigame?.unload(); currentMinigame = null;</c> (<c>:4165-4171</c>). The first test pins that, and it pins
/// the 11 100 ms timer the duration claim rests on, so a target version that shortened the window is a finding rather
/// than a silently wrong classification.
/// </para>
///
/// <para>
/// THE POPULATION IS PRINTED, and an unreadable tree is a failure rather than a silent pass: the site is read out of
/// the decompiled source at its own declaration, so a moved site is a finding, never an omission.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the release half is a pin because the minigame loop cannot run in a headless runner and is the premise the fact depends on, while the hold half drives the real ReadFacts path on a probe actor.
public sealed class MinigameHoldTests
{
    private const string Fact = "Minigame";

    private const string Game1File = "StardewValley/Game1.cs";

    private const string FishingFile = "StardewValley.Minigames/FishingGame.cs";

    /// <summary><c>Game1._update</c>, which ticks the mounted minigame and unloads it when its own tick returns true (<c>Game1.cs:4165-4171</c>).</summary>
    private const string TickUpdate = "private void _update(GameTime gameTime)";

    /// <summary>The minigame's own loop, whose done branch starts the results sequence (<c>FishingGame.cs:154-163</c>).</summary>
    private const string FishingTick = "public bool tick(GameTime time)";

    /// <summary>The after-fade callback that takes the body and sets the results timer (<c>FishingGame.cs:167-181</c>).</summary>
    private const string ResultsScreen = "public void gameDoneAfterFade()";

    /// <summary>
    /// The site the boundary card names, with the engine path that takes the body: the done branch fades to the results
    /// screen, and that callback holds the body for its own timer. Its duration is part of the path on purpose - it is
    /// the number the classification rests on.
    /// </summary>
    private static readonly (string Site, (string File, string Declaration, string Contains)[] Path)[] Sites =
    {
        ("FishingGame.cs:170", new[]
        {
            (FishingFile, FishingTick, "Game1.globalFadeToBlack(gameDoneAfterFade"),
            (FishingFile, ResultsScreen, "showResultsTimer = 11100;"),
            (FishingFile, ResultsScreen, "Game1.player.canMove = false;"),
        }),
    };

    /// <summary>
    /// The release is a PAIR, and the pair is what is checked: the minigame is unloaded and the property nulled on the
    /// adjacent lines the engine writes them on (<c>Game1.cs:4170-4171</c>). A substring test over the whole
    /// <c>_update</c> body would accept either half from anywhere in it - and <c>_update</c> also nulls the property at
    /// <c>:3968</c> for an unrelated reason, which measured as a gate that stayed green with the real release commented
    /// out. This is the same reading as the field: what the engine releases with is the sequence, not a word.
    /// </summary>
    private static readonly string[] ReleasePair =
    {
        "currentMinigame?.unload();",
        "currentMinigame = null;",
    };

    [Fact]
    public void EverySiteThatTakesTheBodyForAMinigameIsReleasedByTheEnginesOwnWrite()
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

        if (!ReleasedInOrder())
        {
            foreach ((string site, _) in Sites)
                findings.Add($"hold_entered_without_release:{site}:{Fact}");
            findings.Add($"hold_release_missing:{Game1File}:{DecompiledSource.MethodName(TickUpdate)}:{Fact}");
        }

        Sites.Should().NotBeEmpty($"the minigame site is read from {FishingFile}, and this gate checked none");
        findings.Should().BeEmpty(
            $"the site that takes the body for a minigame must still reach the results screen, and the engine must still "
            + $"unload the minigame and null the property on the adjacent lines it does it on ({Game1File}); examined "
            + $"{Sites.Length} site(s): " + string.Join(", ", Sites.Select(site => site.Site))
            + $"; findings: {string.Join(", ", findings)}");
    }

    /// <summary>Whether the engine's unload-then-null pair still sits, in order and adjacent, inside <c>Game1._update</c>.</summary>
    private static bool ReleasedInOrder()
    {
        IReadOnlyList<string> update = DecompiledSource.Code(
            DecompiledSource.MethodBody(DecompiledSource.Lines(Game1File), TickUpdate));
        int at = -1;
        for (int index = 0; index < update.Count; index++)
        {
            if (update[index].Contains(ReleasePair[0], StringComparison.Ordinal))
            {
                at = index;
                break;
            }
        }

        if (at < 0)
            return false;

        return update
            .Skip(at + 1)
            .Where(line => line.Trim().Length > 0)
            .Take(1)
            .Any(line => line.Contains(ReleasePair[1], StringComparison.Ordinal));
    }

    [Fact]
    public void TheFactIsTheEnginesOwnMinigameAndClearsOnTheEnginesOwnRelease()
    {
        Farmer actor = CreateActor();

        RunWithGameState(() =>
        {
            SetMinigame(NewMinigame());
            WorldModel.ReadFacts(actor).Minigame.Should().BeTrue(
                "the engine is running a minigame: `currentMinigame` is mounted (Game1.cs:1719)");

            // The engine's release: `_update` writes `currentMinigame = null;` when the minigame's own tick returns
            // true (Game1.cs:4170-4171). Nothing else in the world changes.
            SetMinigame(null);
            WorldModel.ReadFacts(actor).Minigame.Should().BeFalse(
                "the fact clears on the engine's own write, not on a duration of ours");
            WorldModel.Classify(WorldModel.ReadFacts(actor)).Kind.Should().Be(ActorDispositionKind.Idle);
        });
    }

    [Fact]
    public void TheHoldDoesNotNeedCanMoveToBeTaken()
    {
        // Farmer.IsBusyDoingSomething() counts a mounted minigame in its own right and lists it first (Farmer.cs:7936),
        // so a body the engine calls busy must not read as free just because nothing has taken CanMove away yet.
        Farmer actor = CreateActor(canMove: true);

        RunWithGameState(() =>
        {
            SetMinigame(NewMinigame());
            WorldModel.ReadFacts(actor).Minigame.Should().BeTrue();
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

    /// <summary>
    /// A mounted minigame with no constructor run: the fact is the minigame's PRESENCE, and the fishing game's
    /// constructor reaches the content registry for its own items (FishingGame.cs:21), which a headless process has no
    /// data for.
    /// </summary>
    private static IMinigame NewMinigame() =>
        (IMinigame)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(FishingGame));

    /// <summary>
    /// The engine's own field, written directly rather than through the property: the property's setter calls
    /// <c>value.minigameId()</c> and re-randomises the weather debris on a null (<c>Game1.cs:1727-1740</c>), which is
    /// the engine's business and not what this case is about.
    /// </summary>
    private static void SetMinigame(IMinigame? minigame) =>
        typeof(Game1)
            .GetField("_currentMinigame", BindingFlags.NonPublic | BindingFlags.Static)!
            .SetValue(null, minigame);

    /// <summary>The Game1 statics <c>ReadFacts</c> reads, saved and restored around the probe (the suite convention).</summary>
    private static void RunWithGameState(Action action)
    {
        FieldInfo menuField = typeof(Game1).GetField(
            "_activeClickableMenu",
            BindingFlags.NonPublic | BindingFlags.Static)!;
        FieldInfo warpingField = typeof(Game1).GetField("_isWarping", BindingFlags.NonPublic | BindingFlags.Static)!;
        FieldInfo minigameField = typeof(Game1).GetField("_currentMinigame", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? menuBefore = menuField.GetValue(null);
        object? warpingBefore = warpingField.GetValue(null);
        object? minigameBefore = minigameField.GetValue(null);
        bool eventUpBefore = Game1.eventUp;
        int timeOfDayBefore = Game1.timeOfDay;
        bool newDayBefore = Game1.newDay;
        FarmEvent? farmEventBefore = Game1.farmEvent;
        bool freezeControlsBefore = Game1.freezeControls;
        try
        {
            menuField.SetValue(null, null);
            warpingField.SetValue(null, false);
            minigameField.SetValue(null, null);
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
            warpingField.SetValue(null, warpingBefore);
            minigameField.SetValue(null, minigameBefore);
            Game1.eventUp = eventUpBefore;
            Game1.timeOfDay = timeOfDayBefore;
            Game1.newDay = newDayBefore;
            Game1.farmEvent = farmEventBefore!;
            Game1.freezeControls = freezeControlsBefore;
        }
    }
}
