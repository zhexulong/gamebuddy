using GameBuddy.Stardew;

internal static class PortfolioTerminalDeliveryCoreTests
{
    private sealed class Delivery
    {
        internal Delivery(string id) => this.Id = id;
        internal string Id { get; }
    }

    private sealed record ValueEqualDelivery(string Id);

    internal static int Main()
    {
        EmptyQueuePeekFailsClosed();
        NullDeliveryIsRejected();
        EnqueueThenPeekReturnsHead();
        ArmRequiresHeadAndPositiveGeneration();
        PendingTracksArmedCompletion();
        CompleteRequiresCompletedMatchingGeneration();
        FailedCompletionRemovesArmAndKeepsHead();
        GenerationMismatchFailsClosed();
        AcknowledgeRejectsArmedHeadAndDequeuesUnarmedHead();
        FifoHeadBlockingMatrix();
        ValueEqualDeliveryUsesCompletionEquality();
        Console.WriteLine("PortfolioTerminalDeliveryCore contract passed.");
        return 0;
    }

    private static void EmptyQueuePeekFailsClosed()
    {
        PortfolioTerminalDeliveryCore<Delivery> core = new();
        Require(!core.TryPeekTerminalDelivery(out Delivery? delivery) && delivery is null, "empty peek must fail closed");
    }

    private static void NullDeliveryIsRejected()
    {
        PortfolioTerminalDeliveryCore<Delivery> core = new();
        RequireThrows<ArgumentNullException>(() => core.Enqueue(null!), "null delivery must fail closed");
        Require(!core.TryPeekTerminalDelivery(out _), "rejected null delivery must not enter the FIFO");
    }

    private static void EnqueueThenPeekReturnsHead()
    {
        PortfolioTerminalDeliveryCore<Delivery> core = new();
        Delivery head = new("head");
        core.Enqueue(head);
        Require(core.TryPeekTerminalDelivery(out Delivery? peeked) && ReferenceEquals(peeked, head), "enqueued delivery must be peekable");
    }

    private static void ArmRequiresHeadAndPositiveGeneration()
    {
        PortfolioTerminalDeliveryCore<Delivery> core = new();
        Delivery head = new("head");
        Delivery second = new("second");
        core.Enqueue(head);
        core.Enqueue(second);
        Require(!core.TryArmTerminalDelivery(second, Completion(7)), "non-head delivery must not be armable");
        Require(!core.TryArmTerminalDelivery(head, Completion(0)), "zero generation must not be armable");
        Require(core.TryArmTerminalDelivery(head, Completion(7)), "head with positive generation must arm");
        Require(!core.TryArmTerminalDelivery(head, Completion(7)), "double arm must fail closed");
    }

    private static void PendingTracksArmedCompletion()
    {
        PortfolioTerminalDeliveryCore<Delivery> core = new();
        Delivery head = new("head");
        core.Enqueue(head);
        Require(!core.IsTerminalDeliveryPending(head), "unarmed delivery must not be pending");
        core.TryArmTerminalDelivery(head, Completion(7));
        Require(core.IsTerminalDeliveryPending(head), "armed delivery must be pending");
    }

    private static void CompleteRequiresCompletedMatchingGeneration()
    {
        PortfolioTerminalDeliveryCore<Delivery> core = new();
        Delivery head = new("head");
        core.Enqueue(head);
        PortfolioPipeOutboundCompletion pending = Completion(7);
        core.TryArmTerminalDelivery(head, pending);
        Require(!core.TryCompleteTerminalDelivery(head, 7, out bool failed) && !failed, "incomplete write must not complete");
        pending.Resolve(true);
        Require(core.TryCompleteTerminalDelivery(head, 7, out failed) && !failed, "completed matching write must complete");
        Require(!core.TryPeekTerminalDelivery(out _), "completed delivery must be dequeued");
    }

    private static void FailedCompletionRemovesArmAndKeepsHead()
    {
        PortfolioTerminalDeliveryCore<Delivery> core = new();
        Delivery head = new("head");
        core.Enqueue(head);
        PortfolioPipeOutboundCompletion failed = Completion(7);
        core.TryArmTerminalDelivery(head, failed);
        failed.Resolve(false);
        Require(!core.TryCompleteTerminalDelivery(head, 7, out bool failedWrite) && failedWrite, "failed write must report failure");
        Require(!core.IsTerminalDeliveryPending(head), "failed completion must remove the arm");
        Require(core.TryPeekTerminalDelivery(out Delivery? stillHead) && ReferenceEquals(stillHead, head), "failed completion must keep the head queued");
    }

