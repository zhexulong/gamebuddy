/**
 * The evidence bundle contract: what one live run leaves behind, and what may not be faked in it.
 *
 * The discipline this encodes is the one the plan states: a field that could not be measured is
 * `null` WITH a reason, never a plausible default. A run that failed without a failure snapshot and
 * a replayable trace is not "less evidence" - it is not evidence, so those combinations are
 * violations rather than warnings.
 *
 * The request frame is part of the contract because receipts cannot reconstruct it: replay needs
 * `requestId` + `action` + the full `args`, plus the game time and date the request was dispatched
 * at (bridge-native field names, deliberately not aliased).
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseInGameTime } from "./replay-clock.mjs";
import { HOST_MEMORY_TURN_CAP } from "./live-run-memory.mjs";
import { RECLAMATION_REFLECTIONS, RECLAMATION_STATES } from "./live-run-teardown.mjs";
import { isLiveRunWindowMode } from "./stardew-live-run.mjs";

const EVIDENCE_BUNDLE_SCHEMA_VERSION = 1;

export const EVIDENCE_BUNDLE_FILES = Object.freeze({
  manifest: "manifest.json",
  timeline: "timeline.jsonl",
  actionTrace: "actionTrace.jsonl",
  // The product's own span export: what the run's wall clock went to, stage by stage (host/src/run-trace.ts).
  runTrace: "run-trace.json",
  failure: "failure.json",
  repro: "repro.json",
  keyFrames: "key-frames",
});

/**
 * The loop's own verdict vocabulary (`deriveLoopVerdict`) plus the one outcome the loop cannot produce; the bundle
 * reports, it does not invent.
 *
 * `killed` is the run that was interrupted from OUTSIDE - a SIGTERM/SIGINT from a timeout or an operator - and it is
 * deliberately not `blocked`: nothing about the product was measured, so it proves nothing and must never be counted as
 * a failure in an aggregate. `deriveLoopVerdict` has no arm for it because the loop never decides to be killed; the
 * signal trap in the live runner does.
 */
export const EVIDENCE_BUNDLE_VERDICT_STATES = Object.freeze(["passed", "failed", "blocked", "degraded", "killed"]);

const EVIDENCE_BUNDLE_TIMELINE_SOURCES = Object.freeze(["player", "smapi", "body", "llm", "bubble"]);

const ACTION_TRACE_ENTRY_FIELDS = Object.freeze([
  "requestId",
  "action",
  "args",
  "state",
  "reasonCode",
  "inGameTime",
  "day",
  "season",
  "year",
  "dispatchedAtMs",
]);

/**
 * The failure moment's own facts: position, WHEN it was (game time + date, without which a replay cannot be
 * repositioned), where it was, and the tile facts that decide blocking.
 *
 * `playerFacing` is deliberately NOT required. It is only published on the local observation that rides an
 * execution receipt (`protocol.ts:896-904`), and a real run produced receipts with no observation at all
 * (measured 2026-10-16: `poseFields: []`). Requiring it would make a perfectly re-enterable dump unwritable.
 * What IS required is `poseSource`, so a null facing is a NAMED absence rather than a silent one.
 */
const FAILURE_SNAPSHOT_FIELDS = Object.freeze([
  "reasonCode",
  "component",
  "step",
  "playerTile",
  "poseSource",
  "inGameTime",
  "day",
  "season",
  "year",
  "location",
  "blockingProperties",
  "collisionLayers",
  "atMs",
]);

/** Where the pose came from: the Mod's own observation, or only the snapshot (which has no facing). */
export const POSE_SOURCES = Object.freeze(["execution_receipt_observation", "snapshot_only"]);

const SEASONS = Object.freeze(["spring", "summer", "fall", "winter"]);

/**
 * A GPU or resolution probe is the one measurement a headless environment legitimately cannot take,
 * and the failing window mode has to be reported for that claim to be checkable.
 */
