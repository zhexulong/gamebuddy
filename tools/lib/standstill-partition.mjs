import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { median, seconds, shareToATenth } from "./action-cadence.mjs";

/**
 * WHERE THE WALL CLOCK WENT WHEN THE BODY WAS NOT STEPPING: the five readings one number could not carry.
 *
 * <p>
 * MEASURED 2026-11-20 (`round84`, 2,065.9 s of wall clock): the run published `actionCadence.idleMs` as ONE number, and that
 * number (1,234 s) was the gap between its two standalone actions - so the only published account of "where the time went"
 * described two events out of 331, and reading it made the bottleneck look like queue overlap. The truth was 261.1 s of
 * native execution (12.6 % of the wall) and, between its programmes, 1,265.2 s of turn gap against 437.5 s of queue wait:
 * the turn boundary, not the queue, which is the opposite conclusion. Four causes printed as one number, and a reader with
 * one number aims the next fix at the wrong one.
 * </p>
 * <p>
 * THE POPULATION IS EVERY MILLISECOND OF THE WALL, and a bucket that cannot be read says `not_measured` with the field that
 * would have answered - never zero, which would read as "the body was never blocked". The four standstill causes and the
 * body's own execution are printed with the residue beside them, and the residue is NAMED by the stretch it covers rather
 * than absorbed: a partition that leaves a share unexplained behind one authoritative number is the defect this module
 * exists to remove.
 * </p>
 * <p>
 * THE FIVE READINGS: the body's duty cycle (and the longest single standstill), the standstill partition with its
 * residue, the autonomy horizon (how long one programme lasts against how long one turn costs), the cognitive tax the
 * tool surface charges in turns and in nodes, and the intent yield of a delivered turn against the three ways its work
 * reaches nobody.
 * </p>
 * <p>
 * AND THE RESIDUE NAMES TWO THINGS THAT ARE NOT THE SAME. The run's head (before its first body step) and its tail
 * (after its last settlement) are FACTS about the run, not measurement error, so they are buckets; what head and tail
 * cannot name is the disagreement between the two clocks this report reads, and the run measures how far apart those
 * clocks are, so the residual prints against a tolerance derived from its own timestamps instead of against 1 ms.
 * </p>
 * <p>
 * ONE THING HERE IS READ ON A SHARED ORIGIN. A programme's stamps come from the Mod's journal clock and a turn's window from
 * the Host's own trace, and the two count from different origins (`clockOffsetMs`, measured per run). The split of the time
 * between two programmes is the rule `host/src/event-pump.turn-gap-round84.test.ts` owns, and this module reproduces it on
 * the single origin that fixture measures on rather than inventing a second answer beside it; the offset is printed so the
 * reader sees what the split is measuring across.
 * </p>
 */

const STANDSTILL_GATE = "a_residual_is_either_named_or_bounded";
const RUN_TRACE_NAME = "run-trace.json";
// The Mod's own turn account: the only record of how many readings went stale and how many refresh attempts were spent on
// them. It is printed on one line of the runner log, so a run whose log never reached the verdict answers `not_measured`
// rather than zero.
const TURN_ACCOUNT = "GAME_TURN_ACCOUNT";
// Tools whose whole purpose is to hand the model a reading it could already have had, or to ask the world a question it
// will then have to act on. They are not failures - they are the measure of how much of the run the tool surface taxed.
const COGNITIVE_TAX_TOOLS = ["stardew_observe", "stardew_look_up", "stardew_find_destination", "stardew_plan_shape"];
// Actions the COMPILER manufactures to keep the body usable rather than the player asking for them: they cost nodes whose
// outcome is a success nobody asked for, so counting them as objectives prices housekeeping as work.
const COGNITIVE_TAX_ACTIONS = ["equip_tool", "navigate_to_destination"];

/** The run's Host trace, refused whole rather than half-read: a partial span list cannot be a population. */
function readRunTrace(runDir) {
  const path = join(runDir, RUN_TRACE_NAME);
  if (!existsSync(path)) return { path: null, events: null, why: `this run has no ${RUN_TRACE_NAME}` };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {
      path,
      events: null,
      why: `${RUN_TRACE_NAME} holds no readable JSON, so it was refused rather than half-read`,
    };
  }
  if (!Array.isArray(parsed?.traceEvents))
    return { path, events: null, why: `${RUN_TRACE_NAME} carries no traceEvents array` };
  return { path, events: parsed.traceEvents, why: null };
}

/**
 * The instant the Host's trace counts from, in the run's own wall clock.
 *
 * `traceEvents[].ts` is microseconds from the RUNNER PROCESS's start, and the runner publishes that offset itself
 * (`phaseTimings.runner_process_start`). Measured on `round84`: `startedAtMs + runner_process_start + ts/1000` lands on the
 * first activity point the bundle carries (`presentation.activity.points[0]`) to the millisecond, and on the first prompt
 * turn within its delivery span. Without this the trace has no place in the wall clock, and every stretch it names would
 * be an offset from an origin nobody published.
 */
function traceOriginMs(result) {
  const startedAtMs = result?.startedAtMs;
  const processStartMs = result?.phaseTimings?.runner_process_start;
  return Number.isFinite(startedAtMs) && Number.isFinite(processStartMs) ? startedAtMs + processStartMs : null;
}

/**
 * One window per DELIVERED batch: from its `delivery` span to the end of its last `turn.tail`.
 *
 * A batch is not a session turn (that is the efficiency block's unit, and a run can deliver 83 batches in 96 turns), so the
 * windows come from the Host's own spans and not from a re-derivation of them. `tails` is kept because a window built from
 * one span and a window built from twenty are different readings, and the count is what lets a reader see which it got.
 */
