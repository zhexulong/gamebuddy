/**
 * What a plan DID, said once, without the companion having to ask.
 *
 * Measured 2026-11-07 over a 42-minute live run and 29 plan batches: every one of **114 node entries was
 * `state: "pending"`**, `succeeded`/`rejected` appeared zero times, `settled: true` never appeared, and
 * `stardew_action_program_status` was never answered successfully (0 tool results). The cause is not precision:
 * `planBatchAnswer` reads the journal at the moment of SUBMISSION, so the only states it can ever report are the ones
 * that existed then. The terminal states do reach the Mod's journal, and they do reach this Host as receipts, but
 * nothing carried them back as an answer the companion could read. It said so in its own words: 「让 plan_work 给回
 * 逐节点、带索引的终态……这不是精度问题，而是我缺少『我做过什么』的权威账本。」
 *
 * So the Host watches a program it submitted until the Mod's journal says it stopped, and then mints ONE fact: the
 * bounded, indexed, terminal ledger of that program - `programId`, the Mod's own `settledAtMs`, the node rows, and a
 * one-line summary. It enters the same event pump as every other fact, and it is an ORDINARY fact: a settlement is an
 * outcome, so it opens the next turn itself (`event-pump.ts:isHeldProgressFact` holds progress, never an outcome) and
 * it may open a presentation lease (`companion-loop.ts:opensPresentationLease`), because an outcome nobody was told
 * about does not exist.
 *
 * ITS IDENTITY IS ONE OPAQUE TOKEN, for the same reason every Host-minted salient fact carries one
 * (`companion-arrival-fact.ts`): it becomes the `sourceEventId` a Game turn presents under, and both the lease
 * (`isOpaqueSource`) and the Game lineage (`GameTurnLineageTracker.beginPlayerBatch`) accept only
 * `[A-Za-z0-9_-]{1,128}`. A `:` in it does not fail loudly - it makes the turn silent, which is how the round40 run
 * lost its answers to settled plans.
 *
 * WHAT IT IS NOT. It is not a second authority. The rows come from `planBatchAnswer` - the same reader, the same join
 * on `nodeId`, the same `PLAN_NODE_STATE_UNREADABLE` for a node the journal said nothing about - so the digest and the
 * tool answer cannot disagree. `settledAtMs` is the Mod's own `atMs` on the last journal event it appended for this
 * program (`BodyProgramJournalEvent.AtMs`, "the moment the Mod appended this event, on the process's monotonic clock"),
 * read by the caller that owns the port; when that read is impossible the field is `null` rather than the Host's wall
 * clock, because a Host stamp would measure the bridge instead of the game.
 *
 * ONCE. `createProgramSettlementReporter` claims a program id the first time it produces a digest for it, so a second
 * snapshot of the same settled program (a later status read, a resubmission answered `idempotent`, a second watch)
 * produces nothing. A program that has not reached a terminal state produces nothing either - that claim is never
 * made, so a still-running plan cannot burn its one digest.
 */

import type { WorldFact } from "./event-pump.js";
import { isTerminalProgramStatus, planBatchAnswer, type PlanAnswerNode } from "./program-status-wait.js";

/** The fact's own identity: the `semanticKind` the lease reads, and the one token it is filed under. Only this module mints it. */
export const PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND = "program_settled";

/** Who synthesised the fact. Not `stardew_mod`: the Mod never says this. */
export const PROGRAM_SETTLED_DIGEST_SOURCE = "host_game_session";

/**
 * How many node rows one digest carries.
 *
 * The wire's own node bound is 256 (`MAX_BODY_PROGRAM_NODES`) and `plan_work` caps a script at 16, so a plan that
 * exceeds this is ordinary rather than pathological. Twenty rows is roughly a full `plan_work` script plus the equip
 * steps it wrote, and what does not fit is COUNTED (`omitted`) instead of dropped silently: a caller that needs the
 * tail asks `stardew_action_program_status`, which is still the reader.
 */
