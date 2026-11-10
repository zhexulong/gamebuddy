/**
 * When does a submitted plan stop being news?
 *
 * `stardew_action_program_status` used to answer that only by being polled, and `plan_work` returns immediately, so
 * a model that wanted to know had one option: ask again. Measured on the 2026-10-26 run, 48 calls at a p50 gap of
 * 6,365 ms and a max of 34,918 ms - each gap a whole model turn spent learning nothing.
 *
 * The facts a wait needs are already published, so this module adds no authority: it reads the same
 * `program_status` payload the tool already reads, and it never invents a finished state. On expiry the caller gets
 * the last real snapshot plus `reachedTerminal: false`. The one thing it now remembers is when it first saw each node
 * in its state (`createProgramProgressObserver`), because the wire carries no timestamp and a caller choosing its next
 * wait needs to know how long the node in front of it has been there.
 *
 * "It did not finish" alone is not an answer a caller can act on. The wait re-reads the live journal every interval
 * (`PROGRAM_STATUS_POLL_INTERVAL_MS`), so it already knows whether the journal published anything at all while it
 * held the turn. Measured 2026-10-28 (`round4`): 84 `program_status` calls blocked 459 s, seven of them the full 30 s
 * bound, and in six of those the snapshot handed back was identical to the one the caller already had - four
 * consecutive 30 s waits on `plan_273` all returned `eventHighWater: 288` with `n03` running. Reporting that
 * re-ask-would-tell-you-nothing fact is `snapshotChanged`.
 *
 * An unchanged snapshot is only that fact when nothing is executing. While an action runs, the snapshot it compares
 * cannot change by construction (see `NODE_STATES_IN_FLIGHT`), so silence there is the action working, not the plan
 * stalling - and returning early on it hands the caller a still-running plan it can only ask about again.
 *
 * ## Why the wait is informed, not shortened
 *
 * Measured 2026-11-02 over one 24-minute run: `stardew_action_program_status` was called 65 times for 281 s, the longest
 * single call spending its whole 30,000 ms bound (`round 7` was worse: 89 calls, 452 s). A fifth of that run sat inside
 * one read-only tool, and the plans were finishing - 66 programs of 290 nodes at 93% success. So the waste was the
 * polling, not the execution.
 *
 * The bound is not what was wrong with it. A wait returns the instant the plan settles, so a large bound costs nothing
 * when the plan finishes inside it; it costs only when the plan does not. What was wrong is that the result gave a
 * caller nothing to choose a bound FROM: a node list with states, and no statement of how much work was left or how
 * long the node in front of it had been in that state. With no basis, the only safe choice is the maximum, every time.
 *
 * That makes this (b) - return progress, not just state - rather than (a). `createProgramProgressObserver` publishes
 * `total`, `settled`, `remaining`, `running`, `queued` and the current node with the time the Host has watched it in
 * its state, so a second call is informed rather than blind. Two things are deliberately NOT done. Omitting `waitMs`
 * still means "one read and return": "what is the state now" is a different question from "wait for it", and a
 * blocking default would charge every cheap check for a wait it did not ask for. And the 30 s cap stays, because no
 * smaller cap can know when a plan genuinely needs longer - it would turn one wait into three with the caller learning
 * nothing in between.
 */

import { BODY_PROGRAM_NODE_STATE_VERDICTS, BODY_PROGRAM_NODE_STATES, bodyProgramNodeStateVerdict } from "./protocol.js";

/** The only non-terminal program state (`BodyProgramState`, `BodyProgramModels.cs:144`). */
const ACTIVE_PROGRAM_STATE = "active";

/**
 * How often a waiting call re-reads. The bridge round-trip this rides on is cheap; the cost being avoided is a model
 * turn between polls, not a network hop.
 */
const PROGRAM_STATUS_POLL_INTERVAL_MS = 250;

/**
 * The largest wait a caller may ask for.
 *
 * Bounded on purpose: a tool call that can block for as long as a caller names is a hang waiting to happen, and the
 * plan this waits on has its own action-scoped watchdogs. Thirty seconds covers a multi-node farm batch comfortably
 * and stays inside a single tool turn.
 */
export const MAX_PROGRAM_STATUS_WAIT_MS = 30_000;

