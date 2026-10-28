import type { GameCompanionRuntimeAttachment, GameHostBindingFactory } from "../runtime-core.internal.js";
import type { CompanionModelConfig } from "../runtime-identity.js";
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
 * Reads the Game surface's model selection, mapped onto this surface's own answer.
 *
 * This is the one read, and it happens twice in a Game session's life: while the attachment is built
 * (where `undefined` means `no_model`, the fresh-install state this surface opens in and only refuses
 * at a provider turn) and again before every companion turn (where the same absence refuses, because
 * a turn that ran without a model would be answered on the endpoint the player just left).
 */
async function readGameModelConfig(
  input: Readonly<{ runtimeRoot: string; agentDir: string }>,
): Promise<CompanionModelConfig | undefined> {
  const selection = await resolveSurfaceModelSelection({
    runtimeRoot: input.runtimeRoot,
    agentDir: input.agentDir,
    surface: "game",
  });
  if (selection.status === "no_model") return undefined;
  return requireSelectedModelConfig(selection, GAME_MODEL_CONFIGURATION_UNAVAILABLE);
}

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
  // A root with no model still constructs: the Chat surface already works that way (a fresh install opens, reads and
  // holds a draft, and only a send refuses), and a Game surface that cannot even be built for the same reason made the
  // two surfaces disagree about what "no model" means. Only that state is omitted here.
  //
  // `unreadable` is not the same fact and keeps refusing: a connection document this process cannot parse is a broken
  // configuration, not an absent one, and telling a player to bring a connection they already brought is the wrong
  // instruction. The one owner of the rule distinguishes the two, so this surface does too.
  const modelConfig = await readGameModelConfig(input);
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
    ...(modelConfig === undefined ? {} : { modelConfig }),
    gameplaySubagentEnabled: input.gameplayWorkerEnabled,
    hostBindingFactory: input.hostBindingFactory,
    ...recoveryFields,
  });
}
