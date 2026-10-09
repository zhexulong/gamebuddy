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
 * honestly rather than pointing at a tool that will refuse.
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
          action: "stardew_answer_dialogue",
          guidance:
            `The farmhand cannot act because a ${modalType} is waiting for an answer. Call ` +
            `'stardew_answer_dialogue' with the responseKey you want, then re-issue the same request.`,
        };
      if (isQuestion === "false")
        return {
          action: "stardew_dismiss_modal",
          guidance:
            `The farmhand cannot act because a ${modalType} is on screen. Call 'stardew_dismiss_modal' to ` +
            `close it, then re-issue the same request with the same target.`,
        };
      // No answer state was readable, which is the case for an operation menu rather than a dialogue. Say
      // what will actually happen instead of promising a close that the whitelist may refuse.
      return {
        action: "stardew_dismiss_modal",
        guidance:
          `The farmhand cannot act because a ${modalType} is on screen. Try 'stardew_dismiss_modal'; it ` +
          `refuses menus it is not allowed to close, and if it refuses, report the blockage instead of ` +
          `retrying the original request.`,
      };
    }
    case "transient_busy": {
      const kind = evidenceField(detail, "transient_kind") ?? "a short animation";
      const windowMs = evidenceField(detail, "retry_window_ms") ?? "2000";
      return {
        action: null,
        guidance:
          `The farmhand is briefly busy with ${kind}; this clears on its own and no tool can shorten it. ` +
          `Re-issue the SAME request after about ${windowMs} ms rather than changing the target.`,
      };
    }
    case "cutscene_active":
      return {
        action: null,
        guidance:
          "A cutscene currently holds the farmhand, so no action can run. Do not issue actions until the " +
          "scene ends; if the player is watching, this is a good moment to narrate rather than to act.",
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
        guidance:
          "The farmhand is already walking to a target an earlier request chose. Wait for the walk to settle, " +
          "then re-issue the same request; a new movement directive for a different tile also takes over from " +
          "the walk in progress, so issue one only if you mean to change the target.",
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
        guidance:
          "The farmhand's body is held by an in-flight movement that a newer command supersedes. Re-issue " +
          "the same request now; the new directive takes over from the walk in progress.",
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
export function describeBodyHoldRefusal(
  reasonCode: string | null,
  evidence: unknown,
): StardewActionRemedy | null {
  return remedyForBodyHold(reasonCode, evidenceDetailOf(evidence));
}
