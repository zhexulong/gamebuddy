import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { analyzeChatRunAudit } from "./lib/chat-run-audit.mjs";

const TOOL = "tools/compare-chat-live-runs.mjs";

/**
 * Build a minimal but schema-valid `chat_run_audit/v1` trace. Every knob is a
 * count per turn so a test can move exactly one graded signal at a time.
 *
 * @param {object} [options]
 * @returns {object}
 */
function buildTrace({
  runId = "run-0000",
  states = ["completed"],
  commitsPerTurn = 1,
  resyncsPerTurn = 0,
  stateReadsPerTurn = 1,
  framesPerTurn = 1,
  conflictsPerTurn = 0,
  providerSentPerTurn = false,
  problemCodes = [],
  providerObservability = "observed",
  trailingStateReads = 0,
  frameGapMsPerTurn = 0,
  extraEvents = [],
  generation = "gen-0000",
  inventoryDigest = "0".repeat(64),
} = {}) {
  const events = [];
  let at = 0;
  // The wire format stores `kind` and `code` as SEPARATE fields and the frozen
  // §3.1 code is the bare suffix (`lifecycle` + `run.started`), not a
  // pre-composed `lifecycle.run.started`. Call sites stay readable by writing
  // the human label and letting this helper split it exactly once.
  const push = (label, kind, actor, meta, extraMs = 0) => {
    at += 10 + extraMs;
    const prefix = `${kind}.`;
    const code = label.startsWith(prefix) ? label.slice(prefix.length) : label;
    events.push(meta === undefined ? { at, kind, actor, code } : { at, kind, actor, code, meta });
  };

  events.push({ at: 0, kind: "lifecycle", actor: "harness", code: "run.started" });
  states.forEach((state, index) => {
    push("lifecycle.turn.submitted", "lifecycle", "harness", { cursor: `t${index}` });
    if (providerSentPerTurn) push("provider.request.sent", "provider", "host");
    for (let frame = 0; frame < framesPerTurn; frame += 1) {
      push("sse.frame.received", "sse", "host", undefined, frame === 0 ? 0 : frameGapMsPerTurn);
    }
    for (let resync = 0; resync < resyncsPerTurn; resync += 1) {
      push("sse.stream.resync", "sse", "host", { reason: "resync_required" });
    }
    push("presentation.admitted", "presentation", "host");
    for (let commit = 0; commit < commitsPerTurn; commit += 1) {
      push("presentation.committed", "presentation", "host");
    }
    for (let read = 0; read < stateReadsPerTurn; read += 1) {
      push("http.state.read", "http", "harness");
    }
    for (let conflict = 0; conflict < conflictsPerTurn; conflict += 1) {
      push("http.state.conflict", "http", "harness", { status: 409 });
    }
    const problemCode = problemCodes[index];
    if (problemCode !== undefined) {
      push("provider.error", "provider", "host", { problemCode });
    }
    if (state === "completed") push("provider.settled", "provider", "host");
    // The durable terminal carries the attributable cause, mirroring
    // reference-pipeline-state.ts: a failed turn projects its problemCode on the
    // terminal itself, not only through provider.error (which is the
    // runtime-unavailable subset).
    push(
      "lifecycle.turn.terminal",
      "lifecycle",
      "harness",
      problemCode === undefined || state !== "failed" ? { state } : { state, problemCode },
    );
  });
  for (let read = 0; read < trailingStateReads; read += 1) push("http.state.read", "http", "harness");
  push("lifecycle.run.finished", "lifecycle", "harness", { providerObservability });
  for (const event of extraEvents) events.push(event);

  events.sort((left, right) => left.at - right.at);
  return {
    schema: "chat_run_audit/v1",
    runId,
    startedAt: "2026-09-26T00:00:00.000Z",
    completedAt: "2026-09-26T00:01:00.000Z",
    surface: "chat-only",
    artifact: { generation, inventoryDigest },
    provider: { embedded: true, observed: true },
    originMs: 0,
    events,
  };
}

function write(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
  return path;
}

