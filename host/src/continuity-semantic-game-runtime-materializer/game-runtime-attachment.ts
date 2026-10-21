import { join } from "node:path";

import type { GameCompanionRuntimeAttachment, GameHostBindingFactory } from "../runtime-core.internal.js";
import type { CompanionModelConfig } from "../runtime-identity.js";
import { ModelProfileStore, resolveModelProfileConfig } from "../settings/model-profile-store.js";
import { TavernConnectionStore } from "../tavern/connection-store.js";

/** The durable recovery fields this construction zone already owns. */
export type GameRuntimeRecoveryAttachment = Pick<
  GameCompanionRuntimeAttachment,
  "recoveryJournal" | "recoveryBinding" | "recoveryPort"
>;

/**
 * The player's active connection as the model selection it stands for: the
 * provider/model pair, and nothing else.
 *
 * The endpoint and the credential are deliberately not copied here:
 * `runtime-core` merges the selected provider entry into Pi's `models.json` from
 * the same stored record under the same `agentDir`, so that record keeps one
 * owner. Read exactly as the Chat construction reads it
 * (`continuity-semantic-chat-runtime-construction.internal.ts:260-272`): a
 * connection store that cannot be read counts as "no active connection", and the
 * surface's own profile then applies.
 */
async function readActiveConnectionSelection(
  agentDir: string,
): Promise<Readonly<{ provider: string; modelId: string }> | null> {
  try {
    const active = await new TavernConnectionStore(agentDir).active();
    if (active === null) return null;
    return Object.freeze({ provider: active.providerId, modelId: active.modelId });
  } catch {
    return null;
  }
}

/**
 * The one rule the Game attachment applies to the player's model: an active
 * connection decides provider and model, and the surface's own profile decides
 * only what the connection does not - the thinking level. That level is this
 * surface's tuning for how much the companion reasons before it acts in the
 * world, not a fact about the connection, so configuring a connection for Chat
 * does not retune the Game's reasoning (design/28 §2.3).
 *
 * With no active connection the surface profile applies unchanged, which is what
 * keeps a root without player connections configured exactly as it was.
 *
 * Null means neither source could yield a model: the caller refuses the
 * attachment rather than building a runtime no provider can answer for.
 */
function resolveGameModelConfig(
  input: Readonly<{
    profileConfig: CompanionModelConfig | null;
    activeConnection: Readonly<{ provider: string; modelId: string }> | null;
  }>,
): CompanionModelConfig | null {
  const { profileConfig, activeConnection } = input;
  if (profileConfig === null) return null;
  if (activeConnection === null) return profileConfig;
  return Object.freeze({
    provider: activeConnection.provider,
    modelId: activeConnection.modelId,
    thinkingLevel: profileConfig.thinkingLevel,
  });
}

/**
 * Builds the one attachment every Game runtime is constructed with.
 *
 * The model configuration is the player's own and resolves exactly the way the
 * Chat surface's does: the active connection decides provider and model when the
 * player has selected one, and the surface's own `game` profile decides every
 * other case - including the case with no connection at all. One configured
 * connection therefore serves both surfaces, which is what a player means by "I
 * configured it, so it must work in the game too".
 *
 * The resolved configuration is a precondition of the surface, not an option the
 * caller may skip: the attachment always carries `modelConfig`, and the
 * operational gate nonce decides only whether the gameplay worker is armed. A
 * Game session constructed without a model configuration is not a degraded
 * session but a dead one - the embedded runtime substitutes its `unknown`
 * placeholder model, records no provider entry, and leaves the surface unable to
 * reach any provider - so a store that cannot yield a resolvable configuration
 * fails closed here, before a runtime exists, with the same named discipline the
 * gameplay worker uses. No default model is invented and no other surface's
 * profile is substituted.
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
  const modelProfile = await new ModelProfileStore(join(input.runtimeRoot, "settings", "model-profiles.json")).read(
    "game",
  );
  const modelConfig = resolveGameModelConfig({
    profileConfig: resolveModelProfileConfig(modelProfile),
    activeConnection: await readActiveConnectionSelection(input.agentDir),
  });
  if (modelConfig === null) throw new Error("game_runtime_model_configuration_unavailable");
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