function deliveredTurns(events) {
  const byBatch = new Map();
  let spans = 0;
  let unkeyed = 0;
  for (const event of events) {
    const name = event?.name;
    if (name !== "delivery" && name !== "turn.tail") continue;
    const batchId = event?.args?.batchId;
    if (typeof batchId !== "string" || typeof event.ts !== "number") {
      unkeyed += 1;
      continue;
    }
    spans += 1;
    const startMs = event.ts / 1000;
    const endMs = startMs + (typeof event.dur === "number" ? event.dur / 1000 : 0);
    const row = byBatch.get(batchId) ?? { batchId, startMs, endMs, tails: 0 };
    row.startMs = Math.min(row.startMs, startMs);
    row.endMs = Math.max(row.endMs, endMs);
    if (name === "turn.tail") row.tails += 1;
    byBatch.set(batchId, row);
  }
  return { turns: [...byBatch.values()].sort((left, right) => left.startMs - right.startMs), spans, unkeyed };
}

/** Each programme's own window and its nodes' executions, in the order the body dispatched them. */
function programmeWindows(result) {
  const outcomes = Array.isArray(result?.programOutcomes) ? result.programOutcomes : null;
  if (outcomes === null) return null;
  const windows = [];
  let untimed = 0;
  for (const outcome of outcomes) {
    const executions = (Array.isArray(outcome?.executions) ? outcome.executions : [])
      .filter((execution) => typeof execution?.atMs === "number")
      .map((execution) => ({
        nodeId: typeof execution.nodeId === "string" ? execution.nodeId : null,
        atMs: execution.atMs,
        settledAtMs: typeof execution.settledAtMs === "number" ? execution.settledAtMs : null,
      }))
      .sort((left, right) => left.atMs - right.atMs);
    if (executions.length === 0) continue;
    const settled = executions.filter(
      (execution) => execution.settledAtMs !== null && execution.settledAtMs >= execution.atMs,
    );
    untimed += executions.length - settled.length;
    if (settled.length === 0) continue;
    windows.push({
      programId: typeof outcome.programId === "string" ? outcome.programId : null,
      nodes: executions.length,
      firstAtMs: executions[0].atMs,
      lastSettledMs: Math.max(...settled.map((execution) => execution.settledAtMs)),
      executions,
    });
  }
  windows.sort((left, right) => left.firstAtMs - right.firstAtMs);
  return { windows, untimed };
}

/**
 * The body's own execution, the freeze between two steps, and the switches inside one programme.
 *
 * `intraMs` pairs the nodes of ONE programme, so the 272 switches of `round84` are counted (161 ms each) and the time a
 * programme spent waiting between its own steps cannot hide in the time between programmes. The freeze is measured on the
 * merged intervals instead: a programme that overlaps another leaves no standstill, and the longest standstill is a fact
 * about the merged occupancy, not about one programme's own life.
 */
function measureBody({ windows, untimed }) {
  const inFlight = [];
  let intraMs = 0;
  let switches = 0;
  for (const window of windows) {
    for (const [index, execution] of window.executions.entries()) {
      if (execution.settledAtMs === null || execution.settledAtMs < execution.atMs) continue;
      inFlight.push({
        programId: window.programId,
        nodeId: execution.nodeId,
        atMs: execution.atMs,
        settledAtMs: execution.settledAtMs,
      });
      const next = window.executions[index + 1];
      if (next === undefined) continue;
      switches += 1;
      const gapMs = next.atMs - execution.settledAtMs;
      if (gapMs > 0) intraMs += gapMs;
    }
  }
  inFlight.sort((left, right) => left.atMs - right.atMs);
  let freeze = null;
  let reached = inFlight.length === 0 ? null : inFlight[0].settledAtMs;
  for (const execution of inFlight) {
    if (reached !== null && execution.atMs > reached) {
      const gapMs = execution.atMs - reached;
      if (freeze === null || gapMs > freeze.gapMs)
        freeze = {
          gapMs,
          fromMs: reached,
          toMs: execution.atMs,
          programId: execution.programId,
          nodeId: execution.nodeId,
        };
    }
    reached = reached === null ? execution.settledAtMs : Math.max(reached, execution.settledAtMs);
  }
  const measuredMs = inFlight.reduce((total, execution) => total + (execution.settledAtMs - execution.atMs), 0);
  return { measuredMs, intraMs, switches, freeze, measured: inFlight.length, untimed };
}

/**
 * The wait between two programmes, split by the rule the owning fixture measures.
 *
 * `host/src/event-pump.turn-gap-round84.test.ts` (`a_program_ends_and_the_body_waits`) owns this split, and this verdict
 * reproduces it rather than re-deciding it: the part of a gap the COMPOSING turn's own window covers is queue wait (the
 * programme drained and the turn that composed the next one had not settled, which is the only part a wake rule can move),
 * and the rest is turn gap (a turn closed having composed nothing and nobody opened the next). A switch whose two
 * programmes overlapped leaves no wait at all and is counted as `inHand` rather than as a negative gap.
 */
