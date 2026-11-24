/**
 * What a container owes a request it had already admitted: an ending.
 *
 * The shape this checks is the one no ordinary test writes. A request is admitted, it is parked
 * inside the container (the caller holds the release), and the container's teardown runs while it
 * is still there - a Chat lane switch, a store close, a Memory service rebuilt under a panel. When
 * the park is released the request must end in one of exactly two ways: it COMPLETES with its
 * value, or it is REFUSED in the container's own bounded vocabulary (the codes its `close()` /
 * unavailable / conflict paths publish). Anything else is the defect this exists for:
 *
 *  - a store-closed fault (`chat_thread_store_closed`, `ERR_INVALID_STATE`, a finalized statement,
 *    anything whose text says closed/sqlite/eio/enoent), which means the teardown closed something a
 *    request was inside;
 *  - a raw infrastructure error or a `status >= 500` payload reaching the caller instead of a code;
 *  - an unhandled rejection, which is a promise nobody awaited and therefore a caller told nothing;
 *  - a silent hang: the request never settles, so every caller behind it waits forever.
 *
 * It proves, therefore, one property per container: measured over a request the container itself
 * admitted, this teardown ends that request rather than abandoning it. The check cannot see whether
 * the request was correct before the teardown (the caller's own assertions do), cannot see a
 * teardown that defers its close behind a timer longer than one macrotask (the release happens one
 * macrotask after the teardown starts), and cannot see a request the container refused at admission
 * instead of parking it - that fails as `start_refused_at_admission` and is a scenario to rewrite,
 * not a finding.
 */
export class InFlightTeardownViolation extends Error {
  readonly code = "in_flight_teardown_violation" as const;
  readonly check: string;
  readonly finding: string;
  constructor(check: string, finding: string) {
    super(`in_flight_teardown_violation:${check}:${finding}`);
    this.name = "InFlightTeardownViolation";
    this.check = check;
    this.finding = finding;
  }
}

export type InFlightHandle = Readonly<{
  /** Called by `start` once the request is admitted: from here on it is in flight. */
  enter: () => void;
  /** Resolves when this check releases the park. Awaiting it is what parks the request. */
  released: Promise<void>;
}>;

export type InFlightTeardownCheck<T> = Readonly<{
  /** Names the container and the story; every finding is reported under this name. */
  name: string;
  /** Admits one request and parks it on `inFlight.released`, then finishes the request. */
  start: (inFlight: InFlightHandle) => Promise<T>;
  /** Runs while the request is parked: the container's own close path. */
  teardown: () => Promise<void>;
  /**
   * The container's own bounded refusals for a request it had already admitted - the codes its
   * close/unavailable/conflict paths publish. A refusal outside this list is not bounded and fails
   * the check, so the list stays as narrow as the container's real vocabulary.
   */
  refusals: readonly string[];
  /** How long the request may take to reach its park. */
  parkTimeoutMs?: number;
  /** How long the request and the teardown may take to settle once the park is released. */
  settleTimeoutMs?: number;
}>;

export type InFlightTeardownReading<T> = Readonly<{
  name: string;
  outcome: "completed" | "refused";
  /** The completed value, or `undefined` when the request was refused. */
  value: T | undefined;
  /** The refusal code, or `undefined` when the request completed. */
  refusal: string | undefined;
}>;

/** The store's own connections carry a 5 s `busy_timeout`; 30 s is a container that will not end. */
const DEFAULT_PARK_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 30_000;

/** A fault that says a resource was taken away from the request rather than answered. */
const TEARDOWN_FAULT = /closed|finali[sz]ed|sqlite|eio|enoent|econn|epipe|err_invalid_state/iu;

/**
 * Proves one container's in-flight-teardown property; see the file docblock for what it proves and
 * what it cannot.
 */
