namespace GameBuddy.Stardew;

/// <summary>
/// Game-thread-owned one-shot transfer for the Portfolio bootstrap socket.
/// The pipe worker records only a disconnected generation; this state is
/// consumed and advanced by the game-thread session.
/// </summary>
internal sealed class PortfolioBootstrapHandoff
{
    private long bootstrapGeneration = -1;
    private long expectedStrictGeneration = -1;
    private bool strictGenerationConsumed;

    internal bool IsBootstrapGeneration(long generation) => this.bootstrapGeneration == generation;
    internal bool IsBootstrapSuccessorGeneration(long generation) => this.bootstrapGeneration > 0
        && this.bootstrapGeneration != long.MaxValue && generation == this.bootstrapGeneration + 1;
    internal bool HasBootstrapGeneration => this.bootstrapGeneration >= 0;
    internal bool IsExpectedStrictGeneration(long generation) => this.expectedStrictGeneration == generation;
    internal bool HasExpectedStrictGeneration => this.expectedStrictGeneration >= 0;
    internal long ExpectedStrictGeneration => this.expectedStrictGeneration;
    internal bool IsStrictGenerationConsumed => this.strictGenerationConsumed;

    internal bool TryRecordBootstrap(long generation)
    {
        if (generation <= 0 || this.bootstrapGeneration >= 0 || this.expectedStrictGeneration >= 0 || this.strictGenerationConsumed)
            return false;
        this.bootstrapGeneration = generation;
        return true;
    }

    internal bool TryConsumeDisconnect(long generation, bool activeExecution, out string reasonCode)
    {
        if (activeExecution || generation <= 0 || this.bootstrapGeneration != generation
            || this.expectedStrictGeneration >= 0 || this.strictGenerationConsumed || generation == long.MaxValue)
        {
            reasonCode = "portfolio_bootstrap_not_allowed";
            return false;
        }
        this.expectedStrictGeneration = generation + 1;
        reasonCode = "accepted";
        return true;
    }

    internal bool TryAcceptStrictHello(long generation)
    {
        if (generation <= 0 || this.expectedStrictGeneration != generation || this.strictGenerationConsumed)
            return false;
        this.expectedStrictGeneration = -1;
        this.strictGenerationConsumed = true;
        return true;
    }
}