function programmeSwitches(windows, turns) {
  const gaps = [];
  let inHand = 0;
  let withoutAComposingTurn = 0;
  for (let index = 1; index < windows.length; index += 1) {
    const previous = windows[index - 1];
    const next = windows[index];
    const gapMs = next.firstAtMs - previous.lastSettledMs;
    if (gapMs <= 0) {
      inHand += 1;
      continue;
    }
    const composing = turns.filter((turn) => turn.startMs < next.firstAtMs).at(-1) ?? null;
    if (composing === null) {
      withoutAComposingTurn += 1;
      gaps.push({ gapMs, queueMs: 0, turnGapMs: gapMs, programId: next.programId });
      continue;
    }
    const queueMs = Math.max(
      0,
      Math.min(composing.endMs, next.firstAtMs) - Math.max(composing.startMs, previous.lastSettledMs),
    );
    gaps.push({ gapMs, queueMs, turnGapMs: gapMs - queueMs, programId: next.programId });
  }
  const total = (key) => gaps.reduce((sum, gap) => sum + gap[key], 0);
  return {
    gaps,
    inHand,
    withoutAComposingTurn,
    betweenMs: total("gapMs"),
    queueMs: total("queueMs"),
    turnGapMs: total("turnGapMs"),
  };
}

/**
 * The body's window placed in the run's wall clock, from the Host's own admission spans.
 *
 * A programme's stamps and a turn's span are read from two clocks, and the two do not share an origin: the Mod's clock
 * opens when its body-program journal does and the trace's opens when the runner process does. `clockOffsetMs` is the
 * median distance between them, printed so a reader can see what the split above is measuring across. Measured on
 * `round84`: 328 paired admissions at a median of 22,746 ms - and they are NOT one constant, which is the whole reason
 * the residual below needs a tolerance: the pairs span 13,639..22,774 ms because one dispatch carries a stamp 9.1 s from
 * where the other clock puts it.
 *
 * The window itself needs no offset: each node's own exposure is `admission.ts + its duration`, a difference inside one
 * clock, so the head (run start -> the first step) and the tail (the last settlement -> run end) are wall-clock facts.
 * `firstSkewMs` and `lastSkewMs` are how far the two clocks place the window's TWO ENDS apart, which is where a
 * residual that survives head and tail has to sit.
 */
function placeBodyWindow({ events, windows, originMs, result }) {
  const admissions = events.filter(
    (event) =>
      event?.name === "admission" && typeof event.ts === "number" && typeof event?.args?.programId === "string",
  );
  if (admissions.length === 0 || originMs === null) return null;
  const stamps = new Map();
  for (const window of windows)
    for (const execution of window.executions) stamps.set(`${window.programId}/${execution.nodeId}`, execution);
  const offsets = [];
  let firstMs = Infinity;
  let lastMs = -Infinity;
  let paired = 0;
  let firstPaired = null;
  let lastPaired = null;
  for (const admission of admissions) {
    const atMs = admission.ts / 1000;
    firstMs = Math.min(firstMs, atMs);
    const execution = stamps.get(`${admission.args.programId}/${admission.args.nodeId}`);
    if (execution === undefined || execution.settledAtMs === null || execution.settledAtMs < execution.atMs) continue;
    paired += 1;
    const endMs = atMs + (execution.settledAtMs - execution.atMs);
    lastMs = Math.max(lastMs, endMs);
    offsets.push(atMs - execution.atMs);
    if (firstPaired === null || atMs < firstPaired.traceMs) firstPaired = { traceMs: atMs, journalMs: execution.atMs };
    if (lastPaired === null || endMs > lastPaired.traceEndMs)
      lastPaired = { traceEndMs: endMs, journalMs: execution.settledAtMs };
  }
  if (paired === 0) return null;
  const wallOf = (traceMs) => originMs + traceMs;
  const widest = Math.max(...offsets);
  const narrowest = Math.min(...offsets);
  return {
    paired,
    unpaired: admissions.length - paired,
    clockOffsetMs: median(offsets),
    clockOffsetPairs: offsets.length,
    clockOffsetSpreadMs: widest - narrowest,
    clockOffsetNarrowestMs: narrowest,
    clockOffsetWidestMs: widest,
    firstSkewMs: firstPaired === null ? null : firstPaired.traceMs - firstPaired.journalMs,
    lastSkewMs: lastPaired === null ? null : lastPaired.traceEndMs - lastPaired.journalMs,
    headMs: Math.max(0, wallOf(firstMs) - result.startedAtMs),
    tailMs: Math.max(0, result.endedAtMs - wallOf(lastMs)),
    firstWallMs: wallOf(firstMs),
    lastWallMs: wallOf(lastMs),
    windowMs: lastMs - firstMs,
  };
}

/** The Mod's turn account, read from the LAST line of the runner log it is printed on. */
function readStaleAccount(runnerLogPath) {
  if (runnerLogPath === null)
    return {
      why: `this run wrote no live-runner.log, and the aged-reading account (${TURN_ACCOUNT}) is printed only there`,
    };
  let text;
  try {
    text = readFileSync(runnerLogPath, "utf8");
  } catch {
    return { why: `${basename(runnerLogPath)} could not be read back` };
  }
  const line = text
    .split(/\r?\n/u)
    .filter((row) => row.includes(TURN_ACCOUNT) && row.includes("aged readings"))
    .at(-1);
  if (line === undefined)
    return {
      why: `${basename(runnerLogPath)} carries no ${TURN_ACCOUNT} line, so no aged-reading account was published`,
    };
  const count = (pattern) => {
    const found = pattern.exec(line);
    return found === null ? null : Number(found[1]);
  };
  return {
    agedReadings: count(/aged readings (\d+)/u),
    autoObserveOnStale: count(/auto_observe_on_stale (\d+)/u),
    refreshAttemptsSpent: count(/refresh_attempts_spent: (\d+)/u),
    why: null,
    source: basename(runnerLogPath),
  };
}