export async function withInFlightTeardownCheck<T>(
  check: InFlightTeardownCheck<T>,
): Promise<InFlightTeardownReading<T>> {
  const parkTimeoutMs = check.parkTimeoutMs ?? DEFAULT_PARK_TIMEOUT_MS;
  const settleTimeoutMs = check.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const unhandled: string[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(describe(reason));
  };
  process.on("unhandledRejection", onUnhandledRejection);

  const entered = deferred();
  const release = deferred();
  try {
    // Read through an accessor because the outcome arrives from a callback: a bare `let` or a field
    // would be narrowed to `undefined` by the compiler, and this check's whole job is what arrived.
    const recorded = holder<T>();
    const started = begin("start", () =>
      check.start(Object.freeze({ enter: entered.resolve, released: release.promise })),
    ).then((half) => {
      recorded.put(half);
      return half;
    });

    const admission = await bounded(
      Promise.race([entered.promise.then(() => "parked" as const), started.then(() => "ended" as const)]),
      parkTimeoutMs,
      check.name,
      "start",
    );
    if (admission === "ended") {
      throw new InFlightTeardownViolation(
        check.name,
        `start_refused_at_admission:${refusalOf(recorded.get())}:the request never reached the park, so nothing was in flight`,
      );
    }

    const teardownRun = begin("teardown", check.teardown);
    await macrotask();
    if (recorded.get() !== undefined) {
      throw new InFlightTeardownViolation(
        check.name,
        `start_ended_before_the_park_was_released:${refusalOf(recorded.get())}:nothing was inside the container when it closed`,
      );
    }

    release.resolve();
    await bounded(started, settleTimeoutMs, check.name, "start_after_release");
    const teardown = await bounded(teardownRun, settleTimeoutMs, check.name, "teardown");
    if (!teardown.ok) {
      throw new InFlightTeardownViolation(check.name, `teardown_threw:${describe(teardown.error)}`);
    }
    // An unhandled rejection is reported by the runtime on the tick after it happens, so the
    // listener is read only once the queue has had a turn.
    await macrotask();
    if (unhandled.length !== 0) {
      throw new InFlightTeardownViolation(check.name, `unhandled_rejection:${unhandled.join("|")}`);
    }

    const outcome = recorded.get();
    if (outcome === undefined) {
      throw new InFlightTeardownViolation(check.name, "silent_hang:the request ended without an outcome");
    }
    if (outcome.ok) {
      return Object.freeze({
        name: check.name,
        outcome: "completed" as const,
        value: outcome.value,
        refusal: undefined,
      });
    }
    const refusal = refusalToken(outcome.error);
    if (TEARDOWN_FAULT.test(describe(outcome.error))) {
      throw new InFlightTeardownViolation(
        check.name,
        `store_closed_error:${refusal}:the teardown took away what the request was inside`,
      );
    }
    if (statusOf(outcome.error) >= 500) {
      throw new InFlightTeardownViolation(check.name, `infrastructure_status_${statusOf(outcome.error)}:${refusal}`);
    }
    if (!check.refusals.includes(refusal)) {
      throw new InFlightTeardownViolation(
        check.name,
        `unbounded_refusal:${refusal}:not one of ${check.refusals.join(",") || "(none declared)"}`,
      );
    }
    return Object.freeze({
      name: check.name,
      outcome: "refused" as const,
      value: undefined,
      refusal,
    });
  } finally {
    release.resolve();
    process.off("unhandledRejection", onUnhandledRejection);
  }
}

type Half<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** One written-once outcome, read through a call so the compiler keeps its declared type. */
function holder<T>(): Readonly<{ get: () => Half<T> | undefined; put: (half: Half<T>) => void }> {
  let half: Half<T> | undefined;
  return Object.freeze({
    get: (): Half<T> | undefined => half,
    put: (next: Half<T>): void => {
      half = next;
    },
  });
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return Object.freeze({ promise, resolve });
}

function macrotask(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Invokes one half of the check; a synchronous throw becomes the same outcome shape as a rejection. */
function begin<T>(half: string, run: () => Promise<T>): Promise<Half<T>> {
  try {
    const started = run();
    if (started === null || typeof started !== "object" || typeof started.then !== "function") {
      return Promise.resolve(Object.freeze({ ok: false as const, error: new Error(`${half}_is_not_a_promise`) }));
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
      () => reject(new InFlightTeardownViolation(check, `silent_hang:${label}_did_not_settle_within_${timeoutMs}ms`)),
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

function refusalOf(settled: Half<unknown> | undefined): string {
  if (settled === undefined) return "no_outcome";
  return settled.ok ? "completed" : refusalToken(settled.error);
}

/** The container's own code for a refusal: its `code` when it publishes one, else its message. */
function refusalToken(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length !== 0) return code.slice(0, 120);
  return describe(error);
}

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status;
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof statusCode === "number" ? statusCode : 0;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 200);
}
