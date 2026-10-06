import { join } from "node:path";

import type {
  GameCompanionRuntimeAttachment,
  GameHostBindingFactory,
} from "../runtime-core.internal.js";
import {
  ModelProfileStore,
  resolveModelProfileConfig,
} from "../settings/model-profile-store.js";

/** The durable recovery fields this construction zone already owns. */
export type GameRuntimeRecoveryAttachment = Pick<
  GameCompanionRuntimeAttachment,
  "recoveryJournal" | "recoveryBinding" | "recoveryPort"
>;

/**
 * Builds the one attachment every Game runtime is constructed with.
 *
 * The player's own Game profile model is a precondition of the surface, not an
 * option the caller may skip: the attachment always carries `modelConfig`, and
 * the operational gate nonce decides only whether the gameplay worker is armed.
 * A Game session constructed without a model configuration is not a degraded
 * session but a dead one — the embedded runtime substitutes its `unknown`
 * placeholder model, records no provider entry, and leaves the surface unable
 * to reach any provider — so a store that cannot yield a resolvable Game
 * profile fails closed here, before a runtime exists, with the same named
 * discipline the gameplay worker uses. No default model is invented and no
 * other surface's profile is substituted.
 */
export async function createGameRuntimeAttachment(
  input: Readonly<{
    runtimeRoot: string;
    gameplayWorkerEnabled: boolean;
    hostBindingFactory: GameHostBindingFactory;
    recoveryAttachment?: GameRuntimeRecoveryAttachment;
  }>,
): Promise<GameCompanionRuntimeAttachment> {
  const modelConfig = resolveModelProfileConfig(
    await new ModelProfileStore(
      join(input.runtimeRoot, "settings", "model-profiles.json"),
    ).read("game"),
  );
  if (modelConfig === null)
    throw new Error("game_runtime_model_configuration_unavailable");
  const recoveryAttachment = input.recoveryAttachment;
  const recoveryFields =
    recoveryAttachment === undefined
      ? {}
      : Object.freeze({
          ...(recoveryAttachment.recoveryJournal === undefined
            ? {}
            : { recoveryJournal: recoveryAttachment.recoveryJournal }),
          ...(recoveryAttachment.recoveryBinding === undefined
            ? {}
            : { recoveryBinding: recoveryAttachment.recoveryBinding }),
          ...(recoveryAttachment.recoveryPort === undefined
            ? {}
            : { recoveryPort: recoveryAttachment.recoveryPort }),
        });
  return Object.freeze({
    modelConfig,
    gameplaySubagentEnabled: input.gameplayWorkerEnabled,
    hostBindingFactory: input.hostBindingFactory,
    ...recoveryFields,
  });
}
