import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDeploymentManifest,
  createExactNextProviderAttestationCollector,
  evaluateExactNextProviderAttestation,
  isContentFreeReport,
  parseArguments,
  prepareReportTarget,
  writeReport,
} from "./run-player-memory-next-round-attestation.mjs";

const nonceSha256 = "a".repeat(64);
const expected = Object.freeze({ sessionId: "pi_chat_01", nonceSha256 });
function attestation(overrides = {}) {
  return {
    schema: "gamebuddy-player-memory-next-round-host-attestation/v1",
    nonceSha256,
    sessionId: "pi_chat_01",
    surface: "chat",
    providerRoundGeneration: 1,
    exactSelectedCoverage: true,
    ...overrides,
  };
}
async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-next-attestation-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("argument parsing accepts only an optional report target", () => {
  assert.deepEqual(parseArguments([]), { reportPath: undefined });
  assert.throws(() => parseArguments(["--report"]), /usage:/);
  assert.throws(() => parseArguments(["--other", "report.json"]), /usage:/);
});

test("report target is create-only 0600 and rejects content-bearing values", () =>
  withRoot(async (root) => {
    const target = await prepareReportTarget(join(root, "report.json"));
    await writeReport(target, { state: "blocked", reasonCode: "provider_attestation_unavailable" });
    if (process.platform !== "win32") assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(target, "utf8")).state, "blocked");
    await assert.rejects(writeReport(target, { state: "blocked" }), { code: "EEXIST" });
    await assert.rejects(
      writeReport(await prepareReportTarget(join(root, "bad.json")), { prompt: "private content" }),
      /content_guard/,
    );
    assert.equal(isContentFreeReport('{"providerResponse":"no"}'), false);
    const fileParent = join(root, "file-parent");
    await writeFile(fileParent, "x");
    await assert.rejects(prepareReportTarget(join(fileParent, "report.json")), /report_parent_not_real_directory/);
  }));

test("strict Host attestation binds session nonce and accepted source exact coverage", () => {
  const result = evaluateExactNextProviderAttestation(attestation(), expected);
  assert.equal(result.observed, true);
  assert.equal(result.providerInvocation, true);
  assert.equal(
    evaluateExactNextProviderAttestation(attestation({ exactSelectedCoverage: false }), expected).reasonCode,
    "provider_attestation_schema_invalid",
  );
  assert.equal(
    evaluateExactNextProviderAttestation(attestation({ nonceSha256: "b".repeat(64) }), expected).reasonCode,
    "provider_attestation_binding_mismatch",
  );
  assert.equal(
    evaluateExactNextProviderAttestation(attestation({ sessionId: "pi_other" }), expected).reasonCode,
    "provider_attestation_binding_mismatch",
  );
  assert.equal(
    evaluateExactNextProviderAttestation({ ...attestation(), extra: true }, expected).reasonCode,
    "provider_attestation_schema_invalid",
  );
  assert.equal(
    evaluateExactNextProviderAttestation(undefined, expected).reasonCode,
    "provider_attestation_unavailable",
  );
});

test("collector rejects unknown IPC and replay after its one strict positive attestation", () => {
  const collector = createExactNextProviderAttestationCollector(expected);
  assert.equal(collector.collect({ schema: "unknown/v1" }).reasonCode, "provider_attestation_schema_invalid");
  assert.equal(collector.collect(attestation()).observed, true);
  assert.equal(collector.collect(attestation()).reasonCode, "provider_attestation_replayed");
});

test("schema-v2 manifest is an independent Chat deployment", () => {
  const principal = { playerId: "player", companionId: "companion", continuityId: "continuity" };
  assert.deepEqual(createDeploymentManifest("C:/fresh", principal, "bootstrap"), {
    schemaVersion: 2,
    topology: "independent_chat_and_game_surfaces",
    runtimeRoot: "C:/fresh",
    principal,
    bootstrapOperationId: "bootstrap",
    authorityGeneration: 1,
  });
});

test("runner stays external to SQLite, mocks, UI, and Host source while requiring the production launcher and opt-in", async () => {
  const source = await readFile(new URL("./run-player-memory-next-round-attestation.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:sqlite|DatabaseSync|sqlite3|openDatabaseAsync/i);
  assert.doesNotMatch(source, /mock provider|fake provider|mockProvider|playwright|puppeteer|webdriver/i);
  assert.doesNotMatch(source, /host\/src|vendor\//i);
  assert.match(source, /start-production-artifact\.mjs/);
  assert.match(source, /schemaVersion: 2/);
  assert.match(source, /GAMEBUDDY_PLAYER_MEMORY_NEXT_ROUND_NONCE_SHA256/);
  assert.match(source, /stdio: \["ignore", "pipe", "pipe", "ipc"\]/);
  assert.match(source, /production_launcher_child_ipc_forwarding_unavailable/);
  assert.match(source, /chat_player_memory_exact_next_provider_attestation_not_game_gate/);
  assert.match(source, /providerAcceptedOrSemanticAnswer: false/);
});
