using System;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using StardewValley;
using StardewValley.Quests;

namespace GameBuddy.Stardew;

// Accepting the day's help-wanted quest for the `accept_daily_quest` action.
//
// THE SEAM. The accept write is not owned by a reusable game method: it lives inline in the ACCEPT
// branch of the bulletin board's `receiveLeftClick` (Menus/Billboard.cs:363-374), and its only
// in-game caller is that same member (the board is opened from GameLocation.cs:9788 for the
// "Bulletin"/"DailyQuest" action tile). That branch is a literal sequence of native state writes
// with NO game-logic fork, NO confirmation state and NO owned continuation:
//
//     Game1.questOfTheDay.dailyQuest.Value       = true;
//     Game1.questOfTheDay.dayQuestAccepted.Value = Game1.Date.TotalDays;
//     Game1.questOfTheDay.accepted.Value         = true;      // == Quest.accept() (Quest.cs:475)
//     Game1.questOfTheDay.canBeCancelled.Value   = true;
//     Game1.questOfTheDay.daysLeft.Value         = 2;
//     Game1.player.questLog.Add(Game1.questOfTheDay);
//     Game1.player.acceptedDailyQuest.Set(true);
//     UpdateDailyQuestButton();                               // presentation only
//
// Everything in it that changes durable game state is a write to a PUBLIC native member
// (`Quest.dailyQuest`/`accepted`/`canBeCancelled`/`daysLeft`/`dayQuestAccepted`,
// `Farmer.questLog`, `Farmer.acceptedDailyQuest`); `Game1.playSound("newArtifact")` and
// `UpdateDailyQuestButton()` are presentation and are deliberately NOT reproduced. The accepted
// flag is set through the game's own `Quest.accept()` (Quest.cs:475,
// `public virtual void accept() { accepted.Value = true; }`), the named public settlement for that
// half, so the two cannot drift. We never open the board, never call `receiveLeftClick`, and never
// simulate a click; the write half is reproduced on the public fields it writes.
//
// ARGUMENTS are exactly `{ expectedTargetId }`, all required (the protocol has no optional
// argument). `expectedTargetId` is the opaque id `DiscoverDailyQuestTargets` publishes: it binds
// the day (`Game1.Date.TotalDays`), the native quest type and the quest's own id, so a request
// names the offer it read instead of a raw `Quest` object, and a request from another day (or
// against a replaced offer) is a named refusal rather than a silent re-target. There is no
// coordinate: the posted quest is native world state (`NetWorldState.QuestOfTheDay`,
// NetWorldState.cs:536), not a tile, so nothing is walked to.
//
// REFUSALS, each naming its own live fact: no quest posted (`daily_quest_unavailable`), the
// published id no longer describes the live offer (`daily_quest_target_moved`), the offer was
// already taken (`daily_quest_already_accepted`), a posted quest with no text
// (`daily_quest_unavailable`), or the game's own predicate answering false for any other reason
// (`daily_quest_not_acceptable`). `Game1.CanAcceptDailyQuest()` (Game1.cs:7760) is the same
// predicate the board's own Accept button reads for its `visible` flag
// (`UpdateDailyQuestButton`, Billboard.cs:518), so the product and the offer cannot disagree.
//
// POSTCONDITION is an OBSERVABLE WORLD CHANGE read back after the writes: the quest sits in
// `Game1.player.questLog` exactly once, `Game1.questOfTheDay.accepted` is true and
// `Game1.player.acceptedDailyQuest` is true. A body that ran but whose fresh postcondition cannot
// be read is `Uncertain`, never a success.
//
// PHASE. One synchronous store with no await: once the first field is written the body is past any
// cancel point, and admission is `General` - the seam drives no tool lifecycle and starts no swing,
// the same profile `clear_fish_pond` and `toggle_animal_door` admit against.
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// Accept the quest the board is offering today, through the same public state writes the
    /// board's own Accept branch performs. Every refusal names the live fact it read.
    /// </summary>
    public LocalExecutionReceipt RequestLocalAcceptDailyQuest(
        string requestId,
        string expectedTargetId,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        DailyQuestTargetResolution resolution = ResolveDailyQuestTarget(expectedTargetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        return this.ExecuteAcceptDailyQuest(executionId, requestId, expectedTargetId);
    }

    /// <summary>
    /// The one execution body. It re-resolves the offer and re-reads the preconditions against the
    /// live world, because admission and the body are two separate game-thread reads.
    /// </summary>
    private LocalExecutionReceipt ExecuteAcceptDailyQuest(string executionId, string requestId, string expectedTargetId)
    {
        DailyQuestTargetResolution resolution = ResolveDailyQuestTarget(expectedTargetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        Quest quest = resolution.Quest!;
        bool acceptedBefore = quest.accepted.Value;
        bool acceptedDailyBefore = Game1.player.acceptedDailyQuest.Value;
        int logBefore = CountQuestLogEntries(Game1.player, quest);
        int daysLeftBefore = quest.daysLeft.Value;

        // THE WRITE HALF of Billboard.cs:366-372, on the public native members it writes.
        quest.dailyQuest.Value = true;
        quest.dayQuestAccepted.Value = Game1.Date.TotalDays;
        quest.accept();
        quest.canBeCancelled.Value = true;
        quest.daysLeft.Value = 2;
        if (CountQuestLogEntries(Game1.player, quest) == 0)
            Game1.player.questLog.Add(quest);
        Game1.player.acceptedDailyQuest.Set(newValue: true);

        int logAfter = CountQuestLogEntries(Game1.player, quest);
        bool postcondition = logAfter == 1 && quest.accepted.Value && Game1.player.acceptedDailyQuest.Value;
        string evidence =
            $"{resolution.Identity};accepted_before={acceptedBefore.ToString().ToLowerInvariant()};"
            + $"accepted_daily_before={acceptedDailyBefore.ToString().ToLowerInvariant()};days_left_before={daysLeftBefore};"
            + $"quest_log_before={logBefore};quest_log_after={logAfter};days_left_after={quest.daysLeft.Value};"
            + $"accepted_after={quest.accepted.Value.ToString().ToLowerInvariant()};"
            + $"accepted_daily_after={Game1.player.acceptedDailyQuest.Value.ToString().ToLowerInvariant()};"
            + $"daily_after={quest.dailyQuest.Value.ToString().ToLowerInvariant()};"
            + $"can_be_cancelled_after={quest.canBeCancelled.Value.ToString().ToLowerInvariant()};"
            + $"day_accepted_after={quest.dayQuestAccepted.Value}";

        return postcondition
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "daily_quest_accepted", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "daily_quest_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// One resolved offer, or the named reason the published target no longer matches the live
    /// world.
    /// </summary>
    private sealed record DailyQuestTargetResolution(
        bool Accepted,
        string ReasonCode,
        string Evidence,
        string Identity,
        Quest? Quest)
    {
        internal static DailyQuestTargetResolution Reject(string reasonCode, string evidence) =>
            new(false, reasonCode, evidence, string.Empty, null);
    }

    /// <summary>
    /// Re-derives the day's posted quest on the game thread. Every mismatch is a NAMED refusal,
    /// never a silent re-target, and the final gate is the game's own acceptability predicate.
    /// </summary>
    private static DailyQuestTargetResolution ResolveDailyQuestTarget(string expectedTargetId)
    {
        Quest? quest = Game1.questOfTheDay;
        if (quest is null)
            return DailyQuestTargetResolution.Reject(
                "daily_quest_unavailable",
                $"published={expectedTargetId};quest=none;day_of_month={Game1.Date.DayOfMonth}");

        string liveId = BuildDailyQuestTargetId(quest);
        string identity = $"daily_quest_id={liveId};day_of_month={Game1.Date.DayOfMonth};quest_type={quest.questType.Value}";
        if (!string.Equals(liveId, expectedTargetId, StringComparison.Ordinal))
            return DailyQuestTargetResolution.Reject(
                "daily_quest_target_moved",
                $"{identity};published={expectedTargetId}");

        if (Game1.player.acceptedDailyQuest.Value || quest.accepted.Value)
            return DailyQuestTargetResolution.Reject(
                "daily_quest_already_accepted",
                $"{identity};accepted={quest.accepted.Value.ToString().ToLowerInvariant()};"
                    + $"accepted_daily={Game1.player.acceptedDailyQuest.Value.ToString().ToLowerInvariant()}");

        if (string.IsNullOrEmpty(quest.questDescription))
            return DailyQuestTargetResolution.Reject(
                "daily_quest_unavailable",
                $"{identity};description_empty=true");

        // The game's OWN predicate - the same one the board's Accept button reads for its
        // `visible` flag (Billboard.cs:518). The named facts above exist for precision; this is the
        // final authority, so the product and the offer can never disagree about acceptability.
        if (!Game1.CanAcceptDailyQuest())
            return DailyQuestTargetResolution.Reject(
                "daily_quest_not_acceptable",
                $"{identity};can_accept=false");

        return new DailyQuestTargetResolution(true, "accepted", string.Empty, identity, quest);
    }

    /// <summary>
    /// Opaque, stable selector for one day's posted quest: the day, the native quest type and the
    /// quest's own id. The day is deliberately part of the name, so tomorrow's offer is a different
    /// target and a request from a previous run can never silently name it.
    /// </summary>
    internal static string BuildDailyQuestTargetId(Quest quest) =>
        BuildDailyQuestTargetId(quest.questType.Value, quest.id.Value);

    internal static string BuildDailyQuestTargetId(int questType, string questId)
    {
        string raw = string.Create(CultureInfo.InvariantCulture, $"{Game1.Date.TotalDays}:{questType}:{questId}");
        return $"daily_quest_{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// The offer the actor can take right now, projected read-only from the game's own predicate:
    /// at most one entry, published only while `accept_daily_quest` is advertised AND the game
    /// would accept the posted quest. Nothing is synthesized - a day with no posted quest, an
    /// already-accepted offer, or an offer with no text is not advertised, because there is nothing
    /// to accept.
    /// </summary>
    private static IReadOnlyList<BridgeDailyQuestTarget> DiscoverDailyQuestTargets()
    {
        if (!Game1.CanAcceptDailyQuest() || Game1.questOfTheDay is not Quest quest)
            return Array.Empty<BridgeDailyQuestTarget>();
        return new[]
        {
            new BridgeDailyQuestTarget(BuildDailyQuestTargetId(quest), quest.questType.Value, quest.questTitle),
        };
    }

    /// <summary>How many entries in the actor's log are the exact quest instance.</summary>
    private static int CountQuestLogEntries(Farmer player, Quest quest)
    {
        int count = 0;
        for (int index = 0; index < player.questLog.Count; index++)
        {
            if (ReferenceEquals(player.questLog[index], quest))
                count++;
        }
        return count;
    }
}
