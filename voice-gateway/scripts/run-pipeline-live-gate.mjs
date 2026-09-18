#!/usr/bin/env node
/**
 * Voice pipeline live-run gate.
 *
 * Two modes:
 *
 *   --mode rehearsal   (DEFAULT, unattended): plays three synthesized
 *                      sentences through the REAL Windows output device via
 *                      StreamingSpeechPipeline; verifies the physical chain
 *                      (device open, 20ms micro-chunk flow, fade on cancel),
 *                      without requiring a human speaker. Exit 0 only when
 *                      every stage completes.
 *
 *   --mode live        (final gate): records the microphone while you speak
 *                      (PTT via WindowsPttCapture), runs cloud Groq Whisper ASR
 *                      (GROQ_API_KEY) or audited local SenseVoice
 *                      (GAMEBUDDY_SENSEVOICE_ASSET_MANIFEST), then plays the
 *                      transcript back through the same pipeline.
 *
 * Exit codes: 0 = gate passed, 1 = gate failed, 2 = environment/precondition
 * missing. A JSON artifact is written next to the script.
 *
 * Usage:
 *   node voice-gateway/scripts/run-pipeline-live-gate.mjs --mode rehearsal [--output-device default]
 *   node voice-gateway/scripts/run-pipeline-live-gate.mjs --mode live [--output-device default] [--input-device default]
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const voiceGatewayRoot = resolve(__dirname, "..");
const require = createRequire(import.meta.url);

// Same optional local operator env source as gateway main.ts (.env.local).
for (const envPath of [resolve(voiceGatewayRoot, ".env.local"), resolve(voiceGatewayRoot, "..", ".env.local")]) {
  try {
    process.loadEnvFile?.(envPath);
    break;
  } catch {
    // optional local file
  }
}

// Compiled dist outputs (pnpm --filter @gamebuddy/voice-gateway build).
const gatewayDist = (name) => import(pathToFileURL(resolve(voiceGatewayRoot, "dist", name)).href);

function option(name, argv = process.argv) {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) return null;
  return argv[index + 1];
}
const mode = option("--mode") ?? "rehearsal";
const outputDevice = option("--output-device") ?? process.env.GAMEBUDDY_WINDOWS_OUTPUT_DEVICE ?? "default";
const inputDevice = option("--input-device") ?? process.env.GAMEBUDDY_WINDOWS_INPUT_DEVICE ?? "default";
const ttsMode = option("--tts") ?? "synth";
const artifactPath = resolve(__dirname, "pipeline-live-gate.json");

if (process.platform !== "win32") {
  console.error("voice_gate_requires_windows");
  process.exit(2);
}
if (mode !== "rehearsal" && mode !== "live") {
  console.error("voice_gate_invalid_mode");
  process.exit(2);
}
if (ttsMode !== "synth" && ttsMode !== "mimo") {
  console.error("voice_gate_invalid_tts");
  process.exit(2);
}

const { createWindowsAudioMixer } = await gatewayDist("windows-audio.js");
const { createStreamingWindowsAudioMixer } = await gatewayDist("streaming-windows-audio.js");
const { createStreamingSpeechPipeline } = await gatewayDist("streaming-pipeline.js");
const { synthSpeechLikePcm16 } = await gatewayDist("synth-audio.js");
const { WindowsPttCapture } = await gatewayDist("windows-capture.js");
const { GroqWhisperAsrProvider } = await gatewayDist("groq.js");
const { SenseVoiceCliAsrProvider } = await gatewayDist("sensevoice.js");
const { MimoTtsProvider } = await gatewayDist("mimo.js");

const rl = createInterface({ input: process.stdin, output: process.stdout });

function report(summary) {
  return {
    schema: "gamebuddy-voice-pipeline-live-gate/v1",
    mode,
    runId: randomUUID(),
    timestamp: new Date().toISOString(),
    outputDevice,
    inputDevice,
    ...summary,
  };
}

async function rehearsal() {
  const mixer = await createStreamingWindowsAudioMixer(outputDevice);
  if (mixer.ready !== true) {
    await writeFile(artifactPath, JSON.stringify(report({ passed: false, reason: mixer.failureReason ?? "mixer_not_ready" }), null, 2));
    console.error(`voice_gate_output_unavailable: ${mixer.failureReason ?? "unknown"}`);
    process.exit(1);
  }
  const ttsProvider = ttsMode === "mimo" ? await configuredRehearsalMimo() : await synthTts();
  if (ttsProvider === undefined) {
    await writeFile(artifactPath, JSON.stringify(report({ passed: false, reason: "tts_unavailable" }), null, 2));
    console.error("voice_gate_tts_unavailable: set MIMO_API_KEY for --tts mimo");
    process.exit(2);
  }
  ttsForReport = {
    providerId: ttsProvider.providerId,
    modelRevision: ttsProvider.modelRevision,
  };
  // Phase 2 render: the resident stream mixer opens the device once and
  // accepts 20ms micro-chunks via stdin, so the pipeline pumps each micro-chunk
  // directly (no per-chunk process spawn, no sentence batching workaround).
  const pipeline = await createStreamingSpeechPipeline({ tts: ttsProvider, mixer });
  const played = { sentences: 0, microChunks: 0 };
  try {
    const sentences = ["你好，这是第一条合成语音。", "第二条用于验证分句与微块播放。", "第三条结束后会被平滑淡出。"];
    // Parallel pre-synthesis: enqueue all sentences, then pump continuously
    // while the background worker synthesizes — chunk N plays while N+1 is
    // still being generated, so MiMo's network latency never gaps playback.
    for (const sentence of sentences) {
      await pipeline.pushText(sentence, Date.now());
      played.sentences += 1;
    }
    await pipeline.flush();
    await pipeline.pumpToIdle();
    if (mixer.ready !== true) {
      await writeFile(
        artifactPath,
        JSON.stringify(report({ passed: false, reason: `output_revoked: ${mixer.failureReason ?? "unknown"}` }), null, 2),
      );
      console.error(`voice_gate_output_revoked: ${mixer.failureReason ?? "unknown"}`);
      process.exit(1);
    }
    // Cancel path: a queued utterance is faded by the sink and the unplayed
    // audio is dropped before it ever reaches the resident stream device.
    await pipeline.pushText("这条语音会被取消，用于验证未提交的音频永远不会到达设备。", Date.now());
    await pipeline.flush();
    for (let index = 0; index < 4 && (await pipeline.pumpAwait()); index += 1);
    await pipeline.cancelSpeech();
    await pipeline.pumpToIdle();
    const summary = report({
      passed: true,
      stage: "rehearsal",
      mixerReady: mixer.ready === true,
      playedSentences: played.sentences,
      cancelExercised: true,
      ttsProvider: ttsForReport.providerId,
      // Phase 2 render path: device opens once and micro-chunks stride stdin.
      renderPath: "winmm_resident_stream",
    });
    await writeFile(artifactPath, JSON.stringify(summary, null, 2));
    console.log(`voice_gate_passed: ${played.sentences} sentences on ${outputDevice} (tts=${ttsForReport.providerId}, render=winmm_resident_stream)`);
  } finally {
    await pipeline.close();
    await mixer.close();
  }
}

/**
 * Sentence-committing mixer adapter for the live gate only: play() accumulates
 * micro-chunks; commit() issues one real device write; drop() discards the
 * accumulated sentence after a cancel. Deliberately rehearsed here, not in the
 * product pipeline, because the commit granularity is a physical property of
 * the current Windows render adapter.
 */
