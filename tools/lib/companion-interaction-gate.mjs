/**
 * Companion interaction gate for Game-surface spoken summaries.
 *
 * The Game surface already has native action channels (movement, emote,
 * face_direction), so a companion's spoken line must be SHORT and TO THE
 * PLAYER — never a checklist of what the companion just did. This follows the
 * RP-community consensus that characters should speak dialogue, not narrate
 * their own actions ("no narration, stage directions, lists, or artificial
 * structuring"; "end each response with a question" as the classic turnover
 * device).
 *
 * The gate is deliberately two hard signals plus one recorded soft signal:
 *   - summary_too_long : more than 120 characters after trimming
 *   - step_checklist   : a "first…then/and…" step-recital pattern
 *   - hasPlayerAddress : mentions the player or asks a question (recorded,
 *                        not enforced — a companion may also just exclaim)
 * Both hard signals must pass for the summary to be acceptable.
 */
export function assessCompanionInteraction(text) {
  const trimmed = String(text ?? "").trim();
  const metrics = { length: [...trimmed].length };
  if (trimmed.length === 0) {
    return Object.freeze({ passed: false, reasons: ["empty"], metrics });
  }

  const reasons = [];
  if (metrics.length > 120) reasons.push("summary_too_long");
  // "先翻松泥土，把种子种进土里，又拎着浇水壶给它浇了水" style recitals.
  // Also catches "先把…，再…" and "先…，然后…，接着…".
  if (/先[^。；!！?？]{1,60}(再|然后|接着|又)[^。；!！?？]{1,60}/.test(trimmed)) {
    reasons.push("step_checklist");
  }
  // Soft interaction signal: address the player or ask/turn the turn over.
  const hasPlayerAddress = /[？?]|你|咱们|我们|一起|好不好|想吃|要不要/.test(trimmed);

  return Object.freeze({
    passed: reasons.length === 0,
    reasons,
    metrics: Object.freeze({ ...metrics, hasPlayerAddress }),
  });
}