import type { AsrProvider } from "./gateway.js";
import { pcm16ToWav } from "./sensevoice.js";

export const GROQ_WHISPER_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
export const GROQ_WHISPER_DEFAULT_MODEL = "whisper-large-v3-turbo";

/**
 * 开箱即用的 Whisper prompt 预设。prompt 只做语境引导（不注入系统指令），
 * 解决两个确定性问题：简体字输出、中英混杂时保留英文原文。
 * 外部可传自定义 prompt；未传时按 locale 回退到对应预设；环境变量
 * GAMEBUDDY_WHISPER_PROMPT 可免编译覆盖。
 */
export const WHISPER_PROMPT_PRESETS = Object.freeze({
  /** 简体中文 + 保留英文混合词（默认 zh）。 */
  ZH_SIMPLIFIED: "这是一段普通话与 English 混合的日常对话，使用简体中文记录，英文单词保留原文。",
  /** 英文默认。 */
  EN: "This is a casual English conversation. Transcribe it verbatim.",
  /** 允许外部注入游戏领域专有名词（如 Parsnip、Iridium、矿洞）。 */
  withDomainTerms(terms: readonly string[]): string {
    const joined = terms.length === 0 ? "" : `，可能包含专有名词：${terms.join("、")}`;
    return `这是一段普通话与 English 混合的日常对话${joined}。使用简体中文记录，英文单词保留原文。`;
  },
} as const);

export function promptForLocale(locale: string, explicit?: string): string | undefined {
  if (explicit !== undefined && explicit.trim().length > 0) return explicit.trim();
  const env = process.env.GAMEBUDDY_WHISPER_PROMPT;
  if (env !== undefined && env.trim().length > 0) return env.trim();
  const language = locale.split(/[-_]/)[0]?.toLowerCase();
  if (language === "zh") return WHISPER_PROMPT_PRESETS.ZH_SIMPLIFIED;
  if (language === "en") return WHISPER_PROMPT_PRESETS.EN;
  return undefined;
}

const MAX_PCM_BYTES = 25 * 1024 * 1024;
const TEST_ENDPOINT_OVERRIDE = Symbol("groq_test_endpoint_override");
type GroqWhisperInternalOptions = GroqWhisperOptions & Readonly<{ [TEST_ENDPOINT_OVERRIDE]?: string }>;

export type GroqWhisperOptions = Readonly<{
  apiKey: string;
  model?: string;
  endpoint?: string;
  /** 可选自定义 prompt；省略时按 locale 回退 WHISPER_PROMPT_PRESETS。 */
  prompt?: string;
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
  readonly #prompt: string | undefined;

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
    this.#prompt = options.prompt;
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
    // Whisper 输出字体现由模型自决；prompt 做语境引导（简体 + 保留英文），
    // 不发系统指令，≤224 tokens 界限内。
    const prompt = promptForLocale(locale, this.#prompt);
    if (prompt !== undefined) formData.append("prompt", prompt);

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
