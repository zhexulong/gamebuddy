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
/// THE GATE FOR THE <c>DayTransition</c> FACT: the day the engine advances is a fact read from the engine's own
/// two flags (<c>Game1.newDay</c>, <c>Game1.farmEvent</c>) and cleared by the engine's own writes, and a farm event
/// that takes the body without those writes is a defect rather than a state we tolerate.
///
/// <para>
/// WHY THIS FAMILY THIRD. Two native sites take the body for a whole farm event and leave no other declared fact up
/// (boundary: <c>.tmp/boundary-day-transition.md</c>, from the residual in <c>.tmp/boundary-card-actor-holds.md</c>
/// §2 rows 10 and 11). A farm event runs with <c>eventUp == false</c> - the two are tracked separately
/// (<c>Game1.cs:1023</c> next to <c>:2190</c>) - so before this fact the disposition said <c>idle</c> while the
/// engine had the body, and it stays that way for the event's timer, its dialogue and its naming menu.
/// </para>
///
/// <para>
/// WHAT MAKES THE RELEASE TRUSTWORTHY. The fact is the engine's own pair of statics, so it clears on the tick the
/// engine clears them: <c>newDay = false;</c> in the overnight coroutine (<c>Game1.cs:8567</c>) and
/// <c>farmEvent = null;</c> when the event's own tick (<c>:4193</c>) or its <c>setUp</c> (<c>:8606</c>) reports it
/// over. The first test pins that, and it pins the driver as well - the coroutine still calls
/// <c>farmEvent.setUp()</c> and <c>_update</c> still ticks it - so a site that lost its driver is named rather than
/// silently dropped.
/// </para>
///
/// <para>
/// THE POPULATION IS PRINTED, and an unreadable tree is a failure rather than a silent pass: the sites are read out
/// of the decompiled source at their own declarations, so a moved site is a finding, never an omission.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the release half is a pin because the overnight sequence cannot run in a headless runner and is the premise the fact depends on, while the hold half drives the real ReadFacts path on probe actors.
public sealed class DayTransitionHoldTests
{
    private const string Fact = "DayTransition";

    private const string Game1File = "StardewValley/Game1.cs";

    /// <summary><c>Game1._update</c>, which ticks a mounted farm event and drops it when its own tick says it is over (<c>Game1.cs:4187-4193</c>).</summary>
    private const string TickUpdate = "private void _update(GameTime gameTime)";

    /// <summary>The overnight coroutine: it runs <c>farmEvent.setUp()</c> (<c>:8604</c>), clears <c>newDay</c> (<c>:8567</c>) and drops a farm event that never started (<c>:8606</c>).</summary>
    private const string NewDayAfterFade = "private static IEnumerator<int> _newDayAfterFade()";

    /// <summary>
    /// The sites the boundary card names, each with the engine path that keeps the body on its way through the
    /// day: the <c>setUp</c> that takes <c>CanMove</c>, the coroutine that calls it, and the tick that re-asserts it
    /// every frame. A hop that moved or was deleted is reported against the site.
    /// </summary>
    private static readonly (string Site, (string File, string Declaration, string Contains)[] Path)[] Sites =
    {
        ("BirthingEvent.cs:34", new[]
        {
            ("StardewValley.Events/BirthingEvent.cs", "public override bool setUp()", "Game1.player.CanMove = false;"),
            (Game1File, NewDayAfterFade, "farmEvent.setUp()"),
            (Game1File, TickUpdate, "farmEvent.tickUpdate(gameTime)"),
        }),
        ("PlayerCoupleBirthingEvent.cs:89", new[]
        {
            ("StardewValley.Events/PlayerCoupleBirthingEvent.cs", "public override bool setUp()", "Game1.player.CanMove = false;"),
            (Game1File, NewDayAfterFade, "farmEvent.setUp()"),
            (Game1File, TickUpdate, "farmEvent.tickUpdate(gameTime)"),
        }),
    };