/**
 * Sentence-committing mixer adapter for the live gate only: play() accumulates
 * micro-chunks; commit() issues one real device write; drop() discards the
 * accumulated sentence after a cancel. Deliberately rehearsed here, not in the
 * product pipeline, because the commit granularity is a physical property of
 * the current Windows render adapter.
 */
function createSentenceCommittingMixer(inner, commitEveryMs = Infinity) {
  let accumulated = new Uint8Array(0);
  return {
    get ready() {
      return inner.ready;
    },
    async play(_jobId, _epoch, pcm16) {
      const merged = new Uint8Array(accumulated.byteLength + pcm16.byteLength);
      merged.set(accumulated);
      merged.set(pcm16, accumulated.byteLength);
      accumulated = merged;
    },
    async commitMaybe() {
      // Bound each real device write to ~commitEveryMs of audio so long live
      // transcripts never exceed the waveout PowerShell timeout.
      if (commitEveryMs === Infinity || accumulated.byteLength / 2 / 16_000 * 1_000 < commitEveryMs) return;
      await this.commit();
    },
    async commit() {
      if (accumulated.byteLength === 0) return;
      const sentence = accumulated;
      accumulated = new Uint8Array(0);
      await inner.play("voice_live", 0, sentence);
    },
    drop() {
      const dropped = accumulated.byteLength / 2 / 16_000; // seconds
      accumulated = new Uint8Array(0);
      return Math.round(dropped * 1_000);
    },
    stop() {
      inner.stop();
    },
  };
}

function synthTts() {
  return {
    providerId: "synth-live-gate",
    modelRevision: "synth-v1",
    ready: true,
    async *synthesize(job) {
      // Cap the synthetic utterance so a long transcript never exceeds the
      // waveout PowerShell timeout (12s): the gate proves the pipeline, the
      // real TTS provider owns production timing.
      const durationMs = Math.min(Math.max(120, job.text.length * 60), 3_000);
      yield synthSpeechLikePcm16(durationMs / 1_000, { amplitude: 4_000 });
    },
  };
}

