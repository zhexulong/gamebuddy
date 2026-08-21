/**
 * 5-State Monoidal Lifecycle Finite State Machine.
 * Transitions: uninitialized -> starting -> active -> draining -> terminal
 * Monoidal Cancellation Absorption: Cancel(Starting) === Terminal
 * Terminal state is strictly absorbing and irreversible.
 */
export type LifecycleState = "uninitialized" | "starting" | "active" | "draining" | "terminal";

export interface LifecycleResult {
  readonly state: LifecycleState;
  readonly reasonCode: string;
}

export interface LifecycleFsm {
  readonly currentState: LifecycleState;
  start(action: (signal: AbortSignal) => Promise<void>): Promise<void>;
  drain(reasonCode?: string): LifecycleResult;
  complete(reasonCode?: string): LifecycleResult;
  cancel(reasonCode: string): LifecycleResult;
}

export function createLifecycleFsm(): LifecycleFsm {
  let state: LifecycleState = "uninitialized";
  let abortController = new AbortController();

  return {
    get currentState() {
      return state;
    },
    async start(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
      if (state !== "uninitialized") {
        throw new Error(`invalid_start_state:${state}`);
      }
      state = "starting";
      abortController = new AbortController();

      try {
        await action(abortController.signal);
        const currentState = state as LifecycleState;
        if (abortController.signal.aborted || currentState === "terminal") {
          state = "terminal";
        } else if (currentState === "starting") {
          state = "active";
        }
      } catch (err) {
        state = "terminal";
        if (abortController.signal.aborted) {
          return;
        }
        throw err;
      }
    },
    drain(reasonCode = "draining"): LifecycleResult {
      if (state === "active") {
        state = "draining";
      }
      return { state, reasonCode };
    },
    complete(reasonCode = "completed"): LifecycleResult {
      state = "terminal";
      return { state: "terminal", reasonCode };
    },
    cancel(reasonCode: string): LifecycleResult {
      abortController.abort(reasonCode);
      state = "terminal";
      return { state: "terminal", reasonCode };
    },
  };
}
