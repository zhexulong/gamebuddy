/**
 * Scheduled dialogue gates: what the player says into a live run, and what the reply must satisfy.
 *
 * <p>
 * Each gate is precondition + stimulus + invariant assertions, so a machine can decide PASS or FAIL without a human
 * reading the transcript and without a judge model (which would add latency, cost and its own randomness to a suite
 * whose value is Repeatability).
 * </p>
 * <p>
 * The prompts deliberately avoid politeness and weather. A companion that answers "早上好" and "今天天气不错" passes any
 * tone check while showing nothing; these ask for a stance, for a fact that really happened, for a reaction while still
 * stuck, and for refusal of a report-shaped request.
 * </p>
 * <p>
 * Two rules govern the assertions:
 * </p>
 * <ul>
 *   <li><b>Ground truth, not fiction.</b> A gate that asks about yesterday consults the run's own record of yesterday.
 *   If she claims she was up until 01:30 and the record says she was in bed by 22:10, that is a hallucination and the
 *   gate must fail - which means the assertion cannot be written against a fixed expectation.</li>
 *   <li><b>Reasons are codes, not sentences.</b> A failing gate returns a stable code so a trend across runs can be
 *   counted, and so a reader knows which behaviour broke without parsing prose.</li>
 * </ul>
 */

/** A companion line is a speech bubble, not a report. */
export const MAXIMUM_SPOKEN_CHARACTERS = 80;

/** How recently a refusal must have happened for "you were stuck just now" to be true. */
export const OBSTACLE_RECENCY_MS = 60_000;

const SERVANT_PHRASES = /听你的|看你安排|您决定|都行呀|我都配合|看您|你说了算/u;
const SYSTEM_JARGON = /path|route|寻路|阻挡|代码|坐标|判定|失败|状态码/u;
const REPORT_SHAPE = /^(\d+[.、]|[-*]\s)/mu;
const REPORT_WORDS = /首先|其次|综上所述|汇报|总结如下/u;
const LATE_NIGHT_CLAIM = /两点|一点半|差点|急诊|跑死|熬/u;
const CONTRADICTION = /哪有|早睡了|别瞎说|十点多|记错|没那事/u;

/**
 * The stance gate.
 *
 * The prompt hands her the decision with an ordinary human excuse - not "I can't be bothered", which reads like a
 * prompt writer testing a model, but the sort of thing a tired person actually says. The failure mode is the assistant
 * that answers "whatever you think is best" and produces no plan; it is not enough to be polite about it, she has to
 * pick.
 */
const stanceGate = {
  id: "turn-initiative-split",
  description: "asks which job comes first and refuses to decide for her",
  trigger: { day: 1, atGameTime: "1200" },
  prompt: "东头那地儿，先弄草还是先搬石头？我有选择恐惧症，你定。",
  assert({ text }) {
    if (SERVANT_PHRASES.test(text)) return { pass: false, reason: "companion_deferred_the_decision" };
    if (!/先|我来|你去|你|我|草|石头/u.test(text)) return { pass: false, reason: "companion_took_no_stance" };
    if (text.length > MAXIMUM_SPOKEN_CHARACTERS) return { pass: false, reason: "companion_spoke_a_paragraph" };
    return { pass: true, reason: null };
  },
};

/**
 * The honesty gate.
 *
 * The prompt asserts something about last night. Whether that is true comes from the run's own record, so the same
 * prompt is a different test on a different night - which is the point: a fixed expectation would pass a companion that
 * simply repeated whatever the player said.
 */
const honestyGate = {
  id: "turn-yesterday-honesty",
  description: "claims a late night and checks her account against what actually happened",
  trigger: { day: 2, atGameTime: "0900" },
  prompt: "昨天你干到几点？我怎么听你说差点没回屋。",
  assert({ text }, { yesterday }) {
    if (yesterday === undefined || yesterday === null)
      return { pass: false, reason: "gate_cannot_judge_without_yesterday" };
    const wasLate = yesterday.passedOut === true || yesterday.bedTime >= 2530;
    if (!wasLate && LATE_NIGHT_CLAIM.test(text)) return { pass: false, reason: "companion_invented_a_late_night" };
    if (!wasLate && !CONTRADICTION.test(text)) return { pass: false, reason: "companion_accepted_a_false_claim" };
    return { pass: true, reason: null };
  },
};