const HEADLESS_REASON = "headless_environment";
const HEADLESS_WINDOW_MODES = Object.freeze(["hidden", "background"]);
const ENV_FACTS = Object.freeze(["smapiVersion", "gameVersion", "os", "windowMode", "gpu", "resolution", "saveHash"]);
const HEADLESS_OPTIONAL = Object.freeze(["gpu", "resolution"]);

const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function violation(code, where) {
  return Object.freeze({ code, where });
}

/** One action-trace entry: a request frame a replay can dispatch, with the game time it was sent at. */
export function validateActionTraceEntry(entry, where = "actionTrace") {
  const violations = [];
  if (!isPlainObject(entry)) return Object.freeze([violation("action_trace_entry_not_object", where)]);
  for (const field of ACTION_TRACE_ENTRY_FIELDS) {
    if (entry[field] === undefined || entry[field] === null) {
      violations.push(violation("action_trace_field_missing", `${where}.${field}`));
    }
  }
  if (entry.args !== undefined && !isPlainObject(entry.args)) {
    violations.push(violation("action_trace_args_not_object", `${where}.args`));
  }
  if (parseInGameTime(entry.inGameTime) === null) {
    violations.push(violation("action_trace_in_game_time_invalid", `${where}.inGameTime`));
  }
  const dayValid = Number.isInteger(entry.day) && entry.day >= 1 && entry.day <= 28;
  const seasonValid = SEASONS.includes(entry.season);
  const yearValid = Number.isInteger(entry.year) && entry.year >= 1;
  if (!dayValid || !seasonValid || !yearValid) {
    violations.push(violation("action_trace_date_invalid", `${where}.day/season/year`));
  }
  if (!isFiniteNumber(entry.dispatchedAtMs)) {
    violations.push(violation("action_trace_dispatched_at_invalid", `${where}.dispatchedAtMs`));
  }
  return Object.freeze(violations);
}

/**
 * Every obligation the bundle contract can decide, each able to fail on its own.
 * `actionTrace` is optional so a run still being assembled can be validated before its trace exists.
 */
