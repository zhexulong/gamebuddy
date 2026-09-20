import assert from "node:assert/strict";
import test from "node:test";
import { parseVoiceGatewayArtifactAdmission, validateVoiceGatewayArtifactAdmission } from "./voice-gateway-artifact-admission.js";

const valid = {
  schema: "gamebuddy-host-voice-gateway-admission/v1",
  generation: "gen-1", inventoryDigest: "a".repeat(64), entryPath: "bin/gateway.js",
  entrySha256: "b".repeat(64), protocolPath: "protocol/schema.json", protocolSha256: "c".repeat(64),
  nodeVersion: "v24.20.0", platform: "win32", arch: "x64",
};

test("accepts and parses a valid voice gateway artifact", () => {
  assert.deepEqual(parseVoiceGatewayArtifactAdmission(JSON.stringify(valid)), valid);
});

test("rejects unknown keys", () => {
  assert.throws(() => validateVoiceGatewayArtifactAdmission({ ...valid, extra: true }), /unknown field/);
});

test("rejects traversal paths", () => {
  assert.throws(() => validateVoiceGatewayArtifactAdmission({ ...valid, entryPath: "bin/../gateway.js" }), /unsafe artifact path/);
  assert.throws(() => validateVoiceGatewayArtifactAdmission({ ...valid, protocolPath: "/etc/schema.json" }), /unsafe artifact path/);
});

test("rejects a wrong platform", () => {
  assert.throws(() => validateVoiceGatewayArtifactAdmission({ ...valid, platform: "linux" }), /unsupported artifact runtime/);
});

test("rejects secret fields", () => {
  assert.throws(() => validateVoiceGatewayArtifactAdmission({ ...valid, apiSecret: "hidden" }), /unknown field/);
});

test("rejects invalid and trailing JSON", () => {
  assert.throws(() => parseVoiceGatewayArtifactAdmission("{not-json"), /invalid voice gateway admission artifact/);
  assert.throws(() => parseVoiceGatewayArtifactAdmission(`${JSON.stringify(valid)} trailing`), /invalid voice gateway admission artifact/);
});
