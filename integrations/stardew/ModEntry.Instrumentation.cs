using System.Reflection;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Navigation;
using GameBuddy.Stardew.Handlers;
using GameBuddy.Stardew.Sensory;
using HarmonyLib;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewModdingAPI.Utilities;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

/// <summary>
/// The tick instrumentation, split out of ModEntry.cs when that file's size ratchet required a
/// partial. Every member here exists to say WHAT the tick is doing rather than to do it: the phase
/// marker, the background watchdog and its report, the stage sequence, the throttled stage and
/// heartbeat lines, and the probes that answer whether the engine itself is still running. It is a
/// mechanical split of one partial class - same modifiers, same call sites, same authority; the
/// instrumentation only reads state and writes log lines.
/// </summary>
public sealed partial class ModEntry : Mod
{
    // A DIAGNOSTIC helper, kept in the main partial rather than ModEntry.Fixtures.cs: the fixtures partial is a
    // curated surface (every declared method there must be whitelisted and owner-approved), and this only
    // reports why a fixture tick is not advancing. Its callers are the fixture tick path below.
    /// <summary>
    /// The early returns on the fixture tick path that leave NO trace. A stall at the title screen therefore
    /// presents as a bare pipe timeout with no Mod line at all - observed live, and it cost hours - so each
    /// return reports once, naming itself. Once per distinct reason, so a per-tick condition cannot flood the log.
    /// </summary>
    private readonly Dictionary<string, long> blockedTickReasonsLogged = new(StringComparer.Ordinal);

    /// <summary>Name the stage this tick is executing, so a tick that never returns can still be located.</summary>
    private void MarkTickPhase(string phase)
    {
        Volatile.Write(ref this.tickWatchdogPhase, phase);
    }

    /** The engine-loop probe: a frame counter incremented on the game thread and written from a timer thread. */
    private readonly EngineLoopProbe engineLoopProbe = new();

    private void BeginTickWatchdog()
    {
        if (this.tickWatchdog is not null)
            return;
        this.tickWatchdog = new Timer(
            _ =>
            {
                this.engineLoopProbe.WriteSample();
                this.ReportStalledTick();
            },
            null,
            TickWatchdogPeriodMs,
            TickWatchdogPeriodMs);
    }

    private void ReportStalledTick()
    {
        long started = Interlocked.Read(ref this.tickWatchdogTickStartedAtMs);
        long tick = Interlocked.Read(ref this.tickWatchdogTick);
        if (started == 0L)
            return;
        long elapsed = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - started;
        if (elapsed < TickWatchdogStallMs)
            return;
        // One line per stalled tick: the phase is the answer, and repeating it every period would only add noise.
        if (Interlocked.Exchange(ref this.tickWatchdogLastStalledTick, tick) == tick)
            return;
        // The timer thread does NOT log: SMAPI's logger is shared with the console, and a timer callback writing there
        // is a cross-thread lock this thread must not take (the reviewer named it and my own evidence agrees - during
        // every freeze the watchdog's log line was missing even when its file write would have been possible). The
        // report is written here and LOGGED by the game thread on its next tick.
        Volatile.Write(ref this.pendingStalledTickReport, "GameBuddy tick " + tick + " has been running for " + (elapsed / 1000)
            + "s; last phase=" + this.tickWatchdogPhaseForReport() + "; recent=" + this.RecentStageSequenceForReport() + ".");
        // ...and to a FILE as well, because the logger may be exactly what is stuck. Measured 2026-10-19 (g78gate): the
        // engine kept rendering at 60 fps while this lane went silent mid-work, this report never appeared, and SMAPI's log
        // stopped at the same instant - so a logger that blocks would hide the very stall the watchdog exists to report. A
        // plain append from this timer thread needs nothing the game thread holds.
        try
        {
            string directory = Path.Combine(Constants.DataPath, "ErrorLogs");
            Directory.CreateDirectory(directory);
            File.AppendAllText(
                Path.Combine(directory, "gamebuddy-stalled-ticks.txt"),
                $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()};tick={tick};elapsed_ms={elapsed};phase={this.tickWatchdogPhaseForReport()};recent={this.RecentStageSequenceForReport()}" + Environment.NewLine);
        }
        catch
        {
            // The log line above is the primary report; this is the fallback that survives a blocked logger.
        }
    }