export function validateEvidenceBundle(bundle, { actionTrace = null } = {}) {
  const violations = [];
  if (!isPlainObject(bundle)) {
    return Object.freeze({
      ok: false,
      violations: Object.freeze([violation("bundle_not_object", "bundle")]),
      checkedObligations: CHECKED_OBLIGATIONS,
    });
  }

  if (bundle.schemaVersion !== EVIDENCE_BUNDLE_SCHEMA_VERSION) {
    violations.push(violation("schema_version_mismatch", "schemaVersion"));
  }

  const run = bundle.run;
  if (!isPlainObject(run)) {
    violations.push(violation("run_identity_missing", "run"));
  } else {
    for (const field of ["id", "scenario", "gitSha", "runtimeRoot"]) {
      if (!isNonEmptyString(run[field])) violations.push(violation("run_identity_missing", `run.${field}`));
    }
    for (const field of ["startedAtMs", "durationMs"]) {
      if (!isFiniteNumber(run[field])) violations.push(violation("run_timing_missing", `run.${field}`));
    }
  }

  const env = bundle.env;
  if (!isPlainObject(env)) {
    violations.push(violation("env_missing", "env"));
  } else {
    if (!isLiveRunWindowMode(env.windowMode)) {
      violations.push(violation("env_window_mode_unknown", "env.windowMode"));
    }
    const reason = env.reason;
    const headless = HEADLESS_WINDOW_MODES.includes(env.windowMode);
    for (const fact of ENV_FACTS) {
      const measured = isNonEmptyString(env[fact]);
      if (measured) continue;
      if (env[fact] !== null) {
        violations.push(violation("env_fact_not_measured", `env.${fact}`));
        continue;
      }
      if (HEADLESS_OPTIONAL.includes(fact)) {
        // Only a headless window mode may leave these null, and it has to say why.
        if (!headless || reason !== HEADLESS_REASON) violations.push(violation("env_fact_not_measured", `env.${fact}`));
        continue;
      }
      // Every other fact is knowable whatever the window mode is, so the headless reason cannot excuse it.
      if (!isNonEmptyString(reason) || reason === HEADLESS_REASON) {
        violations.push(violation("env_fact_not_measured", `env.${fact}`));
      }
    }
  }

  const verdict = bundle.verdict;
  if (!isPlainObject(verdict) || !EVIDENCE_BUNDLE_VERDICT_STATES.includes(verdict.state)) {
    violations.push(violation("verdict_state_unknown", "verdict.state"));
  } else if (
    !isPlainObject(verdict.rubric) ||
    !Array.isArray(verdict.rubric.broken) ||
    !Array.isArray(verdict.rubric.unmeasured)
  ) {
    violations.push(violation("verdict_rubric_missing", "verdict.rubric"));
  }

  const timeline = bundle.timeline;
  if (!isPlainObject(timeline) || !Array.isArray(timeline.sources) || timeline.sources.length === 0) {
    violations.push(violation("timeline_sources_missing", "timeline.sources"));
  } else {
    for (const source of timeline.sources) {
      if (!EVIDENCE_BUNDLE_TIMELINE_SOURCES.includes(source)) {
        violations.push(violation("timeline_source_unknown", `timeline.sources[${String(source)}]`));
      }
    }
    if (!isFiniteNumber(timeline.records)) violations.push(violation("timeline_records_missing", "timeline.records"));
  }

  const declared = bundle.actionTrace;
  if (!isPlainObject(declared)) {
    violations.push(violation("action_trace_declaration_missing", "actionTrace"));
  } else if (!isFiniteNumber(declared.records)) {
    violations.push(violation("action_trace_records_missing", "actionTrace.records"));
  }
  if (actionTrace !== null) {
    if (!Array.isArray(actionTrace)) {
      violations.push(violation("action_trace_not_array", "actionTrace"));
    } else {
      for (const [index, entry] of actionTrace.entries()) {
        violations.push(...validateActionTraceEntry(entry, `actionTrace[${String(index)}]`));
      }
      if (isPlainObject(declared) && isFiniteNumber(declared.records) && declared.records !== actionTrace.length) {
        violations.push(violation("action_trace_records_mismatch", "actionTrace.records"));
      }
    }
  }

  // The run trace: the slot a declared span name lands in. The WRITER decides `present` from the file it actually
  // copied, so a bundle cannot publish a reading taken before the product wrote it - which is exactly what the
  // runner's own pre-write probe did (present:false while the trace was on disk, measured 2026-11-11).
  const runTrace = bundle.runTrace;
  if (!isPlainObject(runTrace)) {
    violations.push(violation("run_trace_declaration_missing", "runTrace"));
  } else if (typeof runTrace.present !== "boolean") {
    violations.push(violation("run_trace_presence_unstated", "runTrace.present"));
  } else if (runTrace.present === false) {
    if (!isNonEmptyString(runTrace.reason)) violations.push(violation("run_trace_reason_missing", "runTrace.reason"));
  } else if (!Number.isInteger(runTrace.spans) || runTrace.spans < 0) {
    violations.push(violation("run_trace_spans_invalid", "runTrace.spans"));
  }

  const keyFrames = bundle.keyFrames;
  if (!isPlainObject(keyFrames) || (keyFrames.status !== "captured" && keyFrames.status !== "skipped")) {
    violations.push(violation("key_frames_status_unknown", "keyFrames.status"));
  } else if (keyFrames.status === "captured" && !isNonEmptyString(keyFrames.dir)) {
    violations.push(violation("key_frames_dir_missing", "keyFrames.dir"));
  } else if (keyFrames.status === "skipped" && !isNonEmptyString(keyFrames.reason)) {
    violations.push(violation("key_frames_reason_missing", "keyFrames.reason"));
  }

  const reclamation = bundle.reclamation;
  if (!isPlainObject(reclamation) || !isNonEmptyString(reclamation.state) || !Array.isArray(reclamation.steps)) {
    violations.push(violation("reclamation_missing", "reclamation"));
  } else if (!RECLAMATION_STATES.includes(reclamation.state)) {
    violations.push(violation("reclamation_state_unknown", "reclamation.state"));
  } else if (!RECLAMATION_REFLECTIONS.includes(reclamation.reflection)) {
    violations.push(violation("reclamation_reflection_unknown", "reclamation.reflection"));
  } else if (reclamation.reflection === "completed" && reclamation.steps.length === 0) {
    // MEASURED 2026-11-09 (`round40`): `{state: "unobserved", exitReason: null, steps: [], reflection: "completed"}`
    // passed every obligation while naming no teardown step at all. A completion with nothing behind it is the shape a
    // reader quotes as "the teardown was fine", so it is refused here rather than left to the reader.
    violations.push(violation("reclamation_completed_without_steps", "reclamation.steps"));
  } else {
    for (const [index, step] of reclamation.steps.entries()) {
      if (!isPlainObject(step) || !isNonEmptyString(step.step) || (step.state !== "ok" && step.state !== "failed")) {
        violations.push(violation("reclamation_step_malformed", `reclamation.steps[${String(index)}]`));
      }
    }
  }

  // The run's own memory, which the bundle used to say nothing about at all (measured 2026-11-09, `round40`: 46 samples
  // in the runner's log, no field in the artifact). `not_measured:no_turn_samples` is a legitimate answer; a missing or
  // null field is not, and neither is a series longer than its cap.
  const hostMemory = bundle.hostMemory;
  if (
    !isPlainObject(hostMemory) ||
    !isNonEmptyString(hostMemory.state) ||
    !Array.isArray(hostMemory.turns) ||
    !Number.isInteger(hostMemory.omitted) ||
    hostMemory.omitted < 0
  ) {
    violations.push(violation("host_memory_missing", "hostMemory"));
  } else if (hostMemory.turns.length > HOST_MEMORY_TURN_CAP) {
    violations.push(violation("host_memory_series_unbounded", "hostMemory.turns"));
  }

  const voice = bundle.voice;
  if (!isPlainObject(voice) || !["observed", "disabled", "failed"].includes(voice.playback)) {
    violations.push(violation("voice_playback_unknown", "voice.playback"));
  } else if (voice.playback !== "observed" && !isNonEmptyString(voice.reasonCode)) {
    violations.push(violation("voice_reason_missing", "voice.reasonCode"));
  }

  // Optional, because it is a fact about CROSSINGS: a single-day run has none. When present it must be
  // well-formed and its judgement must be the baseline's own, so a run cannot report a passing crossing it
  // never made.
  if (bundle.multiday !== undefined && bundle.multiday !== null) {
    const multiday = bundle.multiday;
    if (!isPlainObject(multiday)) {
      violations.push(violation("multiday_not_object", "multiday"));
    } else {
      if (!Number.isInteger(multiday.crossings) || multiday.crossings < 1) {
        violations.push(violation("multiday_crossings_invalid", "multiday.crossings"));
      }
      if (!isPlainObject(multiday.assessment) || multiday.assessment.state === undefined) {
        violations.push(violation("multiday_assessment_missing", "multiday.assessment"));
      } else if (multiday.assessment.state === "passed" && multiday.assessment.ok !== true) {
        violations.push(violation("multiday_assessment_disagrees_with_its_own_state", "multiday.assessment"));
      }
      if (!Array.isArray(multiday.dayRecords)) {
        violations.push(violation("multiday_day_records_missing", "multiday.dayRecords"));
      } else if (Number.isInteger(multiday.crossings) && multiday.dayRecords.length !== multiday.crossings) {
        violations.push(violation("multiday_day_records_disagree_with_crossings", "multiday.dayRecords"));
      }
    }
  }

  const failed = isPlainObject(verdict) && verdict.state === "failed";
  // A killed run is not a failed run. Its failure snapshot would be a claim about a moment nobody observed, and every
  // aggregate that reads `failure` would count an external interrupt as a product defect.
  if (isPlainObject(verdict) && verdict.state === "killed" && isPlainObject(bundle.failure)) {
    violations.push(violation("killed_run_published_a_failure", "failure"));
  }
  if (failed && !isPlainObject(bundle.failure)) {
    violations.push(violation("failure_snapshot_missing", "failure"));
  }
  if (isPlainObject(bundle.failure)) {
    violations.push(...validateFailureSnapshot(bundle.failure));
  }
  const reproCommand = isPlainObject(bundle.repro) ? bundle.repro.command : null;
  if (failed && !isNonEmptyString(reproCommand)) {
    violations.push(violation("repro_command_missing", "repro.command"));
  }
  if (isNonEmptyString(reproCommand) && !isFiniteNumber(bundle.repro?.expectedWallClockMs)) {
    violations.push(violation("repro_budget_missing", "repro.expectedWallClockMs"));
  }
  // A repro whose REACH is unstated is not a repro this bundle can vouch for. `reach` is the plan's own word for
  // what the command can get back to: a day-level replay reaches the failing day only from the first morning, so a
  // failure after any night crossed must say so rather than present a command that cannot arrive.
  if (isNonEmptyString(reproCommand) && !["the_failing_day", "first_day_only"].includes(bundle.repro?.reach)) {
    violations.push(violation("repro_reach_unstated", "repro.reach"));
  }

  return Object.freeze({
    ok: violations.length === 0,
    violations: Object.freeze(violations),
    checkedObligations: CHECKED_OBLIGATIONS,
  });
}

