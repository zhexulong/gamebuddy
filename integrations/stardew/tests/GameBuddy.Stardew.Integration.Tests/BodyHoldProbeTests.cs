using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using HarmonyLib;
using StardewValley;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `a_body_hold_names_its_writer:&lt;site&gt;` - the probe that turns "she cannot move" into "this frame took her".
///
/// <para>
/// MEASURED `round88`, day 6 17:00: the game clock froze for five minutes (three `solicit` reads 150 s apart, byte-identical
/// at `timeOfDay 1700`), 29 receipts said <c>held_by=stalled_with_no_holder:CanMove</c>, and none of the three timers the
/// Mod knew about was running - `body_pause=0`, `noMovementPause=0` - while the last fact before the freeze was
/// `emote_started`, whose pause is 200 ms. A named absence is honest and it is not solved: whoever wrote the flag held the
/// whole clock, because the engine's own `shouldTimePass()` reads it (`Game1.cs:9307-9310`).
/// </para>
///
/// <para>
/// SO THE GATE IS A SYNTHETIC FOURTH SITE. The probe is installed for real - a Harmony postfix on the engine's own
/// <c>Farmer.CanMove</c> setter, which is the ONE seam any writer passes through - and then a test method that is not one of
/// the three known timers takes the flag. The gate is red unless the log names that method and the ledger hands the
/// receipt the same name; if the setter cannot be patched the gate says so instead of passing on nothing.
/// </para>
///
/// <para>
/// It also stays in the tree once the declaration has landed: <see cref="TheProductInstallsTheProbe"/> reads the Mod's own
/// entry point, because a probe nobody installs is indistinguishable from a probe that saw nothing.
/// </para>
/// </summary>
[Collection(BodyHoldLedgerGates.Name)]
public sealed class BodyHoldProbeTests
{
    private const string HarmonyId = "gamebuddy.body-hold-gate";
    private const string ModEntry = "integrations/stardew/ModEntry.cs";

    /// <summary>The one word every line this probe writes starts with, so a gate reads its own lines and not the install line.</summary>
    private const string LinePrefix = "[body-hold]";

    private static readonly Regex PauseWrite = new(
        @"noMovementPause\s*=\s*(?:Math\.Max\([^,]*,\s*)?(-?\d+)",
        RegexOptions.Compiled);

    private readonly ITestOutputHelper output;

    public BodyHoldProbeTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// THE GATE: a site that is none of the three known timers takes the flag and is NAMED, in the log and in the ledger.
    /// </summary>
    [Fact]
    public void AFourthSiteThatTakesTheBodyIsNamedInTheLogAndInTheHold()
    {
        var lines = new List<string>();
        Farmer actor = UninitializedActor();
        BodyHoldProbe.Reset();
        BodyHoldProbe.ObservedActor = actor;
        Harmony harmony = new(HarmonyId);
        try
        {
            string? failure = BodyHoldProbe.TryInstall(harmony, lines.Add);
            failure.Should().BeNull("blocked: {0}", failure);
            BodyHoldProbe.IsInstalled.Should().BeTrue(
                "blocked: the engine's CanMove setter could not be patched, so this gate would examine nothing at all");

            // THE SYNTHETIC FOURTH SITE. Not `performPlayerEmote`, not the pool entrance, not the emote selector - a method
            // of this test assembly that writes the same engine property.
            TheFourthSiteTakesTheBody(actor);

            this.output.WriteLine(string.Join(Environment.NewLine, lines));
            lines.Should().Contain(
                line => line.StartsWith(LinePrefix, StringComparison.Ordinal)
                    && line.Contains(nameof(TheFourthSiteTakesTheBody), StringComparison.Ordinal),
                "the probe has to log the frame that took the body, or the next freeze is the same absence again");

            BodyHoldFact hold = BodyHold.DescribeBodyHold();
            hold.State.Should().Be(BodyHoldState.HeldOpen, "nothing declared a window for this site");
            hold.Holder.Should().Be(
                BodyHold.HolderForSite($"{nameof(BodyHoldProbeTests)}.{nameof(TheFourthSiteTakesTheBody)}"),
                "the receipt reads the ledger, so the ledger has to carry the same name the log carries");
            BodyHold.Counts.Undeclared.Should().Be(1);
        }
        finally
        {
            harmony.UnpatchAll(HarmonyId);
            BodyHoldProbe.Reset();
        }
    }

