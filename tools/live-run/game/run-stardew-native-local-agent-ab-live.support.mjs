// red-proof: inject  dropping the `other_player_owns_the_barrier` witness in night-verdict.mjs ->
//   `AssertionError: she declared locally ready: got companion_sleep_refused:requires_other_player` at
//   tools/live-run/game/run-stardew-native-local-agent-ab-live.test.mjs:2715
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STARDEW_ACTION_TOOL_NAMES } from "../../../host/dist-test/action-registry.js";
import {
  actionBreadthClause,
  buildSnapshotCensus,
  measureActionBreadth,
  readActionBreadthSurface,
} from "../../lib/action-breadth.mjs";
import { appendTurnMemory, summarizeHostMemory, turnMemoryPoint } from "../../lib/live-run-memory.mjs";
import { sweepTaskPrompts } from "../../lib/multiday-daily-tasks.mjs";
import { decideDayWake, WAKE_REASON, WAKE_REASONS } from "../../lib/multiday-loop.mjs";
import { deliveryAccountClause, summarizeDeliveryAccount } from "../../lib/presentation-delivery-account.mjs";
import { describeRunCost, summarizeRunCost } from "../../lib/run-cost-account.mjs";
import { sessionEntries } from "../../lib/session-jsonl.mjs";
import { executedActionIds, executionTraceInvariant, programExecutionRows } from "./execution-trace.mjs";
import { createGameClock } from "./game-clock.mjs";
import { shouldAbandonTurnForTransport } from "./transport-loss.mjs";
import { attributeTurnSpeech } from "./turn-speech.mjs";
import { publishCadence } from "./action-cadence-reading.mjs";

// The support the runner's own assertions read: the sources they compare against, the extractors that evaluate a
// declaration on its own, and the fixtures a scenario needs. Declarations only - nothing here asserts anything, so the
// two test files that import it keep their assertions where they read.

export const RUNNER_SOURCE = await readFile(
  new URL("./run-stardew-native-local-agent-ab-live.mjs", import.meta.url),
  "utf8",
);

// The modules the runner composes. `RUNNER_SOURCE` stays the FILE - an assertion about a call site still reads the
// runner that makes the call - and the surface is the code that file calls, so a declaration that moved to a module is
// read from the module that now owns it, with its own text.
export const RUNNER_SURFACE_SOURCES = await Promise.all(
  [
    "agent-session-record.mjs",
    "assembled-context-evidence.mjs",
    "capability-audit.mjs",
    "day-opening.mjs",
    "game-process-samplers.mjs",
    "mod-log-decoding.mjs",
    "night-watch-bounds.mjs",
    "run-verdicts.mjs",
  ].map((name) => readFile(new URL(`./${name}`, import.meta.url), "utf8")),
);

export const RUNNER_SURFACE_SOURCE = [RUNNER_SOURCE, ...RUNNER_SURFACE_SOURCES].join("\n");

// The launch begins before the runner exists, so the steps the RUNNER cannot see (the save copy, the deploy, the game's
// own start) are measured by the launcher and asserted here against ITS source, not the runner's.
export const LAUNCHER_SOURCE = await readFile(new URL("./launch-ladder-live.mjs", import.meta.url), "utf8");

/**
 * What the presentation evidence is in the fixtures below: nothing presented, and an account that says exactly that.
 *
 * `buildRunResult` decides its `delivery_account` clause on this object, so a fixture that stubbed it as `{ pieces: [] }`
 * would be a run whose account cannot be READ - which is blocked by name (`delivery_account_absent`), never passed.
 */
export const NOTHING_PRESENTED = Object.freeze({
  pieces: [],
  deliveryAccount: summarizeDeliveryAccount({ records: [], bubblesProduced: 0 }),
});

// The baseline module's own text: the night-fact reader lives there (one authority for the minted `night_ended_*` shape),
// so the assertion about how that shape is read belongs to the module rather than to the runner that calls it.
export const NIGHT_FACTS_SOURCE = await readFile(new URL("../../lib/multiday-baseline.mjs", import.meta.url), "utf8");

// The program tool's description is presented material, but the runner mounts the Host's tool definitions rather
// than authoring them, so the one copy lives in the materializer. Read (never write) it here to falsify its content.
export const HOST_MATERIALIZER_SOURCE = await readFile(
  new URL(
    "../../../host/src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts",
    import.meta.url,
  ),
  "utf8",
);

/** The opening scenario's own prompt text: the task the run presents first, and nothing else. */
export function extractOpeningTaskPrompt(source) {
  const start = source.indexOf("morning_routine: Object.freeze({");
  const end = source.indexOf("memory_covenant: Object.freeze({");
  assert.ok(start >= 0 && end > start, "the runner must define the opening scenario's prompt");
  return source.slice(start, end);
}

