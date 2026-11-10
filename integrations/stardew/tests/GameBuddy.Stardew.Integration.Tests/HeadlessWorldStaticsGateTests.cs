using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE GATE FOR ONE DEFECT FAMILY: a world fixture that writes a process-wide static and does not put it back.
///
/// <para>
/// Serialising the classes (<see cref="HeadlessGameWorld.Collection"/>) makes a stale static fail LATER rather than
/// concurrently, and xunit promises no order, so "later" is a different class in every run - which is why the same
/// build produced 0, 1, 6, 8 and 9 failures on consecutive runs of 2026-11-10 with no source change between them. The
/// population is DERIVED, not listed: every nested <see cref="IDisposable"/> type in this assembly that exposes a
/// parameterless static <c>Create()</c> is a world fixture, so a fixture written tomorrow is covered by being written.
/// </para>
///
/// <para>
/// Two properties, because a fixture can leak in two ways and the second one is what the first one hides:
/// </para>
///
/// <list type="number">
/// <item>the statics it found are the statics it leaves (<see cref="HeadlessGameWorld.GameStatics"/> and
/// <see cref="HeadlessGameWorld.GameInstanceFields"/>) - the shape that broke was a snapshot taken AFTER the world was
/// built, so the fixture's own <c>Game1</c> and <c>netWorldState</c> were recorded as the values to restore;</item>
/// <item>a <c>Game1</c> instance it did NOT create keeps its own location book - because the fixture that finds a
/// leftover <c>Game1</c> and registers its location on it poisons the name for every later fixture, and the symptom
/// lands three classes away: a farmer whose <c>currentLocation</c> resolves into somebody else's farm.</item>
/// </list>
///
/// <para>
/// The failure message names the fixture and the static, because "expected true, got false" costs the next reader an
/// afternoon. Fixtures whose <c>Create()</c> takes arguments are printed as NOT COVERED rather than skipped quietly.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class HeadlessWorldStaticsGateTests
{
    /// <summary>
    /// A fixture that builds a world and disposes it must leave every declared static as it found it.
    /// </summary>
    [Fact]
    public void EveryWorldFixtureLeavesTheProcessStaticsAsItFoundThem()
    {
        IReadOnlyList<Type> fixtures = Fixtures(out IReadOnlyList<string> uncovered);
        fixtures.Should().NotBeEmpty(
            "a gate whose population is empty agrees with itself; the fixture types it derives from are the population");

        Dictionary<string, object?> before = HeadlessGameWorld.CaptureStatics();
        var failures = new List<string>();
        try
        {
            foreach (Type fixture in fixtures)
            {
                MethodInfo create = Factory(fixture)!;
                IDisposable? world = null;
                try
                {
                    world = (IDisposable)create.Invoke(null, null)!;
                }
                catch (Exception error)
                {
                    failures.Add($"{fixture.Name}.Create threw {Innermost(error).GetType().Name}: {Innermost(error).Message}");
                    HeadlessGameWorld.RestoreStatics(before);
                    continue;
                }

                world.Dispose();
                foreach (KeyValuePair<string, object?> entry in before)
                {
                    object? now = HeadlessGameWorld.Static(entry.Key).Get();
                    if (!Equals(now, entry.Value))
                    {
                        failures.Add(
                            $"{fixture.Name} left Game1.{entry.Key} as `{Describe(now)}` after disposing, "
                            + $"but found `{Describe(entry.Value)}`");
                    }
                }

                HeadlessGameWorld.RestoreStatics(before);
            }
        }
        finally
        {
            HeadlessGameWorld.RestoreStatics(before);
        }

        string.Join(Environment.NewLine, failures).Should().BeEmpty(
            $"every world fixture must restore the statics it writes (population {fixtures.Count} fixtures; "
            + $"not covered: {string.Join(", ", uncovered)})");
    }

    /// <summary>
    /// A fixture that finds a <c>Game1</c> already installed must not write that instance's location book: the book is
    /// what <c>getLocationFromName</c> answers from, so a registered location outlives the fixture that built it.
    /// </summary>
    [Fact]
    public void EveryWorldFixtureLeavesAGame1ItDidNotCreateAlone()
    {
        IReadOnlyList<Type> fixtures = Fixtures(out IReadOnlyList<string> uncovered);
        fixtures.Should().NotBeEmpty();

        Dictionary<string, object?> before = HeadlessGameWorld.CaptureStatics();
        var failures = new List<string>();
        try
        {
            foreach (Type fixture in fixtures)
            {
                GameLocation sentinelLocation = NewLocation("SentinelFarm");
                var book = new List<GameLocation> { sentinelLocation };
                var sentinelGame = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
                HeadlessGameWorld.InstanceField("instanceGameLocation").SetValue(sentinelGame, sentinelLocation);
                HeadlessGameWorld.InstanceField("_locations").SetValue(sentinelGame, book);
                Game1.game1 = sentinelGame;

                IDisposable? world = null;
                try
                {
                    world = (IDisposable)Factory(fixture)!.Invoke(null, null)!;
                }
                catch (Exception error)
                {
                    failures.Add($"{fixture.Name}.Create threw {Innermost(error).GetType().Name}: {Innermost(error).Message}");
                    HeadlessGameWorld.RestoreStatics(before);
                    continue;
                }

                world.Dispose();

                if (!ReferenceEquals(Game1.game1, sentinelGame))
                {
                    failures.Add(
                        $"{fixture.Name} left Game1.game1 as `{Describe(Game1.game1)}` instead of the instance it found");
                }
                else
                {
                    if (!ReferenceEquals(HeadlessGameWorld.InstanceField("_locations").GetValue(sentinelGame), book))
                        failures.Add($"{fixture.Name} replaced the location book of a Game1 it did not create");
                    else if (book.Count != 1 || !ReferenceEquals(book[0], sentinelLocation))
                    {
                        failures.Add(
                            $"{fixture.Name} registered `{string.Join("|", book.Select(entry => entry?.Name ?? "<null>"))}` "
                            + "in the location book of a Game1 it did not create");
                    }

                    if (!ReferenceEquals(HeadlessGameWorld.InstanceField("instanceGameLocation").GetValue(sentinelGame), sentinelLocation))
                    {
                        failures.Add(
                            $"{fixture.Name} left Game1.currentLocation as `{Describe(HeadlessGameWorld.InstanceField("instanceGameLocation").GetValue(sentinelGame))}` "
                            + "on a Game1 it did not create");
                    }
                }

                HeadlessGameWorld.RestoreStatics(before);
            }
        }
        finally
        {
            HeadlessGameWorld.RestoreStatics(before);
        }

        string.Join(Environment.NewLine, failures).Should().BeEmpty(
            $"a fixture may only write the location book of the Game1 it built itself (population {fixtures.Count}; "
            + $"not covered: {string.Join(", ", uncovered)})");
    }

    /// <summary>
    /// Every nested disposable fixture type in this assembly, and - named rather than silently dropped - the ones whose
    /// factory needs arguments, which this gate therefore cannot construct.
    /// </summary>
    private static IReadOnlyList<Type> Fixtures(out IReadOnlyList<string> uncovered)
    {
        var covered = new List<Type>();
        var skipped = new List<string>();
        foreach (Type type in typeof(HeadlessGameWorld).Assembly.GetTypes())
        {
            if (!type.IsNested || !type.IsClass || !typeof(IDisposable).IsAssignableFrom(type)) continue;
            if (type.IsDefined(typeof(System.Runtime.CompilerServices.CompilerGeneratedAttribute), inherit: false)) continue;
            if (type.IsAbstract) continue;
            if (Factory(type) is not null) covered.Add(type);
            else skipped.Add($"{type.DeclaringType?.Name}.{type.Name}");
        }

        uncovered = skipped.OrderBy(name => name, StringComparer.Ordinal).ToArray();
        return covered.OrderBy(type => type.FullName, StringComparer.Ordinal).ToArray();
    }

    /// <summary>The fixture's parameterless static factory, or null when it needs arguments to build a world.</summary>
    private static MethodInfo? Factory(Type type) =>
        type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
            .FirstOrDefault(method => method.Name == "Create"
                && method.GetParameters().Length == 0
                && type.IsAssignableFrom(method.ReturnType));

    private static GameLocation NewLocation(string name)
    {
        var location = new GameLocation();
        typeof(GameLocation)
            .GetField("name", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(location, new Netcode.NetString(name));
        return location;
    }

    private static string Describe(object? value) => value switch
    {
        null => "<null>",
        GameLocation location => $"GameLocation:{location.Name}",
        Game1 => "Game1",
        _ => value.GetType().Name,
    };

    private static Exception Innermost(Exception error) =>
        error is TargetInvocationException { InnerException: { } inner } ? Innermost(inner) : error;
}

