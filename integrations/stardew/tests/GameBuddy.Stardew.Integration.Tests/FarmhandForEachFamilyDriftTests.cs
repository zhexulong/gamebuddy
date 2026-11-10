using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;
using Xunit.Abstractions;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE FAMILY A LOOP NAMES IS THE CATALOGUE'S OWN DECLARATION, and this gate derives that population instead of restating it.
///
/// <para>
/// Measured 2026-11-10 (`round42`, day 6): a `water_crop` loop refused eight rows as
/// `row_target_identity_unavailable:water_crop:croptargets`, and the lowercase family in that code read as a family id that
/// could never match the snapshot's `cropTargets`. The lowering is the reason grammar's (a node's reason code is
/// lowercase-only, so every family named in one is projected), but nothing was checking the other half: that the family the
/// SEAM uses is the family the SNAPSHOT publishes, spelled the same way.
/// </para>
/// <para>
/// Measured 2026-11-11 (`round44`, minute 4): sixty `cut_weeds` rows over a 3x20 strip, every one refused as
/// `row_target_identity_unavailable:cut_weeds:weedtargets`. `cut_weeds` is not a broken family - it is a family the row
/// identity seam had no arm for, because the seam knew only the four actions `3d249ff1` covered. A loop is only worth
/// writing for the actions that clear a patch, so the population of this gate is EVERY action whose descriptor declares a
/// target family, and each one must now either mint a row identity or carry a stated reason this file can read.
/// </para>
/// <para>
/// WHY A GATE AND NOT A LIST. The population is <see cref="FarmhandActionCatalog.Registrations"/>'s own
/// <c>TargetFamily</c> declarations and the seam's own two tables (<see cref="FarmhandForEachFarmWorld.MintedFamilies"/>,
/// <see cref="FarmhandForEachFarmWorld.ReasonedFamilies"/>). An action added with a family is examined the moment it exists,
/// and the failure names the action and the family that drifted. An empty population is BLOCKED rather than green, because
/// a gate that examines nothing agrees with itself.
/// </para>
/// </summary>
public sealed class FarmhandForEachFamilyDriftTests
{
    private readonly ITestOutputHelper output;

    public FarmhandForEachFamilyDriftTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>
    /// Every action that declares a target family either mints a row identity through that family, or is refused with a
    /// reason that says why that family cannot be addressed per row.
    ///
    /// <para>
    /// THREE BUCKETS, EACH DERIVED. <b>Loopable</b>: the action declares no <c>expectedTargetId</c> (its tile IS its target,
    /// so the seam is never asked) or its family is minted. <b>Reasoned</b>: the action needs an identity and the seam states
    /// why its family has none, so the row's refusal says something a caller can act on. <b>Drift</b>: neither - the family
    /// reaches the row as the generic `row_target_identity_unavailable`, which says nothing about why, and that is what this
    /// assertion fails on.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryActionThatDeclaresATargetFamilyEitherMintsARowIdentityOrCarriesAStatedReason()
    {
        IReadOnlyList<string> minted = FarmhandForEachFarmWorld.MintedFamilies;
        IReadOnlyList<string> reasoned = FarmhandForEachFarmWorld.ReasonedFamilies;
        FamilyAction[] familyActions = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor?.TargetFamily is not null)
            .Select(registration => new FamilyAction(
                registration.ActionId,
                registration.Descriptor!.TargetFamily!,
                registration.Descriptor.Arguments.Any(argument => string.Equals(argument.Name, "expectedTargetId", StringComparison.Ordinal))))
            .ToArray();

        familyActions.Should().NotBeEmpty("the catalogue's own family declarations are this gate's population, and a gate that examines nothing agrees with itself");
        minted.Should().NotBeEmpty("a mint list that names nothing would make every family below carry a reason for not being addressed");

        FamilyAction[] asks = familyActions.Where(action => action.AsksForAnIdentity).ToArray();
        FamilyAction[] loopable = familyActions.Where(action => !action.AsksForAnIdentity
            || minted.Contains(action.Family, StringComparer.Ordinal)).ToArray();
        FamilyAction[] withReason = asks.Where(action => !minted.Contains(action.Family, StringComparer.Ordinal)
            && reasoned.Contains(action.Family, StringComparer.Ordinal)).ToArray();
        FamilyAction[] drift = asks.Where(action => !minted.Contains(action.Family, StringComparer.Ordinal)
            && !reasoned.Contains(action.Family, StringComparer.Ordinal)).ToArray();