    private string tickWatchdogPhaseForReport() => Volatile.Read(ref this.tickWatchdogPhase) ?? "unknown";

    /// <summary>
    /// The steps this lane has entered recently, oldest first, for a watchdog report.
    ///
    /// Why the phase alone is not enough: the lane's seven steps run inside a millisecond, and the on-disk markers are
    /// throttled for volume, so a frozen log can end at a step whose successors never had a chance to print. This
    /// sequence is kept in memory without I/O and is dumped only when a tick stops returning - exactly when it is needed.
    /// </summary>
    private string RecentStageSequenceForReport()
    {
        var ordered = new System.Collections.Generic.List<string>(this.recentStageSequence.Length);
        for (int offset = 0; offset < this.recentStageSequence.Length; offset += 1)
        {
            string? entry = this.recentStageSequence[(this.recentStageCursor + offset) % this.recentStageSequence.Length];
            if (entry is not null) ordered.Add(entry);
        }
        return ordered.Count == 0 ? "(none)" : string.Join(">", ordered);
    }

    /// <summary>
    /// Samples the stage this tick has reached: the first sighting of every distinct stage, and afterwards at most ONE
    /// line per <see cref="StageLogWindowMs"/> for the whole sequence.
    ///
    /// What a reader needs from this line is which stage the lane entered, that the lane is still moving, and whether
    /// the line is a transition or a repeat - hence the tick and <c>gap</c>, the ticks since the previous stage line.
    /// What it must not be is one line per stage per tick: measured 2026-11-12, one multiday run wrote 8 991 lines from
    /// this family alone, and twice a diagnosis read the newest <c>capability_publication_done</c> as the run's "last
    /// line" when nothing about the stages had changed. That line was the previous tick, not a boundary.
    ///
    /// Every call site obeys the one law, because a per-tick bypass is the same defect wherever it is granted: the
    /// in-flight markers used to be forced so the last line of a frozen log named the step immediately before the hung
    /// engine call, and that property now lives in <see cref="recentStageSequence"/>, which the stall watchdog writes to
    /// the log AND to <c>ErrorLogs/gamebuddy-stalled-ticks.txt</c> even when the logger itself is blocked - which is
    /// exactly the freeze where a log line could never have been read.
    /// </summary>
    /// <returns>The line this sample should print, or null when the sample is not due.</returns>
    internal string? StageLogLine(string phase, long nowUnixMs, long tick)
    {
        this.MarkTickPhase(phase);
        // The SEQUENCE is recorded BEFORE the throttle, and it is what lets the throttle be this coarse: a stalled tick
        // reports the steps it entered, so no single log line has to name the step that hung. Recorded on 2026-10-19
        // (g67gate): the log ended at `capability_publication_done` while the hang was in one of the six steps after it,
        // none of which had printed. This is a memory write with no I/O, so recording every step costs nothing.
        this.recentStageSequence[this.recentStageCursor++ % this.recentStageSequence.Length] = phase;
        // The first sighting of a stage is always printed, so the lane's whole vocabulary is in every log even though
        // the steady state keeps only a sample of it.
        bool firstSighting = this.loggedStagePhases.Add(phase);
        if (!firstSighting && nowUnixMs - this.nativeLocalPlayerFixtureLastStageUnixMs < StageLogWindowMs)
            return null;
        this.nativeLocalPlayerFixtureLastStageUnixMs = nowUnixMs;
        long gap = tick - this.nativeLocalPlayerFixtureLastStageTick;
        this.nativeLocalPlayerFixtureLastStageTick = tick;
        return $"[DEBUG-native-local-stage] stage={phase};tick={tick};gap={gap}";
    }

    private void LogStageOnce(string phase)
    {
        string? line = this.StageLogLine(
            phase,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Interlocked.Read(ref this.tickWatchdogTick));
        if (line is null)
            return;
        // Info, not Trace: the liveness meter reads the lane's console capture, and Trace never reaches it.
        this.Monitor.Log(line, LogLevel.Info);
    }

