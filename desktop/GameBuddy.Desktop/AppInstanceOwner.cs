namespace GameBuddy.Desktop;

/// <summary>
/// The current-user app-instance authority: exactly one GameBuddy primary instance per
/// product partition, and a secondary invocation that may only ask the primary to open or
/// focus the presentation before it exits.
/// <para>
/// The authority is one cross-process native lease and nothing else. It is not a Chat
/// continuity lock, a Game/Stardew guardian lease, a path lock or bridge ownership, and it
/// makes no claim about any of them; it exists so that a double-click on the product entry
/// cannot produce two Host owners. The lease is released by the operating system when its
/// holder ends, so an owner that died mid-launch leaves evidence rather than a permanent
/// refusal - and that evidence is the only thing this authority will act on.
/// </para>
/// <para>
/// The partition is part of the lease's name and is a closed token supplied by the entry
/// that owns it, so an installed launch and a portable layout cannot collide by accident and
/// neither can silently adopt the other's instance.
/// </para>
/// </summary>
internal sealed class AppInstanceOwner : IDisposable
{
    /// <summary>The installed product's own partition.</summary>
    internal const string InstalledPartition = "installed";

    /// <summary>
    /// Reported when the lease was held by a process that ended without releasing it. It is
    /// not a silent take-over: the operating system's abandonment of the lease is the proof
    /// that the previous owner is no longer executing.
    /// </summary>
    internal const string RecoveredCategory = "primary_instance_recovered";

    private const string LeaseNamePrefix = @"Local\GameBuddy.Desktop.PrimaryAppInstance.v1.";
    private readonly Mutex lease;
    private int disposed;

    private AppInstanceOwner(Mutex lease, bool primary)
    {
        this.lease = lease;
        IsPrimary = primary;
    }

    /// <summary>Whether this process owns the primary instance and may start Host/runtime.</summary>
    internal bool IsPrimary { get; }

    /// <summary>
    /// The exact lease name one partition owns. A partition token is not an option a caller
    /// may extend: it is one bounded lowercase token, so no caller can address another
    /// product's instance by passing a longer or differently punctuated name.
    /// </summary>
    internal static string LeaseName(string partition)
    {
        if (!IsPartitionToken(partition)) throw new ArgumentException("A bounded lowercase partition token is required.", nameof(partition));
        return $"{LeaseNamePrefix}{partition}";
    }

    /// <summary>
    /// Acquires the partition's lease. A process that acquires it is the primary instance; a
    /// process that does not is a secondary invocation, which is not an error and not a
    /// second product - it has exactly one thing it may do.
    /// </summary>
    internal static AppInstanceOwner Acquire(string partition)
    {
        var name = LeaseName(partition);
        var lease = new Mutex(initiallyOwned: false, name);
        try
        {
            bool primary;
            try
            {
                primary = lease.WaitOne(0);
            }
            catch (AbandonedMutexException)
            {
                // The previous owner terminated while holding the lease. The operating
                // system hands this waiter the abandoned lease instead of leaving the
                // partition permanently claimed, and that grant is the evidence.
                primary = true;
            }
            return new AppInstanceOwner(lease, primary);
        }
        catch
        {
            lease.Dispose();
            throw;
        }
    }

    /// <summary>
    /// The one thing a secondary invocation may do. It is a bounded intent on a bounded
    /// channel, and it carries no option, no path and no credential; a secondary that cannot
    /// deliver it reports that honestly instead of starting a Host of its own.
    /// </summary>
    internal static Task<bool> RequestOpenAsync(CancellationToken cancellationToken) =>
        PrimaryIntentPipe.RequestAsync(PrimaryIntent.Open, PrimaryIntentPipe.SecondaryWait, cancellationToken);

    private static bool IsPartitionToken(string value)
    {
        if (value.Length is 0 or > 32) return false;
        if (value[0] is < 'a' or > 'z') return false;
        foreach (var character in value)
            if (character is not (>= 'a' and <= 'z') and not (>= '0' and <= '9') and not '-') return false;
        return true;
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        if (IsPrimary)
        {
            try
            {
                lease.ReleaseMutex();
            }
            catch (ApplicationException)
            {
                // The lease was already abandoned or released; nothing is left to hand over.
            }
        }
        lease.Dispose();
    }
}