/**
 * What the wait itself saw, BESIDE the payload it returned last.
 *
 * `reachedTerminal` is the one the wait was built for. `snapshotChanged` is what makes an expired wait actionable: a
 * caller told only "still running" cannot tell a long node from a plan that published nothing for thirty seconds, and
 * the measured answer to that is to ask again and pay the same bound once more.
 */
export interface ProgramStatusWaitOutcome<TResult> {
  readonly result: TResult;
  readonly waited: Readonly<{ reachedTerminal: boolean; snapshotChanged: boolean }>;
}

/**
 * The node states in which the Mod owes this plan a publication, so a still snapshot is not news.
 *
 * A node's state is the only part of the compared snapshot that moves during an action, and it moves exactly once per
 * transition (`BodyProgramNodeState`, `BodyProgramModels.cs:145`): `host_admitted` -> `running` -> a terminal state. So
 * from the moment a node is admitted until its terminal receipt the snapshot is not quiet, it is frozen.
 *
 * Measured 2026-10-31 over 83 runs and 2,674 dispatches (dispatch -> terminal receipt, joined by `requestId` on the
 * Mod's 60 Hz tick): `move_to_tile` p90 3,612 ms, `harvest_crop` p90 4,133 ms, `break_rock_source` p90 2,960 ms, and
 * 22% of all executions outlive the 2,000 ms `cb48fdac` waits. Treating that interval as silence is why 74% of waits
 * came back while the action was still running.
 *
 * `awaiting_host_admission` is deliberately NOT here: that state waits on the Host, and measured over 1,205 admissions
 * the Host answers in p90 200 ms, so two seconds of it is a stall the caller should be told about rather than a
 * dispatch whose receipt is owed.
 */
const NODE_STATES_IN_FLIGHT: ReadonlySet<string> = new Set(["host_admitted", "running"]);

/**
 * The node states with nothing left to run, DERIVED from the one declaration (`BODY_PROGRAM_NODE_STATE_VERDICTS`).
 *
 * Everything here has stopped for good, so counting one of them as outstanding work would overstate what waiting can
 * still deliver. `rejected` and `skipped_dependency` are the two a naive reader misses: a plan whose remaining nodes
 * depend on a rejected one is still `active`, and the Mod will never dispatch the node that was refused or the
 * descendants it skipped. `abandoned` is the ADR-006 state for a dispatch whose outcome can never be known - settled
 * ignorance, which the plan itself reports as `failed`.
 *
 * The membership is not written here: a state added to the declaration is settled or moving by its own verdict, and
 * "nothing left to run" and "owes a reason" cannot come apart.
 */
const NODE_STATES_SETTLED: ReadonlySet<string> = new Set(
  BODY_PROGRAM_NODE_STATES.filter((state) => BODY_PROGRAM_NODE_STATE_VERDICTS[state] !== "moving"),
);

/**
 * Is every action this snapshot shows finished, with nothing dispatched and unsettled?
 *
 * `true` means no publication is owed, so an unchanged snapshot is the actionable "asking again will say the same"
 * fact. `false` means the Mod is holding an execution whose terminal receipt is still to come.
 */