    /// <summary>
    /// Names the gate that is holding the fixture tick, at most once every two seconds per reason.
    /// </summary>
    /// <remarks>
    /// It used to log each reason exactly ONCE. Measured 2026-10-19 (g77loop): the engine kept rendering at 60 fps - the
    /// engine-loop counter advanced 300 frames every five seconds - while this lane's heartbeat stopped for 92 seconds and
    /// nothing else was written. With once-per-reason, a gate that was reported earlier and then held again is invisible,
    /// and "the Mod went quiet" cannot be told from "the Mod is blocked", which is exactly the distinction a stall needs.
    /// The reason is still named; only the repeating is new.
    /// </remarks>
    private void LogBlockedTickReasonOnce(string reason)
    {
        // Every gated return passes through here, so this is where the tick gate span is opened: it names the
        // reason the lane yielded and stays open until a later tick gets past every gate.
        ModTrace.NoteTickGateHeld(reason);
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        bool first = !this.blockedTickReasonsLogged.TryGetValue(reason, out long last);
        if (!first && now - last < 2_000L)
            return;
        this.blockedTickReasonsLogged[reason] = now;
        this.Monitor.Log($"GameBuddy fixture tick is not advancing: {reason}", LogLevel.Warn);
    }

    private FarmhandProvisioningProbe? provisioningProbe;
    private SleepModalProbe? sleepModalProbe;
    private bool sleepModalProbeRejected;
    private PathPredicateProbe? pathPredicateProbe;

    /// <summary>The longest a stage line may take to appear again, in milliseconds: one sample per window, per lane.</summary>
    private const long StageLogWindowMs = 2_000L;

    private long nativeLocalPlayerFixtureLastStageUnixMs;
    /// <summary>The tick the previous stage line reported, so the next one can say how many ticks it skipped.</summary>
    private long nativeLocalPlayerFixtureLastStageTick;
    /// <summary>Stages already printed once this session; their first line is never throttled away.</summary>
    private readonly HashSet<string> loggedStagePhases = new(StringComparer.Ordinal);
    private long nativeLocalPlayerFixtureLastReadinessLogUnixMs;
    /// <summary>The deepest stack this run has sampled, and whether it has already been reported.</summary>
    private int nativeLocalStackFrames;
    private bool nativeLocalStackReported;
private long nativeLocalPlayerFixtureLastHeartbeatUnixMs;
    // The recent step sequence, kept in memory because the LAST LINE of a frozen log is not enough: the lane runs seven
    // steps inside a millisecond, and a throttle that prints only one of them cannot say which one hung. Recorded on
    // 2026-10-19 (g67gate): the log ended at `capability_publication_done` while the hang was in one of the six steps
    // after it, none of which had printed. Memory is cheap here; disk writes on the game thread are not.
    private readonly string[] recentStageSequence = new string[24];

    /// <summary>A stalled-tick report the watchdog thread left for the game thread to log.</summary>
    private string? pendingStalledTickReport;

    /// <summary>The run's span recorder: one Perfetto file next to the SMAPI log, flushed by its own timer thread.</summary>
    private ModTraceRecorder? traceRecorder;

    // The engine's own frame counter, incremented by a Harmony postfix on `Game1.Update` and written to a file by the
    // timer below. Why a FILE and not the Mod log: during the freeze the Mod's tick is not running, so nothing inside
    // it can report; a timer thread can. Why only a counter on the game thread: an earlier instrument wrote ~500 lines a
    // second synchronously and became part of the problem it was measuring.
    private int recentStageCursor;

    /// <summary>
    /// Tick watchdog state: the phase the current tick is in, and when that tick started.
    ///
    /// Measured 2026-10-18 (run g23): the Mod's log stopped at the cross-day lifecycle's
    /// `AwaitingSettlement -> AwaitingSave` while the game process burned a full core for fifteen minutes and the
    /// engine never wrote the save. Every gate already says why it yields, but a tick that never RETURNS cannot
    /// report anything - so a background timer reads these fields and names the phase the tick is stuck in. The
    /// marker is a plain field write on the game thread, which is what makes it affordable to set per stage.
    /// </summary>
    private Timer? tickWatchdog;
    private long tickWatchdogTickStartedAtMs;
    private long tickWatchdogTick;
    private string? tickWatchdogPhase;
    private long tickWatchdogLastStalledTick = -1;
    private long tickCounter;
    private const int TickWatchdogPeriodMs = 5_000;
    private const int TickWatchdogStallMs = 12_000;

