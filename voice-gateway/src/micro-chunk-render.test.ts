import { strict as assert } from "node:assert";
import test from "node:test";

import {
  applyFade,
  DEFAULT_SAMPLE_RATE,
  FADE_MS,
  MICRO_CHUNK_MS,
  MicroChunkRenderSink,
  SILENCE_MS,
} from "./micro-chunk-render.js";

const SAMPLES_PER_20MS = Math.round((DEFAULT_SAMPLE_RATE * MICRO_CHUNK_MS) / 1_000);
const SAMPLES_PER_5MS = Math.round((DEFAULT_SAMPLE_RATE * FADE_MS) / 1_000);
const SAMPLES_PER_10MS = Math.round((DEFAULT_SAMPLE_RATE * SILENCE_MS) / 1_000);
const BYTES_PER_20MS = SAMPLES_PER_20MS * 2;

function sinePcm(sampleCount: number, amplitude = 8_000): Uint8Array {
  const pcm = new Uint8Array(sampleCount * 2);
  const view = new Int16Array(pcm.buffer);
  for (let index = 0; index < sampleCount; index += 1) {
    view[index] = Math.round(
      amplitude * Math.sin((2 * Math.PI * 220 * index) / DEFAULT_SAMPLE_RATE),
    );
  }
  return pcm;
}

function pcmToSamples(pcm: Uint8Array): readonly number[] {
  const view = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  return Array.from(view);
}

function maxAbsJump(samples: readonly number[]): number {
  let max = 0;
  for (let index = 1; index < samples.length; index += 1) {
    max = Math.max(max, Math.abs(samples[index]! - samples[index - 1]!));
  }
  return max;
}

test("MicroChunkRenderSink emits 20ms micro-chunks in order, preserving PCM", async () => {
  const emitted: Uint8Array[] = [];
  const sink = new MicroChunkRenderSink((pcm) => { emitted.push(pcm); });
  const utterance = sinePcm(SAMPLES_PER_20MS * 3 + 17); // 3 full chunks + ragged tail
  await sink.play(utterance);
  assert.equal(emitted.length, 3); // tail stays buffered for the next micro-chunk
  for (const chunk of emitted) assert.equal(chunk.byteLength, BYTES_PER_20MS);
  assert.deepEqual(pcmToSamples(emitted[0]!), pcmToSamples(utterance).slice(0, SAMPLES_PER_20MS));
  assert.deepEqual(pcmToSamples(emitted[2]!), pcmToSamples(utterance).slice(2 * SAMPLES_PER_20MS, 3 * SAMPLES_PER_20MS));
});

test("MicroChunkRenderSink buffers a partial micro-chunk and flushes it on the next play", async () => {
  const emitted: Uint8Array[] = [];
  const sink = new MicroChunkRenderSink((pcm) => { emitted.push(pcm); });
  await sink.play(sinePcm(17));
  assert.equal(emitted.length, 0);
  await sink.play(sinePcm(SAMPLES_PER_20MS * 2 - 17)); // completes the first micro-chunk exactly
  assert.equal(emitted.length, 2);
  assert.equal(pcmToSamples(emitted[0]!).length, SAMPLES_PER_20MS);
});

test("MicroChunkRenderSink stop() fades the tail with raised cosine and pads silence", async () => {
  const emitted: Uint8Array[] = [];
  const sink = new MicroChunkRenderSink((pcm) => { emitted.push(pcm); }, DEFAULT_SAMPLE_RATE);
  await sink.play(sinePcm(44_000)); // 1s utterance, mostly played
  const chunkCountBeforeStop = emitted.length;
  await sink.stop();
  // One faded tail chunk plus one silence pad chunk.
  assert.equal(emitted.length, chunkCountBeforeStop + 2);

  const fadeTail = emitted[emitted.length - 2]!;
  const silencePad = emitted[emitted.length - 1]!;
  assert.equal(silencePad.byteLength, SAMPLES_PER_10MS * 2);
  assert.deepEqual(pcmToSamples(silencePad), new Array(SAMPLES_PER_10MS).fill(0));

  const tailSamples = pcmToSamples(fadeTail);
  // The buffered tail is whatever did not fill a full micro-chunk (44000 % 320
  // = 160 samples — the final 160 samples of the source utterance); the fade
  // window covers its final 5ms.
  const tailCount = 44_000 % SAMPLES_PER_20MS;
  assert.equal(tailSamples.length, tailCount);
  const fadeStart = Math.max(0, tailCount - SAMPLES_PER_5MS);
  // Identity at the fade window start (w(0)=1): the faded tail re-encodes the
  // exact same PCM as the original pre-fade sample.
  const sourceSamples = pcmToSamples(sinePcm(44_000)).slice(44_000 - tailCount);
  assert.equal(tailSamples[fadeStart], sourceSamples[fadeStart]);
  // The raised-cosine tail reaches true silence before the pad.
  assert.ok(Math.abs(tailSamples[tailSamples.length - 1]!) <= 300, "fade last sample must be near silence");
  // Every faded sample lies between the original and silence (monotone window).
  for (let index = fadeStart; index < tailSamples.length; index += 1) {
    const original = Math.abs(sourceSamples[index]!);
    const faded = Math.abs(tailSamples[index]!);
    assert.ok(faded <= original + 1, `fade sample ${index} must not exceed the original`);
  }
});

