import { readFile } from "node:fs/promises";
import type { Mixer, TtsProvider } from "./gateway.js";
import { MimoTtsProvider } from "./mimo.js";
import { auditSenseVoiceAssets, type SenseVoiceAssetManifest, SenseVoiceCliAsrProvider } from "./sensevoice.js";
import { startVoiceGateway } from "./server.js";
import { createWindowsAudioMixer, type WindowsOutputSelection } from "./windows-audio.js";
import { type WindowsInputSelection, WindowsPttCapture } from "./windows-capture.js";

// Windows output is opt-in. `default` asks Windows to resolve its current
// multimedia output device for every open; an explicit `waveout:N` endpoint
// never silently falls back to another device.
const unavailableMixer: Mixer = { ready: false, play() {}, stop() {} };
const port = Number.parseInt(process.env.GAMEBUDDY_VOICE_PORT ?? "49731", 10);
const token = process.env.GAMEBUDDY_VOICE_TOKEN ?? "";
if (!Number.isInteger(port) || port < 1 || port > 65_535 || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) {
  console.error(
    "Set GAMEBUDDY_VOICE_TOKEN (16+ opaque characters) and optional GAMEBUDDY_VOICE_PORT before starting Voice Gateway.",
  );
  process.exitCode = 2;
} else {
  const asr = await configuredAsr();
  const candidateTts = await configuredTts();
  const mixer = await configuredMixer();
  const capture = await configuredCapture(asr);
  const tts = candidateTts === undefined ? undefined : await verifyTtsAgainstMixer(candidateTts, mixer);
  const gateway = await startVoiceGateway({ port, token, asr, tts, mixer, capture });
  const status = gateway.capabilities.ready ? "voice ready" : "voice unavailable";
  console.log(`GameBuddy Voice Gateway listening on 127.0.0.1:${gateway.port} (protocol v1; ${status}).`);
  const shutdown = async () => {
    await gateway.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

/** Real ASR is opt-in and fail-closed: no asset configuration means text-only. */
async function configuredAsr(): Promise<SenseVoiceCliAsrProvider | undefined> {
  const path = process.env.GAMEBUDDY_SENSEVOICE_ASSET_MANIFEST;
  if (path === undefined || path.length === 0) return undefined;
  let manifest: SenseVoiceAssetManifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8")) as SenseVoiceAssetManifest;
  } catch {
    throw new Error("sensevoice_manifest_unreadable");
  }
  await auditSenseVoiceAssets(manifest);
  return new SenseVoiceCliAsrProvider(manifest);
}

/** Cloud TTS is separately opt-in; missing key/profile remains text-only. */
async function configuredTts(): Promise<MimoTtsProvider | undefined> {
  const apiKey = process.env.MIMO_API_KEY;
  const voice = process.env.GAMEBUDDY_MIMO_VOICE;
  if (apiKey === undefined || voice === undefined) return undefined;
  // Prove that the configured credential/profile can produce a bounded PCM
  // chunk before speech is published. Errors deliberately collapse to an
  // unavailable surface and never expose provider response text or secrets.
  const candidate = new MimoTtsProvider({ apiKey, voiceByProfile: { "companion.default": voice } });
  return candidate;
}

/** Provider readiness is not publishable until its actual PCM opens/writes/completes on the chosen Windows output. */
async function verifyTtsAgainstMixer(candidate: MimoTtsProvider, mixer: Mixer): Promise<TtsProvider | undefined> {
  if (mixer.ready !== true || !("probePcm" in mixer) || typeof mixer.probePcm !== "function") return undefined;
  try {
    const job: Parameters<MimoTtsProvider["synthesize"]>[0] = {
      jobId: "voice_probe",
      sessionId: "voice_probe",
      epoch: 0,
      sourceEventId: "voice_probe",
      text: "。",
      locale: "zh-CN",
      voiceProfile: "companion.default",
      expiresAtMs: Date.now() + 12_000,
      interruptible: true,
    };
    for await (const pcm16 of candidate.synthesize(job, AbortSignal.timeout(12_000))) {
      await mixer.probePcm(pcm16);
      return new MimoTtsProvider({
        apiKey: process.env.MIMO_API_KEY!,
        voiceByProfile: { "companion.default": process.env.GAMEBUDDY_MIMO_VOICE! },
        ready: true,
      });
    }
  } catch {
    mixer.stop();
  }
  return undefined;
}

/** `default` is Windows' current default output; explicit waveOut endpoints do not fall back. */
async function configuredMixer(): Promise<Mixer> {
  const selected = process.env.GAMEBUDDY_WINDOWS_OUTPUT_DEVICE;
  if (selected === undefined || selected.length === 0) return unavailableMixer;
  if (process.platform !== "win32") return unavailableMixer;
  try {
    return await createWindowsAudioMixer(selected as WindowsOutputSelection);
  } catch {
    return unavailableMixer;
  }
}

/**
 * With audited ASR on Windows, capture follows the OS default unless the user
 * explicitly pins an endpoint. Do not sample at startup: a quiet microphone
 * must not make the user-selected/default device unavailable. Real driver open
 * and bounded PCM are checked only during an explicit PTT lifecycle.
 */
async function configuredCapture(asr: SenseVoiceCliAsrProvider | undefined): Promise<WindowsPttCapture | undefined> {
  if (asr === undefined || process.platform !== "win32") return undefined;
  const selected = process.env.GAMEBUDDY_WINDOWS_INPUT_DEVICE;
  const selection = (selected === undefined || selected.length === 0 ? "default" : selected) as WindowsInputSelection;
  try {
    return new WindowsPttCapture(selection);
  } catch {
    return undefined;
  }
}
