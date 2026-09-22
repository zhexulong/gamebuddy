/**
 * Host wire ↔ real bundle gateway joint rehearsal.
 *
 * Spawns the bundled single-file gateway (voice-gateway/.dist/entry) with the
 * exact child-only launch environment the Desktop supervisor would inject,
 * then connects the *production Host adapter* the way desktop bootstrap does
 * (connectHealthyVoiceGateway → LocalVoiceGatewayClient), drives the Chat
 * streaming sink (createChatVoiceStreamingSink) with two delta chunks and a
 * finalize, and asserts the terminal playback observation plus the additive
 * voice surface state returns to "ready". No 真人说话: TTS is real MiMo;
 * only the LLM-delta side is scripted text.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";

const voiceGatewayRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hostRoot = resolve(voiceGatewayRoot, "..", "host");
const bundleEntry = resolve(voiceGatewayRoot, ".dist", "entry", "voice-gateway-entry.mjs");
const artifactPath = resolve(voiceGatewayRoot, "scripts", "pipeline-host-wire-bundle-rehearsal.json");

if (process.platform !== "win32") {
  console.error("voice_host_wire_rehearsal_requires_windows");
  process.exit(2);
}

const port = Number.parseInt(process.env.GAMEBUDDY_VOICE_PORT ?? "49745", 10);
const token = "voice_token_1234567890_host_wire_rehearsal";
const persona = process.env.GAMEBUDDY_MIMO_PERSONA ?? "soft_maid";

const env = {
  ...process.env,
  GAMEBUDDY_VOICE_PORT: String(port),
  GAMEBUDDY_VOICE_TOKEN: token,
  GAMEBUDDY_VOICE_CLOUD_TTS_ADMISSION: "desktop-consent-v1",
  GAMEBUDDY_MIMO_PERSONA: persona,
  GAMEBUDDY_WINDOWS_OUTPUT_DEVICE: process.env.GAMEBUDDY_WINDOWS_OUTPUT_DEVICE ?? "default",
  HTTPS_PROXY: process.env.HTTPS_PROXY ?? "",
  HTTP_PROXY: process.env.HTTP_PROXY ?? "",
};
// Rehearsal-only: strip PATH and the rest to prove the production child-only
// environment reaches voice ready (the absolute PowerShell path fix).
for (const name of ["PATH", "PATHEXT", "USERPROFILE", "APPDATA", "windir"]) delete env[name];

const child = spawn(process.execPath, ["--use-env-proxy", bundleEntry], {
  cwd: voiceGatewayRoot,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let childOut = "";
let childErr = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => { childOut += chunk; });
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { childErr += chunk; });

const record = { schema: "gamebuddy-voice-host-wire-bundle-rehearsal/v1", passed: false, reason: "not_started", persona };

try {
  const readyLine = await new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + 45_000;
    const poll = () => {
      const line = childOut.split("\n").find((l) => l.includes("listening on 127.0.0.1"));
      if (line !== undefined) return resolvePromise(line.trim());
      if (child.exitCode !== null || child.signalCode !== null) return reject(new Error(`gateway_child_exited: ${child.exitCode}; stderr=${childErr.slice(-600)}`));
      if (Date.now() > deadline) return reject(new Error("gateway_listen_timeout"));
      setTimeout(poll, 200);
    };
    poll();
  });
  if (!readyLine.includes("voice ready")) throw new Error(`gateway_not_voice_ready: ${readyLine}`);

  // Production Host adapter path: same module + connect seam the desktop
  // bootstrap wire uses (voice-bootstrap.ts → connectHealthyVoiceGateway).
  const { connectHealthyVoiceGateway } = await import(pathToFileURL(resolve(hostRoot, "dist-test", "voice-bootstrap.js")).href);
  // Production wire calls health *without* a voiceProfile (the gateway
  // resolves its own configured profile); passing the persona id here would
  // mismatch the configured companion.default profile and read unavailable.
  const voice = await connectHealthyVoiceGateway({ host: "127.0.0.1", port, token });
  if (voice === undefined) throw new Error("host_wire_connection_failed");
  const health = await voice.health();
  if (health === undefined) throw new Error("host_wire_health_failed");
  record.capabilitiesReady = true;

  const sink = voice.createChatVoiceStreamingSink();
  const reader = voice.createVoiceSurfaceReader();

  await sink.begin?.(`turn_${Date.now()}`);
  const before = reader();
  const observations = [];
  const unsubscribe = voice.onPlaybackObservation((event) => {
    if (event?.terminalStatus !== undefined) observations.push(event);
  });
  await sink.append("你好，这是 Host 流式 sink 的第一段。");
  await sink.append("第二段结束后应回到 ready。");
  await sink.finalize?.();
  // Wait for the terminal playback observation to arrive and the surface
  // state to settle back to ready.
  const deadline = Date.now() + 120_000;
  while (observations.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  unsubscribe();
  if (observations.length === 0) throw new Error("playback_observation_missing");
  const observation = observations[observations.length - 1];
  if (observation.terminalStatus !== "completed") throw new Error(`playback_not_completed: ${observation.terminalStatus}`);

  await new Promise((r) => setTimeout(r, 1500));
  const after = reader();

  record.passed = true;
  record.reason = "ok";
  record.terminalStatus = observation.terminalStatus;
  record.beforeSurfaceState = before?.state ?? null;
  record.afterSurfaceState = after?.state ?? null;
  record.childReadyLine = readyLine;
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record, null, 2));
  await voice.close();
} catch (error) {
  record.reason = error instanceof Error ? error.message : "host_wire_rehearsal_failed";
  record.childReadyLine = childOut.split("\n").find((l) => l.includes("listening on 127.0.0.1")) ?? null;
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.error(`voice_host_wire_failed: ${record.reason}\nstderr=${childErr.slice(-800)}`);
  process.exitCode = 1;
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}