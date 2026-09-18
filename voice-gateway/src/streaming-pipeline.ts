/**
 * Phase 2 Slice 2 wiring — StreamingSpeechPipeline.
 *
 * Composes the frozen policy slices into a playable downlink:
 *
 *   pushText(delta)
 *     -> StreamingSentenceChunker (Intl.Segmenter + accumulator)
 *     -> TtsProvider.synthesize per sentence (completed sentences only;
 *        accumulator partials flush on flush())
 *     -> MicroChunkRenderSink (20ms micro-chunks, raised-cosine fade)
 *     -> bounded pump() queue
 *     -> Mixer.play (one micro-chunk per pump tick)
 *
 * The mixer is driven explicitly: `pump()` advances playback by one micro-chunk
 * so tests control pacing with a virtual clock (no real device, no human
 * speaker). `cancelSpeech()` fades the sounded tail within 5ms, pads 10ms
 * silence, and discards queued-but-unplayed audio so a barge-in never sounds
 * stale text. The pipeline is voice-local: it owns no Chat or Game state, and
 * a closed pipeline never emits.
 */
import { StreamingSentenceChunker } from "./streaming-chunker.js";
import { MicroChunkRenderSink } from "./micro-chunk-render.js";
import type { Mixer, TtsProvider } from "./gateway.js";

export type StreamingSpeechPipelineOptions = Readonly<{
  tts: TtsProvider;
  mixer: Mixer;
  sampleRate?: number;
  locale?: string;
}>;

export type StreamingSpeechPipeline = Readonly<{
  /** Feed a text delta; enqueues completed sentences and returns immediately (synthesis runs in the background). */
  pushText(delta: string, nowMs?: number): Promise<void>;
  /** Flush accumulated partials through the background synthesizer; returns immediately. */
  flush(): Promise<void>;
  /** Advance playback by one 20ms micro-chunk; false when the queue is empty. */
  pump(): boolean;
  /** Like pump(), but awaits the underlying mixer write (real-device backpressure). */
  pumpAwait(): Promise<boolean>;
  /** True while sentences are still being synthesized or micro-chunks are queued. */
  readonly pendingWork: boolean;
  /** Play until every enqueued and in-flight sentence has been voiced (parallel pre-synthesis drain). */
  pumpToIdle(): Promise<void>;
  /** Fade the sounding tail (5ms raised cosine) and pad 10ms silence; drop the unplayed queue. */
  cancelSpeech(): Promise<void>;
  close(): Promise<void>;
  readonly pendingChunks: number;
}>;

export async function createStreamingSpeechPipeline(options: StreamingSpeechPipelineOptions): Promise<StreamingSpeechPipeline> {
  const sampleRate = options.sampleRate ?? 16_000;
  const chunker = new StreamingSentenceChunker(options.locale ?? "zh-CN");
  const microQueue: Uint8Array[] = [];
  const sentenceQueue: string[] = [];
  let closed = false;
  let worker: Promise<void> | undefined;
  let workerRunning = false;

  const sink = new MicroChunkRenderSink((microChunk) => {
    if (!closed && microChunk.byteLength > 0) microQueue.push(microChunk);
  }, sampleRate);

  const synthesizeSentence = async (text: string): Promise<void> => {
    const job = {
      jobId: `pipeline_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      sessionId: "pipeline",
      epoch: 0,
      sourceEventId: "pipeline",
      text,
      locale: options.locale ?? "zh-CN",
      voiceProfile: "companion.default",
      expiresAtMs: Date.now() + 60_000,
      interruptible: true,
    };
    const controller = new AbortController();
    for await (const pcm16 of options.tts.synthesize(job, controller.signal)) {
      if (closed || pcm16.byteLength === 0) continue;
      await sink.play(pcm16);
    }
  };

  const runWorker = (): void => {
    if (workerRunning || closed) return;
    workerRunning = true;
    worker = (async () => {
      while (!closed) {
        const text = sentenceQueue.shift();
        if (text === undefined) break;
        await synthesizeSentence(text);
      }
    })().finally(() => {
      workerRunning = false;
      worker = undefined;
    });
  };

  return Object.freeze({
    async pushText(delta: string, nowMs = Date.now()) {
      if (closed) return;
      for (const chunk of chunker.push(delta, nowMs)) sentenceQueue.push(chunk.text);
      runWorker();
      // Fire-and-forget: the worker synthesizes in the background while the
      // caller pumps already-queued audio (parallel pre-synthesis, Phase 2).
    },
    async flush() {
      if (closed) return;
      for (const chunk of chunker.flush()) sentenceQueue.push(chunk.text);
      runWorker();
    },
    pump(): boolean {
      if (closed) return false;
      const microChunk = microQueue.shift();
      if (microChunk === undefined) return false;
      const result = options.mixer.play("pipeline", 0, microChunk);
      if (result instanceof Promise) void result.catch(() => undefined);
      return true;
    },
    async pumpAwait(): Promise<boolean> {
      if (closed) return false;
      const microChunk = microQueue.shift();
      if (microChunk === undefined) return false;
      await options.mixer.play("pipeline", 0, microChunk);
      return true;
    },
    get pendingWork() {
      return sentenceQueue.length > 0 || workerRunning || microQueue.length > 0;
    },
    async pumpToIdle() {
      for (;;) {
        if (await this.pumpAwait()) continue;
        if (sentenceQueue.length > 0 || workerRunning) {
          // Micro-chunks are momentarily drained but synthesis is still
          // producing; yield briefly so it can enqueue the next audio.
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          continue;
        }
        return;
      }
    },
    async cancelSpeech() {
      if (closed) return;
      const unplayedStart = microQueue.length;
      // Fade the tone the sink is currently holding and pad silence. These
      // micro-chunks append to the queue; everything queued before the cancel
      // (unplayed stale audio) is then dropped.
      await sink.stop();
      microQueue.splice(0, unplayedStart);
    },
    async close() {
      if (closed) return;
      closed = true;
      sentenceQueue.length = 0;
      chunker.reset();
      await sink.stop();
      microQueue.length = 0;
    },
    get pendingChunks() {
      return microQueue.length;
    },
  });
}