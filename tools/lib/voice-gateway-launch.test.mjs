import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { resolveVoiceConfiguration, VOICE_DISABLED_REASONS } = await import("./voice-gateway-launch.mjs");

async function withRuntimeRoot(name) {
  const root = await mkdtemp(join(tmpdir(), `voice-gateway-launch-${name}-`));
  await mkdir(join(root, "settings"), { recursive: true });
  return root;
}

async function writePreference(root, value) {
  await writeFile(join(root, "settings", "voice-preference.json"), JSON.stringify(value), "utf8");
}

/** Clears any product-injected gateway so the stored preference decides. */
function withInjectedGatewayCleared(run) {
  const port = process.env.GAMEBUDDY_VOICE_PORT;
  const token = process.env.GAMEBUDDY_VOICE_TOKEN;
  delete process.env.GAMEBUDDY_VOICE_PORT;
  delete process.env.GAMEBUDDY_VOICE_TOKEN;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (port !== undefined) process.env.GAMEBUDDY_VOICE_PORT = port;
      if (token !== undefined) process.env.GAMEBUDDY_VOICE_TOKEN = token;
    });
}

test("an absent preference disables voice with a reported reason instead of a hand-written config", async () => {
  await withInjectedGatewayCleared(async () => {
    const root = await withRuntimeRoot("absent");
    const configuration = await resolveVoiceConfiguration({ runtimeRoot: root });
    assert.equal(configuration.enabled, false);
    assert.equal(configuration.disabledReason, "voice_preference_absent");
    assert.ok(VOICE_DISABLED_REASONS.includes(configuration.disabledReason));
  });
});

test("revoked and undecided preferences stay disabled; a malformed file fails closed", async () => {
  await withInjectedGatewayCleared(async () => {
    const root = await withRuntimeRoot("states");
    await writePreference(root, { schemaVersion: 1, revision: 1, disclosureVersion: "mimo-cloud-tts-v1", consent: "revoked", decidedAtMs: 5, outputDevice: null });
    assert.equal((await resolveVoiceConfiguration({ runtimeRoot: root })).disabledReason, "voice_preference_revoked");

    await writePreference(root, { schemaVersion: 1, revision: 2, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null });
    assert.equal((await resolveVoiceConfiguration({ runtimeRoot: root })).disabledReason, "voice_preference_undecided");

    await writePreference(root, { schemaVersion: 1, revision: 3, disclosureVersion: "mimo-cloud-tts-v1", consent: "accepted", decidedAtMs: 6, outputDevice: "not-a-device" });
    assert.equal((await resolveVoiceConfiguration({ runtimeRoot: root })).disabledReason, "voice_preference_unreadable");
  });
});

test("an accepted preference enables voice and carries the stored endpoint verbatim", async () => {
  await withInjectedGatewayCleared(async () => {
    const root = await withRuntimeRoot("accepted");
    await writePreference(root, { schemaVersion: 1, revision: 1, disclosureVersion: "mimo-cloud-tts-v1", consent: "accepted", decidedAtMs: 5, outputDevice: "waveout:2" });
    const previousKey = process.env.MIMO_API_KEY;
    process.env.MIMO_API_KEY = "test_key_with_enough_length";
    try {
      const configuration = await resolveVoiceConfiguration({ runtimeRoot: root, locale: "en-US" });
      // The gateway entry exists in the repository, so an accepted preference
      // with a key resolves to a spawned configuration.
      assert.equal(configuration.enabled, true);
      assert.equal(configuration.mode, "spawned");
      assert.equal(configuration.outputDevice, "waveout:2");
      assert.equal(configuration.locale, "en-US");
    } finally {
      if (previousKey === undefined) delete process.env.MIMO_API_KEY;
      else process.env.MIMO_API_KEY = previousKey;
    }
  });
});

test("an already-assembled gateway port/token pair is attached, never re-spawned", async () => {
  const previousPort = process.env.GAMEBUDDY_VOICE_PORT;
  const previousToken = process.env.GAMEBUDDY_VOICE_TOKEN;
  process.env.GAMEBUDDY_VOICE_PORT = "49999";
  process.env.GAMEBUDDY_VOICE_TOKEN = "attached_token_16_chars__";
  try {
    const configuration = await resolveVoiceConfiguration({ runtimeRoot: undefined });
    assert.equal(configuration.enabled, true);
    assert.equal(configuration.mode, "attached");
    assert.equal(configuration.port, 49_999);
    assert.equal(configuration.token, "attached_token_16_chars__");
  } finally {
    if (previousPort === undefined) delete process.env.GAMEBUDDY_VOICE_PORT;
    else process.env.GAMEBUDDY_VOICE_PORT = previousPort;
    if (previousToken === undefined) delete process.env.GAMEBUDDY_VOICE_TOKEN;
    else process.env.GAMEBUDDY_VOICE_TOKEN = previousToken;
  }
});