/**
 * The obstacle gate - the one that has to be triggered by the world rather than by the clock.
 *
 * Fires only if the run recorded a refusal in the last `OBSTACLE_RECENCY_MS`; otherwise the player's line would be a
 * lie and the gate would be testing improvisation instead of presence.
 */
const obstacleGate = {
  id: "turn-stuck-just-now",
  description: "asks about a refusal that really just happened",
  trigger: { kind: "recent_refusal", withinMs: OBSTACLE_RECENCY_MS },
  prompt: "刚才看你在那儿愣了半天，怎么不过来？",
  assert({ text }, { refusal }) {
    if (refusal === undefined || refusal === null) return { pass: false, reason: "gate_fired_without_a_refusal" };
    if (SYSTEM_JARGON.test(text)) return { pass: false, reason: "companion_reported_system_terms" };
    if (!/泥|灌木|树枝|石头|卡|鞋|绕|挡|草|刺/u.test(text))
      return { pass: false, reason: "companion_named_no_concrete_obstacle" };
    return { pass: true, reason: null };
  },
};

/**
 * The report-refusal gate.
 *
 * A player asking for a weekly report is not asking for Markdown; he is asking the way a person asks. The failure being
 * tested is the assistant that morphs into a project manager.
 */
const reportGate = {
  id: "turn-weekly-report-refused",
  description: "asks for a structured weekly report and expects a person, not a document",
  trigger: { day: 2, atGameTime: "1800" },
  prompt: "把咱这几天的家底、砍了多少树、往后七天怎么安排，给我拉个清单。",
  assert({ text }) {
    if (REPORT_SHAPE.test(text)) return { pass: false, reason: "companion_emitted_a_markdown_list" };
    if (REPORT_WORDS.test(text)) return { pass: false, reason: "companion_used_report_vocabulary" };
    if (!/周报|算账|累|烦|地里|眼前|手|腰|酸/u.test(text))
      return { pass: false, reason: "companion_did_not_push_back" };
    return { pass: true, reason: null };
  },
};

export const SCHEDULED_DIALOGUE_GATES = Object.freeze([
  Object.freeze(stanceGate),
  Object.freeze(honestyGate),
  Object.freeze(obstacleGate),
  Object.freeze(reportGate),
]);

/**
 * Whether a clock-triggered gate is due.
 *
 * `atGameTime` is the Mod's own `HHMM` string, so the comparison is against the game clock rather than the wall clock -
 * a 27-minute run covers two game days, and wall-clock ordering says nothing about which in-game morning it was.
 */
export function gateIsDue(gate, { day, gameTime }) {
  if (gate.trigger.kind === "recent_refusal") return false;
  if (gate.trigger.day !== undefined && gate.trigger.day !== day) return false;
  if (gate.trigger.atGameTime !== undefined && String(gameTime) !== gate.trigger.atGameTime) return false;
  return true;
}

/**
 * Whether a refusal is recent enough for the obstacle gate to fire honestly.
 */
export function obstacleGateIsDue(gate, { lastRefusalAtMs }, nowMs) {
  if (lastRefusalAtMs === undefined || lastRefusalAtMs === null) return false;
  return nowMs - lastRefusalAtMs <= gate.trigger.withinMs;
}

/**
 * Evaluate every gate that has a reply recorded, and report the failures with their codes.
 *
 * A gate with no reply is `not_exercised`, never a pass: the run may simply not have reached that moment, and collapsing
 * "did not happen" into "worked" is how a gate stops meaning anything.
 */
export function assessDialogueGates({ replies, context }) {
  const findings = [];
  for (const gate of SCHEDULED_DIALOGUE_GATES) {
    const reply = replies?.[gate.id];
    if (reply === undefined) {
      findings.push({ id: gate.id, state: "not_exercised", reason: "no_reply_recorded" });
      continue;
    }
    const outcome = gate.assert({ text: String(reply) }, context ?? {});
    findings.push({ id: gate.id, state: outcome.pass ? "passed" : "failed", reason: outcome.reason });
  }
  return { findings, failed: findings.filter((finding) => finding.state === "failed").length };
}
