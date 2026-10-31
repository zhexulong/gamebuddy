import type { Messages } from "../i18n";
import type { BrowserTurnV1 } from "../reference-pipeline-api";

/**
 * The failed turn's own sentence.
 *
 * A `failed` turn is not one outcome: the Host publishes which one it was as a
 * closed `problemCode` on the turn (`BrowserTurnV1Schema.problemCode`,
 * `tavern_browser_api/v1`), and its four members mean four different things to
 * the player - the connection dropped mid-reply, the model answered but nothing
 * was shown, the endpoint refused the request, or the reply could not be written.
 * The surface collapsed all of them into one "try again", which told the player
 * nothing about what had actually happened.
 *
 * The refusal is `runtime_unavailable`, and that one member is why the surface
 * needed a category rather than a better sentence: a wrong key, a revoked key, a
 * model the endpoint does not serve and a network that cannot reach it all arrive
 * as that same member, because it is what the Host settles a provider rejection
 * with (`p4-provider-start-execution.ts`: a rejected `session.prompt()`). No
 * declared code says "the endpoint refused us" more narrowly, and a turn-level
 * "the runtime is down" does not exist - a runtime that never started ends as
 * `not_started`, not as a failed turn - so this member's sentence names the
 * credential, the model and the endpoint, and sends the player to Settings.
 *
 * Three rules shape the mapping:
 *  - the raw member never reaches the player. `interrupted` and
 *    `no_visible_presentation` are contract vocabulary; this function is the one
 *    place a member becomes a sentence, and it returns a catalogue string;
 *  - **the map is exhaustive over the contract's union**, so a fifth member added
 *    to `BrowserTurnV1["problemCode"]` fails the typecheck here, in the file that
 *    owes the player words for it, rather than silently inheriting the generic
 *    line (`TURN_PROBLEM_CODES`, the runtime mirror the wire validator uses, is
 *    pinned separately by `problem-code-gate.test.mjs`);
 *  - a member this build does not know falls back to the catalogue's generic
 *    failure line rather than rendering as itself, so a Host that adds a fifth
 *    code is a worse message, not an enum in front of the player.
 *
 * The `??` is not dead code for a typed caller that has the branch above it: it is
 * the untyped boundary (the value arrives off the wire), and the wire validator
 * refuses an unrecognized code before the state reaches here, so the fallback is
 * a build-time guard plus a last-resort string, never the normal path.
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
    | "chatFailedProviderCredentialRejected"
    | "chatFailedProviderModelNotServed"
    | "chatFailedProviderRateLimited"
    | "chatFailedProviderContextOverflow"
    | "chatFailedProviderEndpointUnreachable"
  >,
  /**
   * The classified cause the Host published beside `problemCode`, when it read one. It is a
   * SECOND argument rather than a replacement for the code: a turn whose cause was not classified
   * still has a `problemCode` that needs words, and the two facts are independent.
   */
  providerFailure?: BrowserTurnV1["providerFailure"],
): string {
  const byCode: Readonly<Record<NonNullable<BrowserTurnV1["problemCode"]>, string>> = {
    interrupted: labels.chatFailedInterrupted,
    no_visible_presentation: labels.chatFailedNoVisiblePresentation,
    runtime_unavailable: labels.chatFailedRuntimeUnavailable,
    storage_unavailable: labels.chatFailedStorageUnavailable,
  };
  /**
   * One sentence per class, and the exhaustive map is the reason this function exists: a sixth
   * class fails the typecheck here, in the file that owes the player words for it, rather than
   * silently inheriting the five-cause paragraph above.
   */
  const byProviderFailure: Readonly<Record<NonNullable<BrowserTurnV1["providerFailure"]>, string>> = {
    credential_rejected: labels.chatFailedProviderCredentialRejected,
    model_not_served: labels.chatFailedProviderModelNotServed,
    rate_limited: labels.chatFailedProviderRateLimited,
    context_overflow: labels.chatFailedProviderContextOverflow,
    endpoint_unreachable: labels.chatFailedProviderEndpointUnreachable,
  };
  // The cause is the more specific fact, so it wins - but only for the code it describes. A
  // provider refusal can only ever be a `runtime_unavailable`; a turn that was interrupted or
  // failed to save has a cause of its own and must keep its own sentence even if a stale
  // `providerFailure` somehow arrived beside it.
  if (problemCode === "runtime_unavailable" && providerFailure !== undefined)
    return byProviderFailure[providerFailure] ?? labels.chatFailedRuntimeUnavailable;
  if (problemCode === undefined) return labels.chatFailed;
  return byCode[problemCode] ?? labels.chatFailed;
}
