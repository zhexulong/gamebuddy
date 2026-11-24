/**
 * What one revision means when two writers claim it in the same tick: exactly one of them wins,
 * the other is refused by the container's own bounded conflict, and the durable row afterwards is
 * ONE state - not a half-written one, and not a row left holding both writes.
 *
 * The shape this checks is the one sequential tests cannot reach. Every existing CAS test runs the
 * loser after the winner has already returned, so the loser is refused for the trivial reason that
 * its revision is old. Here both operations are invoked before either is awaited, so the container
 * decides the race itself, and what is asserted afterwards is what a player would see: one success,
 * one named conflict, and a row that says exactly one of the two things happened.
 *
 * It proves, therefore, one property per container: this pair of writes on one revision is settled
 * by the container rather than by whatever order the caller happened to use. It cannot see a race
 * between real threads - both operations run in one process, and the store's own transaction is
 * synchronous, so "at once" here means one tick - cannot judge the durable row beyond the
 * predicate the caller passes as `assertCoherent`, and cannot see a conflict the container hides by
 * retrying internally (that arrives as a success, and a success is counted as one). The HTTP status
 * a conflict reaches the browser as is not this seam's fact: the broker maps it (`problemFor` in
 * `reference-pipeline-dialogue-web.core.ts` and `tavern-management-dialogue-web.ts`), and its own
 * suite pins that mapping.
 */
export class ConcurrentCasViolation extends Error {
  readonly code = "concurrent_cas_violation" as const;
  readonly check: string;
  readonly finding: string;
  constructor(check: string, finding: string) {
    super(`concurrent_cas_violation:${check}:${finding}`);
    this.name = "ConcurrentCasViolation";
    this.check = check;
    this.finding = finding;
  }
}

export type ConcurrentCasCheck<TFirst, TSecond, TDurable> = Readonly<{
  /** Names the container and the two operations; every finding is reported under this name. */
  name: string;
  /** The revision both writers read and both claim. Printed in every finding. */
  expectedRevision: number;
  first: () => Promise<TFirst>;
  second: () => Promise<TSecond>;
  /** The container's own bounded conflict codes for a write that lost the CAS. */
  conflicts: readonly string[];
  /** Reads the durable row fresh, after both writers ended. */
  readDurable: () => Promise<TDurable>;
  /** Judges the durable row as one coherent state; it throws naming what it found. */
  assertCoherent: (durable: TDurable) => void;
  /** How long either writer, and the durable reread, may take. */
  settleTimeoutMs?: number;
}>;

export type ConcurrentCasReading<TDurable> = Readonly<{
  name: string;
  expectedRevision: number;
  winner: "first" | "second";
  conflict: string;
  durable: TDurable;
}>;

const DEFAULT_SETTLE_TIMEOUT_MS = 30_000;

/**
 * Proves one container's single-revision conflict property; see the file docblock for what it
 * proves and what it cannot.
 */
export async function withConcurrentCasCheck<TFirst, TSecond, TDurable>(
  check: ConcurrentCasCheck<TFirst, TSecond, TDurable>,
): Promise<ConcurrentCasReading<TDurable>> {
  const settleTimeoutMs = check.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  // Both writers are invoked before either is awaited: that is the race.
  const [first, second] = await bounded(
    Promise.all([attempt(check.first), attempt(check.second)] as const),
    settleTimeoutMs,
    check.name,
    "writers",
  );

  const outcomes = [
    Object.freeze({ label: "first" as const, outcome: first }),
    Object.freeze({ label: "second" as const, outcome: second }),
  ];
  const winners = outcomes.filter((entry) => entry.outcome.ok);
  const losers = outcomes.filter((entry) => !entry.outcome.ok);
  if (winners.length !== 1 || losers.length !== 1) {
    throw new ConcurrentCasViolation(
      check.name,
      `expected_exactly_one_winner_at_revision_${check.expectedRevision}:first=${describeOutcome(first)},second=${describeOutcome(second)}`,
    );
  }
  const winner = winners[0];
  const loser = losers[0];
  if (winner === undefined || loser === undefined) {
    throw new ConcurrentCasViolation(check.name, `expected_exactly_one_winner_at_revision_${check.expectedRevision}`);
  }
  const refusal = loser.outcome.ok ? "completed" : refusalToken(loser.outcome.error);
  if (!check.conflicts.includes(refusal)) {
    throw new ConcurrentCasViolation(
      check.name,
      `unbounded_conflict:${loser.label}_refused_with_${refusal}:not one of ${check.conflicts.join(",") || "(none declared)"}`,
    );
  }

  const durable = await bounded(check.readDurable(), settleTimeoutMs, check.name, "durable_reread");
  try {
    check.assertCoherent(durable);
  } catch (error) {
    throw new ConcurrentCasViolation(
      check.name,
      `incoherent_durable_state_after_${winner.label}_won_at_revision_${check.expectedRevision}:${describe(error)}`,
    );
  }
  return Object.freeze({
    name: check.name,
    expectedRevision: check.expectedRevision,
    winner: winner.label,
    conflict: refusal,
    durable,
  });
}

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** One writer's ending; a synchronous throw is the same shape as a rejection. */
function attempt<T>(run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    const started = run();
    if (started === null || typeof started !== "object" || typeof started.then !== "function") {
      return Promise.resolve(Object.freeze({ ok: false as const, error: new Error("writer_is_not_a_promise") }));
    }
    return Promise.resolve(started).then(
      (value) => Object.freeze({ ok: true as const, value }),
      (error: unknown) => Object.freeze({ ok: false as const, error }),
    );
  } catch (error) {
    return Promise.resolve(Object.freeze({ ok: false as const, error }));
  }
}

/** A promise that never settles is a caller waiting forever, so every wait is bounded by name. */
function bounded<T>(value: Promise<T>, timeoutMs: number, check: string, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ConcurrentCasViolation(check, `silent_hang:${label}_did_not_settle_within_${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    value.then(
      (resolved) => {
        clearTimeout(timer);
        resolve(resolved);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function describeOutcome(outcome: Attempt<unknown>): string {
  return outcome.ok ? "completed" : refusalToken(outcome.error);
}

/** The container's own code for a refusal: its `code` when it publishes one, else its message. */
function refusalToken(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length !== 0) return code.slice(0, 120);
  return describe(error);
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 200);
}