    private sealed record NativeLocalMoveStallProbePending(string FarmName, Vector2 PlannedAnchor, bool UseHorseBlock);
    private NativeLocalMoveStallProbePending? nativeLocalMoveStallProbePending;

    /// <summary>
    /// Bounded diagnostics for one native-chat ingress run. It deliberately
    /// accepts a fixed stage vocabulary only: never text, IDs, scope, locale,
    /// token, message body, or exception data.
    /// </summary>
    private void MonitorNativeChatIngress(string stage) =>
        // These fixed redacted stages are the live diagnosis boundary. Debug is
        // retained in the default SMAPI log; Trace is not, which made the
        // previous no-reply run observationally inconclusive.
        this.Monitor.Log($"GameBuddy native chat ingress stage={stage}.", LogLevel.Debug);

    private static Vector2? FindNativeLocalMoveStallAnchor(GameLocation location)
    {
        // The probe's declared Given is "a ROUTE EXISTS from A straight through
        // blocker B to target C". That has to be true for the PLANNER, not just
        // for `isTilePassable`: A* uses `isCollidingPosition(..., pathfinding: true)`
        // (PathFindController.findPath), which additionally rejects Buildings-layer
        // tiles, building footprints, resource clumps and standing animals. A cheap
        // passability scan alone selected a Farm column that the planner refused
        // outright, and the probe then reported `no_native_path` without ever
        // exercising the blocker. So verify with the same planner the action uses,
        // from the actual start tile, and require the path to CROSS B.
        int width = location.map.Layers[0].LayerWidth;
        int height = location.map.Layers[0].LayerHeight;
        for (int y = 4; y < height - 4; y++)
        {
            for (int x = 4; x < width - 4; x++)
            {
                Vector2 a = new(x, y);
                Vector2 b = new(x, y + 1);
                Vector2 c = new(x, y + 2);
                if (!IsMoveStallLineWalkable(location, a, b, c))
                    continue;
                if (!PlannerRoutesThrough(location, a, b, c))
                    continue;
                return a;
            }
        }
        return null;
    }

    private static bool IsMoveStallLineWalkable(GameLocation location, Vector2 a, Vector2 b, Vector2 c)
    {
        foreach (Vector2 tile in new[] { a, b, c })
        {
            // Farmers is excluded from the occupancy mask because the just-warped
            // actor is STANDING on tile A; its own body must not fail the very
            // arrangement it anchors. Every other class still counts, so objects,
            // terrain features, buildings and characters (NPCs, pets) still
            // disqualify a candidate.
            //
            // The first clause is the PLANNER's admission rather than the map's: the Given is a line the A* will step
            // on, and `isTilePassable` called a trellis crop open ground while `isCollidingPosition` refused it.
            if (!StardewBodyController.IsWalkableTile(location, Game1.player, tile)
                || location.objects.ContainsKey(tile)
                || location.terrainFeatures.ContainsKey(tile)
                || location.IsTileOccupiedBy(tile, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false))
                return false;
        }
        return true;
    }

