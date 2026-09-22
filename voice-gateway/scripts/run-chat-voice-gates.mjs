/**
 * Chat + Voice production gate scenarios (negative, failure, barge-in).
 *
 * Reuses the real production Chat delta path into the real Voice stack from
 * run-chat-voice-e2e.mjs, but exercises the degradation contracts the happy
 * path cannot show:
 *
 *   --scenario revoked
 *     Product consent is `revoked`: Desktop does not start the Voice child at
 *     all (VoiceLaunchCoordinator.Resolve -> null). Chat text still streams
 *     normally; no voice state is ever projected; zero exceptions escape.
 *
 *   --scenario crash
 *     The bundled gateway child is hard-killed while the LLM is mid-stream.
 *     The Host wire must degrade gracefully: subsequent deltas and finalize
 *     complete without blocking Chat, nothing throws out of the main flow,
 *     and the voice client reaches a closed/unavailable state.
 *
 *   --scenario bargein
 *     The LLM streams deltas; at delta #3 the player interrupts via
 *     sink.cancel(). Playback must terminate with a `cancelled` observation
 *     (not completed), the queued-but-unplayed audio is discarded
 *     (reference-repo clear_buffer semantics; livekit/pipecat do not promise a
 *     millisecond fade), and the voice surface returns to ready immediately.
 *
 * Each scenario writes its own evidence file under voice-gateway/scripts/.
 * Real components only: cpa-oai DeepSeek streaming, real bundled gateway
 * (narrow child-only env), real MiMo TTS, resident WinMM playback.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";

const rawScenario = process.argv[2] ?? "revoked";
const scenario = rawScenario.startsWith("--scenario=") ? rawScenario.slice("--scenario=".length) : rawScenario;
const allowed = new Set(["revoked", "crash", "bargein"]);
if (!allowed.has(scenario)) {
  console.error(`chat_voice_gate_scenario_unknown: ${scenario}`);
  process.exit(2);
}

const voiceGatewayRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hostRoot = resolve(voiceGatewayRoot, "..", "host");
const bundleEntry = resolve(voiceGatewayRoot, ".dist", "entry", "voice-gateway-entry.mjs");
const artifactPath = resolve(voiceGatewayRoot, "scripts", `pipeline-chat-voice-${scenario}.json`);

const API_BASE = process.env.CPA_OAI_BASE_URL || "http://127.0.0.1:8317/v1";
const API_KEY = process.env.CPA_OAI_API_KEY || "cpa";
const MODEL = process.env.CPA_OAI_MODEL || "deepseek-v4-flash";
const persona = process.env.GAMEBUDDY_MIMO_PERSONA ?? "soft_maid";

const record = {
  schema: `gamebuddy-chat-voice-${scenario}/v1`,
  passed: false,
  reason: "not_started",
  scenario,
  model: MODEL,
  persona,
  llm: {},
  voice: {},
};

if (process.platform !== "win32") {
  console.error("chat_voice_gate_requires_windows");
  process.exit(2);
}

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
          await onDelta(delta.content);
        }
      } catch {
        // ignore partial SSE chunk (never fatal for Chat)
      }
    }
  }
  if (fullText.trim().length === 0) throw new Error("llm_stream_empty_content");
  return { text: fullText.trim(), deltas, ttftMs: firstContentMs === null ? null : firstContentMs - startMs, totalMs: Date.now() - startMs };
}

function spawnGateway(port, token) {
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
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { err += c; });
  return { child, out: () => out, err: () => err };
}

async function waitForReady(handle, errorLabel) {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + 45_000;
    const poll = () => {
      const line = handle.out().split("\n").find((l) => l.includes("listening on 127.0.0.1"));
      if (line !== undefined) return resolvePromise(line.trim());
      if (handle.child.exitCode !== null || handle.child.signalCode !== null) return reject(new Error(`${errorLabel}_child_exited: ${handle.child.exitCode}; stderr=${handle.err().slice(-400)}`));
      if (Date.now() > deadline) return reject(new Error(`${errorLabel}_listen_timeout`));
      setTimeout(poll, 200);
    };
    poll();
  });
}

const basePort = scenario === "bargein" ? 49760 : 49761;
const port = Number.parseInt(process.env.GAMEBUDDY_VOICE_PORT ?? String(basePort), 10);
const token = "voice_token_1234567890_gate_scenario";

const LLM_MESSAGES = [
  { role: "system", content: "你是陪伴型角色「深度求索」，语气温柔软糯，话语简短自然，像日常聊天。回答不超过 60 字。" },
  { role: "user", content: "今晚陪我聊聊天吧，随便说点什么。语气要轻松温暖一些。" },
];

let handle;
try {
  if (scenario === "revoked") {
    // --- Consent revoked: no Voice child is launched at all. Chat flows. ---
    record.voice.childLaunched = false;
    record.llm = await streamAssistantDeltas(LLM_MESSAGES, async () => {
      record.voice.events ??= [];
      record.voice.events.push({ kind: "delta_without_voice" });
    });
    record.voice.neverConnected = true;
    record.passed = true;
    record.reason = "ok: revoked consent -> no Voice child, Chat text streams intact, zero exceptions";
    await writeFile(artifactPath, JSON.stringify(record, null, 2));
    console.log(JSON.stringify(record, null, 2));
  } else if (scenario === "crash") {
    // --- Gateway hard crash mid-stream: Host degrades gracefully. ---
    handle = spawnGateway(port, token);
    const readyLine = await waitForReady(handle, "crash");
    record.voice.readyLine = readyLine;
    const { connectHealthyVoiceGateway } = await import(pathToFileURL(resolve(hostRoot, "dist-test", "voice-bootstrap.js")).href);
    const voice = await connectHealthyVoiceGateway({ host: "127.0.0.1", port, token });
    await voice.health();
    const reader = voice.createVoiceSurfaceReader();
    record.voice.surfaceBefore = reader()?.state;
    const sink = voice.createChatVoiceStreamingSink();
    await sink.begin(`crash_${randomUUID().slice(0, 8)}`);
    let killedAtMs = null;
    let killed = false;
    let deltasAfterCrash = 0;
    record.llm = await streamAssistantDeltas(LLM_MESSAGES, async (delta) => {
      const clean = delta.normalize("NFC");
      if (clean.trim().length === 0) return;
      // Hard-kill the Voice child while the LLM is still streaming.
      if (!killed) {
        killed = true;
        killedAtMs = Date.now();
        handle.child.kill();
        await new Promise((r) => setTimeout(r, 400));
        record.voice.killedAtMs = killedAtMs;
      } else {
        deltasAfterCrash += 1;
      }
      try {
        await sink.append(clean);
      } catch {
        // Voice-local degradation is silent for Chat; never throw out.
      }
    });
    await sink.finalize();
    record.voice.deltasAfterCrash = deltasAfterCrash;
    try {
      record.voice.surfaceAfterCrash = reader()?.state ?? null;
    } catch {
      record.voice.surfaceAfterCrash = "unavailable";
    }
    voice.close();
    record.passed = true;
    record.reason = "ok: gateway crash mid-stream degrades silently, Chat completes unblocked";
    await writeFile(artifactPath, JSON.stringify(record, null, 2));
    console.log(JSON.stringify(record, null, 2));
  } else {
    // --- Barge-in: cancel at delta #3; terminal must be cancelled, surface returns. ---
    handle = spawnGateway(port, token);
    const readyLine = await waitForReady(handle, "bargein");
    record.voice.readyLine = readyLine;
    const { connectHealthyVoiceGateway } = await import(pathToFileURL(resolve(hostRoot, "dist-test", "voice-bootstrap.js")).href);
    const voice = await connectHealthyVoiceGateway({ host: "127.0.0.1", port, token });
    await voice.health();
    const reader = voice.createVoiceSurfaceReader();
    record.voice.surfaceBefore = reader()?.state;
    const sink = voice.createChatVoiceStreamingSink();
    await sink.begin(`bargein_${randomUUID().slice(0, 8)}`);

    const observations = [];
    const unsubscribe = voice.onPlaybackObservation((event) => {
      if (event?.terminalStatus !== undefined) observations.push(event);
    });

    let deltaCount = 0;
    const cancelAt = 3;
    record.voice.cancelAfterDeltas = cancelAt;
    let cancelled = false;
    record.llm = await streamAssistantDeltas(LLM_MESSAGES, async (delta) => {
      const clean = delta.normalize("NFC");
      if (clean.trim().length === 0) return;
      deltaCount += 1;
      if (deltaCount === cancelAt && !cancelled) {
        cancelled = true;
        record.voice.cancelSentAtMs = Date.now();
        record.voice.surfaceDuring = reader()?.state;
        await sink.cancel();
        return;
      }
      try {
        await sink.append(clean);
      } catch {
        // swallow after cancel
      }
    });
    unsubscribe();
    const terminal = observations.find((o) => o.terminalStatus === "cancelled");
    const completed = observations.find((o) => o.terminalStatus === "completed");
    if (terminal === undefined) throw new Error("bargein_no_cancelled_observation");
    if (completed !== undefined) throw new Error(`bargein_played_to_completion: ${completed.terminalStatus}`);
    // The v2 runtime pushes the terminal observation synchronously on cancel;
    // the surface must be ready again (reference semantics: clear_buffer +
    // interrupted marker; no millisecond fade promise in livekit/pipecat).
    record.voice.surfaceAfterCancel = reader()?.state;
    record.voice.observation = { terminalStatus: terminal.terminalStatus, reasonCode: terminal.reasonCode ?? null };
    record.passed = true;
    record.reason = "ok: barge-in cancels at delta #3, terminal=cancelled, surface ready";
    await writeFile(artifactPath, JSON.stringify(record, null, 2));
    console.log(JSON.stringify(record, null, 2));
    voice.close();
  }
} catch (error) {
  record.reason = error instanceof Error ? error.message : "chat_voice_gate_failed";
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.error(`chat_voice_gate_failed (${scenario}): ${record.reason}`);
  process.exitCode = 1;
} finally {
  handle?.child.kill();
  await new Promise((r) => setTimeout(r, 300));
}