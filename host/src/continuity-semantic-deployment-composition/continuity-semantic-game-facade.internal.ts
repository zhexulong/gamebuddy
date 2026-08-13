import {
  readReservedGameRuntimeMaterializationFacts,
  releaseReservedGameRuntimeMaterialization,
  reserveGameRuntimeMaterialization,
  withConsumedBindingExecution,
} from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.internal.js";
import type { GameRuntimeBinding } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import type {
  GameRuntimeMaterializer,
  MaterializedGameRuntime,
} from "../continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.internal.js";
import type {
  LiveSemanticGame,
  SemanticGameProductionAuthority,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";

/** Internal construction product; the public module narrows it to its facade type. */
export type ConstructedUnmountedGameSemanticFacade = Readonly<{
  authority: "SEMANTIC";
  runEnter(): Promise<Readonly<{ state: "active" }>>;
  close(): Promise<void>;
}>;

/**
 * Shares the exact production lifecycle orchestration with test-support while
 * keeping every dependency construction-owned. The public deployment module
 * never accepts any of these dependencies as input.
 */
export function constructKnownUnmountedGameSemanticFacade(
  binding: GameRuntimeBinding,
  game: SemanticGameProductionAuthority,
  materializer: GameRuntimeMaterializer,
): ConstructedUnmountedGameSemanticFacade {
  let closing = false;
  let active = false;
  let recoveryRequired = false;
  let live: Readonly<{ runtime: MaterializedGameRuntime; durable: LiveSemanticGame }> | undefined;
  let closePromise: Promise<void> | undefined;
  let drainResolve: (() => void) | undefined;
  const drain = (): Promise<void> =>
    active
      ? new Promise((resolve) => {
          drainResolve = resolve;
        })
      : Promise.resolve();

  const runEnter = async (): Promise<Readonly<{ state: "active" }>> => {
    if (closing || active || live || recoveryRequired) throw new Error("semantic_game_facade_unavailable");
    active = true;
    try {
      const completed = await binding.executeWithBinding((token) =>
        withConsumedBindingExecution(token, async (execution) => {
          const reservation = reserveGameRuntimeMaterialization(execution);
          const facts = readReservedGameRuntimeMaterializationFacts(reservation);
          let permit: Awaited<ReturnType<typeof game.prepareEnter>> | undefined;
          let runtime: MaterializedGameRuntime | undefined;
          try {
            permit = await game.prepareEnter(facts);
            runtime = await materializer.materializeEnter(reservation, permit);
            const durable = await game.commitEnter(permit, runtime.receipt);
            return Object.freeze({ runtime, durable });
          } catch (error) {
            if (runtime) {
              try {
                await runtime.close();
              } catch {
                /* durable failure follows */
              }
            }
            if (permit) {
              // A failed terminalization must be contained locally even if the
              // store-side effect_failed transition itself faults. Otherwise a
              // pending durable enter could be abandoned by ordinary close.
              try {
                const failed = await game.failEnter(permit);
                if (
                  failed.status !== "recovery_required" ||
                  failed.gameState !== "recovery_required" ||
                  failed.leaseState !== "recovery_required"
                ) {
                  throw new Error("semantic_game_enter_failure_not_recovered");
                }
              } catch {
                recoveryRequired = true;
              }
            }
            if (!permit) releaseReservedGameRuntimeMaterialization(reservation);
            throw error;
          }
        }),
      );
      live = completed;
      return Object.freeze({ state: "active" as const });
    } finally {
      active = false;
      drainResolve?.();
      drainResolve = undefined;
    }
  };

  const close = (): Promise<void> =>
    (closePromise ??= (async () => {
      closing = true;
      await drain();
      let failure: unknown;
      if (recoveryRequired) {
        closePromise = undefined;
        closing = false;
        throw new Error("semantic_game_facade_recovery_required");
      }
      if (live) {
        const current = live;
        try {
          const permit = await game.prepareClose(current.durable);
          try {
            const receipt = await current.runtime.teardownClose(permit);
            await game.commitClose(current.durable, permit, receipt);
            live = undefined;
          } catch (error) {
            try {
              await game.failClose(current.durable, permit);
              live = undefined;
              recoveryRequired = true;
            } catch {
              /* preserve teardown failure and retain live capability */
            }
            throw error;
          }
        } catch (error) {
          failure = error;
        }
      }
      // A failed close is deliberately not followed by reverse binding/store
      // closure: recovery is durable and a fresh owner-proof contract is required.
      if (failure === undefined) {
        // Acquisition is binding → Game authority. A failed Game close leaves
        // the binding live for an explicit retry; only a closed Game authority
        // permits the final reverse binding shutdown.
        try {
          await game.close();
        } catch (error) {
          failure ??= error;
        }
        if (failure === undefined)
          try {
            await binding.close();
          } catch (error) {
            failure ??= error;
          }
      }
      if (failure !== undefined) {
        closePromise = undefined;
        closing = false;
        throw failure;
      }
    })());

  return Object.freeze({ authority: "SEMANTIC" as const, runEnter, close });
}
