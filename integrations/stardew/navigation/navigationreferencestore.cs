using System.Security.Cryptography;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Navigation;

/// <summary>
/// Runtime-private, opaque Navigation reference table. Handles are random lookup
/// keys, never encoded bindings or permits; all resolution occurs against a
/// current game-thread binding context.
/// </summary>
internal sealed class NavigationReferenceStore
{
    private const int RandomHandleBytes = 16;
    private static readonly TimeSpan HandleLifetime = TimeSpan.FromMinutes(5);
    private readonly Dictionary<string, Entry> entries = new(StringComparer.Ordinal);
    private bool closed;

    internal string IssueNode(NavigationBindingContext context, NavigationNodeBinding binding) =>
        Issue("nr1_", context, binding.ContentOwner, binding.CanonicalDestinationIdentity, binding.SourceGeneration, binding.ObservationSequence, null);

    internal string IssueCursor(NavigationBindingContext context, NavigationCursorBinding binding) =>
        Issue("wc1_", context, binding.ContentOwner, binding.CanonicalDestinationIdentity, binding.SourceGeneration, binding.ObservationSequence, binding.ImmutableFrontierSnapshot);

    internal string IssueDestination(NavigationBindingContext context, NavigationDestinationBinding binding) =>
        Issue("dr1_", context, binding.ContentOwner, binding.CanonicalDestinationIdentity, binding.SourceGeneration, binding.ObservationSequence, null);

    internal void Close()
    {
        this.closed = true;
        this.entries.Clear();
    }

    internal void ClearForWorldUnload() => this.entries.Clear();

    internal void ClearForSourceGenerationChange() => this.entries.Clear();

    internal bool TryResolveNode(string nodeRef, NavigationBindingContext context, out NavigationNodeBinding? binding, out string reasonCode)
    {
        binding = null;
        if (!TryResolve(nodeRef, "nr1_", context, out Entry? entry, out reasonCode, out _)) return false;
        binding = new NavigationNodeBinding(entry!.ContentOwner, entry.CanonicalDestinationIdentity, entry.SourceGeneration, entry.ObservationSequence);
        return true;
    }

    internal bool TryResolveCursor(string cursor, NavigationBindingContext context, out NavigationCursorBinding? binding, out string reasonCode)
    {
        binding = null;
        if (!TryResolve(cursor, "wc1_", context, out Entry? entry, out reasonCode, out _)) return false;
        binding = new NavigationCursorBinding(entry!.ContentOwner, entry.CanonicalDestinationIdentity, entry.SourceGeneration, entry.ObservationSequence, entry.FrontierSnapshot!);
        return true;
    }

    internal bool TryResolveDestination(
        NavigationDestinationSelector selector,
        NavigationBindingContext context,
        out NavigationDestinationBinding? binding,
        out string reasonCode,
        out string? failureDetail)
    {
        binding = null;
        if (selector.Kind != "ref" || selector.Label is not null)
        {
            reasonCode = "destination_ref_invalid";
            failureDetail = "selector=ref;handle=none";
            return false;
        }
        if (!TryResolve(selector.Ref, "dr1_", context, out Entry? entry, out reasonCode, out failureDetail))
            return false;
        binding = new NavigationDestinationBinding(entry!.ContentOwner, entry.CanonicalDestinationIdentity, entry.SourceGeneration, entry.ObservationSequence);
        return true;
    }

