import type { Messages } from "../i18n";
import type { BrowserTurnV1 } from "../reference-pipeline-api";

/**
 * The failed turn's own sentence.
 *
 * A `failed` turn is not one outcome: the Host publishes which one it was as a
 * closed `problemCode` on the turn (`BrowserTurnV1Schema.problemCode`,
 * `tavern_browser_api/v1`), and its four members mean four different things to
 * the player - the connection dropped mid-reply, the model answered but nothing
 * was shown, the runtime was not up, or the reply could not be written. The
 * surface collapsed all of them into one "try again", which told the player
 * nothing about what had actually happened.
 *
 * Two rules shape the mapping:
 *  - the raw member never reaches the player. `interrupted` and
 *    `no_visible_presentation` are contract vocabulary; this function is the one
 *    place a member becomes a sentence, and it returns a catalogue string;
 *  - a member this build does not know falls back to the catalogue's generic
 *    failure line rather than rendering as itself, so a Host that adds a fifth
 *    code is a worse message, not an enum in front of the player.
 *
 * The map is typed `Record<NonNullable<BrowserTurnV1["problemCode"]>, string>`,
 * so a fifth member added to the contract's turn union fails the build here
 * until somebody writes the player's words for it. `problemCode` is optional on
 * the wire (the contract makes it optional), and a failed turn without one takes
 * the same fallback.
 */
export function turnFailureText(
  problemCode: BrowserTurnV1["problemCode"],
  labels: Pick<
    Messages,
    | "chatFailed"
    | "chatFailedInterrupted"
    | "chatFailedNoVisiblePresentation"
    | "chatFailedRuntimeUnavailable"
    | "chatFailedStorageUnavailable"
  >,
): string {
  const byCode: Readonly<Record<string, string>> = {
    interrupted: labels.chatFailedInterrupted,
    no_visible_presentation: labels.chatFailedNoVisiblePresentation,
    runtime_unavailable: labels.chatFailedRuntimeUnavailable,
    storage_unavailable: labels.chatFailedStorageUnavailable,
  };
  if (problemCode === undefined) return labels.chatFailed;
  return byCode[problemCode] ?? labels.chatFailed;
}
