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
 * Three hard signals plus one recorded soft signal:
 *   - summary_too_long   : more than 120 characters after trimming
 *   - step_checklist     : a "first…then/and…" step-recital pattern
 *   - unobserved_event   : asserts a specific thing the world did in response
 *                          (e.g. an NPC rejoiced, reacted, or said something)
 *                          when the receipts carry no such event. A trace shows
 *                          the companion narrating "Jodi beamed and said dinner
 *                          was saved" while the offer receipt recorded
 *                          showed_response=false — i.e. no dialogue happened at
 *                          all. Inventing a reaction is a worse interaction
 *                          failure than being long, so it is a hard signal.
 *   - hasPlayerAddress   : mentions the player or asks a question (recorded,
 *                          not enforced — a companion may also just exclaim)
 * All hard signals must pass for the summary to be acceptable.
 */
export function assessCompanionInteraction(text, observedEvents = []) {
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
  // Asserting a specific in-world reaction that never happened. `observedEvents`
  // carries the event kinds the receipts actually prove (e.g. "npc_dialogue");
  // a narration of a concrete reaction without that evidence is fabrication.
  //
  // Parenthetical tone tags ((满意)/(softly)) are the companion's own delivery,
  // not a claim about the world, so they are stripped first. The reaction must
  // also be tied to a character subject within a short window - a bare emotional
  // word elsewhere in the sentence is not a claim that an NPC reacted.
  const withoutToneTags = trimmed
    .replace(/（[^）]{0,40}）/g, "")
    .replace(/\([^)]{0,40}\)/g, "")
    .replace(/\[[^\]]{0,40}\]/g, "");
  const subject = "(她|他|乔迪|Jodi|[A-Z][a-z]{2,}|npc|NPC)";
  const reaction = "(乐|笑|开心|高兴|点头|挥手|答应|满意|感动|惊|说|喊|叫|回话|嘟|夸奖|道谢|beamed|smiled|laughed|said|nodded|replied)";
  const claimsNpcReaction = new RegExp(`${subject}[^。；.!！?？]{0,12}${reaction}`).test(withoutToneTags);
  if (claimsNpcReaction && !observedEvents.includes("npc_dialogue")) {
    reasons.push("unobserved_event");
  }
  // Soft interaction signal: address the player or ask/turn the turn over.
  const hasPlayerAddress = /[？?]|你|咱们|我们|一起|好不好|想吃|要不要/.test(trimmed);

  return Object.freeze({
    passed: reasons.length === 0,
    reasons,
    metrics: Object.freeze({ ...metrics, hasPlayerAddress, claimedNpcReaction: claimsNpcReaction }),
  });
}