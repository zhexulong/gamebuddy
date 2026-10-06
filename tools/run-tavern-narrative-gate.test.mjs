import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyNarrativeStartupFailure,
  classifyNarrativeStartupStderr,
  classifyNarrativeTurnBlock,
  classifyNarrativeTurnOutcome,
  createNarrativeGateDeploymentManifest,
  deriveAttemptPosition,
  deriveAuthenticatedReferenceChatApi,
  evaluateNarrativeGateMarker,
  evaluateNarrativeGateRuntime,
  NARRATIVE_RUN_KINDS,
  NARRATIVE_RUN_FAILURE_CODES,
  NARRATIVE_RUN_POSITIONS,
  narrativeTurnDurableState,
  observedTurnFailure,
  parseArguments,
  prepareReportTarget,
  projectGuardSafeFailureCode,
  projectTranscriptShape,
  reportBase,
  writeReport,
} from "./run-tavern-narrative-gate.mjs";

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-tavern-gate-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("narrative gate accepts only its optional report argument and a bounded attempt kind", () => {
  assert.deepEqual(parseArguments([]), { reportPath: undefined, kind: "main" });
  for (const kind of NARRATIVE_RUN_KINDS)
    assert.equal(parseArguments(["--report", "report.json", "--kind", kind]).kind, kind);
  assert.throws(() => parseArguments(["--report"]), /usage:/);
  assert.throws(() => parseArguments(["--unknown", "report.json"]), /usage:/);
  // The kind is a closed vocabulary: a free-text label can never be an attempt.
  assert.throws(() => parseArguments(["--kind", "attempt_labels_not_exercised_distinctions"]), /usage:/);
  assert.throws(() => parseArguments(["--kind"]), /usage:/);
  assert.throws(() => parseArguments(["--kind", "failure", "--kind", "main"]), /duplicate_kind/);
});

test("narrative gate derives each kind's position from observations, never from the requested kind", () => {
  // The three kinds report three different positions...
  assert.equal(NARRATIVE_RUN_POSITIONS.main, "fresh_chat_completed_turn");
  assert.equal(NARRATIVE_RUN_POSITIONS.failure, "provider_rejected_turn_failed");
  assert.equal(NARRATIVE_RUN_POSITIONS.recovery, "resumed_existing_chat_completed_turn");
  const happyPath = {
    freshChat: true,
    turnTerminalState: "completed",
    providerBoundaryCrossed: true,
  };
  assert.equal(deriveAttemptPosition("main", happyPath), NARRATIVE_RUN_POSITIONS.main);
  // ...and a happy path asked to be the failure or recovery attempt derives
  // NOTHING, which is what makes relabelling alone unsatisfiable.
  assert.equal(deriveAttemptPosition("failure", happyPath), undefined);
  assert.equal(deriveAttemptPosition("recovery", happyPath), undefined);
  const realFailure = {
    turnTerminalState: "failed",
    providerBoundaryCrossed: true,
    problemCode: "runtime_unavailable",
  };
  assert.equal(deriveAttemptPosition("failure", realFailure), NARRATIVE_RUN_POSITIONS.failure);
  assert.equal(deriveAttemptPosition("main", realFailure), undefined);
  // "Some failure happened" is NOT the failing position. The same durable
  // `failed` terminal with a code this plan does not accept derives nothing...
  assert.deepEqual(NARRATIVE_RUN_FAILURE_CODES, ["runtime_unavailable"]);
  assert.equal(
    deriveAttemptPosition("failure", { ...realFailure, problemCode: "no_visible_presentation" }),
    undefined,
  );
  assert.equal(
    deriveAttemptPosition("failure", { ...realFailure, problemCode: "unavailable" }),
    undefined,
  );
  // ...and neither does a failure that never reached the provider, or one whose
  // evidence carries no bounded code at all.
  assert.equal(
    deriveAttemptPosition("failure", { ...realFailure, providerBoundaryCrossed: false }),
    undefined,
  );
  assert.equal(
    deriveAttemptPosition("failure", { turnTerminalState: "failed", providerBoundaryCrossed: true }),
    undefined,
  );
  // A recovered Chat that did not keep the predecessor transcript is not a
  // recovery, and a resumed-but-idle Chat (no further committed turn) is not one
  // either: the counts must actually grow.
  const recovery = {
    freshChat: true,
    predecessorTurnTerminalState: "completed",
    predecessorTranscriptLength: 2,
    resumedTranscriptLength: 2,
    resumedTranscriptKeepsPredecessor: true,
    postResumeTurnTerminalState: "completed",
    postResumeTranscriptLength: 4,
  };
  assert.equal(deriveAttemptPosition("recovery", recovery), NARRATIVE_RUN_POSITIONS.recovery);
  assert.equal(
    deriveAttemptPosition("recovery", { ...recovery, resumedTranscriptKeepsPredecessor: false }),
    undefined,
  );
  assert.equal(
    deriveAttemptPosition("recovery", { ...recovery, postResumeTranscriptLength: 2 }),
    undefined,
  );
  assert.equal(deriveAttemptPosition("recovery", { ...recovery, resumedTranscriptLength: 0 }), undefined);
});

