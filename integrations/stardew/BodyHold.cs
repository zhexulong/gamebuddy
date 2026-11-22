using System;

namespace GameBuddy.Stardew;

/// <summary>
/// The three states a held body can be in, declared rather than inferred.
///
/// <para>
/// WHY THIS EXISTS. `Farmer.CanMove` is written by roughly sixty native sites and nothing declared who held it, so a
/// stalled body could only be reported as an ABSENCE: measured `round88`, day 6 17:00, the game clock froze for five
/// minutes (three `solicit` reads 150 s apart, byte-identical) while 29 receipts said
/// <c>held_by=stalled_with_no_holder:CanMove</c> - and the engine's own `shouldTimePass()` reads the same flag
/// (`Game1.cs:9307-9310`), so whoever wrote it held the whole clock, not just her next step. None of the three timers
/// the Mod knew about was running (`body_pause=0`, `noMovementPause=0`, `destination_locked=0`), and the last fact
/// before the freeze was `emote_started`, whose pause is 200 ms.
/// </para>
/// <para>
/// So the hold is a state machine with three declared states and no unnamed one. <see cref="BodyHoldState.Free"/> is a
/// body nothing has taken. <see cref="BodyHoldState.Held"/> is a hold that declared when it ends.
/// <see cref="BodyHoldState.HeldOpen"/> is a hold that declared that it does not know when it ends - which is legal
/// because it names its holder, and <c>held-open</c> with NO holder cannot exist: it is the state this Mod cannot
/// represent, so <see cref="TryHold"/> refuses to create it and the receipt names the defect instead.
/// </para>
/// <para>
/// EVERY TRANSITION IS DECLARED, and every state offers a forward action: a bounded hold offers the wait its own window
/// earns, an open-ended hold offers the report that ends the attempt, and a body the authority does not know about is
/// reported as the absence it is (never as a wait, and never as "nothing is admissible", because the authority has
/// measured neither).
/// </para>
/// <para>
/// THE WRITER SIDE IS ONE SEAM. Nothing in this Mod drives the sixty native writes through here - that would be sixty
/// edits with no authority behind them. <see cref="BodyHoldProbe"/> observes the engine's own <c>CanMove</c> setter and
/// writes what it saw through this ledger, so a writer nobody declared still arrives with a name on it.
/// </para>
/// </summary>
internal enum BodyHoldState
{
    Free,
    Held,
    HeldOpen,
}

/// <summary>
/// One declared hold: WHO holds the body, WHY, and - for a bounded hold - the instant its own window ends.
///
/// <para>
/// <c>EndsAtMs</c> is null for <see cref="BodyHoldState.HeldOpen"/> and a wall-clock instant otherwise; it can lie in the
/// past, which is a bounded hold whose window passed while the flag stayed down. That is not the hold silently becoming
/// a different state: it is the same declared hold, reported with its overrun, because the alternative - claiming a
/// holder whose window is gone, or dropping it and claiming nobody - would each be a fact this ledger did not measure.
/// </para>
/// </summary>
internal readonly record struct BodyHoldFact(BodyHoldState State, string? Holder, string? Reason, long? EndsAtMs)
{
    /// <summary>Nothing holds the body. A value rather than null, so "free" is a state and not an absent answer.</summary>
    internal static readonly BodyHoldFact Free = new(BodyHoldState.Free, null, null, null);

    internal bool IsFree => this.State == BodyHoldState.Free;

    /// <summary>
    /// What is left of a bounded hold at <paramref name="nowMs"/>, or null for an open-ended one. Negative means the
    /// declared window has passed.
    /// </summary>
    internal long? RemainingMs(long nowMs) => this.EndsAtMs is long endsAt ? endsAt - nowMs : null;
}

/// <summary>
/// What the probe has seen, so a probe that never fires is visible instead of looking like a body nothing ever took.
///
/// <para>
/// `EngineLoopProbe` learned this the hard way: its first placement wrote `frames=0` for a whole run because nothing had
/// been patched, and the zero was indistinguishable from a frozen engine. A hold probe that reports no writes has the
/// same two causes - no writer, or no patch - so the counts are published beside the hold they describe.
/// </para>
/// </summary>
internal readonly record struct BodyHoldCounts(long Declared, long Attributed, long Undeclared, long Refused);

/// <summary>
/// The one authority for a declared body hold. Game-thread only: every writer is a Harmony postfix on the game thread and
/// every reader is the tick, the admission or the navigation terminal, which all run there too.
/// </summary>
internal static class BodyHold
{
    /// <summary>
    /// The emote's own timer: `performPlayerEmote` writes `Farmer.noMovementPause = Math.Max(noMovementPause, 200)`
    /// (Farmer.cs:2505) and the engine's update writes `CanMove = false` while that counts down (`Farm.cs` :7586-7593).
    /// </summary>
    internal const string EmoteHolder = "body_pause:emote";
    internal const int EmoteMs = 200;

