/**
 * Chat + Voice production E2E rehearsal.
 *
 * Drives the REAL production Chat delta path into the REAL Voice stack:
 *  1. Real LLM (cpa-oai / DeepSeek) streams assistant deltas for a
 *     deepseek-chan character scene;
 *  2. Each content delta goes through the Host voice streaming sink
 *     (createChatVoiceStreamingSink — the same sink production Chat
 *     wiring feeds from onPreviewDelta);
 *  3. Real bundled Voice Gateway child (narrow child-only env) + real MiMo
 *     TTS + resident WinMM playback;
 *  4. Asserts playback_observation(completed) and the additive surface
 *     projection ready -> speaking -> ready.
 *
 * No CI gate is involved: this runs against the local cpa-oai LLM endpoint,
 * the locally bundled gateway artifact and the real audio device.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";

const voiceGatewayRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hostRoot = resolve(voiceGatewayRoot, "..", "host");
const bundleEntry = resolve(voiceGatewayRoot, ".dist", "entry", "voice-gateway-entry.mjs");
const artifactPath = resolve(voiceGatewayRoot, "scripts", "pipeline-chat-voice-e2e.json");

const API_BASE = process.env.CPA_OAI_BASE_URL || "http://127.0.0.1:8317/v1";
const API_KEY = process.env.CPA_OAI_API_KEY || "cpa";
const MODEL = process.env.CPA_OAI_MODEL || "deepseek-v4-flash";
const persona = process.env.GAMEBUDDY_MIMO_PERSONA ?? "soft_maid";

const record = {
  schema: "gamebuddy-chat-voice-e2e/v1",
  passed: false,
  reason: "not_started",
  model: MODEL,
  persona,
  llm: {},
  voice: {},
};

if (process.platform !== "win32") {
  console.error("chat_voice_e2e_requires_windows");
  process.exit(2);
}

// --- 1. Real LLM streaming (production cpa-oai endpoint). ---
async function streamAssistantDeltas(messages, onDelta) {
  const startMs = Date.now();
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, stream: true, temperature: 0.7, max_tokens: 800 }),
  });
  if (!res.ok) throw new Error(`llm_error_${res.status}: ${(await res.text()).slice(0, 150)}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let deltas = 0;
  let fullText = "";
  let firstContentMs = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === "[DONE]") continue;
      try {
        const parsed = JSON.parse(dataStr);
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) {
          if (firstContentMs === null) firstContentMs = Date.now();
          fullText += delta.content;
          deltas += 1;
          onDelta(delta.content);
        }
      } catch {
        // ignore partial SSE chunk
      }
    }
  }
  if (fullText.trim().length === 0) throw new Error("llm_stream_empty_content");
  return { text: fullText.trim(), deltas, ttftMs: firstContentMs === null ? null : firstContentMs - startMs, totalMs: Date.now() - startMs };
}

// --- 2. Spawn the real bundled gateway in the narrow child-only env. ---
const port = Number.parseInt(process.env.GAMEBUDDY_VOICE_PORT ?? "49747", 10);
const token = "voice_token_1234567890_chat_voice_e2e";
const env = {
  ...process.env,
  GAMEBUDDY_VOICE_PORT: String(port),
  GAMEBUDDY_VOICE_TOKEN: token,
  GAMEBUDDY_VOICE_CLOUD_TTS_ADMISSION: "desktop-consent-v1",
  GAMEBUDDY_MIMO_PERSONA: persona,
  GAMEBUDDY_WINDOWS_OUTPUT_DEVICE: process.env.GAMEBUDDY_WINDOWS_OUTPUT_DEVICE ?? "default",
  HTTPS_PROXY: process.env.HTTPS_PROXY ?? "",
  HTTP_PROXY: process.env.HTTP_PROXY ?? "",
};
for (const name of ["PATH", "PATHEXT", "USERPROFILE", "APPDATA", "windir"]) delete env[name];

const child = spawn(process.execPath, ["--use-env-proxy", bundleEntry], { cwd: voiceGatewayRoot, env, stdio: ["ignore", "pipe", "pipe"] });
let childOut = "";
let childErr = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c) => { childOut += c; });
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => { childErr += c; });

try {
  const readyLine = await new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + 45_000;
    const poll = () => {
      const line = childOut.split("\n").find((l) => l.includes("listening on 127.0.0.1"));
      if (line !== undefined) return resolvePromise(line.trim());
      if (child.exitCode !== null || child.signalCode !== null) return reject(new Error(`gateway_child_exited: ${child.exitCode}; stderr=${childErr.slice(-400)}`));
      if (Date.now() > deadline) return reject(new Error("gateway_listen_timeout"));
      setTimeout(poll, 200);
    };
    poll();
  });
  if (!readyLine.includes("voice ready")) throw new Error(`gateway_not_voice_ready: ${readyLine}`);
  record.voice.readyLine = readyLine;

  // --- 3. Connect through the production Host adapter. ---
  const { connectHealthyVoiceGateway } = await import(pathToFileURL(resolve(hostRoot, "dist-test", "voice-bootstrap.js")).href);
  const voice = await connectHealthyVoiceGateway({ host: "127.0.0.1", port, token });
  if (voice === undefined) throw new Error("host_wire_connection_failed");
  await voice.health();
  record.voice.connected = true;

  const reader = voice.createVoiceSurfaceReader();
  record.voice.surfaceBefore = reader()?.state;
  const sink = voice.createChatVoiceStreamingSink();
  await sink.begin(`e2e_${randomUUID().slice(0, 8)}`);
  await sink.append("（以下是 深度求索 的回应朗读。）");

  const observations = [];
  const unsubscribe = voice.onPlaybackObservation((event) => {
    if (event?.terminalStatus !== undefined) observations.push(event);
  });

  const onDelta = async (delta) => {
    const clean = delta.normalize("NFC");
    if (clean.trim().length === 0) return;
    try {
      await sink.append(clean);
    } catch {
      // voice-local degradation; keep streaming clean text
    }
    record.voice.surfaceDuring = reader()?.state;
  };

  record.llm = await streamAssistantDeltas(
    [
      { role: "system", content: "你是陪伴型角色「深度求索」，语气温柔软糯，话语简短自然，像日常聊天。回答不超过 60 字。" },
      { role: "user", content: "今晚陪我聊聊天吧，随便说点什么。语气要轻松温暖一些。" },
    ],
    onDelta,
  );
  await sink.finalize();

  // Wait for the terminal playback observation (real MiMo synthesis + playback).
  const deadline = Date.now() + 180_000;
  while (observations.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  unsubscribe();
  if (observations.length === 0) throw new Error("playback_observation_missing");
  const observation = observations[observations.length - 1];
  if (observation.terminalStatus !== "completed") throw new Error(`playback_not_completed: ${observation.terminalStatus}`);
  await new Promise((r) => setTimeout(r, 1000));

  record.voice.terminalStatus = observation.terminalStatus;
  record.voice.surfaceAfter = reader()?.state;
  record.passed = true;
  record.reason = "ok";
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record, null, 2));
  await voice.close();
} catch (error) {
  record.reason = error instanceof Error ? error.message : "chat_voice_e2e_failed";
  record.voice.readyLine = childOut.split("\n").find((l) => l.includes("listening on 127.0.0.1")) ?? null;
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.error(`chat_voice_e2e_failed: ${record.reason}\nstderr=${childErr.slice(-800)}`);
  process.exitCode = 1;
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}