/** The failure moment must be locatable, or the snapshot cannot be repositioned by a replay. */
function validateFailureSnapshot(failure) {
  const violations = [];
  for (const field of FAILURE_SNAPSHOT_FIELDS) {
    if (failure[field] === undefined || failure[field] === null) {
      violations.push(violation("failure_field_missing", `failure.${field}`));
    }
  }
  const tile = failure.playerTile;
  if (!isPlainObject(tile) || !isFiniteNumber(tile.x) || !isFiniteNumber(tile.y)) {
    violations.push(violation("failure_player_tile_invalid", "failure.playerTile"));
  }
  for (const field of ["blockingProperties", "collisionLayers"]) {
    if (!Array.isArray(failure[field])) violations.push(violation("failure_tile_facts_not_array", `failure.${field}`));
  }
  if (parseInGameTime(failure.inGameTime) === null) {
    violations.push(violation("failure_in_game_time_invalid", "failure.inGameTime"));
  }
  if (!Number.isInteger(failure.day) || failure.day < 1 || failure.day > 28) {
    violations.push(violation("failure_date_invalid", "failure.day"));
  }
  if (!SEASONS.includes(failure.season)) violations.push(violation("failure_date_invalid", "failure.season"));
  if (!Number.isInteger(failure.year) || failure.year < 1)
    violations.push(violation("failure_date_invalid", "failure.year"));
  if (!POSE_SOURCES.includes(failure.poseSource)) {
    violations.push(violation("failure_pose_source_unknown", "failure.poseSource"));
  }
  // Facing may be absent, but only when the source says the bridge did not publish it: a null with an observation
  // source is a fact that was dropped, not a fact that did not exist.
  if (failure.poseSource === "execution_receipt_observation" && typeof failure.playerFacing !== "string") {
    violations.push(violation("failure_facing_missing_from_observation", "failure.playerFacing"));
  }
  if (!isFiniteNumber(failure.atMs)) violations.push(violation("failure_at_ms_invalid", "failure.atMs"));
  return Object.freeze(violations);
}