function hasNothingInFlight(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return true;
  const record = payload as Record<string, unknown>;
  const snapshot = record.snapshot;
  if (typeof snapshot !== "object" || snapshot === null) return true;
  const nodes = (snapshot as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return true;
  return !nodes.some(
    (node) =>
      typeof node === "object" &&
      node !== null &&
      NODE_STATES_IN_FLIGHT.has((node as Record<string, unknown>).state as string),
  );
}

/**
 * The work a `program_status` payload still has outstanding, and how long the node in front of it has been there.
 *
 * A node list with states is not an answer to "should I wait again": four nodes of which two are `pending` reads the
 * same as four nodes of which three settled while the caller was not looking. The counts make the remaining work
 * something the caller can decide from, and `current.observedInStateMs` says whether the node it would be waiting on is
 * behaving like a normal action (measured per-action p90s are seconds, not tens of seconds) or has stopped moving.
 */
export interface ProgramStatusProgress {
  readonly total: number;
  /** Nodes in a settled state (`NODE_STATES_SETTLED`): nothing more will happen to them. */
  readonly settled: number;
  /** `total - settled`: what the plan still has to get through, including the node executing now. */
  readonly remaining: number;
  /** Nodes dispatched with their receipt still owed (`host_admitted`, `running`). */
  readonly running: number;
  /** Nodes not started yet: `pending`, or waiting for this Host's admission. */
  readonly queued: number;
  /**
   * The node the plan is on now - the first one in flight, or the next one it will start when nothing is in flight.
   *
   * `observedInStateMs` is how long THIS HOST has continuously watched that node in that state, across calls, so `0`
   * means the state is new to this process and does not mean the node has done nothing.
   */
  readonly current: Readonly<{ nodeId: string; state: string; observedInStateMs: number }> | null;
  /**
   * Every node's own clock, in the order the journal listed them - the same reading `current` publishes, for each node.
   *
   * `current` answers "what is the plan waiting on"; this answers "how long has EACH step been where it is", which is
   * what a per-node answer needs and what one plan cannot have two of: `plan_work` and
   * `stardew_action_program_status` read their clocks from this one ledger, so a node cannot have one elapsed time in
   * one tool's answer and a different one in the other's.
   */
  readonly nodes: readonly ProgramNodeProgress[];
}

/** One node's state and how long this Host has watched it there. */
export interface ProgramNodeProgress {
  readonly nodeId: string;
  readonly state: string;
  readonly observedInStateMs: number;
}

/** How many plans the Host keeps a node clock for. A measured run submitted 66 programs in 24 minutes, so this is slack. */
const MAX_OBSERVED_PROGRAMS = 64;

/** How long an unread plan keeps its clock: longer than any action, shorter than a session, so ids cannot be inherited. */
const OBSERVATION_RETENTION_MS = 10 * 60_000;

/** One plan's node clocks: when the Host first saw each node in the state it is in now. */
type ObservedProgram = { nodes: Map<string, { state: string; since: number }>; lastSeen: number };

export interface ProgramProgressObserver {
  /** The progress a `program_status` payload describes, or `null` when that payload is not a found plan. */
  observe(payload: unknown, nowMs?: number): ProgramStatusProgress | null;
}

/**
 * A ledger of "when did this Host first see THIS node in THIS state", and the progress it makes answerable.
 *
 * The elapsed time cannot come off the wire: `BodyProgramNodeStatus` carries no timestamp (protocol.ts:1503) and the
 * Mod's own history is the event log, which a status read does not page. The Host is already reading these payloads,
 * so it times what it reads. That is observation, not authority: a node's clock restarts whenever its state changes,
 * nothing here can make a plan look finished, and a payload that is not `found` is answered with `null`.
 */
export function createProgramProgressObserver(): ProgramProgressObserver {
  const programs = new Map<string, ObservedProgram>();
  return Object.freeze({
    observe(payload: unknown, nowMs: number = Date.now()): ProgramStatusProgress | null {
      const plan = readPlanProgressSource(payload);
      if (plan === null) return null;
      // Keyed by the plan AND its STOP epoch: a STOP is a new epoch of the same id, whose nodes are about to be
      // cancelled and re-dispatched, so inheriting the previous epoch's clock would time work that no longer exists.
      const key = `${plan.programId}|${plan.stopEpoch}`;
      const anchors = new Map(programs.get(key)?.nodes ?? []);
      let settled = 0;
      let running = 0;
      let current: ProgramStatusProgress["current"] = null;
      let next: ProgramStatusProgress["current"] = null;
      const views: ProgramNodeProgress[] = [];
      for (const node of plan.nodes) {
        const anchor = anchors.get(node.nodeId);
        if (anchor === undefined || anchor.state !== node.state)
          anchors.set(node.nodeId, { state: node.state, since: nowMs });
        const view = Object.freeze({
          nodeId: node.nodeId,
          state: node.state,
          observedInStateMs: Math.max(0, nowMs - anchors.get(node.nodeId)!.since),
        });
        views.push(view);
        if (NODE_STATES_SETTLED.has(node.state)) settled += 1;
        else if (NODE_STATES_IN_FLIGHT.has(node.state)) {
          running += 1;
          if (current === null) current = view;
        } else if (next === null) next = view;
      }
      // A plan that has stopped keeps no clock: a later plan may reuse the id, and a stale anchor would report another
      // plan's work as this one's.
      if (plan.programId.length > 0 && plan.state === ACTIVE_PROGRAM_STATE)
        programs.set(key, { nodes: anchors, lastSeen: nowMs });
      else programs.delete(key);
      pruneObservations(programs, nowMs);
      const remaining = plan.nodes.length - settled;
      return Object.freeze({
        total: plan.nodes.length,
        settled,
        remaining,
        running,
        queued: remaining - running,
        current: current ?? next,
        nodes: Object.freeze(views),
      });
    },
  });
}

/**
 * The Host's own observation of the plans it reads.
 *
 * One per process on purpose: the number is about the plan, not about the call, so a node the previous call already
 * saw running has been running since then rather than since this one began.
 */
export const programStatusProgress: ProgramProgressObserver = createProgramProgressObserver();

/**
 * One node of a plan, answered where the caller wrote it: at its index, with the Mod's own state and reason.
 *
 * `state` is the Mod's node-state token VERBATIM (`BodyProgramNodeState` -> `BridgeSession.ToWire`), not a Host
 * translation. The four states a caller must be able to tell apart are `succeeded` (it did the thing, and its receipt
 * proved it), `rejected` (refused before it ran, `reasonCode` says why), `failed`/`cancelled` (it ran or was stopped
 * without succeeding, `reasonCode` is the action's own word), and the non-terminal `pending`,
 * `awaiting_host_admission`, `host_admitted`, `running`. Folding those into one "did not work" word would erase the
 * difference between a refusal and a cancellation, which is the difference between "fix the argument" and "you stopped
 * me".
 */
interface PlanNodeAnswer {
  /** The 0-based position among the nodes THIS plan carries, so a script can be read back positionally. */
  readonly index: number;
  readonly actionId: string;
  readonly state: string;
  /** `rejectionCode`, else `failureCode`: the Mod's own reason for a node that did not succeed. */
  readonly reasonCode?: string;
  /** Where to go instead, when the reason was that the target had no route. */
  readonly hint?: string;
  /**
   * WHY, in the Mod's own words - the receipt's evidence for a node that STOPPED WITHOUT SUCCEEDING, carried verbatim.
   *
   * Present only where a node ended short of its effect, and absent everywhere else, because the two absences mean
   * different things. A `pending` or `running` node has not ended, so it has nothing to explain and the field is not
   * there: measured `round42`, 100+ live rows answered `{"state":"pending","reasonDetail":"unknown_reason:pending"}`
   * against 159 pending, 400 succeeded, 47 failed and 22 rejected, which dressed every queued step as a defect and
   * buried the 69 rows that were one. A `succeeded` node proves its effect instead.
   *
   * Where it IS owed, a settlement that carried no reason answers `unknown_reason:<state>` rather than omitting the key,
   * so "the Mod had nothing more to say" and "the Host forgot to ask" cannot be the same answer.
   *
   * Never re-rendered and never summarised: `owner=Pierre;owner_tile=4,17;actor_tile=4,19;radius=1` is what the refusing
   * layer wrote, and a Host that reformatted it into prose would be a second author of a fact it did not observe.
   */
  readonly reasonDetail?: string;
  /** The tile the node acts on, when its arguments name one - the coordinate a refusal is read against. */
  readonly tile?: Readonly<{ x: number; y: number }>;
  /**
   * How long this Host has watched a node that has NOT stopped, in its current state.
   *
   * Absent on a terminal node: nothing is still being watched. Present on the rest, including a `pending` one, so
   * "running for twelve seconds" is a fact the caller can size against "queued for twelve seconds".
   */
  readonly elapsedMs?: number;
  /**
   * WHY a node was skipped, named: the producers this node waits on that stopped without succeeding.
   *
   * Present only on `skipped_dependency`, and only when the compiled graph names such a producer. `skipped_dependency`
   * is the one state that says nothing on its own - it is `skipped` because of ANOTHER node, and a caller told only the
   * token has to guess which step to fix. Measured 2026-11-09: 102 of 469 nodes over one run, where a single
   * `no_native_path` failure skipped 15 (`plan_1661`); a caller reading "15 skipped" without the name learns nothing
   * about the one tile to avoid.
   *
   * Absent is a fact too, and not the same one: the Mod also settles every never-attempted node as
   * `skipped_dependency` when a program is abandoned, and a skip whose producers are not in the graph (or are still
   * running) names nothing rather than guessing one.
   */
  readonly skippedBecause?: readonly Readonly<{ nodeId: string; reasonCode: string }>[];
}

/** A plan's per-node answer, and the batch statement that goes with it. */
export interface PlanBatchAnswer {
  readonly nodes: readonly PlanNodeAnswer[];
  /** True only when every node reached a terminal state. Never true of a batch that is still running. */
  readonly settled: boolean;
  /** Nodes with nothing terminal to report yet. `0` exactly when `settled`. */
  readonly remaining: number;
}

/**
 * The node a plan answer has to name, as the Host compiled it: the id the Mod's journal will carry it under, the
 * action, the arguments the caller wrote, and the nodes it waits on.
 *
 * `dependsOn` is the compiled graph's own CONSUMPTION edge (`body-program-script.ts` `emitPlanNode`), which is what
 * lets this answer say which producer a skip is owed to instead of only that it happened.
 */
export interface PlanAnswerNode {
  readonly nodeId: string;
  readonly actionId: string;
  readonly arguments: Readonly<Record<string, Readonly<{ type: string; canonicalValue?: string }>>>;
  readonly dependsOn?: readonly string[];
}

/**
 * The state a plan answers for a node the Mod's journal said nothing about.
 *
 * Not `pending`: a node the journal does not list has not been shown to be waiting, and reporting it as queued would be
 * the Host inventing progress. It is counted as remaining, so a batch with an unreadable node can never read as
 * settled.
 */
const PLAN_NODE_STATE_UNREADABLE = "unknown";

/**
 * What became of each node the caller wrote, joined on the identity the frame carries.
 *
 * <p>
 * THE JOIN IS THE NODE ID, and it has to be: `plan_work` compiles the ids itself (`n001`, `n002`, ... and
 * `n003_approach` for a walk the compiler inserts before a door), and the Mod's journal accepts the candidate's own ids
 * verbatim (`OpenBodyProgramJournalAuthority.Accept` -> `new VerifiedBodyProgramNode(node.NodeId, ...)`), so
 * `nodes[].nodeId` on the status snapshot is the same string the Host compiled. Nothing here reads array position, so
 * a snapshot that lists its nodes in another order - or a node the Mod re-attempts - cannot be reported against the
 * wrong step.
 * </p>
 * <p>
 * WHY THIS EXISTS AT ALL: measured in a companion's own session, `plan_work` answered `settled: false` for every batch,
 * which is a statement about the CALL and was read as one about the WORK. It re-submitted an identical `sleep({})`
 * three times in twenty seconds, its average batch fell 8.00 -> 5.04 -> 4.47 across one run, and one `sleep` refused
 * with `actor_held_by_modal` was only discovered from a later fact batch. The states were always in the journal; what
 * was missing was this projection.
 * </p>
 */
export function planBatchAnswer(
  compiled: readonly PlanAnswerNode[],
  snapshot: unknown,
  clocks: readonly ProgramNodeProgress[] = [],
): PlanBatchAnswer {
  const journal = new Map(readPlanJournalNodes(snapshot).map((node) => [node.nodeId, node] as const));
  const elapsed = new Map(clocks.map((node) => [node.nodeId, node.observedInStateMs] as const));
  const nodes = compiled.map((node, index) => {
    const row = journal.get(node.nodeId);
    const state = row?.state ?? PLAN_NODE_STATE_UNREADABLE;
    const reasonCode = row?.rejectionCode ?? row?.failureCode ?? null;
    const hint = row?.hint ?? null;
    const reasonDetail = planNodeReasonDetail(state, row?.refusalDetail ?? null, row?.recoveryDiagnostic ?? null);
    const tile = planNodeTile(node.arguments);
    const clock = NODE_STATES_SETTLED.has(state) ? undefined : elapsed.get(node.nodeId);
    const skippedBecause = state === "skipped_dependency" ? producersThatSkipped(node.dependsOn, journal) : [];
    return Object.freeze({
      index,
      actionId: node.actionId,
      state,
      ...(reasonCode === null ? {} : { reasonCode }),
      ...(hint === null ? {} : { hint }),
      ...(reasonDetail === null ? {} : { reasonDetail }),
      ...(tile === undefined ? {} : { tile }),
      ...(clock === undefined ? {} : { elapsedMs: clock }),
      ...(skippedBecause.length === 0 ? {} : { skippedBecause }),
    });
  });
  const remaining = nodes.filter((node) => !NODE_STATES_SETTLED.has(node.state)).length;
  return Object.freeze({ nodes: Object.freeze(nodes), settled: remaining === 0, remaining });
}

/**
 * WHY a node ended, as the row states it: the Mod's own detail, else the state it stopped in.
 *
 * <para>
 * The state's own verdict decides whether a reason is owed at all (`BODY_PROGRAM_NODE_STATE_VERDICTS`), so `null` means
 * "nothing to explain" in exactly two cases: the node has not stopped (`pending`, `host_admitted`, `running`, and the
 * Host's own `unknown` for a node the journal does not list - none of them has ended, so none of them has a reason), or
 * it `succeeded`, where the receipt's effect is the answer. Everything the declaration calls `stopped_without_success`
 * answers a string. That is deliberate. `round41` measured the whole defect this closes: `shop_purchase` refused
 * `shop_counter_out_of_reach` six times while the Mod's receipt held
 * `owner=Pierre;owner_tile=4,17;actor_tile=4,19;radius=1`, the model read only the code, and it invented the world fact it
 * needed. Ninety-four `program_status` replies in that round carried no `evidence` and no `detail` at all.
 * </para>
 * <para>
 * `unknown_reason:<state>` is therefore the placeholder for "this node ENDED and the reason side of its frame is empty",
 * and where it is owed it must stay IMPOSSIBLE to omit: a row that simply dropped the key would be indistinguishable from
 * one whose refusal carried no detail, and the difference between "the Mod said nothing" and "there was nothing to say"
 * is the difference between a bug and a success. It never coexists with a real detail, because the two are arms of one
 * `??` chain. It is never owed by a node that has not ended: that row would report a settlement defect about a step that
 * is still queued, and `round42` shows it buries the rows that are real.
 * </para>
 * <para>
 * `recoveryDiagnostic` is consulted for the same reason: the journal's own `execution_uncertain` did not use to reach the
 * wire, so `recovery_required` would otherwise answer `unknown_reason:recovery_required` - a second lie about a state the
 * Mod had already explained.
 * </para>
 */
export function planNodeReasonDetail(
  state: string,
  refusalDetail: string | null,
  recoveryDiagnostic: string | null,
): string | null {
  if (bodyProgramNodeStateVerdict(state) !== "stopped_without_success") return null;
  return refusalDetail ?? recoveryDiagnostic ?? `unknown_reason:${state}`;
}

/**
 * The producers of a skipped node that stopped without succeeding, named with the reason each stopped.
 *
 * Derived from TWO facts the answer already holds - the compiled graph's edges and the Mod's own states - and from
 * nothing else: a producer is named only when the journal says it is settled and not `succeeded`, so a skip this graph
 * cannot explain stays unexplained instead of borrowing someone else's reason. A transitive skip (`c` depends on `b`,
 * `b` on `a`) names `b`, the node actually waited on, because `b` carries its own answer about `a`.
 */
function producersThatSkipped(
  dependsOn: readonly string[] | undefined,
  journal: ReadonlyMap<string, PlanJournalNode>,
): readonly Readonly<{ nodeId: string; reasonCode: string }>[] {
  if (dependsOn === undefined) return [];
  const named: { nodeId: string; reasonCode: string }[] = [];
  for (const producerId of dependsOn) {
    const producer = journal.get(producerId);
    if (producer === undefined || producer.state === "succeeded" || !NODE_STATES_SETTLED.has(producer.state)) continue;
    named.push(
      Object.freeze({
        nodeId: producerId,
        reasonCode: producer.rejectionCode ?? producer.failureCode ?? producer.state,
      }),
    );
  }
  return Object.freeze(named);
}

/** One journal row as a plan answer reads it: the Mod's state, and the reasons that may ride with it. */
type PlanJournalNode = Readonly<{
  nodeId: string;
  state: string;
  rejectionCode?: string | null;
  failureCode?: string | null;
  hint?: string | null;
  refusalDetail?: string | null;
  recoveryDiagnostic?: string | null;
}>;

/**
 * The node rows a status snapshot carries, read defensively for the same reason `readPlanProgressSource` is: this is
 * the shape of a frame from another process, and a row it cannot read is a row a plan answer must not guess at.
 */
function readPlanJournalNodes(snapshot: unknown): readonly PlanJournalNode[] {
  if (typeof snapshot !== "object" || snapshot === null) return [];
  const rows = (snapshot as Record<string, unknown>).nodes;
  if (!Array.isArray(rows)) return [];
  const nodes: PlanJournalNode[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const entry = row as Record<string, unknown>;
    if (typeof entry.nodeId !== "string" || typeof entry.state !== "string") continue;
    nodes.push(
      Object.freeze({
        nodeId: entry.nodeId,
        state: entry.state,
        rejectionCode: typeof entry.rejectionCode === "string" ? entry.rejectionCode : null,
        failureCode: typeof entry.failureCode === "string" ? entry.failureCode : null,
        hint: typeof entry.hint === "string" ? entry.hint : null,
        refusalDetail: typeof entry.refusalDetail === "string" ? entry.refusalDetail : null,
        recoveryDiagnostic: typeof entry.recoveryDiagnostic === "string" ? entry.recoveryDiagnostic : null,
      }),
    );
  }
  return nodes;
}

/**
 * The tile a node acts on, when its arguments name one as two integers.
 *
 * Read from the arguments the caller wrote rather than from the snapshot: the compile-time arguments are what the node
 * was submitted with, and the tile is the one fact that makes "node 3 failed at 61,18" sayable without matching an
 * execution id. Absent for the thirteen families whose rows carry no tile, and for an action that names none.
 */
function planNodeTile(arguments_: PlanAnswerNode["arguments"]): Readonly<{ x: number; y: number }> | undefined {
  const x = arguments_.x;
  const y = arguments_.y;
  if (x?.type !== "integer" || y?.type !== "integer") return undefined;
  if (x.canonicalValue === undefined || y.canonicalValue === undefined) return undefined;
  const xValue = Number(x.canonicalValue);
  const yValue = Number(y.canonicalValue);
  if (!Number.isSafeInteger(xValue) || !Number.isSafeInteger(yValue)) return undefined;
  return Object.freeze({ x: xValue, y: yValue });
}

/**
 * How many consecutive polls with an unchanged snapshot end a wait early.
 *
 * An expired wait is the expensive outcome, and it is usually the predictable one: measured 2026-10-30, a 32-minute run
 * issued **82 `program_status` calls with `waitMs` set, 2,084 s of requested waiting (34.7 min), and only 21 of them
 * (26%) reached a terminal state**. The model had learned to wait instead of polling and then treated the wait as work.
 *
 * The wait already knows whether anything happened - `snapshotChanged` is that fact - so spending the remaining bound
 * after several polls have seen nothing is spending the model's turn on news that cannot arrive. Two polls at the
 * 250 ms interval is half a second of ``no change`` while the caller's own bound may be thirty seconds.
 *
 * The interval, not the bound, is what makes this safe: the journal publishes a node event per game-thread action, so a
 * plan that is DOING anything differs within a second. A plan still waiting on its first admission can stay identical
 * for longer, which is why the threshold is not one poll - the admitting Mod answers within a frame or not at all.
 */
const UNCHANGED_POLLS_BEFORE_EARLY_RETURN = 8;

/**
 * Is this `program_status` payload finished?
 *
 * `active` is the only state that is still going. Everything else - `succeeded`, `failed`, `cancelled`,
 * `recovery_required`, `quarantined` - has stopped for good. `recovery_required` and `quarantined` especially: a plan
 * that will never run again is exactly what a waiting caller needs told, and treating it as "still running" is how a
 * poller waits for news that cannot come.
 *
 * `not_found` counts as finished for the same reason: there is no longer anything to wait for, and the answer does
 * not change by asking again. `invalid_input` does not - that is a caller error, not a plan state, and the read that
 * produced it will keep producing it, so the loop must not spin on it.
 */
export function isTerminalProgramStatus(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const record = payload as Record<string, unknown>;
  if (record.code === "not_found") return true;
  if (record.code !== "found") return false;
  const snapshot = record.snapshot;
  if (typeof snapshot !== "object" || snapshot === null) return false;
  return (snapshot as Record<string, unknown>).state !== ACTIVE_PROGRAM_STATE;
}

/**
 * Poll until the plan stops or the wait expires, then return the LAST read either way.
 *
 * `first` is the caller's own read, which it already made; the wait starts from it rather than repeating it, so a plan
 * that finished before the wait began costs nothing extra and every later comparison is against what the caller was
 * actually told.
 */
export async function waitForTerminalProgramStatus<TResult>(
  read: () => Promise<TResult>,
  first: TResult,
  waitMs: number,
  now: () => number = Date.now,
  sleep: (milliseconds: number) => Promise<void> = defaultSleep,
): Promise<ProgramStatusWaitOutcome<TResult>> {
  const bounded = Math.max(0, Math.min(MAX_PROGRAM_STATUS_WAIT_MS, Math.trunc(waitMs)));
  const deadline = now() + bounded;
  let previous = first;
  let snapshotChanged = false;
  let unchangedPolls = 0;
  const settle = (result: TResult, reachedTerminal: boolean) =>
    Object.freeze({ result, waited: Object.freeze({ reachedTerminal, snapshotChanged }) });
  // Every read passes through here, so the expiry read counts the same as any other: a plan that moved on the last
  // poll before the deadline is a plan that moved, and saying otherwise is the blindness this reports on.
  const readOnce = async (): Promise<TResult> => {
    const result = await read();
    if (programSnapshot(result) !== programSnapshot(previous)) {
      snapshotChanged = true;
      unchangedPolls = 0;
    } else if (hasNothingInFlight(result)) {
      // Only silence with nothing executing is the fact the caller cannot get by asking again. While an action is in
      // flight the next publication is guaranteed to be its terminal receipt, so this poll is not evidence of a stall
      // and must not spend the early return's allowance.
      unchangedPolls++;
    }
    previous = result;
    return result;
  };
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) return settle(await readOnce(), false);
    // Nothing has moved for a while: hand back what is known NOW rather than what will still be known at the deadline.
    // `snapshotChanged` tells the caller the same thing it would have told it thirty seconds later, and the run keeps
    // its turn. The read is fresh, so the caller never receives a stale payload for this decision.
    if (unchangedPolls >= UNCHANGED_POLLS_BEFORE_EARLY_RETURN) return settle(await readOnce(), false);
    await sleep(Math.min(remaining, PROGRAM_STATUS_POLL_INTERVAL_MS));
    const result = await readOnce();
    if (isTerminalProgramStatus(result)) return settle(result, true);
    if (now() >= deadline) return settle(result, false);
  }
}

