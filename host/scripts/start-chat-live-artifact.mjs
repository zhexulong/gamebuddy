import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertChatLiveArtifactAdmission,
  assertChatLiveArtifactRoot,
} from "./chat-live-artifact-support.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIRECTORY = dirname(SCRIPT_PATH);
export const CHAT_LIVE_ARTIFACT_ROOT = resolve("D:\\GameBuddy-chat-live-tmp");
export const CHAT_LIVE_ENTRY = "dialogue-web-main.js";

const DIALOGUE_MODE_FLAGS = new Set([
  "--known-root-recovery",
  "--tavern-management",
  "--reference-game",
]);
const DIALOGUE_NONCE_PREFIX = "--tavern-narrative-gate-nonce-sha256=";

function isDialogueManifestArgument(argument) {
  return typeof argument === "string"
    && argument.length > 0
    && !argument.startsWith("--")
    && !DIALOGUE_MODE_FLAGS.has(argument)
    && !argument.startsWith(DIALOGUE_NONCE_PREFIX);
}

/**
 * The Chat Live child resolves bare packages only from its copied artifact
 * tree. In particular, it cannot inherit a caller's NODE_PATH, preload, Pi
 * installation, Pi session, or Magic Context selector.
 */
export function createChatLiveChildEnvironment(inherited = process.env) {
  if (inherited === null || typeof inherited !== "object" || Array.isArray(inherited))
    throw new Error("chat_live_child_environment_invalid");
  const environment = { ...inherited };
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (
      normalized === "NODE_PATH"
      || normalized === "NODE_OPTIONS"
      || normalized === "PI"
      || normalized.startsWith("PI_")
      || normalized.startsWith("MAGIC_CONTEXT_")
    ) delete environment[key];
  }
  return environment;
}

function assertDialogueConfigurationProvided(args, environment) {
  const hasEnvironmentManifest = typeof environment.GAMEBUDDY_DIALOGUE_CONFIG === "string"
    && environment.GAMEBUDDY_DIALOGUE_CONFIG.length > 0;
  const hasArgumentManifest = args.some(isDialogueManifestArgument);
  if (!hasEnvironmentManifest && !hasArgumentManifest)
    throw new Error("dialogue_deployment_manifest_path_required");
}

/**
 * Creates the exact direct Node invocation for the verified Chat Live entry.
 * The production caller supplies only CHAT_LIVE_ARTIFACT_ROOT; the artifact
 * root parameter is exposed here solely to keep this construction testable.
 */
export function createChatLiveLaunch({ artifactRoot, manifest, args, environment = process.env } = {}) {
  const root = resolve(artifactRoot ?? "");
  if (root !== CHAT_LIVE_ARTIFACT_ROOT) throw new Error("chat_live_artifact_root_not_canonical");
  if (
    manifest === null
    || typeof manifest !== "object"
    || manifest.entry !== CHAT_LIVE_ENTRY
    || typeof manifest.disposableRoot !== "string"
    || resolve(manifest.disposableRoot) !== root
  ) throw new Error("chat_live_manifest_entry_invalid");
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string"))
    throw new Error("chat_live_launch_arguments_invalid");
  assertDialogueConfigurationProvided(args, environment);
  const entryPath = resolve(root, CHAT_LIVE_ENTRY);
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([entryPath, ...args]),
    cwd: root,
    env: createChatLiveChildEnvironment(environment),
    entryPath,
  });
}

async function assertRegularEntry(entryPath) {
  const state = await lstat(entryPath);
  if (state.isSymbolicLink() || !state.isFile()) throw new Error("chat_live_entry_not_regular_file");
  if (await realpath(entryPath) !== entryPath) throw new Error("chat_live_entry_identity_invalid");
}

export async function startChatLiveArtifact({ args = process.argv.slice(2), environment = process.env } = {}) {
  const artifact = await assertChatLiveArtifactRoot({ artifactRoot: CHAT_LIVE_ARTIFACT_ROOT });
  // Keep the admission assertion explicit at this launch boundary even though
  // assertChatLiveArtifactRoot also cross-checks the admission bindings.
  const admission = assertChatLiveArtifactAdmission(artifact.admission);
  if (admission.entry !== CHAT_LIVE_ENTRY || artifact.manifest.entry !== CHAT_LIVE_ENTRY)
    throw new Error("chat_live_manifest_entry_invalid");
  if (resolve(artifact.manifest.disposableRoot) !== CHAT_LIVE_ARTIFACT_ROOT)
    throw new Error("chat_live_manifest_root_invalid");
  const launch = createChatLiveLaunch({
    artifactRoot: CHAT_LIVE_ARTIFACT_ROOT,
    manifest: artifact.manifest,
    args,
    environment: { ...environment, GAMEBUDDY_CHAT_LIVE_ARTIFACT: "gamebuddy.chat-live.v1" },
  });
  await assertRegularEntry(launch.entryPath);
  const pathLock = await import(pathToFileURL(resolve(CHAT_LIVE_ARTIFACT_ROOT, "path-lock.js")).href);
  const reclaimer = await import(pathToFileURL(resolve(CHAT_LIVE_ARTIFACT_ROOT, "windows-stale-lock-reclaimer", "index.js")).href);
  const capability = await reclaimer.createChatLiveWindowsStaleLockReclaimer(CHAT_LIVE_ARTIFACT_ROOT);
  pathLock.bindWindowsStaleLockReclaimer(capability);

  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: "inherit",
  });
  return await new Promise((resolveExit) => {
    child.once("error", () => resolveExit(1));
    child.once("close", (code) => resolveExit(code ?? 1));
  });
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await startChatLiveArtifact();
}
