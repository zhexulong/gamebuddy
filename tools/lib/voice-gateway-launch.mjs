import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared Voice Gateway configuration and launch assembly for live runners.
 *
 * Runners must not hand-write gateway launch details. The decision of whether
 * TTS is enabled, which endpoint/output device/voice to use, and whether the
 * gateway is already provided by the product supervisor all come from
 * configuration:
 *
 *   1. An already-assembled gateway (GAMEBUDDY_VOICE_PORT + GAMEBUDDY_VOICE_TOKEN
 *      injected by the owning product surface) is attached to as-is; the runner
 *      never spawns a second child.
 *   2. Otherwise the stored player preference
 *      (<runtimeRoot>/settings/voice-preference.json, written by the frontend
 *      settings surface) decides: `consent: "accepted"` enables cloud TTS and
 *      its `outputDevice` pins the endpoint. A missing/undecided/revoked
 *      preference means voice is genuinely disabled and the caller reports that
 *      instead of inventing a configuration.
 *
 * Nothing here writes the preference file, and no credential ever leaves the
 * child environment.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GATEWAY_ENTRY = join(REPOSITORY_ROOT, "vendor", "pi-koe", "dist", "main.js");
const CLOUD_TTS_ADMISSION = "desktop-consent-v1";

/** Configuration facts for one voice attempt. `enabled: false` carries why. */
export const VOICE_DISABLED_REASONS = Object.freeze([
  "voice_preference_absent",
  "voice_preference_undecided",
  "voice_preference_revoked",
  "voice_preference_unreadable",
  "voice_api_key_absent",
  "voice_gateway_entry_missing",
]);

/**
 * Reads the one stored voice preference the settings surface owns. Any
 * malformed or unreadable file fails closed to disabled rather than guessing.
 */
async function readStoredVoicePreference(runtimeRoot) {
  if (typeof runtimeRoot !== "string" || runtimeRoot.length === 0) {
    return Object.freeze({ consent: "absent", outputDevice: null });
  }
  let parsed;
  try {
    parsed = JSON.parse(
      await readFile(join(runtimeRoot, "settings", "voice-preference.json"), "utf8"),
    );
  } catch {
    return Object.freeze({ consent: "absent", outputDevice: null });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return Object.freeze({ consent: "unreadable", outputDevice: null });
  }
  const consent = parsed.consent;
  const outputDevice = parsed.outputDevice;
  if (consent !== "undecided" && consent !== "accepted" && consent !== "revoked") {
    return Object.freeze({ consent: "unreadable", outputDevice: null });
  }
  const deviceIsValid =
    outputDevice === null ||
    (typeof outputDevice === "string" && /^waveout:[0-9]{1,4}$/.test(outputDevice));
  if (!deviceIsValid) return Object.freeze({ consent: "unreadable", outputDevice: null });
  return Object.freeze({ consent, outputDevice: outputDevice ?? null });
}

/** Reads MIMO_API_KEY from the process env, then from the optional local env file. */
export async function resolveVoiceApiKey() {
  const fromEnv = process.env.MIMO_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.trim().length >= 16) return fromEnv.trim();
  try {
    const local = await readFile(join(REPOSITORY_ROOT, ".env.local"), "utf8");
    for (const line of local.split(/\r?\n/)) {
      const match = /^MIMO_API_KEY=(.+)$/.exec(line.trim());
      if (match !== null && match[1].trim().length >= 16) return match[1].trim();
    }
  } catch {
    /* optional local file */
  }
  return null;
}

/**
 * One pure configuration read answering "is voice enabled, and with what".
 * Runners consume this and report `disabledReason` verbatim when voice is off.
 */