export const MAX_SETTLED_DIGEST_NODES = 20;

/** How often a background watch re-reads. Slower than a turn-holding wait: this one is not on anybody's clock. */
export const PROGRAM_SETTLEMENT_WATCH_INTERVAL_MS = 1_000;

/**
 * How long a background watch follows one program.
 *
 * Generous on purpose - `advance_day` carries a 600 s watchdog of its own, and a watch that gives up before the Mod
 * does would lose the ledger for exactly the longest plans. Past this bound the watch stops without a digest: the
 * journal still holds the answer and `stardew_action_program_status` still reads it, so what is lost is the unprompted
 * delivery, not the fact.
 */
export const PROGRAM_SETTLEMENT_WATCH_MAX_MS = 15 * 60_000;

/** One node of a settled plan, in the shape `planBatchAnswer` answers with. */
export type SettledDigestNode = ReturnType<typeof planBatchAnswer>["nodes"][number];

/**
 * What ONE stopped program produced, as data: the aggregate, and the rows it is counted over.
 *
 * THE SAME OBJECT ANSWERS BOTH QUESTIONS. The settlement fact carries it (`programSettledDigest`), and a status poll on a
 * program that has stopped answers with the rendering the fact was minted from
 * (`createProgramSettlementReporter().settled`) - so the two cannot disagree about what happened, and a poll adds no
 * fact the unprompted delivery did not already carry. Measured `round43`: 29 of 96 assistant turns were status polls,
 * which is what an answer that needs a second question produces.
 *
 * `counts` is over the WHOLE plan even when `nodes` is bounded (`MAX_SETTLED_DIGEST_NODES`), so `omitted` never turns
 * the aggregate into a partial one. Every state is the Mod's own token (`BodyProgramNodeState`), never a Host
 * translation: `succeeded`, `rejected`, `failed`, `cancelled`, `recovery_required`, `abandoned`,
 * `skipped_dependency`, and the Host's own `unknown` for a node the journal did not list.
 *
 * Deliberately absent: `settledAtMs` and any clock. When the journal closed, and how long this Host watched a node in
 * its state, are facts about the READING; the fact carries the first beside this rendering, and nothing about the
 * outcome can come apart from the fact by measuring it twice.
 */
export interface SettledProgramAnswer {
  /** The population every count is over: the nodes this Host submitted, not the rows the journal happened to list. */
  readonly total: number;
  readonly counts: Readonly<Record<string, number>>;
  /** The one line a reader can take without parsing twenty rows: `.settledSummary`. */
  readonly summary: string;
  /** The rows, bounded; each carries its terminal state and, where the Mod said one, its own code. */
  readonly nodes: readonly SettledDigestNode[];
  /** How many rows did not fit. `0` for a plan inside the bound, and the counts above still cover them. */
  readonly omitted: number;
}

/**
 * The settled answer as data, from the answer both consumers already read (`planBatchAnswer`).
 *
 * Not a second projection: the rows are the batch answer's rows, unchanged, so `reasonCode`, `hint`, `tile`,
 * `reasonDetail` and `skippedBecause` arrive here exactly as `stardew_action_program_status` reports them.
 */
export function settledProgramAnswer(answer: ReturnType<typeof planBatchAnswer>): SettledProgramAnswer {
  const counts: Record<string, number> = {};
  for (const node of answer.nodes) counts[node.state] = (counts[node.state] ?? 0) + 1;
  const nodes = answer.nodes.slice(0, MAX_SETTLED_DIGEST_NODES);
  return Object.freeze({
    total: answer.nodes.length,
    counts: Object.freeze(counts),
    summary: settledSummary(counts, answer.nodes.length),
    nodes: Object.freeze(nodes),
    omitted: answer.nodes.length - nodes.length,
  });
}

