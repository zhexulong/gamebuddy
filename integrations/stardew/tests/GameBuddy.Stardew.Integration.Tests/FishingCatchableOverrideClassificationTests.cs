using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The reader's ONE structural premise — "does this location's own class sample fish itself?" — held against the engine's
/// own type table.
///
/// <para>
/// WHY THIS IS A GATE AND NOT A TEST. The reader refuses to publish a set on any location whose class answers
/// <c>getFish</c> itself, because such a class can return a species the two fish tables do not name, and a set that
/// silently omitted one would accuse the engine of an impossibility. The population is therefore the engine's OWN
/// assembly: every concrete <c>GameLocation</c> subclass it ships is asked, so a location class added by a game update or
/// by a mod is covered the day it exists instead of the day someone remembers it. The ground truth is read from metadata
/// (does THIS type declare <c>getFish</c>?), which is a different question from the one the reader answers (which method
/// does an instance of this type end at?), so the two are not the same fact spelled twice.
/// </para>
///
/// <para>
/// WHAT IT LOOKED LIKE BEFORE. The reader asked <c>Type.GetMethod("getFish", Type[])</c> with a hand-written parameter
/// list that did not match the engine's signature, so the lookup answered null for EVERY type and the classification said
/// "this class has its own sampler" about all ~200 of them. The refusal branch of the <c>fish_here</c> admission guard was
/// unreachable, the <c>LocationFish</c> lookup never published a species anywhere, and the live-run parity half answered
/// <c>not_measured</c> on the only world this action has. One wrong overload made a whole reader read as "quietly
/// cautious" instead of broken, which is why the assertion below is the type table rather than one example.
/// </para>
/// </summary>
public sealed class FishingCatchableOverrideClassificationTests
{
    private readonly ITestOutputHelper output;

    public FishingCatchableOverrideClassificationTests(ITestOutputHelper output) => this.output = output;

    /// <summary>The engine's own sampler, and the name the classification must look up.</summary>
    private const string SamplerName = "getFish";

    /// <summary>The five location classes this version of the engine gives their own sampler.</summary>
    private static readonly string[] KnownOwnSamplers =
    {
        "StardewValley.Farm",
        "StardewValley.Locations.MineShaft",
        "StardewValley.Locations.Railroad",
        "StardewValley.Locations.IslandLocation",
        "StardewValley.Locations.IslandSouthEast",
    };

    /// <summary>
    /// Every concrete location the engine ships, classified the same way the reader classifies it, against the metadata's
    /// own answer.
    /// </summary>
    [Fact]
    public void EveryLocationClassTheEngineShipsIsClassifiedByItsOwnMetadata()
    {
        List<Type> locations = typeof(StardewValley.GameLocation).Assembly
            .GetTypes()
            .Where(static type => typeof(StardewValley.GameLocation).IsAssignableFrom(type) && !type.IsAbstract)
            .OrderBy(static type => type.FullName, StringComparer.Ordinal)
            .ToList();

        // Zero population is blocked, never green: an engine this cannot enumerate is a blocked reading, not agreement.
        // The floor is a shape, not today's count - a tree that ships forty locations is still a population.
        locations.Should().HaveCountGreaterThan(30, "the population is the engine's own location classes");

        List<string> declarers = locations
            .Where(type => type != typeof(StardewValley.GameLocation) && Declares(type))
            .Select(static type => type.FullName!)
            .ToList();
        List<string> affected = locations.Where(DeclaresItsOwnOverride).Select(static type => type.FullName!).ToList();
        this.output.WriteLine(
            $"examined {locations.Count} location classes; {declarers.Count} declare {SamplerName}; {affected.Count} end at an override");
        foreach (string name in declarers) this.output.WriteLine($"  declares {SamplerName}: {name}");

        // The premise the reader's docblock states, read from metadata rather than restated here: if the engine's own set
        // of overriders changed, this line is where the change is announced.
        declarers.Should().BeEquivalentTo(KnownOwnSamplers, "the reader's docblock names exactly these five");
        affected.Should().NotBeEmpty("a class that inherits an override still ends at it");

        List<string> drifted = locations
            .Where(type => FishingCatchableQuery.DeclaresOwnFishSampler(type) != DeclaresItsOwnOverride(type))
            .Select(type => $"{type.FullName}: engine declares={DeclaresItsOwnOverride(type)}, reader answered={FishingCatchableQuery.DeclaresOwnFishSampler(type)}")
            .ToList();

        drifted.Should().BeEmpty(
            "a location class the reader misclassifies either silences the reader or lets it publish a set the engine can leave");
    }

    /// <summary>
    /// The two answers the reader's refusal turns on, named so a reader of a failure knows which direction broke.
    /// </summary>
    [Fact]
    public void TheBaseSamplerIsTheTablePathAndAFarmWithoutARedirectIsToo()
    {
        FishingCatchableQuery.DeclaresOwnFishSampler(typeof(StardewValley.GameLocation))
            .Should().BeFalse("the engine's own sampler IS the Data/Locations path");
        FishingCatchableQuery.DeclaresOwnFishSampler(typeof(StardewValley.Locations.FarmHouse))
            .Should().BeFalse("an interior inherits the engine's sampler and can add nothing");
        FishingCatchableQuery.DeclaresOwnFishSampler(typeof(StardewValley.Locations.Beach))
            .Should().BeFalse("a location with no override is the table and nothing else");
        FishingCatchableQuery.DeclaresOwnFishSampler(typeof(StardewValley.Farm))
            .Should().BeTrue("the farm answers it itself, whether or not the answer is a redirect");
        // WHICH type answers is the fact the farm's redirect precision turns on, so it is asserted rather than assumed:
        // a mod farm type that inherits Farm.getFish must be decided by Farm's own logic.
        FishingCatchableQuery.OwnFishSamplerDeclaredBy(typeof(StardewValley.Farm))
            .Should().Be(typeof(StardewValley.Farm));
        FishingCatchableQuery.OwnFishSamplerDeclaredBy(typeof(StardewValley.Locations.Beach))
            .Should().Be(typeof(StardewValley.GameLocation), "an inheriting location ends at the engine's own sampler");
    }

    /// <summary>
    /// Whether the engine's own metadata says this type's sampler is an OVERRIDE rather than the base method - walked up
    /// the base chain to the first type that declares it. <c>GameLocation</c> declares the method and is therefore not an
    /// override of itself, while a class that merely INHERITS an override (the engine's <c>Caldera</c> inherits
    /// <c>IslandLocation</c>'s) still ends at that override, which is the distinction the reader's whole classification
    /// turns on. The walk is spelled out here rather than asked of reflection with a signature, because the signature is
    /// exactly what the reader's own lookup could get wrong.
    /// </summary>
    private static bool DeclaresItsOwnOverride(Type type)
    {
        for (Type? cursor = type; cursor is not null && cursor != typeof(object); cursor = cursor.BaseType)
        {
            if (Declares(cursor)) return cursor != typeof(StardewValley.GameLocation);
        }
        return false;
    }

    /// <summary>Whether the engine's own metadata says this type declares the sampler rather than inheriting it.</summary>
    private static bool Declares(Type type) =>
        type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            .Any(method => method.Name == SamplerName);
}