test("the failing attempt's evidence is derived from the product's own durable failure observation", () => {
  // The exact shape a real failing attempt produced: Pi's prompt rejected after
  // the request crossed the provider boundary and the durable turn failed with
  // this bounded product code. The runner's observation KIND is `turn_failed`
  // while the durable state the product reports is `failed`; comparing the kind
  // against the durable name is what made a genuinely failed live attempt
  // unsatisfiable, so this pins the mapping between them.
  const observed = Object.freeze({ kind: "turn_failed", problemCode: "runtime_unavailable" });
  assert.equal(narrativeTurnDurableState(observed), "failed");
  assert.deepEqual(observedTurnFailure(observed), {
    turnTerminalState: "failed",
    problemCode: "runtime_unavailable",
  });
  // What the runner puts in the position evidence for that observation reaches
  // the failing position...
  assert.equal(
    deriveAttemptPosition("failure", {
      turnTerminalState: narrativeTurnDurableState(observed),
      providerBoundaryCrossed: true,
      problemCode: observedTurnFailure(observed).problemCode,
    }),
    NARRATIVE_RUN_POSITIONS.failure,
  );
  // ...while a completed turn, a code-less failure, and a failure we never saw
  // terminal facts for do not.
  assert.equal(narrativeTurnDurableState("completed"), "completed");
  assert.equal(observedTurnFailure("completed"), undefined);
  assert.equal(narrativeTurnDurableState("timeout"), "timeout");
  assert.equal(observedTurnFailure({ kind: "turn_failed" }).problemCode, "unavailable");
  assert.equal(observedTurnFailure("turn_failed").problemCode, "unavailable");
  assert.equal(
    deriveAttemptPosition(
      "failure",
      observedTurnFailure({ kind: "turn_failed" }) === undefined
        ? {}
        : {
            turnTerminalState: "failed",
            providerBoundaryCrossed: true,
            problemCode: observedTurnFailure({ kind: "turn_failed" }).problemCode,
          },
    ),
    undefined,
  );
});

test("authenticatedReferenceChatApi reports the authenticated operations that were observed", () => {
  assert.equal(
    deriveAuthenticatedReferenceChatApi({ stateSnapshotObserved: true, submissionAccepted: true }),
    true,
  );
  // Each observed half can independently make it false, so it is an observation
  // and not the literal it used to be.
  assert.equal(
    deriveAuthenticatedReferenceChatApi({ stateSnapshotObserved: false, submissionAccepted: true }),
    false,
  );
  assert.equal(
    deriveAuthenticatedReferenceChatApi({ stateSnapshotObserved: true, submissionAccepted: false }),
    false,
  );
  assert.equal(deriveAuthenticatedReferenceChatApi(undefined), false);
});

test("the runner keeps only the transcript's structure, never its text", () => {
  assert.deepEqual(
    projectTranscriptShape([
      { role: "player", text: "private prompt", order: 0 },
      { role: "companion", text: "private dialogue", order: 1 },
      { text: "no role", order: 2 },
    ]),
    [
      { role: "player", order: 0 },
      { role: "companion", order: 1 },
      { role: "unknown", order: 2 },
    ],
  );
  assert.deepEqual(projectTranscriptShape(undefined), []);
});

test("a refused submission is a bounded block code, never an unbounded message", () => {
  assert.equal(
    classifyNarrativeTurnBlock({ kind: "turn_failed", problemCode: "runtime_unavailable" }),
    "turn_failed:runtime_unavailable",
  );
  assert.equal(
    classifyNarrativeTurnBlock({ kind: "submission_refused", status: 409, problemCode: "turn_busy" }),
    "message_failed:409:turn_busy",
  );
  assert.equal(classifyNarrativeTurnBlock("completed"), undefined);
});