test("MicroChunkRenderSink stop() produces no audible step discontinuity", async () => {
  const emitted: Uint8Array[] = [];
  const sink = new MicroChunkRenderSink((pcm) => { emitted.push(pcm); });
  await sink.play(sinePcm(20_000));
  await sink.stop();
  const allSamples = emitted.flatMap((pcm) => pcmToSamples(pcm));
  // A sinusoidal fade-out of a 220Hz tone has no jump larger than ~2*amplitude
  // of one sample step (amplitude 8000); a step-function pop would far exceed
  // this. Amplitude 8000 * 2pi * 220/16000 = ~691 max natural step; allow 1600.
  assert.ok(maxAbsJump(allSamples) <= 1_600, `max jump ${maxAbsJump(allSamples)}`);
});

test("MicroChunkRenderSink ignores play() after stop and re-arms via reset()", async () => {
  const emitted: Uint8Array[] = [];
  const sink = new MicroChunkRenderSink((pcm) => { emitted.push(pcm); });
  await sink.play(sinePcm(SAMPLES_PER_20MS));
  assert.equal(sink.stopped, false);
  await sink.stop();
  assert.equal(sink.stopped, true);
  const before = emitted.length;
  await sink.play(sinePcm(SAMPLES_PER_20MS));
  assert.equal(emitted.length, before); // ignored
  sink.reset();
  assert.equal(sink.stopped, false);
  await sink.play(sinePcm(SAMPLES_PER_20MS));
  assert.equal(emitted.length, before + 1);
});

test("MicroChunkRenderSink rejects odd-sized PCM and invalid sample rates", () => {
  const sink = new MicroChunkRenderSink(() => undefined);
  assert.rejects(() => sink.play(new Uint8Array([0, 0, 1])), /invalid_pcm16_chunk/);
  assert.throws(() => new MicroChunkRenderSink(() => undefined, 1_000), /invalid_render_sample_rate/);
  assert.throws(() => new MicroChunkRenderSink(() => undefined, 96_000), /invalid_render_sample_rate/);
});

test("applyFade is a pure raised-cosine window: identity before fade, silence at the end", () => {
  const samples = 100;
  const pcm = sinePcm(samples, 16_000);
  const window = Array.from({ length: SAMPLES_PER_5MS }, (_, n) => 0.5 * (1 + Math.cos((Math.PI * n) / SAMPLES_PER_5MS)));
  const faded = applyFade(pcm, window, SAMPLES_PER_5MS);
  const inputSamples = pcmToSamples(pcm);
  const outputSamples = pcmToSamples(faded);
  const fadeFrom = samples - SAMPLES_PER_5MS;
  for (let index = 0; index < fadeFrom; index += 1) {
    assert.equal(outputSamples[index], inputSamples[index], `sample ${index} must pass through`);
  }
  for (let index = fadeFrom; index < samples; index += 1) {
    const weight = window[index - fadeFrom]!;
    assert.ok(Math.abs(outputSamples[index]! - inputSamples[index]! * weight) <= 1.5, `fade sample ${index}`);
  }
  assert.equal(outputSamples[samples - 1], Math.round(inputSamples[samples - 1]! * window[SAMPLES_PER_5MS - 1]!));
  assert.throws(() => applyFade(pcm, [0.5], 3), /invalid_fade_window/);
});