/**
 * The part of a `program_status` payload that is about THIS program.
 *
 * `eventHighWater` is deliberately left out: it is the journal-wide cursor (`BodyProgramJournalState.EventHighWater`),
 * so another program's node would make two reads differ while this one stood still. What a caller waiting on one plan
 * needs is that plan's own state and nodes, compared textually - the Mod's serialization has a fixed field order, so
 * the Mod's value and this string are the same fact.
 */
function programSnapshot(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Record<string, unknown>;
  const snapshot = record.snapshot;
  if (typeof snapshot !== "object" || snapshot === null) return `${String(record.code)}|`;
  const program = snapshot as Record<string, unknown>;
  return `${String(record.code)}|${String(program.state)}|${JSON.stringify(program.nodes ?? null)}`;
}

/**
 * The part of a `program_status` payload the progress counts read: its own state and its nodes' states, and nothing else.
 *
 * Only a `found` payload describes a plan. `not_found` and `invalid_input` have no nodes to count, and answering them
 * with zeroes would read as "a plan with nothing left" - the one thing this must never say about a plan it did not read.
 */
function readPlanProgressSource(payload: unknown): {
  programId: string;
  stopEpoch: string;
  state: string;
  nodes: readonly Readonly<{ nodeId: string; state: string }>[];
} | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (record.code !== "found") return null;
  const snapshot = record.snapshot;
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const plan = snapshot as Record<string, unknown>;
  const nodes: { nodeId: string; state: string }[] = [];
  if (Array.isArray(plan.nodes))
    for (const node of plan.nodes) {
      if (typeof node !== "object" || node === null) continue;
      const entry = node as Record<string, unknown>;
      nodes.push({ nodeId: String(entry.nodeId ?? ""), state: String(entry.state ?? "") });
    }
  return {
    programId: String(plan.programId ?? ""),
    stopEpoch: String(plan.stopEpoch ?? ""),
    state: String(plan.state ?? ""),
    nodes,
  };
}

/** Drop clocks nobody will read again, oldest first, so a long session cannot grow this without bound. */
function pruneObservations(programs: Map<string, ObservedProgram>, nowMs: number): void {
  for (const [programId, entry] of programs)
    if (nowMs - entry.lastSeen > OBSERVATION_RETENTION_MS) programs.delete(programId);
  while (programs.size > MAX_OBSERVED_PROGRAMS) {
    let oldestId: string | undefined;
    let oldestSeen = Number.POSITIVE_INFINITY;
    for (const [programId, entry] of programs)
      if (entry.lastSeen < oldestSeen) {
        oldestSeen = entry.lastSeen;
        oldestId = programId;
      }
    if (oldestId === undefined) return;
    programs.delete(oldestId);
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
