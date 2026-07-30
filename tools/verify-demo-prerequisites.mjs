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

const farmhandId = process.env.GAMEBUDDY_AI_FARMHAND_ID;
if (farmhandId && /^\d+$/.test(farmhandId)) {
  pass("configured local AI Farmhand", "opaque multiplayer ID is configured; value was not logged");
} else {
  fail("configured local AI Farmhand", "set GAMEBUDDY_AI_FARMHAND_ID after the native local-co-op Farmhand joins the dedicated test save");
}

if (process.env.GAMEBUDDY_LOCAL_COOP_READY === "1") {
  pass("local split-screen readiness", "operator confirmed a second local input device and vacant cabin are ready");
} else {
  fail("local split-screen readiness", "set GAMEBUDDY_LOCAL_COOP_READY=1 only after a second local input device and vacant cabin are ready");
}

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
  console.log("Demo environment preflight passed. Continue with the documented split-screen/model/device runbooks.");
}
