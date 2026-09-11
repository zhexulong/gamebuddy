using System.Text;
using System.Text.Json;

namespace GameBuddy.Stardew.Navigation;

/// <summary>
/// Pure bounded projection for local scene observations. Candidate ranking is
/// deterministic and based only on copied facts supplied by the caller.
/// </summary>
internal sealed class SceneObservationProjection
{
    internal const int DefaultRadius = 15;
    internal const int MaximumRadius = 30;
    internal const int MaximumAffordances = 20;
    internal const int MaximumPayloadUtf8Bytes = 2048;

    private readonly SceneObservationStore references;

    internal SceneObservationProjection(SceneObservationStore references)
    {
        this.references = references ?? throw new ArgumentNullException(nameof(references));
    }

    internal SceneObservationProjectionResult Observe(
        SceneObservationContext context,
        SceneObservationInput input,
        int? radius = null)
    {
        int effectiveRadius = radius ?? DefaultRadius;
        if (effectiveRadius is < 0 or > MaximumRadius)
            return Invalid(context, "scene_observation_invalid");
        if (!input.IsValid || !context.ScopeIdentity.IsValid || context.ObservationSequence <= 0)
            return Invalid(context, "scene_observation_invalid");
        if (!StringComparer.Ordinal.Equals(context.LocationName, input.CurrentRegion)
            && string.IsNullOrWhiteSpace(context.LocationName))
            return Invalid(context, "scene_observation_invalid");
        if (!this.references.TryBeginObservation(context, out string beginReason))
            return Invalid(context, beginReason);

        var ranked = input.Candidates
            .Where(candidate => candidate.IsValid
                && StringComparer.Ordinal.Equals(candidate.LocationName, context.LocationName))
            .Select(candidate => ToRankedCandidate(candidate, input.ActorTileX, input.ActorTileY, effectiveRadius))
            .Where(candidate => candidate is not null)
            .Select(candidate => candidate!)
            .OrderBy(candidate => candidate.Distance)
            .ThenBy(candidate => candidate.Priority)
            .ThenBy(candidate => SceneAffordanceKindWire.ToWireValue(candidate.Kind), StringComparer.Ordinal)
            .ThenBy(candidate => candidate.Name, StringComparer.Ordinal)
            .ThenBy(candidate => candidate.OpaqueEntityIdentity, StringComparer.Ordinal)
            .ToArray();

        var affordances = new List<SceneAffordanceProjection>(Math.Min(ranked.Length, MaximumAffordances));
        bool partial = false;
        foreach (RankedCandidate candidate in ranked)
        {
            if (affordances.Count >= MaximumAffordances)
            {
                partial = true;
                break;
            }

            if (!this.references.TryIssue(context, candidate.Source, out string? reference, out _))
                return Invalid(context, "scene_observation_invalid");

            affordances.Add(new SceneAffordanceProjection(
                reference!,
                SceneAffordanceKindWire.ToWireValue(candidate.Source.Kind),
                candidate.Source.Name,
                candidate.Distance,
                SceneDirectionWire.ToWireValue(candidate.Direction),
                candidate.Source.ActionHint));
        }

        SceneObservationProjectionResult result = BuildResult(
            context,
            affordances,
            partial,
            partial ? "maximum_affordances" : null);
        if (result.PayloadUtf8Bytes <= SceneObservationProjection.MaximumPayloadUtf8Bytes)
            return result;

        while (affordances.Count > 0)
        {
            affordances.RemoveAt(affordances.Count - 1);
            result = BuildResult(context, affordances, partial: true, truncatedReason: "payload_limit");
            if (result.PayloadUtf8Bytes <= SceneObservationProjection.MaximumPayloadUtf8Bytes)
                return result;
        }

        return BuildResult(context, Array.Empty<SceneAffordanceProjection>(), partial: true, truncatedReason: "payload_limit");
    }

    private static RankedCandidate? ToRankedCandidate(
        SceneAffordanceSource source,
        int actorTileX,
        int actorTileY,
        int radius)
    {
        long distance = Math.Abs((long)source.TileX - actorTileX)
            + Math.Abs((long)source.TileY - actorTileY);
        if (distance > radius || distance > int.MaxValue)
            return null;

        SceneDirection direction = source.TileX == actorTileX && source.TileY == actorTileY
            ? SceneDirection.CurrentTile
            : Math.Abs((long)source.TileX - actorTileX) >= Math.Abs((long)source.TileY - actorTileY)
                ? source.TileX < actorTileX ? SceneDirection.West : SceneDirection.East
                : source.TileY < actorTileY ? SceneDirection.North : SceneDirection.South;
        return new RankedCandidate(source, (int)distance, direction);
    }

    private static SceneObservationProjectionResult BuildResult(
        SceneObservationContext context,
        IReadOnlyList<SceneAffordanceProjection> affordances,
        bool partial,
        string? truncatedReason)
    {
        string summary = affordances.Count == 0
            ? $"Nothing actionable is visible in {context.LocationName}."
            : $"{affordances.Count} actionable {(affordances.Count == 1 ? "object" : "objects")} visible in {context.LocationName}.";
        var result = new SceneObservationProjectionResult(
            context.LocationName,
            context.ScopeIdentity.LocationName,
            affordances,
            summary,
            partial,
            truncatedReason,
            context,
            0);
        return result with { PayloadUtf8Bytes = MeasurePayload(result) };
    }

    private static SceneObservationProjectionResult Invalid(SceneObservationContext context, string reason) =>
        new(
            context.LocationName,
            context.ScopeIdentity.LocationName,
            Array.Empty<SceneAffordanceProjection>(),
            string.Empty,
            false,
            reason,
            context,
            0);

    private static int MeasurePayload(SceneObservationProjectionResult result)
    {
        object payload = new
        {
            currentLocation = result.CurrentLocation,
            currentRegion = result.CurrentRegion,
            affordances = result.Affordances,
            summary = result.Summary,
            partial = result.IsPartial,
            truncatedReason = result.TruncatedReason,
        };
        return Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(payload));
    }

    private sealed record RankedCandidate(
        SceneAffordanceSource Source,
        int Distance,
        SceneDirection Direction)
    {
        internal SceneAffordanceKind Kind => this.Source.Kind;
        internal string Name => this.Source.Name;
        internal string OpaqueEntityIdentity => this.Source.OpaqueEntityIdentity;
        internal int Priority => this.Source.Priority;
    }
}

internal sealed record SceneObservationProjectionResult(
    string CurrentLocation,
    string CurrentRegion,
    IReadOnlyList<SceneAffordanceProjection> Affordances,
    string Summary,
    bool IsPartial,
    string? TruncatedReason,
    SceneObservationContext Observation,
    int PayloadUtf8Bytes)
{
    internal bool IsValid => string.IsNullOrEmpty(this.TruncatedReason)
        || this.TruncatedReason is "maximum_affordances" or "payload_limit";
}
