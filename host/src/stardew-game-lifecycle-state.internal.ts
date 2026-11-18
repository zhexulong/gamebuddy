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
  /**
   * Activation itself failed, before any Player Host launch was asked for. A refusal that
   * reserved nothing leaves nothing of the attempt behind, so it returns to `inactive`
   * instead of latching this surface into a state no press can leave; a refusal the
   * reservation outlived keeps `closing` as its only exit.
   */
  | "activation_failed"
  /**
   * A launch failed and the attempt could NOT be settled: containment of the process it may
   * have started cannot be verified from inside this process, so the durable record is the
   * terminal `quarantined` one and keeps occupying the installation registration. This is
   * the state the old `launchTerminal` boolean was, and its only exit is a proof kind this product does
   * not have - `never_spawned` - rather than a settlement: see
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
 *
 * `inactive` is reachable from the states an attempt is HANDED BACK from, and that edge is
 * the topology's own requirement rather than a convenience: settling an ended attempt returns
 * this lifecycle to a state in which the next attempt can be prepared, so "settled, ready
 * again" has to be expressible. A graph that could only go forward would make the hand-back
 * the one transition the code performs that it refuses by name.
 */
const TRANSITIONS: Record<StardewGameLifecycleState, readonly StardewGameLifecycleState[]> = {
  inactive: ["reserving", "closing"],
  reserving: ["staging", "activation_failed", "closing"],
  staging: ["staged", "activation_failed", "closing"],
  staged: [
    "launching_player_host",
    // Activation's own catch answers every failure from `reserving` onwards, and staging is
    // inside the guarded body: a refusal after the profile was staged is still an activation
    // that failed, and the graph says so rather than masking the real error behind a refusal of
    // the transition itself.
    "activation_failed",
    "closing",
  ],
  launching_player_host: [
    "awaiting_player_host_attestation",
    // A launch refused before it reached the child leaves the attempt exactly as it was,
    // so the same staged attempt can be launched again.
    "staged",
    "launch_quarantined",
    "closing",
  ],
  awaiting_player_host_attestation: ["player_host_attested", "launch_quarantined", "inactive", "closing"],
  player_host_attested: [
    "inactive",
    // The attestation can fail AFTER the host was attested: a create re-attests the exact owner
    // before it consumes it, and an owner whose session no longer correlates is an attempt whose
    // outcome nobody can prove any more - the same quarantine a failed launch gets, for the same
    // reason. Without this edge that refusal was swallowed by the create's own failure path and
    // the surface kept advertising `running` for a host it had just failed to attest.
    "launch_quarantined",
    "closing",
  ],
  // The one failed state with an egress, and the shape of it: a refusal that reserved nothing
  // abandons nothing, so it goes back to where a first attempt starts instead of latching the
  // surface. A failure the reservation outlived keeps `closing` alone, and a quarantine has no
  // egress of its own at all - the missing capability is a `never_spawned` proof of non-existence,
  // not a containment - see `STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS`.
  activation_failed: ["inactive", "closing"],
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
 * One entry is left, and it is the decision this table exists to make reviewable rather than
 * silent: a failed launch whose containment nobody observed has no egress inside this process.
 * `launch_quarantined` cannot be reached by settlement at all - an attempt the runtime never held
 * has nothing to contain, and one it did hold refuses the settlement's first transition (its entry
 * states both walls and the proof kind that would replace them). `activation_failed` used to be
 * listed beside it and is NOT any more: a refusal that reserved nothing abandons nothing, so it
 * returns to `inactive` and the next press asks again.
 */
