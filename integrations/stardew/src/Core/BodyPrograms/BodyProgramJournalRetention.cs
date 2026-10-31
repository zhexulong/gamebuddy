using System.Collections.ObjectModel;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>
/// The journal's retention policy: the one place that decides how much durable history a save keeps.
///
/// <para>
/// Why it exists: every append path grew the journal without bound while <see cref="BodyProgramJournalPersistence"/>
/// refused any state past two fixed counts. MEASURED 2026-10-31 on a real save, after ONE run: 63 programs and 550
/// events. Two ordinary sessions therefore reached the program count, <c>Encode</c> began to throw, <c>TryPersist</c>
/// refused every write, and the save could not accept another program at all. The counts are not the defect - raising
/// them only moves the cliff - the missing half was this policy. Both counts stay exactly where they were; what changes
/// is that the writer now keeps the journal under them by construction.
/// </para>
/// <para>
/// What survives, and why each half:
/// </para>
/// <list type="bullet">
/// <item>
/// A program the controller may still need is LIVE and is never evicted. <see cref="BodyProgramState.Active"/> is work
/// still being driven, so dropping it is action loss. <see cref="BodyProgramState.RecoveryRequired"/> is the only
/// durable record of a dispatch whose outcome is unknown, it holds the whole scope closed until it is
/// <c>abandoned</c>, and evicting it would release that quarantine with no settlement event - a silent heal this
/// policy has no authority to perform.
/// </item>
/// <item>
/// A closed program stays queryable for a retry window, because a repeated <c>program_status</c> for a program that
/// just settled is a normal retry and may never answer "not found". The window is ordered by each program's LAST
/// EVENT, not by its position in the array: a long-lived plan that finishes late is the most recent settlement, and a
/// window that retired it in the same write that settled it would fail the caller's own retry.
/// </item>
/// <item>
/// Events survive as a SUFFIX of the log, renumbered to start at 1. The codec's continuity rule (<c>Cursor</c> is the
/// next value after its predecessor, the log starts at 1, and <c>EventHighWater</c> is the entry count) admits no
/// other shape: a bare truncation leaves the high water above the entry count and is refused on read. Renumbering is
/// what the number already means - a POSITION in the retained log, not a generation counter - and no consumer holds a
/// cursor across a save: the run evaluator reads each program from 0 within one run, and the Host forwards cursors
/// without storing them. A caller that asks past the trimmed end gets an empty page and the new high water, which the
/// wire already accepts (<c>local-stardew-bridge.test.ts</c>, "high-water below the requested cursor").
/// </item>
/// </list>
/// </summary>
internal static class BodyProgramJournalRetention
{
    /// <summary>
    /// The most programs a journal this build can have written holds. This is the codec's corruption bound and is
    /// deliberately the number it always was: an upper bound on the writer's own output, not a gameplay limit. The fix
    /// is the writer staying under it, not the reader accepting more.
    /// </summary>
    internal const int MaximumPrograms = 128;

    /// <summary>And likewise the most events, unchanged, for the same reason.</summary>
    internal const int MaximumEvents = 4096;

    /// <summary>
    /// How many closed programs stay queryable when nothing is live. Sized from the measurement that motivated this
    /// policy rather than from a round number: one ordinary run settles 63 programs and that run's own evaluator reads
    /// back the status of every program it submitted, so a window below one run would report <c>not_found</c> for work
    /// that really happened. 96 keeps a whole measured run plus half again.
    /// </summary>
    internal const int RetainedClosedPrograms = 96;

    /// <summary>
    /// Whether this state means "the controller may still need this program", i.e. the program is not history.
    /// <see cref="BodyProgramState.RecoveryRequired"/> belongs here even though it can never run again: see the class
    /// remarks.
    /// </summary>
    internal static bool IsLive(BodyProgramState state) =>
        state is BodyProgramState.Active or BodyProgramState.RecoveryRequired;

    /// <summary>
    /// Returns the retained window of <paramref name="state"/>, or the same instance when it is already inside it.
    /// Idempotent, so a second save cannot move the window and decoding our own payload is a fixpoint.
    ///
    /// <para>
    /// Applied by the single writer (<see cref="OpenBodyProgramJournalAuthority"/>) BEFORE validation and encoding, so
    /// the state that reaches <see cref="BodyProgramJournalPersistence.Encode"/> is always one the reader accepts. The
    /// reader is NOT taught to trim: a file already past the bound was written by the pre-retention build and stays
    /// <c>Corrupt</c>, because reading it would require inventing the settlement order it never recorded.
    /// </para>
    /// </summary>
    internal static BodyProgramJournalState Trim(BodyProgramJournalState state)
    {
        // A malformed state is the validator's to refuse, not this policy's to guess at.
        if (state.Programs is null || state.Events is null || state.Events.Count == 0 || state.Programs.Count == 0) return state;

        Dictionary<string, long> lastCursorByProgram = new(StringComparer.Ordinal);
        foreach (BodyProgramJournalEvent @event in state.Events)
            if (@event is not null && BodyProgramValidation.IsIdentifier(@event.ProgramId))
                lastCursorByProgram[@event.ProgramId] = @event.Cursor;

        // Live programs are never evicted, so they spend the budget first and closed programs get what is left. The
        // floor is 1, not 0: the CLOSED program with the newest event is the one this very write just settled, and the
        // caller's own post-write answer is read back from it by id. Evicting it would turn a successful settlement into
        // a lookup that throws inside the Mod. A journal whose live work alone fills the bound therefore fails the
        // write closed (<c>PersistenceWriteFailed</c>) instead of silently dropping work that may still be driven.
        int live = state.Programs.Count(program => program?.Program is not null && IsLive(program.State));
        int closedBudget = Math.Max(1, MaximumPrograms - live);

        // A program's last event IS the moment it stopped changing - the settlement is appended in the same durable
        // write that closes the program - so ordering by it orders by settlement, whatever order the array is in.
        long[] closedLastCursors = state.Programs
            .Where(program => program?.Program is not null && !IsLive(program.State))
            .Select(program => lastCursorByProgram.TryGetValue(program.Program.ProgramId, out long cursor) ? cursor : 0)
            .Where(cursor => cursor > 0)
            .OrderByDescending(cursor => cursor)
            .ToArray();

        long cut = 1;
        if (closedLastCursors.Length > closedBudget)
            cut = closedLastCursors[closedBudget] + 1;
        if (state.Events.Count > MaximumEvents)
            cut = Math.Max(cut, state.Events[state.Events.Count - MaximumEvents].Cursor);
        if (cut <= state.Events[0].Cursor) return state;

        BodyProgramJournalEvent[] kept = state.Events.Where(@event => @event is not null && @event.Cursor >= cut).ToArray();
        BodyProgramJournalEvent[] events = new BodyProgramJournalEvent[kept.Length];
        for (int index = 0; index < kept.Length; index++)
            events[index] = kept[index] with { Cursor = index + 1 };

        HashSet<string> referenced = events.Select(@event => @event.ProgramId).ToHashSet(StringComparer.Ordinal);
        BodyProgramJournalProgram[] programs = state.Programs
            .Where(program => program?.Program is not null
                && (IsLive(program.State) || referenced.Contains(program.Program.ProgramId)))
            .ToArray();
        return new BodyProgramJournalState(state.SchemaVersion, state.Scope, state.PolicyIdentity, events.Length,
            Array.AsReadOnly(programs), Array.AsReadOnly(events));
    }
}
