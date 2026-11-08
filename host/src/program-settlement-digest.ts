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
 * one-line summary. It enters the same event pump as every other fact, and it is a HELD fact (see
 * `event-pump.ts:isHeldProgressFact`), so it arrives in the model's next batch instead of minting a turn of its own: a
 * settlement is news for the next turn, not a reason to interrupt.
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

/** The fact's own identity, and the label the pump holds it under. Only this module mints it. */
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
  if (typeof input.programId !== "string" || input.programId.length === 0) return undefined;
  if (input.compiled.length === 0) return undefined;
  if (!isTerminalProgramStatus(input.status)) return undefined;
  const snapshot = foundSnapshot(input.status);
  if (snapshot === null) return undefined;
  const answer = planBatchAnswer(input.compiled, snapshot);
  const shown = answer.nodes.slice(0, MAX_SETTLED_DIGEST_NODES);
  const omitted = answer.nodes.length - shown.length;
  return Object.freeze({
    source: PROGRAM_SETTLED_DIGEST_SOURCE,
    kind: "world_fact" as const,
    eventId: `program_settled:${input.programId}`,
    sourceEventId: `program_settled:${input.programId}`,
    correlationId: `program_settled:${input.programId}`,
    revision: 0,
    occurredAtMs: input.nowMs ?? Date.now(),
    semanticKind: PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND,
    payload: Object.freeze({
      kind: PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND,
      programId: input.programId,
      settledAtMs: input.settledAtMs,
      summary: settledSummary(answer.nodes),
      nodes: Object.freeze(shown),
      ...(omitted > 0 ? { omitted } : {}),
    }),
  });
}

export interface ProgramSettlementReporter {
  /** Compose, and hand the digest to the pump, at most once per program id. */
  report(input: SettledDigestInput): WorldFact | undefined;
}

/**
 * Exactly-once for the settled digest.
 *
 * The claim is taken only when a digest is actually produced, so a watch that reads the journal before the program
 * stopped leaves the program unclaimed. Held per runtime (this is constructed where the tools are), never globally:
 * two Game sessions must not share a ledger of what one of them did.
 */
export function createProgramSettlementReporter(announce: (fact: WorldFact) => void): ProgramSettlementReporter {
  const settled = new Set<string>();
  return Object.freeze({
    report(input: SettledDigestInput): WorldFact | undefined {
      if (settled.has(input.programId)) return undefined;
      const fact = programSettledDigest(input);
      if (fact === undefined) return undefined;
      settled.add(input.programId);
      announce(fact);
      return fact;
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
 * `done` counts `succeeded` only - a `failed` node is not done. Every OTHER settled state is named with its own count
 * in a fixed order, so a run that cancelled two nodes and abandoned one cannot be summarised as "12 of 14 done" and
 * read as two silent losses.
 */
export function settledSummary(nodes: readonly { readonly state: string }[]): string {
  const counts = new Map<string, number>();
  let succeeded = 0;
  for (const node of nodes) {
    if (node.state === "succeeded") succeeded += 1;
    else counts.set(node.state, (counts.get(node.state) ?? 0) + 1);
  }
  const parts = [`${succeeded} of ${nodes.length} done`];
  for (const state of SETTLED_DIGEST_SUMMARY_STATES)
    if ((counts.get(state) ?? 0) > 0) parts.push(`${counts.get(state)} ${state}`);
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