test("narrative gate creates the exact schema-v2 independent-surface deployment manifest", () => {
  const principal = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" };
  assert.deepEqual(createNarrativeGateDeploymentManifest("C:/fresh-runtime", principal, "bootstrap_01"), {
    schemaVersion: 2,
    topology: "independent_chat_and_game_surfaces",
    runtimeRoot: "C:/fresh-runtime",
    principal,
    bootstrapOperationId: "bootstrap_01",
    authorityGeneration: 1,
  });
});

test("narrative gate classifies bounded startup stderr for exit-before-ready failures", () => {
  assert.equal(
    classifyNarrativeStartupStderr("Error: dialogue_deployment_manifest_path_required\n"),
    "dialogue_start_stderr:dialogue_deployment_manifest_path_required",
  );
  assert.equal(
    classifyNarrativeStartupFailure(
      new Error("dialogue_exited_before_ready:1"),
      "desktop_compose_runtime_admission_mismatch\n",
    ),
    "dialogue_start_stderr:desktop_compose_runtime_admission_mismatch",
  );
  assert.equal(
    classifyNarrativeStartupFailure(new Error("desktop_compose_bootstrap_ack_invalid"), ""),
    "desktop_compose_bootstrap_ack_invalid",
  );
  assert.equal(classifyNarrativeStartupStderr("Error: private prompt text\n"), undefined);
  assert.equal(classifyNarrativeStartupFailure(new Error("dialogue_exited_before_ready:1"), ""), "dialogue_exited_before_ready:1");
});

test("narrative gate distinguishes a provider wait from a missing durable terminal signal", () => {
  assert.equal(classifyNarrativeTurnOutcome("timeout", []), "provider_request_pending");
  assert.equal(
    classifyNarrativeTurnOutcome("timeout", ["turn.state_changed"]),
    "dialogue_terminal_signal_unobserved",
  );
  assert.equal(classifyNarrativeTurnOutcome("turn_failed", ["turn.state_changed"]), undefined);
});

test("narrative gate fails closed when no child IPC marker exists", () => {
  assert.deepEqual(evaluateNarrativeGateMarker(undefined, "a".repeat(64), "pi_session_1"), {
    observed: false,
    reasonCode: "provider_marker_unavailable",
  });
});

test("runtime IPC provides an independently validated Pi session identity", () => {
  assert.deepEqual(
    evaluateNarrativeGateRuntime({ schema: "gamebuddy-tavern-narrative-gate-runtime/v1", piSessionId: "pi_session_1" }),
    { observed: true, piSessionId: "pi_session_1" },
  );
  assert.deepEqual(evaluateNarrativeGateRuntime(undefined), {
    observed: false,
    reasonCode: "provider_runtime_session_unavailable",
  });
});

test("child IPC marker requires the expected digest and session mapping", () => {
  assert.deepEqual(
    evaluateNarrativeGateMarker(
      { schema: "gamebuddy-tavern-narrative-gate-marker/v1", sessionId: "pi_session_1", nonceSha256: "a".repeat(64) },
      "a".repeat(64),
      "pi_session_1",
    ),
    { observed: true, preSendSerialized: true },
  );
  assert.equal(
    evaluateNarrativeGateMarker(
      { schema: "gamebuddy-tavern-narrative-gate-marker/v1", sessionId: "pi_session_1", nonceSha256: "b".repeat(64) },
      "a".repeat(64),
      "pi_session_1",
    ).reasonCode,
    "provider_marker_digest_mismatch",
  );
});

test("report writer is create-only and rejects content-bearing evidence", () =>
  withRoot(async (root) => {
    const target = await prepareReportTarget(join(root, "report.json"));
    await writeReport(target, { schema: "test/v1", state: "blocked", reasonCode: "provider_marker_unavailable" });
    assert.equal(JSON.parse(await readFile(target, "utf8")).state, "blocked");
    await assert.rejects(writeReport(target, { state: "blocked" }), { code: "EEXIST" });
    await assert.rejects(
      writeReport(await prepareReportTarget(join(root, "content.json")), { prompt: "private prompt" }),
      /evidence_report_content_guard_rejected/,
    );
    const parentFile = join(root, "not-a-directory");
    await writeFile(parentFile, "not a directory");
    await assert.rejects(prepareReportTarget(join(parentFile, "report.json")), /report_parent_not_real_directory/);
  }));

