using System.Collections.Concurrent;
using System.Reflection;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The outbound queue is mutated from three threads: the game main thread
/// admits frames with TryEnqueueOutbound, the background worker drains the
/// frames of a discarded connection generation with DiscardGeneration, and the
/// worker's writer dequeues one frame per delivery. Those three mutations must
/// agree on the admitted count and the queue length, and a drain must retire
/// exactly the frames it saw when it began — never a frame the game thread
/// admitted while the drain was running.
/// </summary>
public sealed class LocalPipeBridgeOutboundQueueTests
{
    // Mirrors LocalPipeBridge.MaximumQueuedMessages. The admission cap itself is
    // not under test here; these tests pin that a drain cannot corrupt the
    // count that cap is measured against.
    private const int MaximumQueuedMessages = 64;

    // A connection generation that the generation-0 frames admitted while the
    // bridge is disconnected cannot belong to, so a drain of it retains them.
    private const long DiscardedGeneration = 1;

    private static readonly FieldInfo OutboundField =
        typeof(LocalPipeBridge).GetField("outbound", BindingFlags.Instance | BindingFlags.NonPublic)!;

    private static readonly FieldInfo OutboundCountField =
        typeof(LocalPipeBridge).GetField("outboundCount", BindingFlags.Instance | BindingFlags.NonPublic)!;

    [Fact]
    public void DiscardGeneration_RetainsFramesAdmittedWhileDisconnected_WithoutDriftingTheAdmittedCount()
    {
        string pipeName = "gamebuddy_outbound_retained_" + Guid.NewGuid().ToString("N");
        using LocalPipeBridge bridge = new(pipeName);
        bridge.CurrentGeneration.Should().Be(0, "an unconnected bridge admits pre-connect frames at generation 0");

        List<string> queued = new();
        List<PipeOutboundCompletion> completions = new();
        for (int index = 0; index < 8; index++)
        {
            string json = "queued_before_discard_" + index;
            bridge.TryEnqueueOutbound(0, json, out PipeOutboundCompletion completion).Should().BeTrue();
            queued.Add(json);
            completions.Add(completion);
        }

        // DiscardGeneration is the worker's disconnect path. Meeting a queue
        // that still holds frames admitted while the bridge was disconnected is
        // the state where its retained frames must survive: invoking the drain
        // directly is the only deterministic way to reach it, because the worker
        // path that calls it cannot be interleaved on demand.
        InvokeDiscardGeneration(bridge, DiscardedGeneration);

        OutboundCount(bridge).Should().Be(OutboundQueue(bridge).Count,
            "a drain must keep the admitted count equal to the queue length");
        OutboundQueue(bridge).Select(message => message.Json).Should().Equal(queued,
            "frames of another generation must stay queued in their admission order");
        completions.Should().OnlyContain(completion => !completion.Result.IsCompleted,
            "a drain must resolve only the completions of the generation it discarded");

        int admittedAfterDrain = 0;
        while (bridge.TryEnqueueOutbound(0, "admitted_after_discard_" + admittedAfterDrain, out _))
            admittedAfterDrain++;

        admittedAfterDrain.Should().Be(MaximumQueuedMessages - queued.Count,
            "the admission cap must count the retained frames that are still queued");
        OutboundQueue(bridge).Count.Should().Be(MaximumQueuedMessages);
    }

