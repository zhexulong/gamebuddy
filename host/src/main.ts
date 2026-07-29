import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { connectLocalCompanion, disconnectLocalCompanion } from "./local-bootstrap.js";

/**
 * Explicit local Host bootstrap. It never searches the repository for config,
 * never reads credentials from source files, and refuses to start without an
 * identity-bound Mod bridge configuration supplied by the local operator.
 */
type LocalHostConfig = Readonly<{
  playerId: string; saveId: string; worldId: string; companionId: string;
  pipeName: string; bridgeToken: string;
  model?: "mimo-v2.5" | "mimo-v2.5-pro";
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
// The initial snapshot came directly from the Mod before runtime creation.
// Forward it once, then Host service forwards later validated bridge facts.
connected.loop.pump.enqueueFact({ source: "stardew_mod", kind: "snapshot", correlationId: "bootstrap_snapshot", revision: connected.bridge.state.snapshot?.revision ?? 0, payload: connected.bridge.state.snapshot ?? {} });
await connected.loop.flush();
process.stdout.write("GameBuddy Host connected to an identity-bound local Stardew bridge. Press Ctrl+C to stop.\n");
await new Promise<void>((resolveStop) => {
  const stop = () => resolveStop();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
});
disconnectLocalCompanion(connected);

function validateConfig(value: unknown): LocalHostConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_host_config");
  const candidate = value as Record<string, unknown>;
  const opaque = (key: string) => typeof candidate[key] === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(candidate[key]) ? candidate[key] : undefined;
  const playerId = opaque("playerId"); const saveId = opaque("saveId"); const worldId = opaque("worldId"); const companionId = opaque("companionId"); const pipeName = opaque("pipeName");
  const bridgeToken = typeof candidate.bridgeToken === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(candidate.bridgeToken) ? candidate.bridgeToken : undefined;
  const model = candidate.model === undefined ? undefined : candidate.model === "mimo-v2.5" || candidate.model === "mimo-v2.5-pro" ? candidate.model : undefined;
  if (playerId === undefined || saveId === undefined || worldId === undefined || companionId === undefined || pipeName === undefined || bridgeToken === undefined || (candidate.model !== undefined && model === undefined)) throw new Error("invalid_host_config");
  return { playerId, saveId, worldId, companionId, pipeName, bridgeToken, model };
}