    internal static bool IsWellFormedHandle(string? value, string prefix)
    {
        if (value is null || !value.StartsWith(prefix, StringComparison.Ordinal) || value.Length != prefix.Length + 22) return false;
        string encoded = value[prefix.Length..];
        if (encoded.Any(character => !((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character is '-' or '_'))
            || encoded[^1] is not ('A' or 'Q' or 'g' or 'w')) return false;
        Span<byte> buffer = stackalloc byte[RandomHandleBytes];
        return Convert.TryFromBase64String(encoded.Replace('-', '+').Replace('_', '/') + "==", buffer, out int written) && written == RandomHandleBytes;
    }

    private string Issue(string prefix, NavigationBindingContext context, string contentOwner, string canonicalDestinationIdentity, string sourceGeneration, long observationSequence, string? frontierSnapshot)
    {
        if (this.closed) throw new InvalidOperationException("Navigation reference store is closed.");
        string handle;
        Span<byte> bytes = stackalloc byte[RandomHandleBytes];
        do
        {
            RandomNumberGenerator.Fill(bytes);
            handle = prefix + Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        } while (this.entries.ContainsKey(handle));

        this.entries.Add(handle, new Entry(
            prefix,
            context.RuntimeInstanceId,
            context.Scope,
            contentOwner,
            canonicalDestinationIdentity,
            sourceGeneration,
            observationSequence,
            context.Now,
            context.Now.Add(HandleLifetime),
            frontierSnapshot));
        return handle;
    }

    /// <summary>
    /// The handle's own answer: the binding, or the ONE condition that refused it.
    ///
    /// <para>
    /// A DESTINATION HANDLE'S REFUSAL IS SPLIT INTO ONE CODE PER FACT. It used to be one `destination_ref_stale` for
    /// four conditions - the five-minute lifetime passed, another runtime instance, another scope, another destination
    /// generation - and the receipt above it said only `destination_selector_stale`, so `round85`'s `plan_323` could not
    /// tell a handle it had outlived from a destination set that had moved. Node and cursor handles keep their single
    /// code: no receipt publishes them.
    /// </para>
    /// </summary>
    private bool TryResolve(
        string? handle,
        string expectedPrefix,
        NavigationBindingContext context,
        out Entry? entry,
        out string reasonCode,
        out string? failureDetail)
    {
        entry = null;
        failureDetail = null;
        if (!IsWellFormedHandle(handle, expectedPrefix)) { reasonCode = InvalidReason(expectedPrefix); return false; }
        if (this.closed) { reasonCode = StaleReason(expectedPrefix, "store_closed"); failureDetail = "stale=store_closed"; return false; }
        if (!this.entries.TryGetValue(handle!, out Entry? found)) { reasonCode = InvalidReason(expectedPrefix); return false; }
        if (found.Prefix != expectedPrefix) { reasonCode = InvalidReason(expectedPrefix); return false; }
        if (context.Now >= found.ExpiresAt)
        {
            reasonCode = StaleReason(expectedPrefix, "expired");
            // The two numbers the caller needs to see it for itself: how long ago the handle was issued, and the lifetime
            // it outlived. Nothing here is a guess - both come out of the entry the lookup just found.
            failureDetail =
                $"stale=expired;handle_age_ms={(long)(context.Now - found.IssuedAt).TotalMilliseconds};handle_lifetime_ms={(long)HandleLifetime.TotalMilliseconds}";
            return false;
        }
        if (context.RuntimeInstanceId != found.RuntimeInstanceId)
        {
            reasonCode = StaleReason(expectedPrefix, "runtime_instance_changed");
            failureDetail = "stale=runtime_instance_changed";
            return false;
        }
        if (!Equals(context.Scope, found.Scope))
        {
            reasonCode = StaleReason(expectedPrefix, "scope_changed");
            failureDetail = "stale=scope_changed";
            return false;
        }
        if (context.SourceGeneration != found.SourceGeneration)
        {
            reasonCode = StaleReason(expectedPrefix, "source_generation_changed");
            failureDetail = "stale=source_generation_changed";
            return false;
        }
        entry = found;
        reasonCode = "accepted";
        return true;
    }

    private static string InvalidReason(string prefix) => prefix == "wc1_" ? "world_map_cursor_invalid" : prefix == "nr1_" ? "world_map_node_invalid" : "destination_ref_invalid";
    private static string StaleReason(string prefix, string cause) => prefix == "wc1_" ? "world_map_cursor_stale" : prefix == "nr1_" ? "world_map_node_stale" : $"destination_ref_{cause}";

    private sealed record Entry(
        string Prefix,
        string RuntimeInstanceId,
        BridgeScope Scope,
        string ContentOwner,
        string CanonicalDestinationIdentity,
        string SourceGeneration,
        long ObservationSequence,
        DateTimeOffset IssuedAt,
        DateTimeOffset ExpiresAt,
        string? FrontierSnapshot
    );
}
