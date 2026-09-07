/**
 * Cross-game GameAdapter Service Provider Interface (SPI).
 * Defines the contract that each game integration adapter must fulfill to decouple
 * generic Host orchestration from game-specific execution semantics.
 */

export type GameActionReceipt = Readonly<{
  outcome: "success" | "failure" | "rejected" | "uncertain";
  reason?: string;
  evidence?: unknown;
  details?: Readonly<Record<string, unknown>>;
}>;

export type GameActionDispatchInput = Readonly<{
  actionId: string;
  parameters?: Readonly<Record<string, unknown>>;
  requestId: string;
  executionId: string;
  correlationId?: string;
  deadlineUnixMs?: number;
  idempotencyKey?: string;
}>;

export type GameActionDispatchResult = Readonly<{
  executionId: string;
  status: "dispatched" | "completed" | "rejected" | "failed";
  receipt?: GameActionReceipt;
  error?: string;
}>;

export type GamePostconditionEvaluationInput = Readonly<{
  actionId: string;
  executionId: string;
  receipt?: GameActionReceipt | unknown;
  evidence?: unknown;
  expectedOutcome?: string;
  currentState?: unknown;
}>;

export type GamePostconditionEvaluationResult = Readonly<{
  verified: boolean;
  reason?: string;
  evidence?: unknown;
  details?: Readonly<Record<string, unknown>>;
}>;

export type GameActionDescriptor = Readonly<{
  actionId: string;
  description?: string;
  parametersSchema?: unknown;
}>;

export type GameAdapterStatus = Readonly<{
  gameId: string;
  connected: boolean;
  version?: string;
  statusText?: string;
}>;

export type GameAdapter = Readonly<{
  readonly gameId: string;
  readonly version: string;
  dispatchAction(input: GameActionDispatchInput): Promise<GameActionDispatchResult>;
  evaluatePostcondition(input: GamePostconditionEvaluationInput): Promise<GamePostconditionEvaluationResult>;
  getPublishedActions?(): Promise<readonly GameActionDescriptor[]>;
  getStatus?(): Promise<GameAdapterStatus>;
  cancelAction?(executionId: string): Promise<boolean>;
}>;
