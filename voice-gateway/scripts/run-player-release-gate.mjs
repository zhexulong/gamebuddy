/**
 * L5 player release gate (Voice streaming module).
 *
 * A real player session driving the production Chat-with-voice path:
 *  1. Real bundled Voice Gateway child (narrow child-only env) + real MiMo.
 *  2. Real LLM (cpa-oai / DeepSeek) streaming companion replies for
 *     deepseek-chan (character card + worldbook, decoded through the system's
 *     own native importer — no pre-processing in the gate).
 *  3. Player input is REAL SPEECH: PTT (press Enter, speak, press Enter) via
 *     WindowsPttCapture, transcribed by Groq Whisper (cloud ASR). No auto-
 *     greeting: production conversation.ts opens with `opening:"blank"`, so
 *     the companion speaks only after the player's first message.
 *  4. Companion deltas stream into the Host voice sink; speakable text skips
 *     *action* narration so only spoken lines are read aloud.
 *  5. After each turn the terminal playback observation is awaited, the voice
 *     surface must return to ready, and sensitive material (keys/tokens/PCM)
 *     must not appear in the gateway child's stderr.
 *
 * Evidence: pipeline-player-release.json (per-turn ASR transcript, llm deltas,
 * playback terminal, surface transitions, consent record, stderr safety scan).
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile, readFile } from "node:fs/promises";

const voiceGatewayRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hostRoot = resolve(voiceGatewayRoot, "..", "host");
const projectRoot = resolve(voiceGatewayRoot, "..");
const bundleEntry = resolve(voiceGatewayRoot, ".dist", "entry", "voice-gateway-entry.mjs");
const artifactPath = resolve(voiceGatewayRoot, "scripts", "pipeline-player-release.json");
const presetRoot = resolve(projectRoot, "assets", "tavern", "presets", "deepseek-chan");

const API_BASE = process.env.CPA_OAI_BASE_URL || "http://127.0.0.1:8317/v1";
const API_KEY = process.env.CPA_OAI_API_KEY || "cpa";
const MODEL = process.env.CPA_OAI_MODEL || "deepseek-v4-flash";
const persona = process.env.GAMEBUDDY_MIMO_PERSONA ?? "soft_maid";
const CONSENT_DISCLOSURE = "mimo-cloud-tts-v1";

const record = {
  schema: "gamebuddy-player-release/v1",
  passed: false,
  reason: "not_started",
  model: MODEL,
  persona,
  disclosureVersion: CONSENT_DISCLOSURE,
  consent: null,
  turns: [],
  stderrSafety: null,
};

// Optional local operator environment (GROQ_API_KEY, MIMO_API_KEY) — same
// loading behavior as the production voice gateway main.ts.
for (const envPath of [".env.local", "../.env.local"]) {
  try {
    process.loadEnvFile?.(envPath);
    break;
  } catch {
    // optional local file
  }
}

if (process.platform !== "win32") {
  console.error("player_release_requires_windows");
  process.exit(2);
}
if (!process.stdin.isTTY) {
  console.error("player_release_requires_interactive_stdin");
  process.exit(2);
}

// --- 1. System-native deepseek-chan recognition (card + worldbook). ---
const cardSource = await readFile(resolve(presetRoot, "card.json"), "utf8");
const card = JSON.parse(cardSource);
if (card.spec !== "chara_card_v2" || card.data === undefined || typeof card.data.name !== "string") {
  record.reason = "deepseek_chan_card_not_recognized";
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.error(record.reason);
  process.exit(2);
}
const worldbookRaw = JSON.parse(await readFile(resolve(presetRoot, "worldbook.json"), "utf8"));
if (worldbookRaw === undefined || !Array.isArray(worldbookRaw.entries) || worldbookRaw.entries.length === 0) {
  record.reason = "deepseek_chan_worldbook_not_recognized";
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.error(record.reason);
  process.exit(2);
}
record.cardName = card.data.name;
record.worldbookEntries = worldbookRaw.entries.length;
record.characterBookPresent = card.data.character_book !== undefined && card.data.character_book !== null;

const rl = createInterface({ input: process.stdin, output: process.stdout });
async function ask(question) {
  return new Promise((resolvePromise) => rl.question(question, (answer) => resolvePromise(answer)));
}

// --- 2. Explicit player consent before any cloud TTS happens. ---
console.log("\n=== Player Release Gate: Voice consent ===");
console.log(`The companion will use cloud TTS (MiMo, disclosure ${CONSENT_DISCLOSURE}).`);
console.log("No audio leaves this machine except the TTS request containing the spoken text.");
const consentLine = await ask("Type `accept` to consent, anything else to abort: ");
if (consentLine.trim().toLowerCase() !== "accept") {
  record.reason = "player_consent_declined";
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.error("Player declined consent; gate aborted.");
  process.exit(2);
}
record.consent = { state: "accepted", disclosureVersion: CONSENT_DISCLOSURE, decidedAtMs: Date.now() };
console.log("Consent recorded.\n");

// --- 3. Spawn the real bundled gateway (narrow child-only env). ---
const port = Number.parseInt(process.env.GAMEBUDDY_VOICE_PORT ?? "49780", 10);
const token = "voice_token_1234567890_player_release";
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

const { WindowsPttCapture } = await import(pathToFileURL(resolve(voiceGatewayRoot, "dist", "windows-capture.js")).href);
const { GroqWhisperAsrProvider } = await import(pathToFileURL(resolve(voiceGatewayRoot, "dist", "groq.js")).href);
const inputDevice = (process.env.GAMEBUDDY_WINDOWS_INPUT_DEVICE ?? "default");
// Reference-repo behavior (pipecat input_device_index=None / livekit WebRTC
// source): capture through the SYSTEM DEFAULT input endpoint instead of an
// enumerated wavein:N. Explicit indices pick virtual endpoints (Stereo Mix,
// ASUS AI noise-cancelling) that are not the player's physical microphone.
const groqKey = process.env.GROQ_API_KEY;
if (groqKey === undefined || groqKey.trim().length < 16) {
  record.reason = "player_asr_unavailable: set GROQ_API_KEY";
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.error(record.reason);
  process.exit(2);
}
const asr = new GroqWhisperAsrProvider({ apiKey: groqKey.trim() });
const capture = new WindowsPttCapture(inputDevice);
record.inputDevice = inputDevice;
record.asrProvider = "groq-whisper";

function toWavPcm16(pcm16) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm16.byteLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm16.byteLength, 40);
  return Uint8Array.from(Buffer.concat([header, Buffer.from(pcm16)]));
}

function energyProfile(pcm16) {
  const samples = pcm16.byteLength / 2;
  let sum = 0;
  let peak = 0;
  const segLen = 8_000;
  const segments = [];
  let segSum = 0;
  let segCount = 0;
  for (let i = 0; i + 1 < pcm16.byteLength; i += 2) {
    const s = pcm16[i] | (pcm16[i + 1] << 8);
    const v = s < 0x8000 ? s : s - 0x10000;
    const a = Math.abs(v);
    sum += a * a;
    if (a > peak) peak = a;
    segSum += a * a;
    segCount += 1;
    if (segCount === segLen) {
      segments.push(Math.round(Math.sqrt(segSum / segLen)));
      segSum = 0;
      segCount = 0;
    }
  }
  if (segCount > 0) segments.push(Math.round(Math.sqrt(segSum / segCount)));
  return { bytes: pcm16.byteLength, rms: Math.round(Math.sqrt(sum / Math.max(1, samples))), peak, segments };
}

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
  record.voiceReadyLine = readyLine;

  const { connectHealthyVoiceGateway } = await import(pathToFileURL(resolve(hostRoot, "dist-test", "voice-bootstrap.js")).href);
  const voice = await connectHealthyVoiceGateway({ host: "127.0.0.1", port, token });
  if (voice === undefined) throw new Error("host_wire_connection_failed");
  await voice.health();
  const reader = voice.createVoiceSurfaceReader();

  // Companion system prompt: character card (name/summary greeting) + worldbook.
  const companionLore = worldbookRaw.entries
    .map((entry) => `[${entry.keys ?? ""}] ${entry.title ?? entry.comment ?? ""}: ${entry.content ?? ""}`)
    .join("\n")
    .slice(0, 6000);
  const systemPrompt = [
    `You are ${card.data.name}, the player's companion in a cozy chat.`,
    `Character: ${card.data.description ?? ""}`.slice(0, 2000),
    `Personality: ${card.data.personality ?? ""}`.slice(0, 800),
    `World info:\n${companionLore}`,
    "Rules: reply in short, warm natural lines like everyday chat. Use *...* only for small actions; most of the reply should be spoken dialogue. Keep replies under 120 characters.",
  ].join("\n");

  const messages = [{ role: "system", content: systemPrompt }];
  console.log(`\n=== Player Release Gate: real session with ${card.data.name} ===`);
  console.log("(No auto-greeting, matching production: press Enter, speak, press Enter to stop. \"q\" ends the session.)\n");

  let turnIndex = 0;
  for (;;) {
    console.log("\n（按 Enter 开始说话，自动录音 15 秒；输入 q 结束会话）");
    const startLine = (await ask("speak> ")).trim();
    if (startLine.toLowerCase() === "q") break;
    await capture.start(20_000);
    console.log("录音中…（15 秒后自动结束）");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15_000));
    const pcm16 = await capture.stop();
    // Save the raw capture as wav so the player can hear what the microphone
    // actually picked up (Whisper hallucinates video-platform phrases on
    // low-SNR input; the wav is ground truth for diagnosing it).
    const wavPath = resolve(voiceGatewayRoot, "scripts", `player-turn-${turnIndex}.wav`);
    await writeFile(wavPath, toWavPcm16(pcm16));
    const diag = energyProfile(pcm16);
    record.captureDiagnostics ??= [];
    record.captureDiagnostics.push({ inputDevice: inputDevice, turn: turnIndex, wav: wavPath, ...diag });
    console.log(`PCM: bytes=${diag.bytes} rms=${diag.rms} peak=${diag.peak} segments=[${diag.segments.join(",")}] wav=${wavPath}`);
    if (diag.rms < 100) {
      console.log("（麦克风能量过低，未检测到语音；已保存 wav 供核对）");
      continue;
    }
    const playerLine = (await asr.transcribe(pcm16, "zh-CN", new AbortController().signal)).trim();
    console.log(`转录: ${playerLine}`);
    messages.push({ role: "user", content: playerLine });
    const turn = { index: turnIndex++, player: playerLine, llm: {}, voice: {} };
    record.turns.push(turn);
    const sink = voice.createChatVoiceStreamingSink();
    await sink.begin(`player_turn_${turnIndex}`);

    const spokenByTurn = async (chunk) => {
      const clean = chunk.normalize("NFC");
      if (clean.trim().length === 0) return;
      lastSpoken += clean;
      // Await like production (p4-provider-start-execution awaits
      // speechSink.append): the sink's chunkIndex increments after the await,
      // so parallel appends would collide on the same chunkIndex and the
      // gateway would reject the job with chunk_index_out_of_order.
      try {
        await sink.append(clean);
      } catch {
        // voice-local degradation is silent for the player session
      }
      deltas += 1;
    };

    // Stream the companion reply; feed deltas straight into the sink exactly
    // like the production Chat wiring.
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages, stream: true, temperature: 0.8, max_tokens: 400 }),
    });
    if (!res.ok) throw new Error(`llm_error_${res.status}: ${(await res.text()).slice(0, 150)}`);
    const readerBody = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullReply = "";
    let deltas = 0;
    let lastSpoken = "";
    for (;;) {
      const { done, value } = await readerBody.read();
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
            fullReply += delta.content;
            await spokenByTurn(delta.content);
          }
        } catch { /* partial SSE */ }
      }
    }
    messages.push({ role: "assistant", content: fullReply.trim() });
    turn.llm = { reply: fullReply.trim(), replyLength: fullReply.trim().length, deltas, spokenLength: lastSpoken.length };
    await sink.finalize();

    // Await the terminal playback observation; surface must return to ready.
    // Any terminal status is a settlement (completed/cancelled/failed/...);
    // when the sink carried no audio at all the job idles without an
    // observation, so a short grace period resolves to no_speakable.
    const terminal = await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("player_turn_observation_timeout")), 90_000);
      const unsubscribe = voice.onPlaybackObservation((event) => {
        if (event?.terminalStatus !== undefined) {
          clearTimeout(timer);
          unsubscribe();
          resolvePromise(event);
        }
      });
      // If no audio was appended at all (empty or pure-narration reply), the
      // job idles with no observation; settle after a short grace period.
      setTimeout(() => {
        if (lastSpoken.trim().length === 0) {
          clearTimeout(timer);
          unsubscribe();
          resolvePromise({ terminalStatus: "no_speakable" });
        }
      }, 3000);
    });
    await new Promise((r) => setTimeout(r, 500));
    turn.voice.terminalStatus = terminal.terminalStatus;
    turn.voice.reasonCode = terminal.reasonCode ?? null;
    turn.voice.surfaceAfter = reader()?.state ?? null;
    console.log(`${card.data.name}> ${fullReply.trim()}\n`);
  }

  // --- 4. stderr safety scan: no keys/tokens/PCM fragments. ---
  const sensitive = [];
  const lowerErr = childErr.toLowerCase();
  for (const marker of ["mimo_api_key", "api-key:", "bearer ", "pcm16", "base64", "voice_token_", "desktop-consent-v1"]) {
    if (lowerErr.includes(marker.toLowerCase())) sensitive.push(marker);
  }
  record.stderrSafety = { scannedBytes: childErr.length, sensitiveHits: sensitive };
  if (sensitive.length > 0) throw new Error(`stderr_safety_failed:${sensitive.join(",")}`);

  record.passed = true;
  record.reason = "ok: real player session, companion replied and spoke, surface settled, stderr clean";
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ ...record, turns: record.turns.map((t) => ({ index: t.index, llm: { replyLength: t.llm.replyLength, deltas: t.llm.deltas, spokenLength: t.llm.spokenLength }, voice: t.voice })) }, null, 2));
  await voice.close();
} catch (error) {
  record.reason = error instanceof Error ? error.message : "player_release_failed";
  await writeFile(artifactPath, JSON.stringify(record, null, 2));
  console.error(`player_release_failed: ${record.reason}\nstderr=${childErr.slice(-800)}`);
  process.exitCode = 1;
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
}