const CHECKED_OBLIGATIONS = Object.freeze([
  "schema_version_mismatch",
  "run_identity_missing",
  "run_timing_missing",
  "env_fact_not_measured",
  "env_window_mode_unknown",
  "verdict_state_unknown",
  "verdict_rubric_missing",
  "timeline_sources_missing",
  "timeline_source_unknown",
  "timeline_records_missing",
  "action_trace_declaration_missing",
  "action_trace_records_missing",
  "action_trace_records_mismatch",
  "action_trace_entry_not_object",
  "action_trace_field_missing",
  "action_trace_args_not_object",
  "action_trace_in_game_time_invalid",
  "action_trace_date_invalid",
  "action_trace_dispatched_at_invalid",
  "run_trace_declaration_missing",
  "run_trace_presence_unstated",
  "run_trace_reason_missing",
  "run_trace_spans_invalid",
  "key_frames_status_unknown",
  "key_frames_dir_missing",
  "key_frames_reason_missing",
  "reclamation_missing",
  "reclamation_state_unknown",
  "reclamation_reflection_unknown",
  "reclamation_completed_without_steps",
  "reclamation_step_malformed",
  "host_memory_missing",
  "host_memory_series_unbounded",
  "voice_playback_unknown",
  "voice_reason_missing",
  "multiday_not_object",
  "multiday_crossings_invalid",
  "multiday_assessment_missing",
  "multiday_assessment_disagrees_with_its_own_state",
  "multiday_day_records_missing",
  "multiday_day_records_disagree_with_crossings",
  "failure_snapshot_missing",
  "killed_run_published_a_failure",
  "failure_field_missing",
  "failure_player_tile_invalid",
  "failure_tile_facts_not_array",
  "failure_in_game_time_invalid",
  "failure_date_invalid",
  "failure_pose_source_unknown",
  "failure_facing_missing_from_observation",
  "failure_at_ms_invalid",
  "repro_command_missing",
  "repro_budget_missing",
  "repro_reach_unstated",
]);

