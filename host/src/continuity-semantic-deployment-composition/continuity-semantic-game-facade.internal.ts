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
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { GameOperationalGateEvidence } from "../game-operational-gate-evidence.js";
import type { HostGameLifecycleSnapshot } from "../game-status/game-status.js";
import type { CompanionHostService } from "../host-service.js";

/**
 * Commit-gated connected ingress. Its brand and backing live authority remain
 * private to this construction module; consumers receive neither a binding,
 * permit, store, mutex, nor a teardown operation.
 */
export type ConnectedSemanticGameLease = Readonly<{
  readonly __connectedSemanticGameLease: unique symbol;
  /** Host-observed Pi identity, exposed only for one-shot operational-gate IPC correlation. */
  piSessionId: string;
  /** Exact durable Game session from the committed enter permit. */
  gameSessionId: string;
  host: CompanionHostService;
  lifecycleSnapshot(): HostGameLifecycleSnapshot;
  /**
   * Entry-owned one-shot post-commit ingress release. The Host remains sealed
   * until the entry has bootstrapped the receipt-owned voice session and bound
   * STOP authority.
   */
  activateCommittedIngress(): void;
  /** Source-owned, content-free operational-gate evidence; absent unless armed at construction. */
  nextOperationalGateEvidence?(): Promise<Omit<GameOperationalGateEvidence, "nonceSha256" | "piSessionId">>;
  /** Launch-owned one-shot prompt task; its worker result is intentionally discarded. */
  dispatchPromptDefinedTask(task: string): Promise<void>;
  /** Seals and cancels the exact active prompt task before close waits for drain. */
  cancelPromptDefinedTask(): void;
}>;

/** Internal construction product; the public module narrows it to its facade type. */
export type RecoverDeadOwnerRequest = Readonly<{
  request: "recover_dead_owner";
  operationId: string;
}>;

/**
 * The entry-facing semantic Game surface. Recovery is intentionally a narrow
 * operator request: construction retains every owner, proof, permit, binding,
 * mutex, path, and store authority fact.
 */
export type ConstructedUnmountedGameSemanticFacade = Readonly<{
  authority: "SEMANTIC";
  runEnter(): Promise<ConnectedSemanticGameLease>;
  recoverDeadOwner(input: RecoverDeadOwnerRequest): Promise<void>;
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
  let live:
    | {
        runtime: MaterializedGameRuntime;
        durable: LiveSemanticGame;
        closeCheckpoint?: {
          permit: Awaited<ReturnType<typeof game.prepareClose>>;
          receipt?: Awaited<ReturnType<MaterializedGameRuntime["teardownClose"]>>;
        };
      }
    | undefined;
  let closePromise: Promise<void> | undefined;
  let connectedLease: ConnectedSemanticGameLease | undefined;
  let ingressActivated = false;
  let promptTaskConsumed = false;
  let drainResolve: (() => void) | undefined;
  const drain = (): Promise<void> =>
    active
      ? new Promise((resolve) => {
          drainResolve = resolve;
        })
      : Promise.resolve();

  const runEnter = async (): Promise<ConnectedSemanticGameLease> => {
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
            if (runtime.connected === undefined) throw new Error("semantic_game_connected_ingress_unavailable");
            const durable = await game.commitEnter(permit, runtime.receipt);
            return { runtime, durable };
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
      const connected = completed.runtime.connected!;
      if (typeof completed.runtime.piSessionId !== "string" || completed.runtime.piSessionId.length === 0)
        throw new Error("semantic_game_pi_session_unavailable");
      // Materialization constructs the loop/Host and admits the launch-owned
      // initial facts before minting its receipt. Only the exact durable
      // commit above may publish this deliberately narrow connected ingress.
      connectedLease = Object.freeze({
        piSessionId: completed.runtime.piSessionId,
        gameSessionId: completed.runtime.receipt.gameSessionId,
        host: connected.host,
        lifecycleSnapshot: connected.lifecycleSnapshot,
        activateCommittedIngress: () => {
          if (ingressActivated) return;
          ingressActivated = true;
          connected.activateIngress();
        },
        ...(connected.nextOperationalGateEvidence === undefined
          ? {}
          : { nextOperationalGateEvidence: connected.nextOperationalGateEvidence }),
        dispatchPromptDefinedTask: async (task: string): Promise<void> => {
          if (!ingressActivated) throw new Error("semantic_game_ingress_not_activated");
          if (closing || live === undefined) throw new Error("semantic_game_lease_unavailable");
          if (promptTaskConsumed) throw new Error("semantic_game_prompt_task_already_consumed");
          // Linearize before entering the async worker seam. A rejected worker
          // may have produced a native side effect and must never be replayed.
          promptTaskConsumed = true;
          active = true;
          try {
            await connected.dispatchPromptDefinedTask(task);
          } finally {
            active = false;
            drainResolve?.();
            drainResolve = undefined;
          }
        },
        cancelPromptDefinedTask: (): void => {
          if (closing || live === undefined) return;
          connected.cancelPromptDefinedTask();
        },
      }) as ConnectedSemanticGameLease;
      return connectedLease;
    } finally {
      active = false;
      drainResolve?.();
      drainResolve = undefined;
    }
  };

  const recoverDeadOwner = async (input: RecoverDeadOwnerRequest): Promise<void> => {
    if (closing || active || live || recoveryRequired) throw new Error("semantic_game_facade_unavailable");
    active = true;
    try {
      await game.recoverDeadOwner(input);
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
          // The checkpoint is an opaque record of the sole close operation
          // admitted for this live runtime. A physical teardown failure keeps
          // its permit for retry; a durable commit failure additionally keeps
          // the exact successful teardown receipt, so retry cannot teardown a
          // runtime that has already been closed.
          const checkpoint =
            current.closeCheckpoint ?? (current.closeCheckpoint = { permit: await game.prepareClose(current.durable) });
          checkpoint.receipt ??= await current.runtime.teardownClose(checkpoint.permit);
          await game.commitClose(current.durable, checkpoint.permit, checkpoint.receipt);
          live = undefined;
          connectedLease = undefined;
        } catch (error) {
          // `live`, its binding-backed runtime, store/coordinator authority,
          // and close checkpoint deliberately remain intact. In particular, do
          // not call failClose here: it would durably retire an owner while
          // the physical runtime could still survive.
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

  return Object.freeze({ authority: "SEMANTIC" as const, runEnter, recoverDeadOwner, close });
}
