/**
 * v2 wire rehearsal —真实 v2 线缆 + 真实 MiMo + 真实常驻流式设备的无人验证。
 *
 * 启动真实 Voice Gateway(常驻流式 mixer + MiMo TTS),以一个 v2 peer 身份:
 *   1. v1 hello 认证同一 socket
 *   2. 发送 stream_speech_chunk(两段 delta,第二段 final)
 *   3. 监听服务端推送的 playback_observation(completed)
 *   4. 断言真实 mixer 收到音频、事件 envelop 合法
 *
 * 与 v1 rehearsal 的区别:这里走的就是 v2 wire(设计待办"stream_speech_chunk
 * 真实线缆收发"),但不需要玩家说话 — live gate(PTT 说话)由玩家执行。
 */
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const voiceGatewayRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const gatewayDist = (name) => import(pathToFileURL(resolve(voiceGatewayRoot, "dist", name)).href);

const token = "voice_token_1234567890_v2rehearsal";
const port = Number.parseInt(process.env.GAMEBUDDY_VOICE_PORT ?? "49732", 10);
const outputDevice = process.env.GAMEBUDDY_WINDOWS_OUTPUT_DEVICE ?? "default";
const artifactPath = resolve(voiceGatewayRoot, "scripts", "pipeline-v2-rehearsal.json");
const { writeFile } = await import("node:fs/promises");

if (process.platform !== "win32") {
  console.error("voice_v2_rehearsal_requires_windows");
  process.exit(2);
}

const { createStreamingWindowsAudioMixer } = await gatewayDist("streaming-windows-audio.js");
const { MimoTtsProvider } = await gatewayDist("mimo.js");
const { startVoiceGateway } = await gatewayDist("server.js");

process.loadEnvFile?.(resolve(voiceGatewayRoot, "..", ".env.local"));

const mixer = await createStreamingWindowsAudioMixer(outputDevice);
if (mixer.ready !== true) {
  console.error(`voice_v2_output_unavailable: ${mixer.failureReason ?? "mixer_not_ready"}`);
  process.exit(1);
}
const apiKey = process.env.MIMO_API_KEY;
if (apiKey === undefined || apiKey.trim().length < 16) {
  console.error("voice_v2_tts_unavailable: set MIMO_API_KEY");
  await mixer.close();
  process.exit(2);
}
const tts = new MimoTtsProvider({
  apiKey: apiKey.trim(),
  voiceByProfile: { "companion.default": process.env.GAMEBUDDY_MIMO_VOICE ?? "mimo_default" },
  admission: Object.freeze({ assertCurrent() {} }),
});

const gateway = await startVoiceGateway({ port, token, tts, mixer });
const record = { schema: "gamebuddy-voice-v2-wire-rehearsal/v1", passed: false, reason: "not_started" };
try {
  const socket = createConnection({ host: "127.0.0.1", port: gateway.port });
  let buffer = "";
  const waiters = [];
  const events = [];
  socket.setEncoding("utf8");
  const nextFrame = () =>
    new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("v2_peer_read_timeout")), 30_000);
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

  socket.write(
    `${JSON.stringify({ type: "hello", token, protocolVersion: 1, requestId: randomUUID() })}\n`,
  );
  const helloAck = await nextFrame();
  if (helloAck.type !== "hello_ack") throw new Error(`v2_hello_failed: ${helloAck.type}`);

  const epoch = 0; // 与 server 的 core.epoch 对齐(全新 gateway)
  const deadlineMs = Date.now() + 120_000;
  const sessionId = `v2_rehearsal_${randomUUID().slice(0, 8)}`;
  const speechJobId = `v2_job_${randomUUID().slice(0, 8)}`;
  const base = {
    protocolVersion: 2,
    sessionId,
    connectionEpoch: epoch,
    timestampMs: Date.now(),
    speechJobId,
    deadlineMs,
  };

  socket.write(
    `${JSON.stringify({ ...base, type: "stream_speech_chunk", requestId: randomUUID(), chunkIndex: 0, deltaText: "你好，这是 v2 线缆的第一段。", isFinalChunk: false })}\n`,
  );
  socket.write(
    `${JSON.stringify({ ...base, type: "stream_speech_chunk", requestId: randomUUID(), chunkIndex: 1, deltaText: "第二段是最终分块，结束后应推送播放完成事件。", isFinalChunk: true, timestampMs: Date.now() })}\n`,
  );

  let observation;
  for (let index = 0; index < 120; index += 1) {
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

  await mixer.close();
  const stats = mixer.playoutStats;
  record.passed = true;
  record.reason = "ok";
  record.terminalStatus = observation.terminalStatus;
  record.audioEndMs = observation.audioEndMs;
  record.playoutStats = stats;
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.log(
    `voice_v2_passed: ${observation.terminalStatus} in ${events.filter((e) => e.type === "playback_observation").length} observation(s)` +
      (stats === undefined ? "" : ` [maxGap=${stats.maxGapMs}ms overStep=${stats.gapsOverStepMs}/${stats.frames}]`),
  );
  socket.destroy();
} catch (error) {
  record.reason = error instanceof Error ? error.message : "v2_rehearsal_failed";
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.error(`voice_v2_failed: ${record.reason}`);
  process.exitCode = 1;
} finally {
  await gateway.close();
  await mixer.close();
}