/**
 * The coordinator's Player Host slot for the redacted role lifecycle view, and the rule that
 * makes it a VIEW of one state rather than a second authority beside it.
 *
 * `game.state.read` (`game-browser/game-browser-state-provider.ts`) is the only consumer of
 * that view, and it derives `instance.status` from this slot.
 *
 * What went wrong before this rule was total: the coordinator knows things the facade's
 * process owner does not (whether a launch was requested, whether the attestation was
 * correlated, whether a failed attempt was settled), so this projection named the slot for
 * three of the coordinator's states and OVERRODE the facade for the rest. The override was
 * the defect, and it was invisible in the shape of the code: the coordinator never left
 * `awaiting_player_host_attestation`, so the override answered `awaiting_attestation` for the
 * rest of the process and `game.state.read` could only ever publish
 * `instance.status: "launching"`. The game ran; the browser was told a launch was in flight.
 *
 * So every state now answers, in a `Record` the compiler requires to be complete: adding a
 * state to `StardewGameLifecycleState` fails the build here until somebody says what the
 * browser should read for it. There is no `default`, no fall-through, and no state where the
 * facade's own reading is reached by not being mentioned.
 *
 * Two of them are deliberately "nothing owned": `staged` says a launch is authorized but no
 * process exists (`not_started`, which the browser reads as `none` beside the launch-readiness
 * generation), and the failed states say this lifecycle owns no running Player Host. The
 * facade's process-owner reading is a fact about the *process owner*, not about this attempt:
 * an activated-but-not-launched attempt holds an outstanding launch reservation, and passing
 * that through as `pending` would make `game.state.read` announce `launching` while no launch
 * was ever requested - the same class of defect, from the other direction.
 */

import type { StardewGameLifecycleState } from "./stardew-game-lifecycle-state.internal.js";
import type { StardewRoleLifecycleView } from "./stardew-role-lifecycle-facade.js";

type PlayerHostSlot = StardewRoleLifecycleView["playerHost"];

/**
 * A slot that is not a function of the state alone: whether THIS lifecycle ever asked the
 * Player Host to start. After a launch, the process is up and unattested whatever the
 * lifecycle is doing now - that is the fact an ordinary close deliberately preserves, and
 * flattening it to "nothing is running" would report a closed Host as owning no game while
 * the player's game is still running.
 */
const DEPENDS_ON_LAUNCH = "depends_on_launch" as const;

/**
 * ...and one state whose Player Host slot this lifecycle does not own at all: `inactive` is
 * "no attempt exists in this lifecycle", which says nothing about a game the player started
 * themselves or one an independent attachment flow observed. That reading belongs to the facade,
 * so this table DELEGATES it by name instead of guessing it - the difference between a declared
 * delegation and the old silent fall-through is the whole point of the table.
 */
const FACADE_OWNED = "facade_owned" as const;

/**
 * The one projection rule. Total over the lifecycle, so it is a view of that state and not a
 * competing reading of the process owner beside it.
 */
type SlotDeclaration = PlayerHostSlot | typeof DEPENDS_ON_LAUNCH | typeof FACADE_OWNED;

const PLAYER_HOST_SLOT: Readonly<Record<StardewGameLifecycleState, SlotDeclaration>> = Object.freeze({
  // No attempt exists in this lifecycle, so the process owner / attachment flow is the authority
  // for what the player's game is doing.
  inactive: FACADE_OWNED,
  // The owned Player Host is being reserved and staged: an outstanding launch reservation
  // exists from the moment `reserving` succeeds, so the reservation IS the published fact.
  reserving: Object.freeze({ state: "pending", ownership: "gamebuddy_direct_spawn" }),
  staging: Object.freeze({ state: "pending", ownership: "gamebuddy_direct_spawn" }),
  // Activated and ready to launch: no Player Host process exists yet, so the composed slot
  // must not claim GameBuddy-owned launch activity.
  staged: Object.freeze({ state: "not_started", ownership: "none" }),
  launching_player_host: Object.freeze({ state: "pending", ownership: "gamebuddy_direct_spawn" }),
  awaiting_player_host_attestation: Object.freeze({
    state: "awaiting_attestation",
    ownership: "gamebuddy_direct_spawn",
  }),
  player_host_attested: Object.freeze({ state: "attested", ownership: "gamebuddy_direct_spawn" }),
  // Activation failed before a launch was asked for: no Player Host exists.
  activation_failed: Object.freeze({ state: "not_started", ownership: "none" }),
  // The launch may have started a process, so what the view says depends on whether it did.
  launch_quarantined: DEPENDS_ON_LAUNCH,
  // An ordinary close deliberately PRESERVES the Player Host (ADR-0007), so the slot must keep
  // saying the game is up whenever this lifecycle launched one.
  closing: DEPENDS_ON_LAUNCH,
  closed: DEPENDS_ON_LAUNCH,
});

/**
 * Coordinator-authoritative Player Host slot for the one lifecycle state.
 *
 * `playerHostLaunched` is this lifecycle's own fact - it asked the Player Host to start - and it
 * is read only by the states whose answer genuinely depends on it (the failed and shut-down
 * ones). Every other state answers from itself, which is what makes this a view of the state
 * rather than a second reading of the process owner.
 */
export function projectCoordinatorPlayerHostSlot(
  state: StardewGameLifecycleState,
  playerHostLaunched: boolean,
): PlayerHostSlot | undefined {
  const declared = PLAYER_HOST_SLOT[state];
  if (declared === FACADE_OWNED) return undefined;
  if (declared !== DEPENDS_ON_LAUNCH) return declared;
  return playerHostLaunched
    ? Object.freeze({ state: "awaiting_attestation", ownership: "gamebuddy_direct_spawn" })
    : Object.freeze({ state: "not_started", ownership: "none" });
}

/** Composes the coordinator-owned slot into the facade's redacted view. */
export function composeCoordinatorRoleLifecycleView(
  state: StardewGameLifecycleState,
  facadeView: StardewRoleLifecycleView,
  playerHostLaunched: boolean,
): StardewRoleLifecycleView {
  const playerHost = projectCoordinatorPlayerHostSlot(state, playerHostLaunched);
  // The one declared delegation returns the facade's own view unchanged: there is nothing of
  // this lifecycle to compose into it.
  if (playerHost === undefined) return facadeView;
  return Object.freeze({ schemaVersion: 1, playerHost, aiClient: facadeView.aiClient });
}
