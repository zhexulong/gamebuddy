import { createServer, type Server, type Socket } from "node:net";
import { type AsrProvider, type GatewayEvent, type Mixer, type PcmFormat, type SpeechJob, type TtsProvider, VoiceGatewayCore, VOICE_GATEWAY_PROTOCOL_VERSION } from "./gateway.js";

export type VoiceGatewayServerOptions = Readonly<{ /** Loopback only; other bind addresses are rejected. */ host?: "127.0.0.1" | "::1"; port: number; token: string; core?: VoiceGatewayCore; asr?: AsrProvider; tts?: TtsProvider; mixer?: Mixer }>;
export type StartedVoiceGateway = Readonly<{ port: number; close(): Promise<void> }>;
type Request =
 | { type: "hello"; token: string; protocolVersion: number; requestId: string }
 | { type: "health"; requestId: string }
 | { type: "ptt_start"; requestId: string; sessionId: string; inputId?: string; locale?: string }
 | { type: "ptt_frame"; requestId: string; pcm16Base64: string; format?: PcmFormat }
 | { type: "ptt_stop"; requestId: string; reasonCode?: string }
 | { type: "capture_cancel"; requestId: string; reasonCode?: string }
 | { type: "speech_enqueue"; requestId: string; job: SpeechJob }
 | { type: "speech_cancel"; requestId: string; jobId: string; reasonCode?: string }
 | { type: "stop_all"; requestId: string; reasonCode?: string }
 | { type: "events"; requestId: string; after?: number };
