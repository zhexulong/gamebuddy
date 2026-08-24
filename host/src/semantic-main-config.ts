import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { VoiceGatewayConnection } from "./voice-gateway-client.js";

export type SemanticVoiceConfig = Readonly<{
  voiceGateway: VoiceGatewayConnection;
  voiceSessionId: string;
  voiceProfile: string;
}>;

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const VOICE_PROFILE = /^[A-Za-z0-9._-]{1,128}$/;
const VOICE_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const VOICE_CONFIG_KEYS = ["schemaVersion", "voiceGateway", "voiceSessionId", "voiceProfile"] as const;
const VOICE_GATEWAY_KEYS = ["port", "token"] as const;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type SemanticMainCommand = Readonly<
  | { kind: "enter"; operatorConfigPath: string }
  | { kind: "recover_dead_owner"; operatorConfigPath: string; operationId: string }
>;

/**
 * Parses the Host's deliberately small command surface. Dead-owner recovery
 * is CLI-only and has no implicit or automatic route from normal entry.
 */
export function parseSemanticMainCommand(
  argv: readonly string[],
  environmentOperatorConfigPath: string | undefined,
): SemanticMainCommand {
  if (argv.length === 0) {
    if (!validAbsolutePath(environmentOperatorConfigPath))
      throw new Error("semantic_game_operator_config_path_required");
    return Object.freeze({ kind: "enter", operatorConfigPath: environmentOperatorConfigPath });
  }
  if (argv.length === 1 && validAbsolutePath(argv[0]))
    return Object.freeze({ kind: "enter", operatorConfigPath: argv[0] });
  if (
    argv.length === 3 &&
    validAbsolutePath(argv[0]) &&
    argv[1] === "recover-dead-owner" &&
    typeof argv[2] === "string" &&
    OPERATION_ID.test(argv[2])
  ) {
    return Object.freeze({ kind: "recover_dead_owner", operatorConfigPath: argv[0], operationId: argv[2] });
  }
  throw new Error("invalid_semantic_main_command");
}

/**
 * Loads the optional, Host-local voice attachment configuration. It is
 * deliberately separate from the semantic Game operator configuration: voice
 * may attach only when every required voice fact is explicitly configured.
 */
export async function loadSemanticVoiceConfig(path: string): Promise<SemanticVoiceConfig> {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || !isAbsolute(path)) {
    throw new Error("invalid_semantic_voice_config");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("invalid_semantic_voice_config");
  }
  const config = exactObject(parsed, VOICE_CONFIG_KEYS);
  const gateway = config === undefined ? undefined : exactObject(config.voiceGateway, VOICE_GATEWAY_KEYS);
  if (
    config === undefined ||
    config.schemaVersion !== 1 ||
    gateway === undefined ||
    !validPort(gateway.port) ||
    typeof gateway.token !== "string" ||
    !VOICE_TOKEN.test(gateway.token) ||
    typeof config.voiceSessionId !== "string" ||
    !IDENTIFIER.test(config.voiceSessionId) ||
    typeof config.voiceProfile !== "string" ||
    !VOICE_PROFILE.test(config.voiceProfile)
  ) {
    throw new Error("invalid_semantic_voice_config");
  }
  return Object.freeze({
    voiceGateway: Object.freeze({ port: gateway.port, token: gateway.token }),
    voiceSessionId: config.voiceSessionId,
    voiceProfile: config.voiceProfile,
  });
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const names = Object.keys(value);
  if (names.length !== keys.length || !keys.every((key) => names.includes(key))) return undefined;
  return value as Record<string, unknown>;
}

function validAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value);
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}
