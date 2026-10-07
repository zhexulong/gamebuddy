using System;
using System.Globalization;
using System.Linq;
using StardewValley;
using StardewValley.Menus;

namespace GameBuddy.Stardew;

// Talking to a villager, for the `talk_to_npc` action.
//
// WHY THIS IS ITS OWN ACTION. `NPC.checkAction` (NPC.cs:2464) does two things and
// the catalog covered one of them:
//   * the GIFT half — `if (who.ActiveObject != null && !who.isRidingHorse() &&
//     tryToReceiveActiveObject(who))` (:2760-2765, and the same shape at :2498,
//     :2781, :2840) routes into tryToReceiveActiveObject (:1712). That is what
//     `interact_npc_with_item` mirrors, and that action REQUIRES a held item
//     (`slot` + `expectedQualifiedItemId`; it refuses with
//     `item_not_owned_in_slot` without one), so it covers gifting only;
//   * the TALK half — with empty hands the ingress reaches
//     `grantConversationFriendship(who); Game1.drawDialogue(this);` (:2766-2767,
//     and the queued-dialogue sibling at :2807-2811). Nothing invoked it.
// The talk/gift intents are orthogonal and the protocol has NO optional
// arguments (`HasExactProperties` rejects a missing OR extra key), so this is a
// separate action id rather than an optional argument on the gift action. The
// owner ruling is recorded as the method-layer verdict
// `NPC.checkAction@2464 -> newPrimitive("talk_to_npc")`
// (action-development/src/analysis/stardew-action-inventory-reconciliation.mjs:406-411),
// and `talk_to_npc` is already the successor named by the retired policy label
// `npc_talk` (host/src/action-registry.ts:526).
//
// THE SEAM, AND THE BRANCH IT TAKES. The seam is the native entry itself:
// `NPC.checkAction(Game1.player, location)`. With an EMPTY-handed actor and an
// ordinary named villager it runs, in this order:
//   :2466-2469 IsInvisible  -> return false
//   :2470-2478 isSleeping   -> emote + shake, return false
//   :2479-2482 !who.CanMove -> return false
//   :2511-2520 CanReceiveGifts() && no friendship record -> record created
//   :2521-2525 NotifyQuests(OnNpcSocialized) && Game1.dialogueUp -> return true
//   :2723-2747 marriage dialogue / checkForNewCurrentDialogue(heartLevel)
//   :2748-2768 the main talk branch: local player, friendship record present,
//              (endOfRouteMessage || a new current dialogue ||
//               HasLocationOverrideDialogue) -> face the farmer, and because
//              who.ActiveObject is null the gift call is SKIPPED, then
//              grantConversationFriendship + Game1.drawDialogue -> return true
//   :2779-2813 the queued-dialogue sibling: canTalk() && CurrentDialogue.Count > 0
//   :2911-2920 setTemporaryMessages / endOfRouteMessage, else return false
// Everything that decides whether a dialogue appears is inside those lines, so
// re-implementing the branch Mod-side would mean reproducing dialogue-key
// resolution, activeDialogueEvents, mailReceived, heart-level selection and the
// location override hook — the same reason `ride_bus` drives
// BusStop.answerDialogue instead of re-creating the fare/cutscene logic. The
// native entry is therefore called with the precondition that selects the talk
// branch (empty hands), and NOTHING else is reproduced.
//
// WHAT THE NATIVE ENTRY ALSO DOES, named here so the receipt can never pretend a
// different branch was a talk: checkAction has other exits that are reachable
// without changing the arguments. A SPOUSE (:2568-2667) can take the kiss
// branch and return true with no dialogue; the Dwarf in a Mine with the
// Dwarvish translation guide and Krobus in the Sewer (:2848-2857) call
// Utility.TryOpenShopMenu; Leo (:2833-2837) draws a dialogue that arms
// AskLeoMemoryPrompt via Game1.afterDialogues; the pants easter egg
// (:2510/:2808) returns true without drawing. Those are native behaviours of
// talking to those villagers, not something this action should suppress — but
// none of them is the talk branch, so none of them may be reported as
// `npc_talked`. They land in `talk_to_npc_no_dialogue` with the observed menu
// type in the evidence, which is exactly the story: "the native entry handled
// it, and no dialogue came up". No special-case refusals are invented for them.
//
// ARGUMENTS are exactly `{ x, y, expectedTargetId }` — the NPC family's own shape
// (`npc_relationship` / `pet_animal`, FarmhandActionCatalog.Target()), every one
// required. `x,y` is the tile the target was PUBLISHED at, used only as the walk
// leg's destination; the person is re-resolved from the opaque id on the game
// thread and reach is measured against the villager's LIVE tile, never the
// snapshot tile. `expectedTargetId` is the family's existing opaque NPC identity,
// `BuildNpcRelationshipTargetId(location, npcName)` — one villager has ONE
// published target id no matter which of the three NPC actions names it (the
// same "one subject, one published anchor" rule `toggle_animal_door` follows for
// the building's human-door tile). It deliberately contains no coordinate: a
// villager walks, and an id bound to a tile would make every request a race
// (see the comment on that function).
//
// THE DISCOVERY LIST. `talk_to_npc` publishes the same `npcRelationshipTargets`
// entries `npc_relationship`/`interact_npc_with_item` read (published whenever
// any of the three is advertised). That predicate — villager, named, inside the
// discovery radius, with a `friendshipData` record — is the native main talk
// branch's OWN entry precondition (`value != null` at :2748), so this action
// advertises the villagers whose talk branch it can actually serve. A villager
// with no friendship record is NOT advertised: for those, native checkAction
// falls through to the queued-dialogue/shop/memory branches above, which this
// action does not claim to be. See the report for that boundary.
//
// ADMISSION, in the native preconditions' own terms. The shared mechanical
// admission (`AdmitExecution`, profile General) supplies identity -> actionability
// (Idle: no menu, no event, movable) -> deadline -> body exclusivity, which is
// also exactly checkAction's :2479 `!who.CanMove` refusal. Then:
//   * the target resolves to a live villager in the CURRENT location
//     (`talk_to_npc_target_not_found` otherwise);
//   * the villager is in a state checkAction refuses on before any dialogue
//     logic (`talk_to_npc_target_unavailable`, evidence names invisible/sleeping);
//   * the actor is EMPTY-HANDED (`hands_not_empty`). This is the branch's own
//     precondition: with an object in hand native takes the gift path at :2760,
//     which is `interact_npc_with_item`'s intent, not this action's;
//   * the actor is within Chebyshev-1 of the villager's live tile
//     (`target_out_of_range`), else the shared approach leg walks there
//     (`target_out_of_reach` if it cannot) and the whole admission runs again on
//     arrival.
//
// POSTCONDITION, OBSERVED. `checkAction`'s bool is not the evidence — many
// branches return true without a dialogue. The receipt requires the world to
// show the talk BRANCH's own outcome after the call:
// `Game1.dialogueUp` AND `Game1.activeClickableMenu is DialogueBox`. That is
// what `Game1.drawDialogue(speaker)` produces (Game1.cs:9533-9555: it sets
// activeClickableMenu to a DialogueBox and dialogueUp = true), and it is also
// what the game itself uses to decide "a dialogue is on screen". The villager's
// relationship facts are re-read before and after and reported, but they are not
// part of the postcondition: `grantConversationFriendship` (:2923-2939) returns
// early when the farmer already talked to that villager today, so the dialogue
// can legitimately be up with no relationship movement.
//
// One consequence the caller must know: a successful talk leaves the actor IN
// the dialogue — `drawDialogue` sets `player.CanMove = false` (Game1.cs:9548-9549)
// and mounts a DialogueBox, so the next body-owning action is refused with
// `player_not_actionable` until the dialogue is closed (`dismiss_modal`, or
// `answer_dialogue` when the NPC pushes a question). The receipt reports
// `player_can_move_after` and `menu_open_after` so that state is visible rather
// than inferred.
//
// LIFECYCLE. Registered in FarmhandActionCatalog as
// `FarmhandActionLifecycle.Experimental` (family `npc_social`, handler group
// MachinesAndAnimals, descriptor `{ x, y, expectedTargetId }`, postcondition
// `npc_talked`, native binding `NPC.checkAction`). Experimental keeps it off the
// default Agent surface until it has passed its own native-local live gate; the
// promotion to LiveVerified is a separate, explicit catalog edit owned by the
// parent.
//
// FAILURE MODES, each with its own terminal code: unknown/stale target or a
// villager who is not in this location (`talk_to_npc_target_not_found` — the
// published id is location-scoped, so a villager elsewhere has a different id by
// construction and is not distinguishable from an unknown one here), an NPC
// state that makes the native entry refuse before any dialogue logic
// (`talk_to_npc_target_unavailable`), an actor whose hands are not empty
// (`hands_not_empty`, the existing family code), out of reach
// (`target_out_of_range` / `target_out_of_reach`, the existing family codes),
// the native entry declining the interaction (`talk_to_npc_not_handled`), the
// native entry handling it through a branch that produced no dialogue
// (`talk_to_npc_no_dialogue`), the native call throwing
// (`talk_to_npc_native_exception`), and success (`talk_to_npc_talked`).
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// Talks to one published villager, resolving the person from their opaque id
    /// on the game thread and proving the talk from the world afterwards. See the
    /// file header for the seam ruling, the arguments and the failure modes.
    /// </summary>
    public LocalExecutionReceipt RequestLocalTalkToNpc(
        string requestId,
        int targetX,
        int targetY,
        string expectedTargetId,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // General, not Physical: this seam starts no tool swing and drives no tool
        // lifecycle — it is the same instantaneous native object/NPC interaction
        // `pet_animal` admits through this path.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        TalkNpcTargetResolution resolution = ResolveTalkNpcTarget(location, expectedTargetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        // The branch's own precondition: with an object in hand native takes the
        // gift path (NPC.cs:2760) instead of the talk branch, which is
        // interact_npc_with_item's intent and not this action's.
        if (Game1.player.ActiveObject is not null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "hands_not_empty",
                $"{resolution.Identity};hand_item={Game1.player.ActiveObject.QualifiedItemId}");

        int npcTileX = (int)resolution.Npc!.Tile.X;
        int npcTileY = (int)resolution.Npc.Tile.Y;
        if (!IsTileWithinChebyshevRadius(Game1.player, npcTileX, npcTileY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "talk_to_npc", location, npcTileX, npcTileY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteTalkToNpc(arrivalExecutionId, arrivalRequestId, expectedTargetId), nowMs, requestedDeadlineMs);
        return this.ExecuteTalkToNpc(executionId, requestId, expectedTargetId);
    }

    /// <summary>
    /// The one execution body, reached both in range and on arrival from the
    /// approach leg. It re-validates the target identity, the actor's hands and
    /// the geometry, because the walk can take several ticks and the villager
    /// walks too.
    /// </summary>
    private LocalExecutionReceipt ExecuteTalkToNpc(string executionId, string requestId, string targetId)
    {
        GameLocation location = Game1.player.currentLocation;
        TalkNpcTargetResolution resolution = ResolveTalkNpcTarget(location, targetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);
        if (Game1.player.ActiveObject is not null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "hands_not_empty",
                $"{resolution.Identity};hand_item={Game1.player.ActiveObject.QualifiedItemId}");

        StardewValley.NPC npc = resolution.Npc!;
        int npcTileX = (int)npc.Tile.X;
        int npcTileY = (int)npc.Tile.Y;
        if (!IsTileWithinChebyshevRadius(Game1.player, npcTileX, npcTileY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range",
                $"{resolution.Identity};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y}");

        Friendship? friendship = Game1.player.friendshipData.TryGetValue(npc.Name, out Friendship? record) ? record : null;
        bool talkedToTodayBefore = friendship?.TalkedToToday ?? false;
        int pointsBefore = friendship?.Points ?? 0;
        bool dialogueUpBefore = Game1.dialogueUp;
        bool handled;
        try
        {
            // THE SEAM. The native entry itself, with the empty-handed
            // precondition established above selecting the talk branch. No
            // input edge, no synthesized click, no reproduced dialogue
            // construction.
            handled = npc.checkAction(Game1.player, location);
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "talk_to_npc_native_exception",
                $"{resolution.Identity};dialogue_up_before={dialogueUpBefore.ToString().ToLowerInvariant()};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        // Re-read the world AFTER the call. The dialogue is the talk branch's
        // observable outcome; the relationship facts are corroboration only,
        // because grantConversationFriendship is a no-op once the farmer has
        // already talked to this villager today.
        bool dialogueUpAfter = Game1.dialogueUp;
        bool dialogueBoxUpAfter = Game1.activeClickableMenu is DialogueBox;
        string menuAfter = Game1.activeClickableMenu?.GetType().Name ?? "none";
        bool talkedToTodayAfter = Game1.player.friendshipData.TryGetValue(npc.Name, out Friendship? after) && after.TalkedToToday;
        int pointsAfter = friendship is not null && Game1.player.friendshipData.TryGetValue(npc.Name, out Friendship? afterRecord) ? afterRecord.Points : pointsBefore;
        string evidence =
            $"{resolution.Identity};native_handled={handled.ToString().ToLowerInvariant()};"
            + $"dialogue_up_before={dialogueUpBefore.ToString().ToLowerInvariant()};dialogue_up_after={dialogueUpAfter.ToString().ToLowerInvariant()};"
            + $"dialogue_box_after={dialogueBoxUpAfter.ToString().ToLowerInvariant()};menu_open_after={menuAfter};"
            + $"talked_to_today_before={talkedToTodayBefore.ToString().ToLowerInvariant()};talked_to_today_after={talkedToTodayAfter.ToString().ToLowerInvariant()};"
            + $"points_before={pointsBefore};points_after={pointsAfter};player_can_move_after={Game1.player.CanMove.ToString().ToLowerInvariant()}";

        if (dialogueUpAfter && dialogueBoxUpAfter)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "talk_to_npc_talked", evidence);
        if (!handled)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "talk_to_npc_not_handled", evidence);
        // checkAction returned true through one of the entry's other exits
        // (spouse kiss, Dwarf/Krobus shop, Leo memory, pants easter egg). The
        // native call ran and no dialogue came up: say exactly that.
        return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "talk_to_npc_no_dialogue", evidence);
    }

    /// <summary>
    /// One resolved talk subject, or the named reason the published target can no
    /// longer be talked to. <see cref="Identity"/> is the evidence prefix shared
    /// by every receipt this body mints.
    /// </summary>
    private sealed record TalkNpcTargetResolution(
        bool Accepted,
        string ReasonCode,
        string Evidence,
        string Identity,
        StardewValley.NPC? Npc)
    {
        internal static TalkNpcTargetResolution Reject(string reasonCode, string evidence) =>
            new(false, reasonCode, evidence, string.Empty, null);
    }

    /// <summary>
    /// Re-derives the person the opaque id names, on the game thread, from the
    /// actor's CURRENT location. The id is the family identity
    /// (`BuildNpcRelationshipTargetId`), so this is the same subject
    /// npc_relationship/interact_npc_with_item resolve — and deliberately without
    /// their friendship-record requirement: the native talk branch can draw from
    /// an already-queued dialogue without one, and refusing here would refuse
    /// worlds the native entry serves.
    /// </summary>
    private static TalkNpcTargetResolution ResolveTalkNpcTarget(GameLocation location, string expectedTargetId)
    {
        StardewValley.NPC? npc = location.characters
            .OfType<StardewValley.NPC>()
            .FirstOrDefault(candidate => candidate.IsVillager
                && !string.IsNullOrWhiteSpace(candidate.Name)
                && string.Equals(BuildNpcRelationshipTargetId(location, candidate.Name), expectedTargetId, StringComparison.Ordinal));
        if (npc is null)
            return TalkNpcTargetResolution.Reject(
                "talk_to_npc_target_not_found",
                $"target={expectedTargetId};location={location.NameOrUniqueName};villagers_present="
                + location.characters.OfType<StardewValley.NPC>().Count(candidate => candidate.IsVillager && !string.IsNullOrWhiteSpace(candidate.Name)).ToString(CultureInfo.InvariantCulture));

        string identity = $"location={location.NameOrUniqueName};target={expectedTargetId};npc={npc.Name};tile={(int)npc.Tile.X},{(int)npc.Tile.Y}";

        // checkAction's own early refusals (:2466-2478), before any dialogue
        // logic: an invisible or sleeping villager can never reach the talk
        // branch, so the actor is not sent walking first.
        if (npc.IsInvisible || npc.isSleeping.Value)
            return TalkNpcTargetResolution.Reject(
                "talk_to_npc_target_unavailable",
                $"{identity};invisible={npc.IsInvisible.ToString().ToLowerInvariant()};sleeping={npc.isSleeping.Value.ToString().ToLowerInvariant()}");

        return new TalkNpcTargetResolution(true, "accepted", string.Empty, identity, npc);
    }
}
