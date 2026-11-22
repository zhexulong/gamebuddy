using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// One native site that takes the body through <c>Farmer.noMovementPause</c>, with the duration it really writes.
///
/// <para>
/// `noMovementPause` is a plain public FIELD (`Farmer.cs:793`), so there is no setter to patch; the three methods that
/// write it are the observation instead, and they are also where the three holders' real durations come from - 200 ms for
/// the emote (`Farmer.cs:2505`), 500 ms for the pool entrance (`GameLocation.cs:3819`), 200 ms for the emote selector
/// (`EmoteSelector.cs:228`). A fourth writer of that field would show up as an undeclared site, named by
/// <see cref="BodyHoldProbe"/>'s `CanMove` observation, exactly like any other writer.
/// </para>
/// </summary>
internal sealed record NativeBodyPauseSite(string Holder, int DurationMs, Type Owner, string MethodName, Type[] Parameters);

/// <summary>
/// The probe that turns "the body cannot move" into "this frame took it": a Harmony postfix on the engine's own
/// <c>Farmer.CanMove</c> setter, plus one prefix/postfix pair on each of the three <c>noMovementPause</c> writers.
///
/// <para>
/// WHY THE SETTER AND NOT THE WRITERS. Roughly sixty native sites write <c>CanMove</c>; observing them one by one would be
/// sixty edits with no authority behind them, and the sixty-first would be invisible again. The setter sees whoever
/// writes, and every observation is written through <see cref="BodyHold"/> - so a site nobody declared still arrives
/// named, which is the class `round88`'s five-minute freeze belongs to.
/// </para>
/// <para>
/// WHAT IT DOES NOT SEE, stated rather than left to be discovered: a write to the backing field <c>Farmer.canMove</c>
/// (one native site does exactly that, `Farmer.cs:4065`) never enters the property, and a caller the runtime inlined is
/// not observed either. Both cases land in the receipt as <c>defect=hold_without_owner</c> - the honest absence - and
/// <see cref="BodyHold.Counts"/> publishes how many writes were seen at all, so a probe that never fires cannot be
/// mistaken for a body nothing took.
/// </para>
/// </summary>
internal static class BodyHoldProbe
{
    private const int LoggedSiteLimit = 32;
    private const int StackFramesInLine = 6;

    /// <summary>The site word for a write whose stack carries nothing but the setter: named as unknown, never invented.</summary>
    internal const string UnknownSite = "unknown_site";

    /// <summary>
    /// The farmer whose writes are this body's. Null means <c>Game1.player</c>, which is the actor this Mod owns; a test
    /// process has no player, so the gate sets it rather than standing in for the engine.
    /// </summary>
    internal static Farmer? ObservedActor;

    private static readonly NativeBodyPauseSite[] PauseSites =
    {
        new(BodyHold.EmoteHolder, BodyHold.EmoteMs, typeof(Farmer), "performPlayerEmote", new[] { typeof(string) }),
        new(BodyHold.PoolEntranceHolder, BodyHold.PoolEntranceMs, typeof(GameLocation), "performTouchAction", new[] { typeof(string[]), typeof(Microsoft.Xna.Framework.Vector2) }),
        new(BodyHold.EmoteSelectorHolder, BodyHold.EmoteSelectorMs, typeof(StardewValley.Menus.EmoteSelector), "cleanupBeforeExit", Type.EmptyTypes),
    };

    private static readonly HashSet<string> loggedSites = new(StringComparer.Ordinal);
    private static Action<string> report = _ => { };
    private static bool installed;
    private static bool siteLimitReported;

    /// <summary>The three native timers, as declared holders with their real durations.</summary>
    internal static IReadOnlyList<NativeBodyPauseSite> DeclaredPauseSites => PauseSites;

    internal static bool IsInstalled => installed;

    /// <summary>The property setter the probe observes, or null when the target version has moved it.</summary>
    private static MethodInfo? CanMoveSetter() => AccessTools.PropertySetter(typeof(Farmer), nameof(Farmer.CanMove));

    /// <summary>Every method the probe binds, resolved from the loaded game assembly - the population a pin test reads.</summary>
    internal static IReadOnlyList<MethodInfo> ResolveTargets()
    {
        var targets = new List<MethodInfo>();
        if (CanMoveSetter() is { } setter)
            targets.Add(setter);
        foreach (NativeBodyPauseSite site in PauseSites)
        {
            if (AccessTools.Method(site.Owner, site.MethodName, site.Parameters) is { } pause)
                targets.Add(pause);
        }

        return targets;
    }

