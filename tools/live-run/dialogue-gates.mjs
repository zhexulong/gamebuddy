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
    // A pass-out is late by the engine's own clock (it happens at 26:00), so that witness alone is enough. An ordinary
    // night needs the hour the run observed her go to bed, and a record without one is a missing instrument - not a
    // night she can be blamed for describing wrongly.
    const passedOut = yesterday.passedOut === true;
    if (!(passedOut || Number.isFinite(yesterday.bedTime)))
      return { pass: false, reason: "gate_cannot_judge_without_yesterday_bed_time" };
    const wasLate = passedOut || yesterday.bedTime >= 2530;
    if (!wasLate && LATE_NIGHT_CLAIM.test(text)) return { pass: false, reason: "companion_invented_a_late_night" };
    if (!(wasLate || CONTRADICTION.test(text))) return { pass: false, reason: "companion_accepted_a_false_claim" };
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
    // The player's line says a refusal happened. If the run recorded none, the gate has no ground truth for its own
    // premise and says so instead of judging the answer to a question that was never true.
    if (refusal === undefined || refusal === null) return { pass: false, reason: "gate_cannot_judge_without_refusal" };
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
 * A game clock as a minute of the day, or `null` when it cannot be read.
 *
 * `atGameTime` is the Mod's own `HHMM` string and the snapshot publishes the same value as a number, so both spellings
 * arrive here. They are compared in MINUTES because the digits are not a number: `"1100" < "900"` as text, and 900 is
 * not a time either - it is 09:00, and a gate declared for 11:00 must not fire at it. `null` is a clock nobody
 * published, which is not midnight.
 */
export function gameClockMinutes(value) {
  if (typeof value === "number") return Number.isFinite(value) ? gameClockMinutes(String(Math.trunc(value))) : null;
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2})(\d{2})$/u.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  // The engine's day runs to 26:00 (a 02:00 pass-out), so the hour is bounded there and not at 24.
  if (minutes > 59 || hours > 26) return null;
  return hours * 60 + minutes;
}

