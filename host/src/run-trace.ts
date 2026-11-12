import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * One run's span recorder.
 *
 * WHY THIS EXISTS: a live run used to be measured by whatever stderr line or result field the last incident made
 * someone hand-add (`actionCadence`, `toolTiming`, `pieceAtMs`), each on its own clock, so answering "where did this
 * action's wall clock go?" cost a fresh run and a guess. Every stage of one action instead records a span here, on a
 * single monotonic clock, and one export turns the whole run into a Chrome-trace file any trace viewer reads.
 *
 * Deliberately tiny: a recorder, not a tracing platform. No sampler, exporter, or collector process.
 *
 * The export is REWRITTEN WHILE THE RUN LIVES, not only at close. A trace written as the last step of `close()` never
 * exists for the runs a trace is wanted for: the live runners write their evidence package before the runtime is torn
 * down, and a killed run is killed before `close()` is reached at all (measured 2026-11-11: the product's own file was
 * on disk for every graceful run and the manifest written beside it still said `product_did_not_flush_run_trace`).
 */

/** The one clock every span in a run is measured on: monotonic milliseconds. */
export type RunTraceClock = () => number;

/** The file a Game runtime's export lands in: beside the run manifest, and the slot the evidence bundle carries. */
export const RUN_TRACE_FILE_NAME = "run-trace.json";

/**
 * The span log is bounded, so a long run's export has a known ceiling instead of growing with the run.
 *
 * What evicts: the OLDEST SETTLED span, and only when a new span would exceed the cap. An open span is never evicted -
 * it is a stage the run is inside, and deleting it would hide the stuck stage this file exists to show. That makes the
 * cap a soft one by the number of spans open at one instant, which is the action in flight (single digits).
 */
export const RUN_TRACE_MAX_SPANS = 5_000;

/** How often the export on disk is rewritten while the run is live. Bounds what a hard kill can lose to one tick. */
export const RUN_TRACE_FLUSH_INTERVAL_MS = 5_000;

type RunTraceAttribute = string | number | boolean | null;
type RunTraceAttributes = Readonly<Record<string, RunTraceAttribute>>;

export type RunTraceSpan = Readonly<{
  traceId: string;
  spanId: string;
  parentId: string | null;
  name: string;
  /** Span start on the run clock (ms). */
  startMs: number;
  /** `null` while open: an interrupted stage stays visible in the export instead of disappearing. */
  endMs: number | null;
  attributes: RunTraceAttributes;
}>;

export type RunTraceSpanHandle = Readonly<{
  spanId: string;
  /** Idempotent: a second call is a no-op, so failure paths can close defensively without rewriting a span. */
  end(attributes?: RunTraceAttributes): void;
}>;

export type RunTrace = Readonly<{
  traceId: string;
  begin(name: string, attributes?: RunTraceAttributes, parentId?: string | null): RunTraceSpanHandle;
  /** Runs a body inside one span and closes it on return, rejection, or throw. */
  span<T>(
    name: string,
    attributes: RunTraceAttributes,
    body: (span: RunTraceSpanHandle) => T,
    parentId?: string | null,
  ): T;
  spans(): readonly RunTraceSpan[];
  /** Spans the cap forced out. Non-zero means the export is a window onto the run, not the whole of it. */
  dropped(): number;
}>;

/** The one action-path taxonomy, so a stage cannot be spelled two ways. */
export const RUN_SPAN_NAMES = Object.freeze({
  action: "action",
  admission: "admission",
  journalWrite: "journal.write",
  bridgeCall: "bridge.call",
  modExecute: "mod.execute",
  present: "present",
});

export function createRunTrace(
  traceId: string,
  options: Readonly<{ now?: RunTraceClock; maxSpans?: number }> = {},
): RunTrace {
  if (typeof traceId !== "string" || traceId.length === 0) throw new Error("invalid_run_trace_id");
  const now = options.now ?? (() => performance.now());
  const maxSpans = options.maxSpans ?? RUN_TRACE_MAX_SPANS;
  if (!Number.isSafeInteger(maxSpans) || maxSpans < 1) throw new Error("invalid_run_trace_max_spans");
  // A handle holds its own SLOT, never an array index: eviction shifts the array, and an index-keyed handle would then
  // close whichever span moved into that position.
  const slots: RunTraceSlot[] = [];
  let nextSpanId = 0;
  let dropped = 0;

  const evictOldestSettled = (): void => {
    const index = slots.findIndex((slot) => slot.span.endMs !== null);
    if (index < 0) return;
    slots.splice(index, 1)[0]!.dropped = true;
    dropped += 1;
  };

  const begin = (name: string, attributes: RunTraceAttributes = {}, parentId: string | null = null) => {
    const spanId = `s${String(nextSpanId++)}`;
    if (slots.length >= maxSpans) evictOldestSettled();
    const slot: RunTraceSlot = {
      dropped: false,
      span: Object.freeze({
        traceId,
        spanId,
        parentId,
        name,
        startMs: now(),
        endMs: null,
        attributes: Object.freeze({ ...attributes }),
      }),
    };
    slots.push(slot);
    return Object.freeze({
      spanId,
      end(more?: RunTraceAttributes) {
        if (slot.dropped) return;
        const span = slot.span;
        if (span.endMs !== null) return;
        slot.span = Object.freeze({
          ...span,
          endMs: Math.max(span.startMs, now()),
          attributes: Object.freeze({ ...span.attributes, ...more }),
        });
      },
    });
  };

  return Object.freeze({
    traceId,
    begin,
    span<T>(
      name: string,
      attributes: RunTraceAttributes,
      body: (span: RunTraceSpanHandle) => T,
      parentId: string | null = null,
    ): T {
      const handle = begin(name, attributes, parentId);
      let result: T;
      try {
        result = body(handle);
      } catch (error) {
        handle.end({ failed: describeTraceFailure(error) });
        throw error;
      }
      if (typeof (result as { then?: unknown } | null)?.then === "function") {
        return (result as Promise<T>).then(
          (value) => {
            handle.end();
            return value;
          },
          (error: unknown) => {
            handle.end({ failed: describeTraceFailure(error) });
            throw error;
          },
        ) as T;
      }
      handle.end();
      return result;
    },
    spans: () => Object.freeze(slots.map((slot) => slot.span)),
    dropped: () => dropped,
  });
}

