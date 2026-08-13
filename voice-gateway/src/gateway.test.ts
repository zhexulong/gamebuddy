import assert from "node:assert/strict";
import test from "node:test";

import { type AsrProvider, type Mixer, type SpeechJob, type TtsProvider, VoiceGatewayCore } from "./gateway.js";

const asr: AsrProvider = {
  providerId: "fake-asr",
  modelRevision: "fake-asr-v1",
  async transcribe(_pcm16, _locale, signal) {
    if (signal.aborted) throw new Error("aborted");
    return "去农场看看";
  },
};
const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
const tts: TtsProvider = {
  providerId: "fake-tts",
  modelRevision: "fake-tts-v1",
  ready: true,
  async *synthesize(_job, signal) {
    if (!signal.aborted) yield* chunks;
  },
};
function mixer(): Mixer & { played: number; stopped: number } {
  return {
    ready: true,
    played: 0,
    stopped: 0,
    play() {
      this.played++;
    },
    stop() {
      this.stopped++;
    },
  };
}
function job(epoch: number, changes: Partial<SpeechJob> = {}): SpeechJob {
  return {
    jobId: "job_01",
    sessionId: "session_01",
    epoch,
    sourceEventId: "event_01",
    text: "你好",
    locale: "zh-CN",
    voiceProfile: "companion.default",
    expiresAtMs: Date.now() + 5_000,
    interruptible: true,
    ...changes,
  };
}
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void;
  return {
    promise: new Promise<T>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: resolvePromise,
  };
}

test("fake standalone gateway makes only a final PTT transcript eligible for Host delivery", async () => {
  const output = mixer();
  const gateway = new VoiceGatewayCore(asr, tts, output);
  gateway.startPtt("session_01", "input_01");
  gateway.partial("去农");
  gateway.pushPcm(new Uint8Array([0, 1, 2, 3]));
  assert.equal(await gateway.stopPtt(), "去农场看看");
  assert.deepEqual(
    gateway.events.map((event) => event.type),
    ["capture_state", "partial_transcript", "capture_state", "final_transcript"],
  );
  assert.equal(gateway.events.at(-1)?.type, "final_transcript");
  assert.equal(
    gateway.events.some((event) => event.type === "final_transcript" && event.actualFormat.sampleRate === 16_000),
    true,
  );
});

test("speech direction is accepted only when the published capability supports it", async () => {
  const unsupportedTts: TtsProvider = { ...tts, capabilities: { perUtteranceDirection: false } };
  const unsupported = new VoiceGatewayCore(asr, unsupportedTts, mixer());
  assert.equal(unsupported.queueSpeech(job(unsupported.epoch, { direction: "warm" })), false);
  const unsupportedEvent = unsupported.events.at(-1);
  assert.equal(unsupportedEvent?.type, "speech_state");
  assert.equal(
    unsupportedEvent?.type === "speech_state" ? unsupportedEvent.reasonCode : undefined,
    "speech_direction_not_supported",
  );

  const supportedTts: TtsProvider = { ...tts, capabilities: { perUtteranceDirection: true } };
  const supported = new VoiceGatewayCore(asr, supportedTts, mixer());
  assert.equal(supported.queueSpeech(job(supported.epoch, { direction: "warm" })), true);
});

test("speech is bounded, text-safe on failure, and STOP_ALL invalidates old epochs", async () => {
  const output = mixer();
  const gateway = new VoiceGatewayCore(asr, tts, output);
  assert.equal(gateway.queueSpeech(job(gateway.epoch)), true);
  await gateway.drain();
  assert.equal(output.played, 2);
  gateway.startPtt("session_01", "input_02");
  gateway.stopAll();
  gateway.stopAll();
  assert.equal(output.stopped, 2);
  assert.equal(gateway.queueSpeech(job(0)), false);
  assert.equal(
    gateway.events.some((event) => event.type === "speech_state" && event.reasonCode === "stale_or_expired"),
    true,
  );
});

test("Fun-ASR no-speech result never produces a final transcript", async () => {
  const asr: AsrProvider = {
    providerId: "sensevoice",
    modelRevision: "test",
    transcribe: async () => {
      throw new Error("sensevoice_no_speech");
    },
  };
  const gateway = new VoiceGatewayCore(asr, tts, mixer());
  const inputId = gateway.startPtt("chat_01", "input_silence");
  gateway.pushPcm(new Uint8Array([0, 0]));
  assert.equal(await gateway.stopPtt(), null);
  assert.equal(
    gateway.events.some((event) => event.type === "final_transcript" && event.inputId === inputId),
    false,
  );
  assert.equal(
    gateway.events.some(
      (event) => event.type === "asr_failure" && event.inputId === inputId && event.reasonCode === "asr_no_speech",
    ),
    true,
  );
});