    private static void GenerationMismatchFailsClosed()
    {
        PortfolioTerminalDeliveryCore<Delivery> core = new();
        Delivery head = new("head");
        core.Enqueue(head);
        PortfolioPipeOutboundCompletion completion = Completion(7);
        core.TryArmTerminalDelivery(head, completion);
        completion.Resolve(true);
        Require(!core.TryCompleteTerminalDelivery(head, 8, out bool failed) && failed, "wrong authenticated generation must fail closed");
        Require(core.TryPeekTerminalDelivery(out Delivery? stillHead) && ReferenceEquals(stillHead, head), "generation mismatch must keep the head queued");
    }

    private static void AcknowledgeRejectsArmedHeadAndDequeuesUnarmedHead()
    {
        PortfolioTerminalDeliveryCore<Delivery> core = new();
        Delivery head = new("head");
        core.Enqueue(head);
        PortfolioPipeOutboundCompletion completion = Completion(7);
        core.TryArmTerminalDelivery(head, completion);
        Require(!core.TryAcknowledgeTerminalDelivery(head), "armed head must not be acknowledged");
        completion.Resolve(true);
        Require(core.TryCompleteTerminalDelivery(head, 7, out _), "armed head must complete");
        Delivery second = new("second");
        core.Enqueue(second);
        Require(core.TryAcknowledgeTerminalDelivery(second), "unarmed head must be acknowledgeable");
        Require(!core.TryPeekTerminalDelivery(out _), "acknowledged head must be dequeued");
    }

    private static void FifoHeadBlockingMatrix()
    {
        PortfolioTerminalDeliveryCore<Delivery> core = new();
        Delivery first = new("first");
        Delivery second = new("second");
        Delivery third = new("third");
        core.Enqueue(first);
        core.Enqueue(second);
        core.Enqueue(third);
        Require(!core.TryArmTerminalDelivery(third, Completion(7)), "third must be blocked behind head");
        PortfolioPipeOutboundCompletion firstCompletion = Completion(7);
        core.TryArmTerminalDelivery(first, firstCompletion);
        firstCompletion.Resolve(true);
        Require(core.TryCompleteTerminalDelivery(first, 7, out _), "head must complete first");
        Require(core.TryPeekTerminalDelivery(out Delivery? nowHead) && ReferenceEquals(nowHead, second), "second must become head");
        PortfolioPipeOutboundCompletion secondCompletion = Completion(7);
        Require(core.TryArmTerminalDelivery(second, secondCompletion) && core.TryArmTerminalDelivery(third, Completion(7)) is false,
            "second arms while third stays blocked");
        Require(core.TryAcknowledgeTerminalDelivery(second) is false, "armed second must not be acknowledged");
        secondCompletion.Resolve(true);
        Require(core.TryCompleteTerminalDelivery(second, 7, out _), "second must complete");
        Require(core.TryPeekTerminalDelivery(out Delivery? thirdHead) && ReferenceEquals(thirdHead, third), "third must become head");
    }

    private static void ValueEqualDeliveryUsesCompletionEquality()
    {
        PortfolioTerminalDeliveryCore<ValueEqualDelivery> core = new();
        ValueEqualDelivery head = new("head");
        ValueEqualDelivery equalButDistinct = new("head");
        core.Enqueue(head);
        PortfolioPipeOutboundCompletion completion = Completion(7);
        Require(core.TryArmTerminalDelivery(head, completion), "exact head instance must arm");
        Require(!core.IsTerminalDeliveryPending(equalButDistinct), "equal but distinct delivery must not share an arm");
        Require(!core.TryCompleteTerminalDelivery(equalButDistinct, 7, out _), "equal but distinct delivery must not complete head");
        completion.Resolve(true);
        Require(core.TryCompleteTerminalDelivery(head, 7, out _), "exact head instance must complete");
    }

    private static PortfolioPipeOutboundCompletion Completion(long generation) => new(generation);

    private static void RequireThrows<TException>(Action action, string message)
        where TException : Exception
    {
        try
        {
            action();
        }
        catch (TException)
        {
            return;
        }
        throw new InvalidOperationException($"PortfolioTerminalDeliveryCore contract failed: {message}");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"PortfolioTerminalDeliveryCore contract failed: {message}");
    }
}
