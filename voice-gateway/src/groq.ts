import type { AsrProvider } from "./gateway.js";
import { pcm16ToWav } from "./sensevoice.js";

export const GROQ_WHISPER_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
export const GROQ_WHISPER_DEFAULT_MODEL = "whisper-large-v3-turbo";

const MAX_PCM_BYTES = 25 * 1024 * 1024;
const TEST_ENDPOINT_OVERRIDE = Symbol("groq_test_endpoint_override");
type GroqWhisperInternalOptions = GroqWhisperOptions & Readonly<{ [TEST_ENDPOINT_OVERRIDE]?: string }>;

export type GroqWhisperOptions = Readonly<{
  apiKey: string;
  model?: string;
  endpoint?: string;
}>;

/**
 * Cloud Whisper ASR provider via Groq's high-speed OpenAI-compatible REST API.
 * Transcribes 16 kHz signed 16-bit mono PCM by wrapping it in a transient WAV container.
 * Secrets, audio content, and full network responses are never logged.
 */
export class GroqWhisperAsrProvider implements AsrProvider {
  public readonly providerId = "groq-whisper";
  public readonly modelRevision: string;
  readonly #apiKey: string;
  readonly #endpoint: string;

  public constructor(options: GroqWhisperOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim().length < 16) {
      throw new Error("groq_api_key_not_configured");
    }
    this.#apiKey = options.apiKey.trim();
    this.modelRevision = options.model ?? GROQ_WHISPER_DEFAULT_MODEL;

    const testEndpoint = (options as GroqWhisperInternalOptions)[TEST_ENDPOINT_OVERRIDE];
    if (testEndpoint !== undefined) {
      if (!isLoopbackTestEndpoint(testEndpoint)) throw new Error("groq_test_endpoint_not_allowed");
      this.#endpoint = testEndpoint;
    } else {
      this.#endpoint = options.endpoint ?? GROQ_WHISPER_ENDPOINT;
    }
  }

  /** Explicit test-only endpoint seam; production construction uses the verified origin. */
  public static forTest(options: GroqWhisperOptions, endpoint: string): GroqWhisperAsrProvider {
    return new GroqWhisperAsrProvider({ ...options, [TEST_ENDPOINT_OVERRIDE]: endpoint } as GroqWhisperInternalOptions);
  }

  public async transcribe(pcm16: Uint8Array, locale: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error("asr_cancelled");
    if (pcm16.byteLength === 0 || pcm16.byteLength % 2 !== 0) throw new Error("invalid_pcm16_audio");
    if (pcm16.byteLength > MAX_PCM_BYTES) throw new Error("audio_payload_too_large");

    const wav = pcm16ToWav(pcm16);
    const blob = new Blob([Buffer.from(wav)], { type: "audio/wav" });
    const formData = new FormData();
    formData.append("file", blob, "speech.wav");
    formData.append("model", this.modelRevision);
    formData.append("response_format", "json");
    formData.append("temperature", "0");

    if (typeof locale === "string" && locale.length > 0) {
      const language = locale.split(/[-_]/)[0]?.toLowerCase();
      if (language && language.length >= 2 && language.length <= 3) {
        formData.append("language", language);
      }
    }

    let response: Response;
    try {
      response = await fetch(this.#endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
        },
        body: formData,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw new Error("asr_cancelled");
      throw new Error(`groq_network_error:${sanitizeError(error)}`);
    }

    if (!response.ok) {
      throw new Error(`groq_transcription_failed:http_${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("groq_invalid_json_response");
    }

    if (
      typeof body === "object" &&
      body !== null &&
      "text" in body &&
      typeof (body as { text: unknown }).text === "string"
    ) {
      return (body as { text: string }).text.trim();
    }
    throw new Error("groq_unexpected_response_format");
  }
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

function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 120).replace(/gsk_[A-Za-z0-9]+/g, "<redacted>");
  }
  return "unknown";
}
