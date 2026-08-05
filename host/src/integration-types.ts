import { type ExecutionReceipt, type Scope, type Snapshot } from "./protocol.js";
import { type KnowledgeBundle } from "./knowledge.js";
import { type GameIntegrationModule } from "./integration-module.js";

/**
 * Compatibility state exposed by the first Stardew bridge adapter. Other
 * integrations may keep a different opaque state behind their module port.
 */
export type CompanionIntegrationState = Readonly<{
  connected: boolean;
  sessionId: string | null;
  capabilities: readonly string[];
  snapshot: Snapshot | null;
  latestReceipt: ExecutionReceipt | null;
  latestReasonCode: string | null;
}>;

/**
 * Host-facing connection port. The connection owns only identity and its
 * explicitly mounted module; game facts remain behind the adapter's state.
 */
export interface IntegrationConnection {
  readonly scope: Scope;
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
