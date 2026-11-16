// Tests for the Mod's one bounded wait for the live game locale.
//
// What is verified here: the state machine (nothing configured / already reached / still
// waiting / the bound passed), the exactness rule the wait is given, and that a run whose
// locale already matches pays nothing for the wait. What is NOT verified here: that the
// live game really reaches the configured locale a second or two after the main menu -
// that is Stardew's own behaviour, measured on the launched game's log (SMAPI's
// `locale set to zh (zh-CN)`), and a unit test has no game to observe.
using FluentAssertions;
using GameBuddy.Stardew;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class LiveGameLocaleWaitTests
{
    private const long TimeoutMs = 30_000;

    /// <summary>A live-locale reader a test can move, and a clock it can advance.</summary>
    private sealed class FakeGameLocale
    {
        public FakeGameLocale(string locale, long nowUnixMs = 1_000)
        {
            this.Locale = locale;
            this.NowUnixMs = nowUnixMs;
        }

        public string Locale { get; set; }

        public long NowUnixMs { get; private set; }

        public void Advance(long milliseconds) => this.NowUnixMs += milliseconds;

        public LiveGameLocaleWait WaitFor(string requiredLocale) =>
            new(
                requiredLocale,
                TimeoutMs,
                live => NativeChatPresentationPolicy.IsSameLocale(requiredLocale, live),
                () => this.Locale,
                () => this.NowUnixMs);
    }

    [Fact]
    public void WithoutAConfiguredLocale_TheWaitNeverHoldsAndNeverExpires()
    {
        FakeGameLocale game = new(locale: string.Empty);
        LiveGameLocaleWait wait = game.WaitFor(string.Empty);

        wait.IsRequired.Should().BeFalse("a run that configured no language leaves the live game locale in charge");
        wait.Evaluate().Should().Be(LiveGameLocaleWaitState.Ready);

        // Not merely "ready now": no deadline was armed, so no amount of time can turn an
        // unconfigured run into a refusal.
        game.Advance(TimeoutMs * 10);
        wait.Evaluate().Should().Be(LiveGameLocaleWaitState.Ready);
    }

    [Fact]
    public void WhenTheLiveLocaleAlreadyMatches_TheWaitIsReadyWithoutReadingTheClock()
    {
        // The "no extra delay" claim, made structural: when the live locale is already the
        // configured one, the wait never consults the clock at all, so it cannot hold a tick.
        LiveGameLocaleWait wait = new(
            "zh-CN",
            TimeoutMs,
            live => NativeChatPresentationPolicy.IsSameLocale("zh-CN", live),
            () => "zh-CN",
            () => throw new InvalidOperationException("a satisfied wait must not arm a deadline"));

        wait.Evaluate().Should().Be(LiveGameLocaleWaitState.Ready);
        wait.Evaluate().Should().Be(LiveGameLocaleWaitState.Ready);
    }

    [Fact]
    public void AnUnreachedLocaleHoldsUntilTheBoundAndThenExpires()
    {
        FakeGameLocale game = new(locale: string.Empty, nowUnixMs: 5_000);
        LiveGameLocaleWait wait = game.WaitFor("zh-CN");

        wait.Evaluate().Should().Be(LiveGameLocaleWaitState.Waiting, "the engine has not applied the locale yet");

        game.Advance(TimeoutMs - 1);
        wait.Evaluate().Should().Be(LiveGameLocaleWaitState.Waiting, "the bound has not passed yet");

        game.Advance(1);
        wait.Evaluate().Should().Be(LiveGameLocaleWaitState.Expired, "the bound is the deadline itself");
    }

    [Fact]
    public void TheLocaleThatArrivesInsideTheBoundLetsTheCallerProceed()
    {
        FakeGameLocale game = new(locale: string.Empty);
        LiveGameLocaleWait wait = game.WaitFor("zh-CN");

        wait.Evaluate().Should().Be(LiveGameLocaleWaitState.Waiting);
        game.Advance(1_500);
        game.Locale = "zh-CN";

        wait.Evaluate().Should().Be(LiveGameLocaleWaitState.Ready, "the engine reached the configured locale");
    }

    [Theory]
    // A native preference-style label is not the live BCP-47 locale: the engine's own
    // language string is what the Host and the Mod both speak, and the fixture path already
    // refuses this exact confusion.
    [InlineData("zh")]
    [InlineData("zh-cn")]
    [InlineData("en-US")]
    [InlineData("")]
    public void OnlyTheExactLiveBcp47LocaleSatisfiesTheWait(string liveLocale)
    {
        FakeGameLocale game = new(locale: liveLocale);

        game.WaitFor("zh-CN").Evaluate().Should().Be(LiveGameLocaleWaitState.Waiting);
    }

    [Fact]
    public void Describe_NamesTheWantedAndTheSeenLocale()
    {
        FakeGameLocale game = new(locale: "en-US");

        game.WaitFor("zh-CN").Describe().Should().Be("wanted zh-CN, saw 'en-US'");
    }
}

/// <summary>A monitor that keeps what the Mod said, so a refusal can be read by name.</summary>
internal sealed class RecordingMonitor : StardewModdingAPI.IMonitor
{
    private readonly List<string> lines = new();

    public IReadOnlyList<string> Lines => this.lines;

    public bool IsVerbose => true;

    public void Log(string message, StardewModdingAPI.LogLevel level = StardewModdingAPI.LogLevel.Trace) =>
        this.lines.Add($"[{level}] {message}");

    public void LogOnce(string message, StardewModdingAPI.LogLevel level = StardewModdingAPI.LogLevel.Trace) =>
        this.lines.Add($"[{level}] {message}");

    public void VerboseLog(string message) => this.lines.Add($"[verbose] {message}");

    // The handler form is a formatting optimization with no plain text to keep: the calls
    // this record exists for are the Mod's own `Log` lines.
    public void VerboseLog(ref StardewModdingAPI.Framework.Logging.VerboseLogStringHandler message) { }
}
