import { dirname, resolve } from "node:path";
import { parseActionPolicy, type ActionPolicy } from "./action-registry.js";

export type LocalHostConfig = Readonly<{
  playerId: string;
  saveId: string;
  worldId: string;
  companionId: string;
  pipeName: string;
  bridgeToken: string;
  model?: "deepseek-v4-flash";
  thinkingLevel?: "high";
  knowledgeBundlePath?: string;
  gameVersion?: string;
  voiceGateway?: Readonly<{ port: number; token: string }>;
  presentation?: Readonly<{ speech?: Readonly<{ voiceProfile: string }> }>;
  actionPolicy?: ActionPolicy;
  gameplaySubagent?: boolean;
}>;

/** Validate operator-owned Host config without reading files or credentials. */
export function validateLocalHostConfig(value: unknown): LocalHostConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_host_config");
  const candidate = value as Record<string, unknown>;
  const opaque = (key: string) => typeof candidate[key] === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(candidate[key]) ? candidate[key] : undefined;
  const playerId = opaque("playerId");
  const saveId = opaque("saveId");
  const worldId = opaque("worldId");
  const companionId = opaque("companionId");
  const pipeName = opaque("pipeName");
  const bridgeToken = typeof candidate.bridgeToken === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(candidate.bridgeToken) ? candidate.bridgeToken : undefined;
  const model = candidate.model === undefined ? undefined : candidate.model === "deepseek-v4-flash" ? candidate.model : undefined;
  const thinkingLevel = candidate.thinkingLevel === undefined ? (model === undefined ? undefined : "high") : candidate.thinkingLevel === "high" ? candidate.thinkingLevel : undefined;
  const knowledgeBundlePath = candidate.knowledgeBundlePath === undefined
    ? undefined
    : typeof candidate.knowledgeBundlePath === "string" && candidate.knowledgeBundlePath.length > 0 && candidate.knowledgeBundlePath.length <= 512
      ? candidate.knowledgeBundlePath
      : undefined;
  const gameVersion = candidate.gameVersion === undefined
    ? undefined
    : typeof candidate.gameVersion === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(candidate.gameVersion)
      ? candidate.gameVersion
      : undefined;
  const voiceCandidate = candidate.voiceGateway;
  const voiceGateway = voiceCandidate === undefined ? undefined : parseVoiceGateway(voiceCandidate);
  const presentation = candidate.presentation === undefined ? undefined : parsePresentation(candidate.presentation);
  let actionPolicy: ActionPolicy | undefined;
  if (candidate.actionPolicy !== undefined) {
    try { actionPolicy = parseActionPolicy(candidate.actionPolicy); }
    catch { throw new Error("invalid_host_config"); }
  }
  const gameplaySubagent = candidate.gameplaySubagent === undefined ? false : candidate.gameplaySubagent === true;
  if (playerId === undefined || saveId === undefined || worldId === undefined || companionId === undefined || pipeName === undefined || bridgeToken === undefined
    || (candidate.model !== undefined && model === undefined)
    || (candidate.thinkingLevel !== undefined && thinkingLevel === undefined)
    || (model === undefined && thinkingLevel !== undefined)
    || (voiceCandidate !== undefined && voiceGateway === undefined)
    || (candidate.presentation !== undefined && presentation === undefined)
    || (candidate.actionPolicy !== undefined && actionPolicy === undefined)
    || (candidate.gameplaySubagent !== undefined && typeof candidate.gameplaySubagent !== "boolean")
    || (presentation?.speech !== undefined && voiceGateway === undefined)
    || (candidate.knowledgeBundlePath !== undefined && knowledgeBundlePath === undefined)
    || (candidate.gameVersion !== undefined && gameVersion === undefined)
    || ((knowledgeBundlePath === undefined) !== (gameVersion === undefined))) {
    throw new Error("invalid_host_config");
  }
  return { playerId, saveId, worldId, companionId, pipeName, bridgeToken, model, thinkingLevel, knowledgeBundlePath, gameVersion, voiceGateway, presentation, actionPolicy, gameplaySubagent };
}

/** Resolve an operator-configured knowledge path relative to its Host config. */
export function resolveKnowledgeBundlePath(configPath: string, knowledgeBundlePath: string): string {
  return resolve(dirname(configPath), knowledgeBundlePath);
}

function parsePresentation(value: unknown): LocalHostConfig["presentation"] | undefined {
  if (!isRecord(value)) return undefined;
  if (value.speech === undefined) return {};
  if (!isRecord(value.speech) || typeof value.speech.voiceProfile !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value.speech.voiceProfile)) return undefined;
  return { speech: { voiceProfile: value.speech.voiceProfile } };
}

function parseVoiceGateway(value: unknown): LocalHostConfig["voiceGateway"] | undefined {
  if (!isRecord(value) || typeof value.port !== "number" || typeof value.token !== "string") return undefined;
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65_535 || !/^[A-Za-z0-9_-]{16,256}$/.test(value.token)) return undefined;
  return { port: value.port, token: value.token };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