/** The `description` literal that belongs to `stardew_submit_action_program`, delimited by its own tool body. */
export function extractProgramToolDescription(source) {
  const toolAt = source.indexOf('"stardew_submit_action_program"');
  const descriptionAt = source.indexOf("description:", toolAt);
  const end = source.indexOf("parameters: bodyProgramToolParameters(", descriptionAt);
  assert.ok(toolAt >= 0 && descriptionAt > toolAt && end > descriptionAt, "the program tool must have a description");
  return source.slice(descriptionAt, end);
}

/** The runner's rung-clause list, sliced out so a test can read the declarations the verdict is built from. */
export function rungClauseList(source) {
  const start = source.indexOf("const rungClauses = Object.freeze([");
  const end = source.indexOf("const result = await buildRunResult({\n    rungClauses,");
  assert.ok(start >= 0 && end > start, "the runner must declare its rung clauses in one list, and pass them");
  return source.slice(start, end);
}

/**
 * Extracts a named top-level function's exact source text from the runner, so
 * the structure test can run the REAL predicate instead of a paraphrase. The
 * runner module never loads here (top-level live side effects), so the function
 * text is evaluated in isolation; it must therefore be free of closures.
 */
export function extractRunnerFunction(source, name, bindings = {}) {
  // An array of names compiles ALL of them into one scope, so a helper that a tested function calls is
  // evaluated with it. Without this, an extracted copy referenced a function that only existed in the
  // runner file and the behavioural test failed for a reason that had nothing to do with the behaviour.
  if (Array.isArray(name)) {
    const parts = name.map((one) => extractRunnerFunction(source, one).source);
    const names = Object.keys(bindings);
    const functions = new Function(...names, `${parts.join("\n")}\nreturn [${name.join(", ")}];`)(
      ...names.map((key) => bindings[key]),
    );
    // Carry each declaration's own text, so a test that reads `.source` of one of several composed functions gets THAT
    // function's declaration instead of `undefined`.
    name.forEach((_one, index) =>
      Object.defineProperty(functions[index], "source", { value: parts[index], enumerable: false }),
    );
    return functions;
  }
  const marker = `function ${name}`;
  const declarationAt = source.indexOf(marker);
  assert.ok(declarationAt !== -1, `runner must define ${name}`);
  // The declaration's own `async` modifier is part of it: a slice that started at `function` would drop it, and the
  // body's `await` would no longer parse inside the wrapper.
  const start =
    source.slice(Math.max(0, declarationAt - 6), declarationAt) === "async " ? declarationAt - 6 : declarationAt;
  // The body opens at the first `{` OUTSIDE the parameter list: a destructured
  // parameter (`function f({ a, b })`) makes the obvious "first brace after the
  // name" land inside the signature and truncate the extraction before the body.
  let parenDepth = 0;
  let bodyOpen = -1;
  for (let index = declarationAt + marker.length; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "{" && parenDepth === 0) {
      bodyOpen = index;
      break;
    }
  }
  assert.ok(bodyOpen !== -1, `runner function ${name} must have a body`);
  let depth = 0;
  let end = bodyOpen;
  for (; end < source.length; end += 1) {
    if (source[end] === "{") depth += 1;
    else if (source[end] === "}") {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }
  // Include the signature from the name through the body so the evaluated text is
  // a complete declaration.
  const body = source.slice(start, end);
  // A helper the extracted function calls from ANOTHER module (rather than from the runner file) is handed in as a
  // binding: the tested function then runs against the real implementation instead of throwing a ReferenceError into
  // its own catch block, which answers "the fallback was used" to a question nobody asked.
  const globals = Object.keys(bindings);
  const value = new Function(...globals, `${body}\nreturn ${name};`)(...globals.map((key) => bindings[key]));
  // Carry the declaration text so several declarations can be composed into one scope.
  Object.defineProperty(value, "source", { value: body, enumerable: false });
  return value;
}

/**
 * The runner's REAL `runAgentTurn`, in a scope a test controls.
 *
 * Every name here is part of the turn's module surface, and the list is one spelling because two of them had already
 * drifted: an eval that carried neither `sampleHostMemory`, `appendTurnMemory` nor `turnMemoryPoint` could not run the
 * turn at all (`round40`'s sampler commit referenced a name its own test scope never carried), and `transportAbandonCause`
 * joined that surface when round46's abandon reason started being recorded on the turn.
 */
