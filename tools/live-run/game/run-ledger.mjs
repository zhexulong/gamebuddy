/**
 * One clock, one ledger: every moment a run could be waiting on something, recorded in the same unit.
 *
 * The run of 2026-10-25 could not be attributed. `actionCadence` reported all three of its phases as zero, so
 * nothing split think from exec from idle; `acceptMs: 610_725` was the whole accept path, not the provider; and
 * `presentation` carried a first-text time whose boundary was incomplete. The auditor's verdict was that any
 * split was an upper bound, because the clocks did not agree and some of the moments were never recorded at all.
 *
 * The ledger answers one question - "during this span, what was the run waiting on?" - by recording BOUNDARIES
 * only. Each entry is an instant plus what changed there, and every entry is on the run's own monotonic clock, so
 * a difference between two entries is a duration rather than an inference.
 *
 * What it deliberately does not do: it does not decide which wait is "the model's". That is a judgement, it
 * belongs to the reader, and burying it here is how `thinkMs` came to mean three different things.
 */

/** The moments worth recording. A closed set: an unknown kind is a bug, not a new category. */
export const LEDGER_KINDS = Object.freeze([
  /** The run's own start: the zero this ledger is measured from. */
  "run.start",
  /** A prompt was handed to the provider. */
  "provider.request",
  /** The first byte or delta came back. The gap from `provider.request` is the provider's own latency. */
  "provider.first_token",
  /** The provider finished responding. */
  "provider.done",
  /** A tool call began (the agent is acting, not deciding). */
  "tool.start",
  /** A tool call settled - its result is now the agent's to read. */
  "tool.settled",
  /** A world action was dispatched to the Mod. */
  "world.dispatch",
  /** The Mod's receipt for that action settled. */
  "world.settled",
  /** The companion's text became visible to the player. */
  "present.visible",
  /** The run ended, for whatever reason. */
  "run.end",
]);

const KIND_SET = new Set(LEDGER_KINDS);

/**
 * An append-only ledger on one clock.
 *
 * `now` is injected so a test can drive it; the product passes the same monotonic reader the trace uses, which is
 * the whole point - two sources of time in one run is what made the previous measurement unusable.
 */
export function createLedger(options) {
  const clock = options?.now;
  if (typeof clock !== "function") throw new Error("ledger_needs_a_clock");

  const entries = [];
  let order = 0;

  const record = (kind, detail) => {
    if (!KIND_SET.has(kind)) throw new Error(`ledger_unknown_kind:${kind}`);
    const atMs = clock();
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error("ledger_clock_read_invalid");
    // Monotonic in ARRIVAL order, not in time: two entries can share a millisecond, and an ordering that dropped
    // one of them would hide the very race a reader is looking for.
    const entry = Object.freeze({
      seq: order++,
      kind,
      atMs,
      ...(detail === undefined ? {} : { detail: Object.freeze({ ...detail }) }),
    });
    entries.push(entry);
    return entry;
  };

  return Object.freeze({
    record,
    entries: () => Object.freeze([...entries]),
    /** The whole ledger, for the artifact. Frozen so a later append cannot rewrite what was published. */
    snapshot: () => Object.freeze({ clock: "run_monotonic", entries: Object.freeze([...entries]) }),
  });
}

/**
 * Durations between the boundaries of one kind-pair, in arrival order.
 *
 * A pair whose second half has not arrived yet is reported as `endMs: null` - an open wait, which is exactly the
 * shape a frozen run leaves and the one the old cadence could not express.
 */
export function ledgerSpans(entries, openKind, closeKind) {
  if (!KIND_SET.has(openKind) || !KIND_SET.has(closeKind)) throw new Error("ledger_unknown_kind");
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const spans = [];
  let open = null;
  for (const entry of sorted) {
    if (entry.kind === openKind) {
      open = entry;
      continue;
    }
    if (entry.kind !== closeKind || open === null) continue;
    spans.push(Object.freeze({ startMs: open.atMs, endMs: entry.atMs, durationMs: entry.atMs - open.atMs }));
    open = null;
  }
  if (open !== null) spans.push(Object.freeze({ startMs: open.atMs, endMs: null, durationMs: null }));
  return Object.freeze(spans);
}

/** Median and max over the closed spans only; an open span is counted separately rather than as zero. */
export function ledgerSummary(spans) {
  const closed = spans.filter((s) => s.endMs !== null).map((s) => s.durationMs);
  const open = spans.length - closed.length;
  if (closed.length === 0) return Object.freeze({ count: 0, open, medianMs: null, maxMs: null, sumMs: 0 });
  const sorted = [...closed].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
  return Object.freeze({
    count: sorted.length,
    open,
    medianMs,
    maxMs: sorted[sorted.length - 1],
    sumMs: sorted.reduce((total, value) => total + value, 0),
  });
}