/**
 * Turns and calls the tool surface charged the model, and nodes the compiler charged the body.
 *
 * Both halves are needed because they are not the same currency: a question costs a MODEL TURN (`round84`: 13 calls in 12
 * turns across observe/look_up/find_destination/plan_shape) while `equip_tool` and `navigate_to_destination` cost body
 * NODES the player never asked for (29 and 3). Counting either as the other prices the tool surface as work.
 */
function measureCognitiveTax({ sessionWalk, result, stale }) {
  const calls = new Map();
  const turnsWithOne = new Set();
  if (sessionWalk !== null)
    for (const [index, turn] of sessionWalk.turns.entries())
      for (const call of turn.calls) {
        if (!COGNITIVE_TAX_TOOLS.includes(call.name)) continue;
        calls.set(call.name, (calls.get(call.name) ?? 0) + 1);
        turnsWithOne.add(index);
      }
  const callCount = [...calls.values()].reduce((total, value) => total + value, 0);
  const nodes = new Map();
  for (const outcome of Array.isArray(result?.programOutcomes) ? result.programOutcomes : [])
    for (const node of Array.isArray(outcome?.nodeOutcomes) ? outcome.nodeOutcomes : []) {
      if (!COGNITIVE_TAX_ACTIONS.includes(node?.actionId)) continue;
      nodes.set(node.actionId, (nodes.get(node.actionId) ?? 0) + 1);
    }
  return {
    calls,
    callCount,
    turns: sessionWalk === null ? null : turnsWithOne.size,
    sessionTurns: sessionWalk === null ? null : sessionWalk.turns.length,
    nodes,
    stale,
  };
}

/**
 * What a delivered turn produced: the useful fraction, and the three ways a turn's work reaches nobody.
 *
 * `turns_per_completed_action 0.53` reads as a healthy run and is not, because the denominator counts every node that
 * reached a terminal state including 22 `plant_seed` attempts that all failed. So the yield is printed against the
 * DELIVERED turns (a batch the Host actually handed over), beside the turns that made no call, the speeches the delivery
 * account dropped for want of a lease, and the programmes whose every node failed.
 */
function measureIntentYield({ result, turns, traceEvents }) {
  const toolSpans = traceEvents.filter((event) => typeof event?.name === "string" && /^stardew_/u.test(event.name));
  const withACall = turns.filter((turn) =>
    toolSpans.some(
      (span) => typeof span.ts === "number" && span.ts / 1000 >= turn.startMs && span.ts / 1000 <= turn.endMs,
    ),
  );
  const parts = result?.presentation?.deliveryAccount?.parts ?? null;
  const suppressed = parts?.suppressed ?? null;
  const dropped = Number.isInteger(suppressed?.no_presentation_lease) ? suppressed.no_presentation_lease : null;
  const programmes = Array.isArray(result?.programOutcomes) ? result.programOutcomes : [];
  const failed = programmes.filter((outcome) => {
    const nodes = Array.isArray(outcome?.nodeOutcomes) ? outcome.nodeOutcomes : [];
    return nodes.length > 0 && nodes.every((node) => node?.state !== "succeeded");
  });
  const families = new Map();
  for (const outcome of programmes)
    for (const node of Array.isArray(outcome?.nodeOutcomes) ? outcome.nodeOutcomes : []) {
      const row = families.get(node?.actionId ?? "unknown") ?? { attempted: 0, succeeded: 0 };
      row.attempted += 1;
      if (node?.state === "succeeded") row.succeeded += 1;
      families.set(node?.actionId ?? "unknown", row);
    }
  const neverSucceeded = [...families.entries()].filter(([, row]) => row.succeeded === 0);
  return {
    delivered: turns.length,
    withACall: withACall.length,
    zeroTool: turns.length - withACall.length,
    speechesProduced: Number.isInteger(parts?.produced) ? parts.produced : null,
    droppedSpeeches: dropped,
    programmes: programmes.length,
    failedProgrammes: failed.length,
    neverSucceeded,
  };
}

/**
 * The residual as a STATE - measured, or the name of the input nobody read - and never as a nullable number.
 *
 * <p>
 * NAMED OR BOUNDED. The four middle buckets are charged on the same window the head and the tail leave, so what they
 * miss is `windowMs - explainedMs`: negative when they charge more than the window holds (two programme windows
 * overlapping, or a published body sum counting steps no programme holds), positive when the window holds seconds no
 * bucket charges. Measured on `round84`: -4,486 ms of a 2,065,870 ms wall - 58,383 ms of "unexplained" was 38,265 ms
 * of run head and 24,604 ms of run tail with 4,486 ms charged twice.
 * </p>
 * <p>
 * A `null` used to travel from here to the verdict as though it were a value, and the verdict then inferred an outcome
 * from it - the absence-as-pass shape `tools/check-live-run-verdict-guards.mjs` exists to catch, and the shape that
 * reported this branch. The state names which input was absent, so the verdict reports that instead of inferring one.
 * </p>
 */
function residualState({ explainedMs, placed }) {
  if (explainedMs === null) return Object.freeze({ state: "not_measured", absent: "explained_buckets" });
  if (placed === null) return Object.freeze({ state: "not_measured", absent: "admission_span" });
  // THE TOLERANCE THIS RUN'S OWN TIMESTAMPS PRODUCE, not a number chosen here: a dispatch is written twice, as a
  // `run-trace.json` admission and as the same node's `result.json` stamp, and the widest disagreement between any two of
  // those pairs is the largest amount by which this run places one instant twice.
  return Object.freeze({
    state: "measured",
    ms: placed.windowMs - explainedMs,
    toleranceMs: placed.clockOffsetSpreadMs,
  });
}