export function loadRunAgentTurn({
  actionTrace = [],
  factLog = [],
  programSubmissions = [],
  client,
  presentedSummary = "",
  scenario = "multiday_routine",
  sampleAdvertisedActions = () => {},
  submitPlayerPrompt,
  sampleModHeartbeat = () => ({ count: 1, sinceMs: 0, line: "DEBUG-native-local-heartbeat", silentMs: 0 }),
  modHeartbeatStallMs,
  bridgeDisconnections = Object.freeze([]),
  bridgeDiagnostics = [],
  waitForSessionQuiet = async (turn) => turn,
  sampleHostMemory = () => ({ rssMb: 316, freeMb: 2048, heapUsedMb: 208 }),
}) {
  const build = new Function(
    "actionTrace",
    "factLog",
    "programSubmissions",
    "client",
    "presentedSummary",
    "SCENARIO",
    "sampleAdvertisedActions",
    "submitPlayerPrompt",
    "shouldAbandonTurnForTransport",
    "sampleModHeartbeat",
    "MOD_HEARTBEAT_STALL_MS",
    "bridgeDisconnections",
    "waitForSessionQuiet",
    "WAKE_REASONS",
    "sampleHostMemory",
    "appendTurnMemory",
    "turnMemoryPoint",
    "diagnostics",
    `let worldStallReason = null;
// The run's own progress record (../core/run-progress.mjs): null until the capture shows where it writes,
// which is the runner's own initial value. A turn that records progress starts from this state.
let progress = null;
let turnStartedAtMs = null;
let agentTurnCount = 0;
const bridgeDiagnostics = diagnostics;
const hostMemory = { turns: [], turnsOmitted: 0 };
const runSessionRecord = Object.freeze({ path: undefined, reason: "no_session_record_for_run_surface_session" });
${extractRunnerFunction(RUNNER_SURFACE_SOURCE, "transportAbandonCause").source}
${extractRunnerFunction(RUNNER_SURFACE_SOURCE, "runAgentTurn").source}
return { runAgentTurn, stall: () => worldStallReason, memory: () => hostMemory };`,
  );
  return build(
    actionTrace,
    factLog,
    programSubmissions,
    client,
    presentedSummary,
    scenario,
    sampleAdvertisedActions,
    submitPlayerPrompt,
    shouldAbandonTurnForTransport,
    sampleModHeartbeat,
    modHeartbeatStallMs,
    bridgeDisconnections,
    waitForSessionQuiet,
    WAKE_REASONS,
    sampleHostMemory,
    appendTurnMemory,
    turnMemoryPoint,
    bridgeDiagnostics,
  );
}

// ── the launch sequence, on one clock, in one line shape ──────────────────────────────────────────────────────────────
// "Why is startup slow" was unanswerable from the log: the runner's first line was its first bridge frame, so the save
// copy, the deploy, the game's own load and the runner's imports arrived as one blank (round55: the log's first phase-ish
// number was 25,750ms in, and nothing said which step cost it). The instrument that replaced the blank is one line per
// phase, all on the launcher's clock, so a reader SUBTRACTS instead of guessing. These guards hold the instrument: the
// line shape, the clock, and the fact that every step the launch performs actually emits one.
export const LAUNCHER_OWNED_PHASES = new Set([
  "launcher_start",
  "prompt_surface_checked",
  "fixture_free",
  "clean_done",
  "save_template_copied",
  "deploy_done",
  "orchestrator_spawned",
  "game_launched",
]);

export const REQUIRED_LAUNCH_PHASES = Object.freeze([
  ...LAUNCHER_OWNED_PHASES,
  "runner_process_start",
  "module_eval_start",
  "environment_facts_done",
  "bridge_connected",
  "first_frame_dispatched",
  "persona_mounted",
  "provider_wait",
  "first_model_response",
]);

/**
 * One module-scope `const NAME = <expr>;` declaration from the runner's own source.
 *
 * By NAME, not by position: the runner declares its tool-timing constants with the run's record above the failure
 * hooks (`Cannot access 'TOOL_TIMING_LONGEST_LIMIT' before initialization` is what the dump used to throw for a run that
 * died early), so a slice "from the first constant to the categorizer" no longer spans them and the extraction has to
 * follow each declaration wherever it now lives.
 */
export function extractRunnerConstant(source, name) {
  const at = source.indexOf(`const ${name} =`);
  assert.ok(at !== -1, `runner must declare ${name}`);
  let depth = 0;
  for (let index = at; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === ";" && depth === 0) return source.slice(at, index + 1);
  }
  throw new Error(`unterminated declaration for ${name}`);
}

/**
 * The tool-timing block - its constants and the functions that read them - evaluated on its own, so a categorization
 * can be tested against a real session record instead of against a regex. The runner module never loads here, so the
 * Host's tool-name table is supplied as a global.
 */
