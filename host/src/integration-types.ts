import type { GameIntegrationModule } from "./integration-module.js";
import type { KnowledgeBundle } from "./knowledge.js";
import type { ActionRegistration, ExecutionReceipt, Scope as StardewScope, Snapshot } from "./protocol.js";

/**
 * Compatibility state exposed by the first Stardew bridge adapter. Other
 * integrations may keep a different opaque state behind their module port.
 */
export type CompanionIntegrationState = Readonly<{
  connected: boolean;
  sessionId: string | null;
  capabilities: readonly string[];
  /**
   * Authenticated Mod registration projection for this connection generation.
   * Production bridge clients populate it from hello_ack; absence is treated as
   * an empty catalog so a partial or stale adapter never materializes an action.
   */
  catalogRegistrations?: readonly ActionRegistration[];
  /** Authenticated catalog publication revision for this connection generation. */
  catalogRevision?: number;
  snapshot: Snapshot | null;
  latestReceipt: ExecutionReceipt | null;
  latestReasonCode: string | null;
}>;

/**
 * Host-neutral integration identity. Any save/world/player binding remains
 * adapter-owned and is verified through GameIntegrationModule.
 */
export type IntegrationScope = Readonly<{
  integrationId: string;
}>;

export interface IntegrationConnection {
  readonly scope: IntegrationScope;
  /**
   * Host-owned liveness fence. Launchers set this false before closing on a
   * lifecycle loss; every adapter-owned action path must reject while false.
   * It prevents a stale tool closure from treating a former connection as live.
   */
  readonly executionGate?: Readonly<{ executable: boolean }>;
  readonly module: GameIntegrationModule;
  /** Adapter-owned opaque facts; Host core passes them back to the module. */
  readonly state: unknown;
  /** Optional module-owned advisory data mounted by the Host. */
  readonly knowledge?: unknown;
  /** Optional version binding owned by the selected integration. */
  readonly gameVersion?: string;
}

/**
 * Compatibility execution/state port used by the Stardew bridge adapter and
 * its existing tools. Generic Host code uses GameIntegrationModule methods
 * instead of importing Stardew registries or tool factories.
 */
export interface CompanionIntegration extends IntegrationConnection {
  /** Stardew bridge-v1 compatibility scope; generic Host code uses IntegrationScope only. */
  readonly scope: StardewScope;
  readonly state: CompanionIntegrationState;
  /** Stardew compatibility data; generic Host code only sees opaque knowledge. */
  readonly knowledge?: KnowledgeBundle;
  /** Target integration version owned by Host configuration, never Agent input. */
  readonly gameVersion?: string;
  /** Compatibility execution methods remain adapter-owned and optional. */
  readonly execute?: (...args: any[]) => any;
  readonly cancel?: (...args: any[]) => any;
}

/**
 * The first migration keeps Stardew's legacy bridge state typed behind the
 * adapter. New integrations should implement only IntegrationConnection and
 * never import this compatibility shape.
 */
export type LegacyStardewIntegration = CompanionIntegration;
