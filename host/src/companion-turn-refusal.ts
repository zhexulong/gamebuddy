import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Magic Context's refusal entry (upstream v0.48.0, `pi-context-refusal.ts`).
 *
 * A pass that degrades and cannot replay the last good request is never sent unmanaged: the guard
 * appends this display-only entry — it is never part of the model's context — and calls `ctx.abort()`.
 * Pi would otherwise catch the handler's exception and continue with the unmodified, unreduced
 * messages. The abort is the CONSEQUENCE of the refusal, so without this entry the Host cannot tell a
 * refused turn from the player's own STOP.
 */
export const MAGIC_CONTEXT_REFUSED_TURN_ENTRY_TYPE = "magic-context-turn-refused";

/**
 * True only for Pi's own `appendEntry` of Magic Context's refusal entry. Pi emits `entry_appended` for
 * every custom entry (the coding surface's own bookkeeping among them), so matching the entry type is
 * what makes this a refusal rather than a foreign entry.
 */
export function isRefusedTurnEvent(event: AgentSessionEvent): boolean {
  if (event.type !== "entry_appended" || event.entry.type !== "custom") return false;
  return event.entry.customType === MAGIC_CONTEXT_REFUSED_TURN_ENTRY_TYPE;
}