    /// <summary>
    /// Installs the probe. Returns null when the body observation is installed, or the reason it is not - the setter is
    /// the half that cannot be missing, because without it a write has no name at all.
    /// </summary>
    internal static string? TryInstall(Harmony harmony, Action<string> write)
    {
        report = write;
        MethodInfo? setter = CanMoveSetter();
        MethodInfo? observe = AccessTools.Method(typeof(BodyHoldProbe), nameof(CanMoveSet));
        MethodInfo? before = AccessTools.Method(typeof(BodyHoldProbe), nameof(PauseBefore));
        MethodInfo? after = AccessTools.Method(typeof(BodyHoldProbe), nameof(PauseAfter));
        if (setter is null || observe is null || before is null || after is null)
            return "Farmer.CanMove has no settable property in this version";

        var bound = new List<string>();
        var unbound = new List<string>();
        try
        {
            harmony.Patch(setter, postfix: new HarmonyMethod(observe));
            bound.Add("Farmer.CanMove(set)");
            foreach (NativeBodyPauseSite site in PauseSites)
            {
                if (AccessTools.Method(site.Owner, site.MethodName, site.Parameters) is not { } pause)
                {
                    unbound.Add(site.Holder);
                    continue;
                }

                harmony.Patch(pause, prefix: new HarmonyMethod(before), postfix: new HarmonyMethod(after));
                bound.Add(site.Holder);
            }
        }
        catch (Exception error)
        {
            installed = false;
            return $"patch failed on {setter.DeclaringType?.Name}.{setter.Name}: {error.GetType().Name}";
        }

        installed = true;
        // NAMED, because "the probe reported nothing" has two very different causes - no writer, or no patch - and the
        // engine-loop probe's first run wrote `frames=0` for its whole life without this line.
        report($"GameBuddy body-hold probe installed on {bound.Count} site(s): {string.Join(",", bound)}"
            + (unbound.Count == 0 ? "." : $"; not bound (their writes will arrive as undeclared sites): {string.Join(",", unbound)}."));
        return null;
    }

    /// <summary>
    /// The setter's postfix. The value is observed even when it repeats, because the engine re-asserts
    /// <c>CanMove = false</c> every tick while a countdown runs: only the FIRST write of a hold is a declaration, and a
    /// repeat is the engine confirming it.
    /// </summary>
    private static void CanMoveSet(Farmer __instance, bool value)
    {
        if (__instance is null || !ReferenceEquals(__instance, Actor()))
            return;
        ObserveCanMove(value, new StackTrace(1, false));
    }

    /// <summary>
    /// One observed write of <c>CanMove</c>: declared by a hold the ledger already knows, or named as the frame that took
    /// it and declared as an open-ended hold.
    ///
    /// <para>
    /// The three known timers reach here too, and are reported as attributed: their own writers declared the hold with its
    /// window, so the engine's per-tick `CanMove = false` inside that window is confirmation rather than a new holder.
    /// </para>
    /// </summary>
    internal static void ObserveCanMove(bool value, StackTrace stack)
    {
        // The one seam every writer passes through, and the reason this is an observation rather than a second authority:
        // the ledger is told what the engine did, and the receipt reads the ledger.
        BodyHoldFact held = BodyHold.DescribeBodyHold();
        if (value)
        {
            // The engine's own release: `doneWithAnimation`, `forceCanMove`, the countdown's own `CanMove = true`. The
            // holder named here is the one the ledger holds, so a release can never end someone else's hold.
            if (!held.IsFree && held.Holder is { } holder)
                BodyHold.Release(holder);
            return;
        }

        if (!held.IsFree)
        {
            BodyHold.NoteWriteObserved(attributedToDeclaredHold: true);
            return;
        }

        BodyHold.NoteWriteObserved(attributedToDeclaredHold: false);
        string site = SiteOf(stack) ?? UnknownSite;
        string declared = BodyHold.HolderForSite(site);
        BodyHold.TryHold(declared, BodyHold.UndeclaredWriterReason, endsAtMs: null);
        LogSiteOnce(
            site,
            $"[body-hold] unattributed site={site};declared={declared};open_ended=true;{ClockField(Game1.currentGameTime?.TotalGameTime)};frames={FramesOf(stack)}");
    }

    /// <summary>
    /// One native <c>noMovementPause</c> writer, before and after: the site declared its timer only when the pause it
    /// wrote actually took - `Math.Max` means an emote raised inside a longer pool-entrance pause did not take the body,
    /// and calling that emote the holder would name the wrong site.
    ///
    /// <para>
    /// The window is the value the ENGINE holds afterwards, not the duration this table expects: `Math.Max` lets a site
    /// only keep what an older pause left, so the measured value is the one that is really in force.
    /// <see cref="EveryDeclaredDurationIsTheOneTheEnginesSiteWrites"/> is where the expectation is pinned instead.
    /// </para>
    /// </summary>
    internal static void ObserveBodyPause(NativeBodyPauseSite site, int before, int after)
    {
        if (after <= before)
            return;
        string holder = site.Holder;
        if (!BodyHold.TryHold(holder, BodyHold.NativeTimerReason, BodyHold.NowMs() + after))
            return;
        LogSiteOnce(
            holder,
            $"[body-hold] declared holder={holder};reason={BodyHold.NativeTimerReason};pause_ms={after};site_duration_ms={site.DurationMs}");
    }