        string line = string.Create(
            CultureInfo.InvariantCulture,
            $"family-actions examined {familyActions.Length} · loopable {loopable.Length} · with a reason {withReason.Length}");
        this.output.WriteLine(line);

        drift.Should().BeEmpty(
            $"{line}. An action that declares `expectedTargetId` over a family this seam neither mints nor states a reason "
            + "for answers the row with the generic `row_target_identity_unavailable`, which a caller cannot tell from a "
            + "family that needs a reader it has not got. Mint the family from its own publisher in FarmhandForEachFarmWorld, "
            + "or state the reason there. Drifting actions: "
            + string.Join(", ", drift.Select(action => $"{action.ActionId} -> {action.Family}")));

        // NO FACT GETS TWO SPELLINGS: a family in both tables would answer whichever check ran first, and the reason would
        // never expire. `minted` wins at runtime (CanNameFamily is asked first), so the pair is invisible there.
        minted.Intersect(reasoned, StringComparer.Ordinal).Should().BeEmpty(
            "a family the seam mints cannot also carry a reason for not being addressable");

        // AN EXEMPTION EXPIRES: a reason whose family no action declares any more is a statement about a family that no
        // longer exists on the surface, and it would sit there explaining nothing.
        string[] declared = familyActions.Select(action => action.Family).Distinct(StringComparer.Ordinal).ToArray();
        reasoned.Except(declared, StringComparer.Ordinal).Should().BeEmpty(
            "a stated reason outlives its fact as soon as no action declares that family; remove the entry rather than "
            + "leaving a rule for a family nobody can name");
    }

    /// <summary>
    /// The families a loop can name are families the snapshot publishes, ordinal-equal: `cropTargets` and `croptargets` are
    /// two families, and only one of them exists.
    /// </summary>
    [Fact]
    public void EveryFamilyALoopCanNameIsOneTheSnapshotPublishesWithThatExactSpelling()
    {
        string[] published = SnapshotFamilies();
        published.Should().NotBeEmpty("a published-family gate whose population is empty agrees with itself");
        published.Should().HaveCountGreaterThan(
            50,
            $"the snapshot's target families are this gate's population, and a near-empty population means the derivation broke rather than that the surface shrank (found {published.Length})");

        FarmhandForEachFarmWorld.MintedFamilies.Except(published, StringComparer.Ordinal).Should().BeEmpty(
            "the seam names a family by the spelling the snapshot publishes it under; a difference of case can never match, and a case-insensitive lookup would hide the next mismatch instead of naming it");

        // The other direction: an action whose descriptor declares a family the snapshot does not publish is addressing
        // rows nobody can observe, and a loop over it would be refused for a family that does not exist.
        string[] declared = FarmhandActionCatalog.Registrations
            .Select(registration => registration.Descriptor?.TargetFamily)
            .Where(family => family is not null)
            .Select(family => family!)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        declared.Should().NotBeEmpty("the catalogue is the seam's other half and must declare families at all");
        declared.Except(published, StringComparer.Ordinal).Should().BeEmpty(
            "an action whose `targetFamily` the snapshot does not publish addresses a family no caller can read");
    }

    /// <summary>
    /// ONE IDENTITY PER FAMILY, AND IT IS THE FAMILY'S OWN: for every family this seam mints, the world builds an occupant,
    /// that family's REAL `Discover*` publishes a row for it, and the id the SEAM mints for that row's tile is the id the
    /// row carries.
    ///
    /// <para>
    /// This is the assertion a second hash cannot pass. The expectation is not restated here - it is the publisher's own
    /// output, read through the production discovery method - so a seam that computed its own id would have to agree with
    /// the publisher forever to stay green, which is exactly what "one function, one row" means.
    /// </para>
    /// <para>
    /// TWO FAMILIES CANNOT BE PUBLISHED BY THIS PROCESS, and even that is a measured claim: each exemption states its
    /// blocker and the general gate asserts the blocker still holds, so teaching the harness to publish the row turns this
    /// red instead of leaving a family quietly unexamined behind an explanation that has stopped being true.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryMintedFamilyMintsTheIdentityItsOwnPublisherPublishes()
    {
        PublisherThrows.Keys.Except(FarmhandForEachFarmWorld.MintedFamilies, StringComparer.Ordinal).Should().BeEmpty(
            "an exemption for a family this seam no longer mints has outlived its fact and must be deleted");
        PublisherPublishesNothing.Keys.Except(FarmhandForEachFarmWorld.MintedFamilies, StringComparer.Ordinal).Should().BeEmpty(
            "an exemption for a family this seam no longer mints has outlived its fact and must be deleted");

        int rowsChecked = 0;
        foreach (string family in FarmhandForEachFarmWorld.MintedFamilies)
        {
            using TargetFamilyWorld world = TargetFamilyWorld.Create();
            world.PopulateFor(family);
            if (PublisherThrows.TryGetValue(family, out string? blocked))
            {
                Action publish = () => world.Rows(family);
                publish.Should().Throw<Exception>($"{blocked}; the exemption is only honest while that is still true");
                continue;
            }
            IReadOnlyList<object> rows = world.Rows(family);
            if (PublisherPublishesNothing.TryGetValue(family, out string? nothing))
            {
                rows.Should().BeEmpty($"{nothing}; the exemption is only honest while that is still true");
                continue;
            }
            rows.Should().NotBeEmpty(
                $"{family} is a family this seam mints, so its own discovery must publish a row for the world this file "
                + $"builds for it ({world.Describe(family)})");
            foreach (object row in rows)
            {
                int x = RowField<int>(row, "X");
                int y = RowField<int>(row, "Y");
                string published = RowField<string>(row, "TargetId");
                SeamOver(world).TargetIdFor(family, x, y, declaredArguments: null).Should().Be(
                    published,
                    $"the row at {x},{y} of {family} must carry the identity that family publishes - one function, not a second hash");
                rowsChecked++;
            }
        }

        string line = string.Create(
            CultureInfo.InvariantCulture,
            $"minted families {FarmhandForEachFarmWorld.MintedFamilies.Count} · rows cross-checked {rowsChecked} · unpublishable here {PublisherThrows.Count + PublisherPublishesNothing.Count}");
        this.output.WriteLine(line);
        rowsChecked.Should().BeGreaterThan(0, $"{line}: a cross-check that compared nothing agrees with itself");
    }

    /// <summary>
    /// The snapshot's own family declaration: every property that carries a list of targets, in the spelling the wire
    /// carries, taken from the serializer's naming policy rather than from a second list of names.
    /// </summary>
    internal static string[] SnapshotFamilies() => typeof(BridgeSnapshot)
        .GetProperties()
        .Where(property => property.PropertyType.IsGenericType
            && property.PropertyType.GetGenericTypeDefinition() == typeof(IReadOnlyList<>))
        .Select(property => BridgeProtocol.JsonOptions.PropertyNamingPolicy!.ConvertName(property.Name))
        .ToArray();

    private static T RowField<T>(object row, string name) =>
        (T)row.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.Public)!.GetValue(row)!;

    /// <summary>
    /// The families whose `Discover*` THROWS in this process, each with the measured blocker, so the cross-check above can
    /// say what it did not examine rather than reporting a smaller population as a complete one.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> PublisherThrows = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [FarmhandForEachFarmWorld.HarvestTargetsFamily] =
            "`DiscoverHarvestTargets` resolves the harvest item through `ItemRegistry.Create`, which reads the item "
            + "type-definition registry populated from Data/Objects at startup (measured: KeyNotFoundException \"No item type "
            + "definition found\"), and this process never loads it",
    };

    /// <summary>
    /// The families whose `Discover*` publishes NOTHING in this process, each with the measured blocker.
    ///
    /// `seedTargets` is the one family whose identity names the caller's selection as well as the tile, and the family only
    /// offers a tile the seed can actually be planted on - an answer `HoeDirt.canPlantThisSeedHere` takes from Data/Crops,
    /// which this process never loads, so every candidate tile is refused before a row exists. The MINT is proved at the
    /// dispatch level instead: `ForEachNodeExecutionTests` runs a `plant_seed` loop and asserts each row carries
    /// <see cref="ExecutionManager.BuildSeedTargetId"/> for its own slot and tile.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> PublisherPublishesNothing = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [FarmhandForEachFarmWorld.SeedTargetsFamily] =
            "`DiscoverSeedTargets` admits a tile only where `HoeDirt.canPlantThisSeedHere` answers true, and that reads "
            + "Data/Crops, which this process never loads",
    };

    /// <summary>The seam, reading the world this file just populated: the same type the Mod hands a live pass.</summary>
    private static IFarmhandForEachWorld SeamOver(TargetFamilyWorld world) =>
        new FarmhandForEachFarmWorld(world.Farm, new HashSet<string>(StringComparer.Ordinal), () => false);

    /// <summary>One action and the family its own descriptor declares: the pair this gate is determined per.</summary>
    private readonly record struct FamilyAction(string ActionId, string Family, bool AsksForAnIdentity);
}
