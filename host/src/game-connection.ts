import type { GameIntegrationAdapter } from "./game-integration-adapter.js";
import type { KnowledgeBundle } from "./knowledge.js";
import type {
  ActionRegistration,
  ExecutionReceipt,
  NavigationReadRequest,
  NavigationReadResult,
  Scope as StardewScope,
  Snapshot,
} from "./protocol.js";

/**
 * Compatibility state exposed by the first Stardew bridge adapter. Other
 * integrations may keep a different opaque state behind their adapter port.
 */
export type StardewBridgeConnectionState = Readonly<{
  connected: boolean;
  sessionId: string | null;
  capabilities: readonly string[];
  /**
   * Authenticated Mod registration projection for this connection generation.
   * Production bridge clients populate it from hello_ack; absence is treated as
   * an empty catalog so a partial or stale adapter never materializes an action.
   */
  catalogRegistrations?: readonly ActionRegistration[];
  /** Current authenticated Mod availability projection; absent means no action may materialize. */
  catalogRevision?: number;
  enabledActionIds?: readonly string[];
  snapshot: Snapshot | null;
  latestReceipt: ExecutionReceipt | null;
  latestReasonCode: string | null;
}>;

/**
 * Host-neutral integration identity. Any save/world/player binding remains
 * adapter-owned and is verified through GameIntegrationAdapter.
 */
type IntegrationScope = Readonly<{
  integrationId: string;
}>;

export interface GameConnection {
  readonly scope: IntegrationScope;
  /**
   * Host-owned liveness fence. Launchers set this false before closing on a
   * lifecycle loss; every adapter-owned action path must reject while false.
   * It prevents a stale tool closure from treating a former connection as live.
   */
  readonly executionGate?: Readonly<{ executable: boolean }>;
  readonly module: GameIntegrationAdapter;
  /** Adapter-owned opaque facts; Host core passes them back to the adapter. */
  readonly state: unknown;
  /** Optional adapter-owned advisory data mounted by the Host. */
  readonly knowledge?: unknown;
  /** Optional version binding owned by the selected integration. */
  readonly gameVersion?: string;
}

/**
 * Compatibility execution/state port used by the Stardew bridge adapter and
 * its existing tools. Generic Host code uses GameIntegrationAdapter methods
 * instead of importing Stardew registries or tool factories.
 */
export interface StardewBridgeConnection extends GameConnection {
  /** Stardew bridge-v1 compatibility scope; generic Host code uses IntegrationScope only. */
  readonly scope: StardewScope;
  readonly state: StardewBridgeConnectionState;
  /** Stardew compatibility data; generic Host code only sees opaque knowledge. */
  readonly knowledge?: KnowledgeBundle;
  /** Target integration version owned by Host configuration, never Agent input. */
  readonly gameVersion?: string;
  /** Compatibility execution methods remain adapter-owned and optional. */
  readonly execute?: (...args: any[]) => any;
  readonly cancel?: (...args: any[]) => any;
  /** Mod-owned read-only Navigation discovery; never a game action. */
  readonly navigationRead?: (request: NavigationReadRequest) => Promise<NavigationReadResult>;
}