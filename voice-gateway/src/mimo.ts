import { type SpeechJob, type TtsProvider } from "./gateway.js";

export const MIMO_TTS_ENDPOINT = "https://api.xiaomimimo.com/v1/chat/completions";
export const MIMO_TTS_MODEL = "mimo-v2.5-tts";

export type MimoTtsOptions = Readonly<{ apiKey: string; voiceByProfile: Readonly<Record<string, string>>; endpoint?: string; styleByProfile?: Readonly<Record<string, string>> }>;

/**
 * Explicit MiMo V2.5 streaming adapter. The key stays in caller-owned local
 * configuration. It sends only one already-visible short expression and never
 * logs headers, text, base64 audio, or full provider responses.
 */
export class MimoTtsProvider implements TtsProvider {
  public readonly providerId = "xiaomi-mimo";
  public readonly modelRevision = MIMO_TTS_MODEL;
  readonly #endpoint: string;
  public constructor(private readonly options: MimoTtsOptions) {
    if (options.apiKey.length < 16) throw new Error("mimo_api_key_not_configured");
    this.#endpoint = options.endpoint ?? MIMO_TTS_ENDPOINT;
  }

  public async *synthesize(job: SpeechJob, signal: AbortSignal): AsyncIterable<Uint8Array> {
    const voice = this.options.voiceByProfile[job.voiceProfile];
    if (voice === undefined) throw new Error("mimo_voice_profile_not_configured");
    const style = this.options.styleByProfile?.[job.voiceProfile];
    const response = await fetch(this.#endpoint, {
      method: "POST",
      headers: { "api-key": this.options.apiKey, "content-type": "application/json", accept: "text/event-stream" },
      signal,
      body: JSON.stringify({
        model: MIMO_TTS_MODEL,
        messages: [
          ...(style === undefined ? [] : [{ role: "user", content: style }]),
          { role: "assistant", content: job.text },
        ],
        audio: { format: "pcm16", voice }, stream: true,
      }),
    });
    if (!response.ok || response.body === null) throw new Error(`mimo_http_${response.status}`);
    const decoder = new TextDecoder(); let buffered = ""; let completed = false; let sawAudio = false;
    for await (const chunk of response.body) {
      if (signal.aborted) return;
      buffered += decoder.decode(chunk, { stream: true });
      for (;;) {
        const newline = buffered.indexOf("\n"); if (newline < 0) break;
        const line = buffered.slice(0, newline).trim(); buffered = buffered.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim(); if (data === "[DONE]") { completed = true; break; }
        const payload = parseSseJson(data); const base64 = audioData(payload);
        if (base64 !== null) { const pcm16 = Uint8Array.from(Buffer.from(base64, "base64")); if (pcm16.byteLength === 0) throw new Error("mimo_empty_audio_chunk"); sawAudio = true; yield pcm16; }
        if (providerError(payload)) throw new Error("mimo_provider_error");
      }
      if (completed) break;
    }
    if (!completed) throw new Error("mimo_truncated_stream");
    if (!sawAudio) throw new Error("mimo_no_audio");
  }
}

function parseSseJson(data: string): unknown { try { return JSON.parse(data) as unknown; } catch { throw new Error("mimo_invalid_sse_json"); } }
function providerError(value: unknown): boolean {
  return typeof value === "object" && value !== null && "error" in value && (value as { error?: unknown }).error !== undefined;
}
function audioData(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0 || typeof choices[0] !== "object" || choices[0] === null) return null;
  const delta = (choices[0] as { delta?: unknown }).delta;
  if (typeof delta !== "object" || delta === null) return null;
  const audio = (delta as { audio?: unknown }).audio;
  if (typeof audio !== "object" || audio === null) return null;
  const data = (audio as { data?: unknown }).data;
  return typeof data === "string" ? data : null;
}
