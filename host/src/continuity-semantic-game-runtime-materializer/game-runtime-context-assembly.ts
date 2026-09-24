import { join } from "node:path";
import { readIdentityProfile, type IdentityProfile } from "../identity-profile.js";
import { resolveRuntimePaths } from "../runtime-identity.js";
import type { GameCompanionIdentity } from "../runtime-core.internal.js";
import { readWorldBook, worldBookMetadata, type WorldBookBinding } from "../worldbook.js";

/**
 * Host-owned Game-surface context assembly.
 *
 * The Game surface must present the same companion the Chat surface does:
 * `BaseIdentityProfile` (name, role, reviewed persona, bounded dialogue
 * examples) and the reviewed always-on world book. Both are canonical Host
 * files under the runtime root, so this module reads them instead of asking any
 * caller — including a live-run script — to supply content.
 *
 * Contract:
 *   - an explicitly supplied value always wins (the composition may have
 *     already resolved it);
 *   - otherwise the canonical file under `resolveRuntimePaths(identity,
 *     runtimeRoot)` is read: the same identity key the Chat surface uses, so one
 *     imported character card serves both surfaces;
 *   - a missing or invalid file yields `undefined` (the runtime core then owns
 *     creating the default profile and an empty world book);
 *   - nothing here writes, and no scenario is ever read: tavern fiction must not
 *     leak into the game world.
 */
export type GameRuntimeContextSource = Readonly<{
  profile?: IdentityProfile;
  worldBook?: WorldBookBinding;
}>;

export async function assembleGameRuntimeContext(input: Readonly<{
  identity: GameCompanionIdentity;
  runtimeRoot: string;
  /** Explicitly resolved profile supplied by the composition, if any. */
  identityProfile?: IdentityProfile;
  /** Explicitly resolved world book supplied by the composition, if any. */
  worldBook?: WorldBookBinding;
}>): Promise<GameRuntimeContextSource> {
  const runtimePaths = resolveRuntimePaths(input.identity, input.runtimeRoot);
  const profile = input.identityProfile ?? (await readCanonicalProfile(runtimePaths.identityProfilePath));
  const worldBook = input.worldBook ?? (await readCanonicalWorldBook(runtimePaths.runtimeCwd));
  return Object.freeze({
    ...(profile === undefined ? {} : { profile }),
    ...(worldBook === undefined ? {} : { worldBook }),
  });
}

async function readCanonicalProfile(path: string): Promise<IdentityProfile | undefined> {
  try {
    return await readIdentityProfile(path);
  } catch {
    // Absent or invalid: the runtime core owns the default profile.
    return undefined;
  }
}

async function readCanonicalWorldBook(runtimeCwd: string): Promise<WorldBookBinding | undefined> {
  try {
    const book = await readWorldBook(join(runtimeCwd, "worldbook.json"));
    return Object.freeze({ metadata: worldBookMetadata(book), book });
  } catch {
    // Absent or invalid: an empty world book is the honest default.
    return undefined;
  }
}
