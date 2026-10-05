/**
 * Player-input admission for the live-run harness.
 *
 * The Host refuses a player message it cannot honestly deliver - while the
 * integration admission is revoked (an overflow or disconnect invalidated the
 * world view) or after the session closed - and it now says so instead of
 * returning silently (`PlayerInputDisposition` in host-service.ts).
 *
 * Measured on a real ladder-5 run (2026-10-05): the harness submitted its prompt
 * into a closed admission and could not tell. The void signature resolved in ~1s,
 * no snapshot was ever received (revision 0), no tool call or receipt followed,
 * and the artifact read like "the companion chose to do nothing" - which sent a
 * real investigation in the wrong direction.
 *
 * This helper makes the wait explicit: it submits, and while the Host answers
 * with a refusal it retries (bounded), because the refusal means NOTHING was
 * enqueued - a retry can never duplicate the player's turn. A THROWN error is not
 * a refusal and is never retried: that means the message was admitted and
 * delivery failed, which the caller must see.
 *
 * A `void`/`undefined` return is treated as accepted so legacy callers (and test
 * doubles) keep working.
 */

export const DEFAULT_ADMISSION_TIMEOUT_MS = 90_000;
export const DEFAULT_ADMISSION_POLL_MS = 500;

function isRefusal(value) {
  return value !== null && typeof value === "object" && value.accepted === false;
}

/**
 * Submit one player prompt and wait until the Host accepts it.
 *
 * @returns `accepted` plus the observed admissions: how many attempts were made,
 *          how long the wait took, every refusal reason code in order, and the
 *          final one. A refused result is NOT an error - the caller decides
 *          whether to treat it as a blocked run (it must never be reported as a
 *          quiet successful turn).
 */
export async function submitPlayerPrompt({
  accept,
  text,
  locale,
  timeoutMs = DEFAULT_ADMISSION_TIMEOUT_MS,
  pollMs = DEFAULT_ADMISSION_POLL_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof accept !== "function") throw new Error("player_input_accept_required");
  if (typeof text !== "string" || text.trim().length === 0) throw new Error("player_input_text_required");

  const startedAtMs = now();
  const refusals = [];
  let attempts = 0;
  for (;;) {
    attempts += 1;
    // A throw propagates: the message was admitted, delivery failed, and that is
    // a different fact from a refusal.
    const disposition = await accept(text, locale);
    if (!isRefusal(disposition)) {
      return Object.freeze({
        accepted: true,
        attempts,
        waitedMs: now() - startedAtMs,
        refusals: Object.freeze([...refusals]),
      });
    }
    const reasonCode = typeof disposition.reasonCode === "string" ? disposition.reasonCode : "player_input_refused";
    refusals.push(reasonCode);
    if (now() - startedAtMs >= timeoutMs) {
      return Object.freeze({
        accepted: false,
        attempts,
        waitedMs: now() - startedAtMs,
        refusals: Object.freeze([...refusals]),
        lastRefusal: reasonCode,
      });
    }
    await sleep(pollMs);
  }
}
