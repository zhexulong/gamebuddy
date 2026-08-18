namespace GameBuddy.Stardew;

/// <summary>
/// Topology-local, action-neutral owner of the generation-bound terminal
/// delivery queue shared by every Portfolio action coordinator that emits
/// asynchronous terminal deliveries. It owns the FIFO delivery queue, the
/// armed completion map, and the exact peek/arm/pending/complete/acknowledge
/// mechanics; it never interprets a receipt, scope, or generation policy and
/// never selects a native member. Instantiated per family by the family
/// coordinator; the family supplies only the concrete delivery type.
/// </summary>
internal sealed class PortfolioTerminalDeliveryCore<TDelivery>
    where TDelivery : class
{
    private readonly object gate = new();
    private readonly Queue<TDelivery> terminalDeliveries = new();
    // Delivery ownership is object identity: two equal receipt-shaped deliveries
    // must never share an in-flight local transport completion.
    private readonly Dictionary<TDelivery, PortfolioPipeOutboundCompletion> terminalCompletions = new(ReferenceEqualityComparer.Instance);

    internal void Enqueue(TDelivery delivery)
    {
        ArgumentNullException.ThrowIfNull(delivery);
        lock (this.gate)
            this.terminalDeliveries.Enqueue(delivery);
    }

    internal bool TryPeekTerminalDelivery(out TDelivery? delivery)
    {
        lock (this.gate)
        {
            if (this.terminalDeliveries.Count == 0)
            {
                delivery = null;
                return false;
            }
            delivery = this.terminalDeliveries.Peek();
            return true;
        }
    }

    internal bool TryArmTerminalDelivery(TDelivery delivery, PortfolioPipeOutboundCompletion completion)
    {
        lock (this.gate)
        {
            if (this.terminalDeliveries.Count == 0 || !ReferenceEquals(this.terminalDeliveries.Peek(), delivery)
                || this.terminalCompletions.ContainsKey(delivery))
                return false;
            if (completion.Generation <= 0)
                return false;
            this.terminalCompletions.Add(delivery, completion);
            return true;
        }
    }

    internal bool IsTerminalDeliveryPending(TDelivery delivery)
    {
        lock (this.gate)
            return this.terminalCompletions.ContainsKey(delivery);
    }

    internal bool TryCompleteTerminalDelivery(TDelivery delivery, long authenticatedGeneration, out bool failed)
    {
        lock (this.gate)
        {
            failed = false;
            if (this.terminalDeliveries.Count == 0 || !ReferenceEquals(this.terminalDeliveries.Peek(), delivery))
                return false;
            if (!this.terminalCompletions.TryGetValue(delivery, out PortfolioPipeOutboundCompletion? completion))
                return false;
            if (!completion.IsCompleted)
                return false;
            this.terminalCompletions.Remove(delivery);
            if (!completion.Succeeded || completion.Generation != authenticatedGeneration)
            {
                failed = true;
                return false;
            }
            this.terminalDeliveries.Dequeue();
            return true;
        }
    }

    internal bool TryAcknowledgeTerminalDelivery(TDelivery delivery)
    {
        lock (this.gate)
        {
            if (this.terminalDeliveries.Count == 0 || !ReferenceEquals(this.terminalDeliveries.Peek(), delivery)
                || this.terminalCompletions.ContainsKey(delivery))
                return false;
            this.terminalDeliveries.Dequeue();
            return true;
        }
    }
}
