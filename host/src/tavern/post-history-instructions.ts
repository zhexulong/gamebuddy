import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { TavernArtifactStore } from "./artifact-store.js";
import { type PostHistoryInstructions, type TavernArtifact, validateTavernArtifact } from "./types.js";

/**
 * The imported card's own closing direction (`post_history_instructions`) as the
 * companion's own record.
 *
 * It is the same kind of fact as her scenario, her openings and her card's
 * `extensions` object - what the card author wrote - so it gets the same kind of
 * home: a durable artifact under her own root, written when she is provisioned.
 * It is NOT folded into `IdentityProfile`: the identity record is the cached
 * prefix, and this text belongs after the transcript, not inside the head.
 */
export async function writeCompanionPostHistoryInstructions(
  store: TavernArtifactStore,
  companionRoot: string,
  text: string,
): Promise<void> {
  const artifact: PostHistoryInstructions = Object.freeze({
    schemaVersion: 1,
    revision: 1,
    postHistoryInstructionsId: postHistoryInstructionsId(companionRoot),
    text,
  });
  await store.write(postHistoryInstructionsPath(companionRoot), artifact, validateTavernArtifact);
}

/**
 * The companion's own closing direction, or `null` when her card wrote none.
 *
 * Absence is an ordinary state - most cards declare no
 * `post_history_instructions` - and it is deliberately distinct from an empty
 * string, so a later reader can tell "the card said nothing" from "the card said
 * nothing useful". A record that exists but names another companion fails closed
 * instead of being read as hers.
 */
export async function readCompanionPostHistoryInstructions(
  store: TavernArtifactStore,
  companionRoot: string,
): Promise<string | null> {
  const read = await store.readIfPresent(postHistoryInstructionsPath(companionRoot), validateTavernArtifact);
  if (read === undefined) return null;
  if (
    !isPostHistoryInstructions(read.artifact) ||
    read.artifact.postHistoryInstructionsId !== postHistoryInstructionsId(companionRoot)
  )
    throw new Error("invalid_post_history_instructions_artifact");
  return read.artifact.text;
}

function postHistoryInstructionsPath(companionRoot: string): string {
  return join(resolve(companionRoot), "post-history-instructions.json");
}
/** The one derivation of the companion's own record id, from her own root. */
function postHistoryInstructionsId(companionRoot: string): string {
  return `post-history-instructions-${createHash("sha256").update(resolve(companionRoot), "utf8").digest("hex").slice(0, 32)}`;
}
function isPostHistoryInstructions(artifact: TavernArtifact): artifact is PostHistoryInstructions {
  return "postHistoryInstructionsId" in artifact;
}
