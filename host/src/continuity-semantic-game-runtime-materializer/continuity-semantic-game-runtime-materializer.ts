import { createCompanionRuntime, type RuntimeSession } from "../runtime.js";
import type { IntegrationConnection } from "../integration-types.js";
import {
  materializeExactEnter,
  type GameRuntimeMaterializer,
  type MaterializedGameRuntime,
} from "./continuity-semantic-game-runtime-materializer.internal.js";

export type {
  GameRuntimeMaterializer,
  MaterializedGameRuntime,
} from "./continuity-semantic-game-runtime-materializer.internal.js";

/**
 * Creates the fixed production S4c materializer. This is construction-zone-only:
 * the eventual composer invokes it inside the live S4b one-shot callback after
 * durable prepare. No facade/model/Mod-wire configuration reaches this factory.
 */
export function createHostGameRuntimeMaterializer(): GameRuntimeMaterializer {
  return Object.freeze({
    async materializeEnter(reservation, permit): Promise<MaterializedGameRuntime> {
      return materializeExactEnter(reservation, permit, async (execution) => {
        const runtime = await createMaterializedGameRuntime(
          execution.principal,
          execution.world,
          execution.runtimeRoot,
          execution.connection,
          permit.gameSessionId,
        );
        return Object.freeze({
          session: runtime.session,
          ...(runtime.gameplaySubagent === undefined ? {} : { gameplaySubagent: runtime.gameplaySubagent }),
        });
      });
    },
  });
}

type MaterializedGameRuntimeInput = Readonly<{
  principal: Readonly<{ continuityId: string; companionId: string; playerId: string }>;
  world: Readonly<{ saveId: string; worldId: string }>;
  runtimeRoot: string;
  connection: IntegrationConnection;
  gameSessionId: string;
}>;

/**
 * The only named Game runtime constructor lives in the construction-zone
 * materializer. It has no public export: an actual runtime becomes durable
 * Game authority only after this module validates an S4b execution and S4c
 * permit, then the later composer terminalizes an exact receipt.
 */
async function createMaterializedGameRuntime(
  principal: MaterializedGameRuntimeInput["principal"],
  world: MaterializedGameRuntimeInput["world"],
  runtimeRoot: string,
  connection: IntegrationConnection,
  gameSessionId: string,
): Promise<RuntimeSession> {
  return createCompanionRuntime(
    Object.freeze({
      continuityId: principal.continuityId,
      companionId: principal.companionId,
      playerId: principal.playerId,
      saveId: world.saveId,
      worldId: world.worldId,
    }),
    runtimeRoot,
    connection,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    gameSessionId,
    undefined,
    "game",
  );
}
