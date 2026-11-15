/**
 * The ONE declaration of the Game lifecycle: its states, the transitions between them,
 * and the few facts that hold *over* the graph (which state is the deliberate shutdown,
 * which states are the published targets, and which state - if any - has no egress).
 *
 * Why this module exists rather than a comment: the coordinator used to describe one
 * lifecycle four times over - an activation state string, a `launchTerminal` boolean
 * latched by two sites and cleared by none, a facade process-owner slot, and a projection
 * rule that OVERRODE that slot - and every consumer read a different one. The
 * player-visible reading was the one that could not advance: `game.instance.status` could
 * only ever answer `launching`, because the projection overrode the facade with an
 * attestation state the coordinator never left. A fifth hand-written reading (a graph
 * drawn beside the code) would have had the same problem, so the graph is not beside the
 * code: `transition()` in the coordinator refuses an edge this table does not declare.
 * The code cannot disagree with the graph; a wrong graph is a loud refusal at the site.
 *
 * The vocabulary is the coordinator's own lifecycle, not the browser contract's
 * `instance.status`: that word is a *projection* of one of these states, and
 * `game-browser/game-browser-state-provider.ts` is the only place that projection happens.
 */
export type StardewGameLifecycleState =
  /** No attempt exists in this lifecycle: the pre-activation shape. */
  | "inactive"
  /** Activation is consuming its admission and reserving the owned Player Host. */
  | "reserving"
  /** The owner exists and its profile is being staged. */
  | "staging"
  /** Activated and ready: nothing runs, and the launch gate is open. */
  | "staged"
  /** A Player Host launch is in flight. */
  | "launching_player_host"
  /** The launch returned and the session advertisement has not been correlated yet. */
  | "awaiting_player_host_attestation"
  /**
   * The Player Host is up and its advertisement correlated: the game exists and the
   * browser can read it. This attested state is what makes `instance.status: "running"`
   * reachable at all - it is the target this graph is checked against.
   */
  | "player_host_attested"
  /** Activation itself failed, before any Player Host launch was asked for. */
  | "activation_failed"
  /**
   * A launch failed and the attempt could NOT be settled: containment of the process it may
   * have started cannot be verified from inside this process, so the durable record is the
   * terminal `quarantined` one and keeps occupying the installation registration. This is
   * the state the old `launchTerminal` boolean was, and it has no egress yet - see
   * `STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS`.
   */
  | "launch_quarantined"
  /** A deliberate close is draining. */
  | "closing"
  /** The deliberate shutdown has finished. Terminal for the Host, by design. */
  | "closed";

/**
 * Every transition this lifecycle may take, declared once.
 *
 * Each edge is one the code really takes; `transition()` in
 * `stardew-production-lifecycle-coordinator.internal.ts` consults exactly this record and
 * refuses an undeclared successor by name, so this is not documentation beside the code
 * but the authority the code runs through.
 *
 * `closing` is reachable from every non-closed state, including the failed ones: a close
 * that has already begun must have a legal successor, so the deliberate shutdown is
 * declared rather than implied.
 */
const TRANSITIONS: Record<StardewGameLifecycleState, readonly StardewGameLifecycleState[]> = {
  inactive: ["reserving", "closing"],
  reserving: ["staging", "activation_failed", "closing"],
  staging: ["staged", "activation_failed", "closing"],
  staged: ["launching_player_host", "closing"],
  launching_player_host: [
    "awaiting_player_host_attestation",
    // A launch refused before it reached the child leaves the attempt exactly as it was,
    // so the same staged attempt can be launched again.
    "staged",
    "launch_quarantined",
    "closing",
  ],
  awaiting_player_host_attestation: ["player_host_attested", "launch_quarantined", "closing"],
  player_host_attested: ["closing"],
  // Deliberately absent: an edge out of either failed state. An attempt that failed cannot
  // be re-staged in place, and the authenticated operation that would abandon it (and, for
  // the quarantined shape, settle it) does not exist yet. Declaring the edge anyway would
  // make the graph agree with a capability the product does not have - see
  // `STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS`.
  activation_failed: ["closing"],
  launch_quarantined: ["closing"],
  closing: ["closed"],
  closed: [],
};

export const STARDEW_GAME_LIFECYCLE_TRANSITIONS: Readonly<
  Record<StardewGameLifecycleState, readonly StardewGameLifecycleState[]>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(TRANSITIONS).map(([state, successors]) => [state, Object.freeze([...successors])]),
  ) as Record<StardewGameLifecycleState, readonly StardewGameLifecycleState[]>,
);

