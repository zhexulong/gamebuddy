/**
 * The countermeasure an Agent is told about when a Stardew action is refused because the actor's body is
 * held.
 *
 * Why this exists: the Host used to answer a held body with `player_not_actionable` and nothing else. One
 * code covered a mounted menu, a cutscene, a faint, an eating animation and a tool swing - five states whose
 * countermeasures are completely different - so the Agent had no fact to act on and its only visible option
 * was to re-issue the same request until it gave up. The Mod now names the hold and carries the facts; this
 * module turns that into the one thing the Agent should do next, and it is a PURE function of the reason code
 * and the Mod's evidence, so the whole table is testable without a game.
 *
 * It never promises a remedy it cannot deliver: a modal the audited whitelist will not close reports that
 * honestly rather than pointing at a tool that will refuse, and every route it names is one the Game surface
 * actually hands over - a mounted tool, or a step the plan builder admits (`stardew-action-remedy.test.ts`
 * holds both directions). It named `stardew_dismiss_modal` and `stardew_answer_dialogue` until 2026-11-12;
 * both are flat per-action tools a plan surface drops, so the one sentence the Agent got after a hold pointed
 * at a tool that was not in the request at all - the same defect the Game conduct carried for body language.
 */

export type StardewActionRemedy = Readonly<{
  /** The tool to call next, or null when nothing can be called and the Agent must wait or stop. */
  action: string | null;
  /** One sentence the Agent can act on, including the tool name when there is one. */
  guidance: string;
}>;

/** The Mod's evidence travels as `{ detail: "key=value;..." }`. */
export function evidenceDetailOf(evidence: unknown): string | null {
  if (typeof evidence === "string") return evidence;
  if (evidence !== null && typeof evidence === "object" && "detail" in evidence) {
    const detail = (evidence as { detail?: unknown }).detail;
    return typeof detail === "string" ? detail : null;
  }
  return null;
}

/** One `key=value` pair out of the Mod's `;`-separated evidence detail. */
export function evidenceField(detail: string | null, key: string): string | null {
  if (detail === null) return null;
  for (const part of detail.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at) === key) return part.slice(at + 1);
  }
  return null;
}

/**
 * The countermeasure for a body hold, or null when this reason code is not a body hold.
 *
 * Returning null matters: a remedy attached to a code that is not a hold would tell the Agent to close a
 * dialogue that is not open.
 */
