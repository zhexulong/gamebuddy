import { RUN_WAIT_NAMES } from "./run-trace-budget.js";

/**
 * Measures the agent's own deciding time, and nothing else.
 *
 * `actionCadence.thinkMs` covers "a receipt settled, then no dispatch for a while" and labels that
 * thinking. It also contains the body being unavailable: a menu, a pass-out, a sleep lifecycle. One
 * median over that mixture is why a run could be described as "waiting 3.4s for the model" while 240
 * long gaps sat in the same bucket, and why 87 of them looked like an idle actor when the only logger
 * that could have said otherwise samples solely while the actor is blocked.
 *
 * This tracker measures the one interval it can actually see on the Host side - the last tool result of
 * a batch settling, to the next assistant message beginning - and reports nothing when that shape is not
 * present. It does not guess where a wait started from elsewhere in the run.
 */

type ModelWaitEvent = Readonly<{
  /** `message_start` / `message_end` for an assistant message; `tool_result` when a tool returns. */
  type: "message_start" | "message_end" | "tool_result";
  /** Present for message events; `assistant` opens and closes a turn. */
  role?: "assistant" | "user" | "tool" | string;
  /** Monotonic milliseconds, on the same clock the trace uses. */
  atMs: number;
}>;

type ModelWaitSpan = Readonly<{ name: string; startMs: number; endMs: number | null }>;

export type ModelWaitTracker = Readonly<{
  /** Feed one Pi event. Returns a completed span when this event closes a wait, else null. */
  observe(event: ModelWaitEvent): ModelWaitSpan | null;
  /** The currently open wait, or null. A run that froze mid-wait leaves one here. */
  openWait(): ModelWaitSpan | null;
}>;

export function createModelWaitTracker(): ModelWaitTracker {
  // When the most recent tool result settled. Cleared once a wait is measured from it, so one settle
  // cannot be counted twice.
  let settledAtMs: number | null = null;
  let open: ModelWaitSpan | null = null;

  return Object.freeze({
    observe(event: ModelWaitEvent): ModelWaitSpan | null {
      if (event.type === "tool_result") {
        settledAtMs = event.atMs;
        return null;
      }

      if (event.type === "message_start" && event.role !== "assistant") {
        // The player spoke (or a tool message opened): whatever settles next, this settle is no longer the
        // start of the model's wait. Leaving it in place made an inserted player turn, or a run left idle
        // overnight, accumulate as "the model was thinking" - measured on a run where a single assistant
        // message arrived hours after the last tool result.
        settledAtMs = null;
        return null;
      }

      if (event.type === "message_start" && event.role === "assistant") {
        if (settledAtMs === null) return null; // the player spoke: not the model's wait
        open = { name: RUN_WAIT_NAMES.model, startMs: settledAtMs, endMs: event.atMs };
        settledAtMs = null;
        const closed = open;
        open = null;
        return closed;
      }

      return null;
    },
    openWait(): ModelWaitSpan | null {
      return settledAtMs === null ? null : { name: RUN_WAIT_NAMES.model, startMs: settledAtMs, endMs: null };
    },
  });
}
