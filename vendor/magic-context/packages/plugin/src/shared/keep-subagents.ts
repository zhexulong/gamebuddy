/**
 * Debug / data-collection switch: when enabled, Magic Context does NOT delete
 * the child sessions it spawns for its own subagents (historian, dreamer,
 * sidekick, memory-migration, key-files, user-memory review, recomp).
 *
 * By default these child sessions are deleted on success (only FAILED ones are
 * kept for debugging). With `keep_subagents: true` ALL of them are retained, so
 * their full transcript — prompt, tool calls, token usage, model output — stays
 * inspectable in OpenCode's session store / the dashboard. Intended for
 * short-term data collection (e.g. profiling what the dreamer actually does)
 * before the dreamer v2 overhaul, NOT for steady-state use — kept sessions
 * accumulate in the host's session DB until manually cleared.
 *
 * Process-global, set once at boot from config (mirrors `harness.ts`). A
 * config change requires a restart to take effect. NEVER thread this through
 * per-call args — it's a coarse, boot-time debug toggle.
 */
let keepSubagents = false;

/** Set at plugin boot from `keep_subagents` config. */
export function setKeepSubagents(value: boolean): void {
    keepSubagents = value === true;
}

/** True when subagent child sessions should be retained (not deleted). */
export function shouldKeepSubagents(): boolean {
    return keepSubagents;
}

/** Test-only reset. Do NOT call from production paths. */
export function _resetKeepSubagentsForTesting(): void {
    keepSubagents = false;
}