export interface SettledDigestInput {
  readonly programId: string;
  /** The Mod's `atMs` on the last journal event it appended for this program, or `null` when it could not be read. */
  readonly settledAtMs: number | null;
  /** The nodes THIS Host submitted, in the order the caller wrote them (the join is `nodeId`, never position). */
  readonly compiled: readonly PlanAnswerNode[];
  /** A `BodyProgramStatusResult`: `{ code, snapshot }`, exactly what the port answers. */
  readonly status: unknown;
  /** When the Host composed the fact. Carried on the envelope only; the settlement time is the Mod's. */
  readonly nowMs?: number;
}

/**
 * The one settled-digest fact for a program that has stopped, or `undefined` when there is nothing to say.
 *
 * `undefined` means one of exactly two things, each named rather than guessed at: the program has not reached a
 * terminal state, or the journal no longer knows it (`not_found` has no rows to carry). A node the journal says nothing
 * about is NOT suppressed: it rides as `PLAN_NODE_STATE_UNREADABLE`, so one unreadable row cannot cost the other
 * twenty-five.
 */
export function programSettledDigest(input: SettledDigestInput): WorldFact | undefined {
  return settledProgramFact(input)?.fact;
}

/**
 * The fact AND the rendering it was built from, so the reporter can keep the one the poll answers with.
 *
 * One derivation, two consumers: the fact is what the pump delivers, the rendering is what a later status poll answers,
 * and neither can be a second reading of the journal.
 */
export function settledProgramFact(
  input: SettledDigestInput,
): Readonly<{ fact: WorldFact; answer: SettledProgramAnswer }> | undefined {
  if (typeof input.programId !== "string" || input.programId.length === 0) return undefined;
  if (input.compiled.length === 0) return undefined;
  if (!isTerminalProgramStatus(input.status)) return undefined;
  const snapshot = foundSnapshot(input.status);
  if (snapshot === null) return undefined;
  const answer = settledProgramAnswer(planBatchAnswer(input.compiled, snapshot));
  const fact = Object.freeze({
    source: PROGRAM_SETTLED_DIGEST_SOURCE,
    kind: "world_fact" as const,
    eventId: `program_settled_${input.programId}`,
    sourceEventId: `program_settled_${input.programId}`,
    correlationId: `program_settled_${input.programId}`,
    revision: 0,
    occurredAtMs: input.nowMs ?? Date.now(),
    semanticKind: PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND,
    payload: Object.freeze({
      kind: PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND,
      programId: input.programId,
      settledAtMs: input.settledAtMs,
      ...answer,
    }),
  });
  return Object.freeze({ fact, answer });
}

export interface ProgramSettlementReporter {
  /** Compose, and hand the digest to the pump, at most once per program id. */
  report(input: SettledDigestInput): WorldFact | undefined;
  /**
   * The rendering this reporter announced for a program, or `null` when it has not settled one by that id.
   *
   * This is what `stardew_action_program_status` answers a STOPPED program with: the ledger the fact was minted from,
   * not a second read and not a second projection, so a poll after the settlement cannot add a fact the settlement did
   * not carry. `null` is the honest answer for a program this runtime never settled - a rejected candidate, an id from
   * another session, or one whose watch expired - and the poll then reports the journal as it reads it.
   */
  settled(programId: string): SettledProgramAnswer | null;
}

/**
 * Exactly-once for the settled digest.
 *
 * The claim is taken only when a digest is actually produced, so a watch that reads the journal before the program
 * stopped leaves the program unclaimed. Held per runtime (this is constructed where the tools are), never globally:
 * two Game sessions must not share a ledger of what one of them did.
 *
 * The map IS the claim: one entry per settled program id, holding the rendering the fact was built from. It grows with
 * the number of programs ONE runtime settled - a measured run submitted 26 programs in 24 minutes - and is released with
 * the runtime, so there is no drain to miss. An id is minted from the snapshot revision and the node list
 * (`planProgramId`), so a later plan does not inherit an earlier plan's entry.
 */
