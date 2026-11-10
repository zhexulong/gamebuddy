using System;
using System.Collections.Generic;
using System.Reflection;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The one xunit collection every test class that builds a headless <c>Game1</c> world belongs to, and the one
/// declaration of the process-wide statics such a world writes.
///
/// <para>
/// A test world is a set of PROCESS-WIDE statics - <c>Game1.game1</c>, <c>_player</c>, <c>netWorldState</c>, the floor-
/// path table - so two classes that each build one overwrite each other, and a teardown that lands in the middle of the
/// other class's call reads as a NullReferenceException from inside the engine instead of as a failure of the code under
/// test. xunit runs every class in its own collection, in parallel, unless it is told otherwise; this name is how they
/// are told. It is a NAME and not a definition class because a collection needs no body.
/// </para>
///
/// <para>
/// Membership is by the fact the class shares, not by a list: a class that constructs a <c>GameLocation</c>, a
/// <c>Farmer</c> or a <c>Game1</c> for a fixture joins it, and a class that only reads source text or pure arithmetic
/// stays out - serialising those would buy nothing and cost the suite its wall clock.
/// </para>
///
/// <para>
/// THE SECOND RULE, AND THE ONE THIS SUITE KEPT BREAKING. Serialising the classes makes a stale static fail LATER
/// instead of concurrently, so every fixture must also leave the statics exactly as it found them - and xunit does not
/// promise an order, so "later" is a different class in every run. <see cref="GameStatics"/> and
/// <see cref="GameInstanceFields"/> are the population the gate in <c>HeadlessWorldStaticsGateTests</c> restores and
/// compares; a fixture that writes a static outside these lists is outside the gate, so the lists are the place to add
/// one.
/// </para>
/// </summary>
internal static class HeadlessGameWorld
{
    internal const string Collection = "stardew-headless-game-world";

    /// <summary>
    /// Every process-wide <c>Game1</c> static a headless world assigns. Measured 2026-11-10: a fixture that captured
    /// these AFTER building its world left <c>Game1.game1</c> and <c>netWorldState</c> installed, and a later class then
    /// resolved its own farmer's <c>currentLocation</c> by name into the stale location - six `enter_exit` cases and two
    /// approach-ring cases failed on a build whose only difference was the order xunit happened to pick.
    /// </summary>
    internal static readonly string[] GameStatics =
    {
        "game1", "netWorldState", "_locationLookup", "_player", "random", "recentMultiplayerRandom", "otherFarmers",
        "hudMessages", "locationContextData", "petData",
    };

    /// <summary>
    /// <c>Game1</c>'s own per-instance book. A fixture that writes these on an instance it did NOT create poisons that
    /// instance for whoever finds it next: the location it registers answers <c>getLocationFromName</c> for every later
    /// fixture that reuses the same name.
    /// </summary>
    internal static readonly string[] GameInstanceFields = { "instanceGameLocation", "_locations", "instanceOptions" };

    /// <summary>The statics as they are now, keyed by name, for a fixture (or the gate) to compare against later.</summary>
    internal static Dictionary<string, object?> CaptureStatics()
    {
        var captured = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (string name in GameStatics)
            captured[name] = Static(name).Get();
        return captured;
    }

    /// <summary>The statics as a fixture or the gate found them, written back.</summary>
    internal static void RestoreStatics(IReadOnlyDictionary<string, object?> captured)
    {
        foreach (KeyValuePair<string, object?> entry in captured)
            Static(entry.Key).Set(entry.Value);
    }

    /// <summary>
    /// One declared <c>Game1</c> static, by the name <see cref="GameStatics"/> publishes. Read and written through the
    /// engine's own declaration, which is a field for most of them and a property for <c>game1</c>.
    /// </summary>
    internal static (Func<object?> Get, Action<object?> Set) Static(string name)
    {
        FieldInfo? field = typeof(StardewValley.Game1).GetField(name, Any);
        if (field is not null) return (() => field.GetValue(null), value => field.SetValue(null, value));

        PropertyInfo property = typeof(StardewValley.Game1).GetProperty(name, Any)
            ?? throw new MissingMemberException(nameof(StardewValley.Game1), name);
        return (() => property.GetValue(null), value => property.SetValue(null, value));
    }

    /// <summary>
    /// Fails the fixture, by name, when the world it just built is not the world the engine statics answer from.
    ///
    /// <para>
    /// A fixture that assigns <c>actor.currentLocation</c> and then reads the product's answer is only testing its own
    /// world if the assignment stuck: <c>NetLocationRef</c> resolves the name it was given, so a location another class
    /// registered under the same name answers instead - and the product then reads a farm with none of this fixture's
    /// walls, doors or warps. Measured 2026-11-10: that read as two approach-ring and six `enter_exit` assertion
    /// failures in some runs and none in others, with no source change between them.
    /// </para>
    /// </summary>
    internal static void RequireBound(StardewValley.Farmer actor, StardewValley.GameLocation location)
    {
        if (ReferenceEquals(StardewValley.Game1.player, actor)
            && ReferenceEquals(StardewValley.Game1.player?.currentLocation, location))
        {
            return;
        }

        throw new InvalidOperationException(
            "world-not-bound"
            + $";player_is_actor={ReferenceEquals(StardewValley.Game1.player, actor)}"
            + $";location_is_world={ReferenceEquals(StardewValley.Game1.player?.currentLocation, location)}"
            + $";resolved={StardewValley.Game1.player?.currentLocation?.Name ?? "<null>"}"
            + $";world={location.Name}"
            + $";game1_null={StardewValley.Game1.game1 is null}"
            + $";locations={(StardewValley.Game1.game1?._locations is null ? "null" : string.Join("|", StardewValley.Game1.game1._locations.Select(entry => entry?.Name ?? "<null>")))}");
    }

    /// <summary>One declared per-instance field of a <c>Game1</c>, by the name <see cref="GameInstanceFields"/> publishes.</summary>
    internal static FieldInfo InstanceField(string name) =>
        typeof(StardewValley.Game1).GetField(name, Any)!;

    private const BindingFlags Any =
        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance;
}
