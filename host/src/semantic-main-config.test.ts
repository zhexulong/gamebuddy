import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import { loadSemanticVoiceConfig, parseSemanticMainCommand } from "./semantic-main-config.js";

test("main is the operational-gate child and the CLI-only recovery tool, with no operator/voice/control fallback", async () => {
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
    "createKnownSemanticGameFacadeFromOperatorConfig",
    "createKnownSemanticGameDeadOwnerRecoveryFacadeFromOperatorConfig",
    "operatorConfigPath",
    "connectHealthyVoiceGateway",
    "createHostShutdownLifecycle",
    "createVoicePollingSupervisor",
    "startCompanionControlServer",
    "readProductControlLaunch",
    "voiceConfig",
    "LocalStardewBridgeClient",
    "farmhand-companion-preview",
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden main ingress: ${forbidden}`);
  }
  assert.match(source, /parseSemanticMainCommand\(process\.argv\.slice\(2\)\)/);
  assert.match(source, /activateHeadlessOperationalGame\(manifest\)/);
  assert.match(source, /createStardewProductionLifecycleCoordinator\(manifest, folderPicker, game\)/);
  assert.match(source, /lease\.activateCommittedIngress\(\);/);
  assert.match(source, /createProductionGameTaskIngressController\(\{\s*nonceSha256: operationalNonceSha256,/);
  assert.match(source, /dispatchTask: lease\.dispatchPromptDefinedTask/);
  assert.match(source, /nextOperationalGateEvidence\(\)/);
  assert.match(source, /GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA/);
  assert.match(source, /process\.send\(evidence\)/);
  // Recovery is CLI-only and consumes the deployment manifest reference, never
  // an operator file or a facade path.
  assert.match(source, /game\.recoverDeadOwner\(\{ request: "recover_dead_owner", operationId \}\)/);
  assert.match(source, /loadHostDeploymentManifest\(deploymentManifestRef\)/);
  assert.equal(source.includes("gamebuddy-game-operational-gate-runtime/v1"), false);
});

test("semantic main command accepts only exact operational-flag entry or explicit dead-owner recovery forms", () => {
  const manifestRef = "C:/runtime/deployment-manifest.json";
  const nonce = "a".repeat(64);
  assert.deepEqual(parseSemanticMainCommand([
    "--deployment-manifest-ref", manifestRef,
    "--operational-nonce", nonce,
  ]), {
    kind: "enter",
    deploymentManifestRef: manifestRef,
    operationalNonceSha256: nonce,
  });
  assert.deepEqual(parseSemanticMainCommand([
    "recover-dead-owner", "--deployment-manifest-ref", manifestRef,
    "--operation-id", "operation_01",
  ]), {
    kind: "recover_dead_owner",
    deploymentManifestRef: manifestRef,
    operationId: "operation_01",
  });
  for (const argv of [
    [],
    ["--deployment-manifest-ref"],
    ["--deployment-manifest-ref", manifestRef],
    ["--deployment-manifest-ref", manifestRef, "--operational-nonce"],
    ["--deployment-manifest-ref", manifestRef, "--operational-nonce", "short"],
    ["--deployment-manifest-ref", manifestRef, "--operational-nonce", "Z".repeat(64)],
    ["--deployment-manifest-ref", "relative.json", "--operational-nonce", nonce],
    ["--deployment-manifest-ref", manifestRef, "--operational-nonce", nonce, "extra"],
    [manifestRef],
    ["recover-dead-owner"],
    ["recover-dead-owner", manifestRef, "--operation-id", "operation_01"],
    ["recover-dead-owner", "--deployment-manifest-ref", manifestRef],
    ["recover-dead-owner", "--deployment-manifest-ref", manifestRef, "--operation-id", "invalid operation"],
    ["recover-dead-owner", "--deployment-manifest-ref", manifestRef, "--operation-id", "operation_01", "extra"],
    ["--help"],
  ] as const) {
    assert.throws(
      () => parseSemanticMainCommand(argv),
      /invalid_semantic_main_command/,
    );
  }
});

test("semantic voice config requires the exact all-or-nothing wrapper", async () => {
  const root = await canonicalTestRoot("semantic-main-config-");
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
