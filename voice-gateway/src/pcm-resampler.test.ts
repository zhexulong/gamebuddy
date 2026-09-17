import { strict as assert } from "node:assert";
import test from "node:test";

import { PCM_TARGET_SAMPLE_RATE, resamplePcm16To16k } from "./pcm-resampler.js";

test("pcm-resampler: 16k input passes through unchanged", () => {
  const pcm = new Uint8Array([0, 0, 100, 0, 200, 0, 50, 0]);
  const output = resamplePcm16To16k(pcm, 16_000);
  assert.deepEqual(output, pcm);
  assert.equal(output.buffer === pcm.buffer, false, "must return a copy, not alias the input");
});

test("pcm-resampler: 24k downsampling preserves duration and rough waveform shape", () => {
  // 1 second of 440 Hz sine at 24 kHz.
  const fromRate = 24_000;
  const samples = fromRate; // 1s
  const pcm = new Uint8Array(samples * 2);
  const view = new Int16Array(pcm.buffer);
  for (let index = 0; index < samples; index += 1) {
    view[index] = Math.round(8_000 * Math.sin((2 * Math.PI * 440 * index) / fromRate));
  }
  const output = resamplePcm16To16k(pcm, fromRate);
  const out = new Int16Array(output.buffer);
  // Duration stays ~1s at 16 kHz.
  assert.ok(Math.abs(out.length - PCM_TARGET_SAMPLE_RATE) <= 1, `length ${out.length}`);
  // Zero crossings still occur at the expected rate (440 Hz).
  let crossings = 0;
  for (let index = 1; index < out.length; index += 1) {
    if ((out[index - 1]! < 0 && out[index]! >= 0) || (out[index - 1]! >= 0 && out[index]! < 0)) crossings += 1;
  }
  assert.ok(crossings >= 850 && crossings <= 910, `zero crossings ${crossings}`);
  // Peak amplitude is preserved within interpolation tolerance.
  let peak = 0;
  for (let index = 0; index < out.length; index += 1) peak = Math.max(peak, Math.abs(out[index]!));
  assert.ok(peak >= 7_800 && peak <= 8_200, `peak ${peak}`);
});

test("pcm-resampler: constant DC amplitude is preserved exactly", () => {
  const samples = 48_000; // 2s at 24k
  const pcm = new Uint8Array(samples * 2);
  new Int16Array(pcm.buffer).fill(12_345);
  const out = new Int16Array(resamplePcm16To16k(pcm, 24_000).buffer);
  for (let index = 0; index < out.length; index += 1) {
    assert.equal(out[index], 12_345);
  }
});

test("pcm-resampler: rejects odd-sized input and invalid source rates", () => {
  assert.throws(() => resamplePcm16To16k(new Uint8Array([1, 2, 3]), 24_000), /invalid_pcm16_audio/);
  assert.throws(() => resamplePcm16To16k(new Uint8Array(0), 24_000), /invalid_pcm16_audio/);
  assert.throws(() => resamplePcm16To16k(new Uint8Array(4), 1_000), /invalid_source_sample_rate/);
});