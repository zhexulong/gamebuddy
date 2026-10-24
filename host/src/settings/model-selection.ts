import { join } from "node:path";

import type { CompanionModelConfig } from "../runtime-identity.js";
import { TavernConnectionStore } from "../tavern/connection-store.js";
import { ModelProfileStore, type ModelProfile, type ModelProfileSurface } from "./model-profile-store.js";

/**
 * The one place that decides which provider and model a surface's turn runs with, and at which
 * thinking level.
 *
 * This product ships no model endpoint: the player's active connection IS the selection, and a root
 * whose player has activated nothing has no model. The per-surface profile names no provider and no
 * model - it owns the thinking level plus the revision it was read at - so there is exactly one
 * source for the pair and one for the level.
 *
 * The surface identity is the profile's own `surface` field, not a second parameter: one fact, one
 * spelling. It decides the only legitimate difference between the surfaces here: the Chat runs at
 * the level the player chose on the connection, while the Game runs at the level its own profile
 * holds, because that level is how much the companion reasons before she acts in the world rather
 * than a property of the endpoint. Every caller that used to decide this for itself asks this
 * function instead, so activating a connection reaches all three surfaces and none of them can
 * re-derive a precedence the others do not share.
 */

/**
 * What the active-connection read found, with "the read failed" as its own answer.
 *
 * An unreadable store is not the same fact as "no connection is activated": the first is a defect
 * the surface states, the second is the ordinary first-run state a player fixes in Settings. Both
 * used to arrive as `null`, which is how one surface could treat a broken store as "nothing
 * configured" while another refused it.
 */
type ActiveConnectionRead =
  | Readonly<{ status: "active"; providerId: string; modelId: string; thinkingLevel: string }>
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "unreadable" }>;

/**
 * The explicit answer about a surface's model. `no_model` is a member rather than a `null` return
 * or a throw because it is a state the product ships in: a fresh install has no model, and the
 * surface it belongs to is what says so where the player reads it.
 */
export type ModelSelectionOutcome =
  | Readonly<{ status: "selected"; modelConfig: CompanionModelConfig; modelProfileRevision: number }>
  | Readonly<{ status: "no_model"; modelProfileRevision: number }>
  | Readonly<{ status: "unreadable"; modelProfileRevision: number }>;

export type SurfaceModelSelectionInput = Readonly<{
  /** The root the surface profiles live under (`settings/model-profiles.json`). */
  runtimeRoot: string;
  /**
   * The identity-scoped runtime directory the player's connections live in; `runtime-core` derives
   * the same directory, which is why the record read here is the one the runtime then resolves its
   * provider entry and credential from.
   */
  agentDir: string;
  surface: ModelProfileSurface;
}>;

/**
 * Reads the surface's own profile and the player's active connection and answers the rule above.
 *
 * A profile store that cannot be read still throws its own named refusal: the level and the
 * revision are this surface's durable settings, and the surfaces have always reported that failure
 * as the store's, not as an absent model. The connection read is classified instead, because a
 * store that cannot be read is exactly the case the surfaces disagree about.
 */
export async function resolveSurfaceModelSelection(input: SurfaceModelSelectionInput): Promise<ModelSelectionOutcome> {
  const profile = await new ModelProfileStore(join(input.runtimeRoot, "settings", "model-profiles.json")).read(
    input.surface,
  );
  return selectModel(await readActiveConnection(input.agentDir), profile);
}

function selectModel(activeConnection: ActiveConnectionRead, profile: ModelProfile): ModelSelectionOutcome {
  const modelProfileRevision = profile.revision;
  if (activeConnection.status === "unreadable") return Object.freeze({ status: "unreadable", modelProfileRevision });
  if (activeConnection.status === "none") return Object.freeze({ status: "no_model", modelProfileRevision });
  return Object.freeze({
    status: "selected",
    modelConfig: Object.freeze({
      provider: activeConnection.providerId,
      modelId: activeConnection.modelId,
      thinkingLevel: thinkingLevelFor(profile.surface, activeConnection.thinkingLevel, profile.thinkingLevel),
    }),
    modelProfileRevision,
  });
}

/**
 * The one honest difference between the surfaces, and the reason `surface` is an input at all.
 *
 * Chat reasons as much as the connection was tuned to reason; the Game keeps the level its own
 * profile holds, because that level is how much the companion reasons before she acts in the
 * world, not a property of the endpoint the player picked for talking to her.
 */
function thinkingLevelFor(surface: ModelProfileSurface, connectionLevel: string, profileLevel: string): string {
  return surface === "chat" ? connectionLevel : profileLevel;
}

/**
 * The refusal a surface that cannot run without a model states, named by that surface.
 *
 * Two surfaces refuse every outcome but `selected`, and they differ only in the code the player
 * reads: the Game attachment and the bounded Preview each have their own. That name is the
 * parameter, so neither has to re-derive which outcomes are acceptable.
 */
export function requireSelectedModelConfig(
  outcome: ModelSelectionOutcome,
  unavailableCode: string,
): CompanionModelConfig {
  if (outcome.status !== "selected") throw new Error(unavailableCode);
  return outcome.modelConfig;
}

async function readActiveConnection(agentDir: string): Promise<ActiveConnectionRead> {
  try {
    const active = await new TavernConnectionStore(agentDir).active();
    if (active === null) return Object.freeze({ status: "none" });
    return Object.freeze({
      status: "active",
      providerId: active.providerId,
      modelId: active.modelId,
      thinkingLevel: active.thinkingLevel,
    });
  } catch {
    return Object.freeze({ status: "unreadable" });
  }
}
