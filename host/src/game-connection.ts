import type { GameIntegrationAdapter } from "./game-integration-adapter.js";
import type { KnowledgeBundle } from "./knowledge.js";
import type {
  ActionRegistration,
  DataQueryRequest,
  DataQueryResult,
  ExecutionReceipt,
  FarmhandPolicyIdentity,
  NavigationReadRequest,
  NavigationReadResult,
  ObserveSceneRequest,
  ObserveSceneResult,
  Scope as StardewScope,
  Snapshot,
  TileAreaRequest,
  TileAreaResult,
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
  policyIdentity?: FarmhandPolicyIdentity;
  enabledActionIds?: readonly string[];
  /**
   * Why this Mod cannot honour an ActionProgram, when it says so on hello_ack. Published so the Host can project
   * the capability honestly: mounting the program tools while every submission is refused advertises something the
   * Mod cannot do (measured 2026-10-18: real submissions, every one refused `body_program_journal_unavailable`).
   * Absent means the Mod did not say, which is treated as available - the pre-existing behaviour.
   */
  bodyProgramUnavailableReason?: string | null;
  snapshot: Snapshot | null;
  latestReceipt: ExecutionReceipt | null;
  latestReasonCode: string | null;
  /**
   * THE LAST RECTANGLE THIS SESSION READ, beside the snapshot it read it against.
   *
   * <p>
   * A family row is only published inside the Mod's discovery radius (`ExecutionManager.TargetDiscoveryRadius`), so a
   * target outside it is in NO family - and the plan compiler read that silence as "measured, and empty". The one
   * reader that reaches such a tile is the rectangle query, and until this field existed its answer went to the model
   * and nowhere else: `TileAreaQuery.Answer` is stateless on the Mod side, and on this side `readRectangle` composed a
   * sentence with the rows. So a session could read a 3x20 strip and then be refused for planning on a tile of it.
   * </p>
   * <p>
   * OPTIONAL, because the state is built by every connection fixture in this repository and absent means this session
   * never asked. Only an ANSWERED rectangle is recorded, only the latest one is kept, and `reads` says how many this
   * session has made - which is what lets a refusal tell "the read you wrote this from" from "a read that replaced it".
   * </p>
   */
  tileRead?: StardewTileRead;
}>;

/**
 * One answered rectangle read, as the session keeps it: which tiles, what stood on them, and how many reads came
 * before.
 *
 * The row carries the coordinate and the occupant kind because that is the whole of what a plan target needs to be
 * proved: the id and the slot are not the reader's to mint - the Mod mints them at the moment it acts, or refuses.
 */
export type StardewTileRead = Readonly<{
  /** The map the rectangle was read on, or null when the Mod's answer did not state it. */
  location: string | null;
  /** The world revision it was read at. RECORDED, never compared: a stale read is a permission, not a promise. */
  revision: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** How many rectangle reads this session has made, this one included. Two means an earlier read's rows are gone. */
  reads: number;
  rows: readonly Readonly<{ x: number; y: number; occupantKind: string }>[];
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
  readonly gameVersion?: string | undefined;
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
  readonly knowledge?: KnowledgeBundle | undefined;
  /** Target integration version owned by Host configuration, never Agent input. */
  readonly gameVersion?: string | undefined;
  /** Compatibility execution methods remain adapter-owned and optional. */
  readonly execute?: (...args: any[]) => any;
  readonly cancel?: (...args: any[]) => any;
  /** Mod-owned fresh snapshot observation; the tool refreshes before reading so
   * cached state can never present a world the Agent already left. */
  readonly observe?: () => Promise<Snapshot>;
  /** Mod-owned read-only Navigation discovery; never a game action. */
  readonly navigationRead?: (request: NavigationReadRequest) => Promise<NavigationReadResult>;
  /** Mod-owned read-only content-table query; static game data, never a game action. */
  readonly dataQuery?: (request: DataQueryRequest) => Promise<DataQueryResult>;
  /** Mod-owned read-only rectangle query over the live world; a reading, never a game action. */
  readonly tileArea?: (request: TileAreaRequest) => Promise<TileAreaResult>;
  /** Mod-owned read-only live scene observation; scene refs never authorize mutation. */
  readonly observeScene?: (request: ObserveSceneRequest) => Promise<ObserveSceneResult>;
}
