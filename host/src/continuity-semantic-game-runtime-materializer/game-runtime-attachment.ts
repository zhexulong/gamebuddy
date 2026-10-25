import type { GameCompanionRuntimeAttachment, GameHostBindingFactory } from "../runtime-core.internal.js";
import { requireSelectedModelConfig, resolveSurfaceModelSelection } from "../settings/model-selection.js";

/** The durable recovery fields this construction zone already owns. */
export type GameRuntimeRecoveryAttachment = Pick<
  GameCompanionRuntimeAttachment,
  "recoveryJournal" | "recoveryBinding" | "recoveryPort"
>;

/**
 * The Game surface's own name for the state it cannot run in, and the reason `surface: "game"` is
 * what it asks with: the provider and model are the player's active connection, and this surface's
 * profile supplies only the thinking level - how much the companion reasons before she acts in the
 * world, not a fact about the endpoint.
 *
 * "No connection" and "the connection store could not be read" are one refusal here because this
 * surface cannot start without a model either way, and the player's next step is the same - Settings,
 * where the connection they own lives.
 */
const GAME_MODEL_CONFIGURATION_UNAVAILABLE = "game_runtime_model_configuration_unavailable";

/**
 * Builds the one attachment every Game runtime is constructed with.
 *
 * The model configuration is the player's own active connection, exactly as the
 * Chat surface resolves it, plus this surface's own thinking level. One
 * configured connection therefore serves both surfaces, which is what a player
 * means by "I configured it, so it must work in the game too".
 *
 * The resolved configuration is a precondition of the surface, not an option the
 * caller may skip: the attachment always carries `modelConfig`, and the
 * operational gate nonce decides only whether the gameplay worker is armed. A
 * Game session constructed without a model configuration is not a degraded
 * session but a dead one - the embedded runtime substitutes its `unknown`
 * placeholder model, records no provider entry, and leaves the surface unable to
 * reach any provider - so a root with no active connection fails closed here,
 * before a runtime exists, with the same named discipline the gameplay worker
 * uses. No default model is invented: this product ships no endpoint.
 */
export async function createGameRuntimeAttachment(
  input: Readonly<{
    runtimeRoot: string;
    /**
     * The identity-scoped runtime directory the player's connections live in.
     * `runtime-core` derives the identical directory from the same identity and
     * root, which is why the connection record read here is the one the runtime
     * then resolves its provider entry and credential from.
     */
    agentDir: string;
    gameplayWorkerEnabled: boolean;
    hostBindingFactory: GameHostBindingFactory;
    recoveryAttachment?: GameRuntimeRecoveryAttachment;
  }>,
): Promise<GameCompanionRuntimeAttachment> {
  // The refusal below names no directory, so a missing connection, an invalid document and a lookup in the
  // wrong place all read alike. Print the directory and the outcome, once, when the surface is about to refuse.
  const gameSelection = await resolveSurfaceModelSelection({
    runtimeRoot: input.runtimeRoot,
    agentDir: input.agentDir,
    surface: "game",
  });
  if (gameSelection.status !== "selected")
    process.stderr.write(`[game-model] status=${gameSelection.status} agentDir=${input.agentDir}\n`);
  const modelConfig = requireSelectedModelConfig(gameSelection, GAME_MODEL_CONFIGURATION_UNAVAILABLE);
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
          ...(recoveryAttachment.recoveryPort === undefined ? {} : { recoveryPort: recoveryAttachment.recoveryPort }),
        });
  return Object.freeze({
    modelConfig,
    gameplaySubagentEnabled: input.gameplayWorkerEnabled,
    hostBindingFactory: input.hostBindingFactory,
    ...recoveryFields,
  });
}