/**
 * Whether the residual is inside what the run's own timestamps can produce: `failed`, `within`, `blocked`, or
 * `not_measured`.
 *
 * <p>
 * A residual is SIGNED and both directions are wrong in their own way: negative means the middle buckets charge more
 * than the window between the first step and the last settlement holds, positive means that window holds seconds no
 * bucket charges. Either way it is judged against the same tolerance, and a run whose residual was never measured is
 * neither green nor red, because a number nobody measured is neither a pass nor a defect: `blocked` when the wall or a
 * bucket above it could not be read, `not_measured` when no admission span placed the body's window.
 * </p>
 */
function residualVerdict({ wallMs, residual }) {
  if (wallMs === null) return "blocked";
  if (residual.state === "not_measured") {
    return residual.absent === "explained_buckets" ? "blocked" : "not_measured";
  }
  return Math.round(Math.abs(residual.ms)) > Math.round(residual.toleranceMs) ? "failed" : "within";
}

export function summarizeStandstill({ runDir, result, sessionWalk, runnerLogPath }) {
  const wallMs =
    Number.isFinite(result?.startedAtMs) && Number.isFinite(result?.endedAtMs) && result.endedAtMs > result.startedAtMs
      ? result.endedAtMs - result.startedAtMs
      : null;
  const trace = readRunTrace(runDir);
  const originMs = traceOriginMs(result);
  const programmes = programmeWindows(result);
  const body = programmes === null ? null : measureBody(programmes);
  const stream = trace.events === null ? null : deliveredTurns(trace.events);
  const medianTurnMs =
    stream === null || stream.turns.length === 0 ? null : median(stream.turns.map((turn) => turn.endMs - turn.startMs));
  const switches = programmes === null || stream === null ? null : programmeSwitches(programmes.windows, stream.turns);
  const placed =
    trace.events === null || programmes === null || originMs === null
      ? null
      : placeBodyWindow({ events: trace.events, windows: programmes.windows, originMs, result });
  // The published sum is the run's own account of the body (it is the number `round84`'s reader had), and it counts both
  // channels: a standalone action's exposure is body time too. The measured sum is the fallback whose population is the
  // programmes alone, and the source line says which one answered.
  const publishedBodyMs = result?.actionCadence?.execMs?.sum;
  const bodyMs = Number.isFinite(publishedBodyMs) ? publishedBodyMs : (body?.measuredMs ?? null);
  const bodySource = Number.isFinite(publishedBodyMs)
    ? `result.json actionCadence.execMs.sum (${String(result.actionCadence?.measured ?? "?")} of ${String(
        result.actionCadence?.actions ?? "?",
      )} actions timed)`
    : "result.json programOutcomes[].executions[] summed here (the bundle published no actionCadence.execMs.sum)";
  // `blocked/modal` is not in this sum: a run that published no pause span measured none of it, so whatever it held is
  // in the residue rather than invented as a zero. The accounted line says so beside the number.
  const explainedMs =
    bodyMs === null || switches === null || body === null
      ? null
      : bodyMs + switches.turnGapMs + switches.queueMs + body.intraMs;
  const unexplainedMs = wallMs === null || explainedMs === null ? null : wallMs - explainedMs;
  const residual = residualState({ explainedMs, placed });
  const programmeLives =
    programmes === null ? [] : programmes.windows.map((window) => window.lastSettledMs - window.firstAtMs);
  return {
    wallMs,
    tracePath: trace.path,
    traceWhy: trace.why,
    body,
    bodyMs,
    bodySource,
    bodyDuty: bodyMs === null || wallMs === null ? null : shareToATenth(bodyMs, wallMs),
    stream,
    medianTurnMs,
    switches,
    placed,
    explainedMs,
    unexplainedMs,
    residual,
    gate: residualVerdict({ wallMs, residual }),
    autonomy: {
      programmeMedianMs: median(programmeLives),
      programmes: programmeLives.length,
      shorterThanATurn: medianTurnMs === null ? null : programmeLives.filter((lifeMs) => lifeMs < medianTurnMs).length,
    },
    tax: measureCognitiveTax({ sessionWalk, result, stale: readStaleAccount(runnerLogPath) }),
    intent: stream === null ? null : measureIntentYield({ result, turns: stream.turns, traceEvents: trace.events }),
  };
}

