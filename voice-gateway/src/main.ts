import { startVoiceGateway } from "./server.js";

const port = Number.parseInt(process.env.GAMEBUDDY_VOICE_PORT ?? "49731", 10);
const token = process.env.GAMEBUDDY_VOICE_TOKEN ?? "";
if (!Number.isInteger(port) || port < 1 || port > 65_535 || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) {
  console.error("Set GAMEBUDDY_VOICE_TOKEN (16+ opaque characters) and optional GAMEBUDDY_VOICE_PORT before starting Voice Gateway.");
  process.exitCode = 2;
} else {
  const gateway = await startVoiceGateway({ port, token });
  console.log(`GameBuddy Voice Gateway ready on 127.0.0.1:${gateway.port} (protocol v1).`);
  const shutdown = async () => { await gateway.close(); process.exit(0); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
}
