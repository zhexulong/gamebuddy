import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { VoiceGatewayConnection } from "./voice-gateway-client.js";

export type SemanticVoiceConfig = Readonly<{
  voiceGateway: VoiceGatewayConnection;
  voiceSessionId: string;
  voiceProfile: string;
}>;

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VOICE_PROFILE = /^[A-Za-z0-9._-]{1,128}$/;
const VOICE_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const VOICE_CONFIG_KEYS = ["schemaVersion", "voiceGateway", "voiceSessionId", "voiceProfile"] as const;
const VOICE_GATEWAY_KEYS = ["port", "token"] as const;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type SemanticMainCommand = Readonly<
  | { kind: "enter"; deploymentManifestRef: string; operationalNonceSha256: string }
  | { kind: "recover_dead_owner"; deploymentManifestRef: string; operationId: string }
>;

/**
 * Parses the Host's deliberately small command surface. Normal entry accepts
 * only the explicit operational flags `--deployment-manifest-ref <path>` and
 * `--operational-nonce <sha256>`. Dead-owner recovery is CLI-only and has no
 * implicit or automatic route from normal entry.
 */
export function parseSemanticMainCommand(
  argv: readonly string[],
): SemanticMainCommand {
  const manifestRef = argv[1];
  const nonce = argv[3];
  if (argv.length === 4 &&
      argv[0] === "--deployment-manifest-ref" &&
      manifestRef !== undefined &&
      validAbsolutePath(manifestRef) &&
      argv[2] === "--operational-nonce" &&
      nonce !== undefined &&
      SHA256.test(nonce)) {
    return Object.freeze({
      kind: "enter",
      deploymentManifestRef: manifestRef,
      operationalNonceSha256: nonce,
    });
  }
  if (
    argv.length === 5 &&
    argv[0] === "recover-dead-owner" &&
    argv[1] === "--deployment-manifest-ref" &&
    validAbsolutePath(argv[2]) &&
    argv[3] === "--operation-id" &&
    typeof argv[4] === "string" &&
    OPERATION_ID.test(argv[4])
  ) {
    return Object.freeze({
      kind: "recover_dead_owner",
      deploymentManifestRef: argv[2],
      operationId: argv[4],
    });
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