export function loadToolTiming(source) {
  const constants = [
    "TOOL_TIMING_LONGEST_LIMIT",
    "TOOL_TIMING_INVARIANT_VIOLATED",
    "TOOL_TIMING_CATEGORIES",
    "DELEGATE_TOOL_NAME",
    "PLAN_SHAPE_TOOL_NAMES",
    "PLAN_WORK_TOOL_NAMES",
    "PROGRAM_SUBMIT_TOOL_NAMES",
    "PROGRAM_STATUS_TOOL_NAMES",
    "ACTION_TOOL_NAMES",
    "PLAN_TOOL_NAMES",
  ]
    .map((name) => extractRunnerConstant(source, name))
    .join("\n");
  const functions = [
    "toolTimingCategory",
    "emptyCategoryTiming",
    "summarizeCategoryTiming",
    "toolTimingInvariant",
    "readToolTiming",
  ]
    .map((name) => extractRunnerFunction(source, name).source)
    .join("\n");
  return new Function(
    "STARDEW_ACTION_TOOL_NAMES",
    "readFileSync",
    "sessionEntries",
    `${constants}\n${functions}\nreturn { TOOL_TIMING_CATEGORIES, toolTimingCategory, toolTimingInvariant, readToolTiming };`,
  )(STARDEW_ACTION_TOOL_NAMES, readFileSync, sessionEntries);
}

export function writeSessionRecord(names) {
  const file = join(tmpdir(), `gb-ladder-tool-timing-${randomUUID()}.jsonl`);
  const entries = [];
  let atMs = Date.parse("2026-10-22T10:00:00.000Z");
  for (const [index, name] of names.entries()) {
    const id = `call-${index}`;
    atMs += 10;
    entries.push({
      type: "message",
      timestamp: new Date(atMs).toISOString(),
      message: { role: "assistant", content: [{ type: "toolCall", id, name }] },
    });
    atMs += 20;
    entries.push({
      type: "message",
      timestamp: new Date(atMs).toISOString(),
      message: { role: "toolResult", toolCallId: id, content: "ok" },
    });
  }
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
  return file;
}

/** A session record file with `names.length` tool calls, written where the caller says: the binding is a path fact. */
export function writeSessionRecordAt(path, names) {
  const entries = [];
  let atMs = Date.parse("2026-10-22T10:00:00.000Z");
  for (const [index, name] of names.entries()) {
    const id = `call-${index}`;
    atMs += 10;
    entries.push({
      type: "message",
      timestamp: new Date(atMs).toISOString(),
      message: { role: "assistant", content: [{ type: "toolCall", id, name }] },
    });
    atMs += 20;
    entries.push({
      type: "message",
      timestamp: new Date(atMs).toISOString(),
      message: { role: "toolResult", toolCallId: id, content: "ok" },
    });
  }
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
  return path;
}

/** The run-scoped session selection, evaluated with the fs readers it uses: its binding is a real directory layout. */
export function loadRunSessionSelection(source) {
  const [findRunSessionJsonl] = extractRunnerFunction(source, ["findRunSessionJsonl"], { readdirSync, join });
  return findRunSessionJsonl;
}

/** Every `.jsonl` under a runtime root, newest file name last: what a root-wide "newest wins" reader would pick. */
export function newestJsonlUnder(root) {
  const files = [];
  const collect = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.name.endsWith(".jsonl")) files.push({ path, file: entry.name });
    }
  };
  collect(root);
  files.sort((left, right) => left.file.localeCompare(right.file));
  return files[files.length - 1];
}

/**
 * The night watch's cadence, read off the runner's own `watchRollover` call site.
 *
 * A string answer rather than a boolean, because a red gate has to say which of the two defects it found: the timer put
 * back (`timer`), or the trigger gone so the loop falls back to its ceiling alone (`no_trigger`).
 */
export function nightWatchCadence(source) {
  const start = source.indexOf("watchRollover(world, {");
  if (start < 0) return "no_watch_call_site";
  const end = source.indexOf("}),", start);
  const site = source.slice(start, end < 0 ? undefined : end);
  if (/pollIntervalMs/u.test(site)) return "timer";
  if (!/waitForLook: \(ceilingMs\) => worldFacts\.wait\(ceilingMs\)/u.test(site)) return "no_trigger";
  return "world_facts";
}

/**
 * The RECORDED shape a receipt takes in the fact log: its identity flattened onto the entry and the receipt itself
 * kept whole under `worldFactPayload` (`recordedReceipt`). One spelling, because several night fixtures need it.
 */
export const asRecordedFact = (receipt) =>
  Object.freeze({
    type: "execution_receipt",
    reasonCode: receipt.reasonCode,
    requestId: receipt.requestId,
    executionId: receipt.executionId,
    evidence: receipt.evidence,
    worldFactPayload: receipt,
  });

