using System.Text;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The byte-limit guard on DestinationSearch results is measured by an exact
/// field-by-field accumulation (no whole-payload string is materialized). These
/// tests pin that the accumulated size is byte-identical to serializing the
/// payload with the default encoder, for every result shape the guard can see.
/// </summary>
public sealed class DestinationSearchByteBudgetEquivalenceTests
{
    private static readonly BridgeScope Scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");
    private static readonly NavigationBindingContext Context = new("runtime_01", Scope, "generation_01", 1, DateTimeOffset.UtcNow);

    /// <summary>
    /// The reference measurement: what the previous implementation serialized
    /// (an anonymous payload, default serializer). The accumulation must match
    /// this exactly, including the PascalCase record property names of the
    /// selector/candidate records that live inside the anonymous object.
    /// </summary>
    private static int ReferenceSerializedUtf8Bytes(object payload) =>
        Encoding.UTF8.GetByteCount(System.Text.Json.JsonSerializer.Serialize(payload));

    private static void AssertBudgetMatches(DestinationSearchResult result)
    {
        object referencePayload = result.Status switch
        {
            "resolved" => new { status = result.Status, reason = result.Reason, destination = result.Destination },
            "candidates" => new { status = result.Status, reason = result.Reason, candidates = result.Candidates },
            _ => new { status = result.Status, reason = result.Reason },
        };
        DestinationSearchResultMeasurement.MeasureUtf8Bytes(result)
            .Should().Be(ReferenceSerializedUtf8Bytes(referencePayload),
                "the field-by-field byte budget must be byte-identical to serializing the payload");
    }

    [Fact]
    public void ResolvedResult_MatchesReferenceSerialization()
    {
        AssertBudgetMatches(DestinationSearchResult.Resolved("exact_current_locale",
            new DestinationSearchCandidate("Mine", "The Mines",
                new NavigationDestinationSelector("label", "Mine", null), "unknown")));
    }

    [Fact]
    public void ResolvedResultWithOpaqueSelector_MatchesReferenceSerialization()
    {
        AssertBudgetMatches(DestinationSearchResult.Resolved("exact_alias",
            new DestinationSearchCandidate("Mine West", null,
                new NavigationDestinationSelector("ref", null, "dr1_0123456789abcdef"), "unknown")));
    }

    [Fact]
    public void CandidatesResult_MatchesReferenceSerialization()
    {
        AssertBudgetMatches(DestinationSearchResult.WithCandidates("fuzzy_match",
            new[]
            {
                new DestinationSearchCandidate("Mine", "The Mines", new NavigationDestinationSelector("ref", null, "dr1_0001"), "unknown"),
                new DestinationSearchCandidate("Mines", "Mine Shaft", new NavigationDestinationSelector("ref", null, "dr1_0002"), "unknown"),
                new DestinationSearchCandidate("Mining Guild", null, new NavigationDestinationSelector("ref", null, "dr1_0003"), "unknown"),
            }));
    }

    [Fact]
    public void EmptyCandidatesResult_MatchesReferenceSerialization()
    {
        AssertBudgetMatches(DestinationSearchResult.WithCandidates("ambiguous_exact", Array.Empty<DestinationSearchCandidate>()));
    }

    [Fact]
    public void NotFoundAndBlockedAndInvalid_EachMatchReferenceSerialization()
    {
        AssertBudgetMatches(DestinationSearchResult.NotFound());
        AssertBudgetMatches(DestinationSearchResult.Unavailable());
        AssertBudgetMatches(DestinationSearchResult.Invalid());
    }

    [Fact]
    public void NonAsciiLabels_AreEscapedTheSameWayAsReferenceSerialization()
    {
        AssertBudgetMatches(DestinationSearchResult.Resolved("exact_current_locale",
            new DestinationSearchCandidate("罗宾的家", "罗宾",
                new NavigationDestinationSelector("label", "罗宾的家", null), "unknown")));
        AssertBudgetMatches(DestinationSearchResult.WithCandidates("fuzzy_match",
            new[]
            {
                new DestinationSearchCandidate("博物馆", "Museum", new NavigationDestinationSelector("ref", null, "dr1_00a1"), "unknown"),
            }));
    }

    [Fact]
    public void EscapingQuotesAndBackslashes_AreCountedLikeReferenceSerialization()
    {
        AssertBudgetMatches(DestinationSearchResult.Resolved("exact_current_locale",
            new DestinationSearchCandidate("Mine \"5\"", "Path\\Level",
                new NavigationDestinationSelector("label", "Mine \"5\"", null), "unknown")));
    }

    [Fact]
    public void LongLabels_NearTheBoundary_AreCountedExactly()
    {
        // 20 candidates x 90-char labels is far over the 2048 limit; the
        // measurement must agree with the reference serializer at that scale
        // (so the guard flips to blocked exactly when the real serialization
        // would), and it must stay exact across the boundary in both
        // directions.
        string longLabel = new string('x', 90);
        DestinationSearchResult over = DestinationSearchResult.WithCandidates("fuzzy_match",
            Enumerable.Range(0, 20)
                .Select(index => new DestinationSearchCandidate(longLabel + index.ToString("D2"), null,
                    new NavigationDestinationSelector("ref", null, "dr1_" + index.ToString("D6")), "unknown"))
                .ToArray());
        AssertBudgetMatches(over);
        DestinationSearchResultMeasurement.MeasureUtf8Bytes(over).Should().BeGreaterThan(2048,
            "the guard must keep a bloated result off the wire");

        // One candidate with a short label is comfortably under the limit.
        DestinationSearchResult under = DestinationSearchResult.WithCandidates("fuzzy_match",
            new[]
            {
                new DestinationSearchCandidate("Mine", null,
                    new NavigationDestinationSelector("ref", null, "dr1_000001"), "unknown"),
            });
        AssertBudgetMatches(under);
        DestinationSearchResultMeasurement.MeasureUtf8Bytes(under).Should().BeLessThanOrEqualTo(2048,
            "an ordinary result must stay admitted");
    }
}

/// <summary>Test-visible access to the internal byte-budget measurement.</summary>
internal static class DestinationSearchResultMeasurement
{
    internal static int MeasureUtf8Bytes(DestinationSearchResult result) =>
        DestinationSearchBudget.MeasureUtf8Bytes(result);
}