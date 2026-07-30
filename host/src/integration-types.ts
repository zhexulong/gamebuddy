import { type ActionGrant, type ExecutionReceipt, type Scope, type Snapshot } from "./protocol.js";

/** Read-only integration facts usable by Companion tools and the runtime. */
export type CompanionIntegrationState = Readonly<{
  connected: boolean;
  sessionId: string | null;
  capabilities: readonly string[];
  snapshot: Snapshot | null;
  latestReceipt: ExecutionReceipt | null;
  latestReasonCode: string | null;
}>;

export interface CompanionIntegration {
  readonly scope: Scope;
  readonly state: CompanionIntegrationState;
}

/** Host may select only a currently valid, Mod-issued local approval. */
export type MoveApprovalIntegration = CompanionIntegration & {
  nextMoveGrant(target: Readonly<{ x: number; y: number }>): ActionGrant | null;
};
