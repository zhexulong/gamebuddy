import type { GameRuntimeBindingExecution } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.internal.js";
import type { ProductionGamePermit } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import type { CompanionHostService } from "../host-service.js";
import type { RuntimeSession } from "../runtime.js";
import {
  type GameRuntimeMaterializer,
  type MaterializedGameRuntime,
  materializeExactEnter,
  type RuntimeDisposal,
} from "./continuity-semantic-game-runtime-materializer.internal.js";

const observedProductionRuntimes = new WeakMap<MaterializedGameRuntime, RuntimeSession>();

/** Test-build-only observer for an already materialized production runtime; it cannot construct or register authority. */
export function observeMaterializedProductionRuntimeForTest(runtime: MaterializedGameRuntime): RuntimeSession {
  const observed = observedProductionRuntimes.get(runtime);
  if (observed === undefined) throw new Error("materialized_runtime_test_observation_unavailable");
  return observed;
}

export function recordMaterializedProductionRuntimeForTest(runtime: MaterializedGameRuntime, session: RuntimeSession): void {
  observedProductionRuntimes.set(runtime, session);
}

export function forgetMaterializedProductionRuntimeForTest(runtime: MaterializedGameRuntime): void {
  observedProductionRuntimes.delete(runtime);
}

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
      return materializeExactEnter(reservation, permit, async (execution) => {
        const disposal = await factory(Object.freeze({ execution, permit }));
        return Object.freeze({
          ...disposal,
          piSessionId: disposal.piSessionId ?? "pi_session_test_01",
          connected:
            disposal.connected ??
            Object.freeze({
              host: Object.freeze({ close: () => undefined }) as CompanionHostService,
              lifecycleSnapshot: () =>
                Object.freeze({
                  availability: "available" as const,
                  surface: "active" as const,
                  freshness: "current" as const,
                  availableCapabilities: Object.freeze({ category: "none" as const, count: 0 }),
                  activeExecution: "none" as const,
                  latestAuthoritativeReceipt: "none" as const,
                }),
              markClosing: () => undefined,
              activateIngress: () => undefined,
            }),
        });
      });
    },
  });
}