/** The five readings and the partition, in the order a reader asks for them. */
export function standstillLines(report) {
  const label = (name) => `${name.padEnd(19)}`;
  const statusLabel = (name) => `    ${name.padEnd(18)}`;
  const lines = [];
  const push = (line) => lines.push(line);
  const share = (ms) => (ms === null || report.wallMs === null ? "not_measured" : shareToATenth(ms, report.wallMs));
  push(
    `${label("standstill")} wall ${
      report.wallMs === null
        ? "not_measured (result.json carried no readable startedAtMs..endedAtMs)"
        : seconds(report.wallMs)
    }  <- result.json startedAtMs..endedAtMs, whole run`,
  );
  // 1. THE BODY'S DUTY CYCLE. One number for "how much of the run was she actually working", and the longest single
  // standstill beside it: a duty cycle of 12.6 % says she stood still most of the run, and the longest freeze says whether
  // that was many short waits or one long one.
  if (report.bodyMs === null)
    push(`${label("body")} not_measured (no readable actionCadence.execMs.sum and no programme executions)`);
  else
    push(
      `${label("body")} ${seconds(report.bodyMs)} = ${report.bodyDuty ?? "not_measured"} of the wall${
        report.body?.freeze == null
          ? ""
          : ` · longest single standstill ${seconds(report.body.freeze.gapMs)}, after ${String(
              report.body.freeze.programId,
            )} drained and before the next node was dispatched`
      }${report.body !== null && report.body.untimed > 0 ? ` · ${String(report.body.untimed)} execution(s) carry no terminal stamp (unmeasured, not zero)` : ""}  <- ${report.bodySource}${
        report.body === null ? "" : "; result.json programOutcomes[].executions[] for the standstill"
      }`,
    );
  push(
    `${label("turn_gap")} ${
      report.switches === null
        ? `not_measured (${report.traceWhy ?? "no programme window to compare with a turn"})`
        : `${seconds(report.switches.turnGapMs)} = ${share(report.switches.turnGapMs)} · queue_wait ${seconds(
            report.switches.queueMs,
          )} = ${share(report.switches.queueMs)} over ${String(report.switches.gaps.length)} gap(s) of ${String(
            report.switches.gaps.length + report.switches.inHand,
          )} switch(es)${
            report.switches.inHand === 0
              ? ""
              : `, ${String(report.switches.inHand)} of them overlapped and left no wait`
          }${report.switches.withoutAComposingTurn === 0 ? "" : `, ${String(report.switches.withoutAComposingTurn)} with no turn to charge`}`
    }  <- ${report.tracePath === null ? `no ${RUN_TRACE_NAME}` : basename(report.tracePath)} delivery + turn.tail spans, each gap split by the composing turn's own window`,
  );
  push(
    `${statusLabel("intra_program")} ${
      report.body === null
        ? "not_measured (no programme executions)"
        : `${seconds(report.body.intraMs)} = ${share(report.body.intraMs)} over ${String(report.body.switches)} node switch(es)${
            report.body.switches === 0
              ? ""
              : ` (${String(Math.round(report.body.intraMs / report.body.switches))} ms each)`
          }`
    }  <- result.json programOutcomes[].executions[]: the next node's atMs minus the previous node's settledAtMs, inside one programme`,
  );
  push(
    `${statusLabel("blocked_modal")} not_measured (no artifact records time the world sat paused or on a modal: not actionCadence, not run-trace.json, not result.json)`,
  );
  if (report.placed !== null)
    push(
      `${statusLabel("clock_offset")} ${String(Math.round(report.placed.clockOffsetMs))} ms over ${String(
        report.placed.paired,
      )} of ${String(report.placed.paired + report.placed.unpaired)} node admissions, the pairs spanning ${seconds(
        report.placed.clockOffsetSpreadMs,
      )} (${String(Math.round(report.placed.clockOffsetNarrowestMs))}..${String(
        Math.round(report.placed.clockOffsetWidestMs),
      )} ms)  <- a run-trace.json admission span and the same node's result.json atMs are one dispatch read from two clocks, and they count from different origins, so the split above reads them on one origin as the owning fixture does; the SPAN is the tolerance the residual below is judged against`,
    );
  // THE ACCOUNTING, WITH THE RESIDUE NAMED RATHER THAN ABSORBED. The run's head (before the first step was dispatched) and
  // its tail (after the last one settled) are facts about this run, so they are named; what the four middle buckets miss of
  // the window those two leave is the residual, and its sign says whether they charged too much or too little.
  if (report.explainedMs === null)
    push(
      `${statusLabel("accounted")} not_measured (a bucket above could not be read, so no share of this wall can be priced)`,
    );
  else if (report.residual.state !== "measured")
    push(
      `${statusLabel("accounted")} body ${seconds(report.bodyMs)} + turn gap ${seconds(
        report.switches.turnGapMs,
      )} + queue wait ${seconds(report.switches.queueMs)} + intra-program ${seconds(
        report.body?.intraMs ?? null,
      )} = ${seconds(report.explainedMs)} of the ${seconds(
        report.wallMs,
      )} wall; the other ${seconds(report.unexplainedMs)} cannot be named, because no admission span placed the body's window and so there is no run head and no run tail to name it with`,
    );
  else
    push(
      `${statusLabel("accounted")} body ${seconds(report.bodyMs)} + turn gap ${seconds(
        report.switches.turnGapMs,
      )} + queue wait ${seconds(report.switches.queueMs)} + intra-program ${seconds(
        report.body?.intraMs ?? null,
      )} = ${seconds(report.explainedMs)} of the ${seconds(report.wallMs)} wall; the other ${seconds(
        report.unexplainedMs,
      )} is named rather than assumed: run head ${seconds(report.placed.headMs)} before the first body step + run tail ${seconds(
        report.placed.tailMs,
      )} after the last settlement, which leaves a residual of ${seconds(report.residual.ms)} ${
        Math.round(report.residual.ms) === 0
          ? `- the middle buckets and the ${seconds(report.placed.windowMs)} window those two leave agree to the millisecond`
          : report.residual.ms < 0
            ? `- the middle buckets charging ${seconds(-report.residual.ms)} more than the ${seconds(
                report.placed.windowMs,
              )} window those two leave`
            : `- ${seconds(report.residual.ms)} inside that ${seconds(
                report.placed.windowMs,
              )} window that no bucket charges`
      } (blocked/modal is in no sum here: this run measured none, so whatever it held is in that residual)`,
    );
  // 3. THE AUTONOMY HORIZON. She thinks longer than she acts, and no wake threshold changes that: a programme shorter than
  // one turn has drained before the answer that a wake would carry could arrive.
  push(
    `${label("autonomy_horizon")} ${
      report.autonomy.programmeMedianMs === null || report.medianTurnMs === null
        ? `not_measured (${
            report.autonomy.programmeMedianMs === null ? "no programme window" : "no delivered turn"
          }, so there is nothing to divide)`
        : `${(report.autonomy.programmeMedianMs / report.medianTurnMs).toFixed(2)} = median programme ${seconds(
            report.autonomy.programmeMedianMs,
          )} / median delivered turn ${seconds(report.medianTurnMs)} · ${String(
            report.autonomy.shorterThanATurn,
          )} of ${String(report.autonomy.programmes)} programme(s) are shorter than one turn`
    }  <- result.json programOutcomes[].executions[] (a programme's first atMs to its last settledAtMs) + ${
      report.tracePath === null ? `no ${RUN_TRACE_NAME}` : basename(report.tracePath)
    } delivery + turn.tail spans`,
  );
  // 4. THE COGNITIVE TAX, in the currency each half is actually paid in.
  const tax = report.tax;
  push(
    `${label("cognitive_tax")} ${
      tax.turns === null
        ? "not_measured (no session bound to this run, so no tool call was counted)"
        : `${String(tax.callCount)} call(s) in ${String(tax.turns)} of ${String(
            tax.sessionTurns,
          )} prompt turn(s) on ${COGNITIVE_TAX_TOOLS.join("/")} (${
            [...tax.calls.entries()].map(([name, count]) => `${name} ${String(count)}`).join(", ") || "none"
          })`
    } · ${[...tax.nodes.entries()].map(([actionId, count]) => `${String(count)} node(s) ${actionId}`).join(", ") || `0 node(s) ${COGNITIVE_TAX_ACTIONS.join("/")}`}  <- session assistant toolCall parts + result.json programOutcomes[].nodeOutcomes`,
  );
  push(
    `${statusLabel("stale_refresh")} ${
      tax.stale.why !== null
        ? `not_measured (${tax.stale.why})`
        : `${String(tax.stale.agedReadings)} aged reading(s) · auto_observe_on_stale ${String(
            tax.stale.autoObserveOnStale,
          )} · refresh_attempts_spent ${String(tax.stale.refreshAttemptsSpent)}  <- ${tax.stale.source} ${TURN_ACCOUNT}`
    }`,
  );
  // 5. THE INTENT YIELD: what a delivered turn actually produced, against the three ways its work reaches nobody.
  push(
    `${label("intent_yield")} ${
      report.intent === null
        ? `not_measured (${report.traceWhy ?? "no delivered turn to read"})`
        : `${String(report.intent.withACall)} of ${String(report.intent.delivered)} delivered turn(s) carried a tool call (${
            report.intent.delivered === 0
              ? "not_measured"
              : shareToATenth(report.intent.withACall, report.intent.delivered)
          }) · ${String(report.intent.zeroTool)} made no call · ${
            report.intent.droppedSpeeches === null
              ? "speech drops not_measured (result.json presentation.deliveryAccount.parts.suppressed was not published)"
              : `${String(report.intent.droppedSpeeches)} of ${String(
                  report.intent.speechesProduced ?? "?",
                )} produced speeches dropped (no_presentation_lease)`
          } · ${String(report.intent.failedProgrammes)} of ${String(
            report.intent.programmes,
          )} programme(s) had no successful node${
            report.intent.neverSucceeded.length === 0
              ? ""
              : ` (${report.intent.neverSucceeded
                  .map(([actionId, row]) => `${actionId} ${String(row.succeeded)} of ${String(row.attempted)}`)
                  .join(", ")})`
          }`
    }  <- ${report.tracePath === null ? `no ${RUN_TRACE_NAME}` : basename(report.tracePath)} delivery spans x stardew_* tool spans; result.json presentation.deliveryAccount.parts and programOutcomes[].nodeOutcomes`,
  );
  lines.push(...standstillGateLines(report));
  return lines;
}

