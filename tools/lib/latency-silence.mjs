/**
 * How long a live run went without anything the player could observe.
 *
 * WHY THIS EXISTS: the world answers in about two frames (`execMs` median 37 ms) and the model round-trip is median
 * 3.4 s with p90 25 s, so the felt latency of this product is almost entirely SILENCE around a turn. The one property
 * we can enforce today (design/research/companion-latency-budget.md) is: every model wait must have an observable
 * event at least every 3 s - motion, a spoken line, a progress receipt - and no run may report a silent stretch
 * longer than 10 s.
 *
 * WHAT COUNTS AS OBSERVABLE, and what is only recorded:
 *
 *   presented_text   a companion line that landed in the game                     observable
 *   action_dispatch  the companion began doing something (motion starts)          observable
 *   action_settle    the world answered with a receipt                            observable
 *   heartbeat        the Mod's per-tick DEBUG line                                NOT observable: it proves
 *                    the game thread was alive, so it can ATTRIBUTE a silent stretch (`world_stalled`) but never
 *                    clears one - a 153 s think gap with heartbeats every 2 s is still 153 s of the player seeing
 *                    nothing.
 *   model turn       the companion thinking                                       NOT observable: the wait being
 *                    judged, not a signal
 *
 * Pure: every timestamp arrives as an argument on one absolute run clock, and nothing here reads a file. A stretch
 * that cannot be measured answers `null`, never 0 - an unmeasurable run must not read as a silent-free one.
 */
import { median } from "./action-cadence.mjs";

/** The operating rule: no model wait may go longer than this without an observable event. */
export const OBSERVABLE_EVENT_INTERVAL_MS = 3_000;

/** The absolute ceiling: a run reporting a longer silent stretch is unacceptable by the product budget. */
export const MAX_SILENT_STRETCH_MS = 10_000;

const OBSERVABLE_KINDS = new Set(["presented_text", "action_dispatch", "action_settle"]);

const isTime = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * The Mod's own heartbeat cadence, from the samples a caller actually recorded. Used only to decide whether a
 * heartbeat was EXPECTED inside a stretch; `null` when the run recorded fewer than two samples.
 */
function heartbeatIntervalMs(times) {
  if (times.length < 2) return null;
  const gaps = [];
  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index] - times[index - 1];
    if (gap > 0) gaps.push(gap);
  }
  return gaps.length === 0 ? null : median(gaps);
}

/**
 * Name the reason for one silent stretch. Precedence goes from the most specific fact to the weakest:
 *
 *   world_stalled          recorded heartbeats exist, none fell inside a stretch long enough to have missed two
 *   model_wait             a model turn covers the stretch, or the stretch ends at a dispatch (only the agent
 *                          produces a dispatch, so that interval WAS a model wait)
 *   world_action_wait      an action was dispatched before the stretch and still had no terminal when it ended
 *   between_observable_events  an observable event on both sides of the stretch
 *   no_observable_events   the run recorded nothing observable at all
 *   run_start / run_end    the stretch is the run's head or tail
 */
function classifyStretch({
  silentMs,
  startsWith,
  endsWith,
  observableEvents,
  actionSpans,
  heartbeatTimes,
  heartbeatInterval,
  modelTurns,
}) {
  const heartbeatsInside = heartbeatTimes.some((atMs) => atMs > startsWith.atMs && atMs < endsWith.atMs);
  if (heartbeatInterval !== null && !heartbeatsInside && silentMs >= heartbeatInterval * 2) {
    return "world_stalled";
  }
  if (modelTurns.some((turn) => turn.startedAtMs <= startsWith.atMs && turn.endedAtMs >= endsWith.atMs)) {
    return "model_wait";
  }
  const openAction = actionSpans.find(
    (span) =>
      span.dispatchedAtMs !== null &&
      span.dispatchedAtMs <= startsWith.atMs &&
      (span.settledAtMs === null || span.settledAtMs >= endsWith.atMs),
  );
  if (openAction !== undefined) return "world_action_wait";
  if (endsWith.kind === "action_dispatch") return "model_wait";
  if (observableEvents === 0) return "no_observable_events";
  if (OBSERVABLE_KINDS.has(startsWith.kind) && OBSERVABLE_KINDS.has(endsWith.kind)) {
    return "between_observable_events";
  }
  if (startsWith.kind === "run_start") return "run_start";
  if (endsWith.kind === "run_end") return "run_end";
  return "between_observable_events";
}

