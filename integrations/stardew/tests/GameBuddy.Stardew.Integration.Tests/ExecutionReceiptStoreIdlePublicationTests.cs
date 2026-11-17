using System;
using System.Collections.Generic;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// AN EXECUTION'S IDLE TRANSITION IS RETIRED ONCE, AND ONLY AFTER THE ACTOR IS FREE.
///
/// <para>
/// <c>ExecutionReceiptStore.DrainPendingIdleAfterRelease</c> is the only place that transition happens, and it happens
/// from INSIDE the loop that retires the pending entries: each entry is marked retired and removed before the next one
/// is examined. That ordering is what makes a failure in the drain cost the entry it reached and nothing else.
/// </para>
///
/// <para>
/// What this store no longer does is ANNOUNCE that transition: <c>body_idle</c> was a trace of the body rather than a
/// change of the world, so the executor stopped producing it and the announcement callback went with it. The
/// bookkeeping that the announcement used to depend on - parked while the body still owns the execution, retired
/// exactly once, and the navigation marker retired together with the receipt that owned it - is what remains, and it is
/// asserted here because the release ordering is what made the announcement trustworthy.
/// </para>
///
/// <para>
/// The store is driven directly, with the one collaborator it declares - the ownership query - because the two-entry
/// drain cannot be produced through a real <c>ExecutionManager</c> without a live actor: there, ownership is read from
/// the body slots and an entry leaves the pending map in the same call that adds it.
/// </para>
/// </summary>
public sealed class ExecutionReceiptStoreIdlePublicationTests
{
    [Fact]
    public void APendingIdleWaitsForOwnershipAndIsRetiredOnce()
    {
        var owned = new HashSet<string>(StringComparer.Ordinal) { "execution_1" };
        var store = new ExecutionReceiptStore(new RecordingOwnership(owned));

        // The body still owns the execution, so its idle transition parks rather than being retired...
        store.PublishIdleAfterRelease("execution_1", "request_1");
        store.HasPendingIdle("execution_1").Should().BeTrue("a body that is still owned has not come back");

        // ...and the next drain retires it the moment the actor is free.
        owned.Clear();
        store.DrainPendingIdleAfterRelease();
        store.HasPendingIdle("execution_1").Should().BeFalse();
    }

    [Fact]
    public void EachEntryIsRetiredBeforeTheNextIsExaminedAndNothingIsAnnouncedTwice()
    {
        var owned = new HashSet<string>(StringComparer.Ordinal) { "execution_1" };
        var store = new ExecutionReceiptStore(new RecordingOwnership(owned));

        store.PublishIdleAfterRelease("execution_1", "request_1");
        owned.Clear();
        store.PublishIdleAfterRelease("execution_2", "request_2");

        store.HasPendingIdle("execution_1").Should().BeFalse("its release reached it first");
        store.HasPendingIdle("execution_2").Should().BeFalse("the same drain retired it");

        // Nothing is re-parked: the retired set is what makes the transition once per execution.
        store.DrainPendingIdleAfterRelease();
        store.PublishIdleAfterRelease("execution_2", "request_2");
        store.HasPendingIdle("execution_2").Should().BeFalse("a retired execution never becomes pending again");
    }

    [Fact]
    public void EvictingAReceiptRetiresTheNavigationMarkerSoItsSettledExecutionIsRetiredByTheDrain()
    {
        var store = new ExecutionReceiptStore(new RecordingOwnership(new HashSet<string>(StringComparer.Ordinal)));

        // A navigation lineage's marker suppresses the generic drain until its own settle retires it; it is the ONE
        // record the eviction has to retire together with the receipt, or the marker outlives the receipt that owned it
        // and the execution's idle transition is never retired at all.
        store.MarkNavigationExecution("execution_navigation");
        store.Remember(Receipt("request_navigation", "execution_navigation"));
        for (int index = 0; index < ExecutionReceiptStore.MaximumRememberedReceipts; index++)
            store.Remember(Receipt($"request_{index}", $"execution_{index}"));

        store.IsNavigationExecution("execution_navigation")
            .Should().BeFalse("the evicted receipt's navigation marker must go with it");

        store.PublishIdleAfterRelease("execution_navigation", "request_navigation");
        store.HasPendingIdle("execution_navigation").Should().BeFalse();
    }

    private static LocalExecutionReceipt Receipt(string requestId, string executionId) =>
        new(executionId, requestId, ExecutionState.Succeeded, "terminal", 1, null);

    /// <summary>The one question the store asks of the body.</summary>
    private sealed class RecordingOwnership : IActiveBodyOwnership
    {
        private readonly HashSet<string> owned;

        internal RecordingOwnership(HashSet<string> owned) => this.owned = owned;

        public bool HasOwnership(string executionId) => this.owned.Contains(executionId);

        public void ReleaseModalLease(string executionId) { }
    }
}
