import { existsSync } from "node:fs";
import { resolve } from "node:path";

const checks = [];
let blocked = false;

function pass(name, detail) {
  checks.push({ status: "PASS", name, detail });
}

function fail(name, detail) {
  blocked = true;
  checks.push({ status: "BLOCKED", name, detail });
}

function requireDirectory(envName, label) {
  const value = process.env[envName];
  if (!value) {
    fail(label, `set ${envName} to a separately licensed Stardew Valley installation`);
    return;
  }

  const path = resolve(value);
  if (!existsSync(path)) {
    fail(label, `${envName} does not exist: ${path}`);
    return;
  }

  pass(label, path);
}

const gamePath = process.env.GAMEBUDDY_STARDEW_GAME_PATH;
if (gamePath && existsSync(gamePath)) {
  const required = ["Stardew Valley.dll", "StardewModdingAPI.dll", "StardewModdingAPI.exe"];
  const missing = required.filter((file) => !existsSync(resolve(gamePath, file)));
  if (missing.length === 0) {
    pass("primary Stardew + SMAPI", resolve(gamePath));
  } else {
    fail("primary Stardew + SMAPI", `missing ${missing.join(", ")} under ${resolve(gamePath)}`);
  }
} else {
  fail("primary Stardew + SMAPI", "set GAMEBUDDY_STARDEW_GAME_PATH to the installed SMAPI game directory");
}

requireDirectory("GAMEBUDDY_SECOND_STARDEW_GAME_PATH", "independent Farmhand client");

if (process.env.MIMO_API_KEY && process.env.MIMO_API_KEY.trim().length > 0) {
  pass("MiMo credential", "present in process environment; value was not read or logged");
} else {
  fail("MiMo credential", "set MIMO_API_KEY in the process environment");
}

const senseVoiceManifest = process.env.GAMEBUDDY_SENSEVOICE_ASSET_MANIFEST;
if (senseVoiceManifest && existsSync(resolve(senseVoiceManifest))) {
  pass("audited SenseVoice assets", "asset manifest is configured; Gateway performs runtime/model/VAD hash audit before ASR");
} else {
  fail("audited SenseVoice assets", "set GAMEBUDDY_SENSEVOICE_ASSET_MANIFEST to an audited SenseVoice asset manifest");
}

if (process.platform === "win32") {
  pass("audio-device check", "run the Phase 3/4 device fixture on the selected Windows capture/output devices");
} else {
  fail("audio-device check", "the target voice validation environment is Windows");
}

for (const check of checks) {
  console.log(`${check.status}: ${check.name} - ${check.detail}`);
}

if (blocked) {
  console.error("Demo environment preflight is blocked. No @game, @model, or @voice hard gate was run.");
  process.exitCode = 1;
} else {
  console.log("Demo environment preflight passed. Continue with the documented two-client/model/device runbooks.");
}
