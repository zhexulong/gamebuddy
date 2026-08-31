import type { DbCacheEvent } from "./types";

const SEVERITY_RANK: Record<DbCacheEvent["severity"], number> = {
  full_bust: 6,
  bust: 5,
  warming: 4,
  warning: 3,
  stable: 2,
  info: 1,
  unknown: 0,
};

/**
 * Select the event that supplies a turn's summary severity and cause. Equal
 * severities intentionally favor the later event so the displayed cause
 * describes the newest equally-severe step.
 */
export function selectWorstCacheEvent(events: readonly DbCacheEvent[]): DbCacheEvent | undefined {
  let winner: DbCacheEvent | undefined;
  for (const event of events) {
    if (
      !winner ||
      SEVERITY_RANK[event.severity] > SEVERITY_RANK[winner.severity] ||
      (SEVERITY_RANK[event.severity] === SEVERITY_RANK[winner.severity] &&
        event.timestamp >= winner.timestamp)
    ) {
      winner = event;
    }
  }
  return winner;
}

// Map a cache-event severity to a bar/pill color class. Severity is the source
// of truth (computed cross-step in the backend); colors follow it directly.
export function severityColorClass(severity: string): string {
  switch (severity) {
    case "stable":
      return "green";
    case "warning":
      return "amber";
    case "bust":
    case "full_bust":
      return "red";
    case "info":
      return "blue";
    default:
      return "gray"; // unknown / warming
  }
}

const CACHE_CAUSE_LABELS: Record<string, string> = {
  mc_transform_failed_open: "Magic Context transform failed open",
  // Older dashboard backends may still emit this retired inference. It is not
  // evidence of a failed transform, so keep the legacy value non-alarming.
  mc_transform_missing: "No attribution recorded",
};

export function cacheCauseLabel(cause: string): string {
  return CACHE_CAUSE_LABELS[cause] ?? cause;
}

export function cacheCauseColor(cause: string): string {
  return cause === "mc_transform_failed_open" ? "red" : "amber";
}

export function cacheCauseTooltip(cause: string): string | undefined {
  return cause === "mc_transform_failed_open"
    ? "Magic Context recorded a transform error and returned the original messages for this pass."
    : undefined;
}

// Collapse ESTIMATED (max-prompt fallback) context limits to a single stable
// value per session, so the timeline doesn't fragment into one box per step.
//
// Why: when the plugin never recorded a real limit for a session (e.g. an
// untracked subagent worktree), the backend falls back to the session's
// max-prompt — but that's computed over whatever event batch reached it, so on
// the live incremental (since-based) fetch it CLIMBS as the session grows (85k →
// 86k → … → 95k). segmentByContextLimit then starts a new segment on every step.
//
// Fix: per session, take the MAX estimated limit across the rendered window and
// stamp it on every estimated event of that session. The window's largest prompt
// becomes the stable scale; bars read as a consistent fill instead of all ~100%.
// Recorded limits (context_limit_estimated=false) are left untouched, so a
// genuine mid-session model switch still segments correctly.
//
// Returns a new array (does not mutate the inputs); only estimated events are
// rewritten, and only their `context_limit`.
export function normalizeEstimatedContextLimits(events: DbCacheEvent[]): DbCacheEvent[] {
  const maxEstimatedBySession = new Map<string, number>();
  for (const e of events) {
    if (!e.context_limit_estimated) continue;
    const key = `${e.harness}:${e.session_id}`;
    const prev = maxEstimatedBySession.get(key) ?? 0;
    if (e.context_limit > prev) maxEstimatedBySession.set(key, e.context_limit);
  }
  if (maxEstimatedBySession.size === 0) return events;
  return events.map((e) => {
    if (!e.context_limit_estimated) return e;
    const stable = maxEstimatedBySession.get(`${e.harness}:${e.session_id}`) ?? e.context_limit;
    return stable === e.context_limit ? e : { ...e, context_limit: stable };
  });
}

// Context-scaled timeline-bar geometry:
//   outer height = prompt / context_window  (how full the window is)
//   inner segment = cache_read / prompt       (the cached, cheap portion)
//   overflow      = prompt exceeded the window (pinned at 100%)
export function ctxBarGeom(event: DbCacheEvent) {
  const prompt = event.cache_read + event.cache_write + event.input_tokens;
  const limit = event.context_limit > 0 ? event.context_limit : prompt;
  const outer = limit > 0 ? prompt / limit : 0;
  const inner = prompt > 0 ? event.cache_read / prompt : 0;
  return {
    prompt,
    limit,
    overflow: limit > 0 && prompt > limit,
    outerPct: Math.min(100, Math.max(2, outer * 100)),
    innerPct: Math.min(100, Math.max(0, inner * 100)),
  };
}

// Compact token label for axis ticks: 1_000_000 → "1M", 272_000 → "272k".
export function formatTokensShort(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 || Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}
