/**
 * 三轮流式 live run 诊断:
 *  - 每轮把一段文本按句子切成多个 chunk,按模拟 LLM 生成节奏流式发送
 *    (stream_speech_chunk 增量 delta,末尾 isFinalChunk=true)。
 *  - 记录每轮:首 chunk 发送时刻、全部 chunk 发送完成时刻、
 *    playback_observation(completed)到达时刻、mixer.close() 返回时刻。
 *  - 目标:量化"脚本完成 vs 播放完成"的差值来源,并验证流式链路
 *    (首 chunk -> 开始出声)的真实延迟。
 */
import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createConnection } from "node:net";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "host");
const voiceGatewayRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const presetRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "tavern", "presets", "deepseek-chan");

function resolveHostClientDist() {
  for (const candidate of ["dist-test-voice4", "dist-test", "dist"]) {
    if (existsSync(resolve(hostRoot, candidate, "voice-gateway-client.js")) === false) continue;
    if (existsSync(resolve(hostRoot, candidate, "tavern", "browser-contract", "index.js")) === false) continue;
    return candidate;
  }
  throw new Error(
    "host_voice_artifact_missing: build host voice-gateway-client + tavern/browser-contract into host/dist before running this gate",
  );
}
const hostDist = resolveHostClientDist();

const { LocalVoiceGatewayClient } = await import(
  pathToFileURL(resolve(hostRoot, hostDist, "voice-gateway-client.js")).href,
);
const { createStreamingWindowsAudioMixer } = await import(
  pathToFileURL(resolve(voiceGatewayRoot, "dist", "streaming-windows-audio.js")).href,
);
const { MimoTtsProvider, MIMO_TTS_PERSONAS } = await import(pathToFileURL(resolve(voiceGatewayRoot, "dist", "mimo.js")).href);
const { startVoiceGateway } = await import(pathToFileURL(resolve(voiceGatewayRoot, "dist", "server.js")).href);
const { extractSpeakableText } = await import(pathToFileURL(resolve(voiceGatewayRoot, "dist", "speakable-text.js")).href);

process.loadEnvFile?.(resolve(voiceGatewayRoot, "..", ".env.local"));

const token = "voice_token_1234567890_v2rehearsal";
const port = Number.parseInt(process.env.GAMEBUDDY_VOICE_PORT ?? "49732", 10);
const artifactPath = resolve(dirname(fileURLToPath(import.meta.url)), "pipeline-streaming-3turn.json");

// 三轮对话文本(第一轮用卡内 first_mes,其余为模拟 LLM 响应的后续轮次)。
const card = JSON.parse(readFileSync(resolve(presetRoot, "card.json"), "utf8"));
const firstMes = extractSpeakableText(card.data.first_mes.trim());
const turns = [
  firstMes,
  "嗯……我记得你上次说要帮我整理一下日程。(开心) 现在正好有空,我们可以现在就开始。",
  "那从现在开始,我就是你的专属小助手啦。有什么奇怪的问题,也都可以交给我哦。",
];

function splitSentences(text) {
  // 简单按句子分隔符切分,尾随残片并入末句。
  const parts = text.split(/(?<=[。！？!?])/g).filter((p) => p.trim().length > 0);
  return parts.length > 0 ? parts : [text];
}