/**
 * The gate: every millisecond of the wall either NAMED or BOUNDED, and the two printed as different numbers.
 *
 * <p>
 * NAMED: the run's head, before its first body step, and its tail, after its last settlement, are facts about this run.
 * A partition that calls them "unexplained" reads a clean run as a broken one - measured on `round84`, whose 58,383 ms
 * of residue was 38,265 ms of head plus 24,604 ms of tail with 4,486 ms charged twice, and the old gate failed it for
 * 2.8 % of its wall clock that was not error at all.
 * </p>
 * <p>
 * BOUNDED: with head and tail named as buckets, what is left is the disagreement between the two clocks this block reads,
 * and the run measures that disagreement itself - the swing of the per-admission offsets between `run-trace.json` and
 * `result.json` - so the residual is judged against the largest amount THIS run could misplace an instant by. A run
 * whose two sources agree exactly gets a tolerance of 0 ms and must partition its wall exactly.
 * </p>
 * <p>
 * The four middle buckets and the two named ones print on the line with their milliseconds; over the tolerance the gate
 * fails and names the stretch, with its start, its end and what the body was doing there, so a remainder is something a
 * reader can chase rather than one authoritative number. `blocked/modal` stays `not_measured` and is in no sum: a bucket
 * nobody measured is not a bucket measured as zero.
 * </p>
 */
