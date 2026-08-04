import { type ExecutionReceipt, type Scope, type Snapshot } from "./protocol.js";
import { type KnowledgeBundle } from "./knowledge.js";

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
  /** Optional, version-bound advisory knowledge explicitly mounted by Host. */
  readonly knowledge?: KnowledgeBundle;
  /** Target integration version owned by Host configuration, never Agent input. */
  readonly gameVersion?: string;
}
