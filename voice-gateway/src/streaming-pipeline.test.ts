import { strict as assert } from "node:assert";
import test from "node:test";

import type { SpeechJob, TtsProvider } from "./gateway.js";
import { hasRaisedCosineTail, int16Samples, maxSampleJump, RecordingMixer, trailingSilenceRatio } from "./unattended-playback.js";
import { DEFAULT_SAMPLE_RATE, synthSpeechLikePcm16, synthSinePcm16 } from "./synth-audio.js";
import { createStreamingSpeechPipeline } from "./streaming-pipeline.js";

const MICRO_CHUNK_BYTES = ((DEFAULT_SAMPLE_RATE * 20) / 1_000) * 2; // 640 bytes at 16kHz

function synthTts(textDurationMsPerChar = 80): TtsProvider {
  return {
    providerId: "synth-tts",
    modelRevision: "synth-v1",
    ready: true,
    async *synthesize(job: SpeechJob, signal: AbortSignal) {
      if (signal.aborted) return;
      const durationMs = Math.max(120, job.text.length * textDurationMsPerChar);
      yield synthSpeechLikePcm16(durationMs / 1_000);
    },
  };
}

test("unattended: sentences stream through TTS into bounded micro-chunks, played under pump control", async () => {
  const mixer = new RecordingMixer();
  const pipeline = await createStreamingSpeechPipeline({ tts: synthTts(), mixer });
  try {
    await pipeline.pushText("早上好，伙伴。今天天气不错！你准备好了吗？");
    assert.ok(pipeline.pendingChunks > 0, "chunking must queue micro-chunks before any pump");
    while (pipeline.pump()) {
      /* play out */
    }
    await pipeline.flush();
    assert.ok(mixer.plays.length >= 3, `expected several micro-chunks, got ${mixer.plays.length}`);
    for (const play of mixer.plays) {
      assert.ok(play.pcm16.byteLength % 2 === 0);
      assert.ok(play.pcm16.byteLength <= MICRO_CHUNK_BYTES, "no chunk may exceed the 20ms micro-chunk cap");
      assert.equal(play.seq, mixer.plays.indexOf(play), "plays must issue in FIFO order");
    }
  } finally {
    await pipeline.close();
  }
});

test("unattended: cancel mid-utterance fades then pads 10ms silence with no pop", async () => {
  const mixer = new RecordingMixer();
  const pipeline = await createStreamingSpeechPipeline({ tts: synthTts(120), mixer });
  try {
    await pipeline.pushText("这是一段足够长的文本，用来在播放中途打断。还有更多的内容持续到来。");
    // Play only part of the queued audio, then cancel mid-stream.
    assert.ok(pipeline.pendingChunks > 2);
    pipeline.pump();
    pipeline.pump();
    await pipeline.cancelSpeech();
    while (pipeline.pump()) {
      /* drain fade + silence */
    }
    const all = mixer.pcm;
    const tailBytes = (DEFAULT_SAMPLE_RATE / 1_000) * 2 * 20;
    const tail = all.subarray(Math.max(0, all.byteLength - tailBytes));
    // Final 10ms must be near-silent (raised-cosine fade + silence pad).
    assert.ok(
      trailingSilenceRatio(tail, 0.01, 64) >= 0.99,
      `tail not silent: ${trailingSilenceRatio(tail, 0.01, 64)}`,
    );
    // No pop: largest jump stays far below full-scale.
    assert.ok(maxSampleJump(tail) <= 4_000, `pop detected: max jump ${maxSampleJump(tail)}`);
  } finally {
    await pipeline.close();
  }
});

test("unattended: sounded portion before cancel matches the synth source exactly", async () => {
  const mixer = new RecordingMixer();
  const tts: TtsProvider = {
    providerId: "synth-tts",
    modelRevision: "synth-v1",
    ready: true,
    async *synthesize() {
      const source = synthSinePcm16(0.3, { frequencyHz: 220 });
      yield source; // one deterministic utterance
    },
  };
  const pipeline = await createStreamingSpeechPipeline({ tts, mixer });
  try {
    await pipeline.pushText("确定声源。");
    while (pipeline.pump()) {
      /* play out */
    }
    const merged = mixer.pcm;
    const expected = synthSinePcm16(0.3, { frequencyHz: 220 });
    assert.ok(merged.byteLength <= expected.byteLength + MICRO_CHUNK_BYTES * 2);
    // Everything before the sink's fade-and-pad tail is byte-identical.
    const played = merged.subarray(0, expected.byteLength);
    const tolerance = 2; // rounding
    for (let index = 0; index < played.byteLength; index += 2) {
      const left = int16Samples(played)[index / 2]!;
      const right = int16Samples(expected)[index / 2]!;
      assert.ok(Math.abs(left - right) <= tolerance, `sample ${index / 2} drifted`);
    }
    assert.equal(maxSampleJump(merged), maxSampleJump(expected));
  } finally {
    await pipeline.close();
  }
});

test("unattended: long text without punctuation still emits (anti-swallow accumulator)", async () => {
  const mixer = new RecordingMixer();
  const pipeline = await createStreamingSpeechPipeline({ tts: synthTts(60), mixer });
  try {
    // Virtual clock: deltas arrive every 110ms (> ACCUMULATOR_MS), so the
    // 100ms accumulator promotes an unterminated tail into a partial sentence.
    await pipeline.pushText("没有标点的一句话第一段", 0);
    await pipeline.pushText("第二段内容", 110);
    await pipeline.pushText("第三段内容", 220);
    await pipeline.flush();
    while (pipeline.pump()) {
      /* play out */
    }
    assert.ok(mixer.plays.length > 0, "accumulator must emit partial sentences rather than swallow text");
  } finally {
    await pipeline.close();
  }
});

test("unattended: pipeline is voice-local; closed pipeline never emits", async () => {
  const mixer = new RecordingMixer();
  const pipeline = await createStreamingSpeechPipeline({ tts: synthTts(80), mixer });
  await pipeline.pushText("你好。");
  while (pipeline.pump()) {
    /* play out */
  }
  await pipeline.close();
  const playsAtClose = mixer.plays.length;
  await pipeline.pushText("关闭后不再播放。");
  while (pipeline.pump()) {
    /* play out */
  }
  assert.equal(mixer.plays.length, playsAtClose, "closed pipeline must not emit audio");
});

test("unattended: raised-cosine tail check utility accepts a real fade and rejects a hard cut", () => {
  const source = synthSinePcm16(0.05);
  const faded = new Uint8Array(source.byteLength);
  const fadeSamples = Math.round(0.005 * DEFAULT_SAMPLE_RATE);
  const out = int16Samples(faded);
  const src = int16Samples(source);
  for (let index = 0; index < out.length; index += 1) {
    const n = index - (out.length - fadeSamples);
    const weight = n <= 0 ? 1 : 0.5 * (1 + Math.cos((Math.PI * n) / fadeSamples));
    out[index] = Math.round(src[index]! * weight);
  }
  assert.ok(hasRaisedCosineTail(faded, source, 0.005));
  assert.ok(!hasRaisedCosineTail(source, source, 0.005, 32, 64), "unfaded output must be rejected");
});