test("capture terminal emission is exactly once and input IDs cannot collide while finalizing", async () => {
  const pending = deferred<string>();
  const delayedAsr: AsrProvider = {
    providerId: "delayed-asr",
    modelRevision: "v1",
    transcribe() {
      return pending.promise;
    },
  };
  const gateway = new VoiceGatewayCore(delayedAsr, tts, mixer());
  gateway.startPtt("session_01", "input_once");
  gateway.pushPcm(new Uint8Array([1, 2]));
  const finalizing = gateway.stopPtt();
  gateway.cancelCapture("cancel_once");
  assert.throws(() => gateway.startPtt("session_02", "input_once"), /input_id_collision/);
  pending.resolve("late transcript");
  assert.equal(await finalizing, null);
  const terminal = gateway.events.filter(
    (event) =>
      event.type === "capture_state" &&
      event.inputId === "input_once" &&
      (event.state === "cancelled" || event.state === "failed"),
  );
  assert.equal(terminal.length, 1);
  assert.equal(
    gateway.events.some((event) => event.type === "final_transcript"),
    false,
  );
});

test("CancelCapture aborts in-flight ASR without delivering a final transcript", async () => {
  const pending = deferred<string>();
  let aborted = false;
  const delayedAsr: AsrProvider = {
    providerId: "delayed-asr",
    modelRevision: "v1",
    transcribe(_audio, _locale, signal) {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return pending.promise;
    },
  };
  const gateway = new VoiceGatewayCore(delayedAsr, tts, mixer());
  gateway.startPtt("session_01", "input_03");
  gateway.pushPcm(new Uint8Array([1]));
  const finalizing = gateway.stopPtt();
  gateway.cancelCapture();
  pending.resolve("late result");
  assert.equal(await finalizing, null);
  assert.equal(aborted, true);
  assert.equal(
    gateway.events.some((event) => event.type === "final_transcript"),
    false,
  );
  assert.equal(
    gateway.events.some((event) => event.type === "capture_state" && event.state === "cancelled"),
    true,
  );
});

test("speech drain has exactly one mixer owner when jobs arrive together", async () => {
  const release = deferred<void>();
  let active = 0;
  let maximum = 0;
  const slowTts: TtsProvider = {
    providerId: "slow-tts",
    modelRevision: "v1",
    async *synthesize(_job, signal) {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await release.promise;
        if (!signal.aborted) yield new Uint8Array([7]);
      } finally {
        active--;
      }
    },
  };
  const gateway = new VoiceGatewayCore(asr, { ...slowTts, ready: true }, mixer());
  gateway.queueSpeech(job(gateway.epoch, { jobId: "job_01" }));
  const first = gateway.drain();
  gateway.queueSpeech(job(gateway.epoch, { jobId: "job_02" }));
  const second = gateway.drain();
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 1);
  release.resolve();
  await first;
  assert.equal(maximum, 1);
});

test("repeated speech cancellation emits exactly one terminal cancelled state", async () => {
  const ready = deferred<void>();
  const delayedTts: TtsProvider = {
    providerId: "delayed-tts",
    modelRevision: "v1",
    async *synthesize(_job, signal) {
      await ready.promise;
      if (!signal.aborted) yield new Uint8Array([9]);
    },
  };
  const gateway = new VoiceGatewayCore(asr, { ...delayedTts, ready: true }, mixer());
  gateway.queueSpeech(job(gateway.epoch));
  const draining = gateway.drain();
  await new Promise((resolve) => setImmediate(resolve));
  gateway.stopAll("first_cancel");
  gateway.stopAll("second_cancel");
  gateway.cancelSpeech("job_01", "third_cancel");
  ready.resolve();
  await draining;
  const terminal = gateway.events.filter(
    (event) => event.type === "speech_state" && event.jobId === "job_01" && event.state === "cancelled",
  );
  assert.deepEqual(
    terminal.map((event) => (event.type === "speech_state" ? event.reasonCode : undefined)),
    ["first_cancel"],
  );
});

test("STOP_ALL promptly aborts active TTS and suppresses late audio", async () => {
  const ready = deferred<void>();
  let aborted = false;
  const delayedTts: TtsProvider = {
    providerId: "delayed-tts",
    modelRevision: "v1",
    async *synthesize(_job, signal) {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      await ready.promise;
      yield new Uint8Array([9]);
    },
  };
  const output = mixer();
  const gateway = new VoiceGatewayCore(asr, { ...delayedTts, ready: true }, output);
  gateway.queueSpeech(job(gateway.epoch));
  const draining = gateway.drain();
  await new Promise((resolve) => setImmediate(resolve));
  gateway.stopAll();
  assert.equal(aborted, true);
  assert.equal(output.stopped, 1);
  ready.resolve();
  await draining;
  assert.equal(output.played, 0);
  assert.equal(
    gateway.events.some((event) => event.type === "speech_state" && event.state === "cancelled"),
    true,
  );
});
