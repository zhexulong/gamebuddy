import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyNarrativeTurnOutcome,
  createNarrativeGateDeploymentManifest,
  evaluateNarrativeGateMarker,
  evaluateNarrativeGateRuntime,
  parseArguments,
  prepareReportTarget,
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

test("narrative gate accepts only its optional report argument", () => {
  assert.deepEqual(parseArguments([]), { reportPath: undefined });
  assert.throws(() => parseArguments(["--report"]), /usage:/);
  assert.throws(() => parseArguments(["--unknown", "report.json"]), /usage:/);
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

test("narrative gate distinguishes a provider wait from a missing durable terminal signal", () => {
  assert.equal(classifyNarrativeTurnOutcome("timeout", []), "provider_request_pending");
  assert.equal(classifyNarrativeTurnOutcome("timeout", ["turn.state_changed"]), "dialogue_terminal_signal_unobserved");
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

test("Reference live runner stays on authenticated Chat API and never opens SQLite or auto-promotes", async () => {
  const source = await readFile(new URL("./run-tavern-narrative-gate.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:sqlite|DatabaseSync|sqlite3/i);
  assert.doesNotMatch(source, /createChatThreadStore|initial-chat-exact-content-port|chat-thread-store/i);
  assert.doesNotMatch(source, /autoPromote|auto_promote\s*:\s*true/i);
  assert.match(source, /start-production-artifact\.mjs/);
  assert.match(source, /schemaVersion: 2/);
  assert.match(source, /topology: "independent_chat_and_game_surfaces"/);
  assert.match(source, /bootstrapOperationId/);
  assert.match(source, /authorityGeneration: 1/);
  assert.match(source, /--tavern-narrative-gate-nonce-sha256=\$\{nonceSha256\}/);
  assert.doesNotMatch(source, /GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256/);
  assert.match(source, /X-CSRF-Token/);
  assert.match(source, /Idempotency-Key/);
  assert.match(source, /\/api\/tavern\/v1\/state/);
  assert.match(source, /authenticatedReferenceChatApi/);
  assert.doesNotMatch(source, /\/memories\/exclude-source/);
  assert.match(source, /stdio: \["ignore", "pipe", "pipe", "ipc"\]/);
  assert.doesNotMatch(source, /GAMEBUDDY_TAVERN_RAW_INVOCATION_SIGNAL_PATH/);
  assert.match(source, /tavern-narrative-gate-marker\/v1/);
  assert.match(source, /tavern-narrative-gate-runtime\/v1/);
  assert.match(source, /provider_request_pending/);
  assert.match(source, /dialogue_terminal_signal_unobserved/);
  assert.match(
    source,
    /evaluateNarrativeGateMarker\(\r?\n {6}marker,\r?\n {6}nonceSha256,\r?\n {6}runtimeSession\.observed \? runtimeSession\.piSessionId : undefined,/,
  );
  assert.doesNotMatch(source, /markerSessionId = typeof marker\?\.sessionId/);
});
