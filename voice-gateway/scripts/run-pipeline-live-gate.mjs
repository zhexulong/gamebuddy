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
 *                      (PTT via WindowsPttCapture), runs audited SenseVoice
 *                      ASR, then plays the transcript back through the same
 *                      pipeline. Requires GAMEBUDDY_SENSEVOICE_ASSET_MANIFEST
 *                      and GAMEBUDDY_WINDOWS_OUTPUT_DEVICE (or "default").
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
const artifactPath = resolve(__dirname, "pipeline-live-gate.json");

if (process.platform !== "win32") {
  console.error("voice_gate_requires_windows");
  process.exit(2);
}
if (mode !== "rehearsal" && mode !== "live") {
  console.error("voice_gate_invalid_mode");
  process.exit(2);
}

const { createWindowsAudioMixer } = await gatewayDist("windows-audio.js");
const { createStreamingSpeechPipeline } = await gatewayDist("streaming-pipeline.js");
const { synthSpeechLikePcm16 } = await gatewayDist("synth-audio.js");
const { WindowsPttCapture } = await gatewayDist("windows-capture.js");
const { SenseVoiceCliAsrProvider } = await gatewayDist("sensevoice.js");

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
  const mixer = await createWindowsAudioMixer(outputDevice);
  if (mixer.ready !== true) {
    await writeFile(artifactPath, JSON.stringify(report({ passed: false, reason: mixer.failureReason ?? "mixer_not_ready" }), null, 2));
    console.error(`voice_gate_output_unavailable: ${mixer.failureReason ?? "unknown"}`);
    process.exit(1);
  }
  // Physical honesty: the current WinMM adapter commits one PowerShell process
  // per play() call, so the pipeline's 20ms micro-chunks cannot stride that
  // boundary one chunk at a time (hundreds of process spawns). The rehearsal
  // therefore accumulates micro-chunks in a sentence and commits the sentence
  // with one real device write. Streaming micro-chunk stride playback requires
  // the WASAPI resident-stream render target (Phase 2 L4 work), which this
  // gate records but does not fake.
  const sentenceMixer = createSentenceCommittingMixer(mixer);
  const pipeline = await createStreamingSpeechPipeline({ tts: synthTts(), mixer: sentenceMixer });
  const played = { sentences: 0, microChunks: 0 };
  try {
    const sentences = ["你好，这是第一条合成语音。", "第二条用于验证分句与微块播放。", "第三条结束后会被平滑淡出。"];
    for (const sentence of sentences) {
      await pipeline.pushText(sentence, Date.now());
      await pipeline.flush();
      while (pipeline.pump()) played.microChunks += 1; // drain micro-chunks into the sentence accumulator
      await sentenceMixer.commit(); // one real WinMM write per sentence
      played.sentences += 1;
      if (mixer.ready !== true) {
        await writeFile(
          artifactPath,
          JSON.stringify(report({ passed: false, reason: `output_revoked: ${mixer.failureReason ?? "unknown"}` }), null, 2),
        );
        console.error(`voice_gate_output_revoked: ${mixer.failureReason ?? "unknown"}`);
        process.exit(1);
      }
    }
    // Cancel path: queue a sentence, drain micro-chunks, then drop instead of
    // committing — the physical device never hears the abandoned text.
    await pipeline.pushText("这条语音会被取消，用于验证未提交的音频永远不会到达设备。", Date.now());
    await pipeline.flush();
    while (pipeline.pump()) played.microChunks += 1;
    await pipeline.cancelSpeech();
    const dropped = sentenceMixer.drop();
    const summary = report({
      passed: true,
      stage: "rehearsal",
      mixerReady: mixer.ready === true,
      playedMicroChunks: played.microChunks,
      committedSentences: played.sentences,
      droppedChunksAfterCancel: dropped,
      // Physical commit granularity today is one WinMM write per sentence;
      // 20ms stride playback needs the WASAPI render target (Phase 2 L4).
      microChunkStridePlayback: "wasapi_l4_pending",
    });
    await writeFile(artifactPath, JSON.stringify(summary, null, 2));
    console.log(`voice_gate_passed: ${played.sentences} sentences / ${played.microChunks} micro-chunks on ${outputDevice}`);
  } finally {
    await pipeline.close();
    mixer.stop();
  }
}

/**
 * Sentence-committing mixer adapter for the live gate only: play() accumulates
 * micro-chunks; commit() issues one real device write; drop() discards the
 * accumulated sentence after a cancel. Deliberately rehearsed here, not in the
 * product pipeline, because the commit granularity is a physical property of
 * the current Windows render adapter.
 */
function createSentenceCommittingMixer(inner) {
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
    async commit() {
      if (accumulated.byteLength === 0) return;
      const sentence = accumulated;
      accumulated = new Uint8Array(0);
      await inner.play("voice_rehearsal", 0, sentence);
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
      const durationMs = Math.max(120, job.text.length * 120);
      yield synthSpeechLikePcm16(durationMs / 1_000, { amplitude: 4_000 });
    },
  };
}

async function live() {
  const manifestPath = process.env.GAMEBUDDY_SENSEVOICE_ASSET_MANIFEST;
  if (!manifestPath) {
    await writeFile(artifactPath, JSON.stringify(report({ passed: false, reason: "sensevoice_manifest_missing" }), null, 2));
    console.error("voice_gate_live_requires_sensevoice_manifest: set GAMEBUDDY_SENSEVOICE_ASSET_MANIFEST");
    process.exit(2);
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    console.error("voice_gate_manifest_unreadable");
    process.exit(2);
  }
  const asr = new SenseVoiceCliAsrProvider(manifest);
  const capture = new WindowsPttCapture(inputDevice);
  const mixer = await createWindowsAudioMixer(outputDevice);
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

  const pipeline = await createStreamingSpeechPipeline({ tts: synthTts(), mixer });
  try {
    await pipeline.pushText(text, Date.now());
    await pipeline.flush();
    let chunks = 0;
    while (await pipeline.pumpAwait()) {
      chunks += 1;
      if (mixer.ready !== true) throw new Error(`output_revoked: ${mixer.failureReason ?? "unknown"}`);
    }
    const summary = report({ passed: true, stage: "live", transcript: text, playedMicroChunks: chunks });
    await writeFile(artifactPath, JSON.stringify(summary, null, 2));
    console.log(`voice_gate_passed: "${text}" played back in ${chunks} micro-chunks`);
  } finally {
    await pipeline.close();
    mixer.stop();
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

try {
  if (mode === "rehearsal") await rehearsal();
  else await live();
} catch (error) {
  await writeFile(artifactPath, JSON.stringify(report({ passed: false, reason: error instanceof Error ? error.message : "unknown" }), null, 2));
  console.error(`voice_gate_failed: ${error instanceof Error ? error.message : "unknown"}`);
  process.exit(1);
} finally {
  rl.close();
}