using System.Security.Cryptography;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Navigation;

/// <summary>
/// Observation-local opaque refs and bindings. The store owns no native game
/// objects; entries contain only copied immutable facts and are invalidated as a
/// unit whenever the observation context changes or the runtime closes.
/// </summary>
internal sealed class SceneObservationStore
{
    private const int RandomHandleBytes = 12;
    private readonly Dictionary<string, Entry> entries = new(StringComparer.Ordinal);
    private SceneObservationContext? activeObservation;
    private bool closed;

    internal bool IsClosed => this.closed;

    internal SceneObservationContext? ActiveObservation => this.activeObservation;

    internal void Close()
    {
        this.closed = true;
        this.activeObservation = null;
        this.entries.Clear();
    }

    internal void InvalidateForMove(
        string runtimeInstanceId,
        BridgeScope scope,
        string locationName,
        long movementSequence)
    {
        if (this.closed)
            return;

        this.activeObservation = null;
        this.entries.Clear();
        if (SceneObservationScope.IsBoundedText(runtimeInstanceId, 128)
            && scope.IsValid
            && SceneObservationScope.IsBoundedText(locationName, 128)
            && movementSequence >= 0)
        {
            // Movement invalidation records the new context but does not issue
            // refs until a fresh observation is published.
            this.activeObservation = new SceneObservationContext(
                runtimeInstanceId,
                scope,
                locationName,
                movementSequence,
                0);
        }
    }

    internal bool TryBeginObservation(
        SceneObservationContext context,
        out string reasonCode)
    {
        reasonCode = "scene_observation_invalid";
        if (this.closed || !context.ScopeIdentity.IsValid || context.ObservationSequence <= 0)
            return false;

        this.activeObservation = context;
        this.entries.Clear();
        reasonCode = "accepted";
        return true;
    }

    internal bool TryIssue(
        SceneObservationContext context,
        SceneAffordanceSource source,
        out string? reference,
        out string reasonCode)
    {
        reference = null;
        if (!IsCurrentObservation(context))
        {
            reasonCode = "scene_ref_stale";
            return false;
        }
        if (!source.IsValid || !StringComparer.Ordinal.Equals(source.LocationName, context.LocationName))
        {
            reasonCode = "scene_affordance_invalid";
            return false;
        }

        string handle;
        Span<byte> bytes = stackalloc byte[RandomHandleBytes];
        do
        {
            RandomNumberGenerator.Fill(bytes);
            handle = "sr1_" + Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }
        while (this.entries.ContainsKey(handle));

        this.entries.Add(handle, new Entry(
            context,
            source.Kind,
            source.OpaqueEntityIdentity,
            source.LocationName,
            source.TileX,
            source.TileY));
        reference = handle;
        reasonCode = "accepted";
        return true;
    }

    internal bool TryResolve(
        string? reference,
        SceneObservationContext context,
        out SceneAffordanceBinding? binding,
        out string reasonCode)
    {
        binding = null;
        if (!IsWellFormedHandle(reference))
        {
            reasonCode = "scene_ref_invalid";
            return false;
        }
        if (this.closed || !this.entries.TryGetValue(reference!, out Entry? entry))
        {
            reasonCode = "scene_ref_stale";
            return false;
        }
        if (!IsCurrentObservation(context) || !entry.Context.Equals(context))
        {
            reasonCode = "scene_ref_stale";
            return false;
        }

        binding = new SceneAffordanceBinding(
            entry.Kind,
            entry.OpaqueEntityIdentity,
            entry.LocationName,
            entry.TileX,
            entry.TileY,
            entry.Context.ObservationSequence);
        reasonCode = "accepted";
        return true;
    }

    internal static bool IsWellFormedHandle(string? value)
    {
        const string prefix = "sr1_";
        if (value is null || !value.StartsWith(prefix, StringComparison.Ordinal)
            || value.Length != prefix.Length + 16)
            return false;

        string encoded = value[prefix.Length..];
        if (encoded.Any(character => !((character >= 'A' && character <= 'Z')
            || (character >= 'a' && character <= 'z')
            || (character >= '0' && character <= '9')
            || character is '-' or '_')))
            return false;

        Span<byte> buffer = stackalloc byte[RandomHandleBytes];
        return Convert.TryFromBase64String(
            encoded.Replace('-', '+').Replace('_', '/'),
            buffer,
            out int written)
            && written == RandomHandleBytes;
    }

    private bool IsCurrentObservation(SceneObservationContext context) =>
        !this.closed
        && this.activeObservation is not null
        && this.activeObservation.Equals(context)
        && context.ScopeIdentity.IsValid;

    private sealed record Entry(
        SceneObservationContext Context,
        SceneAffordanceKind Kind,
        string OpaqueEntityIdentity,
        string LocationName,
        int TileX,
        int TileY);
}