/** One `execution_receipt` fact exactly as the runner's recorder projects it: identity flattened, receipt kept whole. */
export function recordedActionReceipt(actionId, reasonCode, state = "succeeded", requestId = `req_${actionId}`) {
  const receipt = {
    executionId: `exec_${requestId}`,
    requestId,
    actionId,
    state,
    reasonCode,
    revision: 1,
    evidence: null,
  };
  return {
    type: "execution_receipt",
    reasonCode,
    requestId,
    executionId: receipt.executionId,
    worldFactPayload: receipt,
  };
}

/**
 * The instrument globals `buildRunResult` reads: the run's memory sampler, the projection it publishes, and the ONE path
 * its result is written to. Real implementations, not doubles - the projection is asserted on its own in
 * `tools/lib/live-run-memory.test.mjs`, and a double here would let the assembly publish a series nobody measured.
 */
export const instrumentGlobals = Object.freeze({
  hostMemory: Object.freeze({
    samples: 0,
    startRssMb: null,
    minRssMb: null,
    maxHostRssMb: null,
    minFreeMb: null,
    turns: [],
    turnsOmitted: 0,
  }),
  summarizeHostMemory,
  RESULT_FILE: "/tmp/gb-runner-result.json",
  // The input manifest. Its own suite drives the real builder against a real session record; here the call is recorded,
  // because a test that assembles a result does not own the directory the manifest would be written to.
  writeInputManifest: (call) =>
    Object.freeze({ state: "written", reasonCode: null, path: call.resultPath, sections: 1, bytes: 1 }),
  // The world's own clock, as the run sampled it, and the facts it recorded over that span. Both are read by
  // `buildRunResult` on every path, so a test that assembles a result has to supply them: the sampler here is MEASURED
  // (two readings, the clock between them), so a fixture that does not care about the clock is not blocked by it.
  gameClock: (() => {
    const clock = createGameClock({ now: () => 1_000 });
    clock.observe(Object.freeze({ timeOfDay: 600, dayOfMonth: 1, seasonIndex: 0, year: 1, revision: 1 }));
    clock.observe(Object.freeze({ timeOfDay: 660, dayOfMonth: 1, seasonIndex: 0, year: 1, revision: 2 }));
    return clock;
  })(),
  factLog: [],
  // THE TWO READINGS THE RUNNER PUBLISHES FROM ITS OWN RECORDS, as the real modules: which lines a turn spoke
  // (`./turn-speech.mjs`, closed at the next turn's start) and whether `thinkMs` can answer the thinking question
  // (`./action-cadence-reading.mjs`). A double here would let a fixture publish a `spokenLines` or a `thinkMs` the
  // runner could never produce, which is exactly the shape this pair was written to stop.
  attributeTurnSpeech,
  publishCadence,
});

/** The globals `buildRunResult` reads besides the ones a test supplies, kept in one place for the reason tests below. */
export function builderGlobals(overrides = {}) {
  return {
    ...instrumentGlobals,
    executedActionIds,
    // The breadth reading and its clause, both imported by the runner: `buildRunResult` derives the reading once and
    // hands it to its own clause, so a test of the builder supplies the real implementations. The surface and the
    // census builder are real too - the denominator of a run is its OWN published census, and a double here would let
    // a test pass against a world the runner could never produce.
    measureActionBreadth,
    actionBreadthClause,
    deliveryAccountClause,
    readActionBreadthSurface,
    buildSnapshotCensus,
    snapshotFamilyRows: new Map(),
    snapshotToolCategories: new Set(),
    snapshotCensusSamples: 0,
    NON_ACCOMPLISHMENT_ACTIONS: new Set(["move_to_tile"]),
    phaseTimings: { runStartedAtMs: 1, marks: {} },
    lastObservedSnapshot: null,
    lastObservedPose: null,
    actionTrace: [],
    programSubmissions: [],
    programOutcomes: [],
    sampleProgramOutcomes: async () => [],
    programExecutionRows,
    executionTraceInvariant,
    TOOL_TIMING_INVARIANT_VIOLATED: "TOOL_TIMING_INVARIANT_VIOLATED",
    multidayOutcome: null,
    SCENARIO: "multiday_routine",
    LEGACY_LADDER: null,
    historianRubricOutcome: null,
    runSessionRecord: Object.freeze({ path: undefined, reason: "no_session_record_for_run_surface_session" }),
    summarizeActionCadence: () => ({ spans: [] }),
    summarizePresentationEvidence: () => NOTHING_PRESENTED,
    readToolTiming: () => ({ observed: false, invariant: { checked: false, ok: null } }),
    summarizeRunCost,
    describeRunCost,
    buildFailureSnapshot: (input) => input,
    writeRunBundle: async () => ({ state: "written", runDir: "/run" }),
    closeCapture: async () => ({ state: "closed" }),
    writeFile: async () => {},
    join: (...parts) => parts.join("/"),
    ...overrides,
  };
}

