using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewValley;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// ONE OBJECT, ONE FAMILY: a subject another family already publishes is published THERE and not again here.
///
/// <para>
/// WHY. The farmhouse's starter gift box is a <c>Chest</c> the location itself puts down
/// (<c>FarmHouse.AddStarterGiftBox</c>, FarmHouse.cs:140-181) with no item id at all, so its <c>QualifiedItemId</c>
/// migrates to <c>(O)-1</c> (<c>Item.MigrateLegacyItemId</c>, Item.cs:338-341). Measured 2026-11-23 (<c>round96</c>,
/// the save's own <c>FarmHouse</c> node: one object at <c>(3,7)</c>, <c>Chest</c>, <c>itemId -1</c>, <c>giftbox</c>,
/// <c>playerChest false</c>): the companion's <c>worldObjectTargets</c> carried that same box as
/// <c>non_removable_object</c> with <c>qualifiedItemId "(O)-1"</c> and the display 「错误物品 (-1)」, three lines under
/// the <c>chests</c> row that already named it from <c>chest.Name</c> with its fifteen parsnip seeds. Two spellings of
/// one object, and the reader got the wrong one.
/// </para>
///
/// <para>
/// THE HALF THAT KEEPS THIS FROM BEING A WAY TO HIDE THE ROOM. Withholding the row is only correct because the owning
/// family publishes the subject, so each case below asserts BOTH: the tile appears in the family that owns it, and not
/// in <c>worldObjectTargets</c> - plus an object NO sibling family owns (a twig) that must still arrive, so the case
/// cannot pass by publishing nothing. The population comes from
/// <see cref="ExecutionManager.SubjectsOwnedBySiblingFamilies"/>: every entry there is driven by a subject here and
/// asked whether ITS OWN publisher answered, so a family added to that table is checked without touching this file, and
/// an entry with no subject to drive it FAILS as unmeasured rather than passing quietly.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class WorldObjectRowsDoNotRepeatASiblingFamilyTests
{
    /// <summary>Litter an axe removes and no other family publishes - the falsifier, not the subject of the case.</summary>
    private const string TwigQualifiedItemId = "(O)294";

    /// <summary>The tile the twig stands on, beside the actor and clear of every owned subject.</summary>
    private const int TwigX = 8;
    private const int TwigY = 7;

    [Fact]
    public void EverySubjectASiblingFamilyOwnsIsPublishedThereAndNotInWorldObjectTargets()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(8, 8);
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.Axe), "(T)Axe", upgradeLevel: 0);

        // THE ROOM `round96` HELD, in the shapes the engine builds them: the vanilla starter gift box (no item id at
        // all - `PlaceChestOfKind` builds it the way `FarmHouse.cs:142` does) and the fixture's mannequin, plus the third
        // subject that has its own family. The twig is the object no sibling family names.
        List<(string What, int X, int Y, StardewValley.Object Subject)> subjects = new()
        {
            ("gift_box", 6, 7, world.PlaceChestOfKind(
                StardewValley.Objects.Chest.SpecialChestTypes.None, playerChest: false, giftbox: true, x: 6, y: 7,
                items: new[] { new ChestItem("(O)472", 15) })),
            ("mannequin", 9, 8, Identity(new StardewValley.Objects.Mannequin(), "(M)MannequinMale")),
            ("sign", 8, 9, Identity(new StardewValley.Objects.Sign(), "(BC)Sign")),
        };
        foreach ((_, int x, int y, StardewValley.Object subject) in subjects)
        {
            subject.TileLocation = new Vector2(x, y);
            world.Farm.objects[new Vector2(x, y)] = subject;
        }
        world.PlaceObjectAt(TwigX, TwigY, TwigQualifiedItemId, "Twig", category: -999);

        IReadOnlyList<BridgeWorldObjectTarget> published = FarmhandTargetDiscovery.DiscoverWorldObjectTargets(world.Actor, out int omitted);

        List<string> examined = new();
        List<string> failures = new();
        HashSet<string> drivenFamilies = new(StringComparer.Ordinal);
        foreach ((string what, int x, int y, StardewValley.Object subject) in subjects)
        {
            examined.Add($"{what}@{x},{y}");
            (string Family, string Discovery, Func<StardewValley.Object, bool> Owns)[] owners = ExecutionManager
                .SubjectsOwnedBySiblingFamilies.Where(entry => entry.Owns(subject)).ToArray();
            if (owners.Length != 1)
            {
                failures.Add($"{what}@{x},{y}: {owners.Length} entries of `SubjectsOwnedBySiblingFamilies` own it "
                    + $"({string.Join(",", owners.Select(owner => owner.Family))}), so it has no one family");
                continue;
            }

            (string Family, string Discovery, Func<StardewValley.Object, bool> Owns) owner = owners[0];
            drivenFamilies.Add(owner.Family);
            int ownerRows = Tiles(world.DiscoverFamily(owner.Discovery)).Count(tile => tile == (x, y));
            if (ownerRows == 0)
                failures.Add($"{owner.Family} published no row for {what}@{x},{y}, so withholding it from `worldObjectTargets` "
                    + "would delete the subject from the snapshot instead of moving it to its own family");
            if (published.Any(row => row.X == x && row.Y == y))
                failures.Add($"`worldObjectTargets` published {what}@{x},{y} as well - one object, two spellings: "
                    + $"{string.Join(",", published.Where(row => row.X == x && row.Y == y).Select(row => $"{row.Kind}:{row.QualifiedItemId}:{row.DisplayName}"))}");
        }

        foreach ((string family, _, _) in ExecutionManager.SubjectsOwnedBySiblingFamilies)
        {
            if (!drivenFamilies.Contains(family))
                failures.Add($"{family} owns a subject no case here drives, so this gate does not measure that family");
        }

        string population = $"examined {examined.Count} siblings-owned subjects ({string.Join(",", examined)}) "
            + $"against {drivenFamilies.Count} owning families ({string.Join(",", drivenFamilies.OrderBy(name => name, StringComparer.Ordinal))}) "
            + $"+ 1 falsifier (twig@{TwigX},{TwigY}); omitted={omitted}; "
            + $"worldObjectTargets=[{string.Join(" ", published.Select(row => $"{row.X},{row.Y}:{row.Kind}:{row.QualifiedItemId}"))}]";
        failures.Should().BeEmpty(population);

        published.Should().Contain(
            row => row.X == TwigX && row.Y == TwigY && row.QualifiedItemId == TwigQualifiedItemId,
            $"an object no sibling family publishes still arrives from this lane, or the walk is broken rather than narrowed: {population}");
        omitted.Should().Be(
            subjects.Count,
            $"each owned subject is COUNTED rather than dropped in silence, and the twig is neither owned nor capped: {population}");
    }

    /// <summary>
    /// The identity fields the projections read, written explicitly: no content manager is loaded here, so a real
    /// constructor that resolves a Data row would answer the Error Item instead of the type's own identity.
    /// </summary>
    private static T Identity<T>(T subject, string qualifiedItemId) where T : StardewValley.Object
    {
        // `ItemId` clears the qualified cache, so the qualified value is written AFTER it.
        subject.ItemId = qualifiedItemId[(qualifiedItemId.IndexOf(')') + 1)..];
        typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(subject, qualifiedItemId);
        return subject;
    }

    /// <summary>The tiles one published family names, read off the rows' own `X`/`Y` rather than per row type.</summary>
    private static IReadOnlyList<(int X, int Y)> Tiles(object rows) =>
        ((System.Collections.IEnumerable)rows).Cast<object>()
            .Select(row => (
                X: (int)row.GetType().GetProperty("X", typeof(int))!.GetValue(row)!,
                Y: (int)row.GetType().GetProperty("Y", typeof(int))!.GetValue(row)!))
            .ToArray();
}