    /// <summary>
    /// The frame count at which a stack is declared to be growing rather than merely deep.
    ///
    /// 200 is far above anything this Mod does by design - the deepest legitimate chain is a dispatch through the
    /// router into one action handler - and far below the ~10,000 frames a 1 MB stack holds, so a runaway recursion is
    /// caught while its frames are still readable.
    /// </summary>
    private const int StackFrameThreshold = 200;
    private void LogNativeLocalPlayerReadinessIfBlocked()
    {
        if (Game1.player is null || (Game1.player.CanMove && Game1.activeClickableMenu is null && !Game1.eventUp))
            return;
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (now - this.nativeLocalPlayerFixtureLastReadinessLogUnixMs < 1_000L)
            return;
        this.nativeLocalPlayerFixtureLastReadinessLogUnixMs = now;
        string state = Game1.activeClickableMenu is not null ? "menu_open" : Game1.eventUp ? "event_active" : !Game1.player.CanMove ? "player_cannot_move" : "unknown";
        // The engine's OWN transition state, which is what a night stalls in: `new_day` is `Game1.NewDay`'s flag,
        // `game_mode` moves through the loading/playing modes, and the fade alpha proves whether the fade is
        // advancing. All three are plain reads, and a stall here is not something the Mod's own phases can show.
        // The clock RATE belongs beside the clock itself: 471 s of wall time bought 540 in-game minutes on the run of
        // 2026-10-25 when the engine's own rate says it should have bought 673, and nothing in any artifact said why.
        // With the rate published, that question is arithmetic instead of inference.
        string engineState = $";new_day={Game1.newDay.ToString().ToLowerInvariant()};game_mode={Game1.gameMode};saving={Game1.game1.IsSaving.ToString().ToLowerInvariant()};fade={Game1.fadeToBlackAlpha.ToString("F2", System.Globalization.CultureInfo.InvariantCulture)};clock_rate_ms={Game1.realMilliSecondsPerGameMinute};game_time={Game1.timeOfDay};paused={Game1.paused.ToString().ToLowerInvariant()};freeze_controls={Game1.freezeControls.ToString().ToLowerInvariant()}";
        this.Monitor.Log($"[DEBUG-native-local-readiness] state={state}{engineState};location={Game1.player.currentLocation?.NameOrUniqueName ?? "unknown"};tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};can_move={Game1.player.CanMove};event_up={Game1.eventUp};menu={Game1.activeClickableMenu?.GetType().Name ?? "none"}.", LogLevel.Trace);
    }

