import type { GameRuntimeBindingExecution } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.internal.js";
import type { ProductionGamePermit } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import {
  materializeExactEnter,
  type GameRuntimeMaterializer,
  type RuntimeDisposal,
} from "./continuity-semantic-game-runtime-materializer.internal.js";

/** Test-build-only factory adapter. Production uses the fixed Host runtime factory. */
export function createTestGameRuntimeMaterializer(
  factory: (
    input: Readonly<{
      execution: GameRuntimeBindingExecution;
      permit: ProductionGamePermit;
    }>,
  ) => Promise<RuntimeDisposal>,
): GameRuntimeMaterializer {
  if (typeof factory !== "function") throw new Error("invalid_game_runtime_materializer_factory");
  return Object.freeze({
    async materializeEnter(reservation, permit) {
      return materializeExactEnter(reservation, permit, (execution) => factory(Object.freeze({ execution, permit })));
    },
  });
}
