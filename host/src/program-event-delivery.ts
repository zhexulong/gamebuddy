/**
 * How far into the Mod's journal this Host had already been when it asked about a plan.
 *
 * <p>
 * A `program_status` answer is composed by the Mod from the journal state it publishes (the port call,
 * `local-stardew-bridge.ts:609`), while the same nodes' terminal events reach this Host by other routes:
 * `program_events` pages and the execution receipts on the pump (`host-service.ts:965`). The two can
 * disagree, and until this module nothing compared them - the answer was forwarded verbatim
 * (`continuity-semantic-game-runtime-materializer.ts:571-591`), so a snapshot composed before the journal
 * advanced was reported as an authoritative `state: "active"` even though the connection had already
 * delivered the events that settled the plan.
 * </p>
 * <p>
 * MEASURED 2026-11-09 (round41): a status reply carried `snapshot.programId=plan_739…`, `state: "active"`,
 * `eventHighWater: 626`, while that program's three nodes all reached `succeeded` at journal cursors
 * 625/629/633. `eventHighWater` is the journal-wide cursor at the moment the Mod composed the snapshot
 * (`BodyProgramJournalState.EventHighWater`), so it is MONOTONE in time: a snapshot that reports a lower
 * cursor than one this Host has already been handed is provably older than what it has already delivered.
 * That is the only comparison this ledger makes, and it invents no state of its own - a snapshot that keeps
 * up is passed through untouched.
 * </p>
 */

/** The cursor of a snapshot or an events page, or `null` when that answer carries none. */
function readEventHighWater(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const snapshot = record.snapshot;
  const candidates = [
    typeof snapshot === "object" && snapshot !== null
      ? (snapshot as Record<string, unknown>).eventHighWater
      : undefined,
    record.highWater,
  ];
  for (const candidate of candidates)
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) return candidate;
  return null;
}

/** The program a status payload is about, or `null` for an answer that names no plan. */
function readProgramId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const snapshot = record.snapshot;
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const programId = (snapshot as Record<string, unknown>).programId;
  return typeof programId === "string" && programId.length > 0 ? programId : null;
}

/**
 * Why one snapshot is older than what this Host already holds, in words a model can act on.
 *
 * `stale_snapshot:eventHighWater=626;delivered=633` names both numbers, because "stale" alone gives a caller
 * nothing to distinguish a journal that is behind from a plan that really is still running.
 */
export type ProgramSnapshotStaleness = Readonly<{
  code: string;
  eventHighWater: number;
  delivered: number;
}>;

export interface ProgramEventDeliveryLedger {
  /** Record the watermark a status payload was composed at, and answer the staleness of that same payload. */
  observeStatus(payload: unknown): ProgramSnapshotStaleness | null;
  /** Record the watermark an events page for `programId` was answered at. */
  observeEvents(programId: string, page: unknown): void;
  /** The newest watermark this Host has been handed for one program, or `null` when it has been handed none. */
  delivered(programId: string): number | null;
}

/**
 * One ledger per runtime, constructed where the program tools are: the watermark is what THIS session's connection
 * has been handed, and two Game runtimes in one process must not lend each other a cursor (program ids are chosen by the
 * model and repeat between sessions). `program-settlement-digest.ts`'s reporter is constructed in the same place for
 * the same reason.
 */
export function createProgramEventDeliveryLedger(): ProgramEventDeliveryLedger {
  const delivered = new Map<string, number>();
  const record = (programId: string, highWater: number): void => {
    const previous = delivered.get(programId);
    if (previous === undefined || highWater > previous) delivered.set(programId, highWater);
  };
  return Object.freeze({
    observeStatus(payload: unknown): ProgramSnapshotStaleness | null {
      const programId = readProgramId(payload);
      const highWater = readEventHighWater(payload);
      if (programId === null || highWater === null) return null;
      // Compared BEFORE recording, so a snapshot is never stale against itself.
      const alreadyDelivered = delivered.get(programId) ?? null;
      record(programId, highWater);
      if (alreadyDelivered === null || highWater >= alreadyDelivered) return null;
      return Object.freeze({
        code: `stale_snapshot:eventHighWater=${highWater};delivered=${alreadyDelivered}`,
        eventHighWater: highWater,
        delivered: alreadyDelivered,
      });
    },
    observeEvents(programId: string, page: unknown): void {
      if (programId.length === 0) return;
      const highWater = readEventHighWater(page);
      if (highWater !== null) record(programId, highWater);
    },
    delivered(programId: string): number | null {
      return delivered.get(programId) ?? null;
    },
  });
}
