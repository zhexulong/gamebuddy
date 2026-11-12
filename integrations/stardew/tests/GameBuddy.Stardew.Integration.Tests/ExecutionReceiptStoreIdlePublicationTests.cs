using System;
using System.Collections.Generic;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE IDLE TRANSITION'S ORDER AND ITS FAILURE ARE PROPERTIES, NOT SIDE EFFECTS.
///
/// <para>
/// <c>ExecutionReceiptStore.DrainPendingIdleAfterRelease</c> is the only place an execution's one <c>body_idle</c> fact
/// is published, and it publishes from INSIDE the loop that retires the pending entries: each entry is marked
/// published, removed, and then announced, one at a time. That ordering is what makes a publication failure cost the
/// transition it reached and nothing else. A drain rewritten to collect its transitions and publish them afterwards
/// would look identical in "a trace was emitted for each entry" and would differ here: the second entry would already be
/// retired when the first entry's trace ran, and a throwing sink would leave a different set of entries behind.
/// </para>
///
/// <para>
/// The store is driven directly, with the two collaborators it declares as parameters - the ownership query and the
/// publication - because the two-entry drain cannot be produced through a real <c>ExecutionManager</c> without a live
/// actor: there, ownership is read from the body slots and an entry leaves the pending map in the same call that adds it.
/// </para>
/// </summary>
public sealed class ExecutionReceiptStoreIdlePublicationTests
{
    [Fact]
    public void EachIdleTraceIsPublishedBeforeTheNextPendingEntryIsRetired()
    {
        var events = new List<string>();
        var owned = new HashSet<string>(StringComparer.Ordinal) { "execution_1" };
        var store = new ExecutionReceiptStore(
            new RecordingOwnership(owned, events),
            publishBodyIdleTrace: (executionId, requestId) => events.Add($"body_idle:{executionId}"));

        // The body still holds the first execution, so its idle waits rather than publishing...
        store.PublishIdleAfterRelease("execution_1", "request_1");
        // ...and the next tick's drain sees both entries, in the order they were parked.
        owned.Clear();
        store.PublishIdleAfterRelease("execution_2", "request_2");

        events.Should().Equal(
            new[]
            {
                "own:execution_1",
                "own:execution_1",
                "body_idle:execution_1",
                "own:execution_2",
                "body_idle:execution_2",
            },
            "each entry's idle trace is published before the next entry is examined, so a publication that throws "
            + "cannot retire an entry whose trace has not run");
    }

    [Fact]
    public void AFailingIdleTraceRetiresOnlyTheEntriesItReached()
    {
        var events = new List<string>();
        var owned = new HashSet<string>(StringComparer.Ordinal) { "execution_1", "execution_2" };
        int published = 0;
        var store = new ExecutionReceiptStore(
            new RecordingOwnership(owned, events),
            publishBodyIdleTrace: (executionId, requestId) =>
            {
                events.Add($"body_idle:{executionId}");
                if (++published == 2)
                    throw new InvalidOperationException("trace sink failed");
            });
        store.PublishIdleAfterRelease("execution_1", "request_1");
        store.PublishIdleAfterRelease("execution_2", "request_2");
        owned.Clear();

        Action drain = () => store.DrainPendingIdleAfterRelease();
        drain.Should().Throw<InvalidOperationException>("the publication's own failure is not swallowed here");

        // MEASURED on the loop this store keeps (mark published, remove, then trace): each entry is retired before its
        // own trace is attempted, so the entry whose trace threw is retired and untraced - not published a second time.
        store.HasPendingIdle("execution_1").Should().BeFalse("its trace was published");
        store.HasPendingIdle("execution_2").Should().BeFalse("it was retired before its own trace threw");
        Published(events).Should().Equal(new[] { "execution_1", "execution_2" });

        // Nothing is re-announced: neither a later drain nor a repeat of the same release publishes again.
        store.DrainPendingIdleAfterRelease();
        store.PublishIdleAfterRelease("execution_2", "request_2");
        Published(events).Should().Equal(new[] { "execution_1", "execution_2" });
    }

    /// <summary>The executions whose idle trace the sink received, in the order it received them.</summary>
    private static List<string> Published(List<string> events)
    {
        var published = new List<string>();
        foreach (string entry in events)
        {
            if (entry.StartsWith("body_idle:", StringComparison.Ordinal))
                published.Add(entry["body_idle:".Length..]);
        }

        return published;
    }

    [Fact]
    public void EvictingAReceiptRetiresTheNavigationMarkerSoItsSettledExecutionStillAnnouncesTheIdle()
    {
        var events = new List<string>();
        var store = new ExecutionReceiptStore(
            new RecordingOwnership(new HashSet<string>(StringComparer.Ordinal), events),
            publishBodyIdleTrace: (executionId, requestId) => events.Add($"body_idle:{executionId}"));

        // A navigation lineage's marker deliberately suppresses the generic body_idle trace; it is the ONE record the
        // eviction has to retire together with the receipt, or the marker outlives the receipt that owned it.
        store.MarkNavigationExecution("execution_navigation");
        store.Remember(Receipt("request_navigation", "execution_navigation"));
        for (int index = 0; index < ExecutionReceiptStore.MaximumRememberedReceipts; index++)
            store.Remember(Receipt($"request_{index}", $"execution_{index}"));

        store.PublishIdleAfterRelease("execution_navigation", "request_navigation");

        events.Should().Contain(
            "body_idle:execution_navigation",
            "the evicted receipt's navigation marker must go with it: a stale marker would be removed by the drain "
            + "instead of being absent, and the settled execution would never announce that the actor came back");
    }

    private static LocalExecutionReceipt Receipt(string requestId, string executionId) =>
        new(executionId, requestId, ExecutionState.Succeeded, "terminal", 1, null);

    /// <summary>The two questions the store asks of the body, recorded in the order it asks them.</summary>
    private sealed class RecordingOwnership : IActiveBodyOwnership
    {
        private readonly HashSet<string> owned;
        private readonly List<string> events;

        internal RecordingOwnership(HashSet<string> owned, List<string> events)
        {
            this.owned = owned;
            this.events = events;
        }

        public bool HasOwnership(string executionId)
        {
            this.events.Add($"own:{executionId}");
            return this.owned.Contains(executionId);
        }

        public void ReleaseModalLease(string executionId) => this.events.Add($"lease:{executionId}");
    }
}