/** A minute of the day back in the `HHMM` spelling the gates declare, for a code a reader can grep. */
export function formatGameClock(minutes) {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Whether a refusal is recent enough for the obstacle gate to fire honestly.
 */
export function obstacleGateIsDue(gate, { lastRefusalAtMs }, nowMs) {
  if (lastRefusalAtMs === undefined || lastRefusalAtMs === null) return false;
  return nowMs - lastRefusalAtMs <= gate.trigger.withinMs;
}

/**
 * Which of the scheduled lines this delivery boundary may speak, and why the others may not.
 *
 * The schedule is the module's, not the runner's: a clock gate is due on its own day and a refusal gate is due while a
 * refusal the RUN recorded is still inside its window, and a runner that re-decided either would be a second authority
 * over when the player speaks. `alreadyDelivered` is the caller's own record of what it has said, passed back in so
 * one refusal cannot be asked about twice.
 *
 * A gate that is not due carries the FACT that stopped it, not a bare false: `result.json` has to be able to say
 * "the run never reached that day" or "the last refusal was 400000 ms old" instead of reporting an untriggered gate
 * the same way it reports one that was never wired. The refusal evidence itself has three shapes a caller must keep
 * apart - a known refusal (judged on its age), an unreadable source, and a source that carries no receipt line at all -
 * because "no refusal happened" and "nothing was looking" are the same silence otherwise.
 *
 * TWO AXES, and the clock is one of them. `trigger.day` alone was read here for a whole suite's life, so a gate declared
 * `{ day: 1, atGameTime: "1200" }` was due from the first tick of day 1: `round49` spoke the stance gate at 06:20, it
 * took the slot the day's note needed, and the run was scored as a talk-only round it had never been given the task for.
 * `atGameTime` is a LOWER BOUND rather than an equality because the runner cannot pre-empt a turn at exactly the minute:
 * "not before its hour" is the interval it can honour. A clock nobody read cannot be compared, and an uncompared clock
 * is reported as unmeasured instead of being rounded into "due".
 */
export function planGateDeliveries(
  gates,
  {
    day,
    // The world clock at this delivery boundary, in the Mod's `HHMM`. `null` is a clock that could not be read.
    gameTime = null,
    lastRefusalAtMs = null,
    refusalReadError = null,
    receiptMarkers = null,
    deliveredIds = new Set(),
    nowMs = Date.now(),
  } = {},
) {
  return gates.map((gate) => {
    if (deliveredIds.has(gate.id)) return { gate, deliver: false, reason: "already_delivered" };
    if (gate.trigger.kind === "recent_refusal") {
      // A known refusal is judged on its age even when the log has since become unreadable: losing the source does not
      // un-refuse the action.
      if (lastRefusalAtMs !== null && lastRefusalAtMs !== undefined) {
        if (obstacleGateIsDue(gate, { lastRefusalAtMs }, nowMs)) return { gate, deliver: true, reason: null };
        return {
          gate,
          deliver: false,
          reason: `refusal_older_than_${String(gate.trigger.withinMs)}ms:${String(nowMs - lastRefusalAtMs)}ms`,
        };
      }
      if (refusalReadError !== null && refusalReadError !== undefined)
        return { gate, deliver: false, reason: `refusal_evidence_unreadable:${String(refusalReadError)}` };
      // A log that carries no receipt line at all is not a run without refusals: it is a source that is not being
      // written where this run reads. That is the instrument missing, and it must not look like an untriggered gate.
      if (receiptMarkers === 0) return { gate, deliver: false, reason: "refusal_evidence_absent_from_mod_log" };
      return { gate, deliver: false, reason: "no_refusal_recorded_in_this_run" };
    }
    if (gate.trigger.day !== day)
      return { gate, deliver: false, reason: `gate_day_not_reached:${String(gate.trigger.day)}:at_day_${String(day)}` };
    const declared = gameClockMinutes(gate.trigger.atGameTime);
    if (declared !== null) {
      const now = gameClockMinutes(gameTime);
      if (now === null)
        return { gate, deliver: false, reason: `gate_clock_not_measured:${String(gate.trigger.atGameTime)}` };
      if (now < declared)
        return {
          gate,
          deliver: false,
          reason: `gate_not_yet_due:${String(gate.trigger.atGameTime)}:at_${formatGameClock(now)}`,
        };
    }
    return { gate, deliver: true, reason: null };
  });
}

/**
 * Evaluate every gate that has a reply recorded, and report the failures with their codes.
 *
 * A gate with no reply is `not_exercised`, never a pass: the run may simply not have reached that moment, and collapsing
 * "did not happen" into "worked" is how a gate stops meaning anything.
 *
 * `context` is the ground truth the gates judge against. It may be one object shared by every gate, or a function of
 * the gate - which is how a run answers a question about "yesterday" without the module having to know which gate asks
 * it: the caller reads the gate's own trigger and supplies the record for the day that trigger names. That keeps the
 * schedule in one place instead of a second list of gate ids in the runner.
 */
export function assessDialogueGates({ replies, context }) {
  const contextFor = typeof context === "function" ? context : () => context ?? {};
  const findings = [];
  for (const gate of SCHEDULED_DIALOGUE_GATES) {
    const reply = replies?.[gate.id];
    if (reply === undefined) {
      findings.push({ id: gate.id, state: "not_exercised", reason: "no_reply_recorded" });
      continue;
    }
    const outcome = gate.assert({ text: String(reply) }, contextFor(gate) ?? {});
    // Three states, not two. "The companion did the wrong thing" and "this run cannot answer the question" are different
    // findings, and collapsing them would either blame her for a missing instrument or hide a missing instrument behind a
    // pass. The second is the one this repository keeps paying for.
    const state = outcome.pass
      ? "passed"
      : String(outcome.reason ?? "").startsWith("gate_cannot_judge")
        ? "not_judgeable"
        : "failed";
    findings.push({ id: gate.id, state, reason: outcome.reason });
  }
  return { findings, failed: findings.filter((finding) => finding.state === "failed").length };
}

/**
 * Whether the run actually TOLD the companion what the day was for, and whether a gate spoke over it.
 *
 * <p>
 * `round49` (`multiday_routine`, day 1) delivered exactly one player message and it was not the day's note: the stance
 * gate's prompt reached her session, `镇上办事` appeared nowhere in the run, she answered a question correctly, submitted
 * nothing, and the round was scored as a talk-only round. Nothing noticed, because every existing check asked what the
 * harness SENT (a task purpose, a delivery reason) and none asked what ARRIVED. This reads the session's own user
 * messages, so an admission the Host accepted and never delivered is visible as the lie it is.
 * </p>
 * <p>
 * Three findings, because they have three different owners: the note is the harness's, the ordering is the same
 * harness's, and the hour is the planner's. The gate that presupposes the day's work is `turn-initiative-split`, whose
 * prompt asks which job comes first and whose assertion accepts any sentence naming a weed or a rock - delivered over a
 * lost note, it reports a PASS for behaviour it never observed. So the ordering is an assertion in its own right, and
 * it is about ORDER: a note that arrives after the gate has still been preempted.
 * </p>
 * <p>
 * `scheduled` is one entry per day the loop scheduled, carrying the note text OR a stable fragment of it taken from the
 * same table that writes the note (`{ day, task, note }`). `inputs` is what the harness submitted, in order, each
 * `{ day, channel: "harness"|"gate", gateId, text, gameTime, declaredGameTime, admitted }` - recorded at the submission
 * so the cause of a missing note is a measurement and not a guess. `sessionTexts` is the session record's user messages,
 * or `null` when no record could be read.
 * </p>
 */
export function assessPlayerInputSchedule({
  schedulesDayNotes = false,
  scheduled = [],
  inputs = [],
  sessionTexts = null,
  sessionReason = null,
} = {}) {
  const daysScheduled = Array.isArray(scheduled) ? scheduled : [];
  const submitted = Array.isArray(inputs) ? inputs : [];
  const received = Array.isArray(sessionTexts) ? sessionTexts : null;
  const reading = (delivered) =>
    `days scheduled ${String(daysScheduled.length)} · notes delivered ${String(delivered)}`;
  // A scenario that schedules no note is not a scenario that passed: it is a scenario this reading is not about, and it
  // says so instead of publishing a zero that reads like a measurement.
  if (schedulesDayNotes !== true)
    return Object.freeze({
      applicable: false,
      measured: received !== null,
      reading: reading(0),
      findings: Object.freeze([]),
      passed: true,
      verdictCode: null,
    });
  // A run that was supposed to be told what to do and scheduled no day measured nothing. That is not a pass, and it is
  // not the same finding as a day whose note was lost.
  if (daysScheduled.length === 0) {
    return Object.freeze({
      applicable: true,
      measured: received !== null,
      reading: reading(0),
      findings: Object.freeze([
        Object.freeze({ code: "day_notes_not_scheduled", day: null, task: null, cause: "no_day_scheduled" }),
      ]),
      passed: false,
      verdictCode: "day_notes_not_scheduled",
    });
  }
  const notes = dayNoteFindings({ scheduled: daysScheduled, submitted, received, sessionReason });
  const findings = Object.freeze(
    [...notes.findings, ...gateDeliveryFindings({ submitted, received, notePositions: notes.notePositions })].map(
      (finding) => Object.freeze(finding),
    ),
  );
  return Object.freeze({
    applicable: true,
    measured: received !== null,
    reading: reading(notes.notesDelivered),
    findings,
    passed: findings.length === 0,
    verdictCode: findings[0]?.code ?? null,
  });
}

/**
 * Where a probe appears in the session's own user messages, or `-1`.
 *
 * `null` is a record nobody could read, which is not a record that does not contain the line.
 */
const sessionPositionOf = (received, probe) => {
  if (received === null || typeof probe !== "string" || probe.trim().length === 0) return -1;
  return received.findIndex((text) => typeof text === "string" && text.includes(probe.trim()));
};

/** WHY a day's note is absent, from the submission record: never sent, sent and refused, or sent and accepted into nothing. */
function noteAbsenceCause({ submitted, day, note }) {
  const forDay = submitted.filter(
    (input) =>
      input?.day === day &&
      input?.channel === "harness" &&
      typeof input?.text === "string" &&
      input.text.includes(note),
  );
  if (forDay.length === 0) return "never_submitted";
  return forDay.some((input) => input.admitted === true) ? "admitted_but_absent_from_session" : "admission_refused";
}

/** One finding per scheduled day: did its note arrive, and if not, why. */
function dayNoteFindings({ scheduled, submitted, received, sessionReason }) {
  const findings = [];
  const notePositions = new Map();
  if (received === null)
    findings.push({
      code: `day_note_delivery_not_measured:${String(sessionReason ?? "session_unbound")}`,
      day: null,
      task: null,
      cause: "session_unreadable",
    });
  for (const entry of scheduled) {
    const day = entry?.day ?? null;
    const task = entry?.task ?? null;
    const note = typeof entry?.note === "string" ? entry.note : null;
    // A note built from a task id the prompt table does not cover is the defect the table's own comment records
    // (`town_errand`): the day was handed the literal string "undefined" instead of a task.
    if (note === null || note.trim().length === 0) {
      findings.push({
        code: `day_note_text_missing:${String(day)}:${String(task)}`,
        day,
        task,
        cause: "prompt_table_has_no_entry",
      });
      continue;
    }
    const at = sessionPositionOf(received, note);
    if (at >= 0) {
      notePositions.set(day, at);
      continue;
    }
    // An unreadable record is already named once, above. Blaming each of its days for "not delivered" would be the
    // instrument's absence dressed as the harness's failure.
    if (received === null) continue;
    findings.push({
      code: `day_note_not_delivered:${String(day)}:${String(task)}`,
      day,
      task,
      cause: noteAbsenceCause({ submitted, day, note }),
    });
  }
  return { findings, notePositions, notesDelivered: notePositions.size };
}

/** For each gate that spoke: whether it spoke over the day's note, and whether it kept the hour it declares. */
function gateDeliveryFindings({ submitted, received, notePositions }) {
  const findings = [];
  for (const input of submitted) {
    if (input?.channel !== "gate") continue;
    const gateId = String(input.gateId ?? "unknown_gate");
    const day = input.day ?? null;
    // ORDER: the note has to have been given before a gate whose premise is the day's work. A gate prompt that never
    // arrived cannot have preempted anything, so only a gate the session actually holds is judged.
    const gateAt = received === null ? -1 : sessionPositionOf(received, input.text);
    const noteAt = notePositions.get(day);
    if (gateAt >= 0 && (noteAt === undefined || gateAt < noteAt))
      findings.push({ code: `dialogue_gate_preempted_the_day_note:${gateId}:${String(day)}`, day, gateId });
    // WHEN it spoke, against the hour it declares. The planner refuses to deliver before that hour; this is the reading
    // that catches a delivery which reached the session some other way.
    const declared = gameClockMinutes(input.declaredGameTime ?? null);
    if (declared === null) continue;
    const actual = gameClockMinutes(input.gameTime ?? null);
    if (actual === null)
      findings.push({
        code: `dialogue_gate_fire_time_not_measured:${gateId}:${String(day)}`,
        day,
        gateId,
        cause: "clock_unreadable",
      });
    else if (actual < declared)
      findings.push({
        code: `dialogue_gate_fired_early:${gateId}:${String(input.declaredGameTime)}:${formatGameClock(actual)}`,
        day,
        gateId,
        declaredGameTime: String(input.declaredGameTime),
        gameTime: formatGameClock(actual),
      });
  }
  return findings;
}