type Response = { type: "hello_ack"; requestId: string; protocolVersion: number } | { type: "health"; requestId: string; status: "ready"; protocolVersion: number } | { type: "accepted"; requestId: string; value?: string | boolean } | { type: "events"; requestId: string; events: readonly GatewayEvent[]; next: number } | { type: "error"; requestId: string | null; reasonCode: string };
const fakeAsr: AsrProvider = { providerId: "fake-asr", modelRevision: "phase0-fake-v1", async transcribe(_audio, _locale, signal) { if (signal.aborted) throw new Error("aborted"); return ""; } };
const fakeTts: TtsProvider = { providerId: "fake-tts", modelRevision: "phase0-fake-v1", async *synthesize(_job: SpeechJob, signal) { if (!signal.aborted) yield new Uint8Array([0, 0]); } };
const silentMixer: Mixer = { play() {}, stop() {} };
/** Versioned localhost-only authenticated control/media gateway. Raw frames are transient and never persisted. */
export async function startVoiceGateway(options: VoiceGatewayServerOptions): Promise<StartedVoiceGateway> {
 if (!/^[A-Za-z0-9_-]{16,256}$/.test(options.token)) throw new Error("invalid_voice_gateway_token");
 const host = options.host ?? "127.0.0.1";
 if (host !== "127.0.0.1" && host !== "::1") throw new Error("voice_gateway_loopback_required");
 if (options.core !== undefined && (options.asr !== undefined || options.tts !== undefined || options.mixer !== undefined)) throw new Error("voice_gateway_core_adapter_conflict");
 const core = options.core ?? new VoiceGatewayCore(options.asr ?? fakeAsr, options.tts ?? fakeTts, options.mixer ?? silentMixer); const server = createServer((socket) => handleSocket(socket, options.token, core));
 await new Promise<void>((resolvePromise, reject) => server.once("error", reject).listen(options.port, host, resolvePromise));
 const address = server.address(); if (address === null || typeof address === "string") throw new Error("voice_gateway_address_unavailable");
 return Object.freeze({ port: address.port, close: () => closeServer(server) });
}
function handleSocket(socket: Socket, token: string, core: VoiceGatewayCore): void {
 let authenticated = false; let buffered = ""; let processing: Promise<void> = Promise.resolve(); socket.setEncoding("utf8");
 socket.on("data", (chunk: string) => { buffered += chunk; if (buffered.length > 16_384) { socket.destroy(); return; } for (;;) { const newline = buffered.indexOf("\n"); if (newline < 0) return; const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1); const parsed = parseRequest(line); if (parsed === null) { send(socket, { type: "error", requestId: null, reasonCode: "malformed_request" }); continue; }
   // STOP/CANCEL must bypass a slow ASR/TTS request. Other media commands
   // remain ordered so frames cannot race capture start/stop.
   const dispatchNow = () => dispatch(socket, parsed, token, core, () => authenticated, () => { authenticated = true; });
   if (parsed.type === "stop_all" || parsed.type === "speech_cancel" || parsed.type === "capture_cancel") {
     void dispatchNow().catch(() => { if (!socket.destroyed) send(socket, { type: "error", requestId: parsed.requestId, reasonCode: "gateway_request_failed" }); });
   } else {
     processing = processing.then(dispatchNow).catch(() => { if (!socket.destroyed) send(socket, { type: "error", requestId: parsed.requestId, reasonCode: "gateway_request_failed" }); });
   }
 } });
}
async function dispatch(socket: Socket, request: Request, token: string, core: VoiceGatewayCore, isAuthenticated: () => boolean, authenticate: () => void): Promise<void> {
 if (request.type === "hello") { if (request.protocolVersion !== VOICE_GATEWAY_PROTOCOL_VERSION || request.token !== token) { send(socket, { type: "error", requestId: request.requestId, reasonCode: "authentication_failed" }); socket.end(); return; } authenticate(); send(socket, { type: "hello_ack", requestId: request.requestId, protocolVersion: VOICE_GATEWAY_PROTOCOL_VERSION }); return; }
 if (!isAuthenticated()) { send(socket, { type: "error", requestId: request.requestId, reasonCode: "unauthenticated" }); return; }
 try { switch (request.type) {
  case "health": send(socket, { type: "health", requestId: request.requestId, status: "ready", protocolVersion: VOICE_GATEWAY_PROTOCOL_VERSION }); return;
  case "ptt_start": send(socket, { type: "accepted", requestId: request.requestId, value: core.startPtt(request.sessionId, request.inputId, request.locale) }); return;
  case "ptt_frame": core.pushPcm(Uint8Array.from(Buffer.from(request.pcm16Base64, "base64")), request.format); send(socket, { type: "accepted", requestId: request.requestId, value: true }); return;
  case "ptt_stop": send(socket, { type: "accepted", requestId: request.requestId, value: await core.stopPtt(request.reasonCode) ?? "" }); return;
  case "capture_cancel": core.cancelCapture(request.reasonCode); send(socket, { type: "accepted", requestId: request.requestId, value: true }); return;
  case "speech_enqueue": send(socket, { type: "accepted", requestId: request.requestId, value: core.queueSpeech(request.job) }); void core.drain(); return;
  case "speech_cancel": core.cancelSpeech(request.jobId, request.reasonCode); send(socket, { type: "accepted", requestId: request.requestId, value: true }); return;
  case "stop_all": core.stopAll(request.reasonCode); send(socket, { type: "accepted", requestId: request.requestId, value: true }); return;
  case "events": { const start = Math.max(0, request.after ?? 0); send(socket, { type: "events", requestId: request.requestId, events: core.events.slice(start), next: core.events.length }); return; }
 }} catch (error) { send(socket, { type: "error", requestId: request.requestId, reasonCode: error instanceof Error ? safeReason(error.message) : "gateway_request_failed" }); }
}
function parseRequest(line: string): Request | null { try { const value: unknown = JSON.parse(line); if (typeof value !== "object" || value === null || Array.isArray(value)) return null; const candidate = value as { type?: unknown; requestId?: unknown }; return typeof candidate.type === "string" && typeof candidate.requestId === "string" && candidate.requestId.length > 0 ? value as Request : null; } catch { return null; } }
function safeReason(reason: string): string { return /^[a-z0-9_:-]{1,96}$/i.test(reason) ? reason : "gateway_request_failed"; }
function send(socket: Socket, response: Response): void { socket.write(`${JSON.stringify(response)}\n`); }
async function closeServer(server: Server): Promise<void> { await new Promise<void>((resolvePromise, reject) => server.close((error) => error === undefined ? resolvePromise() : reject(error))); }
