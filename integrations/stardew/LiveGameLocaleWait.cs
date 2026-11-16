namespace GameBuddy.Stardew;

/// <summary>What a caller of <see cref="LiveGameLocaleWait"/> must do on this tick.</summary>
internal enum LiveGameLocaleWaitState
{
    /// <summary>No locale is configured, or the live locale already reaches it: act.</summary>
    Ready,

    /// <summary>The live locale has not reached the configured one yet: return and look again next tick.</summary>
    Waiting,

    /// <summary>The bound passed without the locale: refuse by name instead of acting in the wrong language.</summary>
    Expired,
}

/// <summary>
/// The one bounded wait for the live game locale.
///
/// Stardew applies <c>startup_preferences.languageCode</c> ASYNCHRONOUSLY - from the
/// title-menu update, not at process start - so any path that acts on the first tick
/// the title screen owns can run before the engine has applied the language the run is
/// configured for, and the world it then enters stays in the default locale for the
/// whole session (measured 2026-11-16: <c>startup_preferences</c> said <c>zh</c> while
/// the launched game logged <c>locale set to .</c>, i.e. English, because the native
/// world entry was driven one second after the main menu).
///
/// The wait - arming the deadline, and deciding "not yet" versus "never" - lives here
/// once. Each caller keeps what is its own: the satisfied RULE (the Preview fixture
/// accepts only release-verified locales and says so; an ordinary world entry accepts
/// any locale the game really reached), the timeout it was configured with, and what
/// it refuses with.
/// </summary>
internal sealed class LiveGameLocaleWait
{
    private readonly Func<string, bool> isReached;
    private readonly Func<string> readLiveLocale;
    private readonly Func<long> readNowUnixMs;
    private readonly long timeoutMs;
    private long deadlineUnixMs;

    /// <param name="requiredLocale">The configured locale; empty means nothing to wait for.</param>
    /// <param name="timeoutMs">How long the caller is willing to wait before refusing.</param>
    /// <param name="isReached">The caller's own rule for "the live locale is the wanted one".</param>
    internal LiveGameLocaleWait(
        string? requiredLocale,
        long timeoutMs,
        Func<string, bool> isReached,
        Func<string>? readLiveLocale = null,
        Func<long>? readNowUnixMs = null)
    {
        this.RequiredLocale = requiredLocale ?? string.Empty;
        this.timeoutMs = timeoutMs;
        this.isReached = isReached;
        // Injectable so the state machine can be driven without a live game, exactly as
        // WorldCreationBootstrap's own native edges are.
        this.readLiveLocale = readLiveLocale ?? NativeChatPresentationPolicy.CurrentBcp47Locale;
        this.readNowUnixMs = readNowUnixMs ?? (() => System.DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    /// <summary>The locale the run is configured for; empty when it has none.</summary>
    internal string RequiredLocale { get; }

    /// <summary>Whether the run configured a locale at all.</summary>
    internal bool IsRequired => !string.IsNullOrWhiteSpace(this.RequiredLocale);

    internal LiveGameLocaleWaitState Evaluate()
    {
        // Nothing configured, or already there: the wait is free. A run whose locale
        // matches pays no delay and no extra tick.
        if (!this.IsRequired || this.isReached(this.readLiveLocale()))
            return LiveGameLocaleWaitState.Ready;
        long now = this.readNowUnixMs();
        if (this.deadlineUnixMs == 0)
            this.deadlineUnixMs = now + this.timeoutMs;
        return now >= this.deadlineUnixMs ? LiveGameLocaleWaitState.Expired : LiveGameLocaleWaitState.Waiting;
    }

    /// <summary>Wanted against seen, for the caller's own refusal line.</summary>
    internal string Describe() => $"wanted {this.RequiredLocale}, saw '{this.readLiveLocale()}'";
}