export function standstillGateLines(report) {
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "an unreported time");
  const ms = (value) => (value === null ? "not_measured" : String(Math.round(value)));
  const placed = report.placed;
  const residual = report.residual;
  const toleranceWhy =
    placed === null
      ? "no admission span paired the two clocks, so this run states no skew of its own"
      : `the widest disagreement between the two clocks this run reads: ${String(placed.paired)} node admissions paired a run-trace.json span with the same node's result.json stamp, and the offsets span ${String(
          Math.round(placed.clockOffsetNarrowestMs),
        )}..${String(Math.round(placed.clockOffsetWidestMs))} ms`;
  const parts = [
    `named ${placed === null ? "not_measured" : ms(placed.headMs + placed.tailMs)}${
      placed === null ? "" : ` (run head ${ms(placed.headMs)} + run tail ${ms(placed.tailMs)})`
    }`,
    `body ${ms(report.bodyMs)}`,
    `turn gap ${ms(report.switches === null ? null : report.switches.turnGapMs)}`,
    `queue wait ${ms(report.switches === null ? null : report.switches.queueMs)}`,
    `intra-program ${ms(report.body === null ? null : report.body.intraMs)}`,
    `blocked/modal not_measured`,
    `residual ${residual.state === "measured" ? ms(residual.ms) : "not_measured"}`,
    `tolerance ${residual.state === "measured" ? ms(residual.toleranceMs) : "not_measured"} (${toleranceWhy})`,
  ];
  if (report.wallMs === null)
    return [
      `  ${STANDSTILL_GATE}:blocked - result.json published no readable startedAtMs..endedAtMs, so there is no wall clock to attribute and nothing here is green`,
    ];
  const line = `  ${STANDSTILL_GATE} wall ${ms(report.wallMs)} · ${parts.join(" · ")}`;
  if (report.gate === "blocked")
    return [
      line,
      `  ${STANDSTILL_GATE}:blocked - a bucket above could not be read, so whether the residual is inside the tolerance is not_measured rather than green`,
    ];
  // A run whose body window was never placed cannot name its head or its tail at all, so the residual is never measured:
  // it is reported as `not_measured` with the input that was absent, which is neither green nor a finding.
  if (residual.state === "not_measured")
    return [
      line,
      `  ${STANDSTILL_GATE}:not_measured:${residual.absent} - ${ms(report.unexplainedMs)} ms of the ${ms(
        report.wallMs,
      )} ms wall is in no bucket (${
        report.wallMs === 0 ? "not_measured" : shareToATenth(report.unexplainedMs, report.wallMs)
      }), and no admission span placed the body's window, so there is no run head and no run tail to name it with: the residual was never measured`,
    ];
  if (report.gate === "within")
    return [
      line,
      `  ${STANDSTILL_GATE}:within ${ms(residual.ms)} ms of the ${ms(report.wallMs)} ms wall is in no bucket (${
        report.wallMs === 0 ? "not_measured" : shareToATenth(residual.ms, report.wallMs)
      }) and inside the ${ms(residual.toleranceMs)} ms this run's own timestamps can misplace an instant by, so it is alignment error and not a finding: run head ${seconds(
        placed.headMs,
      )} before the first body step and run tail ${seconds(
        placed.tailMs,
      )} after the last settlement are named, and the middle buckets ${
        Math.round(residual.ms) === 0
          ? "fill their window exactly"
          : residual.ms < 0
            ? "charge more than their window holds"
            : "leave part of their window uncharged"
      }`,
    ];
  // The failure: the stretch, located. A negative residual over-charges the window the head and the tail leave; a positive
  // one leaves seconds inside it, and the two clocks put the window's ends apart - so the end that disagrees most is where
  // the uncharged stretch is.
  const headSkew = placed.firstSkewMs;
  const tailSkew = placed.lastSkewMs;
  const atHead = Number.isFinite(headSkew) && (!Number.isFinite(tailSkew) || Math.abs(headSkew) >= Math.abs(tailSkew));
  let stretch;
  if (residual.ms < 0)
    stretch = `no middle stretch is unnamed - the buckets charge ${seconds(-residual.ms)} more than the ${seconds(
      placed.windowMs,
    )} window between the first step at ${iso(placed.firstWallMs)} and the last settlement at ${iso(
      placed.lastWallMs,
    )}${
      report.switches.inHand === 0
        ? " and no two programme windows overlapped, so a bucket counts seconds its own executions do not hold"
        : `, where ${String(report.switches.inHand)} of ${String(
            report.switches.gaps.length + report.switches.inHand,
          )} programme switch(es) overlapped and two windows counted the same seconds`
    }`;
  else if (atHead)
    stretch = `the largest stretch no bucket covers is ${seconds(
      Math.abs(headSkew),
    )} from ${iso(placed.firstWallMs - headSkew)} to ${iso(placed.firstWallMs)}, where the two clocks disagree about the first step: the journal records it at the left instant and the trace at the right, and nothing in the run was working in between`;
  else
    stretch = `the largest stretch no bucket covers is ${seconds(
      Math.abs(tailSkew),
    )} from ${iso(placed.lastWallMs - tailSkew)} to ${iso(placed.lastWallMs)}, where the two clocks disagree about the last settlement: the journal records the body drained at the left instant and the trace holds it working until the right`;
  return [
    line,
    `  ${STANDSTILL_GATE}:residual ${ms(residual.ms)} ms of the ${ms(report.wallMs)} ms wall is in no bucket (${
      report.wallMs === 0 ? "not_measured" : shareToATenth(residual.ms, report.wallMs)
    }), past the ${ms(residual.toleranceMs)} ms tolerance this run's own timestamps allow - ${stretch}`,
  ];
}