export function createProgramSettlementReporter(announce: (fact: WorldFact) => void): ProgramSettlementReporter {
  const settled = new Map<string, SettledProgramAnswer>();
  return Object.freeze({
    report(input: SettledDigestInput): WorldFact | undefined {
      if (settled.has(input.programId)) return undefined;
      const composed = settledProgramFact(input);
      if (composed === undefined) return undefined;
      settled.set(input.programId, composed.answer);
      announce(composed.fact);
      return composed.fact;
    },
    settled(programId: string): SettledProgramAnswer | null {
      return settled.get(programId) ?? null;
    },
  });
}

/** How one watch ended. `expired` and `stopped` are losses of the DELIVERY only, and the caller names which. */
export type ProgramSettlementWatchOutcome = "settled" | "expired" | "stopped";

export interface ProgramSettlementWatchOptions {
  /** The journal read, the caller's own port call (so its validation and its progress ledger stay in one place). */
  readonly read: () => Promise<unknown>;
  /** Called ONCE with the terminal payload; it owns the digest and the exactly-once claim. */
  readonly onSettled: (status: unknown) => Promise<void>;
  /** False when the runtime behind the port has drained (a closer ran, a session closed). */
  readonly stillWatching?: () => boolean;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly intervalMs?: number;
  readonly maxMs?: number;
}

/**
 * Follow one submitted program until the Mod's journal says it stopped, then hand the payload to `onSettled`.
 *
 * Deliberately NOT `waitForTerminalProgramStatus`: that waiter returns early after a few unchanged polls because its
 * caller is holding a model turn and "nothing moved" is worth telling it. A background watch has no turn to give back,
 * so an early return there would stop following a plan that is merely queued - the one case where the ledger is still
 * owed. A read that throws ends the watch as `stopped`: the port is gone and no later poll can fix that.
 */
export async function watchProgramSettlement(
  options: ProgramSettlementWatchOptions,
): Promise<ProgramSettlementWatchOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const intervalMs = options.intervalMs ?? PROGRAM_SETTLEMENT_WATCH_INTERVAL_MS;
  const deadline = now() + (options.maxMs ?? PROGRAM_SETTLEMENT_WATCH_MAX_MS);
  for (;;) {
    let status: unknown;
    try {
      status = await options.read();
    } catch {
      return "stopped";
    }
    if (isTerminalProgramStatus(status)) {
      await options.onSettled(status);
      return "settled";
    }
    if (options.stillWatching?.() === false) return "stopped";
    if (now() >= deadline) return "expired";
    await sleep(intervalMs);
  }
}

/**
 * One line the model can read without parsing twenty rows: `12 of 14 done, 2 rejected`.
 *
 * `done` counts `succeeded` only - a `failed` node is not done. Every OTHER state is named with its own count in a fixed
 * order, so a run that cancelled two nodes and abandoned one cannot be summarised as "12 of 14 done" and read as two
 * silent losses. Built from the same `counts` the fact publishes, so the sentence and the numbers cannot disagree.
 */
export function settledSummary(counts: Readonly<Record<string, number>>, total: number): string {
  const parts = [`${counts.succeeded ?? 0} of ${total} done`];
  for (const state of SETTLED_DIGEST_SUMMARY_STATES)
    if ((counts[state] ?? 0) > 0) parts.push(`${counts[state]} ${state}`);
  return parts.join(", ");
}

/** The non-success states a summary names, in a fixed order so two runs read the same line two ways the same way. */
const SETTLED_DIGEST_SUMMARY_STATES: readonly string[] = Object.freeze([
  "rejected",
  "failed",
  "cancelled",
  "recovery_required",
  "abandoned",
  "skipped_dependency",
  "unknown",
]);

/** The journal snapshot of a `found` status payload, or `null` - a `not_found` program has no rows to digest. */
function foundSnapshot(status: unknown): Record<string, unknown> | null {
  if (typeof status !== "object" || status === null) return null;
  const record = status as Record<string, unknown>;
  if (record.code !== "found") return null;
  const snapshot = record.snapshot;
  return typeof snapshot === "object" && snapshot !== null ? (snapshot as Record<string, unknown>) : null;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
