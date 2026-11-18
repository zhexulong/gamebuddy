namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The spellings that mean "this handler begins a walk", declared once for the gates that read handler source.
///
/// <para>
/// Six markers because there are six seams, not because the fact has six meanings: the tool family's approach leg,
/// the building-contact form of it, <c>pickup_item</c>'s own debris approach, the tile-target request seam, and the
/// two shapes it hands on to. They live here rather than inside one gate because two gates ask the same question
/// about the same text - <c>ApproachDeclarationCoverageTests</c> asks whether every walking row SAYS it walks, and
/// <c>ApproachBeforeRefusalTests</c> asks whether every row that declares a reach either walks or says what stopped
/// it - and a second copy of the list is a disagreement scheduled for the day a seventh seam appears.
/// </para>
/// </summary>
internal static class HandlerApproachFacts
{
    internal static readonly string[] ApproachLegMarkers =
    {
        "TryBeginToolApproach(",
        "TryBeginBuildingApproach(",
        "new LocalMoveSpec(",
        "new LocalApproachSpec(",
        "new LocalItemPickupSpec(",
        "this.RequestLocalTileTarget(",
    };

    /// <summary>Does this handler body begin a walk? Comments must already be stripped by the caller.</summary>
    internal static bool BeginsAnApproachLeg(string body) =>
        Array.Exists(ApproachLegMarkers, marker => body.Contains(marker, StringComparison.Ordinal));
}
