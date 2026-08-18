import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadSemanticVoiceConfig, parseSemanticMainCommand } from "./semantic-main-config.js";

test("main destructive cutover uses only semantic operator construction and facade teardown", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../src/main.ts"), "utf8");
  for (const forbidden of [
    "connectIntegrationCompanion",
    "createProductionGameContinuity",
    "validateLocalHostConfig",
    "PRODUCT_INTEGRATION_CATALOG",
    "bindIntegrationIdentity",
    "actionPolicy",
    "connected.close",
    "host.close",
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden legacy main ingress: ${forbidden}`);
  }
  assert.match(
    source,
    /parseSemanticMainCommand\(process\.argv\.slice\(2\), process\.env\.GAMEBUDDY_SEMANTIC_GAME_OPERATOR_CONFIG\)/,
  );
  assert.match(source, /GAMEBUDDY_GAME_OPERATIONAL_GATE_NONCE_SHA256/);
  assert.match(source, /\^\[a-f0-9\]\{64\}\$/);
  assert.match(source, /createKnownSemanticGameFacadeFromOperatorConfig\(\s*operatorConfigPath,/);
  assert.match(source, /gameOperationalGateNonceSha256/);
  assert.match(
    source,
    /gameVoicePresentation: voice\.createGameVoicePresentationAttachment\(voiceConfig\.voiceProfile\)/,
  );
  assert.match(
    source,
    /const lease = await facade\.runEnter\(\);\s*if \(voice !== undefined && voiceConfig !== undefined\) \{\s*if \(voiceConfig\.voiceSessionId !== lease\.gameSessionId\) throw new Error\("voice_session_receipt_mismatch"\);\s*await voice\.bootstrapSession\(lease\.gameSessionId\);/,
  );
  assert.match(source, /lease\.activateCommittedIngress\(\);/);
  assert.doesNotMatch(source, /gamePresentation: Object\.freeze/);
  assert.doesNotMatch(source, /speechPort: voice/);
  assert.match(source, /GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA/);
  assert.match(source, /nextOperationalGateEvidence/);
  assert.match(source, /process\.send\(evidence\)/);
  assert.equal(source.includes("gamebuddy-game-operational-gate-runtime/v1"), false);
  assert.match(
    source,
    /createKnownSemanticGameDeadOwnerRecoveryFacadeFromOperatorConfig\(\s*command\.operatorConfigPath,?\s*\)/,
  );
  const recoveryBranch = source.slice(
    source.indexOf('if (command.kind === "recover_dead_owner")'),
    source.indexOf("} else await enterSemanticGame"),
  );
  assert.equal(recoveryBranch.includes("createKnownSemanticGameFacadeFromOperatorConfig("), false);
  assert.match(
    recoveryBranch,
    /await recoveryFacade\.recoverDeadOwner\(\{ request: "recover_dead_owner", operationId: command\.operationId \}\)/,
  );
  assert.match(source, /await facade\.runEnter\(\)/);
  assert.match(source, /closeConnected: \(\) => facade\.close\(\)/);
  for (const forbidden of ["owner", "proof", "permit", "mutex", "binding", "runtimeRoot", "recoverGame("]) {
    assert.equal(
      source.includes(`recoveryFacade.recoverDeadOwner({ ${forbidden}`),
      false,
      `leaked recovery authority: ${forbidden}`,
    );
  }
});

test("semantic main command accepts only exact normal-entry or explicit dead-owner recovery forms", () => {
  const configPath = "C:/semantic/game-operator.json";
  assert.deepEqual(parseSemanticMainCommand([], configPath), { kind: "enter", operatorConfigPath: configPath });
  assert.deepEqual(parseSemanticMainCommand([configPath], undefined), {
    kind: "enter",
    operatorConfigPath: configPath,
  });
  assert.deepEqual(parseSemanticMainCommand([configPath, "recover-dead-owner", "operation_01"], undefined), {
    kind: "recover_dead_owner",
    operatorConfigPath: configPath,
    operationId: "operation_01",
  });
  for (const [argv, environment] of [
    [["recover-dead-owner", "operation_01"], undefined],
    [[configPath, "recover-dead-owner"], undefined],
    [[configPath, "recover-dead-owner", "operation_01", "extra"], undefined],
    [[configPath, "recover-dead-owner", "invalid operation"], undefined],
    [[configPath, "unexpected"], undefined],
    [[], undefined],
    [[], "relative-config.json"],
  ] as const) {
    assert.throws(
      () => parseSemanticMainCommand(argv, environment),
      /(?:invalid_semantic_main_command|semantic_game_operator_config_path_required)/,
    );
  }
});

test("semantic voice config requires the exact all-or-nothing wrapper", async () => {
  const root = await mkdtemp(join(tmpdir(), "semantic-main-config-"));
  const path = join(root, "voice.json");
  const valid = {
    schemaVersion: 1,
    voiceGateway: { port: 12_345, token: "0123456789abcdef" },
    voiceSessionId: "voice_session_01",
    voiceProfile: "companion.default",
  };
  try {
    await writeFile(path, JSON.stringify(valid));
    assert.deepEqual(await loadSemanticVoiceConfig(path), {
      voiceGateway: valid.voiceGateway,
      voiceSessionId: valid.voiceSessionId,
      voiceProfile: valid.voiceProfile,
    });
    for (const invalid of [
      { ...valid, unknown: true },
      { ...valid, voiceProfile: undefined },
      { ...valid, voiceGateway: { ...valid.voiceGateway, host: "127.0.0.1" } },
      { ...valid, voiceGateway: { port: 0, token: valid.voiceGateway.token } },
      { ...valid, voiceSessionId: "invalid session" },
    ]) {
      await writeFile(path, JSON.stringify(invalid));
      await assert.rejects(loadSemanticVoiceConfig(path), /invalid_semantic_voice_config/);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