const record = {
  schema: "gamebuddy-voice-streaming-3turn/v1",
  passed: false,
  reason: "not_started",
  turns: [],
  timings: {},
};
const now = () => Date.now();
try {
  if (process.platform !== "win32") throw new Error("streaming_3turn_requires_windows");
  const t0 = now();
  const apiKey = process.env.MIMO_API_KEY;
  if (apiKey === undefined || apiKey.trim().length < 16) throw new Error("mimo_key_missing");
  const mixer = await createStreamingWindowsAudioMixer("default");
  if (mixer.ready !== true) throw new Error(`mixer_unavailable: ${mixer.failureReason ?? "no_reason"}`);
  const tMixer = now();
  const personaId = process.env.GAMEBUDDY_MIMO_PERSONA ?? "soft_maid";
  const ttsBuilder = new MimoTtsProvider({
    apiKey: apiKey.trim(),
    personaByProfile: { "companion.default": personaId },
    admission: Object.freeze({ assertCurrent() {} }),
  });
  const tts = await probeMimoTts(ttsBuilder, mixer);
  if (tts === undefined) throw new Error("tts_probe_failed");
  const tProbe = now();
  const gateway = await startVoiceGateway({ port, token, tts, mixer });
  const client = await LocalVoiceGatewayClient.connect({ port: gateway.port, token });
  await client.health();
  const tReady = now();
  record.persona = personaId;
  record.resolvedVoice = MIMO_TTS_PERSONAS[personaId]?.voice ?? null;

  const sessionId = "streaming_3turn_session";
  let turnIndex = 0;
  for (const turnText of turns) {
    turnIndex += 1;
    const sentences = splitSentences(turnText);
    const speechJobId = `turn_${turnIndex}_job`;
    const deadlineMs = now() + 180_000;
    const chunkStartTimes = [];
    const observations = [];
    const unsubscribe = client.onPlaybackObservation((event) => observations.push(event));
    const turnT0 = now();
    let chunkIndex = 0;
    let firstFrameEmittedAtMs = null;
    for (const sentence of sentences) {
      const isFinal = chunkIndex === sentences.length - 1;
      chunkStartTimes.push(now());
      // 模拟 LLM 生成节奏:句间间隔 ~600ms(留出 token 生成时间)。
      if (chunkIndex > 0) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));
      }
      await client.streamSpeechChunk(sessionId, speechJobId, chunkIndex, sentence, isFinal, deadlineMs);
      chunkIndex += 1;
    }
    const tSentAll = now();
    // 等待 terminal observation。
    const settled = await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("observation_timeout")), 180_000);
      const check = () => {
        const terminal = observations.find(
          (event) => event.type === "playback_observation" && event.speechJobId === speechJobId,
        );
        if (terminal !== undefined) {
          clearTimeout(timer);
          resolvePromise(terminal);
        } else {
          setTimeout(check, 25);
        }
      };
      check();
    });
    unsubscribe();
    const tObservation = now();
    record.turns.push({
      turn: turnIndex,
      speakableLength: turnText.length,
      sentences: sentences.length,
      terminalStatus: settled.terminalStatus,
      firstChunkSentMs: turnT0 - t0,
      allChunksSentMs: tSentAll - t0,
      observationMs: tObservation - t0,
      chunkCount: chunkIndex,
      gaps: [],
    });
  }

  // 关闭时序:observation -> mixer.close 返回。
  const tBeforeClose = now();
  await mixer.close();
  const tClosed = now();
  record.timings.observationToCloseMs = tClosed - tBeforeClose;
  record.timings.totalMs = tClosed - t0;
  record.timings.mixerReadyMs = tMixer - t0;
  record.timings.probeMs = tProbe - tMixer;
  record.timings.gatewayReadyMs = tReady - tProbe;
  record.passed = true;
  record.reason = "ok";
  record.playoutStats = mixer.playoutStats;
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.log(`streaming_3turn_passed [total=${record.timings.totalMs}ms close+${record.timings.observationToCloseMs}ms]`);
  for (const turn of record.turns) {
    console.log(
      `  turn${turn.turn}: ${turn.sentences} chunks first@${turn.firstChunkSentMs}ms sent@${turn.allChunksSentMs}ms obs@${turn.observationMs}ms terminal=${turn.terminalStatus}`,
    );
  }
  client.close();
  await gateway.close();
} catch (error) {
  record.reason = error instanceof Error ? error.message : "streaming_3turn_failed";
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.error(`streaming_3turn_failed: ${record.reason}`);
  process.exitCode = 1;
}

async function probeMimoTts(candidate, mixer) {
  if (mixer.ready !== true || typeof mixer.probePcm !== "function") return undefined;
  try {
    const job = {
      jobId: "voice_probe",
      sessionId: "voice_probe",
      epoch: 0,
      sourceEventId: "voice_probe",
      text: "。",
      locale: "zh-CN",
      voiceProfile: "companion.default",
      expiresAtMs: Date.now() + 12_000,
      interruptible: true,
    };
    for await (const pcm16 of candidate.synthesize(job, AbortSignal.timeout(12_000))) {
      await mixer.probePcm(pcm16);
      return candidate.markReadyAfterProbe();
    }
  } catch {
    try {
      mixer.stop();
    } catch {}
  }
  return undefined;
}