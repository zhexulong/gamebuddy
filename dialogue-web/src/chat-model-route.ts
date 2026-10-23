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
 * one. With no connection the profile itself is the answer, and it runs on the operator gateway
 * this machine provides (`cpa-oai`). So a root with no saved connection still answers, and "no
 * active connection" is not "no model": a surface that treats the two as the same fact accuses a
 * conversation that works.
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
   * No saved connection, and the Host publishes the Chat profile a send falls back on: a turn goes
   * through the operator gateway named by that profile.
   */
  | Readonly<{ kind: "builtin" }>
  /**
   * The Host could not serve the Chat model profile its own send path resolves from: the store is
   * unreadable, or the store that answers for it is unavailable. A chat runtime cannot be
   * constructed from that, so a reply has no model.
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
 * not reach a model.
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
 * The store is classified first, because the Host reads it first: a profile store the Host cannot
 * serve is a chat runtime it cannot construct, whatever connection is selected.
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
  return profile === "answered" ? Object.freeze({ kind: "builtin" }) : Object.freeze({ kind: "unknown" });
}