type RunTraceSlot = { span: RunTraceSpan; dropped: boolean };

/**
 * One span as a Chrome-trace complete event. `ts`/`dur` are microseconds, which is what the Chrome trace format and
 * Perfetto both read; `pid`/`tid` only place the span on a track (a run is one process and one thread here).
 */
type ChromeTraceEvent = Readonly<{
  ph: "X";
  ts: number;
  dur: number;
  pid: number;
  tid: number;
  name: string;
  args: RunTraceAttributes;
}>;

export type ChromeTrace = Readonly<{
  displayTimeUnit: "ms";
  /** Spans the recorder's cap evicted, so a truncated export cannot be read as a short run. */
  droppedSpans: number;
  traceEvents: readonly ChromeTraceEvent[];
}>;

export function toChromeTrace(
  spans: readonly RunTraceSpan[],
  options: Readonly<{ pid?: number; tid?: number; droppedSpans?: number }> = {},
): ChromeTrace {
  const pid = options.pid ?? 1;
  const tid = options.tid ?? 1;
  const traceEvents = spans.map((span) => {
    const open = span.endMs === null;
    return Object.freeze({
      ph: "X" as const,
      ts: Math.round(span.startMs * 1000),
      dur: open ? 0 : Math.max(0, Math.round((span.endMs! - span.startMs) * 1000)),
      pid,
      tid,
      name: span.name,
      // An open span exports as zero-duration and says so, rather than pretending the stage finished.
      args: Object.freeze(open ? { ...span.attributes, open: true } : { ...span.attributes }),
    });
  });
  return Object.freeze({
    displayTimeUnit: "ms" as const,
    droppedSpans: options.droppedSpans ?? 0,
    traceEvents: Object.freeze(traceEvents),
  });
}

/** Write one run's trace where a trace viewer (Perfetto, chrome://tracing) can open it directly. */
export async function writeRunTrace(
  file: string,
  spans: readonly RunTraceSpan[],
  options: Readonly<{ droppedSpans?: number }> = {},
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(toChromeTrace(spans, options), null, 2)}\n`, "utf8");
}

export type RunTraceFile = Readonly<{
  file: string;
  /** Rewrite the export now; rejects with the last write's failure so a teardown cannot claim success. */
  flush(): Promise<void>;
  /** Stop the periodic rewrite and flush one last time. */
  stop(): Promise<void>;
}>;

/**
 * Keep one run's export on disk while the run is live.
 *
 * A trace written only at `close()` does not exist for a killed run - and a killed run is exactly the one whose trace is
 * wanted. So the export is rewritten on a fixed interval, and `stop()` writes the last version when the runtime is
 * disposed normally. Bounded by construction: the recorder caps its spans (`RUN_TRACE_MAX_SPANS`) and says how many it
 * evicted, so every rewrite is the same bounded size.
 *
 * Writes are serialized through one chain, so a slow disk produces a later write rather than two writes racing for the
 * same file.
 */
export function startRunTraceFile(
  file: string,
  trace: RunTrace,
  options: Readonly<{ intervalMs?: number }> = {},
): RunTraceFile {
  const intervalMs = options.intervalMs ?? RUN_TRACE_FLUSH_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error("invalid_run_trace_flush_interval");
  let lastFailure: unknown = null;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (): Promise<void> => {
    const spans = trace.spans();
    const droppedSpans = trace.dropped();
    const written = chain.then(
      () => writeRunTrace(file, spans, { droppedSpans }),
      () => writeRunTrace(file, spans, { droppedSpans }),
    );
    chain = written.then(
      () => undefined,
      (error: unknown) => {
        lastFailure = error;
      },
    );
    return written;
  };

  // The FIRST write happens now, not at the first tick: a run that dies inside its first interval still leaves a file
  // that says the runtime was up, instead of nothing at all.
  void enqueue().catch(() => undefined);
  const timer = setInterval(() => {
    void enqueue().catch(() => undefined);
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();

  const flush = async (): Promise<void> => {
    await enqueue().catch(() => undefined);
    if (lastFailure === null) return;
    const failure = lastFailure;
    lastFailure = null;
    throw failure;
  };

  return Object.freeze({
    file,
    flush,
    async stop(): Promise<void> {
      clearInterval(timer);
      await flush();
    },
  });
}

/** The bounded failure name a span carries when its stage throws. */
export function describeTraceFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? text.slice(0, 200) : text;
}
