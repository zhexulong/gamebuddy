/**
 * Whether a day opened on a world the companion was actually handed.
 *
 * The first prompt of a day is the one turn with nothing behind it, so a run that hands it over before the world has
 * been read is a run whose day started blind - and that is a fact about the HARNESS, which is why every reading here
 * publishes "not measured" with its own reason instead of a pass. `awaitDayOpeningWorld` waits (bounded in polls as
 * well as in the clock), `readDayStartDeliveries` reads what the Host actually delivered for each scheduled day out of
 * this run's own session record, and `assessDayStarts`/`assessCompanionArrival` turn those readings into the verdict
 * codes the session verdict orders against every behavioural claim about the day.
 */

/**
 * The world-state block's own words when no observation has arrived.
 *
 * The block's owner is `host/src/fact-brief.ts` (`NOTHING_OBSERVED`), and that constant is not exported, so it is spelled
 * here ONCE and compared against the owner's source by this runner's own test - the two cannot drift apart in silence.
 * It is the marker that makes "this day started blind" readable from a delivered message instead of inferred from code.
 */
export const NOTHING_OBSERVED_WORLD = "世界：尚未收到观察";

/**
 * Wait, bounded, for the world she is about to be handed to have been OBSERVED.
 *
 * <p>
 * The day's first prompt is the one turn with nothing behind it: no tool result, no receipt, no settled programme. Handing
 * it over before the world has been read is what `round49` did - the first delivery carried `世界：尚未收到观察`, her first
 * thinking was "no observation yet", and her first action was `stardew_observe {}`, a whole turn spent looking at a world
 * the harness already held.
 * </p>
 *
 * <p>
 * A WAIT CANNOT MANUFACTURE A READING, and it is not asked to: the producer is the attach boundary
 * (`runtime.connected.activateIngress()`, called before the first prompt). What this adds is the failure mode - if the
 * world is still unread when the bound expires, the caller delivers anyway and NAMES the wait, so a blind day is a stated
 * outcome instead of an invisible one. The bound is a HARNESS bound (design 1432), never a product verdict.
 * </p>
 *
 * <p>
 * The poll count is bounded as well as the clock. Without it a `now` that never advances - the shape every test that
 * fakes the clock has - would loop forever, and "bounded" would be a claim about the caller's clock instead of a property
 * of this function.
 * </p>
 */
