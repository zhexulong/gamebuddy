using System.Diagnostics;

namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>
/// The one monotonic clock a journal event is stamped with, in milliseconds.
///
/// <para>
/// WHY IT IS NOT THE WALL CLOCK: an execution's duration is the difference between the moment the Mod dispatched the
/// native effect and the moment it committed the result. Taken from a clock that can be corrected - by NTP, by the
/// player, by a daylight-saving switch - that difference is not a duration, and a clock that steps backwards makes it a
/// negative one. <see cref="Stopwatch"/> is the same elapsed-time clock the game's own frame timing is built on: it only
/// advances, and only with elapsed time.
/// </para>
/// <para>
/// WHY IT IS NOT INJECTED: a stamp is taken where the event is appended, and no production caller has anything to say
/// about it. The origin is this process's: it is captured when this type is first read (the first journal append of a
/// game session). Durations are all the value is used for, and both ends of one execution are read in the same process,
/// so the origin cancels out; comparing stamps from two game launches is not meaningful and nothing does it.
/// </para>
/// </summary>
internal static class BodyProgramJournalClock
{
    private static readonly Stopwatch Clock = Stopwatch.StartNew();

    /// <summary>Milliseconds elapsed on this process's monotonic clock.</summary>
    internal static long ElapsedMs => Clock.ElapsedMilliseconds;
}