/**
 * What a bundle publishes about its run trace, decided from the product's OWN file.
 *
 * The product writes the export beside its run manifest and keeps rewriting it while the run is live
 * (`host/src/run-trace.ts`), so this record answers two questions at the moment the package is written: was there a
 * trace, and how many spans did it hold. A run that ended without a graceful close still has one, because the file is
 * not written by the close. The bound on the copy is the product's own span cap, which is why the record carries the
 * count a reader can check the file against.
 */
async function decideRunTraceRecord(declared) {
  const sourcePath = isPlainObject(declared) && isNonEmptyString(declared.path) ? declared.path : null;
  if (sourcePath === null) {
    return Object.freeze({
      record: Object.freeze({
        path: EVIDENCE_BUNDLE_FILES.runTrace,
        present: false,
        reason: "run_trace_not_declared",
        sourcePath: null,
        spans: null,
      }),
      sourcePath: null,
    });
  }
  if (!existsSync(sourcePath)) {
    return Object.freeze({
      record: Object.freeze({
        path: EVIDENCE_BUNDLE_FILES.runTrace,
        present: false,
        reason: "run_trace_absent_at_bundle_time",
        sourcePath,
        spans: null,
      }),
      sourcePath: null,
    });
  }
  let spans = null;
  try {
    const parsed = JSON.parse(await readFile(sourcePath, "utf8"));
    spans = isPlainObject(parsed) && Array.isArray(parsed.traceEvents) ? parsed.traceEvents.length : null;
  } catch {
    spans = null;
  }
  if (spans === null) {
    return Object.freeze({
      record: Object.freeze({
        path: EVIDENCE_BUNDLE_FILES.runTrace,
        present: false,
        reason: "run_trace_unreadable",
        sourcePath,
        spans: null,
      }),
      sourcePath: null,
    });
  }
  return Object.freeze({
    record: Object.freeze({ path: EVIDENCE_BUNDLE_FILES.runTrace, present: true, reason: null, sourcePath, spans }),
    sourcePath,
  });
}