/** ROUND38'S OWN CLAUSE LIST, in the order the runner declares it (measured 2026-11-06). */
export const ROUND38_CLAUSES = Object.freeze([
  { id: "morning_routine", passed: true, reasonCode: "multiday_routine_blocked" },
  { id: "memory_covenant", passed: true, reasonCode: "covenant_not_honoured" },
  { id: "npc_social_and_presence", passed: true, reasonCode: "harvest_and_offer_not_delivered" },
  { id: "multiday_routine", passed: true, reasonCode: "multiday_routine_blocked" },
  { id: "context", passed: true, reasonCode: "no_expectation_configured" },
  { id: "content", passed: true, reasonCode: "no_expectation_configured" },
  { id: "world_book", passed: true, reasonCode: "product_has_no_world_book_configured" },
  { id: "companion_interaction", passed: false, reasonCode: "summary_too_long" },
  { id: "historian_rubric", passed: true, reasonCode: "historian_rubric_passed" },
]);

/**
 * A clock sampler fed the snapshots a bridge would admit: a NEW frozen object per read, which is how
 * `local-stardew-bridge.ts` stores one (`this.#snapshot = Object.freeze({ ...snapshot, ... })`) and what makes two
 * samples of one snapshot a single reading.
 */
export const clockFrom = (...timesOfDay) => {
  const clock = createGameClock({ now: () => 1_000 });
  timesOfDay.forEach((timeOfDay, index) =>
    clock.observe(Object.freeze({ timeOfDay, dayOfMonth: 1, seasonIndex: 0, year: 1, revision: index + 1 })),
  );
  return clock;
};

/** Every clause of the rung satisfied: what a run looks like when only the world's own clock is against it. */
export const ALL_CLAUSES_PASSED = ROUND38_CLAUSES.map((clause) => ({ ...clause, passed: true }));

// WHAT MAY WAKE HER: a gate over every place the runner can put a prompt in front of the model.
//
// The population is the RUNNER'S OWN SOURCE, scanned for prompt calls, not a list someone maintains: a call site added
// next month is examined without anyone remembering to add it here. Each one must declare one of the five wake reasons,
// and the reason set itself is guarded against quiet growth by requiring a producer a test can actually reach.
export const RUNNER_FILE = "tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs";

export const PROMPT_CALL = "runAgentTurn(";

/** The runner's source with comment CONTENT blanked, so a comment that mentions a call is not read as one.
 *
 * Blanked rather than deleted: every newline survives, so the line a failure names is the line a reader can open.
 */
export function withoutComments(source) {
  const kept = [...source];
  const blank = (from, to) => {
    for (let at = from; at < to && at < kept.length; at += 1) if (kept[at] !== "\n") kept[at] = " ";
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const start = index;
      while (index < source.length && source[index] !== "\n") index += 1;
      blank(start, index);
      continue;
    }
    if (char === "/" && next === "*") {
      const start = index;
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index = Math.min(index + 2, source.length);
      blank(start, index);
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return kept.join("");
}

/** One call's argument list, from the opening parenthesis to its match, with strings left intact. */
export function callArguments(source, parenAt) {
  let depth = 0;
  for (let index = parenAt; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < source.length && source[index] !== quote) index += source[index] === "\\" ? 2 : 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(parenAt, index + 1);
    }
  }
  return source.slice(parenAt);
}

/** Every place the runner can prompt the model: the call, and the line it starts on. */
export function promptCallSites(source) {
  const code = withoutComments(source);
  const sites = [];
  for (let at = code.indexOf(PROMPT_CALL); at >= 0; at = code.indexOf(PROMPT_CALL, at + 1)) {
    // The definition is not a call site.
    if (code.slice(Math.max(0, at - "function ".length), at) === "function ") continue;
    sites.push({ line: code.slice(0, at).split("\n").length, text: callArguments(code, at + PROMPT_CALL.length - 1) });
  }
  return sites;
}

/** The wake reason one call site declares, or null when it declares none. */
export function declaredWakeReason(text) {
  // `wake.reason` is a DERIVED declaration: the day loop's prompt carries the answer `decideDayWake` gave, and
  // `runAgentTurn` refuses anything outside the set at run time, so the reason cannot be anything the set does not name.
  // The structural test above is what keeps `wake` the decision's own answer rather than something else called `wake`.
  const match = /reason:\s*(?:wake\.reason|WAKE_REASON\.([A-Za-z]+)|"([a-z_]+)")/u.exec(text);
  if (match === null) return null;
  if (/reason:\s*wake\.reason/u.test(text)) return "wake.reason";
  return match[1] === undefined ? match[2] : (WAKE_REASON[match[1]] ?? `WAKE_REASON.${match[1]}`);
}

/** What a call site's declaration must be: a member of the set, or the decision's own answer. */
export const isDeclaredWakeReason = (reason) => reason === "wake.reason" || WAKE_REASONS.includes(reason);

