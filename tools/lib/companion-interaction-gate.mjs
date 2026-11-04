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
 * Hard signals plus one recorded soft signal:
 *   - summary_too_long   : more than 120 characters after trimming
 *   - self_tag_leak      : Magic Context's `§N§` prompt self-tag, which the model
 *                          mimics into its reply and the player must never see
 *   - machine_token_leak : machine wire identifiers (gift_given, quest_25_completed)
 *   - unobserved_event   : asserts a specific thing the world did in response
 *                          (e.g. an NPC rejoiced, reacted, or said something)
 *                          when the receipts carry no such event.
 *   - hasPlayerAddress   : mentions the player or asks a question (recorded,
 *                          not enforced — a companion may also just exclaim)
 *
 * NOTE (step_checklist decommissioned):
 * Downstream regex matching for procedural recitals (`step_checklist` / `先…再…`)
 * has been decommissioned. Heuristic parsing of comma-separated clauses caused persistent
 * false-positive errors on ordinary spoken Chinese (e.g. conditional clauses,
 * environmental pauses, incidental remarks). Invariant alignment against chore
 * checklists is owned upstream at the prompt and persona layer (identity-profile.ts
 * and card.json) where positive target templates guide conversational register.
 *
 * All hard signals must pass for the summary to be acceptable.
 *
 * CLAIM BOUNDARY: this is a high-precision, LOW-RECALL detector. The reaction
 * vocabulary is closed, so natural phrasings outside it pass silently — a probe
 * with 16 ordinary Chinese NPC-reaction lines still missed 7 (e.g. 「她哼了一声」
 * 「她微微一愣」「她的神情缓和了」). Treat a pass as "no KNOWN-class breach",
 * never as "the line matches the world state". Widening recall needs a
 * non-vocabulary mechanism, which is a separate design.
 */

export function assessCompanionInteraction(text, observedEvents = []) {
  const trimmed = String(text ?? "").trim();
  const metrics = { length: [...trimmed].length };
  if (trimmed.length === 0) {
    return Object.freeze({ passed: false, reasons: ["empty"], metrics });
  }

  const reasons = [];
  if (metrics.length > 120) reasons.push("summary_too_long");
  // Machine identifiers leaking into player-facing speech. A live run (after the
  // NPC-reaction hole was fixed) told the player “回执显示这算普通送礼
  // （gift_given）…quest_25_completed 还是 false” — it read the receipt's wire
  // format out loud. Unlike reaction wording this is a SHAPE, not an open
  // vocabulary: receipt reason codes and evidence keys are lower snake_case, so a
  // bounded pattern detects the whole class instead of chasing phrasings. Neither
  // Chinese prose nor ordinary English contains `_`, so precision is high.
  // The same leak in enum/constant style (SCREAMING_SNAKE) is caught too.
  const machineTokens = trimmed.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
  const constants = trimmed.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [];
  if (machineTokens.length > 0 || constants.length > 0) reasons.push("machine_token_leak");
  // Magic Context puts a `§N§` self-tag on the prompt (its own instructions tell
  // the model to prefix every reply with one), and the model sometimes mimics it
  // into its output - a real Game run presented "§43§ 已经进屋了，被窝那边我去占着。"
  // to the player. It is internal prompt notation, never companion speech, and it
  // carries no `_`, so `machine_token_leak` above cannot see it. Named on its own
  // so a presentation that still carries the marker is a named failure, never a
  // silent pass. The Chat row is scrubbed where it is persisted; this is the
  // check that the Game bubble is too.
  const selfTag = /§\d+§/.test(trimmed);
  if (selfTag) reasons.push("self_tag_leak");
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
  // A reaction is asserted either by a direct emotion/speech verb, or by a body
  // part that MOVES the way only a reaction moves (eyes curving/brightening, a
  // face reddening, a mouth corner lifting). A live run narrated “她收下的时候
  // 连眼睛都弯了” while its receipt recorded showed_response=false, and the
  // direct-verb list alone missed it.
  //
  // The body-part form requires a change verb in a short window: the bare noun
  // (“她的眼睛很大”) is a description, not a claim that the world reacted, so it
  // must not trip this hard signal.
  const reaction =
    "(乐|笑|开心|高兴|点头|挥手|答应|满意|感动|惊|说|喊|叫|回话|嘟|夸奖|道谢|beamed|smiled|laughed|said|nodded|replied)";
  const bodyPartChange =
    "(眼睛|眼眶|眼珠|眼角|脸|脸颊|面颊|嘴角|眉毛|眉头|神情|表情|神色|下巴)" +
    "[^。；.!！?？]{0,6}" +
    "(弯|亮|红|湿|白|上扬|翘|敛|皱|瞪|睁大|眯|颤|僵|柔和|发红)";
  const window = "[^。；.!！?？]{0,12}";
  const reactionRegex = new RegExp(`${subject}${window}${reaction}`);
  const bodyPartChangeRegex = new RegExp(`${subject}${window}${bodyPartChange}`);
  const reactionClauses = withoutToneTags.split(/[，,、。；;！!？?\n]+/).filter((c) => c.trim().length > 0);
  const claimsNpcReaction = reactionClauses.some((clause) => {
    const c = clause.trim();
    if (/(要是|如果|假如|万一|只要)/.test(c) || /的话$/.test(c)) return false;
    return reactionRegex.test(c) || bodyPartChangeRegex.test(c);
  });
  if (claimsNpcReaction && !observedEvents.includes("npc_dialogue")) {
    reasons.push("unobserved_event");
  }
  // Soft interaction signal: address the player or ask/turn the turn over.
  // Addressing the player means addressing the player: the pronoun/second-person words, nothing else. A question
  // mark and the handoff phrases ("要不要", "好不好") were counted here, which paid the gate's soft signal for
  // asking the player to choose - the same move the behaviour rubric now breaks (memory #4505, measured on a real
  // run whose session ended with a menu of options).
  const hasPlayerAddress = /你|咱们|我们|一起/.test(trimmed);

  return Object.freeze({
    passed: reasons.length === 0,
    reasons,
    metrics: Object.freeze({
      ...metrics,
      hasPlayerAddress,
      claimedNpcReaction: claimsNpcReaction,
      selfTag,
      machineTokens: Object.freeze([...machineTokens, ...constants]),
    }),
  });
}