test("report base note is neutral metadata that never trips the evidence content guard and reports write successfully", () =>
  withRoot(async (root) => {
    const note = reportBase("r1", new Date().toISOString(), { generation: "g-1", inventoryDigest: "a".repeat(64) }).note;
    assert.doesNotMatch(
      note,
      /The player prefers|private dialogue|private prompt|csrf|cookie|stateToken|bootstrap|raw provider output|prompt text/i,
    );
    const passed = {
      ...reportBase("r1", new Date().toISOString(), { generation: "g-1", inventoryDigest: "a".repeat(64) }),
      state: "passed",
      providerInvocation: true,
      assertions: {
        authenticatedReferenceChatApi: true,
        realDialogueTurnAttempted: true,
        providerRuntimeSessionBound: true,
        providerPreSendSerialized: true,
        realTurnOutcomeObserved: true,
        providerAcceptedOrSemanticAnswer: false,
      },
      statuses: { turn: "completed", lastState: "completed", lastProblemCode: undefined, p4Stages: ["prompt_begin", "commit_done"], runtimeCodes: [] },
    };
    const passedTarget = await prepareReportTarget(join(root, "passed.json"));
    await writeReport(passedTarget, passed);
    assert.equal(JSON.parse(await readFile(passedTarget, "utf8")).state, "passed");
    const blocked = {
      ...reportBase("r2", new Date().toISOString(), { generation: "g-1", inventoryDigest: "a".repeat(64) }),
      state: "blocked",
      assertions: {
        authenticatedReferenceChatApi: true,
        realDialogueTurnAttempted: false,
        providerRuntimeSessionBound: false,
        providerPreSendSerialized: false,
        realTurnOutcomeObserved: false,
        providerAcceptedOrSemanticAnswer: false,
      },
      statuses: { turn: "timeout", lastState: "running", lastProblemCode: undefined, p4Stages: [], runtimeCodes: ["unavailable"] },
      reasonCode: "provider_marker_unavailable",
    };
    const blockedTarget = await prepareReportTarget(join(root, "blocked.json"));
    await writeReport(blockedTarget, blocked);
    assert.equal(JSON.parse(await readFile(blockedTarget, "utf8")).reasonCode, "provider_marker_unavailable");
  }));

test("blocked system failure codes are projected guard-safe so evidence can be written and stay content-free on disk", () =>
  withRoot(async (root) => {
    const guard = /The player prefers|private dialogue|private prompt|csrf|cookie|stateToken|bootstrap|raw provider output|prompt text/i;
    for (const [raw, expected] of [
      ["desktop_runtime_bootstrap_unavailable", "desktop_runtime_host_launch_unavailable"],
      ["dialogue_start_stderr:desktop_runtime_bootstrap_unavailable", "dialogue_start_stderr:desktop_runtime_host_launch_unavailable"],
      ["desktop_compose_bootstrap_ack_invalid", "desktop_compose_host_launch_ack_invalid"],
      ["bootstrap_failed:500", "host_launch_failed:500"],
    ]) {
      assert.equal(projectGuardSafeFailureCode(raw), expected);
      assert.doesNotMatch(expected, guard);
    }
    // Non-guard codes and invalid values pass through the charset validation untouched.
    assert.equal(projectGuardSafeFailureCode("provider_marker_unavailable"), "provider_marker_unavailable");
    assert.equal(projectGuardSafeFailureCode("content with spaces"), "live_runner_internal_error");

    const base = () => reportBase("r3", new Date().toISOString(), { generation: "g-1", inventoryDigest: "a".repeat(64) });
    // Contrast: the raw system code is rejected by the guard before projection...
    const rawTarget = await prepareReportTarget(join(root, "raw.json"));
    await assert.rejects(writeReport(rawTarget, { ...base(), state: "blocked", reasonCode: "bootstrap_failed:500" }), /evidence_report_content_guard_rejected/);
    // ...and the projected blocked report (reasonCode plus runtimeCodes) is written and lands guard-free.
    const projectedTarget = await prepareReportTarget(join(root, "projected.json"));
    await writeReport(projectedTarget, {
      ...base(),
      state: "blocked",
      reasonCode: projectGuardSafeFailureCode("bootstrap_failed:500"),
      statuses: {
        turn: "timeout",
        lastState: "running",
        lastProblemCode: undefined,
        p4Stages: ["prompt_begin"],
        runtimeCodes: ["desktop_runtime_bootstrap_unavailable", "unavailable"].map((code) => projectGuardSafeFailureCode(code)),
      },
    });
    const onDisk = await readFile(projectedTarget, "utf8");
    assert.doesNotMatch(onDisk, guard);
    assert.equal(JSON.parse(onDisk).reasonCode, "host_launch_failed:500");
    assert.deepEqual(JSON.parse(onDisk).statuses.runtimeCodes, ["desktop_runtime_host_launch_unavailable", "unavailable"]);
  }));