    /// <summary>
    /// A WRITER NAMED BUT NOT PLACED IN TIME IS HALF AN ANSWER. Measured `round89`
    /// (2026-11-21T20-38-52-354Z): 14 `[body-hold] unattributed` lines named their frames and none carried a clock, so
    /// no line could be joined to the receipt that would have explained it - the verdict could say `FishingRod.tickUpdate`
    /// and not when. The line therefore carries two clocks taken at the same instant: `game_ms`, the engine's own elapsed
    /// game time (which stops when the game does), and `wall_ms`, the receipt stream's clock (`atMs`), which is what the
    /// join is made on.
    /// </summary>
    [Fact]
    public void TheLineCarriesBothClocksSoAWriterCanBePlacedInTime()
    {
        var lines = new List<string>();
        Farmer actor = UninitializedActor();
        BodyHoldProbe.Reset();
        BodyHoldProbe.ObservedActor = actor;
        Harmony harmony = new(HarmonyId);
        try
        {
            string? failure = BodyHoldProbe.TryInstall(harmony, lines.Add);
            failure.Should().BeNull("blocked: {0}", failure);

            long before = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            TheFourthSiteTakesTheBody(actor);
            long after = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            string line = lines.Single(candidate => candidate.StartsWith(LinePrefix, StringComparison.Ordinal));
            this.output.WriteLine(line);
            Match game = Regex.Match(line, @";game_ms=(?<clock>\d+|none);");
            Match wall = Regex.Match(line, @";wall_ms=(?<clock>\d+);");
            game.Success.Should().BeTrue("the line names the engine's own clock, or `none` where there is no game clock");
            wall.Success.Should().BeTrue("the line names the receipt stream's clock, which is the one the join is made on");
            game.Groups["clock"].Value.Should().Be(
                "none",
                "this process runs no game, so the engine clock is the honest absence rather than 0 - a 0 would read as \"the write happened at the engine's first millisecond\"");
            long stamped = long.Parse(wall.Groups["clock"].Value, CultureInfo.InvariantCulture);
            stamped.Should().BeInRange(before, after, "the wall clock is read at the write, not at install time");
        }
        finally
        {
            harmony.UnpatchAll(HarmonyId);
            BodyHoldProbe.Reset();
        }
    }

    /// <summary>
    /// The engine's clock is TOTAL elapsed game time, not the time of day: `TotalGameTime.Milliseconds` is 0..999 and a
    /// line carrying it would place every write inside one second of the same minute. The boundary is past a day, where a
    /// time-of-day reading and the elapsed reading cannot agree.
    /// </summary>
    [Fact]
    public void TheEngineClockIsTotalElapsedGameTimeAndAbsenceIsNamed()
    {
        BodyHoldProbe.ClockField(TimeSpan.FromMilliseconds(12_345_678)).Should().StartWith(
            "game_ms=12345678;wall_ms=",
            "the clock is the elapsed total, so it is monotonic across a session and the wall clock follows it");
        BodyHoldProbe.ClockField(TimeSpan.FromMilliseconds(90_061_001)).Should().StartWith(
            "game_ms=90061001;",
            "25 h of game time reads as 90061001 ms - `.Milliseconds` would read 61001 and place every day alike");
        BodyHoldProbe.ClockField(null).Should().StartWith("game_ms=none;", "no engine clock is named as absent, never as 0");
    }

    /// <summary>
    /// The other half of the same seam: a write INSIDE a declared hold is that hold still running, so it is attributed and
    /// logged nothing - which is what keeps the three known timers from flooding their own evidence.
    /// </summary>
    [Fact]
    public void AWriteInsideADeclaredHoldIsAttributedAndNotLogged()
    {
        var lines = new List<string>();
        Farmer actor = UninitializedActor();
        BodyHoldProbe.Reset();
        BodyHoldProbe.ObservedActor = actor;
        Harmony harmony = new(HarmonyId);
        try
        {
            string? failure = BodyHoldProbe.TryInstall(harmony, lines.Add);
            failure.Should().BeNull("blocked: {0}", failure);

            BodyHold.TryHold(BodyHold.EmoteHolder, BodyHold.NativeTimerReason, BodyHold.NowMs() + BodyHold.EmoteMs).Should().BeTrue();
            TheFourthSiteTakesTheBody(actor);

            BodyHold.DescribeBodyHold().Holder.Should().Be(
                BodyHold.EmoteHolder,
                "a write inside someone else's window is that window, not a new holder");
            BodyHold.Counts.Attributed.Should().Be(1);
            lines.Should().NotContain(line => line.StartsWith(LinePrefix, StringComparison.Ordinal));

            // The engine's own release ends the declared hold, whoever writes the true.
            actor.CanMove = true;
            BodyHold.DescribeBodyHold().Should().Be(BodyHoldFact.Free);
        }
        finally
        {
            harmony.UnpatchAll(HarmonyId);
            BodyHoldProbe.Reset();
        }
    }

    /// <summary>
    /// <summary>
    /// A pause the engine KEPT is not a declaration. `Math.Max` means an emote raised inside the pool entrance's longer
    /// pause leaves the field where it was, so naming the emote there would name the wrong site and promise a window the
    /// engine is not running.
    /// </summary>
    [Fact]
    public void APauseThatTheEngineKeptIsNotDeclaredAsThatSitesHold()
    {
        BodyHoldProbe.Reset();
        try
        {
            NativeBodyPauseSite emote = BodyHoldProbe.DeclaredPauseSites.Single(site => site.Holder == BodyHold.EmoteHolder);

            BodyHoldProbe.ObserveBodyPause(emote, before: BodyHold.PoolEntranceMs, after: BodyHold.PoolEntranceMs);
            BodyHold.DescribeBodyHold().Should().Be(
                BodyHoldFact.Free,
                "the pool entrance's longer pause is what holds the body, and the emote did not take it");

            BodyHoldProbe.ObserveBodyPause(emote, before: 0, after: BodyHold.EmoteMs);
            BodyHold.DescribeBodyHold().Holder.Should().Be(BodyHold.EmoteHolder);
            BodyHold.DescribeBodyHold().State.Should().Be(BodyHoldState.Held);
        }
        finally
        {
            BodyHoldProbe.Reset();
        }
    }

