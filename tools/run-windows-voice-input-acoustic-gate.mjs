import { WindowsPttCapture } from "../voice-gateway/dist/windows-capture.js";

const device = option("--device", "default");
const durationMs = Number(option("--duration-ms", "10_000"));
if (
  !/^default$|^wavein:[0-9]{1,4}$/.test(device) ||
  !Number.isInteger(durationMs) ||
  durationMs < 1_000 ||
  durationMs > 30_000
) {
  throw new Error("invalid_windows_input_acoustic_gate_options");
}

const capture = new WindowsPttCapture(device);
try {
  await capture.start(durationMs);
  await delay(durationMs);
  const pcm16 = await capture.stop();
  console.log(
    JSON.stringify(
      {
        state: "passed",
        gate: "windows_ptt_acoustic_integrity",
        selection: device,
        resolvedDevice: capture.lastResolvedDevice ?? null,
        format: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" },
        acoustic: summarizePcm16(pcm16),
      },
      null,
      2,
    ),
  );
} finally {
  await capture.cancel();
}

/**
 * Reports only coarse acoustic integrity metadata. It never emits, hashes,
 * persists, compares, or transcribes user audio. PCM stays in memory and is
 * released when this process exits.
 */
function summarizePcm16(pcm16) {
  const samples = pcm16.byteLength / 2;
  let sumSquares = 0;
  let peak = 0;
  let clippedSamples = 0;
  let nonSilentWindows = 0;
  let firstActiveWindow = null;
  let lastActiveWindow = null;
  const windowSamples = 1_600; // 100 ms at 16 kHz
  const activeThreshold = 240; // deliberately coarse; not a speech/VAD classifier
  for (let start = 0, window = 0; start < samples; start += windowSamples, window++) {
    const end = Math.min(samples, start + windowSamples);
    let windowPeak = 0;
    for (let index = start; index < end; index++) {
      const sample = pcm16[index * 2] | (pcm16[index * 2 + 1] << 8);
      const signed = sample & 0x8000 ? sample - 0x1_0000 : sample;
      const magnitude = Math.abs(signed);
      sumSquares += signed * signed;
      if (magnitude > peak) peak = magnitude;
      if (magnitude >= 32_700) clippedSamples++;
      if (magnitude > windowPeak) windowPeak = magnitude;
    }
    if (windowPeak >= activeThreshold) {
      nonSilentWindows++;
      if (firstActiveWindow === null) firstActiveWindow = window;
      lastActiveWindow = window;
    }
  }
  return {
    pcm16Bytes: pcm16.byteLength,
    durationMs: Math.round((samples * 1000) / 16_000),
    rmsDbfs: dbfs(Math.sqrt(sumSquares / Math.max(samples, 1))),
    peakDbfs: dbfs(peak),
    clippedSamplePermille: Math.round((clippedSamples * 1000) / Math.max(samples, 1)),
    activeWindowCount: nonSilentWindows,
    firstActiveMs: firstActiveWindow === null ? null : firstActiveWindow * 100,
    lastActiveMs: lastActiveWindow === null ? null : lastActiveWindow * 100,
  };
}
function dbfs(amplitude) {
  return amplitude <= 0 ? null : Math.round(Math.max(-120, 20 * Math.log10(amplitude / 32_768)) * 10) / 10;
}
function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0
    ? fallback
    : (process.argv[index + 1] ??
        (() => {
          throw new Error(`missing_${name.slice(2)}`);
        })());
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