    /// <summary>
    /// Bounded pipeline heartbeat that proves the game-thread tick path is still
    /// executing (and is not frozen in a pipe read or elsewhere). Logs at most
    /// once per 2 seconds, is content-safe, and never changes authority.
    ///
    /// It also carries the PHASE the tick is in, because that is what a freeze needs: the background watchdog can name
    /// a stalled tick only if its own thread gets to run and log, and in the failures that mattered the last line was
    /// a plain heartbeat with no phase at all (measured 2026-10-18, g43cross: the Mod stopped inside a navigation
    /// execution and the harness named the stall 90 s later while the Mod's log said nothing about where it stopped).
    /// The phase is a plain field read, so this costs nothing per tick and turns the last line before any freeze into
    /// the answer: `phase=executions_update` says the body controller never returned.
    /// </summary>
    private void LogNativeLocalPipelineHeartbeat()
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (now - this.nativeLocalPlayerFixtureLastHeartbeatUnixMs < 2_000L)
            return;
        this.nativeLocalPlayerFixtureLastHeartbeatUnixMs = now;
        Farmer? player = Game1.player;
        bool navigateBusy = !(player is null) && this.GetEmbodimentState().Executions?.IsBodyBusy == true;
        bool bridgeConnected = this.ReadinessBridgeConnected();
        // What the READER has seen, which is the half neither side's log showed during the night that hung: the Host only
        // reports its own timer, so `rx=0/0` says "the frame never arrived" while `read>enqueued` says "the Mod dropped
        // it", and `last` names the newest frame.
        LocalPipeBridge.InboundFrameCounters inbound = this.GetEmbodimentState().LocalPipeBridge?.SnapshotInboundFrameCounters()
            ?? default;
        // The OTHER half of the transport, and the one that could lose a receipt without a trace: a frame the outbound
        // queue refused past its cap reached nobody, and the Host waiting for it waited on silence. `tx` is
        // admitted/drained/refused, `peak` is the deepest the queue ever got, and the pair is what tells backpressure
        // (refused with `peak` at the cap) from a dead generation or an oversized frame (refused below it).
        LocalPipeBridge.OutboundFrameCounters outbound = this.GetEmbodimentState().LocalPipeBridge?.SnapshotOutboundFrameCounters()
            ?? default;
        // The numbers that would have explained the deaths the log did not.
        //
        // Three runs (round21, round26, round27) ended the same way: the last Mod line is an ordinary dispatch, the
        // engine loop's tick counter is still advancing at 60 fps, SMAPI writes no shutdown, Windows records no crash,
        // and the process is gone. Nothing in any log was GROWING at the moment it stopped, so the last line said
        // nothing about why. Memory, threads and GC generations are cheap to read every two seconds and are the
        // quantities that actually precede an abrupt death.
        //
        // Read together they answer the question the empty event log cannot: a rising `managedMB`/`wsMB` says the
        // process ran itself out of memory, a flat one says something outside it ended the process - and either answer
        // is actionable, where "the log just stops" is not.
        using System.Diagnostics.Process self = System.Diagnostics.Process.GetCurrentProcess();
        long managedMb = GC.GetTotalMemory(forceFullCollection: false) / (1024 * 1024);
        long workingSetMb = self.WorkingSet64 / (1024 * 1024);
        // STACK DEPTH, because the process is dying of `0xC00000FD` (STATUS_STACK_OVERFLOW) and every other
        // explanation has been excluded by measurement.
        //
        // Measured 2026-11-03: three runs (`round21`, `round26`, `round27`, `round29`) ended with no crash log, no
        // Windows event, the engine at 60 fps to the final tick, a managed heap that had gone FLAT, and 1.6 GB of free
        // memory. The child handle then reported exit code 3221225725, which is `0xC00000FD` - a stack overflow. The
        // last completed span in the Mod's own trace was `mod.dispatch type=program_submit`, 31 ms before the exit.
        //
        // A depth sample every two seconds cannot see the overflow itself (the process is gone at that instant), but it
        // CAN see a stack that grows without returning, which is the only way managed code exhausts a 1 MB stack. The
        // deepest sample is reported with its first frames, once, so the recursion names itself instead of needing a
        // minidump - which this machine cannot take (`admin=False`, no `LocalDumps`, no `dotnet-dump`).
        System.Diagnostics.StackTrace? stack = this.nativeLocalStackFrames < StackFrameThreshold
            ? new System.Diagnostics.StackTrace(1, false)
            : null;
        int stackFrames = stack?.FrameCount ?? this.nativeLocalStackFrames;
        if (stack is not null) this.nativeLocalStackFrames = Math.Max(this.nativeLocalStackFrames, stackFrames);
        if (stackFrames >= StackFrameThreshold && !this.nativeLocalStackReported)
        {
            this.nativeLocalStackReported = true;
            System.Text.StringBuilder deepest = new($"[DEBUG-native-local-stack-depth] frames={stackFrames};top=");
            for (int index = 0; index < Math.Min(12, stack?.FrameCount ?? 0); index++)
            {
                System.Reflection.MethodBase? method = stack?.GetFrame(index)?.GetMethod();
                if (method is null) continue;
                deepest.Append(index == 0 ? "" : "<").Append(method.DeclaringType?.Name).Append('.').Append(method.Name);
            }
            this.Monitor.Log(deepest.ToString(), LogLevel.Warn);
        }
        this.Monitor.Log(
            $"[DEBUG-native-local-heartbeat] location={player?.currentLocation?.NameOrUniqueName ?? "none"};tile={player?.TilePoint.X ?? -1},{player?.TilePoint.Y ?? -1};can_move={player?.CanMove.ToString() ?? "n/a"};navigate={(navigateBusy ? "busy" : "idle")};bridge={(bridgeConnected ? "connected" : "none")};rx={inbound.Read}/{inbound.Enqueued};tx={outbound.Admitted}/{outbound.Drained}/{outbound.Refused};peak={outbound.Peak};txgen={outbound.Generation};last={(inbound.LastType ?? "none")};phase={this.tickWatchdogPhaseForReport()};bodyphase={StardewBodyController.LastPhase};bodyticks={StardewBodyController.EnteredTicks};frame={Game1.ticks};managedMB={managedMb};wsMB={workingSetMb};threads={self.Threads.Count};gc={GC.CollectionCount(0)}/{GC.CollectionCount(1)}/{GC.CollectionCount(2)}",
            LogLevel.Trace);
    }

    /// <summary>Content-free bridge liveness used only by the diagnostic heartbeat.</summary>
    private bool ReadinessBridgeConnected()
    {
        return this.TryGetAiState(out ScreenEmbodimentState state) && state.BridgeSession is not null;
    }
}
