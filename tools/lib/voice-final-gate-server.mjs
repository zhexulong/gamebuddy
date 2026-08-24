import { readFile } from "node:fs/promises";

import { auditSenseVoiceAssets, SenseVoiceCliAsrProvider } from "../../voice-gateway/dist/sensevoice.js";
import { startVoiceGateway } from "../../voice-gateway/dist/server.js";
import { WindowsPttCapture } from "../../voice-gateway/dist/windows-capture.js";

const [manifestPath, portText] = process.argv.slice(2);
const token = process.env.GAMEBUDDY_VOICE_TOKEN;
const selection = process.env.GAMEBUDDY_WINDOWS_INPUT_DEVICE;
const port = Number(portText);
if (manifestPath === undefined || token === undefined || selection === undefined || !Number.isInteger(port))
  throw new Error("voice_final_gate_configuration_missing");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
await auditSenseVoiceAssets(manifest);
// Do not consume a short startup probe: default Windows input is allowed to be
// quiet. The explicit PTT lifecycle below is the only real capture gate.
const gateway = await startVoiceGateway({
  port,
  token,
  asr: new SenseVoiceCliAsrProvider(manifest),
  capture: new WindowsPttCapture(selection),
});
console.log(`voice_final_gate_listening ${gateway.port}`);
const shutdown = async () => {
  await gateway.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
