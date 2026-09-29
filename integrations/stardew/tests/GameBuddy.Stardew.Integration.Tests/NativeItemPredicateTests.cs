using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Pins the native per-item classification predicates.
///
/// These exist because accepting a single hard-coded item id narrows a native
/// category without failing anything: `dig_artifact_spot` discovery, identity
/// and admission all keyed on `(O)590`, so the `(O)SeedSpot` variant the engine
/// spawns at every artifact-spot site was invisible to the Agent and rejected at
/// execution even when it was pointed at one.
///
/// The tests are id-level on purpose: they run without a Game1 harness, and the
/// predicates are total over the id, so a wrong family member fails here rather
/// than silently at runtime.
/// </summary>
public sealed class NativeItemPredicateTests
{
    // --- artifact spot family ---

    [Theory]
    [InlineData("(O)590")] // artifact spot
    [InlineData("(O)SeedSpot")] // raccoon-seed variant, same dig branch
    public void IsArtifactSpotId_AcceptsBothNativeVariants(string qualifiedItemId)
    {
        NativeItemPredicates.IsArtifactSpotId(qualifiedItemId).Should().BeTrue();
    }

    [Theory]
    [InlineData("(O)2")] // stone litter, also breakable but not diggable
    [InlineData("(O)313")] // weed
    [InlineData("(O)294")] // twig
    [InlineData("(O)330")] // clay, a common artifact-spot DROP not a spot
    [InlineData("SeedSpot")] // must be qualified; the unqualified form is not an id
    [InlineData("")]
    [InlineData(null)]
    public void IsArtifactSpotId_RejectsEverythingElse(string? qualifiedItemId)
    {
        NativeItemPredicates.IsArtifactSpotId(qualifiedItemId).Should().BeFalse();
    }

    // --- twig family ---

    [Theory]
    [InlineData("(O)294")]
    [InlineData("(O)295")]
    [InlineData("(O)343")]
    [InlineData("(O)450")]
    public void IsTwigLitterId_AcceptsTheFourSpawnIds(string qualifiedItemId)
    {
        NativeItemPredicates.IsTwigLitterId(qualifiedItemId).Should().BeTrue();
    }

    [Theory]
    [InlineData("(O)2")] // stone, the sibling of the same spawn branch
    [InlineData("(O)590")] // artifact spot, skipped explicitly at the same spawn site
    [InlineData("(O)313")]
    [InlineData(null)]
    public void IsTwigLitterId_RejectsNonTwigIds(string? qualifiedItemId)
    {
        NativeItemPredicates.IsTwigLitterId(qualifiedItemId).Should().BeFalse();
    }

    // --- disjointness ---

    /// <summary>
    /// A single id must belong to at most one family. If two families overlapped,
    /// the scanner's precedence order would decide the kind instead of the item,
    /// and one of the two actions would be unusable.
    /// </summary>
    [Fact]
    public void Families_ArePairwiseDisjointOnEveryCandidateId()
    {
        string[] candidates = new[]
        {
            "(O)590", "(O)SeedSpot", "(O)294", "(O)295", "(O)343", "(O)450",
            "(O)2", "(O)4", "(O)6", "(O)8", "(O)10", "(O)12", "(O)14", "(O)25",
            "(O)313", "(O)330", "(O)674", "(O)685", "(O)710",
        };

        foreach (string id in candidates)
        {
            int families = 0;
            if (NativeItemPredicates.IsArtifactSpotId(id)) families++;
            if (NativeItemPredicates.IsTwigLitterId(id)) families++;
            families.Should().BeLessThanOrEqualTo(1, $"{id} must belong to at most one litter family");
        }
    }

    /// <summary>
    /// The artifact-spot variant must not be confused with the twig family, and
    /// vice versa: they are different native branches at the same spawn site.
    /// </summary>
    [Fact]
    public void ArtifactSpotAndTwigFamilies_NeverOverlap()
    {
        string[] artifactIds = new[] { "(O)590", "(O)SeedSpot" };
        string[] twigIds = new[] { "(O)294", "(O)295", "(O)343", "(O)450" };

        foreach (string id in artifactIds)
            NativeItemPredicates.IsTwigLitterId(id).Should().BeFalse($"{id} is an artifact spot, not a twig");
        foreach (string id in twigIds)
            NativeItemPredicates.IsArtifactSpotId(id).Should().BeFalse($"{id} is a twig, not an artifact spot");
    }
}