export function remedyForBodyHold(reasonCode: string | null, detail: string | null): StardewActionRemedy | null {
  switch (reasonCode) {
    case "actor_held_by_modal": {
      const modalType = evidenceField(detail, "modal_type") ?? "a menu";
      const isQuestion = evidenceField(detail, "is_question");
      if (isQuestion === "true")
        return {
          action: "stardew_plan_work",
          guidance:
            `The farmhand cannot act because a ${modalType} is waiting for an answer. Answering it is an ` +
            `action in the plan you submit with stardew_plan_work: submit 'answer_dialogue' with the responseKey ` +
            `you want, then re-issue the same request.`,
        };
      if (isQuestion === "false")
        return {
          action: "stardew_plan_work",
          guidance:
            `The farmhand cannot act because a ${modalType} is on screen. Closing it is an action in the ` +
            `plan you submit with stardew_plan_work: submit 'dismiss_modal', then re-issue the same request with ` +
            `the same target.`,
        };
      // No answer state was readable, which is the case for an operation menu rather than a dialogue. Say
      // what will actually happen instead of promising a close that the whitelist may refuse.
      return {
        action: "stardew_plan_work",
        guidance:
          `The farmhand cannot act because a ${modalType} is on screen. Dismissing it is an action in the ` +
          `plan you submit with stardew_plan_work: submit 'dismiss_modal'; it refuses menus it is not allowed to ` +
          `close, and if it refuses, report the blockage instead of retrying the original request.`,
      };
    }
    case "transient_busy": {
      const kind = evidenceField(detail, "transient_kind") ?? "a short animation";
      // The bound belongs to the Mod (`WorldModel.TransientRetryWindowMs`), which publishes it as
      // `retry_window_ms` in the refusal evidence. A default here would be a second owner of that number -
      // the duplicated-authority class - so when the evidence is silent the guidance stays honest and
      // names no figure at all.
      const windowMs = evidenceField(detail, "retry_window_ms");
      return {
        action: null,
        guidance:
          `The farmhand is briefly busy with ${kind}; this clears on its own and no tool can shorten it. ` +
          `Re-issue the SAME request ${windowMs === null ? "after a moment" : `after about ${windowMs} ms`} ` +
          `rather than changing the target.`,
      };
    }
    // The cutscene hold. The evidence decides whether there is anything to ACT ON, because a cutscene is not one
    // state: two modal-family handlers act on its own dialogue box (`dismiss_modal` closes it and the native close
    // advances the event; `answer_dialogue` answers a question raised inside it), and with no box on screen no action
    // at all can move the scene along. One sentence covered both, so a run that met a box it could have advanced read
    // "no action can run" and retried until it gave up - measured: four retries over twenty minutes, then
    // "Persistent cutscene ... I just wait."
    case "cutscene_active": {
      const dialogueBox = evidenceField(detail, "dialogue_box");
      const isQuestion = evidenceField(detail, "is_question");
      if (dialogueBox === "true" && isQuestion === "true")
        return {
          action: "stardew_plan_work",
          guidance:
            "A cutscene is holding the farmhand and its dialogue is waiting for an answer. Answering it is an " +
            `action in the plan you submit with stardew_plan_work: submit 'answer_dialogue' with the responseKey the ` +
            "box offers - and if you do not have the keys, submit 'dismiss_modal' once: it refuses a question box " +
            "and that refusal lists the keys and the question.",
        };
      if (dialogueBox === "true")
        return {
          action: "stardew_plan_work",
          guidance:
            "A cutscene is holding the farmhand and its dialogue box is on screen. Advancing it is an action in " +
            `the plan you submit with stardew_plan_work: submit 'dismiss_modal'; if the box is asking a question that ` +
            "step is refused with the offered response keys, which is what 'answer_dialogue' needs.",
        };
      return {
        action: null,
        guidance:
          "A cutscene currently holds the farmhand, so no action can run. Do not issue actions until the " +
          "scene ends; if the player is watching, this is a good moment to narrate rather than to act.",
      };
    }
    // The modal family was admitted into the cutscene and found nothing to act on: the event is running with no
    // dialogue box, so there is no box to dismiss or answer and nothing in the catalog advances an event's own
    // command program. Named separately from `cutscene_active` because the answer is different: this is a wait that
    // ends by itself, not a hold whose countermeasure the Agent has not found yet.
    case "event_has_no_dialogue_box":
      return {
        action: null,
        guidance:
          "A cutscene is holding the farmhand and it has no dialogue box on screen, so no tool can move it along. " +
          "Do not retry now: the scene advances on its own until its next dialogue, and the request can be re-issued " +
          "once the cutscene ends.",
      };
    case "actor_passed_out":
      return {
        action: null,
        guidance:
          "The farmhand is unconscious (exhausted or past the forced end of day), so nothing can be done " +
          "until the next in-game day begins. Do not retry the request.",
      };
    // A named `body_owned_by_*` code says WHICH in-flight execution holds the body. The Mod's frozen table
    // fixes whether that owner can be superseded: only an in-flight local movement yields to a newer command,
    // so only that one is told to re-issue now; every other owner has to settle on its own first.
    case "body_owned_by_navigation":
      return {
        action: null,
        // This owner is NOT supersedable, and the Mod says so (`interruptible=false`, pinned by a test). I checked
        // which side was wrong by reading the movement path: `RequestLocalMove`'s own occupancy guard
        // (farmhandexecutioncontroller.movementactions.cs:50) does not include `activeNavigate`, and the only place
        // a navigation ends is its own approach handoff (`HandleNavigationApproachTransition`, :3763). So there is
        // no takeover to offer - a new move either gets `body_release_unavailable` or proceeds while the
        // navigation is still nominally the owner. The TEXT was the wrong half, so the text is what changed.
        guidance:
          "The farmhand is already walking to a target an earlier request chose, and that walk cannot be taken " +
          "over. Wait for it to settle, then re-issue the same request.",
      };
    case "body_owned_by_travel":
      return {
        action: null,
        guidance:
          "The farmhand is changing location through a door, warp or mine entrance. Wait for the transition " +
          "to finish, then re-issue the same request; a map transition cannot be interrupted.",
      };
    case "body_owned_by_movement":
      return {
        action: null,
        // The guidance is keyed on the OWNER, but what the Agent should do depends on the owner AND what it
        // asked for: only a MOVEMENT directive displaces a walk in progress
        // (farmhandexecutioncontroller.movementactions.cs:52-53 cancels `active`), so a re-issued tool action
        // would simply be refused again. An earlier version promised "the new directive takes over" to any
        // requester, which is false for everything that is not a move. The text now names which case the Agent
        // is in rather than assuming one.
        guidance:
          "Wait for the walk to settle, or replace it: a new movement directive takes over from a walk in " +
          "progress, so if you meant to walk somewhere, re-issue the request now. Any other action has to wait " +
          "for the walk to end.",
      };
    case "body_owned_by_approach":
      return {
        action: null,
        guidance:
          "The farmhand is walking into reach of a target another request chose. Wait for the approach to " +
          "finish, then re-issue the same request.",
      };
    case "body_owned_by_ride":
      return {
        action: null,
        guidance:
          "The farmhand is riding a mount or bus. Wait for the ride to end, then re-issue the same request; " +
          "a ride cannot be interrupted mid-trip.",
      };
    case "body_owned_by_day_advance":
      return {
        action: null,
        guidance:
          "The farmhand is in the day-advance transition. Wait for the new day to begin, then re-issue the " +
          "same request; the transition cannot be interrupted.",
      };
    case "body_owned_by_activity":
      return {
        action: null,
        guidance:
          "The farmhand is occupied by another in-flight activity (petting, animal produce, item use, pickup " +
          "or pedestal taking). Wait for it to finish, then re-issue the same request.",
      };
    default:
      // A QUEUED REQUEST THAT OUTLIVED ITS WAIT. The Mod parks a request that collides with the actor's own in-flight
      // work and dispatches it the moment that work ends; when the owner outlasts the Mod's bounded window the wait
      // ends in this code, which names the owner the wait was for. Nothing was started, so this is recoverable by
      // re-issuing against the world as it is now - and the owner itself travels in the evidence.
      if (reasonCode !== null && reasonCode.startsWith("waiting_for_body:")) {
        const owner = evidenceField(detail, "owner_action") ?? reasonCode.slice("waiting_for_body:".length);
        return {
          action: null,
          guidance:
            `The farmhand was still busy with ${owner}, so the request waited and was not started. Re-issue the same ` +
            `request: if that work is still running it will wait again rather than being lost, so do not change the target.`,
        };
      }
      // The Mod keeps the `body_owned_` prefix on every named hold, so a named code this table does not list
      // yet still gets actionable guidance instead of degrading to an unknown error. The bare legacy
      // `body_owned` names no owner and carries no countermeasure, so it keeps returning null.
      if (reasonCode !== null && reasonCode.startsWith("body_owned_"))
        return {
          action: null,
          guidance:
            "The farmhand's body is held by another in-flight execution. Wait for it to settle, then re-issue " +
            "the same request instead of repeating it in a loop.",
        };
      return null;
  }
}

/**
 * Everything an Agent-visible refusal carries when the body is held: the Mod's named code, the Mod's
 * evidence, the countermeasure, and the exact sentence appended to the tool result.
 *
 * The tool layer and the live probe both call THIS, so what a probe asserts is literally what the Agent
 * reads - an assertion on a hand-written sentence would prove nothing about the tool result.
 */
export function describeBodyHoldRefusal(reasonCode: string | null, evidence: unknown): StardewActionRemedy | null {
  return remedyForBodyHold(reasonCode, evidenceDetailOf(evidence));
}