export async function awaitDayOpeningWorld({
  probe,
  timeoutMs = 15_000,
  pollMs = 250,
  now = () => Date.now(),
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const pollBound = Math.max(1, Math.ceil(timeoutMs / Math.max(1, pollMs)) + 1);
  const startedAtMs = now();
  let polls = 0;
  for (;;) {
    const reading = probe();
    if (reading?.observed === true)
      return Object.freeze({
        observed: true,
        waitedMs: now() - startedAtMs,
        revision: Number.isInteger(reading.revision) ? reading.revision : null,
        polls,
      });
    const waitedMs = now() - startedAtMs;
    if (waitedMs >= timeoutMs || polls >= pollBound)
      return Object.freeze({ observed: false, waitedMs, revision: null, polls });
    await pause(pollMs);
    polls += 1;
  }
}

/**
 * The day's prompt when the wait expired: the harness says what it could not hand over.
 *
 * A statement about the HARNESS, not an instruction to go and look. The turn is still delivered - a companion nobody asks
 * anything cannot act at all - and the sentence exists so the model is not left to read an empty world as a real one.
 * It is deliberately not "observe first": the fix for a blind day is that the observation is handed over, and a prompt
 * that told her to look would hide the harness's own gap behind her next action.
 */
export function dayPromptWithoutObservation(prompt, opening, locale) {
  // A prompt that says the harness never got the world must be about a wait that actually expired: an observed opening
  // returns the prompt untouched rather than stating something false about the harness.
  if (opening?.observed === true) return prompt;
  const waitedSeconds = String(Math.max(0, Math.round((opening?.waitedMs ?? 0) / 1000)));
  return locale === "zh"
    ? `${prompt}\n\n（这一轮之前，系统没有拿到世界的观察：等了 ${waitedSeconds} 秒，仍然没有。现在不知道时间、位置和身上带着什么。）`
    : `${prompt}\n\n(Before this turn the harness never received an observation of the world: it waited ${waitedSeconds}s and none arrived. Time, place and what you carry are unknown.)`;
}

/**
 * What the Host actually DELIVERED for each scheduled day's first turn, read from this run's own session record.
 *
 * <p>
 * THE DAY'S DELIVERY IS THE MESSAGE CARRYING THE DAY'S OWN WORDS, not the message at a POSITION in the record. The
 * harness hands a day's prompt to the Host, and the Host writes it into the record at its next request boundary - measured
 * on `round99`: day 2's prompt was admitted at 10:07:55 and reached the record at 10:09:52 (117 s later, behind the
 * pump's own event batch), day 3's at 178 s. A reading indexed off the record as it stood when the turn OPENED - a count
 * of user messages taken before the prompt, then the first message after it - therefore read a record the day had not
 * reached yet: `days started blind 0 of 3` beside `day_start_reading_missing:2` and `:3` on a run that delivered all
 * three notes (`MULTIDAY_DAY_NOTES days scheduled 3 · notes delivered 3`) and opened every day on an observed world. The
 * position was never the fact; the words are, and they are the harness's own (`promptForDay`), so nothing here has to
 * guess at a record's shape.
 * </p>
 *
 * <p>
 * The days are read IN ORDER, each searching from where the previous one was found, so a rotation that asks the same
 * task on two days reads two deliveries instead of the first one twice.
 * </p>
 *
 * <p>
 * NOT MEASURED is its own answer, with the reason, and never a pass: an unreadable record, a day whose words are nowhere
 * in it (the prompt was admitted and never delivered - the same gap `assessPlayerInputSchedule` names from the note's
 * side), and a day scheduled without words to look for are three different gaps with three different owners.
 * </p>
 */
export function readDayStartDeliveries({ days, texts, marker }) {
  const scheduled = Array.isArray(days) ? days : [];
  const unmeasured = (entry, reason) =>
    Object.freeze({
      day: Number.isInteger(entry?.day) ? entry.day : null,
      waitedMs: Number.isInteger(entry?.waitedMs) ? entry.waitedMs : null,
      measured: false,
      startedBlind: false,
      worldState: null,
      reason,
    });
  // A reading with no marker would compare every delivery against "" and call each one blind, and one with a missing
  // marker would call every delivery sound; both are silent, so the caller must name what it is looking for.
  if (typeof marker !== "string" || marker.length === 0) throw new Error("day_start_marker_required");
  if (!Array.isArray(texts))
    return Object.freeze(scheduled.map((entry) => unmeasured(entry, "session_record_unreadable")));
  const readings = [];
  // Where the previous day's delivery was found: the next day's search starts after it, so the order of the days and the
  // order of the record are the same order.
  let from = 0;
  for (const entry of scheduled) {
    const words = typeof entry?.prompt === "string" ? entry.prompt : "";
    if (words.trim().length === 0) {
      readings.push(unmeasured(entry, "day_prompt_text_missing"));
      continue;
    }
    let at = -1;
    for (let index = from; index < texts.length; index += 1) {
      const text = texts[index];
      if (typeof text === "string" && text.includes(words)) {
        at = index;
        break;
      }
    }
    if (at < 0) {
      readings.push(unmeasured(entry, "day_prompt_not_in_session"));
      continue;
    }
    from = at + 1;
    const delivered = texts[at];
    const block = /<world-state>([\s\S]*?)<\/world-state>/u.exec(delivered)?.[1]?.trim() ?? null;
    readings.push(
      Object.freeze({
        day: Number.isInteger(entry?.day) ? entry.day : null,
        waitedMs: Number.isInteger(entry?.waitedMs) ? entry.waitedMs : null,
        measured: true,
        startedBlind: delivered.includes(marker),
        // The block itself, bounded: the evidence a reader needs, and never the whole delivery (the player's own note is
        // in there and is read for matching only).
        worldState: block === null ? null : `<world-state>${block.slice(0, 200)}</world-state>`,
        reason: null,
      }),
    );
  }
  return Object.freeze(readings);
}

/**
 * Whether a run started its days BLIND, over the days it scheduled.
 *
 * <p>
 * THE POPULATION IS THE DAYS THE RUN SCHEDULED, so a run that scheduled none is blocked rather than green: `0 of 0` would
 * agree with itself. Every scheduled day must be measured, and a blind one is a finding that names the day and the wait
 * that expired in front of it.
 * </p>
 *
 * <p>
 * The verdict code is the first blind day if there is one, else whatever made the population unmeasurable, else `null` -
 * so the caller cannot fold "not measured" into a pass by reading a `null` and a missing field the same way.
 * </p>
 */
export function assessDayStarts({ scheduledDays, readings } = {}) {
  const list = Array.isArray(readings) ? readings : [];
  const findings = [];
  const blindDays = [];
  let measured = 0;
  for (const reading of list) {
    if (reading?.measured !== true) {
      findings.push(
        Object.freeze({
          code: `day_start_reading_missing:${String(reading?.day ?? "?")}:${String(reading?.reason ?? "no_reading")}`,
          day: Number.isInteger(reading?.day) ? reading.day : null,
        }),
      );
      continue;
    }
    measured += 1;
    if (reading.startedBlind === true) {
      blindDays.push(reading.day);
      findings.push(
        Object.freeze({
          code: `day_started_blind:${String(reading.day)}`,
          day: reading.day,
          waitedMs: Number.isInteger(reading.waitedMs) ? reading.waitedMs : null,
        }),
      );
    }
  }
  const population = Number.isInteger(scheduledDays) && scheduledDays > 0 ? scheduledDays : 0;
  const missing = findings.find((finding) => finding.code.startsWith("day_start_reading_missing:"));
  const blocked =
    population === 0
      ? "no_days_scheduled"
      : list.length < population
        ? `day_start_reading_missing:${String(list.length)}_of_${String(population)}`
        : (missing?.code ?? null);
  return Object.freeze({
    population,
    measured,
    startedBlind: blindDays.length,
    blindDays: Object.freeze(blindDays),
    findings: Object.freeze(findings),
    reading: `days started blind ${String(blindDays.length)} of ${String(population)}`,
    blocked,
    verdictCode: blindDays.length > 0 ? `day_started_blind:${String(blindDays[0])}` : blocked,
  });
}

/**
 * Whether the attach's own arrival fact was said, exactly once.
 *
 * <p>
 * The same call that hands the launch's snapshot to the Host (`activateIngress` -> `host.acceptInitialFacts`) is the
 * attach boundary `companionArrivalFact` is gated on (`host-service.ts`, `#sayArrivalOnce`). A harness that never
 * activated the ingress therefore lost BOTH readings with one omission, and only the world-state half was visible: a
 * companion who is never told she arrived is a second defect hiding behind the first.
 * </p>
 *
 * <p>
 * The marker is the arrival fact's own model-facing line - the one `<world-facts>` prints for it from
 * `WORLD_FACT_KIND_ZH.companion_arrival` (`host/src/fact-brief.ts`) - spelled here because that table is module-local;
 * this runner's test compares it against the owner's source so the marker cannot drift. It is the only thing in a
 * delivery that names the arrival: the fact states no sentence of its own (the state it used to repeat is the batch's
 * `<world-state>`). The record is the authority, not the activation flag: "the flag was set" and "the delivery
 * happened" came apart in every other reading in this file.
 * </p>
 *
 * <p>
 * `attached: false` is NOT a finding about the arrival: a run that never materialized already has a failure that names
 * its own cause, and reporting the attach it never attempted would report a symptom over it.
 * </p>
 */
export function assessCompanionArrival({ attached, texts } = {}) {
  const arrivalLine = "- 她到了";
  if (attached !== true)
    return Object.freeze({
      measured: false,
      said: 0,
      reading: "arrival said 0 of 1",
      reason: "ingress_not_activated",
      verdictCode: null,
    });
  if (!Array.isArray(texts))
    return Object.freeze({
      measured: false,
      said: 0,
      reading: "arrival said 0 of 1",
      reason: "session_record_unreadable",
      verdictCode: "companion_arrival_unmeasured",
    });
  const said = texts.filter((text) => text.includes(arrivalLine)).length;
  return Object.freeze({
    measured: true,
    said,
    reading: `arrival said ${String(said)} of 1`,
    reason: null,
    verdictCode: said === 1 ? null : said === 0 ? "companion_arrival_not_delivered" : "companion_arrival_said_twice",
  });
}