    [Fact]
    public void DiscardGeneration_ResolvesExactlyTheDiscardedGenerationsFrames_KeepingTheAdmittedCountExact()
    {
        string pipeName = "gamebuddy_outbound_mixed_" + Guid.NewGuid().ToString("N");
        using LocalPipeBridge bridge = new(pipeName);

        // The mixed queue a disconnect drain meets: frames of the connection
        // being discarded ahead of frames admitted while disconnected. Seeding
        // it directly is the only way to hold frames of a generation the bridge
        // is no longer connected to.
        List<string> stale = new() { "stale_frame_1", "stale_frame_2", "stale_frame_3" };
        List<string> retained = new() { "retained_frame_1", "retained_frame_2" };
        List<PipeOutboundCompletion> staleCompletions = new();
        List<PipeOutboundCompletion> retainedCompletions = new();
        ConcurrentQueue<PipeOutbound> queue = OutboundQueue(bridge);
        foreach (string json in stale)
        {
            PipeOutboundCompletion completion = new(DiscardedGeneration);
            staleCompletions.Add(completion);
            queue.Enqueue(new PipeOutbound(DiscardedGeneration, json, completion));
        }
        foreach (string json in retained)
        {
            PipeOutboundCompletion completion = new(0);
            retainedCompletions.Add(completion);
            queue.Enqueue(new PipeOutbound(0, json, completion));
        }
        SetOutboundCount(bridge, queue.Count);

        InvokeDiscardGeneration(bridge, DiscardedGeneration);

        foreach (PipeOutboundCompletion completion in staleCompletions)
        {
            completion.Result.IsCompleted.Should().BeTrue("a discarded frame must settle its completion");
            ResolvedOutcome(completion).Should().BeFalse("a discarded frame was never delivered");
        }
        retainedCompletions.Should().OnlyContain(completion => !completion.Result.IsCompleted,
            "a retained frame must not be resolved by the drain");
        OutboundQueue(bridge).Select(message => message.Json).Should().Equal(retained,
            "only the discarded generation leaves the queue");
        OutboundCount(bridge).Should().Be(retained.Count)
            .And.Be(OutboundQueue(bridge).Count, "the admitted count must match the queue length");
    }

    [Fact]
    public void ConcurrentAdmissionAndDiscard_KeepTheAdmittedCountExactAndPreserveAdmissionOrder()
    {
        string pipeName = "gamebuddy_outbound_concurrent_" + Guid.NewGuid().ToString("N");
        using LocalPipeBridge bridge = new(pipeName);

        List<string> admitted = new();
        List<PipeOutboundCompletion> completions = new();
        Thread admitting = new(() =>
        {
            for (int index = 0; index < 400; index++)
            {
                string json = "concurrent_frame_" + index;
                if (bridge.TryEnqueueOutbound(0, json, out PipeOutboundCompletion completion))
                {
                    admitted.Add(json);
                    completions.Add(completion);
                }
            }
        });
        admitting.Start();
        WaitUntil(() => !OutboundQueue(bridge).IsEmpty, "the admitting thread must queue its first frame");

        Thread discarding = new(() =>
        {
            for (int index = 0; index < 200; index++)
                InvokeDiscardGeneration(bridge, DiscardedGeneration);
        });
        discarding.Start();

        discarding.Join(TimeSpan.FromSeconds(30)).Should().BeTrue("the discarding worker must finish");
        admitting.Join(TimeSpan.FromSeconds(30)).Should().BeTrue("the admitting thread must finish");

        admitted.Should().HaveCount(MaximumQueuedMessages,
            "a drain must not corrupt the count the admission cap is measured against");
        OutboundQueue(bridge).Select(message => message.Json).Should().Equal(admitted,
            "an admitted frame must keep its queue position and must never be lost");
        OutboundCount(bridge).Should().Be(OutboundQueue(bridge).Count,
            "one gate must keep the admitted count equal to the queue length");
        completions.Should().OnlyContain(completion => !completion.Result.IsCompleted,
            "a drain must resolve only the completions of the generation it discarded");
    }

    private static bool ResolvedOutcome(PipeOutboundCompletion completion) =>
        completion.Result.GetAwaiter().GetResult();

    private static ConcurrentQueue<PipeOutbound> OutboundQueue(LocalPipeBridge bridge) =>
        (ConcurrentQueue<PipeOutbound>)OutboundField.GetValue(bridge)!;

    private static int OutboundCount(LocalPipeBridge bridge) => (int)OutboundCountField.GetValue(bridge)!;

    private static void SetOutboundCount(LocalPipeBridge bridge, int count) =>
        OutboundCountField.SetValue(bridge, count);

    private static void InvokeDiscardGeneration(LocalPipeBridge bridge, long generation) =>
        typeof(LocalPipeBridge).GetMethod("DiscardGeneration", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(bridge, new object[] { generation });

    private static void WaitUntil(Func<bool> condition, string failureMessage)
    {
        long deadline = Environment.TickCount64 + 5_000;
        while (Environment.TickCount64 < deadline)
        {
            if (condition())
                return;
            Thread.Sleep(5);
        }
        throw new InvalidOperationException(failureMessage);
    }
}
