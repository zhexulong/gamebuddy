import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { resolveKnowledgeBundlePath, validateLocalHostConfig } from "./local-host-config.js";

const baseConfig = {
  playerId: "player-01",
  saveId: "save-01",
  worldId: "world-01",
  companionId: "companion-01",
  pipeName: "gamebuddy-stardew-agent",
  bridgeToken: "1234567890abcdef",
};

test("Host config locks the player-facing Agent to DeepSeek V4 Flash at high thinking", () => {
  assert.equal(validateLocalHostConfig({ ...baseConfig, model: "deepseek-v4-flash" }).thinkingLevel, "high");
  assert.equal(validateLocalHostConfig({ ...baseConfig, model: "deepseek-v4-flash", thinkingLevel: "high" }).thinkingLevel, "high");
  assert.throws(() => validateLocalHostConfig({ ...baseConfig, model: "deepseek-v4-flash", thinkingLevel: "medium" }), /invalid_host_config/);
  assert.throws(() => validateLocalHostConfig({ ...baseConfig, model: "gpt-5.6-luna" }), /invalid_host_config/);
  assert.throws(() => validateLocalHostConfig({ ...baseConfig, model: "mimo-v2.5" }), /invalid_host_config/);
});

test("Host config keeps knowledge disabled unless path and version are both configured", () => {
  assert.equal(validateLocalHostConfig(baseConfig).knowledgeBundlePath, undefined);
  assert.equal(validateLocalHostConfig({ ...baseConfig, knowledgeBundlePath: "knowledge.json", gameVersion: "1.6.15" }).gameVersion, "1.6.15");
  assert.throws(() => validateLocalHostConfig({ ...baseConfig, knowledgeBundlePath: "knowledge.json" }), /invalid_host_config/);
  assert.throws(() => validateLocalHostConfig({ ...baseConfig, gameVersion: "1.6.15" }), /invalid_host_config/);
});

test("Host config rejects invalid knowledge version and path values", () => {
  assert.throws(() => validateLocalHostConfig({ ...baseConfig, knowledgeBundlePath: "knowledge.json", gameVersion: "1/6/15" }), /invalid_host_config/);
  assert.throws(() => validateLocalHostConfig({ ...baseConfig, knowledgeBundlePath: "", gameVersion: "1.6.15" }), /invalid_host_config/);
});

test("knowledge path is resolved relative to the Host config file", () => {
  assert.equal(
    resolveKnowledgeBundlePath("C:/profiles/A-host/host.json", "data/stardew-knowledge.json"),
    resolve("C:/profiles/A-host", "data/stardew-knowledge.json"),
  );
});