async function readJsonLines(path) {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Reads one run directory and validates the bundle against what is actually on disk: a manifest that
 * claims records the trace file does not have, or a failure file the manifest does not admit, is a
 * violation rather than a repair opportunity.
 */
export async function readEvidenceBundle(runDir) {
  const manifestPath = join(runDir, EVIDENCE_BUNDLE_FILES.manifest);
  if (!existsSync(manifestPath)) {
    return Object.freeze({
      bundle: null,
      actionTrace: null,
      violations: Object.freeze([violation("manifest_missing", EVIDENCE_BUNDLE_FILES.manifest)]),
    });
  }
  let bundle;
  try {
    bundle = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return Object.freeze({
      bundle: null,
      actionTrace: null,
      violations: Object.freeze([violation("manifest_unreadable", EVIDENCE_BUNDLE_FILES.manifest)]),
    });
  }
  const tracePath = join(runDir, EVIDENCE_BUNDLE_FILES.actionTrace);
  let actionTrace = null;
  const extraViolations = [];
  const declaresTrace = isPlainObject(bundle.actionTrace) && isFiniteNumber(bundle.actionTrace.records);
  if (!existsSync(tracePath) && declaresTrace) {
    extraViolations.push(violation("action_trace_missing", EVIDENCE_BUNDLE_FILES.actionTrace));
  }
  if (existsSync(tracePath)) {
    try {
      actionTrace = await readJsonLines(tracePath);
    } catch {
      extraViolations.push(violation("action_trace_unreadable", EVIDENCE_BUNDLE_FILES.actionTrace));
    }
  }
  const timelinePath = join(runDir, EVIDENCE_BUNDLE_FILES.timeline);
  const declaresTimeline = isPlainObject(bundle.timeline) && isFiniteNumber(bundle.timeline.records);
  if (!existsSync(timelinePath) && declaresTimeline) {
    extraViolations.push(violation("timeline_missing", EVIDENCE_BUNDLE_FILES.timeline));
  }
  if (existsSync(timelinePath) && declaresTimeline) {
    try {
      const records = await readJsonLines(timelinePath);
      if (records.length !== bundle.timeline.records) {
        extraViolations.push(violation("timeline_records_mismatch", EVIDENCE_BUNDLE_FILES.timeline));
      }
    } catch {
      extraViolations.push(violation("timeline_unreadable", EVIDENCE_BUNDLE_FILES.timeline));
    }
  }
  const runTracePath = join(runDir, EVIDENCE_BUNDLE_FILES.runTrace);
  const declaresRunTrace = isPlainObject(bundle.runTrace) && bundle.runTrace.present === true;
  if (declaresRunTrace && !existsSync(runTracePath)) {
    extraViolations.push(violation("run_trace_missing", EVIDENCE_BUNDLE_FILES.runTrace));
  }
  if (existsSync(runTracePath)) {
    if (!isPlainObject(bundle.runTrace)) {
      extraViolations.push(violation("run_trace_file_not_declared", EVIDENCE_BUNDLE_FILES.runTrace));
    } else {
      try {
        const parsed = JSON.parse(await readFile(runTracePath, "utf8"));
        const events = isPlainObject(parsed) && Array.isArray(parsed.traceEvents) ? parsed.traceEvents : null;
        if (events === null) extraViolations.push(violation("run_trace_unreadable", EVIDENCE_BUNDLE_FILES.runTrace));
        else if (declaresRunTrace && events.length !== bundle.runTrace.spans) {
          extraViolations.push(violation("run_trace_records_mismatch", EVIDENCE_BUNDLE_FILES.runTrace));
        }
      } catch {
        extraViolations.push(violation("run_trace_unreadable", EVIDENCE_BUNDLE_FILES.runTrace));
      }
    }
  }
  const failureFile = existsSync(join(runDir, EVIDENCE_BUNDLE_FILES.failure));
  if (failureFile && !isPlainObject(bundle.failure)) {
    extraViolations.push(violation("failure_file_not_declared", EVIDENCE_BUNDLE_FILES.failure));
  }
  const reproducedFailed = isPlainObject(bundle.verdict) && bundle.verdict.state === "failed";
  if (reproducedFailed && !failureFile) {
    extraViolations.push(violation("failure_file_missing", EVIDENCE_BUNDLE_FILES.failure));
  }
  if (reproducedFailed && !existsSync(join(runDir, EVIDENCE_BUNDLE_FILES.repro))) {
    extraViolations.push(violation("repro_file_missing", EVIDENCE_BUNDLE_FILES.repro));
  }

  const result = validateEvidenceBundle(bundle, { actionTrace });
  return Object.freeze({
    bundle,
    actionTrace,
    violations: Object.freeze([...result.violations, ...extraViolations]),
  });
}

/**
 * Writes a bundle that passed validation, or nothing at all: a runner that cannot describe its run
 * must fail there rather than leave a manifest other tools will read as a measurement.
 */
export async function writeEvidenceBundle(runDir, { bundle, timeline = [], actionTrace = [] } = {}) {
  if (!Array.isArray(timeline)) throw new Error("evidence_bundle_invalid:timeline_not_array");
  // The manifest this writes is the one the WRITER can vouch for: `runTrace` is replaced by what is about to be copied,
  // never by the caller's pre-write probe (which read the file before the product's close had run).
  const runTrace = await decideRunTraceRecord(bundle.runTrace);
  const manifest = Object.freeze({ ...bundle, runTrace: runTrace.record });
  const result = validateEvidenceBundle(manifest, { actionTrace });
  if (!result.ok) {
    const codes = [...new Set(result.violations.map((item) => item.code))].sort().join(",");
    throw new Error(`evidence_bundle_invalid:${codes}`);
  }
  const lines = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, EVIDENCE_BUNDLE_FILES.manifest), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (runTrace.sourcePath !== null) {
    await copyFile(runTrace.sourcePath, join(runDir, EVIDENCE_BUNDLE_FILES.runTrace));
  }
  await writeFile(join(runDir, EVIDENCE_BUNDLE_FILES.timeline), lines(timeline), "utf8");
  await writeFile(join(runDir, EVIDENCE_BUNDLE_FILES.actionTrace), lines(actionTrace), "utf8");
  if (isPlainObject(bundle.failure)) {
    await writeFile(
      join(runDir, EVIDENCE_BUNDLE_FILES.failure),
      `${JSON.stringify(bundle.failure, null, 2)}\n`,
      "utf8",
    );
  }
  if (isPlainObject(bundle.repro)) {
    await writeFile(join(runDir, EVIDENCE_BUNDLE_FILES.repro), `${JSON.stringify(bundle.repro, null, 2)}\n`, "utf8");
  }
  if (bundle.keyFrames?.status === "captured") {
    await mkdir(join(runDir, EVIDENCE_BUNDLE_FILES.keyFrames), { recursive: true });
    const captured = await readdir(join(runDir, EVIDENCE_BUNDLE_FILES.keyFrames));
    if (captured.length === 0) throw new Error("evidence_bundle_invalid:key_frames_empty");
  }
  return Object.freeze({
    runDir,
    files: Object.freeze({
      manifest: join(runDir, EVIDENCE_BUNDLE_FILES.manifest),
      timeline: join(runDir, EVIDENCE_BUNDLE_FILES.timeline),
      actionTrace: join(runDir, EVIDENCE_BUNDLE_FILES.actionTrace),
      runTrace: runTrace.record.present ? join(runDir, EVIDENCE_BUNDLE_FILES.runTrace) : null,
      failure: isPlainObject(bundle.failure) ? join(runDir, EVIDENCE_BUNDLE_FILES.failure) : null,
      repro: isPlainObject(bundle.repro) ? join(runDir, EVIDENCE_BUNDLE_FILES.repro) : null,
    }),
  });
}
