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
 */

/** The one clock every span in a run is measured on: monotonic milliseconds. */
export type RunTraceClock = () => number;

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

export function createRunTrace(traceId: string, options: Readonly<{ now?: RunTraceClock }> = {}): RunTrace {
  if (typeof traceId !== "string" || traceId.length === 0) throw new Error("invalid_run_trace_id");
  const now = options.now ?? (() => performance.now());
  const spans: RunTraceSpan[] = [];
  let nextSpanId = 0;

  const begin = (name: string, attributes: RunTraceAttributes = {}, parentId: string | null = null) => {
    const spanId = `s${String(nextSpanId++)}`;
    const index = spans.length;
    spans.push(
      Object.freeze({
        traceId,
        spanId,
        parentId,
        name,
        startMs: now(),
        endMs: null,
        attributes: Object.freeze({ ...attributes }),
      }),
    );
    return Object.freeze({
      spanId,
      end(more?: RunTraceAttributes) {
        const span = spans[index]!;
        if (span.endMs !== null) return;
        spans[index] = Object.freeze({
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
    spans: () => Object.freeze([...spans]),
  });
}

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
  traceEvents: readonly ChromeTraceEvent[];
}>;

export function toChromeTrace(
  spans: readonly RunTraceSpan[],
  options: Readonly<{ pid?: number; tid?: number }> = {},
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
  return Object.freeze({ displayTimeUnit: "ms" as const, traceEvents: Object.freeze(traceEvents) });
}

/** Write one run's trace where a trace viewer (Perfetto, chrome://tracing) can open it directly. */
export async function writeRunTrace(file: string, spans: readonly RunTraceSpan[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(toChromeTrace(spans), null, 2)}\n`, "utf8");
}

/** The bounded failure name a span carries when its stage throws. */
export function describeTraceFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? text.slice(0, 200) : text;
}