/**
 * The longest stretch of `[startedAtMs, endedAtMs]` with no observable event, from recorded inputs only.
 *
 * `presentedText`  [{ atMs }]                 absolute times of companion lines the player saw
 * `actions`        [{ action, dispatchedAtMs, settledAtMs }]  the run's action trace
 * `heartbeats`     [{ atMs }]                 Mod liveness samples, when the producer records them
 * `modelTurns`     [{ startedAtMs, endedAtMs }]  the waits being judged, when the producer records them
 *
 * Returns `{ longestSilentMs, fromMs, toMs, cause, events }`; `events` is every observable event that was counted.
 */
/** Every observable event in the inputs, plus the action spans the cause attribution needs. */
function collectEvents(presentedText, actions) {
  const events = [];
  for (const [index, piece] of (Array.isArray(presentedText) ? presentedText : []).entries()) {
    if (!isTime(piece?.atMs)) continue;
    events.push(Object.freeze({ atMs: piece.atMs, kind: "presented_text", label: `presented_text#${String(index)}` }));
  }
  const actionSpans = [];
  for (const [index, entry] of (Array.isArray(actions) ? actions : []).entries()) {
    const label =
      typeof entry?.action === "string" && entry.action.length > 0 ? entry.action : `action#${String(index)}`;
    const dispatchedAtMs = isTime(entry?.dispatchedAtMs) ? entry.dispatchedAtMs : null;
    const settledAtMs = isTime(entry?.settledAtMs) ? entry.settledAtMs : null;
    if (dispatchedAtMs !== null) {
      events.push(Object.freeze({ atMs: dispatchedAtMs, kind: "action_dispatch", label }));
    }
    // A terminal stamped before its own dispatch is not a usable anchor; the action is then reported as open.
    const usableSettle = settledAtMs !== null && (dispatchedAtMs === null || settledAtMs >= dispatchedAtMs);
    if (usableSettle) {
      events.push(Object.freeze({ atMs: settledAtMs, kind: "action_settle", label }));
    }
    actionSpans.push(Object.freeze({ label, dispatchedAtMs, settledAtMs: usableSettle ? settledAtMs : null }));
  }
  events.sort((left, right) => left.atMs - right.atMs);
  return { events, actionSpans };
}

/** The widest consecutive gap between anchors, or nulls when fewer than two anchors exist. */
function longestStretch(anchors) {
  let longestSilentMs = null;
  let startsWith = null;
  let endsWith = null;
  for (let index = 1; index < anchors.length; index += 1) {
    const gap = anchors[index].atMs - anchors[index - 1].atMs;
    if (gap < 0) continue;
    if (longestSilentMs !== null && gap <= longestSilentMs) continue;
    longestSilentMs = gap;
    startsWith = anchors[index - 1];
    endsWith = anchors[index];
  }
  return { longestSilentMs, startsWith, endsWith };
}

export function analyzeSilence({
  startedAtMs = null,
  endedAtMs = null,
  presentedText = [],
  actions = [],
  heartbeats = [],
  modelTurns = [],
} = {}) {
  const { events, actionSpans } = collectEvents(presentedText, actions);
  const heartbeatTimes = (Array.isArray(heartbeats) ? heartbeats : [])
    .filter((sample) => isTime(sample?.atMs))
    .map((sample) => sample.atMs)
    .sort((left, right) => left - right);
  const turns = (Array.isArray(modelTurns) ? modelTurns : []).filter(
    (turn) => isTime(turn?.startedAtMs) && isTime(turn?.endedAtMs) && turn.endedAtMs >= turn.startedAtMs,
  );

  const anchors = [];
  if (isTime(startedAtMs)) anchors.push(Object.freeze({ atMs: startedAtMs, kind: "run_start", label: "run_start" }));
  anchors.push(...events);
  if (isTime(endedAtMs)) anchors.push(Object.freeze({ atMs: endedAtMs, kind: "run_end", label: "run_end" }));
  anchors.sort((left, right) => left.atMs - right.atMs);

  const { longestSilentMs, startsWith, endsWith } = longestStretch(anchors);
  if (longestSilentMs === null) {
    return Object.freeze({
      longestSilentMs: null,
      fromMs: null,
      toMs: null,
      cause: "unmeasured",
      events: Object.freeze(events),
    });
  }

  const cause = classifyStretch({
    silentMs: longestSilentMs,
    startsWith: startsWith ?? { atMs: null, kind: "no_observable_event" },
    endsWith: endsWith ?? { atMs: null, kind: "no_observable_event" },
    observableEvents: events.length,
    actionSpans,
    heartbeatTimes,
    heartbeatInterval: heartbeatIntervalMs(heartbeatTimes),
    modelTurns: turns,
  });

  return Object.freeze({
    longestSilentMs,
    fromMs: startsWith?.atMs ?? null,
    toMs: endsWith?.atMs ?? null,
    cause,
    events: Object.freeze(events),
  });
}
