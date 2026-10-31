import { randomUUID } from "node:crypto";

import type { GameBrowserStateV1 } from "../game-browser-contract/index.js";
import {
  type CompanionSwitchRequest,
  createCompanionSwitchRequest,
  writeCompanionSwitchRequest,
} from "./companion-switch-request.js";
import type { CompanionDeletionTarget } from "./companion-deletion-service.js";

/**
 * Which companion this installation plays: the player's choice, recorded durably for the
 * launcher to apply at the next launch.
 *
 * **What a switch is not.** It is not a reload. The companion in play is the deployment
 * identity's `companionId`, the semantic authority's database is bound to that one principal,
 * and the launcher owns that identity (`desktop/GameBuddy.Desktop/DeploymentIdentity.cs`).
 * This service therefore does the one thing the Host may do: record the player's choice and
 * say honestly that it takes effect at the next start.
 *
 * **What a switch costs, said before it happens.** The chosen companion's conversations and
 * Memory are not deleted and not merged - they come back with her, because every one of them
 * lives under a path derived from her own identity key. What the player loses for the time
 * being is the OTHER companion's, exactly as the deletion refusal already states it. That is
 * why the surface may not present this as a free action, and why the service answers with the
 * companion it recorded rather than a bare acknowledgement.
 *
 * **Refusals, by name, and each one actionable.** A companion who is already in play is not a
 * switch. A handle that is not on this mount's roster names nothing this Host may activate.
 * And a running Game session refuses the switch outright: the Mod authorizes exactly the
 * companion the durable owner record names, the cabin is bound to her, and re-binding a live
 * session is a different operation this product does not have. Stopping the game first is a
 * step the player can actually take.
 */
export type CompanionActivationOutcome = Readonly<{
  /** The opaque handle the request recorded, so the surface can render exactly that row. */
  handle: string;
  /**
   * How this outcome came about. `recorded` is the only value on success and it is not a
   * boolean on purpose: there is no state in which the Host recorded a switch and failed to
   * say so, and none in which it switched without the launcher.
   */
  status: "recorded";
}>;

export type CompanionActivationService = Readonly<{
  /**
   * Records the choice and answers `null` for a handle this mount's roster never projected.
   *
   * `context.readGameState` is supplied by the caller PER REQUEST, and that is deliberate: the
   * Game state read needs the authenticated browser session (`csrfToken`,
   * `browserSessionExpiresAtMs`), which exists only for the request being served. A reader
   * captured when this service is constructed would read with a session that does not exist yet,
   * or with a stale one.
   *
   * When the mount HAS a Game authority but supplies no reader, the switch is refused rather
   * than allowed: a construction that cannot prove no game is running must not park the
   * authority root out from under a live session.
   */
  activate(
    handle: string,
    context?: Readonly<{ readGameState?: () => Promise<GameBrowserStateV1> }>,
  ): Promise<CompanionActivationOutcome | null>;
}>;