test("Reference live runner stays on the composition bootstrap and authenticated Chat API and never opens SQLite or auto-promotes", async () => {
  const source = await readFile(new URL("./run-tavern-narrative-gate.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:sqlite|DatabaseSync|sqlite3/i);
  assert.doesNotMatch(source, /createChatThreadStore|initial-chat-exact-content-port|chat-thread-store/i);
  assert.doesNotMatch(source, /autoPromote|auto_promote\s*:\s*true/i);
  // E2 spawn protocol: the gate drives the Desktop composition bootstrap through
  // the launcher seam; the removed entry and the chat-live branch never appear.
  assert.match(source, /from "\.\/desktop-composition-launch\.mjs"/);
  assert.match(source, /launchDesktopCompositionGateChild\(/);
  assert.match(source, /surface: "chat-only"/);
  // The launcher is given the runner's own gate output root, whose default is
  // the repository `host/dist` pointer root. The previous spelling pinned a
  // literal `outputRoot: join(HOST_ROOT, "dist")` call site that had already
  // stopped existing, so the assertion failed while the guarantee held; this
  // pins the constant AND the call that consumes it.
  assert.match(source, /outputRoot: OUTPUT_ROOT,/);
  assert.match(
    source,
    /const OUTPUT_ROOT = process\.env\.GAMEBUDDY_TAVERN_GATE_OUTPUT_ROOT[\s\S]{0,120}join\(HOST_ROOT, "dist"\)/,
  );
  assert.doesNotMatch(source, /start-production-artifact\.mjs|dialogue-web-main/);
  assert.doesNotMatch(source, /chat-tavern-live|CHAT_LIVE_ARTIFACT|GAMEBUDDY_CHAT_LIVE_ARTIFACT/);
  assert.doesNotMatch(source, /--tavern-narrative-gate-nonce-sha256=/);
  // The nonce digest reaches the composed runtime only through the launcher env
  // seam; the gate source itself never names the env or the raw nonce.
  assert.match(source, /nonceSha256,/);
  assert.doesNotMatch(source, /GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256/);
  assert.doesNotMatch(source, /const nonce[^\n]*=.*nonceSha256/);
  assert.match(source, /schemaVersion: 2/);
  assert.match(source, /topology: "independent_chat_and_game_surfaces"/);
  assert.match(source, /bootstrapOperationId/);
  assert.match(source, /authorityGeneration: 1/);
  assert.match(source, /X-CSRF-Token/);
  assert.match(source, /Idempotency-Key/);
  assert.match(source, /\/api\/tavern\/v1\/state/);
  assert.match(source, /authenticatedReferenceChatApi/);
  assert.doesNotMatch(source, /\/memories\/exclude-source/);
  assert.match(source, /waitForReady\(\)/);
  assert.doesNotMatch(source, /GAMEBUDDY_TAVERN_RAW_INVOCATION_SIGNAL_PATH/);
  assert.match(source, /tavern-narrative-gate-marker\/v1/);
  assert.match(source, /tavern-narrative-gate-runtime\/v1/);
  assert.match(source, /provider_request_pending/);
  assert.match(source, /dialogue_terminal_signal_unobserved/);
  assert.match(
    source,
    /evaluateNarrativeGateMarker\(\r?\n      marker,\r?\n      nonceSha256,\r?\n      runtimeSession\.observed \? runtimeSession\.piSessionId : undefined,/,
  );
  assert.doesNotMatch(source, /markerSessionId = typeof marker\?\.sessionId/);
  // The attempt kind is a CLOSED vocabulary and the only place a position is
  // produced is the derivation from observations.
  assert.match(source, /NARRATIVE_RUN_KINDS\.includes\(value\)/);
  assert.match(source, /deriveAttemptPosition\(kind, evidence\)/);
  // The failing kind's requirement is named beside the kinds - the one bounded
  // product code an acceptable failure may carry - and the failing attempt's
  // evidence is derived from the durable state (not the observation kind) plus
  // that code. The self-restating `providerRejectionPosition` field is gone: it
  // only restated the other two keys and could never be produced by a real
  // attempt that compared the observation kind against the durable state name.
  assert.match(source, /NARRATIVE_RUN_FAILURE_CODES = Object\.freeze\(\["runtime_unavailable"\]\)/);
  assert.match(source, /NARRATIVE_RUN_FAILURE_CODES\.includes\(evidence\?\.problemCode\)/);
  assert.match(source, /const turnTerminalState = narrativeTurnDurableState\(turn\.outcome\)/);
  assert.doesNotMatch(source, /providerRejectionPosition/);
});
