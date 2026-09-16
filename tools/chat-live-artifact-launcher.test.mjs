import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_LIVE_ARTIFACT_ROOT,
  CHAT_LIVE_ENTRY,
  createChatLiveChildEnvironment,
  createChatLiveLaunch,
} from "../host/scripts/start-chat-live-artifact.mjs";

const SHA256 = "a".repeat(64);
const MANIFEST = Object.freeze({
  schema: "gamebuddy-chat-live-manifest/v1",
  identity: "gamebuddy.chat-live.v1",
  artifactId: "a".repeat(32),
  entry: CHAT_LIVE_ENTRY,
  build: Object.freeze({
    tsconfig: "tsconfig.chat-live.json",
    tsconfigSha256: SHA256,
    typescriptVersion: "5.0.0",
    node: "v24.0.0",
  }),
  browserArtifactManifestSha256: SHA256,
  dependencyClosureDigest: SHA256,
  disposableRoot: CHAT_LIVE_ARTIFACT_ROOT,
});

 test("Chat Live launch is direct, artifact-local, and preserves dialogue arguments", () => {
  const launch = createChatLiveLaunch({
    artifactRoot: CHAT_LIVE_ARTIFACT_ROOT,
    manifest: MANIFEST,
    args: ["--known-root-recovery", "D:\\GameBuddy-data\\dialogue.json"],
    environment: {
      GAMEBUDDY_DIALOGUE_CONFIG: "D:\\GameBuddy-data\\dialogue.json",
      NODE_PATH: "C:\\Users\\Player\\pi\\node_modules",
      NODE_OPTIONS: "--require=C:\\Users\\Player\\pi\\hook.cjs",
      PI_SESSION_DIR: "C:\\Users\\Player\\.pi",
      MAGIC_CONTEXT_HOME: "C:\\Users\\Player\\.magic-context",
    },
  });

  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, [
    `${CHAT_LIVE_ARTIFACT_ROOT}\\${CHAT_LIVE_ENTRY}`,
    "--known-root-recovery",
    "D:\\GameBuddy-data\\dialogue.json",
  ]);
  assert.equal(launch.cwd, CHAT_LIVE_ARTIFACT_ROOT);
  assert.equal(launch.env.GAMEBUDDY_DIALOGUE_CONFIG, "D:\\GameBuddy-data\\dialogue.json");
  assert.equal(Object.hasOwn(launch.env, "NODE_PATH"), false);
  assert.equal(Object.hasOwn(launch.env, "NODE_OPTIONS"), false);
  assert.equal(Object.hasOwn(launch.env, "PI_SESSION_DIR"), false);
  assert.equal(Object.hasOwn(launch.env, "MAGIC_CONTEXT_HOME"), false);
});

test("Chat Live launcher requires a dialogue deployment manifest", () => {
  assert.throws(
    () => createChatLiveLaunch({ artifactRoot: CHAT_LIVE_ARTIFACT_ROOT, manifest: MANIFEST, args: [] , environment: {} }),
    /dialogue_deployment_manifest_path_required/,
  );
});

test("Chat Live child environment does not use inherited module or Pi selectors", () => {
  const environment = createChatLiveChildEnvironment({
    NODE_PATH: "C:\\pi\\node_modules",
    node_path: "C:\\pi\\node_modules",
    Pi: "user-pi",
    PI_HOME: "user-pi",
    MAGIC_CONTEXT_ROOT: "user-context",
    GAMEBUDDY_DIALOGUE_CONFIG: "D:\\manifest.json",
  });
  assert.deepEqual(environment, { GAMEBUDDY_DIALOGUE_CONFIG: "D:\\manifest.json" });
});