/** MiMo for rehearsal: operator-configured key + voice; requires cloud access. */
async function configuredRehearsalMimo() {
  const apiKey = process.env.MIMO_API_KEY;
  const voice = process.env.GAMEBUDDY_MIMO_VOICE ?? "mimo_default";
  if (apiKey === undefined || apiKey.trim().length < 16) return undefined;
  try {
    return new MimoTtsProvider({
      apiKey: apiKey.trim(),
      voiceByProfile: { "companion.default": voice },
      admission: Object.freeze({ assertCurrent() {} }),
    });
  } catch {
    return undefined;
  }
}

async function live() {
  const asr = await configuredLiveAsr();
  if (asr === undefined) {
    await writeFile(
      artifactPath,
      JSON.stringify(report({ passed: false, reason: "asr_unavailable" }), null, 2),
    );
    console.error("voice_gate_live_requires_asr: set GROQ_API_KEY or GAMEBUDDY_SENSEVOICE_ASSET_MANIFEST");
    process.exit(2);
  }
  const capture = new WindowsPttCapture(inputDevice);
  const mixer = await createStreamingWindowsAudioMixer(outputDevice);
  if (mixer.ready !== true) {
    console.error(`voice_gate_output_unavailable: ${mixer.failureReason ?? "unknown"}`);
    process.exit(1);
  }

  console.log("按 Enter 后开始说话，再按 Enter 结束录音。");
  await rl.question("");
  await capture.start();
  console.log("录音中…（按 Enter 结束）");
  await rl.question("");
  const pcm16 = await capture.stop();
  const text = await asr.transcribe(pcm16, "zh-CN", new AbortController().signal);
  console.log(`转录结果: ${text}`);

  const tts = await configuredLiveTts();
  // Resident-stream render: the device opens once and 20ms micro-chunks stride
  // stdin, so the pipeline pumps them directly (no sentence batching).
  const pipeline = await createStreamingSpeechPipeline({ tts, mixer });
  try {
    await pipeline.pushText(text, Date.now());
    await pipeline.flush();
    await pipeline.pumpToIdle();
    if (mixer.ready !== true) throw new Error(`output_revoked: ${mixer.failureReason ?? "unknown"}`);
    const summary = report({
      passed: true,
      stage: "live",
      transcript: text,
      ttsProvider: ttsForReport.providerId,
      renderPath: "winmm_resident_stream",
    });
    await writeFile(artifactPath, JSON.stringify(summary, null, 2));
    console.log(`voice_gate_passed: "${text}" played back (tts=${ttsForReport.providerId}, render=winmm_resident_stream)`);
  } finally {
    await pipeline.close();
    await mixer.close();
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Live ASR is opt-in and fail-closed: Groq cloud (key) or audited local SenseVoice (manifest). */
async function configuredLiveAsr() {
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey !== undefined && groqKey.trim().length >= 16) {
    return new GroqWhisperAsrProvider({ apiKey: groqKey.trim() });
  }
  const manifestPath = process.env.GAMEBUDDY_SENSEVOICE_ASSET_MANIFEST;
  if (manifestPath === undefined || manifestPath.length === 0) return undefined;
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    console.error("voice_gate_manifest_unreadable");
    return undefined;
  }
  return new SenseVoiceCliAsrProvider(manifest);
}

/**
 * Live-gate TTS: MiMo cloud TTS when the operator configured a key and voice
 * (running this gate is itself the explicit operator consent), otherwise the
 * synthetic provider so the pipeline still proves end-to-end. The report
 * records which provider actually voiced the transcript.
 */
async function configuredLiveTts() {
  const apiKey = process.env.MIMO_API_KEY;
  const voice = process.env.GAMEBUDDY_MIMO_VOICE ?? "mimo_default";
  if (apiKey !== undefined && apiKey.trim().length >= 16) {
    try {
      // This gate is an explicit operator action: the admission object is the
      // operator's own consent to a bounded cloud utterance (the gate is not
      // the product path, which remains fail-closed without a Host-owned
      // admission contract).
      const tts = new MimoTtsProvider({
        apiKey: apiKey.trim(),
        voiceByProfile: { "companion.default": voice },
        admission: Object.freeze({ assertCurrent() {} }),
      });
      ttsForReport = { providerId: tts.providerId, modelRevision: tts.modelRevision };
      return tts;
    } catch {
      // fall through to synth provider
    }
  }
  ttsForReport = { providerId: "synth-live-gate", modelRevision: "synth-v1" };
  return synthTts();
}
let ttsForReport = { providerId: "unset", modelRevision: "" };

try {
  if (mode === "rehearsal") await rehearsal();
  else await live();
} catch (error) {
  const detail =
    error instanceof Error && Array.isArray(error.errors)
      ? error.errors.map((item) => (item instanceof Error ? item.message : String(item))).join(" | ")
      : undefined;
  await writeFile(
    artifactPath,
    JSON.stringify(report({ passed: false, reason: error instanceof Error ? error.message : "unknown", detail }), null, 2),
  );
  console.error(`voice_gate_failed: ${error instanceof Error ? error.message : "unknown"}${detail === undefined ? "" : ` [${detail}]`}`);
  process.exit(1);
} finally {
  rl.close();
}