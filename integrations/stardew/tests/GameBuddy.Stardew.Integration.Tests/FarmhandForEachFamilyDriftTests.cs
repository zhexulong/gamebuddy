using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE FAMILY A LOOP NAMES IS THE SNAPSHOT'S OWN SPELLING, and this gate derives that population from the snapshot instead
/// of restating it.
///
/// <para>
/// Measured 2026-11-10 (`round42`, day 6): a `water_crop` loop refused eight rows as
/// `row_target_identity_unavailable:water_crop:croptargets`, and the lowercase family in that code read as a family id that
/// could never match the snapshot's `cropTargets`. The lowering is the reason grammar's (a node's reason code is
/// lowercase-only, so every family named in one is projected), but nothing was checking the other half: that the family the
/// SEAM uses is the family the SNAPSHOT publishes, spelled the same way. A family renamed on one side and not the other
/// fails closed as "no identity at this tile" - a silent, plausible answer - which is exactly the mismatch a permissive,
/// case-insensitive match would keep hidden.
/// </para>
/// <para>
/// WHY A GATE AND NOT A LIST. The population is the snapshot's own declaration: every property that carries a list of
/// targets, named through the SERIALIZER'S naming policy (the same one that writes the wire field). A family added to the
/// snapshot, renamed, or dropped is examined the moment it exists, and the failure names the member that drifted. An empty
/// population is BLOCKED rather than green, because a gate that examines nothing agrees with itself.
/// </para>
/// </summary>
public sealed class FarmhandForEachFamilyDriftTests
{
    [Fact]
    public void EveryFamilyALoopCanNameIsOneTheSnapshotPublishesWithThatExactSpelling()
    {
        string[] published = SnapshotFamilies();
        published.Should().NotBeEmpty("a published-family gate whose population is empty agrees with itself");
        published.Should().HaveCountGreaterThan(
            50,
            $"the snapshot's target families are this gate's population, and a near-empty population means the derivation broke rather than that the surface shrank (found {published.Length})");

        // The families the row identity seam mints an identity for. Every one of them must be a family this snapshot
        // publishes, ordinal-equal: `cropTargets` and `croptargets` are two families, and only one of them exists.
        string[] answered =
        {
            FarmhandForEachFarmWorld.CropTargetsFamily,
            FarmhandForEachFarmWorld.HarvestTargetsFamily,
            FarmhandForEachFarmWorld.SeedTargetsFamily,
        };
        answered.Except(published, StringComparer.Ordinal).Should().BeEmpty(
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
    /// The snapshot's own family declaration: every property that carries a list of targets, in the spelling the wire
    /// carries, taken from the serializer's naming policy rather than from a second list of names.
    /// </summary>
    internal static string[] SnapshotFamilies() => typeof(BridgeSnapshot)
        .GetProperties()
        .Where(property => property.PropertyType.IsGenericType
            && property.PropertyType.GetGenericTypeDefinition() == typeof(IReadOnlyList<>))
        .Select(property => BridgeProtocol.JsonOptions.PropertyNamingPolicy!.ConvertName(property.Name))
        .ToArray();
}