    /// <summary>
    /// The three timers are declared holders with the durations THEIR OWN sites write - 200 ms, 500 ms, 200 ms - and all
    /// four methods the probe binds still exist in the loaded game assembly.
    /// </summary>
    [Fact]
    public void TheThreeTimersAreDeclaredHoldersAndEveryTargetTheProbeBindsStillExists()
    {
        string declared = string.Join(
            ",",
            BodyHoldProbe.DeclaredPauseSites.Select(site => $"{site.Holder}:{site.DurationMs.ToString(CultureInfo.InvariantCulture)}"));
        this.output.WriteLine($"declared timers: {declared}");
        declared.Should().Be(
            $"{BodyHold.EmoteHolder}:{BodyHold.EmoteMs},{BodyHold.PoolEntranceHolder}:{BodyHold.PoolEntranceMs},{BodyHold.EmoteSelectorHolder}:{BodyHold.EmoteSelectorMs}",
            "the three timers are three holders, and a fourth declared timer would have to be added to the table AND here");

        string[] bound = BodyHoldProbe.ResolveTargets()
            .Select(target => $"{target.DeclaringType?.Name}.{target.Name}")
            .ToArray();
        bound.Should().BeEquivalentTo(
            new[] { "Farmer.set_CanMove", "Farmer.performPlayerEmote", "GameLocation.performTouchAction", "EmoteSelector.cleanupBeforeExit" },
            "the probe observes the one setter plus the three writers of the field that has no setter of its own");
    }

    /// <summary>
    /// Each declared window is the number the engine's own site writes into <c>Farmer.noMovementPause</c>, read out of the
    /// decompiled tree: a version that changes a duration reds here instead of leaving a holder that promises a window the
    /// engine does not honour.
    /// </summary>
    [Fact]
    public void EveryDeclaredDurationIsTheOneTheEnginesSiteWrites()
    {
        (string Path, string Declaration, int DeclaredMs)[] sites =
        {
            ("StardewValley/Farmer.cs", "public void performPlayerEmote(string emote_string)", BodyHold.EmoteMs),
            ("StardewValley/GameLocation.cs", "public virtual void performTouchAction(string[] action, Vector2 playerStandingPosition)", BodyHold.PoolEntranceMs),
            ("StardewValley.Menus/EmoteSelector.cs", "protected override void cleanupBeforeExit()", BodyHold.EmoteSelectorMs),
        };

        foreach ((string path, string declaration, int declaredMs) in sites)
        {
            IReadOnlyList<string> body = DecompiledSource.MethodBody(DecompiledSource.Lines(path), declaration);
            body.Should().NotBeEmpty($"the site {declaration} has to still exist, or the holder has no writer");
            int? written = WrittenPauseMs(body);
            this.output.WriteLine($"{path}: {declaration} -> noMovementPause={written?.ToString(CultureInfo.InvariantCulture) ?? "none"}");
            written.Should().Be(declaredMs, $"{path} writes the pause its holder's window is declared from");
        }
    }

    /// <summary>
    /// A probe nobody installs is indistinguishable from a probe that saw nothing, so the product's own entry point is what
    /// this gate reads - the same reason <c>EngineLoopProbe</c>'s first placement (inside a guarded block) was a defect.
    /// </summary>
    [Fact]
    public void TheProductInstallsTheProbe()
    {
        string source = File.ReadAllText(System.IO.Path.Combine(RepositoryRoot(), ModEntry.Replace('/', System.IO.Path.DirectorySeparatorChar)));

        source.Should().Contain("BodyHoldProbe.TryInstall(", "the Mod's Entry has to install the probe, and keep doing it");
    }

    private static void TheFourthSiteTakesTheBody(Farmer actor) => actor.CanMove = false;

    /// <summary>The number a site assigns to <c>noMovementPause</c>, out of the decompiled body with its comments removed.</summary>
    private static int? WrittenPauseMs(IReadOnlyList<string> body)
    {
        foreach (string line in DecompiledSource.Code(body))
        {
            Match match = PauseWrite.Match(line);
            if (match.Success)
                return int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
        }

        return null;
    }

    /// <summary>
    /// The actor the probe observes: a Farmer with its fields default-initialised, the same shape the hold gates build -
    /// <c>CanMove</c> is the one member this file touches, and a full Farmer construction needs a game.
    /// </summary>
    private static Farmer UninitializedActor() =>
        (Farmer)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(Farmer));

    private static string RepositoryRoot()
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(System.IO.Path.Combine(directory.FullName, ModEntry.Replace('/', System.IO.Path.DirectorySeparatorChar))))
                return directory.FullName;
        }

        throw new DirectoryNotFoundException($"{ModEntry} is not reachable from {AppContext.BaseDirectory}");
    }
}