    /// <summary>
    /// The pool entrance's timer: the `PoolEntrance` touch action writes `noMovementPause = 500` (GameLocation.cs:3819),
    /// which is the one site of the three whose window is not 200 ms.
    /// </summary>
    internal const string PoolEntranceHolder = "body_pause:pool_entrance";
    internal const int PoolEntranceMs = 500;

    /// <summary>
    /// The emote selector's timer: `EmoteSelector.cleanupBeforeExit` writes the same 200 ms pause
    /// (EmoteSelector.cs:228), so its window is the emote's and its holder is not - the frame that wrote it is.
    /// </summary>
    internal const string EmoteSelectorHolder = "body_pause:emote_selector";
    internal const int EmoteSelectorMs = 200;

    /// <summary>Why a declared hold exists: a native timer with a known window, or a writer nobody declared.</summary>
    internal const string NativeTimerReason = "native_body_timer";
    internal const string UndeclaredWriterReason = "undeclared_native_writer";

    /// <summary>
    /// The holder word for a write the engine made and nobody declared: the frame that made it, prefixed so the
    /// vocabulary cannot collide with the Mod's own holders. This is the name the probe puts on a fourth site.
    /// </summary>
    internal const string NativeWriterHolderPrefix = "native:";

    private static BodyHoldFact current = BodyHoldFact.Free;
    private static long declared;
    private static long attributed;
    private static long undeclared;
    private static long refused;

    /// <summary>The one clock a hold's window is measured on: monotonic milliseconds, so a wall-clock jump cannot end it.</summary>
    internal static long NowMs() => Environment.TickCount64;

    /// <summary><see cref="NativeWriterHolderPrefix"/> and the site that wrote the flag, as one holder word.</summary>
    internal static string HolderForSite(string site) => NativeWriterHolderPrefix + site;

    /// <summary>
    /// Declares a hold: <c>held(holder, endsAt)</c> when <paramref name="endsAtMs"/> names an instant, <c>held-open(holder)</c>
    /// when it is null.
    ///
    /// <para>
    /// Three declarations are REFUSED, each for the state it cannot represent: no holder (which would be
    /// `held-open` with nobody in it - the state the Mod cannot report, so it must fail loudly here instead), a window
    /// that has already ended (a hold that does not hold), and a holder that is not the incumbent (the body is taken, and
    /// the ledger keeps the holder it already has rather than being overwritten by whoever wrote last).
    /// </para>
    /// </summary>
    internal static bool TryHold(string holder, string reason, long? endsAtMs)
    {
        if (string.IsNullOrWhiteSpace(holder) || string.IsNullOrWhiteSpace(reason))
        {
            refused++;
            return false;
        }

        if (endsAtMs is long endsAt && endsAt <= NowMs())
        {
            refused++;
            return false;
        }

        if (!current.IsFree && string.Equals(current.Holder, holder, StringComparison.Ordinal))
        {
            current = new BodyHoldFact(endsAtMs is null ? BodyHoldState.HeldOpen : BodyHoldState.Held, holder, reason, endsAtMs);
            declared++;
            return true;
        }

        if (!current.IsFree)
        {
            refused++;
            return false;
        }

        current = new BodyHoldFact(endsAtMs is null ? BodyHoldState.HeldOpen : BodyHoldState.Held, holder, reason, endsAtMs);
        declared++;
        return true;
    }

    /// <summary>
    /// Ends <paramref name="holder"/>'s hold. False means that holder was not the one holding the body, and the incumbent
    /// - if any - is untouched: a release from a site that never took it must not free a body someone else owns.
    /// </summary>
    internal static bool Release(string holder)
    {
        if (current.IsFree)
            return false;
        if (!string.Equals(current.Holder, holder, StringComparison.Ordinal))
        {
            refused++;
            return false;
        }

        current = BodyHoldFact.Free;
        return true;
    }

    /// <summary>The one answer every receipt reads: the declared hold, or <see cref="BodyHoldFact.Free"/>.</summary>
    internal static BodyHoldFact DescribeBodyHold() => current;

    /// <summary>Counts one observed write of <c>CanMove</c>, attributed to a declared hold or not.</summary>
    internal static void NoteWriteObserved(bool attributedToDeclaredHold)
    {
        if (attributedToDeclaredHold)
            attributed++;
        else
            undeclared++;
    }

    internal static BodyHoldCounts Counts => new(declared, attributed, undeclared, refused);

    /// <summary>Forgets everything. Test-only: production has one process and one body.</summary>
    internal static void Reset()
    {
        current = BodyHoldFact.Free;
        declared = 0;
        attributed = 0;
        undeclared = 0;
        refused = 0;
    }
}
