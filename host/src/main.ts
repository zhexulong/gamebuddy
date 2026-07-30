import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { attachCompanionExpression } from "./agent-expression.js";
import { connectLocalCompanion, disconnectLocalCompanion } from "./local-bootstrap.js";
import { LocalVoiceGatewayClient } from "./voice-gateway-client.js";

/**
 * Explicit local Host bootstrap. It never searches the repository for config,
 * never reads credentials from source files, and refuses to start without an
 * identity-bound Mod bridge configuration supplied by the local operator.
 */
type LocalHostConfig = Readonly<{
  playerId: string; saveId: string; worldId: string; companionId: string;
  pipeName: string; bridgeToken: string;
  model?: "mimo-v2.5" | "mimo-v2.5-pro";
  voiceGateway?: Readonly<{ port: number; token: string }>;
}>;

const configPath = process.argv[2] ?? process.env.GAMEBUDDY_HOST_CONFIG;
if (configPath === undefined) throw new Error("host_config_path_required");
const config = validateConfig(JSON.parse(await readFile(resolve(configPath), "utf8")) as unknown);
const connected = await connectLocalCompanion({
  identity: { playerId: config.playerId, saveId: config.saveId, worldId: config.worldId, companionId: config.companionId },
  pipeName: config.pipeName,
  bridgeToken: config.bridgeToken,
  modelConfig: config.model === undefined ? undefined : { provider: "xiaomi-mimo", modelId: config.model },
});
// connectLocalCompanion already admitted the mandatory initial Mod snapshot
// through the ordinary Host turn path before returning. Voice remains a
// separate local service and is optional for keyboard/replay Host operation.
const voice = config.voiceGateway === undefined ? undefined : await LocalVoiceGatewayClient.connect(config.voiceGateway);
const detachVoice = voice === undefined ? undefined : connected.host.attachFinalVoiceSource(voice);
// The CLI is the current visible-text sink. Agent prose is presentation only:
// it never feeds back into bridge facts, action authority, or execution state.
const detachExpression = attachCompanionExpression(connected.runtime.session, {
  sessionId: connected.runtime.identityKey,
  visible: { show: async (expression) => { process.stdout.write(`Companion: ${expression.text}\n`); } },
  speech: voice,
});
const voicePoll = voice === undefined ? undefined : setInterval(() => {
  void voice.pollEvents().catch(() => undefined);
}, 200);
process.stdout.write("GameBuddy Host connected to an identity-bound local Stardew bridge. Press Ctrl+C to stop.\n");
await new Promise<void>((resolveStop) => {
  const stop = () => resolveStop();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
});
if (voicePoll !== undefined) clearInterval(voicePoll);
detachExpression();
detachVoice?.();
voice?.close();
disconnectLocalCompanion(connected);

function validateConfig(value: unknown): LocalHostConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_host_config");
  const candidate = value as Record<string, unknown>;
  const opaque = (key: string) => typeof candidate[key] === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(candidate[key]) ? candidate[key] : undefined;
  const playerId = opaque("playerId"); const saveId = opaque("saveId"); const worldId = opaque("worldId"); const companionId = opaque("companionId"); const pipeName = opaque("pipeName");
  const bridgeToken = typeof candidate.bridgeToken === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(candidate.bridgeToken) ? candidate.bridgeToken : undefined;
  const model = candidate.model === undefined ? undefined : candidate.model === "mimo-v2.5" || candidate.model === "mimo-v2.5-pro" ? candidate.model : undefined;
  const voiceCandidate = candidate.voiceGateway;
  const voiceGateway = voiceCandidate === undefined ? undefined : parseVoiceGateway(voiceCandidate);
  if (playerId === undefined || saveId === undefined || worldId === undefined || companionId === undefined || pipeName === undefined || bridgeToken === undefined || (candidate.model !== undefined && model === undefined) || (voiceCandidate !== undefined && voiceGateway === undefined)) throw new Error("invalid_host_config");
  return { playerId, saveId, worldId, companionId, pipeName, bridgeToken, model, voiceGateway };
}

function parseVoiceGateway(value: unknown): LocalHostConfig["voiceGateway"] | undefined {
  if (!isRecord(value) || typeof value.port !== "number" || typeof value.token !== "string") return undefined;
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65_535 || !/^[A-Za-z0-9_-]{16,256}$/.test(value.token)) return undefined;
  return { port: value.port, token: value.token };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
