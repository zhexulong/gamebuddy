using System;
using System.Globalization;
using System.Linq;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Quests;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// accept_daily_quest pre-attachment Given: the game is offering a daily help-wanted quest the
    /// player can still accept.
    ///
    /// Only that declared Given is established. The acceptance itself - the native state writes on
    /// <c>Game1.questOfTheDay</c>, the quest-log entry and <c>Farmer.acceptedDailyQuest</c> - belongs
    /// to production, and this fixture emits no receipt and never calls the action.
    ///
    /// WHY THE OFFER IS SET HERE RATHER THAN FOUND: the action TAKES the offer, so the starting state
    /// has to be known and acceptable. The fixture first asks the game for its own offer
    /// (<c>Game1.RefreshQuestOfTheDay()</c>, Game1.cs:2117 - the same method SaveGame.cs:1259 calls
    /// at save load), and only when the game posts nothing today does it fall back to the game's own
    /// generator chain (<c>ResourceCollectionQuest</c>, one of <c>Utility.getQuestOfTheDay</c>'s own
    /// outcomes) and set it through the public <c>NetWorldState.SetQuestOfTheDay</c>. The Given is
    /// then asserted THROUGH THE PRODUCT'S OWN predicate <c>Game1.CanAcceptDailyQuest()</c>
    /// (Game1.cs:7760) - the exact predicate the board's Accept button reads for its <c>visible</c>
    /// flag - so the fixture and the product cannot disagree, and an unacceptable state fails here
    /// with a named error instead of surfacing later as a product refusal that looks like a bug.
    /// </summary>
    private void InitializeNativeLocalAcceptDailyQuestFixture(Farmer player)
    {
        Game1.RefreshQuestOfTheDay();
        if (Game1.questOfTheDay is not Quest posted || string.IsNullOrEmpty(posted.questDescription))
        {
            ResourceCollectionQuest forced = new();
            forced.reloadObjective();
            forced.reloadDescription();
            forced.dailyQuest.Set(newValue: true);
            Game1.netWorldState.Value.SetQuestOfTheDay(forced);
        }

        Quest quest = Game1.questOfTheDay
            ?? throw new InvalidOperationException("fixture_native_local_accept_daily_quest_offer_missing");

        // The other half of the Given the product reads: this offer has NOT been taken, and no stale
        // entry from an earlier run of this fixture is still in the log.
        quest.accepted.Set(newValue: false);
        player.acceptedDailyQuest.Set(newValue: false);
        foreach (Quest stale in player.questLog.Where(candidate => ReferenceEquals(candidate, quest)).ToArray())
            player.questLog.Remove(stale);

        if (!Game1.CanAcceptDailyQuest())
            throw new InvalidOperationException(
                $"fixture_native_local_accept_daily_quest_not_acceptable:quest_type={quest.questType.Value.ToString(CultureInfo.InvariantCulture)};"
                    + $"description_empty={string.IsNullOrEmpty(quest.questDescription).ToString().ToLowerInvariant()};"
                    + $"accepted_daily={player.acceptedDailyQuest.Value.ToString().ToLowerInvariant()}");

        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player fixture precondition: action=accept_daily_quest"
                + $";location={player.currentLocation?.NameOrUniqueName ?? "unknown"}"
                + $";quest_id={ExecutionManager.BuildDailyQuestTargetId(quest)}"
                + $";quest_type={quest.questType.Value.ToString(CultureInfo.InvariantCulture)}"
                + $";day_of_month={Game1.Date.DayOfMonth.ToString(CultureInfo.InvariantCulture)}",
            LogLevel.Info);
    }
}
