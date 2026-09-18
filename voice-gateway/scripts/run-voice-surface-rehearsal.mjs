/**
 * 前端-声音联调 rehearsal(无真人):验证 voice surface reader 投影经过冻结契约
 * 到达浏览器 snapshot 的最小闭环。
 *
 * 用 host 侧真实 `LocalVoiceGatewayClient` 连接真实 voice gateway:
 *   1. hello + health -> createVoiceSurfaceReader() == 可读
 *   2. streamSpeechChunk(v2 帧真实线缆)-> reader 进入 speaking
 *   3. 推送 completed 观察 -> reader 回到 ready
 *   4. snapshot 组装(contract facade 投影语义)经 TavernStateSnapshotV1Schema 校验
 *
 * 不需要玩家说话;gateway 使用真实 mixer(合成 TTS,避免 MiMo 网络依赖)。
 */
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "host");
const voiceGatewayRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Use the built host voice client and frozen browser contract.
const { LocalVoiceGatewayClient } = await import(
  pathToFileURL(resolve(hostRoot, "dist-test-voice3", "voice-gateway-client.js")).href,
);
const { TavernBrowserValidatorsV1 } = await import(
  pathToFileURL(resolve(hostRoot, "dist-test-voice3", "tavern", "browser-contract", "index.js")).href,
);

const token = "voice_token_1234567890_v2rehearsal";
const port = Number.parseInt(process.env.GAMEBUDDY_VOICE_PORT ?? "49732", 10);
const artifactPath = resolve(dirname(fileURLToPath(import.meta.url)), "pipeline-voice-surface-rehearsal.json");
const { writeFile } = await import("node:fs/promises");

if (process.platform !== "win32") {
  console.error("voice_surface_rehearsal_requires_windows");
  process.exit(2);
}

const { createStreamingWindowsAudioMixer } = await import(
  pathToFileURL(resolve(voiceGatewayRoot, "dist", "streaming-windows-audio.js")).href,
);
const { MimoTtsProvider } = await import(pathToFileURL(resolve(voiceGatewayRoot, "dist", "mimo.js")).href);
const { startVoiceGateway } = await import(pathToFileURL(resolve(voiceGatewayRoot, "dist", "server.js")).href);
const { synthSpeechLikePcm16 } = await import(pathToFileURL(resolve(voiceGatewayRoot, "dist", "synth-audio.js")).href);

process.loadEnvFile?.(resolve(voiceGatewayRoot, "..", ".env.local"));

const mixer = await createStreamingWindowsAudioMixer("default");
if (mixer.ready !== true) {
  console.error(`voice_surface_output_unavailable: ${mixer.failureReason ?? "mixer_not_ready"}`);
  process.exit(1);
}
const tts = {
  providerId: "synth-live-gate",
  modelRevision: "synth-v1",
  ready: true,
  async *synthesize(job) {
    const durationMs = Math.min(Math.max(120, job.text.length * 60), 3_000);
    yield synthSpeechLikePcm16(durationMs / 1_000, { amplitude: 4_000 });
  },
};

const gateway = await startVoiceGateway({ port, token, tts, mixer });
const record = { schema: "gamebuddy-voice-surface-rehearsal/v1", passed: false, reason: "not_started" };
try {
  const client = await LocalVoiceGatewayClient.connect({ port: gateway.port, token });
  await client.health();
  const reader = client.createVoiceSurfaceReader();

  // 1. Ready surface after a healthy gateway.
  const readyState = reader();
  if (readyState === null || readyState.state !== "ready") {
    throw new Error(`voice_surface_not_ready: ${JSON.stringify(readyState)}`);
  }

  // 2. A streamed v2 job must move the surface to speaking.
  const sessionId = "voice_surface_rehearsal_session";
  const speechJobId = "voice_surface_rehearsal_job";
  const deadlineMs = Date.now() + 120_000;
  const observations = [];
  const unsubscribe = client.onPlaybackObservation((event) => observations.push(event));

  await client.streamSpeechChunk(sessionId, speechJobId, 0, "你好，这是语音表面的联调验证。", true, deadlineMs);
  const speakingState = reader();
  if (speakingState === null || speakingState.state !== "speaking") {
    throw new Error(`voice_surface_not_speaking: ${JSON.stringify(speakingState)}`);
  }

  // 3. Wait for the terminal observation pushed over the real wire.
  const settled = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("voice_surface_observation_timeout")), 60_000);
    const check = () => {
      const terminal = observations.find(
        (event) => event.type === "playback_observation" && event.speechJobId === speechJobId,
      );
      if (terminal !== undefined) {
        clearTimeout(timer);
        resolvePromise(terminal);
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
  unsubscribe();

  // 4. The terminal observation must settle the surface back to ready.
  const settledState = reader();
  if (settledState === null || settledState.state !== "ready") {
    throw new Error(`voice_surface_not_settled: ${JSON.stringify(settledState)}`);
  }

  // 5. Contract projection: the snapshot with this voice field must satisfy
  //    the frozen TavernBrowserValidatorsV1 schema (additive optional).
  const snapshot = {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken: "A".repeat(43),
    browserSession: { expiresAtMs: 0 },
    operations: [],
    navigation: [],
    selection: null,
    chat: null,
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    voice: readyState,
    eventStream: null,
  };
  if (!TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check(snapshot)) {
    throw new Error("voice_surface_snapshot_schema_rejected");
  }

  await mixer.close();
  const stats = mixer.playoutStats;
  record.passed = true;
  record.reason = "ok";
  record.readyState = readyState.state;
  record.speakingObserved = true;
  record.settledState = settledState.state;
  record.terminalStatus = settled.terminalStatus;
  record.playoutStats = stats;
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.log(
    `voice_surface_passed: ready -> speaking -> ${settledState.state} (terminal=${settled.terminalStatus})` +
      (stats === undefined ? "" : ` [maxGap=${stats.maxGapMs}ms overStep=${stats.gapsOverStepMs}/${stats.frames}]`),
  );
  client.close();
} catch (error) {
  record.reason = error instanceof Error ? error.message : "voice_surface_rehearsal_failed";
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.error(`voice_surface_failed: ${record.reason}`);
  process.exitCode = 1;
} finally {
  await gateway.close();
  await mixer.close();
}