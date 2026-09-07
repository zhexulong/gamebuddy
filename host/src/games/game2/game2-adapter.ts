import type {
  GameActionDescriptor,
  GameActionDispatchInput,
  GameActionDispatchResult,
  GameActionReceipt,
  GameAdapter,
  GameAdapterStatus,
  GamePostconditionEvaluationInput,
  GamePostconditionEvaluationResult,
} from "../game-adapter.js";

export const GAME2_ID = "game2" as const;
export const GAME2_ADAPTER_VERSION = "0.1.0" as const;

export const GAME2_KNOWN_ACTIONS: readonly GameActionDescriptor[] = Object.freeze([
  Object.freeze({
    actionId: "move_player",
    description: "Move player character towards target coordinates",
  }),
  Object.freeze({
    actionId: "interact",
    description: "Interact with the object or entity in front of the player",
  }),
]);

type Game2ActionExecutor = (
  input: GameActionDispatchInput,
) => Promise<GameActionDispatchResult>;

type Game2PostconditionEvaluator = (
  input: GamePostconditionEvaluationInput,
) => Promise<GamePostconditionEvaluationResult>;

export type Game2GameAdapterOptions = Readonly<{
  actionExecutor?: Game2ActionExecutor;
  postconditionEvaluator?: Game2PostconditionEvaluator;
  publishedActions?: readonly GameActionDescriptor[];
  statusProvider?: () => Promise<GameAdapterStatus>;
  cancelHandler?: (executionId: string) => Promise<boolean>;
}>;

async function defaultGame2ActionExecutor(
  input: GameActionDispatchInput,
): Promise<GameActionDispatchResult> {
  if (!input.actionId || typeof input.actionId !== "string" || input.actionId.trim().length === 0) {
    return Object.freeze({
      executionId: input.executionId,
      status: "rejected",
      error: "invalid_action_id",
      receipt: Object.freeze({
        outcome: "rejected",
        reason: "action_id_must_be_non_empty_string",
      }),
    });
  }

  const isKnown = GAME2_KNOWN_ACTIONS.some((a) => a.actionId === input.actionId);
  if (!isKnown) {
    return Object.freeze({
      executionId: input.executionId,
      status: "rejected",
      error: `unknown_game2_action: ${input.actionId}`,
      receipt: Object.freeze({
        outcome: "rejected",
        reason: "unknown_action",
      }),
    });
  }

  return Object.freeze({
    executionId: input.executionId,
    status: "failed",
    error: "no_active_game2_bridge_session",
    receipt: Object.freeze({
      outcome: "failure",
      reason: "no_active_game2_bridge_session",
    }),
  });
}

async function defaultGame2PostconditionEvaluator(
  input: GamePostconditionEvaluationInput,
): Promise<GamePostconditionEvaluationResult> {
  const receipt = input.receipt as GameActionReceipt | undefined;
  if (!receipt) {
    return Object.freeze({
      verified: false,
      reason: "receipt_missing",
    });
  }

  if (receipt.outcome === "success") {
    return Object.freeze({
      verified: true,
      reason: "outcome_success",
      evidence: receipt.evidence,
      details: receipt.details,
    });
  }

  return Object.freeze({
    verified: false,
    reason: receipt.reason ?? `outcome_${receipt.outcome}`,
    evidence: receipt.evidence,
    details: receipt.details,
  });
}

export function createGame2Adapter(
  options: Game2GameAdapterOptions = {},
): GameAdapter {
  const executor = options.actionExecutor ?? defaultGame2ActionExecutor;
  const evaluator = options.postconditionEvaluator ?? defaultGame2PostconditionEvaluator;
  const actions = options.publishedActions ?? GAME2_KNOWN_ACTIONS;

  return Object.freeze({
    gameId: GAME2_ID,
    version: GAME2_ADAPTER_VERSION,

    async dispatchAction(input: GameActionDispatchInput): Promise<GameActionDispatchResult> {
      return executor(input);
    },

    async evaluatePostcondition(
      input: GamePostconditionEvaluationInput,
    ): Promise<GamePostconditionEvaluationResult> {
      return evaluator(input);
    },

    async getPublishedActions(): Promise<readonly GameActionDescriptor[]> {
      return actions;
    },

    async getStatus(): Promise<GameAdapterStatus> {
      if (options.statusProvider) {
        return options.statusProvider();
      }
      return Object.freeze({
        gameId: GAME2_ID,
        connected: false,
        version: GAME2_ADAPTER_VERSION,
        statusText: "standby",
      });
    },

    async cancelAction(executionId: string): Promise<boolean> {
      if (options.cancelHandler) {
        return options.cancelHandler(executionId);
      }
      return false;
    },
  });
}