/** @returns {{code: number, stdout: string, stderr: string}} */
function compare(a, b) {
  try {
    const stdout = execFileSync("node", [TOOL, a, b], { encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

/** @returns {{dir: string, baseline: string, after: string, code: number, stdout: string, stderr: string, parsed: object}} */
function compareTraces(baselineTrace, afterTrace) {
  const dir = mkdtempSync(join(tmpdir(), "chat-cmp-"));
  const baseline = write(dir, "baseline.json", baselineTrace);
  const after = write(dir, "after.json", afterTrace);
  const result = compare(baseline, after);
  return { dir, baseline, after, ...result, parsed: result.stdout ? JSON.parse(result.stdout) : null };
}

function rowOf(parsed, name) {
  return parsed.rows.find((row) => row.name === name);
}

test("identical traces produce zero rows", () => {
  const { code, parsed } = compareTraces(buildTrace(), buildTrace());
  assert.equal(code, 0);
  assert.equal(parsed.schema, "chat_live_run_comparison/v1");
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.summary.improvements, 0);
  assert.equal(parsed.summary.regressions, 0);
  assert.equal(parsed.summary.neutral, 0);
});

test("a comparison across two generations makes the build change visible", () => {
  // Across a system change the generation usually changes too. That is why the
  // comparator must NOT refuse the pair — but it must never hide it either: a
  // clean-looking 0/0/N over two generations would imply the before/after differ
  // only by the change under test.
  const baseline = buildTrace({ generation: "gen-0001", inventoryDigest: "1".repeat(64) });
  const after = buildTrace({ generation: "gen-0002", inventoryDigest: "2".repeat(64) });
  const { code, parsed } = compareTraces(baseline, after);
  assert.equal(code, 0);
  assert.deepEqual(rowOf(parsed, "artifact.generation"), {
    kind: "stage",
    name: "artifact.generation",
    before: "gen-0001",
    after: "gen-0002",
    verdict: "neutral",
    detail: "the published generation this run measured; when it changes, the comparison also covers a build change, not only the system change under test",
  });
  assert.equal(rowOf(parsed, "artifact.inventoryDigest").verdict, "neutral");
});

test("the same generation produces no artifact row, so a real pair stays clean", () => {
  const { parsed } = compareTraces(buildTrace(), buildTrace());
  assert.equal(rowOf(parsed, "artifact.generation"), undefined);
  assert.equal(rowOf(parsed, "artifact.inventoryDigest"), undefined);
});

test("a removed integrity finding is an improvement", () => {
  const baseline = buildTrace({ commitsPerTurn: 0 });
  const after = buildTrace({ commitsPerTurn: 1 });
  const { code, parsed } = compareTraces(baseline, after);
  assert.equal(code, 0, "an improvement must not fail the comparison");
  const hollow = rowOf(parsed, "hollow_success");
  assert.ok(hollow, "expected the hollow_success finding to be in the diff");
  assert.equal(hollow.before, 1);
  assert.equal(hollow.after, 0);
  assert.equal(hollow.verdict, "improvement");
  assert.equal(rowOf(parsed, "presentationCommitCount").verdict, "improvement");
  assert.equal(parsed.summary.regressions, 0);
});

test("a newly appearing integrity finding is a regression", () => {
  const { code, stdout, stderr, parsed } = compareTraces(
    buildTrace({ commitsPerTurn: 1 }),
    buildTrace({ commitsPerTurn: 0 }),
  );
  assert.equal(code, 1, "an integrity finding must fail the comparison");
  assert.match(stderr, /REGRESSION/);
  assert.match(stderr, /hollow_success/);
  const hollow = rowOf(parsed, "hollow_success");
  assert.equal(hollow.before, 0);
  assert.equal(hollow.after, 1);
  assert.equal(hollow.verdict, "regression");
  assert.ok(stdout.includes("hollow_success"));
});

test("a higher resync count is a regression", () => {
  const { code, stderr, parsed } = compareTraces(buildTrace({ resyncsPerTurn: 0 }), buildTrace({ resyncsPerTurn: 2 }));
  assert.equal(code, 1);
  assert.equal(rowOf(parsed, "resyncCount").verdict, "regression");
  assert.equal(rowOf(parsed, "event.sse.stream.resync").verdict, "regression");
  assert.match(stderr, /REGRESSION: .*resyncCount/);
});

test("a lower resync count is an improvement", () => {
  const { code, parsed } = compareTraces(buildTrace({ resyncsPerTurn: 3 }), buildTrace({ resyncsPerTurn: 1 }));
  assert.equal(code, 0);
  assert.equal(rowOf(parsed, "resyncCount").verdict, "improvement");
});

test("a higher presentation-commit count is an improvement", () => {
  const { code, parsed } = compareTraces(buildTrace({ commitsPerTurn: 1 }), buildTrace({ commitsPerTurn: 2 }));
  assert.equal(code, 0);
  assert.equal(rowOf(parsed, "presentationCommitCount").verdict, "improvement");
  assert.equal(parsed.summary.regressions, 0);
});

test("more /state reads and more state conflicts are regressions", () => {
  const { code, parsed } = compareTraces(
    buildTrace({ stateReadsPerTurn: 1, conflictsPerTurn: 0 }),
    buildTrace({ stateReadsPerTurn: 5, conflictsPerTurn: 1 }),
  );
  assert.equal(code, 1);
  assert.equal(rowOf(parsed, "stateReadCount").verdict, "regression");
  assert.equal(rowOf(parsed, "event.http.state.conflict").verdict, "regression");
});

test("a trace-only code that is neutral stays neutral", () => {
  const { code, parsed } = compareTraces(
    buildTrace(),
    buildTrace({
      providerObservability: "unobserved",
      extraEvents: [{ at: 1000, kind: "provider", actor: "harness", code: "observability_gap" }],
    }),
  );
  assert.equal(code, 0, "an observation gap is not a defect");
  const gap = rowOf(parsed, "event.provider.observability_gap");
  assert.ok(gap);
  assert.equal(gap.before, 0);
  assert.equal(gap.after, 1);
  assert.equal(gap.verdict, "neutral");
  assert.equal(rowOf(parsed, "provider.observability").verdict, "neutral");
  assert.equal(parsed.summary.regressions, 0);
});

test("a newly appearing integrity event code is a regression", () => {
  const { code, parsed } = compareTraces(
    buildTrace(),
    buildTrace({ extraEvents: [{ at: 1000, kind: "memory", actor: "host", code: "conflict" }] }),
  );
  assert.equal(code, 1);
  const row = rowOf(parsed, "event.memory.conflict");
  assert.equal(row.before, 0);
  assert.equal(row.after, 1);
  assert.equal(row.verdict, "regression");
});

// ============================================================================
// Memory probe results
// ============================================================================

const PROBE_DIGEST = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

/** @param {string} code @param {object} [meta] */
function probeEvent(code, meta = {}) {
  return {
    at: 1000,
    kind: "probe",
    actor: "harness",
    code,
    meta: { probeId: "p-turn-01", manifestDigest: PROBE_DIGEST, distance: "turn", dimension: "retention", ...meta },
  };
}

test("probe outcomes are graded per their dimension and carry their own row per distance", () => {
  const { code, parsed } = compareTraces(
    buildTrace(),
    buildTrace({ extraEvents: [probeEvent("needle.hit")] }),
  );
  assert.equal(code, 0, "a probe hit is a measurement, not a defect");
  const row = rowOf(parsed, "probe.needle.hit.distance.turn");
  assert.ok(row, JSON.stringify(parsed.rows.map((entry) => entry.name)));
  assert.equal(row.kind, "probe");
  assert.equal(row.before, 0);
  assert.equal(row.after, 1);
  assert.equal(row.verdict, "improvement");
  // The aggregate event row exists too, and agrees.
  assert.equal(rowOf(parsed, "event.probe.needle.hit").verdict, "improvement");
});

test("a probe miss, a confused distractor and a failed supersede are measurements, never integrity failures", () => {
  // Two different exit codes are in play and they mean different things. The
  // audit tool's exit code is the integrity verdict (probe design §6.1: a miss is
  // never integrity), while this tool's exit code reports that a graded
  // direction moved — exactly as it already does for any `down` counter such as
  // /state reads. A measurement regression is therefore a diff to read, not a
  // correctness failure, and `isolateIntegrity` below pins that the same trace
  // audits as PASSED.
  const missed = buildTrace({
    extraEvents: [
      probeEvent("needle.miss", { distance: "fold", dimension: "retention" }),
      probeEvent("distractor.confused", { distance: "turn", dimension: "discrimination" }),
      probeEvent("supersede.fail", { distance: "turn", dimension: "supersession", reason: "old_retained" }),
    ],
  });
  const { code, parsed } = compareTraces(buildTrace(), missed);
  assert.equal(code, 1, "the comparison reports the direction regression it was designed to show");
  assert.equal(rowOf(parsed, "probe.needle.miss.distance.fold").verdict, "regression");
  assert.equal(rowOf(parsed, "probe.distractor.confused.distance.turn").verdict, "regression");
  assert.equal(rowOf(parsed, "probe.supersede.fail.distance.turn").verdict, "regression");
  assert.equal(parsed.summary.regressions, 6, "three probe codes, each reported as an event row and a per-distance row");
  assert.deepEqual(
    parsed.rows.filter((row) => row.verdict === "regression").map((row) => row.name).sort(),
    [
      "event.probe.distractor.confused",
      "event.probe.needle.miss",
      "event.probe.supersede.fail",
      "probe.distractor.confused.distance.turn",
      "probe.needle.miss.distance.fold",
      "probe.supersede.fail.distance.turn",
    ],
  );

  // The audit integrity verdict over the SAME trace passes: a miss is reported,
  // never failed.
  assert.equal(analyzeChatRunAudit(missed).integrity.passed, true);
  assert.deepEqual(analyzeChatRunAudit(missed).findings, []);
});

test("a probe observation gap and a clean isolation result stay neutral or positive", () => {
  const { code, parsed } = compareTraces(
    buildTrace(),
    buildTrace({
      extraEvents: [
        probeEvent("observability_gap", { distance: "fold", reason: "fold_not_observed" }),
        probeEvent("isolation.clean", { distance: "session", dimension: "isolation" }),
      ],
    }),
  );
  assert.equal(code, 0);
  assert.equal(rowOf(parsed, "probe.observability_gap.distance.fold").verdict, "neutral");
  assert.equal(rowOf(parsed, "probe.isolation.clean.distance.session").verdict, "improvement");
  assert.equal(parsed.summary.regressions, 0);
});

test("an appearing isolation breach is an integrity regression and fails the comparison", () => {
  const { code, stderr, parsed } = compareTraces(
    buildTrace(),
    buildTrace({
      extraEvents: [probeEvent("isolation.breach", { distance: "session", dimension: "isolation" })],
    }),
  );
  assert.equal(code, 1, "isolation.breach is the one probe outcome that fails closed");
  assert.match(stderr, /REGRESSION/);
  assert.match(stderr, /probe\.isolation\.breach\.distance\.session/);
  const row = rowOf(parsed, "probe.isolation.breach.distance.session");
  assert.equal(row.before, 0);
  assert.equal(row.after, 1);
  assert.equal(row.verdict, "regression");
});

test("a disappearing isolation breach is an improvement, even though it is an integrity code", () => {
  const { code, parsed } = compareTraces(
    buildTrace({ extraEvents: [probeEvent("isolation.breach", { distance: "session", dimension: "isolation" })] }),
    buildTrace(),
  );
  assert.equal(code, 0);
  assert.equal(rowOf(parsed, "probe.isolation.breach.distance.session").verdict, "improvement");
  assert.equal(parsed.summary.regressions, 0);
});

test("probe results measured against different manifests are refused rather than compared", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-cmp-"));
  const baseline = write(dir, "baseline.json", buildTrace({ extraEvents: [probeEvent("needle.hit")] }));
  const other = buildTrace({
    extraEvents: [probeEvent("needle.hit", { manifestDigest: "b".repeat(64) })],
  });
  const after = write(dir, "after.json", other);
  const result = compare(baseline, after);
  assert.equal(result.code, 2, "probe counts from different probe material are not comparable");
  assert.match(result.stderr, /not comparable: probe manifestDigest/);
  assert.equal(result.stdout, "");
});

test("a probe trace with an unbound result is rejected before any comparison", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-cmp-"));
  const good = write(dir, "good.json", buildTrace());
  const cases = [
    [
      "probe-no-binding.json",
      { at: 1000, kind: "probe", actor: "harness", code: "needle.hit", meta: { distance: "turn" } },
      /meta\.probeId/,
    ],
    ["probe-bad-digest.json", probeEvent("needle.hit", { manifestDigest: "nope" }), /meta\.manifestDigest/],
    ["probe-bad-distance.json", probeEvent("needle.hit", { distance: "week" }), /meta\.distance/],
    ["probe-bad-dimension.json", probeEvent("needle.hit", { dimension: "naturalness" }), /meta\.dimension/],
    [
      "probe-unplaced-breach.json",
      probeEvent("isolation.breach", { distance: "turn", dimension: "retention" }),
      /must carry meta\.dimension=isolation/,
    ],
    ["probe-content-key.json", probeEvent("needle.hit", { needle: "private" }), /meta\.needle is not an allowed meta key/],
  ];
  for (const [name, event, pattern] of cases) {
    const path = write(dir, name, buildTrace({ extraEvents: [{ ...event, at: 1000 }] }));
    const result = compare(path, good);
    assert.equal(result.code, 2, `${name} must exit 2`);
    assert.match(result.stderr, pattern);
    assert.equal(result.stdout, "", `${name} must not emit a comparison`);
  }
});

test("a turn that stopped completed is a regression and one that became completed is an improvement", () => {
  const worse = compareTraces(
    buildTrace({ states: ["completed"] }),
    buildTrace({ states: ["failed"], problemCodes: ["provider_unavailable"] }),
  );
  assert.equal(worse.code, 1);
  assert.equal(rowOf(worse.parsed, "turn[0].terminalState").verdict, "regression");

  const better = compareTraces(
    buildTrace({ states: ["failed"], problemCodes: ["provider_unavailable"] }),
    buildTrace({ states: ["completed"] }),
  );
  assert.equal(better.code, 0);
  assert.equal(rowOf(better.parsed, "turn[0].terminalState").verdict, "improvement");
});

test("attributable failures and cancellations with a durable read-back are not integrity findings", () => {
  const attributed = buildTrace({
    states: ["failed"],
    commitsPerTurn: 0,
    problemCodes: ["provider_unavailable"],
    stateReadsPerTurn: 1,
    trailingStateReads: 1,
  });
  const confirmedCancel = buildTrace({
    states: ["cancelled"],
    commitsPerTurn: 0,
    stateReadsPerTurn: 1,
    trailingStateReads: 1,
  });
  const { code, parsed } = compareTraces(attributed, confirmedCancel);
  assert.equal(code, 0, "a confirmed cancel after a /state read-back is not a defect");
  assert.equal(parsed.summary.regressions, 0);
  assert.equal(rowOf(parsed, "terminal_cancelled_without_readback"), undefined);
  assert.equal(rowOf(parsed, "terminal_failed_without_problem_code"), undefined);
});

test("a cancellation with no durable read-back after the terminal is an integrity finding", () => {
  const { code, parsed } = compareTraces(
    buildTrace({ states: ["cancelled"], commitsPerTurn: 0, stateReadsPerTurn: 1, trailingStateReads: 1 }),
    buildTrace({ states: ["cancelled"], commitsPerTurn: 0, stateReadsPerTurn: 1 }),
  );
  assert.equal(code, 1);
  assert.equal(rowOf(parsed, "terminal_cancelled_without_readback").verdict, "regression");
});

test("a later turn's /state polls are not a cancelled turn's read-back", () => {
  const { code, parsed } = compareTraces(
    buildTrace({ states: ["cancelled"], commitsPerTurn: 0, trailingStateReads: 1 }),
    buildTrace({ states: ["cancelled", "completed"], commitsPerTurn: 0, stateReadsPerTurn: 1 }),
  );
  assert.equal(code, 1);
  const row = rowOf(parsed, "terminal_cancelled_without_readback");
  assert.equal(row.after, 1, "the second turn's polls are that turn's evidence, not the cancelled turn's");
  assert.equal(row.verdict, "regression");
});

test("durations are reported but never ranked", () => {
  const { code, parsed } = compareTraces(
    buildTrace({ framesPerTurn: 2 }),
    buildTrace({ framesPerTurn: 2, frameGapMsPerTurn: 400 }),
  );
  assert.equal(code, 0, "a slower run must not fail the comparison");
  const duration = rowOf(parsed, "turn[0].maxFrameGapMs");
  assert.ok(duration);
  assert.equal(duration.kind, "duration");
  assert.equal(duration.verdict, "neutral");
  assert.ok(duration.after > duration.before);
  assert.equal(parsed.summary.regressions, 0);
});

test("a duration absent from either trace is not compared", () => {
  const { parsed } = compareTraces(buildTrace(), buildTrace());
  assert.equal(rowOf(parsed, "turn[0].firstFrameLatencyMs"), undefined);
  assert.equal(rowOf(parsed, "turn[0].wallTimeMs"), undefined);
});

test("a trace that never reached a terminal state while the provider was sent is an integrity finding", () => {
  const unsettled = buildTrace({ states: ["completed"], providerSentPerTurn: true });
  const stuck = JSON.parse(JSON.stringify(unsettled));
  stuck.events = stuck.events.filter(
    (event) => event.code !== "turn.terminal" && event.code !== "settled",
  );
  const { code, parsed } = compareTraces(unsettled, stuck);
  assert.equal(code, 1);
  assert.equal(rowOf(parsed, "provider_boundary_unsettled").verdict, "regression");
});

test("traces that disagree on the embedding are refused rather than compared", () => {
  const external = buildTrace();
  external.provider.embedded = false;
  const dir = mkdtempSync(join(tmpdir(), "chat-cmp-"));
  const baseline = write(dir, "baseline.json", buildTrace());
  const after = write(dir, "after.json", external);
  const result = compare(baseline, after);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /not comparable: provider\.embedded/);
  assert.equal(result.stdout, "");
});

