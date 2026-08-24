export type LocalHostConfig = Readonly<{
  playerId: string;
  companionId: string;
  /** Opaque continuity may span Chat/Game; adapter scope otherwise supplies save/world partitioning. */
  continuityId?: string;
  integrationId: string;
  /** Strictly parsed by the selected adapter, never by Host core. */
  integration: unknown;
  model?: "deepseek-v4-flash";
  thinkingLevel?: "high";
  voiceGateway?: Readonly<{ port: number; token: string }>;
  /** Optional Host-owned binding for final-transcript event polling. */
  voiceSessionId?: string;
  presentation?: Readonly<{ speech?: Readonly<{ voiceProfile: string }> }>;
  /** Parsed by the selected module only after catalog selection. */
  actionPolicy?: unknown;
  gameplaySubagent?: boolean;
}>;

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

/** Validate only Host-owned operator config; integration config stays opaque. */
export function validateLocalHostConfig(value: unknown): LocalHostConfig {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        !new Set([
          "playerId",
          "companionId",
          "continuityId",
          "integrationId",
          "integration",
          "model",
          "thinkingLevel",
          "voiceGateway",
          "voiceSessionId",
          "presentation",
          "actionPolicy",
          "gameplaySubagent",
        ]).has(key),
    )
  ) {
    throw new Error("invalid_host_config");
  }
  const playerId = opaque(value.playerId);
  const companionId = opaque(value.companionId);
  const continuityId = value.continuityId === undefined ? undefined : opaque(value.continuityId);
  const integrationId = opaque(value.integrationId);
  const model = value.model === undefined ? undefined : value.model === "deepseek-v4-flash" ? value.model : undefined;
  const thinkingLevel =
    value.thinkingLevel === undefined
      ? model === undefined
        ? undefined
        : "high"
      : value.thinkingLevel === "high"
        ? value.thinkingLevel
        : undefined;
  const voiceGateway = value.voiceGateway === undefined ? undefined : parseVoiceGateway(value.voiceGateway);
  const voiceSessionId = value.voiceSessionId === undefined ? undefined : opaque(value.voiceSessionId);
  const presentation = value.presentation === undefined ? undefined : parsePresentation(value.presentation);
  const gameplaySubagent = value.gameplaySubagent === undefined ? false : value.gameplaySubagent === true;
  if (
    playerId === undefined ||
    companionId === undefined ||
    integrationId === undefined ||
    !isRecord(value.integration) ||
    (value.continuityId !== undefined && continuityId === undefined) ||
    (value.model !== undefined && model === undefined) ||
    (value.thinkingLevel !== undefined && thinkingLevel === undefined) ||
    (model === undefined && value.thinkingLevel !== undefined) ||
    (value.voiceGateway !== undefined && voiceGateway === undefined) ||
    (value.voiceSessionId !== undefined && voiceSessionId === undefined) ||
    (voiceSessionId !== undefined && voiceGateway === undefined) ||
    (value.presentation !== undefined && presentation === undefined) ||
    (value.gameplaySubagent !== undefined && typeof value.gameplaySubagent !== "boolean") ||
    (presentation?.speech !== undefined && voiceGateway === undefined)
  ) {
    throw new Error("invalid_host_config");
  }
  return Object.freeze({
    playerId,
    companionId,
    ...(continuityId === undefined ? {} : { continuityId }),
    integrationId,
    integration: value.integration,
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(voiceGateway === undefined ? {} : { voiceGateway }),
    ...(voiceSessionId === undefined ? {} : { voiceSessionId }),
    ...(presentation === undefined ? {} : { presentation }),
    ...(value.actionPolicy === undefined ? {} : { actionPolicy: value.actionPolicy }),
    gameplaySubagent,
  });
}

function opaque(value: unknown): string | undefined {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : undefined;
}

function parsePresentation(value: unknown): LocalHostConfig["presentation"] | undefined {
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some((key) => key !== "speech")) return undefined;
  if (value.speech === undefined) return {};
  if (
    !isRecord(value.speech) ||
    Object.keys(value.speech).some((key) => key !== "voiceProfile") ||
    typeof value.speech.voiceProfile !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(value.speech.voiceProfile)
  )
    return undefined;
  return { speech: { voiceProfile: value.speech.voiceProfile } };
}

function parseVoiceGateway(value: unknown): LocalHostConfig["voiceGateway"] | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "port" && key !== "token") ||
    typeof value.port !== "number" ||
    typeof value.token !== "string"
  )
    return undefined;
  if (
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535 ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(value.token)
  )
    return undefined;
  return { port: value.port, token: value.token };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
