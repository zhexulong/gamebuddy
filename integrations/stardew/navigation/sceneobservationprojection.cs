using System.Text;
using System.Text.Json;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;

namespace GameBuddy.Stardew.Navigation;

/// <summary>
/// Pure bounded projection for local scene observations. Candidate ranking is
/// deterministic and based only on copied facts supplied by the caller.
/// </summary>
internal sealed class SceneObservationProjection
{
    internal const int DefaultRadius = 15;
    internal const int MaximumRadius = 30;

    /// <summary>
    /// Item ceiling. This is the bound that expresses the product policy: a
    /// 7x7-to-30-radius view can hold many trees, weeds, stones and animals, so
    /// those four kinds are capped at three each (12 slots) and the remaining
    /// nine sparse kinds get one slot apiece, which is what makes 20 a natural
    /// ceiling rather than a round number.
    /// </summary>
    internal const int MaximumAffordances = 20;

    /// <summary>
    /// Per-observation ceiling on ground EXCEPTION tiles. The dominant kind is
    /// one line, so a meadow costs a line rather than fifty; this bounds only the
    /// deviations from it. Ground tiles never consume an affordance slot: they
    /// are a different axis of fact (what the tile is) from an affordance (what
    /// can be done there), so a dense resource view must not hide the ground.
    /// </summary>
    internal const int MaximumGroundExceptions = 12;

    /// <summary>
    /// Byte ceiling. This is a context-safety bound, not a product quota, so it
    /// must ADMIT the item ceiling on real input with headroom, and only act as a
    /// net for legal-but-never-produced padding.
    ///
    /// <para>
    /// Derivation (measured, not assumed). The worst LEGAL realistic fill is
    /// twenty artifact spots, because an artifact spot is the most expensive kind
    /// the scanner emits (its action hint is the long `dig_artifact_spot`) and it
    /// is not density capped:
    /// </para>
    /// <list type="number">
    /// <item>envelope with zero affordances: 194 B</item>
    /// <item>one artifact spot at the longest legal distance/direction pair:
    /// 142 B (the previous estimate of 149 B paired distance 15 with
    /// `CurrentTile`, which cannot co-occur - CurrentTile means distance 0)
    /// <item>twenty of them: 3054 B</item>
    /// <item>headroom for growth (localized or modded item names, new kinds):
    /// 4096 leaves 34%, whereas 3072 would leave 0.6% and therefore breaks the
    /// first time a content mod ships a longer name</item>
    /// <item>the transport frame allows 32 KiB
    /// (BridgeProtocol.MaximumMessageBytes, itself derived from the hello_ack
    /// action catalog against the 64 KiB pipe buffer), so 4096 keeps 8x framing
    /// headroom and cannot become the binding limit</item>
    /// <item>the sibling read-only projection `inspect_world_map` uses the same
    /// item ceiling and a 4096-byte result bound, so the two agree instead of
    /// drifting</item>
    /// </list>
    /// <para>
    /// Contract-maximum padding (a 128-char name plus a 160-char hint, the
    /// largest either field may be) still truncates here, which is intended:
    /// the ceiling exists to stop pathological payloads, not to shrink real
    /// ones. At 4096 the item ceiling binds first on real input, so
    /// `truncatedReason` is `maximum_affordances` for real scenes and
    /// `payload_limit` only for padded ones.
    /// </para>
    /// </summary>
    internal const int MaximumPayloadUtf8Bytes = 4096;

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
        if (!this.references.TryBeginObservation(context, out SceneObservationContext? activeContext, out string beginReason)
            || activeContext is null)
            return Invalid(context, beginReason);
        context = activeContext;

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

