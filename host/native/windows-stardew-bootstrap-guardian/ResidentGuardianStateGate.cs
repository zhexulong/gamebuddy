namespace GameBuddy.WindowsStardewBootstrapGuardian;

/** Serializes resident EOF closing with irreversible launch boundaries. */
internal sealed class ResidentGuardianStateGate
{
    private readonly object sync = new();
    private bool closing;

    internal void Close()
    {
        lock (sync) closing = true;
    }

    internal bool TryRunOpen(Action action)
    {
        lock (sync)
        {
            if (closing) return false;
            action();
            return !closing;
        }
    }

    internal bool IsClosing()
    {
        lock (sync) return closing;
    }
}
