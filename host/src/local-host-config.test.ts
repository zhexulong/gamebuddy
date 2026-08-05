import assert from "node:assert/strict";
import test from "node:test";
import { validateLocalHostConfig } from "./local-host-config.js";

const baseConfig = {
  playerId: "player-01",
  companionId: "companion-01",
  integrationId: "stardew",
  integration: {
    saveId: "save-01",
    worldId: "world-01",
    pipeName: "gamebuddy-stardew-agent",
    bridgeToken: "1234567890abcdef",
  },
};

test("Host config owns only companion and integration-selection fields", () => {
  const parsed = validateLocalHostConfig({ ...baseConfig, model: "deepseek-v4-flash" });
  assert.equal(parsed.thinkingLevel, "high");
  assert.equal(parsed.integrationId, "stardew");
  assert.deepEqual(parsed.integration, baseConfig.integration);
  assert.throws(() => validateLocalHostConfig({ ...baseConfig, pipeName: "host_must_not_parse_adapter_fields" }), /invalid_host_config/);
  assert.throws(() => validateLocalHostConfig({ ...baseConfig, saveId: "host_must_not_parse_adapter_fields" }), /invalid_host_config/);
});

test("Host config rejects unknown, malformed, and non-object integration selection", () => {
  assert.throws(() => validateLocalHostConfig({ ...baseConfig, unexpected: true }), /invalid_host_config/);
  assert.throws(() => validateLocalHostConfig({ ...baseConfig, integrationId: "not/a-valid-id" }), /invalid_host_config/);
  assert.throws(() => validateLocalHostConfig({ ...baseConfig, integration: [] }), /invalid_host_config/);
  assert.throws(() => validateLocalHostConfig({ ...baseConfig, model: "gpt-5.6-luna" }), /invalid_host_config/);
  assert.throws(() => validateLocalHostConfig({ ...baseConfig, thinkingLevel: "medium" }), /invalid_host_config/);
});

test("Host config keeps presentation and voice boundaries strict", () => {
  assert.throws(() => validateLocalHostConfig({ ...baseConfig, presentation: { speech: { voiceProfile: "safe" } } }), /invalid_host_config/);
  assert.throws(() => validateLocalHostConfig({ ...baseConfig, voiceGateway: { port: 0, token: "1234567890abcdef" } }), /invalid_host_config/);
  const parsed = validateLocalHostConfig({ ...baseConfig, continuityId: "continuity-01", voiceGateway: { port: 8383, token: "1234567890abcdef" }, presentation: { speech: { voiceProfile: "safe" } } });
  assert.equal(parsed.continuityId, "continuity-01");
});
