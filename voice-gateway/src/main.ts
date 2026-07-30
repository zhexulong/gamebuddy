import { readFile } from "node:fs/promises";

import { MimoTtsProvider } from "./mimo.js";
import { type Mixer, type TtsProvider } from "./gateway.js";
import { auditSenseVoiceAssets, SenseVoiceCliAsrProvider, type SenseVoiceAssetManifest } from "./sensevoice.js";
import { startVoiceGateway } from "./server.js";

const silentMixer: Mixer = { play() {}, stop() {} };
const port = Number.parseInt(process.env.GAMEBUDDY_VOICE_PORT ?? "49731", 10);
const token = process.env.GAMEBUDDY_VOICE_TOKEN ?? "";
if (!Number.isInteger(port) || port < 1 || port > 65_535 || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) {
  console.error("Set GAMEBUDDY_VOICE_TOKEN (16+ opaque characters) and optional GAMEBUDDY_VOICE_PORT before starting Voice Gateway.");
  process.exitCode = 2;
} else {
  const asr = await configuredAsr();
  const tts = configuredTts();
  const gateway = await startVoiceGateway({ port, token, asr, tts, mixer: silentMixer });
  console.log(`GameBuddy Voice Gateway ready on 127.0.0.1:${gateway.port} (protocol v1).`);
  const shutdown = async () => { await gateway.close(); process.exit(0); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
}


/** Real ASR is opt-in and fail-closed: no asset configuration means text-only. */
async function configuredAsr(): Promise<SenseVoiceCliAsrProvider | undefined> {
  const path = process.env.GAMEBUDDY_SENSEVOICE_ASSET_MANIFEST;
  if (path === undefined || path.length === 0) return undefined;
  let manifest: SenseVoiceAssetManifest;
  try { manifest = JSON.parse(await readFile(path, "utf8")) as SenseVoiceAssetManifest; }
  catch { throw new Error("sensevoice_manifest_unreadable"); }
  await auditSenseVoiceAssets(manifest);
  return new SenseVoiceCliAsrProvider(manifest);
}

/** Cloud TTS is separately opt-in; missing key/profile remains text-only. */
function configuredTts(): TtsProvider | undefined {
  const apiKey = process.env.MIMO_API_KEY;
  const voice = process.env.GAMEBUDDY_MIMO_VOICE;
  if (apiKey === undefined || voice === undefined) return undefined;
  return new MimoTtsProvider({ apiKey, voiceByProfile: { "companion.default": voice } });
}
