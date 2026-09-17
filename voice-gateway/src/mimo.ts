import type { SpeechJob, TtsProvider } from "./gateway.js";

export const MIMO_TTS_ENDPOINT = "https://api.xiaomimimo.com/v1/chat/completions";
export const MIMO_TTS_MODEL = "mimo-v2.5-tts";

const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SSE_BUFFER_BYTES = 512 * 1024;
const MAX_SSE_LINE_BYTES = 256 * 1024;
const MAX_SSE_DATA_BYTES = 256 * 1024;
const MAX_SSE_EVENTS = 1_024;
const MAX_AUDIO_CHUNK_BYTES = 256 * 1024;
const MAX_AUDIO_BYTES = 1_920_000;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Host-owned admission for cloud speech. Environment configuration is not
 * consent: the provider must receive a current authenticated/opaque contract
 * and revalidate it immediately before every provider request.
 */
export type MimoTtsAdmission = Readonly<{
  assertCurrent(): void;
}>;

const TEST_ENDPOINT_OVERRIDE = Symbol("mimo_test_endpoint_override");
const READY_AFTER_PROBE = Symbol("mimo_ready_after_probe");
type MimoTtsInternalOptions = MimoTtsOptions &
  Readonly<{ [TEST_ENDPOINT_OVERRIDE]?: string; [READY_AFTER_PROBE]?: true }>;

export type MimoTtsOptions = Readonly<{
  apiKey: string;
  voiceByProfile: Readonly<Record<string, string>>;
  styleByProfile?: Readonly<Record<string, string>>;
  admission?: MimoTtsAdmission;
}>;

/**
 * Explicit MiMo V2.5 streaming adapter. The key stays in caller-owned local
 * configuration. It sends only one already-visible short expression and never
 * logs headers, text, base64 audio, or full provider responses.
 */
export class MimoTtsProvider implements TtsProvider {
  public readonly providerId = "xiaomi-mimo";
  public readonly modelRevision = MIMO_TTS_MODEL;
  // Credential length and an operator-supplied voice name are not a provider
  // availability proof. The caller may set this only after a bounded,
  // credential-safe provider/profile probe; mixer readiness is independently
  // required by VoiceGatewayCore.
  public readonly ready: boolean;
  public readonly capabilities = Object.freeze({ perUtteranceDirection: true });
  #endpoint: string;
  public constructor(private readonly options: MimoTtsOptions) {
    if (options.apiKey.length < 16) throw new Error("mimo_api_key_not_configured");
    if (!isAdmission(options.admission)) throw new Error("mimo_admission_required");
    const testEndpoint = (options as MimoTtsInternalOptions)[TEST_ENDPOINT_OVERRIDE];
    if (testEndpoint === undefined) {
      if (!isFixedMimoEndpoint(MIMO_TTS_ENDPOINT)) throw new Error("mimo_endpoint_not_allowed");
      this.#endpoint = MIMO_TTS_ENDPOINT;
    } else {
      if (!isLoopbackTestEndpoint(testEndpoint)) throw new Error("mimo_test_endpoint_not_allowed");
      this.#endpoint = testEndpoint;
    }
    this.ready = (options as MimoTtsInternalOptions)[READY_AFTER_PROBE] === true;
  }

  /** Explicit test-only endpoint seam; production construction cannot override the fixed origin. */
  public static forTest(options: MimoTtsOptions, endpoint: string): MimoTtsProvider {
    if (!isLoopbackTestEndpoint(endpoint)) throw new Error("mimo_test_endpoint_not_allowed");
    return new MimoTtsProvider({ ...options, [TEST_ENDPOINT_OVERRIDE]: endpoint } as MimoTtsInternalOptions);
  }

  /** The caller may publish this instance only after its bounded output probe succeeds. */
  public markReadyAfterProbe(): MimoTtsProvider {
    this.options.admission!.assertCurrent();
    return new MimoTtsProvider({ ...this.options, [READY_AFTER_PROBE]: true } as MimoTtsInternalOptions);
  }

  public supportsVoiceProfile(voiceProfile: string): boolean {
    return (
      typeof this.options.voiceByProfile[voiceProfile] === "string" &&
      this.options.voiceByProfile[voiceProfile]!.length > 0
    );
  }

  /** Bounded non-user probe. It does not log/provider-store a player line or raw PCM. */
  public async probe(voiceProfile: string, signal: AbortSignal): Promise<void> {
    this.options.admission!.assertCurrent();
    if (!this.supportsVoiceProfile(voiceProfile)) throw new Error("mimo_voice_profile_not_configured");
    const job: SpeechJob = {
      jobId: "voice_probe",
      sessionId: "voice_probe",
      epoch: 0,
      sourceEventId: "voice_probe",
      text: "。",
      locale: "zh-CN",
      voiceProfile,
      expiresAtMs: Date.now() + 10_000,
      interruptible: true,
    };
    let bytes = 0;
    for await (const chunk of this.synthesize(job, signal)) {
      bytes += chunk.byteLength;
      if (bytes > 0) return;
    }
    throw new Error("mimo_no_audio");
  }