export function createCompanionActivationService(
  options: Readonly<{
    runtimeRoot: string;
    /**
     * The companion the deployment started with: the same fact the roster's `isCurrent` is
     * derived from. Injected rather than recomputed, because a second definition of "who is in
     * play" is how the surface and the request would come to disagree about whose conversation
     * is mounted.
     */
    currentCompanionId: string;
    /** The roster's own reverse map, exactly as the inspector and the avatar upload use it. */
    resolveCompanion(handle: string): Promise<Readonly<CompanionDeletionTarget & { name: string | null }> | null>;
    /**
     * Whether this mount serves a Game authority at all. A chat-only mount constructs none, so
     * no game session can be running there and the switch needs no game read.
     */
    gameAuthorityPresent: boolean;
  }>,
): CompanionActivationService {
  return Object.freeze({
    async activate(
      handle: string,
      context?: Readonly<{ readGameState?: () => Promise<GameBrowserStateV1> }>,
    ): Promise<CompanionActivationOutcome | null> {
      const companion = await options.resolveCompanion(handle);
      if (companion === null) return null;
      // The record's own validity is decided where the record is built: a request whose target
      // is the companion already in play is not a switch, and that refusal has ONE spelling
      // (`createCompanionSwitchRequest`) rather than one here and another there.
      //
      // Building it before the Game read is the ordering that matters: the cheapest, already-
      // known refusal happens before this Host asks any other surface a question, so a player
      // who clicked the row she is already playing never waits on a game-state projection.
      const request: CompanionSwitchRequest = createCompanionSwitchRequest({
        requestId: randomUUID(),
        expectedActiveCompanionId: options.currentCompanionId,
        targetCompanionId: companion.companionId,
        targetContinuityId: companion.continuityId,
      });
      // A running Game session refuses the switch: the Mod authorizes exactly one companion per
      // durable owner record, the cabin is bound to her, and re-binding a live session is a
      // different operation this product does not have. Stopping the game first is a step the
      // player can actually take.
      //
      // A mount that serves a Game authority but hands this call no reader cannot prove a game
      // is stopped, so it refuses for the same reason and with the same code: the alternative is
      // parking the authority root out from under a live session.
      const readGameState = context?.readGameState;
      if (readGameState !== undefined) {
        if (gameSessionOccupiesTheInstallation(await readGameState()))
          throw new Error("companion_switch_requires_no_session");
      } else if (options.gameAuthorityPresent) {
        throw new Error("companion_switch_requires_no_session");
      }
      await writeCompanionSwitchRequest(options.runtimeRoot, request);
      return Object.freeze({ handle, status: "recorded" as const });
    },
  });
}

/**
 * Whether a Game session occupies this installation right now.
 *
 * The classification is TOTAL over the connection union on purpose: every member is named
 * either occupying or free, with the reason, and `companion-activation-service.test.ts`
 * asserts that the two lists cover exactly the members the contract declares. That gate is
 * what makes a newly added connection state fail loudly here instead of silently defaulting
 * to "free" and permitting a switch under a live session.
 *
 * A running instance or a held attachment is occupying without asking about the connection:
 * the Mod authorizes exactly one companion per durable owner record and the cabin is bound to
 * her, and re-binding a live session is not an operation this product has.
 */
export function gameSessionOccupiesTheInstallation(state: GameBrowserStateV1): boolean {
  const game = state.game;
  if (game.instance.status === "running" || game.instance.status === "launching") return true;
  if (game.attachment.status === "attached" || game.attachment.status === "pending") return true;
  return (OCCUPYING_CONNECTION_STATUSES as ReadonlySet<string>).has(game.connectionStatus);
}

/**
 * The connection states in which a Game session stands behind this installation.
 *
 * The others, each for its own reason: `none` (no connection attempted), `discovering` (still
 * looking for the game), `compatibility_warning` and `awaiting_confirmation` (both are before
 * anything is launched or attached, so the player may still change their mind), and `failed`,
 * `disconnected`, `stopped` (the session is over, nothing is bound to a companion).
 *
 * `connected_idle` is occupying: the game is up and only the turn is idle, which is exactly
 * the state in which a player would think a switch is safe and in which it is not.
 */
const OCCUPYING_CONNECTION_STATUSES: ReadonlySet<string> = Object.freeze(
  new Set([
    "launch_pending",
    "attach_pending",
    "connecting",
    "connected_idle",
    "active",
    "stopping",
    "reconnecting",
    "syncing",
  ]),
);

/** The connection states this classification calls free. Listed so the totality gate can read it. */
export const NON_OCCUPYING_CONNECTION_STATUSES: readonly string[] = Object.freeze([
  "none",
  "discovering",
  "compatibility_warning",
  "awaiting_confirmation",
  "stopped",
  "failed",
  "disconnected",
]);

/** Every connection status this classification has a position on, for the totality gate. */
export function classifiedConnectionStatuses(): readonly string[] {
  return Object.freeze([...NON_OCCUPYING_CONNECTION_STATUSES, ...OCCUPYING_CONNECTION_STATUSES]);
}