/** The day turn, which is where a settlement could turn into a prompt. */
export function dayTurnSource(source) {
  const start = source.indexOf("dayTurn: async (day) => {");
  const end = source.indexOf("nightWatch: async (day) =>", start);
  assert.ok(start >= 0 && end > start, "the multi-day scenario must have a day turn");
  return source.slice(start, end);
}

/** A world with nothing in it: the baseline every producer below varies one fact of. */
export const IDLE_DAY = Object.freeze({
  turnIndex: 1,
  objectiveMet: false,
  programRunning: false,
  admissionPending: false,
  lateDay: false,
  dayEndOffered: false,
  stalled: false,
  worldStateStale: false,
});

export const WAKE_PRODUCERS = Object.freeze({
  day_start: () => decideDayWake({ ...IDLE_DAY, turnIndex: 0 }).reason,
  stall_wake: () => decideDayWake({ ...IDLE_DAY, stalled: true }).reason,
  stale_world: () => decideDayWake({ ...IDLE_DAY, worldStateStale: true }).reason,
  day_end_offer: () => decideDayWake({ ...IDLE_DAY, objectiveMet: true, lateDay: true }).reason,
  // THE TWO MEASUREMENTS, not a timer: the day is called unfinishable when the objective's published reading has
  // stood still for a whole measured turn, so this producer hands the decider exactly that - a still reading one
  // span old - and `lateDay`, which it takes from the world clock.
  objective_unreachable_for_today: () =>
    decideDayWake({
      ...IDLE_DAY,
      lateDay: true,
      objectiveProgressSinceMs: 80_000,
      objectiveSpanMs: 40_000,
    }).reason,
  // A session goal is a PLAYER turn, so its reason is declared at its own call site: this reads that site rather than
  // restating it, which is what makes "reachable" a fact about the runner instead of about this table.
  player_input: () => {
    const goals = RUNNER_SOURCE.slice(RUNNER_SOURCE.indexOf('if (SCENARIO === "morning_routine") {'));
    const site = promptCallSites(goals)[0];
    return site === undefined ? null : declaredWakeReason(site.text);
  },
});

/** The decider's own text, where its facts and its return sites are declared. */
export const MULTIDAY_LOOP_SOURCE = await readFile(new URL("../../lib/multiday-loop.mjs", import.meta.url), "utf8");

/**
 * The facts `decideWake` declares, read off its own destructured parameter list.
 *
 * This is the AUTHORITY for "which facts this decision reads": a fact the caller omits keeps its default, and the branch
 * that reads it can then never fire. `decideDayWake` owns `turnIndex` (the day's opening, which is not a settlement
 * question), so it is collected from that signature instead.
 */
export function deciderFactNames(source) {
  const code = withoutComments(source);
  const names = [];
  for (const [headline, tail] of [
    ["export function decideWake({", "} = {}) {"],
    ["export function decideDayWake({", "} = {}) {"],
  ]) {
    const start = code.indexOf(headline);
    assert.ok(start >= 0, `the decider's ${headline} must be findable by name`);
    const end = code.indexOf(tail, start);
    assert.ok(end > start, `the decider's ${headline} must reach its own parameter object`);
    for (const match of code
      .slice(start + headline.length, end)
      .matchAll(/([A-Za-z_$][\w$]*)\s*(?:=[^,]*)?(?:,|$)/gu)) {
      // A rest element (`...facts`) is the forwarding slot, not a fact of its own: the facts it carries are the ones
      // `decideWake` declares, and counting it would invent a fact nothing compares.
      if (code.slice(0, start + headline.length + match.index).endsWith("...")) continue;
      if (!names.includes(match[1])) names.push(match[1]);
    }
  }
  return names;
}

/**
 * Every reason the decider's OWN return sites name, read from its text.
 *
 * `WAKE_SUPPRESSION` returns are a different vocabulary - they answer "why no prompt" rather than "what woke her" - so
 * only `reason: WAKE_REASON.<name>` counts. A name outside `WAKE_REASON` fails rather than being skipped, because a
 * reason the decider can answer must be a reason the vocabulary declares.
 */
