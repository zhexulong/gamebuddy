import type {
  GameActionDescriptor,
  GameActionDispatchInput,
  GameActionDispatchResult,
  GameActionReceipt,
  GameAdapter,
  GameAdapterStatus,
  GamePostconditionEvaluationInput,
  GamePostconditionEvaluationResult,
} from "../../game-adapter.js";

export const STARDEW_GAME_ID = "stardew" as const;
export const STARDEW_ADAPTER_VERSION = "0.1.0" as const;

export const STARDEW_KNOWN_ACTIONS: readonly GameActionDescriptor[] = Object.freeze([
  Object.freeze({
    actionId: "equip_tool",
    description: "Equip a specified tool from player inventory into active hand slot",
  }),
  Object.freeze({
    actionId: "till_soil",
    description: "Use equipped hoe to till a targeted dirt tile",
  }),
  Object.freeze({
    actionId: "sleep_day",
    description: "Navigate to bed and advance to the next game day",
  }),
]);

type StardewActionExecutor = (
  input: GameActionDispatchInput,
) => Promise<GameActionDispatchResult>;

type StardewPostconditionEvaluator = (
  input: GamePostconditionEvaluationInput,
) => Promise<GamePostconditionEvaluationResult>;

/**
 * Fixture and execution options for Stardew GameAdapter production seam.
 * Allows injecting custom action executors and postcondition evaluators
 * for testing, offline verification, or bridge-bound execution, replacing
 * legacy RunPort patterns.
 */
export type StardewGameAdapterOptions = Readonly<{
  actionExecutor?: StardewActionExecutor;
  postconditionEvaluator?: StardewPostconditionEvaluator;
  publishedActions?: readonly GameActionDescriptor[];
  statusProvider?: () => Promise<GameAdapterStatus>;
  cancelHandler?: (executionId: string) => Promise<boolean>;
}>;

/**
 * Default offline/fallback action executor when no live bridge or fixture is injected.
 */
async function defaultStardewActionExecutor(
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

  const isKnown = STARDEW_KNOWN_ACTIONS.some((a) => a.actionId === input.actionId);
  if (!isKnown) {
    return Object.freeze({
      executionId: input.executionId,
      status: "rejected",
      error: `unknown_stardew_action: ${input.actionId}`,
      receipt: Object.freeze({
        outcome: "rejected",
        reason: "unknown_action",
      }),
    });
  }

  return Object.freeze({
    executionId: input.executionId,
    status: "failed",
    error: "no_active_stardew_bridge_session",
    receipt: Object.freeze({
      outcome: "failure",
      reason: "no_active_stardew_bridge_session",
    }),
  });
}

/**
 * Default postcondition evaluator verifying receipt outcome and evidence existence.
 */
async function defaultStardewPostconditionEvaluator(
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

/**
 * Factory creating a GameAdapter instance for Stardew Valley.
 * Serves as the primary production execution seam, accepting injected
 * fixture executors or native bridge handlers.
 */
export function createStardewGameAdapter(
  options: StardewGameAdapterOptions = {},
): GameAdapter {
  const executor = options.actionExecutor ?? defaultStardewActionExecutor;
  const evaluator = options.postconditionEvaluator ?? defaultStardewPostconditionEvaluator;
  const actions = options.publishedActions ?? STARDEW_KNOWN_ACTIONS;

  return Object.freeze({
    gameId: STARDEW_GAME_ID,
    version: STARDEW_ADAPTER_VERSION,

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
        gameId: STARDEW_GAME_ID,
        connected: false,
        version: STARDEW_ADAPTER_VERSION,
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