    /// <summary>
    /// The engine's own writes that end the fact, named by the method whose body must still contain them. Both halves
    /// are here: <c>newDay</c> is the overnight sequence's, and <c>farmEvent</c> is dropped in the two places the
    /// engine can learn the scene is over.
    /// </summary>
    private static readonly (string File, string Declaration, string Contains)[] Releases =
    {
        (Game1File, TickUpdate, "farmEvent = null;"),
        (Game1File, NewDayAfterFade, "newDay = false;"),
        (Game1File, NewDayAfterFade, "farmEvent = null;"),
    };

    [Fact]
    public void EverySiteThatTakesTheBodyForADayTransitionIsReleasedByTheEnginesOwnWrites()
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

        // The population is printed, and an empty one fails: "0 findings" over "0 sites" would agree with itself.
        Sites.Should().NotBeEmpty($"the day-transition sites are read from {Game1File} and the farm events, and this gate checked none");
        findings.Should().BeEmpty(
            $"every site that takes the body for a day transition must still be driven by the overnight sequence, and "
            + $"each release must still be the engine's own write in {Game1File}; examined {Sites.Length} site(s): "
            + string.Join(", ", Sites.Select(site => site.Site))
            + $"; findings: {string.Join(", ", findings)}");
    }

    [Fact]
    public void TheFactIsTheEnginesOwnDayFlagsAndClearsOnTheEnginesOwnReleases()
    {
        Farmer actor = CreateActor();

        RunWithGameState(() =>
        {
            SetNewDay(true);
            WorldModel.ReadFacts(actor).DayTransition.Should().BeTrue(
                "the engine is advancing the day: `newDay` is raised by Game1.NewDay (Game1.cs:10370)");

            // The engine's release: the overnight coroutine writes `newDay = false;` (Game1.cs:8567) once it has
            // finished the new day. Nothing else in the world changes.
            SetNewDay(false);
            WorldModel.ReadFacts(actor).DayTransition.Should().BeFalse(
                "the fact clears on the engine's own write, not on a duration of ours");
            WorldModel.Classify(WorldModel.ReadFacts(actor)).Kind.Should().Be(ActorDispositionKind.Idle);

            // The other half: a mounted farm event holds the body through its own `setUp` (BirthingEvent.cs:34),
            // and the engine drops it with `farmEvent = null;` (Game1.cs:4193, :8606).
            SetFarmEvent(NewFarmEvent());
            WorldModel.ReadFacts(actor).DayTransition.Should().BeTrue(
                "a mounted FarmEvent is the day's own scene and takes the body in its setUp");

            SetFarmEvent(null);
            WorldModel.ReadFacts(actor).DayTransition.Should().BeFalse("the engine drops the event it finished");
        });
    }

    /// <summary>
    /// A probe farmer whose no other fact is up: no menu, no event, no eating, no tool, no animation. The sprite and
    /// the NetFields are the ones <c>ReadFacts</c> dereferences, the same completeness every admission probe supplies.
    /// </summary>
    private static Farmer CreateActor()
    {
        Farmer actor = (Farmer)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(Farmer));
        actor.CanMove = false;
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

    /// <summary>A farm event with no constructor run: the fact is its presence, and <c>setUp</c> is never called here.</summary>
    private static FarmEvent NewFarmEvent() =>
        (FarmEvent)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(BirthingEvent));

    private static void SetNewDay(bool newDay) => Game1.newDay = newDay;

    private static void SetFarmEvent(FarmEvent? farmEvent) => Game1.farmEvent = farmEvent!;

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
        bool freezeControlsBefore = Game1.freezeControls;
        bool newDayBefore = Game1.newDay;
        FarmEvent? farmEventBefore = Game1.farmEvent;
        try
        {
            menuField.SetValue(null, null);
            warpingField.SetValue(null, false);
            Game1.eventUp = false;
            Game1.timeOfDay = 600;
            Game1.freezeControls = false;
            SetNewDay(false);
            SetFarmEvent(null);
            action();
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
            warpingField.SetValue(null, warpingBefore);
            Game1.eventUp = eventUpBefore;
            Game1.timeOfDay = timeOfDayBefore;
            Game1.freezeControls = freezeControlsBefore;
            SetNewDay(newDayBefore);
            SetFarmEvent(farmEventBefore);
        }
    }
}
