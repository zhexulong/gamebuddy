import { join } from "node:path";
import { readIdentityProfile, type IdentityProfile } from "../identity-profile.js";
import { resolveRuntimePaths, type RuntimePaths } from "../runtime-identity.js";
import type { GameCompanionIdentity } from "../runtime-core.internal.js";
import { TavernArtifactStore } from "../tavern/artifact-store.js";
import type { GameSurfaceScenarioSource } from "../tavern/catalog-service.js";
import { resolveCompanionOwnScenario } from "../tavern/library-service.js";
import { resolveTavernPaths } from "../tavern/tavern-paths.js";
import { readWorldBook, worldBookMetadata, type WorldBookBinding } from "../worldbook.js";

/**
 * Host-owned Game-surface context assembly.
 *
 * The Game surface must present the same companion the Chat surface does:
 * `BaseIdentityProfile` (name, role, reviewed persona, bounded dialogue
 * examples), the reviewed always-on world book, and the companion's own
 * scenario. All are canonical Host records under the runtime root, so this
 * module reads them instead of asking any caller — including a live-run script
 * — to supply content.
 *
 * Contract:
 *   - an explicitly supplied value always wins (the composition may have
 *     already resolved it);
 *   - otherwise the canonical file under `resolveRuntimePaths(identity,
 *     runtimeRoot)` is read: the same identity key the Chat surface uses, so one
 *     imported character card serves both surfaces;
 *   - the scenario is the companion's own durable record, read through the same
 *     `resolveCompanionOwnScenario` a new Chat binds, so the pair's authored
 *     premise reaches the Game as the Tier 2 stable background Chat compiles;
 *   - a missing or invalid source yields `undefined` (the runtime core then owns
 *     creating the default profile and an empty world book, and the Game tier
 *     simply carries no scenario);
 *   - nothing here writes.
 */
export type GameRuntimeContextSource = Readonly<{
  profile?: IdentityProfile;
  worldBook?: WorldBookBinding;
  scenario?: GameSurfaceScenarioSource;
}>;

export async function assembleGameRuntimeContext(
  input: Readonly<{
    identity: GameCompanionIdentity;
    runtimeRoot: string;
    /** Explicitly resolved profile supplied by the composition, if any. */
    identityProfile?: IdentityProfile;
    /** Explicitly resolved world book supplied by the composition, if any. */
    worldBook?: WorldBookBinding;
  }>,
): Promise<GameRuntimeContextSource> {
  const runtimePaths = resolveRuntimePaths(input.identity, input.runtimeRoot);
  const profile = input.identityProfile ?? (await readCanonicalProfile(runtimePaths.identityProfilePath));
  const worldBook = input.worldBook ?? (await readCanonicalWorldBook(runtimePaths.runtimeCwd));
  const scenario = await readCompanionOwnScenario(runtimePaths, input.identity, input.runtimeRoot);
  return Object.freeze({
    ...(profile === undefined ? {} : { profile }),
    ...(worldBook === undefined ? {} : { worldBook }),
    ...(scenario === undefined ? {} : { scenario }),
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

/**
 * The companion's own scenario, exactly as `resolveCompanionOwnScenario`
 * resolves it for a new Chat: the reviewed card's scenario persisted under the
 * ONE derived id (`companionScenarioId`). Absent is ordinary; a present but
 * unreadable record yields nothing here rather than a broken source, so the Game
 * tier still boots with its canonical profile and world book (the Chat surface
 * owns refusing a corrupt one).
 */
async function readCompanionOwnScenario(
  runtimePaths: RuntimePaths,
  identity: GameCompanionIdentity,
  runtimeRoot: string,
): Promise<GameSurfaceScenarioSource | undefined> {
  try {
    const { companionRoot } = resolveTavernPaths(runtimePaths, identity);
    const resolved = await resolveCompanionOwnScenario(new TavernArtifactStore(runtimeRoot), companionRoot);
    if (resolved === undefined) return undefined;
    return Object.freeze({
      scenarioId: resolved.binding.sourceId,
      revision: resolved.binding.revision,
      canonicalHash: resolved.binding.canonicalHash,
      text: resolved.artifact.text,
    });
  } catch {
    return undefined;
  }
}