  public async *synthesize(job: SpeechJob, signal: AbortSignal): AsyncIterable<Uint8Array> {
    const voice = this.options.voiceByProfile[job.voiceProfile];
    if (voice === undefined) throw new Error("mimo_voice_profile_not_configured");
    const baseStyle = this.options.styleByProfile?.[job.voiceProfile];
    const style = [baseStyle, job.direction].filter((value): value is string => value !== undefined).join("\n");
    const requestBody = JSON.stringify({
      model: MIMO_TTS_MODEL,
      messages: [
        ...(style.length === 0 ? [] : [{ role: "user", content: style }]),
        { role: "assistant", content: job.text },
      ],
      audio: { format: "pcm16", voice },
      stream: true,
    });
    this.options.admission!.assertCurrent();
    const response = await fetch(this.#endpoint, {
      method: "POST",
      headers: { "api-key": this.options.apiKey, "content-type": "application/json", accept: "text/event-stream" },
      signal,
      body: requestBody,
    });
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!response.ok || response.body === null) throw new Error(`mimo_http_${response.status}`);
    if (contentType !== "text/event-stream") throw new Error("mimo_content_type_invalid");

    const decoder = new TextDecoder();
    let responseBytes = 0;
    let buffered = "";
    let completed = false;
    let sawAudio = false;
    let audioBytes = 0;
    let eventCount = 0;

    const processLine = (rawLine: string): void => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (Buffer.byteLength(data, "utf8") > MAX_SSE_DATA_BYTES) throw new Error("mimo_sse_data_too_large");
      if (Buffer.byteLength(line, "utf8") > MAX_SSE_LINE_BYTES) throw new Error("mimo_sse_line_too_large");
      eventCount += 1;
      if (eventCount > MAX_SSE_EVENTS) throw new Error("mimo_sse_event_limit");
      if (data === "[DONE]") {
        completed = true;
        return;
      }
      const payload = parseSseJson(data);
      if (providerError(payload)) throw new Error("mimo_provider_error");
      const base64 = audioData(payload);
      if (base64 === null) return;
      const pcm16 = decodeAudio(base64);
      audioBytes += pcm16.byteLength;
      if (audioBytes > MAX_AUDIO_BYTES) throw new Error("mimo_audio_limit");
      sawAudio = true;
      pendingAudio.push(pcm16);
    };
    const pendingAudio: Uint8Array[] = [];

    for await (const chunk of response.body) {
      if (signal.aborted) return;
      responseBytes += chunk.byteLength;
      if (responseBytes > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("mimo_response_limit");
      buffered += decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(buffered, "utf8") > MAX_SSE_BUFFER_BYTES) throw new Error("mimo_sse_buffer_limit");
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        processLine(line);
        while (pendingAudio.length > 0) yield pendingAudio.shift()!;
        if (completed) break;
      }
      if (completed) break;
    }
    if (!completed) {
      buffered += decoder.decode();
      if (Buffer.byteLength(buffered, "utf8") > MAX_SSE_LINE_BYTES) throw new Error("mimo_sse_line_too_large");
      if (buffered.length > 0) processLine(buffered);
      while (pendingAudio.length > 0) yield pendingAudio.shift()!;
    }
    if (!completed) throw new Error("mimo_truncated_stream");
    if (!sawAudio) throw new Error("mimo_no_audio");
  }
}

function isFixedMimoEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    return (
      parsed.protocol === "https:" &&
      parsed.origin === "https://api.xiaomimimo.com" &&
      parsed.pathname === "/v1/chat/completions" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function isAdmission(value: MimoTtsAdmission | undefined): value is MimoTtsAdmission {
  return typeof value === "object" && value !== null && typeof value.assertCurrent === "function";
}

function isLoopbackTestEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "localhost") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function parseSseJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new Error("mimo_invalid_sse_json");
  }
}
function providerError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    (value as { error?: unknown }).error !== undefined
  );
}
function audioData(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0 || typeof choices[0] !== "object" || choices[0] === null)
    return null;
  const delta = (choices[0] as { delta?: unknown }).delta;
  if (typeof delta !== "object" || delta === null) return null;
  const audio = (delta as { audio?: unknown }).audio;
  if (typeof audio !== "object" || audio === null) return null;
  const data = (audio as { data?: unknown }).data;
  return typeof data === "string" ? data : null;
}
function decodeAudio(base64: string): Uint8Array {
  if (
    base64.length > Math.ceil((MAX_AUDIO_CHUNK_BYTES * 4) / 3) + 4 ||
    base64.length % 4 !== 0 ||
    !BASE64_PATTERN.test(base64)
  )
    throw new Error("mimo_audio_chunk_invalid");
  const pcm16 = Uint8Array.from(Buffer.from(base64, "base64"));
  if (pcm16.byteLength === 0) throw new Error("mimo_empty_audio_chunk");
  if (pcm16.byteLength > MAX_AUDIO_CHUNK_BYTES || pcm16.byteLength % 2 !== 0)
    throw new Error("mimo_audio_chunk_limit");
  return pcm16;
}
