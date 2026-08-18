import assert from "node:assert/strict";
import test from "node:test";
import {
  validateGameOperationalGateIdentity,
  validateGameOperationalGatePreflight,
} from "./game-operational-gate-preflight.mjs";

const nonce = "a".repeat(64);
const config = Object.freeze({
  runtimeRoot: "C:/GameBuddy/operational-gate",
  sharedIdentity: Object.freeze({
    playerId: "player_01",
    companionId: "companion_01",
    continuityId: "continuity_shared",
  }),
  foreignIdentity: Object.freeze({
    playerId: "player_01",
    companionId: "companion_01",
    continuityId: "continuity_foreign",
  }),
  surfaceSessions: Object.freeze({
    chat: "chat_session_01",
    game: "game_session_01",
    foreign: "foreign_session_01",
  }),
  markerNonceSha256: nonce,
});

test("Game Operational Gate preflight accepts a shared Memory root with distinct surface sessions", () => {
  const result = validateGameOperationalGatePreflight(config);
  assert.equal(result.state, "READY");
  assert.equal(result.runtimeRoot, config.runtimeRoot);
  assert.deepEqual(result.sharedIdentity, config.sharedIdentity);
  assert.deepEqual(result.foreignIdentity, config.foreignIdentity);
  assert.deepEqual(result.surfaceSessions, config.surfaceSessions);
  assert.equal(result.markerNonceSha256, nonce);
});

test("Game Operational Gate preflight rejects malformed exact identities", () => {
  assert.deepEqual(validateGameOperationalGateIdentity({ playerId: "player_01", companionId: "companion_01" }), {
    state: "BLOCKED",
    reasonCode: "identity_shape_invalid",
  });
  assert.deepEqual(
    validateGameOperationalGateIdentity({
      playerId: "player/path",
      companionId: "companion_01",
      continuityId: "continuity_01",
    }),
    { state: "BLOCKED", reasonCode: "identity_playerId_invalid" },
  );
  assert.equal(
    validateGameOperationalGatePreflight({ ...config, sharedIdentity: { ...config.sharedIdentity, unexpected: "no" } })
      .reasonCode,
    "shared_identity_shape_invalid",
  );
});

test("Game Operational Gate preflight requires one normalized absolute runtime root", () => {
  assert.deepEqual(validateGameOperationalGatePreflight({ ...config, runtimeRoot: "relative/game" }), {
    state: "BLOCKED",
    reasonCode: "runtime_root_invalid",
  });
  assert.deepEqual(
    validateGameOperationalGatePreflight({ ...config, runtimeRoot: { shared: "C:/GameBuddy/operational-gate" } }),
    { state: "BLOCKED", reasonCode: "runtime_root_invalid" },
  );
});

test("Game Operational Gate preflight requires distinct Chat/Game surface sessions and a foreign continuity", () => {
  assert.equal(
    validateGameOperationalGatePreflight({
      ...config,
      surfaceSessions: { ...config.surfaceSessions, game: "chat_session_01" },
    }).reasonCode,
    "surface_sessions_not_distinct",
  );
  assert.equal(
    validateGameOperationalGatePreflight({
      ...config,
      foreignIdentity: { ...config.foreignIdentity, playerId: "other_player" },
    }).reasonCode,
    "foreign_identity_partition_mapping_invalid",
  );
  assert.equal(
    validateGameOperationalGatePreflight({
      ...config,
      foreignIdentity: { ...config.foreignIdentity, continuityId: "continuity_shared" },
    }).reasonCode,
    "foreign_identity_partition_mapping_invalid",
  );
  assert.deepEqual(validateGameOperationalGatePreflight({ ...config, markerNonceSha256: "bad" }), {
    state: "BLOCKED",
    reasonCode: "marker_nonce_invalid",
  });
});

test("Game Operational Gate preflight remains a pure config module", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("./game-operational-gate-preflight.mjs", import.meta.url), "utf8"),
  );
  assert.doesNotMatch(source, /node:(?:fs|sqlite|child_process)|DatabaseSync|lstat|realpath|spawn/i);
});
