/**
 * Bundle live rehearsal — real Voice Gateway as a single-file bundle child.
 *
 * Spawns `voice-gateway/.dist/entry/voice-gateway-entry.mjs` as an isolated
 * child process (the exact artifact the production publisher stages), injects
 * the launch-only environment a Desktop supervisor would (port/token/cloud
 * admission/persona), then drives a real v2 wire session: v1 hello, two
 * `stream_speech_chunk` frames, and a `playback_observation(completed)`.
 * No真人说话: TTS 输出走真实常驻 WinMM stream.
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

const voiceGatewayRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundleEntry = resolve(voiceGatewayRoot, ".dist", "entry", "voice-gateway-entry.mjs");
const artifactPath = resolve(voiceGatewayRoot, "scripts", "pipeline-bundle-live-rehearsal.json");
const { writeFile } = await import("node:fs/promises");

if (process.platform !== "win32") {
  console.error("voice_bundle_rehearsal_requires_windows");
  process.exit(2);
}

const port = Number.parseInt(process.env.GAMEBUDDY_VOICE_PORT ?? "49744", 10);
const token = "voice_token_1234567890_bundle_rehearsal";
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
// Rehearsal-only: strip PATH/most inherited variables to prove the bundle
// reaches voice ready under the Desktop supervisor's child-only environment.
for (const name of ["PATH", "PATHEXT", "USERPROFILE", "APPDATA", "windir"]) {
  delete env[name];
}
// The bundle loads .env.local itself, but this rehearsal runs the isolated
// artifact, so the cloud credential is injected the same way a Desktop
// supervisor supplies it (never inferred from the child environment).
try {
  const local = await readFile(resolve(voiceGatewayRoot, "..", ".env.local"), "utf8");
  const match = local.match(/^MIMO_API_KEY=(.*)$/m);
  if (match !== null && match[1].trim().length >= 16) env.MIMO_API_KEY = match[1].trim();
} catch {
  // optional local file
}

const child = spawn(process.execPath, ["--use-env-proxy", bundleEntry], {
  cwd: voiceGatewayRoot,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let childStdout = "";
let childStderr = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => { childStdout += chunk; });
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { childStderr += chunk; });

const record = { schema: "gamebuddy-voice-bundle-live-rehearsal/v1", passed: false, reason: "not_started", persona };
const waitForReady = new Promise((resolvePromise, reject) => {
  const deadline = Date.now() + 30_000;
  const poll = () => {
    if (childStdout.includes("listening on 127.0.0.1")) return resolvePromise();
    if (child.exitCode !== null || child.signalCode !== null) return reject(new Error(`gateway_child_exited: ${child.exitCode}; stderr=${childStderr.slice(-600)}`));
    if (Date.now() > deadline) return reject(new Error("gateway_listen_timeout"));
    setTimeout(poll, 200);
  };
  poll();
});

try {
  await waitForReady;

  const socket = createConnection({ host: "127.0.0.1", port });
  let buffer = "";
  const waiters = [];
  const events = [];
  socket.setEncoding("utf8");
  const nextFrame = () =>
    new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("v2_peer_read_timeout")), 60_000);
      waiters.push((frame) => {
        clearTimeout(timer);
        resolvePromise(frame);
      });
    });
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const frame = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(frame);
      else events.push(frame);
    }
  });
  await new Promise((resolvePromise, reject) => {
    socket.once("error", reject);
    socket.once("connect", resolvePromise);
  });

  socket.write(`${JSON.stringify({ type: "hello", token, protocolVersion: 1, requestId: randomUUID() })}\n`);
  const helloAck = await nextFrame();
  if (helloAck.type !== "hello_ack") throw new Error(`v2_hello_failed: ${helloAck.type}`);

  const epoch = 0;
  const deadlineMs = Date.now() + 120_000;
  const sessionId = `bundle_rehearsal_${randomUUID().slice(0, 8)}`;
  const speechJobId = `bundle_job_${randomUUID().slice(0, 8)}`;
  const base = { protocolVersion: 2, sessionId, connectionEpoch: epoch, timestampMs: Date.now(), speechJobId, deadlineMs };

  socket.write(`${JSON.stringify({ ...base, type: "stream_speech_chunk", requestId: randomUUID(), chunkIndex: 0, deltaText: "你好，这是单文件 bundle 线缆的第一段朗读。", isFinalChunk: false })}\n`);
  socket.write(`${JSON.stringify({ ...base, type: "stream_speech_chunk", requestId: randomUUID(), chunkIndex: 1, deltaText: "第二段是最终分块，结束后应推送播放完成事件。", isFinalChunk: true, timestampMs: Date.now() })}\n`);

  let observation;
  for (let index = 0; index < 240; index += 1) {
    const frame = await nextFrame();
    events.push(frame);
    if (frame.type === "playback_observation" && frame.speechJobId === speechJobId) {
      observation = frame;
      break;
    }
  }
  if (observation === undefined) throw new Error(`v2_playback_observation_missing: ${JSON.stringify(events)}`);
  if (observation.terminalStatus !== "completed")
    throw new Error(`v2_playback_not_completed: ${JSON.stringify(observation)}`);

  // Give the resident mixer a moment to flush its playout stats line.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
  const statsLine = childStderr.split("\n").reverse().find((line) => line.includes("playoutStats") || (line.includes("frames") && line.includes("maxGapMs")));

  record.passed = true;
  record.reason = "ok";
  record.terminalStatus = observation.terminalStatus;
  record.audioEndMs = observation.audioEndMs;
  record.playoutStatsLine = statsLine ?? null;
  record.childReadyLine = childStdout.split("\n").find((line) => line.includes("listening on 127.0.0.1")) ?? null;
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.log(
    `voice_bundle_passed: ${observation.terminalStatus} ${statsLine ?? "(no stats line)"}\n` +
      `ready: ${record.childReadyLine}`,
  );
  socket.destroy();
} catch (error) {
  record.reason = error instanceof Error ? error.message : "bundle_rehearsal_failed";
  record.childReadyLine = childStdout.split("\n").find((line) => line.includes("listening on 127.0.0.1")) ?? null;
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.error(`voice_bundle_failed: ${record.reason}\nstderr=${childStderr.slice(-800)}`);
  process.exitCode = 1;
} finally {
  child.kill();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
}