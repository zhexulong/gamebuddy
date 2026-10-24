import {
  TavernProblemError,
  type TavernConnectionStateV1,
  type TavernModelProfilesV1,
} from "./management-pipeline-api";

/**
 * What a message the player sends from the Chat would actually reach a model through.
 *
 * The Host answers this question in exactly one place - `resolveExactChatRuntimeModelSelection`
 * in `continuity-semantic-chat-runtime-construction` - and its inputs are the two settings
 * projections read here: the Chat model profile (`settings/model-profiles.json`), which the Host
 * reads first, and the player's active connection, which selects the turn's model when there is
 * one. The profile names no model and no provider - it owns only the thinking level - so the
 * connection is the whole answer: with none activated this product has no channel to send through,
 * because it ships no endpoint. That makes "no active connection" and "no model" one fact again,
 * and it is the `none` route.
 *
 * This module is the one place in this client that turns those two reads into that answer, and it
 * keeps the Host's own order. The Chat surface words itself from the returned `kind` alone. If a
 * sentence here ever disagrees with a send again, this function is what is wrong, not either
 * reader of it.
 */
export type ChatModelRoute =
  /** A saved connection is active; the next turn is sent through it. */
  | Readonly<{ kind: "connection" }>
  /**
   * The player has activated no connection, so a reply has no model to reach. The product supplies
   * no endpoint of its own, so this is not a fallback that quietly works: nothing is configured,
   * and the conversation says so where the player reads it. Reading the transcript is unaffected.
   */
  | Readonly<{ kind: "none" }>
  /**
   * Nothing is known: a read did not answer, or it answered with something this client cannot
   * classify. The surface says nothing rather than claiming no model.
   */
  | Readonly<{ kind: "unknown" }>;

/**
 * The two refusals that ARE the profile store failing, read off the Host's own mapping of it
 * (`invalid_model_profile_store`/`model_profile_readback_mismatch` -> `storage_unavailable`, a
 * mount with no profile store -> `runtime_unavailable`). Every other refusal on that route is
 * about the request, the session or this client, and none of them is evidence that a reply could
 * not reach a model. A store the Host cannot serve still means the send path has no model, and
 * that is why it reads as `none` rather than as an accusation about the player's configuration.
 */
const PROFILE_STORE_REFUSAL_CODES: readonly string[] = Object.freeze(["storage_unavailable", "runtime_unavailable"]);

/** The two settings reads this answer is derived from, exactly as the management client serves them. */
export type ChatSettingsReaders = Readonly<{
  readConnection(): Promise<TavernConnectionStateV1>;
  readModelProfiles(): Promise<TavernModelProfilesV1>;
}>;

/** What the profile read itself said, before the Host's precedence is applied to it. */
type ChatProfileRead = "answered" | "store_unavailable" | "unknown";

/**
 * Reads both projections and answers which route a send would take.
 *
 * Two causes yield `none` and the player cannot tell them apart by their next step: no connection
 * is activated (the fresh-install case, where the product has no endpoint to fall back on), or the
 * profile store the Host reads first cannot be served. Both mean a reply has no model, and both are
 * fixed in the same section of Settings, so the surface says one sentence for both.
 */
export async function readChatModelRoute(readers: ChatSettingsReaders): Promise<ChatModelRoute> {
  const [connection, profile] = await Promise.all([
    readers.readConnection().catch(() => null),
    readers.readModelProfiles().then(
      (): ChatProfileRead => "answered",
      (error: unknown): ChatProfileRead =>
        error instanceof TavernProblemError && PROFILE_STORE_REFUSAL_CODES.includes(error.code)
          ? "store_unavailable"
          : "unknown",
    ),
  ]);
  if (profile === "store_unavailable") return Object.freeze({ kind: "none" });
  if (connection === null) return Object.freeze({ kind: "unknown" });
  if (connection.active !== null) return Object.freeze({ kind: "connection" });
  return profile === "answered" ? Object.freeze({ kind: "none" }) : Object.freeze({ kind: "unknown" });
}