/** Every state this module declares, derived from the transition table so the two cannot drift. */
export const STARDEW_GAME_LIFECYCLE_STATES: readonly StardewGameLifecycleState[] = Object.freeze(
  Object.keys(STARDEW_GAME_LIFECYCLE_TRANSITIONS) as StardewGameLifecycleState[],
);

/** The state a lifecycle starts in, and the state every reset returns it to. */
export const STARDEW_GAME_LIFECYCLE_INITIAL_STATE: StardewGameLifecycleState = "inactive";

/**
 * The Host's own deliberate shutdown. It is terminal, and that is the one terminality the
 * gate does not have to be excused from: the process is going away, so no state after it
 * exists to be reachable.
 *
 * It is a PHASE rather than one state because `closing` really is a distinct thing to be in:
 * a close that is draining is still inside the shutdown, and counting that as a separate trap
 * would report the shutdown twice.
 */
export const STARDEW_GAME_LIFECYCLE_DELIBERATE_SHUTDOWN: StardewGameLifecycleState = "closed";
export const STARDEW_GAME_LIFECYCLE_SHUTDOWN_STATES: readonly StardewGameLifecycleState[] = Object.freeze([
  "closing",
  "closed",
]);

/**
 * The published facts this graph must be able to produce, stated as assertions rather than
 * as a chain of code. `game.instance.status` is the browser's word; `running` is the one
 * the whole surface hangs off, and it is reachable exactly when the attested state is.
 */
export const STARDEW_GAME_LIFECYCLE_TARGETS: readonly Readonly<{
  state: StardewGameLifecycleState;
  published: string;
}>[] = Object.freeze([Object.freeze({ state: "player_host_attested", published: "game.instance.status: running" })]);

/**
 * The states with an incoming edge and no outgoing one, each with the reason its only exit is
 * outside this process.
 *
 * This is a declared property, not an allow-list of places the gate stops looking: a state
 * appears here only by naming the fact that would have to change for an edge to exist, and
 * the gate fails on an entry whose state has since gained an edge. `closed` is not listed -
 * it is the deliberate shutdown, not a trap.
 *
 * Both entries are the SAME defect seen twice, and neither is excused: a failed attempt has
 * no authenticated operation that abandons it. `launch_quarantined` needs containment and
 * settlement (so that the installation registration it occupies is released) and there is
 * no route for it; `activation_failed` needs its accepted admission released so a fresh
 * `lifecycle_activation` can be presented, and the reservation a failed activation may
 * already have made can occupy the same registration. This table is where the missing
 * egress is named until it exists.
 */
export const STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS: Readonly<Partial<Record<StardewGameLifecycleState, string>>> =
  Object.freeze({
    launch_quarantined:
      "Containment of the process the failed launch may have started cannot be verified from inside this process, so " +
      "the attempt's durable record is the terminal `quarantined` one and keeps occupying the installation " +
      "registration. Settlement is the only thing that releases that registration, and it advances the record from " +
      "a non-terminal predecessor (its first step requires `reserved`), so no operation in this process - and none " +
      "in a later one, because the record is durable - can release it. The egress is a missing capability, not a " +
      "product rule: an authenticated operation that contains and settles an attempt which never reached an " +
      "attested attachment. Until it exists, a quarantine is terminal for the installation.",
    activation_failed:
      "Activation failed before a Player Host launch was asked for. The accepted admission is retained (so a second " +
      "`lifecycle_activation` is refused with `stardew_lifecycle_activation_conflict`), and a reservation the failed " +
      "activation already made occupies the installation registration, which the next reservation refuses with " +
      "`stardew_bootstrap_registration_unavailable`. The egress is the same missing operation: an authenticated " +
      "reset that abandons the spent attempt.",
  });

/** Whether `from -> to` is a declared transition. */
export function hasGameLifecycleTransition(from: StardewGameLifecycleState, to: StardewGameLifecycleState): boolean {
  return STARDEW_GAME_LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** Whether this lifecycle has begun its deliberate shutdown. */
export function isGameLifecycleClosing(state: StardewGameLifecycleState): boolean {
  return state === "closing" || state === "closed";
}

/**
 * Whether a Player Host this lifecycle launched is up: either its advertisement is still
 * being correlated, or it has been attested. Both answer every operation that needs a
 * running Player Host (cabin handoff, create, headless launch); only the attested state
 * answers the ones that need the *correlated* host.
 */
export function isGameLifecyclePlayerHostUp(state: StardewGameLifecycleState): boolean {
  return state === "awaiting_player_host_attestation" || state === "player_host_attested";
}