export async function resolveVoiceConfiguration({ runtimeRoot, locale = "zh-CN" } = {}) {
  const injectedPort = Number(process.env.GAMEBUDDY_VOICE_PORT ?? 0);
  const injectedToken = process.env.GAMEBUDDY_VOICE_TOKEN;
  if (
    Number.isInteger(injectedPort) &&
    injectedPort > 0 &&
    injectedPort < 65_536 &&
    typeof injectedToken === "string" &&
    /^[A-Za-z0-9_-]{16,256}$/.test(injectedToken)
  ) {
    return Object.freeze({
      enabled: true,
      mode: "attached",
      port: injectedPort,
      token: injectedToken,
      outputDevice: process.env.GAMEBUDDY_WINDOWS_OUTPUT_DEVICE ?? null,
    });
  }

  const preference = await readStoredVoicePreference(runtimeRoot);
  if (preference.consent !== "accepted") {
    const reason =
      preference.consent === "absent"
        ? "voice_preference_absent"
        : preference.consent === "revoked"
          ? "voice_preference_revoked"
          : preference.consent === "undecided"
            ? "voice_preference_undecided"
            : "voice_preference_unreadable";
    return Object.freeze({ enabled: false, disabledReason: reason });
  }
  const apiKey = await resolveVoiceApiKey();
  if (apiKey === null) return Object.freeze({ enabled: false, disabledReason: "voice_api_key_absent" });
  let entryPresent = true;
  try {
    await readFile(GATEWAY_ENTRY);
  } catch {
    entryPresent = false;
  }
  if (!entryPresent)
    return Object.freeze({ enabled: false, disabledReason: "voice_gateway_entry_missing" });

  return Object.freeze({
    enabled: true,
    mode: "spawned",
    apiKey,
    // The stored preference pins the endpoint; `null` deliberately means the
    // Windows default, never a silent fallback to another device.
    outputDevice: preference.outputDevice,
    locale,
  });
}

/** Probes one loopback port; rejects when it is already in use. */
function probeFreePort(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePromise()));
  });
}

/**
 * Spawns the gateway child for a `spawned` configuration, waits for its stdout
 * "listening on" readiness line, and returns the child handle. stderr is kept
 * for diagnostics only (node emits benign warnings there).
 */
export async function launchVoiceGatewayChild(configuration, { port, token }) {
  if (typeof configuration?.apiKey !== "string")
    throw new Error("voice_gateway_configuration_not_spawnable");
  const env = {
    ...process.env,
    MIMO_API_KEY: configuration.apiKey,
    GAMEBUDDY_VOICE_PORT: String(port),
    GAMEBUDDY_VOICE_TOKEN: token,
    GAMEBUDDY_VOICE_CLOUD_TTS_ADMISSION: CLOUD_TTS_ADMISSION,
    // The ladder-2 verified MiMo persona; callers may override via env but the
    // default keeps the same voice the live gate measured.
    GAMEBUDDY_MIMO_VOICE: process.env.GAMEBUDDY_MIMO_VOICE ?? "冰糖",
  };
  // An absent preference endpoint means "Windows default"; an explicit endpoint
  // is passed through verbatim so the gateway never falls back to another device.
  if (typeof configuration.outputDevice === "string" && configuration.outputDevice.length > 0)
    env.GAMEBUDDY_WINDOWS_OUTPUT_DEVICE = configuration.outputDevice;
  else if (env.GAMEBUDDY_WINDOWS_OUTPUT_DEVICE === undefined)
    env.GAMEBUDDY_WINDOWS_OUTPUT_DEVICE = "default";

  const child = spawn(process.execPath, ["--use-env-proxy", GATEWAY_ENTRY], {
    cwd: REPOSITORY_ROOT,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const started = await new Promise((resolvePromise) => {
    const deadline = Date.now() + 30_000;
    const poll = () => {
      if (stdout.includes("listening on")) return resolvePromise(true);
      if (child.exitCode !== null || child.signalCode !== null) return resolvePromise(false);
      if (Date.now() > deadline) return resolvePromise(false);
      setTimeout(poll, 50);
    };
    poll();
  });
  if (!started) {
    child.kill("SIGTERM");
    throw new Error(`voice_gateway_start_failed:${stderr.slice(0, 300)}`);
  }
  return Object.freeze({ child, readStderr: () => stderr });
}

/**
 * Picks the loopback port for a spawned gateway: an explicit configured port
 * when supplied, otherwise the documented default range, probing each candidate
 * so a busy port is skipped rather than reported as a voice failure.
 */
export async function pickVoiceGatewayPort(candidates = null) {
  const list =
    Array.isArray(candidates) && candidates.length > 0
      ? candidates
      : [49_731, 49_732, 49_733, 49_734, 49_735];
  for (const port of list) {
    try {
      await probeFreePort(port);
      return port;
    } catch {
      continue;
    }
  }
  throw new Error("voice_gateway_port_unavailable");
}