        // The 20-item budget is shared by every kind, so a dense kind is capped
        // per observation: a farm radius can hold dozens of wild trees at
        // range 1, which would otherwise occupy all 20 slots and push every
        // sparse anchor (NPC, exit, machine, water) out of the Agent's view.
        var affordances = new List<SceneAffordanceProjection>(Math.Min(ranked.Length, MaximumAffordances));
        var denseKindCounts = new Dictionary<SceneAffordanceKind, int>();
        bool partial = false;
        foreach (RankedCandidate candidate in ranked)
        {
            if (affordances.Count >= MaximumAffordances)
            {
                partial = true;
                break;
            }

            if (SceneAffordanceKindWire.IsDensityCapped(candidate.Kind))
            {
                denseKindCounts.TryGetValue(candidate.Kind, out int issued);
                if (issued >= SceneAffordanceKindWire.MaximumDenseKindAffordances)
                {
                    partial = true;
                    continue;
                }

                denseKindCounts[candidate.Kind] = issued + 1;
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

        // Ground is a separate axis from affordances, so it is summarised once
        // here and carried alongside them rather than competing for the 20
        // affordance slots. Truncating ground never truncates an affordance.
        SceneGroundProjection? ground = BuildGround(input.GroundTiles);
        bool groundLimited = ground is not null && ground.OmittedExceptionTileCount > 0;

        SceneObservationProjectionResult result = BuildResult(
            context,
            affordances,
            partial || groundLimited,
            partial ? "maximum_affordances" : groundLimited ? "ground_limit" : null,
            ground);
        if (result.PayloadUtf8Bytes <= SceneObservationProjection.MaximumPayloadUtf8Bytes)
            return result;

        // Byte overflow drops ground detail before it drops affordances: an
        // affordance names an action the Agent can take, a ground exception only
        // refines where it is standing.
        while (ground is not null && ground.Exceptions.Count > 0)
        {
            ground = ground with
            {
                Exceptions = ground.Exceptions.Take(ground.Exceptions.Count - 1).ToArray(),
                OmittedExceptionTileCount = ground.OmittedExceptionTileCount + 1,
            };
            result = BuildResult(context, affordances, partial: true, truncatedReason: "payload_limit", ground);
            if (result.PayloadUtf8Bytes <= SceneObservationProjection.MaximumPayloadUtf8Bytes)
                return result;
        }

        while (affordances.Count > 0)
        {
            affordances.RemoveAt(affordances.Count - 1);
            result = BuildResult(context, affordances, partial: true, truncatedReason: "payload_limit", ground);
            if (result.PayloadUtf8Bytes <= SceneObservationProjection.MaximumPayloadUtf8Bytes)
                return result;
        }

        return BuildResult(context, Array.Empty<SceneAffordanceProjection>(), partial: true, truncatedReason: "payload_limit", ground);
    }

    /// <summary>
    /// Reduce scanned ground tiles to one dominant kind plus bounded deviations.
    /// The dominant kind is the most frequent one other than <see cref="SceneGroundKind.Other"/>,
    /// because "Mostly: unknown" is less useful than naming the surface actually
    /// underfoot; ties break on the enum order so the result is deterministic.
    /// </summary>
    private static SceneGroundProjection? BuildGround(IReadOnlyList<SceneGroundTile>? tiles)
    {
        if (tiles is null || tiles.Count == 0)
            return null;

        var counts = new Dictionary<SceneGroundKind, int>();
        foreach (SceneGroundTile tile in tiles)
        {
            if (!SceneGroundKindWire.IsDefined(tile.Kind))
                continue;
            counts.TryGetValue(tile.Kind, out int seen);
            counts[tile.Kind] = seen + 1;
        }
        if (counts.Count == 0)
            return null;

        SceneGroundKind dominant = counts
            .Where(pair => pair.Key != SceneGroundKind.Other)
            .Where(pair => pair.Key != SceneGroundKind.Other)
            .OrderByDescending(pair => pair.Value)
            .ThenBy(pair => pair.Key)
            .Select(pair => pair.Key)
            .DefaultIfEmpty(SceneGroundKind.Other)
            .First();

        // Deterministic order so the Agent sees the same exceptions every time:
        // row-major over the scan, not hash order.
        SceneGroundTile[] exceptions = tiles
            .Where(tile => tile.Kind != dominant)
            .OrderBy(tile => tile.TileY)
            .ThenBy(tile => tile.TileX)
            .ToArray();

        return new SceneGroundProjection(
            SceneGroundKindWire.ToWireValue(dominant),
            counts[dominant],
            tiles.Count,
            exceptions.Take(MaximumGroundExceptions)
                .Select(tile => new SceneGroundProjectionTile(tile.TileX, tile.TileY, SceneGroundKindWire.ToWireValue(tile.Kind)))
                .ToArray(),
            Math.Max(0, exceptions.Length - MaximumGroundExceptions));
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
        string? truncatedReason,
        SceneGroundProjection? ground = null)
    {
        string summary = affordances.Count == 0
            ? $"Nothing actionable is visible in {context.LocationName}."
            : $"{affordances.Count} actionable {(affordances.Count == 1 ? "object" : "objects")} visible in {context.LocationName}.";
        var result = new SceneObservationProjectionResult(
            context.ObservationId!,
            context.LocationName,
            context.ScopeIdentity.LocationName,
            affordances,
            summary,
            partial,
            truncatedReason,
            context,
            0,
            ground);
        return result with { PayloadUtf8Bytes = MeasurePayload(result) };
    }

    private static SceneObservationProjectionResult Invalid(SceneObservationContext context, string reason) =>
        new(
            context.ObservationId ?? string.Empty,
            context.LocationName,
            context.ScopeIdentity.LocationName,
            Array.Empty<SceneAffordanceProjection>(),
            string.Empty,
            false,
            reason,
            context,
            0,
            null);

    private static int MeasurePayload(SceneObservationProjectionResult result)
    {
        ObserveSceneResultPayload payload = new(
            result.ObservationId,
            result.CurrentLocation,
            result.CurrentRegion,
            result.Affordances.Select(affordance => new ObserveSceneAffordancePayload(
                affordance.Ref,
                affordance.Kind,
                affordance.Name,
                affordance.Distance,
                affordance.Direction,
                affordance.ActionHint)).ToArray(),
            result.Summary,
            result.IsPartial,
            result.TruncatedReason,
            result.Ground is null
                ? null
                : new ObserveSceneGroundPayload(
                    result.Ground.DominantKind,
                    result.Ground.DominantTileCount,
                    result.Ground.ScannedTileCount,
                    result.Ground.Exceptions
                        .Select(tile => new ObserveSceneGroundTilePayload(tile.TileX, tile.TileY, tile.Kind))
                        .ToArray(),
                    result.Ground.OmittedExceptionTileCount));
        return Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(payload, BridgeProtocol.JsonOptions));
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
    string ObservationId,
    string CurrentLocation,
    string CurrentRegion,
    IReadOnlyList<SceneAffordanceProjection> Affordances,
    string Summary,
    bool IsPartial,
    string? TruncatedReason,
    SceneObservationContext Observation,
    int PayloadUtf8Bytes,
    SceneGroundProjection? Ground = null)
{
    internal bool IsValid => string.IsNullOrEmpty(this.TruncatedReason)
        || this.TruncatedReason is "maximum_affordances" or "payload_limit" or "ground_limit";
}

/// <summary>
/// Wire-shaped ground summary: the dominant back-layer `Type` plus only the
/// tiles that differ from it. A uniform region costs one entry.
/// </summary>
internal sealed record SceneGroundProjection(
    string DominantKind,
    int DominantTileCount,
    int ScannedTileCount,
    IReadOnlyList<SceneGroundProjectionTile> Exceptions,
    int OmittedExceptionTileCount);

internal sealed record SceneGroundProjectionTile(int TileX, int TileY, string Kind);
