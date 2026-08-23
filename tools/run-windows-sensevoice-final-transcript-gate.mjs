import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { VoiceGatewayProbeClient } from "./lib/voice-gateway-probe-client.mjs";

const manifestPath = option("--manifest");
const device = option("--device", "default");
const port = Number(option("--port", "49741"));
const token = option("--token");
const durationMs = Number(option("--duration-ms", "1500"));
if (
  !/^default$|^wavein:[0-9]{1,4}$/.test(device) ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !/^[A-Za-z0-9_-]{16,256}$/.test(token) ||
  !Number.isInteger(durationMs) ||
  durationMs < 100 ||
  durationMs > 30_000 ||
  process.argv.some((value) => value === "--reveal-transcript" || value.startsWith("--reveal-transcript="))
)
  throw new Error("invalid_sensevoice_final_gate_options");

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const assetAudit = await auditAssets(manifest);
  const serverPath = resolve("tools/lib/voice-final-gate-server.mjs");
  const child = spawn(process.execPath, [serverPath, manifestPath, String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, GAMEBUDDY_WINDOWS_INPUT_DEVICE: device, GAMEBUDDY_VOICE_TOKEN: token },
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
  try {
    await waitFor(
      () => stdout.includes("voice_final_gate_listening"),
      20_000,
      "gateway_start_timeout",
      () => stderr,
    );
    const client = await VoiceGatewayProbeClient.connect(port, token);
    try {
      const sessionId = "voice_final_gate";
      const inputId = `ptt_${randomUUID().replaceAll("-", "")}`;
      const started = await client.request({
        type: "ptt_start",
        requestId: "ptt_start_01",
        sessionId,
        inputId,
        locale: "zh-CN",
      });
      if (started.type !== "accepted" || started.value !== inputId) throw new Error("ptt_start_rejected");
      await delay(durationMs);
      const stopped = await client.request({ type: "ptt_stop", requestId: "ptt_stop_01", reasonCode: "ptt_released" });
      if (stopped.type !== "accepted") throw new Error("ptt_stop_rejected");
      const events = await client.request({ type: "events", requestId: "events_01", after: 0, sessionId });
      const final =
        events.type === "events"
          ? events.events?.find((event) => event?.type === "final_transcript" && event.inputId === inputId)
          : undefined;
      const state = final !== undefined ? "passed" : "blocked";
      const finalTranscript =
        final === undefined
          ? null
          : {
              inputId: final.inputId,
              locale: final.locale,
              providerId: final.providerId,
              modelRevision: final.modelRevision,
              textLength: typeof final.text === "string" ? final.text.length : 0,
              actualFormat: final.actualFormat,
            };
      // User speech is never disclosed, compared, hashed, or persisted by this
      // runner. It reports only delivery-state metadata for a local PTT turn.
      console.log(
        JSON.stringify(
          {
            state,
            gate: "windows_ptt_sensevoice_final",
            selection: device,
            assets: assetAudit,
            finalTranscript,
            eventTypes: events.type === "events" ? (events.events?.map((event) => event?.type) ?? []) : [],
            failure: final === undefined ? summarizeFailure(events) : null,
            gatewayDiagnostics: final === undefined ? summarizeGatewayDiagnostics(stderr) : undefined,
          },
          null,
          2,
        ),
      );
      if (state !== "passed") process.exitCode = 2;
    } finally {
      client.close();
    }
  } finally {
    child.kill("SIGTERM");
    await Promise.race([once(child, "close"), delay(5_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing_${name.slice(2)}`);
  }
  if (index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}
async function auditAssets(value) {
  if (
    value?.runtimeId !== "funasr-llamacpp" ||
    !/^[A-Za-z0-9._-]{1,96}$/.test(value?.runtimeRevision ?? "") ||
    !isHash(value?.encoderSha256) ||
    !isHash(value?.modelSha256) ||
    !isHash(value?.vadSha256)
  )
    throw new Error("invalid_sensevoice_asset_manifest");
  for (const [path, expected] of [
    [value.encoderPath, value.encoderSha256],
    [value.modelPath, value.modelSha256],
    [value.vadPath, value.vadSha256],
    [value.executablePath, null],
  ]) {
    await stat(path);
    if (expected !== null && (await sha256(path)) !== expected.toLowerCase())
      throw new Error("sensevoice_asset_hash_mismatch");
  }
  return {
    runtimeId: value.runtimeId,
    runtimeRevision: value.runtimeRevision,
    encoderSha256Prefix: value.encoderSha256.slice(0, 12),
    modelSha256Prefix: value.modelSha256.slice(0, 12),
    vadSha256Prefix: value.vadSha256.slice(0, 12),
  };
}
function isHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}
async function waitFor(predicate, timeout, reason, details) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (details().trim().length > 0) throw new Error("gateway_start_failed");
    await delay(50);
  }
  throw new Error(reason);
}
function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
function summarizeFailure(events) {
  if (events?.type !== "events") return "events_unavailable";
  const failure = events.events?.find(
    (event) => event?.type === "asr_failure" || (event?.type === "capture_state" && event?.state === "failed"),
  );
  return failure?.reasonCode ?? "final_transcript_missing";
}
/** Bounded runtime diagnostics only: no audio, transcript, paths, tokens or command args. */
function summarizeGatewayDiagnostics(stderr) {
  const compact = stderr
    .replace(/[\r\n]+/g, " ")
    .replace(/[A-Za-z]:\\[^\s]+/g, "<path>")
    .trim();
  return compact.length === 0 ? null : compact.slice(0, 240);
}

await main();