export function deciderReturnedReasons(source) {
  const code = withoutComments(source);
  const start = code.indexOf("export function decideWake(");
  const end = code.indexOf("export function wakeReasonReachability(");
  assert.ok(start >= 0 && end > start, "the decider and its reachability reader must both be findable by name");
  const reasons = [];
  for (const match of code.slice(start, end).matchAll(/reason:\s*WAKE_REASON\.([A-Za-z]+)/gu)) {
    const reason = WAKE_REASON[match[1]];
    assert.equal(typeof reason, "string", `decider_reason_not_in_the_vocabulary:WAKE_REASON.${match[1]}`);
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  return reasons;
}

/**
 * The fact names one call's object literal supplies, at its own member boundaries.
 *
 * Both spellings count: `key: value` and the shorthand `key,`. A value that happens to sit after a comma is not a key,
 * which is why the position - not the text - decides: a member begins after the previous member's comma.
 */
export function suppliedFactNames(text) {
  const at = text.indexOf("decideDayWake({");
  assert.ok(at >= 0, "the day loop must ask the decider with an object literal");
  const literal = callArguments(text, text.indexOf("(", at)).slice(1, -1).trim();
  assert.ok(literal.startsWith("{") && literal.endsWith("}"), "the day loop's argument must be one object literal");
  const body = literal.slice(1, -1);
  const keys = [];
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < body.length && body[index] !== quote) index += body[index] === "\\" ? 2 : 1;
      continue;
    }
    if (char === "{" || char === "(" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === ")" || char === "]") {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    const before = body.slice(0, index).replace(/\s+$/u, "");
    if (!(before === "" || before.endsWith(","))) continue;
    const match = /^([A-Za-z_$][\w$]*)\s*(?=[:,])/u.exec(body.slice(index));
    if (match === null) continue;
    if (!keys.includes(match[1])) keys.push(match[1]);
    index += match[0].length - 1;
  }
  return keys;
}

/**
 * The values a probe of one fact can take, read from how the decider itself compares it.
 *
 * A fact the decider tests with `=== true` / `!== true` is a boolean, and a fact it hands to `readObjectiveState` is a
 * measurement: `null` (unmeasured), `0` and a positive number. The domain comes from the comparison in the decider's own
 * text, so a fact whose comparison changes shape is probed differently without editing this table.
 */
export function factProbeDomain(source, name) {
  const booleanComparison = new RegExp(`\\b${name}\\s*[!=]==?\\s*true\\b`, "u");
  if (booleanComparison.test(source)) return [true, false];
  return [null, 0, 1_000];
}

/** Every reason `decideDayWake` answers with over the fact combinations the day loop can actually hand it. */
export function reasonsProbedFrom(source, facts) {
  const domains = facts.map((name) => factProbeDomain(source, name));
  const seen = new Set();
  const walk = (index, supplied) => {
    if (index === facts.length) {
      seen.add(decideDayWake(supplied).reason);
      return;
    }
    for (const value of domains[index]) walk(index + 1, { ...supplied, [facts[index]]: value });
  };
  walk(0, {});
  return seen;
}

/** The prompt table and the note composition, evaluated from the runner's own source with the sweep prompts bound in. */
export function loadPromptScope() {
  const build = new Function(
    "sweepTaskPrompts",
    `
${extractRunnerConstant(RUNNER_SOURCE, "DAILY_TASK_PROMPT_ZH")}
${extractRunnerConstant(RUNNER_SOURCE, "DAILY_TASK_PROMPT_EN")}
${extractRunnerFunction(RUNNER_SURFACE_SOURCE, "dayNoteFragment").source}
${extractRunnerConstant(RUNNER_SOURCE, "SCENARIO_PROMPTS")}
return { DAILY_TASK_PROMPT_ZH, DAILY_TASK_PROMPT_EN, SCENARIO_PROMPTS, dayNoteFragment };
`,
  );
  return build(sweepTaskPrompts);
}

export const sessionLine = (text) =>
  JSON.stringify({
    type: "message",
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }] },
  });

// A DAY'S FIRST TURN MUST NOT OPEN ON `世界：尚未收到观察`.
//
// Measured `round49` (day 1): the harness's very first delivery carried that world-state block, her first thinking was
// "no observation yet", and her first action was `stardew_observe {}` - a whole turn spent looking at a world the
// harness already held. THE PRODUCER WAS MISSING, NOT A DELAY: the launch handle observes the world and parks the
// snapshot in `launch.initialFacts`, and only `runtime.connected.activateIngress()` hands those facts to the pump
// (`host.acceptInitialFacts` -> `pump.enqueueFact`, which sets `#lastSnapshot` synchronously). Production calls it once
// after the enter receipt commits and refuses every task prompt until it has. A bounded wait alone would have expired on
// every run, because nothing in this harness ever asked the Host to hand the reading over.
//
// These tests hold both ends: the reading that NAMES a blind day, and the attach boundary that stops one happening.
export const ROUND49_FIRST_DELIVERY = ["…", "<world-state>", "世界：尚未收到观察", "</world-state>"].join("\n");

export const OBSERVED_FIRST_DELIVERY = [
  "<world-state>",
  "世界（revision 0，刚刚更新）06:20（清晨）；春季 1 日；位置: 农舍；种子: 2 花椰菜种子",
  "</world-state>",
].join("\n");

export const BLIND_MARKER = "世界：尚未收到观察";
