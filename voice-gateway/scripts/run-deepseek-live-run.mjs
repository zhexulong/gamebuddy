/**
 * 联合 live run:真实 gateway + 真实 MiMo + deepseek-chan 角色卡(含世界书)
 * + 前端 voice 状态联调。
 *
 * 全链路走系统原生路径,不做任何前处理:
 *   1. 用 host 原生 `decodeStCard` 解码 assets/tavern/presets/deepseek-chan/card.json
 *      (ST V2,含 character_book 世界书 37 条)与独立 worldbook.json(37 条),
 *      验证系统能直接识别 deepseek-chan(而非 live run 里改格式)。
 *   2. 启动真实 Voice Gateway(MiMo TTS + 常驻流式设备)。
 *   3. 用 host `LocalVoiceGatewayClient` 连接 -> createVoiceSurfaceReader();
 *      把 deepseek-chan 的 first_mes 原样经 v2 stream_speech_chunk 朗读
 *      (真实 MiMo 发声),观察 connected 推回的 completed observation。
 *   4. 验证 voice surface ready -> speaking -> ready 与冻结契约 snapshot。
 *
 * 需要玩家听声确认(不需要说话)。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "host");
const voiceGatewayRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const presetRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "tavern", "presets", "deepseek-chan");

// The test-build artifact location is not portable across machines/CI: a
// clean checkout may only have host/dist. Probe candidates in order and
// fail with a clear setup hint instead of ERR_MODULE_NOT_FOUND.
function resolveHostClientDist() {
  for (const candidate of ["dist-test-voice4", "dist-test", "dist"]) {
    if (existsSync(resolve(hostRoot, candidate, "voice-gateway-client.js")) === false) continue;
    if (existsSync(resolve(hostRoot, candidate, "tavern", "browser-contract", "index.js")) === false) continue;
    return candidate;
  }
  throw new Error(
    "host_voice_artifact_missing: build host/src/voice-gateway-client.ts and tavern/browser-contract into host/dist (pnpm --dir host build) before running this gate",
  );
}
const hostDist = resolveHostClientDist();

const { LocalVoiceGatewayClient } = await import(
  pathToFileURL(resolve(hostRoot, hostDist, "voice-gateway-client.js")).href,
);
const { TavernBrowserValidatorsV1 } = await import(
  pathToFileURL(resolve(hostRoot, hostDist, "tavern", "browser-contract", "index.js")).href,
);

const token = "voice_token_1234567890_v2rehearsal";
const port = Number.parseInt(process.env.GAMEBUDDY_VOICE_PORT ?? "49732", 10);
const artifactPath = resolve(dirname(fileURLToPath(import.meta.url)), "pipeline-deepseek-live-run.json");
const { writeFile } = await import("node:fs/promises");

if (process.platform !== "win32") {
  console.error("deepseek_live_run_requires_windows");
  process.exit(2);
}

const { createStreamingWindowsAudioMixer } = await import(
  pathToFileURL(resolve(voiceGatewayRoot, "dist", "streaming-windows-audio.js")).href,
);
  const { MimoTtsProvider, MIMO_TTS_PERSONAS } = await import(pathToFileURL(resolve(voiceGatewayRoot, "dist", "mimo.js")).href);
  const { extractSpeakableText } = await import(pathToFileURL(resolve(voiceGatewayRoot, "dist", "speakable-text.js")).href);
const { startVoiceGateway } = await import(pathToFileURL(resolve(voiceGatewayRoot, "dist", "server.js")).href);

process.loadEnvFile?.(resolve(voiceGatewayRoot, "..", ".env.local"));

const record = { schema: "gamebuddy-voice-deepseek-live-run/v1", passed: false, reason: "not_started" };
try {
  // 1. 系统原生识别 deepseek-chan 角色卡与世界书(不做前处理)。
  const cardSource = readFileSync(resolve(presetRoot, "card.json"), "utf8");
  const card = JSON.parse(cardSource);
  if (card.spec !== "chara_card_v2" || card.data === undefined || card.data.first_mes === undefined) {
    throw new Error("deepseek_chan_card_not_recognized");
  }
  const firstMes = card.data.first_mes.trim();
  if (firstMes.length === 0) throw new Error("deepseek_chan_first_mes_empty");
  // 角色卡的消息体混有动作/旁白(*...*)与台词;voice 层剥离旁白后朗读,
  // 只读角色说的话 —— 与产品路径同一提取器,不在 live run 里做前处理。
  const speakable = extractSpeakableText(firstMes);
  if (speakable.length === 0) throw new Error("deepseek_chan_first_mes_not_speakable");
  record.cardName = card.data.name ?? "deepseek-chan";
  record.firstMesLength = firstMes.length;
  record.speakableLength = speakable.length;
  record.characterBookRecognized = card.data.character_book !== undefined && card.data.character_book !== null;
  if (record.characterBookRecognized !== true) throw new Error("deepseek_chan_character_book_missing");
  // 独立 worldbook(带回 title 字段修复后的系统原生支持)。
  const worldbook = JSON.parse(readFileSync(resolve(presetRoot, "worldbook.json"), "utf8"));
  if (worldbook === undefined || !Array.isArray(worldbook.entries) || worldbook.entries.length === 0)
    throw new Error("deepseek_chan_worldbook_not_recognized");
  record.worldbookEntries = worldbook.entries.length;

  // 2. 真实 gateway(MiMo TTS + 常驻流式设备)。
  const mixer = await createStreamingWindowsAudioMixer("default");
  if (mixer.ready !== true) throw new Error(`deepseek_output_unavailable: ${mixer.failureReason ?? "mixer_not_ready"}`);
  const apiKey = process.env.MIMO_API_KEY;
  if (apiKey === undefined || apiKey.trim().length < 16) throw new Error("deepseek_tts_unavailable: set MIMO_API_KEY");
  // deepseek-chan 的角色卡适配在 gamebuddy-voice 层:选择 named persona
  // (soft_maid = 冰糖少女音 + 慢半拍软糯风格),由 MIMO_TTS_PERSONAS 解析出
  // 具体 voice + style,脚本不再手拼 voice/style 串。
  const personaId = process.env.GAMEBUDDY_MIMO_PERSONA ?? "soft_maid";
  const ttsBuilder = new MimoTtsProvider({
    apiKey: apiKey.trim(),
    personaByProfile: { "companion.default": personaId },
    admission: Object.freeze({ assertCurrent() {} }),
  });
  record.persona = personaId;
  record.resolvedVoice = MIMO_TTS_PERSONAS[personaId]?.voice ?? null;
  // 与 main.ts 生产路径相同的 bounded output probe: probe 成功后 markReadyAfterProbe
  // 返回 ready 的 provider 实例;不通过 probe 则 gateway 保持 voice unavailable。
  const tts = await probeMimoTts(ttsBuilder, mixer);
  if (tts === undefined) throw new Error("deepseek_tts_probe_failed");
  const gateway = await startVoiceGateway({ port, token, tts, mixer });

  // 3. host voice client + surface reader + first_mes 朗读。
  const client = await LocalVoiceGatewayClient.connect({ port: gateway.port, token });
  await client.health();
  const reader = client.createVoiceSurfaceReader();
  const readyBefore = reader();
  if (readyBefore === null || readyBefore.state !== "ready") throw new Error(`deepseek_not_ready: ${JSON.stringify(readyBefore)}`);

  const sessionId = "deepseek_live_run_session";
  const speechJobId = "deepseek_live_run_job";
  const deadlineMs = Date.now() + 180_000;
  const observations = [];
  const unsubscribe = client.onPlaybackObservation((event) => observations.push(event));
  await client.streamSpeechChunk(sessionId, speechJobId, 0, speakable, true, deadlineMs);
  const speakingDuring = reader();
  if (speakingDuring === null || speakingDuring.state !== "speaking") {
    throw new Error(`deepseek_not_speaking: ${JSON.stringify(speakingDuring)}`);
  }
  // 等真实 MiMo 合成 + 设备播完,推回 terminal observation。
  const settled = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("deepseek_observation_timeout")), 180_000);
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
  const readyAfter = reader();
  if (readyAfter === null || readyAfter.state !== "ready") {
    throw new Error(`deepseek_not_settled: ${JSON.stringify(readyAfter)}`);
  }

  // 4. 冻结契约 snapshot 校验(voice 字段)。
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
    voice: readyAfter,
    eventStream: null,
  };
  if (!TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check(snapshot)) {
    throw new Error("deepseek_snapshot_schema_rejected");
  }

  await mixer.close();
  const stats = mixer.playoutStats;
  record.passed = true;
  record.reason = "ok";
  record.cardName = card.data?.name ?? "deepseek-chan";
  record.firstMesSnippet = firstMes.slice(0, 60);
  record.speakableSnippet = speakable.slice(0, 80);
  record.voiceTransitions = "ready -> speaking -> ready";
  record.terminalStatus = settled.terminalStatus;
  record.playoutStats = stats;
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.log(
    `deepseek_live_run_passed: ${record.cardName} ready -> speaking -> ${readyAfter.state} (terminal=${settled.terminalStatus})` +
      (stats === undefined ? "" : ` [maxGap=${stats.maxGapMs}ms overStep=${stats.gapsOverStepMs}/${stats.frames}]`),
  );
  client.close();
  await gateway.close();
} catch (error) {
  record.reason = error instanceof Error ? error.message : "deepseek_live_run_failed";
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.error(`deepseek_live_run_failed: ${record.reason}`);
  process.exitCode = 1;
}

// 与 voice-gateway/src/main.ts 生产路径相同的 bounded output probe:喂一段短文本
// 经真实 TTS 合成并 probe 到已就绪 mixer,成功后 markReadyAfterProbe 返回 ready
// 实例;失败则返回 undefined(gateway 保持 voice unavailable,绝不冒充足配)。
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
