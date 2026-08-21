import type { GameRuntimeBinding } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import type { GameRuntimeMaterializer } from "../continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.internal.js";
import type { SemanticGameProductionAuthority } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import {
  type ConstructedUnmountedGameSemanticFacade,
  constructKnownUnmountedGameSemanticFacade,
} from "./continuity-semantic-game-facade.internal.js";

/** Test-build-only composition seam. Production composition uses fixed Host constructors. */
export function constructTestKnownUnmountedGameSemanticFacade(
  binding: GameRuntimeBinding,
  game: SemanticGameProductionAuthority,
  materializer: GameRuntimeMaterializer,
): ConstructedUnmountedGameSemanticFacade {
  return constructKnownUnmountedGameSemanticFacade(binding, game, materializer);
}