export const STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS: Readonly<Partial<Record<StardewGameLifecycleState, string>>> =
  Object.freeze({
    launch_quarantined:
      "Settlement is not the way out, and this attempt cannot reach it. Containment is what settlement is: its entry " +
      "asks the contained runtime for this owner, and a launch that never reached that runtime has no runtime to " +
      "contain at all (`stardew_contained_runtime_for_owner_missing`) - there is nothing to settle, so settlement is " +
      "the wrong mechanism rather than an unavailable one. Where the launch DID reach the runtime, the settlement's " +
      "first durable transition is `arm`, which requires the `reserved` predecessor the quarantine has already " +
      "consumed: the engine refuses it (`stardew_bootstrap_owner_transition_invalid`), the record cannot advance, and " +
      "the registration stays occupied. The release half is not a way around either half of that: " +
      "`settleOwnedPlayerHostRegistrationAttempt` does accept a terminal record, `quarantined` included, but nothing " +
      "in this process mints a settlement proof for that revision - and minting one would free the installation " +
      "registration for a process whose containment was never observed, which is the exact incident this state exists " +
      "to record. The egress is therefore a different proof and not a later version of settlement: `never_spawned`, " +
      "that no runtime was ever created for this owner, releasing the registration on evidence of non-existence and " +
      "refusing wherever a runtime record exists (there settlement or the explicit endgame is the path). Until that " +
      "proof kind exists, a quarantine is terminal for the installation.",
  });

/**
 * Every transition site whose from-states the code's own flow does not state, and the states each
 * of them can run in.
 *
 * Three shapes need this. The HAND-BACK: `inactive` is not only the initial state, it is the state
 * an attempt ends INTO, because settling an ended attempt hands it back and the next press prepares
 * a new one - so "settled, ready again" has to be expressible, and this table is the code's claim
 * about where it happens. A transition inside a `catch` block, which runs at whatever state the
 * guarded body had reached. And any transition into a state `STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS`
 * names: a terminal nobody can leave, entered from a helper whose callers are the ones that know
 * where they were.
 *
 * The claim is checked, never trusted: `lifecycle-graph.6` reads the coordinator's
 * `transition(...)` call sites out of the source, requires every site of those shapes to be
 * attributed here, and every pair below to be a declared edge. A site the table does not
 * attribute fails loudly instead of passing by omission, and an entry whose site has gone fails
 * too.
 */
export const STARDEW_GAME_LIFECYCLE_SITE_TRANSITIONS: readonly Readonly<{
  site: string;
  target: StardewGameLifecycleState;
  from: readonly StardewGameLifecycleState[];
}>[] = Object.freeze([
  Object.freeze({
    // `settleEndedAttempt` hands back an attempt that is over: the Player Host the lifecycle
    // attested has gone, or an explicit endgame settled the attempt durably. Both shapes are the
    // ones that hold an owner and a proved ending.
    site: "settleEndedAttempt",
    target: "inactive",
    from: Object.freeze<StardewGameLifecycleState[]>(["awaiting_player_host_attestation", "player_host_attested"]),
  }),
  Object.freeze({
    // `runActivationAfterSettle` resets only a refusal that reserved nothing: nothing of that
    // attempt exists to hand back, so the surface goes back to where a first attempt starts.
    site: "runActivationAfterSettle",
    target: "inactive",
    from: Object.freeze<StardewGameLifecycleState[]>(["activation_failed"]),
  }),
  Object.freeze({
    // Activation's catch answers every failure from `reserving` onwards, and the guarded body
    // stages before it returns: the states below are what that body can leave behind, not only the
    // one it entered through.
    site: "runActivation",
    target: "activation_failed",
    from: Object.freeze<StardewGameLifecycleState[]>(["reserving", "staging", "staged"]),
  }),
  Object.freeze({
    // The launch's catch puts a launch that never reached the child back on the attempt it was
    // launched from, so that attempt can be launched again.
    site: "runPlayerHostLaunch",
    target: "staged",
    from: Object.freeze<StardewGameLifecycleState[]>(["launching_player_host"]),
  }),
  Object.freeze({
    // The quarantine, which is the one state with no egress at all, is entered from a HELPER that
    // every caller reaches through a failure: the launch's own catch, the attestation's catch, and
    // the create that re-attests an attested owner before consuming it. Its from-states are those
    // callers' states, and none of them is on the line the transition sits on.
    site: "failPlayerHostAttempt",
    target: "launch_quarantined",
    from: Object.freeze<StardewGameLifecycleState[]>([
      "launching_player_host",
      "awaiting_player_host_attestation",
      "player_host_attested",
    ]),
  }),
]);

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
