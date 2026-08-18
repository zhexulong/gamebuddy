import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { GAME_OPERATIONAL_GATE_MARKER_SCHEMA } from "./lib/game-operational-gate-marker.mjs";
import {
  createOperationalDeploymentManifest,
  parseArguments,
  prepareReportTarget,
  verifyOperationalMarkers,
  writeReport,
} from "./run-game-operational-gate.mjs";

const nonce = "a".repeat(64);
const sessions = { chat: "chat_session", game: "game_session", foreign: "foreign_session" };
function report(sessionId, surface, semantic, interaction) {
  return {
    schema: GAME_OPERATIONAL_GATE_MARKER_SCHEMA,
    sessionId,
    nonceSha256: nonce,
    surface,
    m1MaxMemoryMutationId: 1,
    materializedCategoryCounts: { SEMANTIC_MEMORY: semantic, INTERACTION_EPISODE: interaction },
  };
}

test("parser requires one config and permits only an optional report", () => {
  assert.deepEqual(parseArguments(["--config", "C:/gate.json"]), {
    configPath: resolve("C:/gate.json"),
    reportPath: undefined,
  });
  assert.throws(() => parseArguments([]), /usage:/);
  assert.throws(() => parseArguments(["--report", "x"]), /usage:/);
  assert.throws(() => parseArguments(["--config", "x", "--config", "y"]), /usage:/);
});

test("schema-v2 manifests bind the shared Memory root to the exact shared identity", () => {
  const principal = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" };
  assert.deepEqual(createOperationalDeploymentManifest("C:/runtime/chat", principal, "bootstrap_01"), {
    schemaVersion: 2,
    topology: "independent_chat_and_game_surfaces",
    runtimeRoot: "C:/runtime/chat",
    principal,
    bootstrapOperationId: "bootstrap_01",
    authorityGeneration: 1,
  });
});

test("marker verifier binds launcher sessions and rejects a foreign shared delta", () => {
  const reports = {
    chat: report(sessions.chat, "chat", 1, 1),
    game: report(sessions.game, "game", 1, 1),
    foreign: report(sessions.foreign, "chat", 0, 0),
  };
  assert.deepEqual(verifyOperationalMarkers(reports, sessions, nonce), {
    state: "READY",
    assertions: { sharedMaterialized: true, foreignZeroSharedDelta: true },
  });
  assert.equal(
    verifyOperationalMarkers({ ...reports, foreign: report(sessions.foreign, "chat", 1, 0) }, sessions, nonce)
      .reasonCode,
    "foreign_marker_shared_delta_observed",
  );
  assert.equal(
    verifyOperationalMarkers(reports, { ...sessions, game: "other" }, nonce).reasonCode,
    "game_marker_binding_mismatch",
  );
});

test("reports are create-only and reject content or credential-shaped fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "game-operational-gate-test-"));
  try {
    const target = await prepareReportTarget(join(root, "report.json"));
    await writeReport(target, { schema: "test/v1", state: "BLOCKED", reasonCode: "bridge_unavailable" });
    assert.equal(JSON.parse(await readFile(target, "utf8")).state, "BLOCKED");
    await assert.rejects(
      writeReport(await prepareReportTarget(join(root, "bad.json")), { prompt: "private" }),
      /content_guard/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner remains launcher-only and refuses an unobservable Game seam", async () => {
  const source = await readFile(new URL("./run-game-operational-gate.mjs", import.meta.url), "utf8");
  assert.match(source, /start-production-artifact\.mjs/);
  assert.match(source, /game_operational_runtime_or_bridge_receipt_ipc_unavailable/);
  assert.match(source, /validateGameOperationalGatePreflight/);
  assert.match(source, /sharedIdentity/);
  assert.match(source, /foreignIdentity/);
  assert.match(source, /surfaceSessions/);
  assert.doesNotMatch(source, /node:sqlite|DatabaseSync|sqlite3/i);
  assert.doesNotMatch(source, /mock.*bridge|fake.*bridge/i);
});