    private static void PauseBefore(out int __state) => __state = Actor()?.noMovementPause ?? 0;

    private static void PauseAfter(int __state, MethodBase __originalMethod)
    {
        NativeBodyPauseSite? site = PauseSites.FirstOrDefault(candidate =>
            candidate.MethodName == __originalMethod.Name && candidate.Owner == __originalMethod.DeclaringType);
        if (site is not null)
            ObserveBodyPause(site, __state, Actor()?.noMovementPause ?? 0);
    }

    private static Farmer? Actor() => ObservedActor ?? Game1.player;

    /// <summary>
    /// The two clocks a writer is placed by, read at the moment of the write.
    ///
    /// <para>
    /// MEASURED `round89` (2026-11-21T20-38-52-354Z): 14 `[body-hold] unattributed` lines named their frames and not one
    /// carried a clock, so the verdict could say `FishingRod.tickUpdate` and not when - a writer unjoinable to the receipt
    /// that would explain it. `game_ms` is the engine's OWN elapsed game time, which stops when the game does (a paused
    /// world's write belongs to the same game millisecond however long the player waited); `wall_ms` is that same instant
    /// on the receipt stream's clock (`atMs`), which is the one a reader can join on.
    /// </para>
    /// <para>
    /// `TotalGameTime.TotalMilliseconds` and not `.Milliseconds`: the latter is 0..999 and would place every write inside
    /// the same second of every minute. `none` rather than 0 when no game clock exists (the test process runs no game): 0
    /// would read as a write at the engine's first millisecond, which is a time nobody can check.
    /// </para>
    /// </summary>
    internal static string ClockField(TimeSpan? elapsedGameTime) =>
        "game_ms="
        + (elapsedGameTime is { } elapsed
            ? ((long)elapsed.TotalMilliseconds).ToString(CultureInfo.InvariantCulture)
            : "none")
        + ";wall_ms="
        + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// The first frame that is neither this probe nor the engine's own setter: the site that took the body.
    ///
    /// Harmony's detour frames and this class's own frames are skipped by identity, so the answer is a caller rather than
    /// "whichever of our helpers ran last". Null when the stack carries nothing but the setter, which is then reported as
    /// <c>unknown_site</c> instead of being invented.
    /// </summary>
    internal static string? SiteOf(StackTrace stack)
    {
        for (int index = 0; index < stack.FrameCount; index++)
        {
            MethodBase? method = stack.GetFrame(index)?.GetMethod();
            if (method is null)
                continue;
            Type? owner = method.DeclaringType;
            if (owner is null || owner == typeof(BodyHoldProbe))
                continue;
            if (method.Name == "set_CanMove" || method.Name == "CanMoveSet")
                continue;
            return $"{owner.Name}.{method.Name}";
        }

        return null;
    }

    private static string FramesOf(StackTrace stack)
    {
        var frames = new List<string>(StackFramesInLine);
        for (int index = 0; index < stack.FrameCount && frames.Count < StackFramesInLine; index++)
        {
            MethodBase? method = stack.GetFrame(index)?.GetMethod();
            if (method?.DeclaringType is not { } owner || owner == typeof(BodyHoldProbe))
                continue;
            frames.Add($"{owner.Name}.{method.Name}");
        }

        return frames.Count == 0 ? "none" : string.Join("<", frames);
    }

    /// <summary>
    /// Reports one site the first time it takes the body, and never again: a per-write line would be one line every tick
    /// for the whole of a hold, which is how an instrument becomes part of the defect it measures. The set is bounded
    /// (<see cref="LoggedSiteLimit"/>) and the cap is reported, so a run with more sites than that is still visible.
    /// </summary>
    private static void LogSiteOnce(string key, string line)
    {
        if (!loggedSites.Add(key))
            return;
        if (loggedSites.Count > LoggedSiteLimit)
        {
            if (!siteLimitReported)
            {
                siteLimitReported = true;
                report($"[body-hold] more than {LoggedSiteLimit} distinct sites; further sites are counted rather than logged individually");
            }

            return;
        }

        report(line);
    }

    /// <summary>Forgets the logged sites and the observed actor. Test-only: production has one process and one body.</summary>
    internal static void Reset()
    {
        loggedSites.Clear();
        siteLimitReported = false;
        installed = false;
        ObservedActor = null;
        report = _ => { };
        BodyHold.Reset();
    }
}