test("a usage error exits 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-cmp-"));
  const baseline = write(dir, "baseline.json", buildTrace());
  const missingArgs = compare(baseline);
  assert.equal(missingArgs.code, 2);
  const missingFile = compare(baseline, join(dir, "absent.json"));
  assert.equal(missingFile.code, 2);
  assert.match(missingFile.stderr, /missing input file/);
});

test("malformed or invalid input exits 2 without a partial comparison", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-cmp-"));
  const good = write(dir, "good.json", buildTrace());
  const cases = [
    ["broken.json", "{ not json", /not valid JSON/],
    ["wrong-schema.json", JSON.stringify({ ...buildTrace(), schema: "chat_run_audit/v2" }), /schema is/],
    [
      "unknown-code.json",
      JSON.stringify({
        ...buildTrace(),
        events: [...buildTrace().events, { at: 9000, kind: "sse", actor: "host", code: "unknown.thing" }],
      }),
      /not in the frozen chat_run_audit\/v1 vocabulary/,
    ],
    [
      "unknown-meta.json",
      JSON.stringify({
        ...buildTrace(),
        events: [{ at: 0, kind: "lifecycle", actor: "harness", code: "run.started", meta: { prompt: "hi" } }],
      }),
      /meta.prompt is not an allowed meta key/,
    ],
    [
      "unordered.json",
      JSON.stringify({
        ...buildTrace(),
        events: [
    { at: 100, kind: "lifecycle", actor: "harness", code: "run.started" },
    { at: 50, kind: "sse", actor: "host", code: "frame.received" },
        ],
      }),
      /precedes/,
    ],
    ["bad-surface.json", JSON.stringify({ ...buildTrace(), surface: "chat-only,game" }), /expected "chat-only"/],
  ];
  for (const [name, contents, pattern] of cases) {
    const path = write(dir, name, contents);
    const result = compare(path, good);
    assert.equal(result.code, 2, `${name} must exit 2`);
    assert.match(result.stderr, pattern);
    assert.equal(result.stdout, "", `${name} must not emit a comparison`);
  }
});
