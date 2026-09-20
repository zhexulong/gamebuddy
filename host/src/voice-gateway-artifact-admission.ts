export const VOICE_GATEWAY_ARTIFACT_SCHEMA = "gamebuddy-host-voice-gateway-admission/v1" as const;

export type VoiceGatewayArtifactAdmission = Readonly<{
  schema: typeof VOICE_GATEWAY_ARTIFACT_SCHEMA;
  generation: string;
  inventoryDigest: string;
  entryPath: string;
  entrySha256: string;
  protocolPath: string;
  protocolSha256: string;
  nodeVersion: "v24.20.0";
  platform: "win32";
  arch: "x64";
}>;

const keys = new Set([
  "schema", "generation", "inventoryDigest", "entryPath", "entrySha256",
  "protocolPath", "protocolSha256", "nodeVersion", "platform", "arch",
]);
const sha256 = /^[0-9a-f]{64}$/;
const safePath = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|[\\/])\.\.?([\\/]|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("invalid JSON", { cause: error });
  }
}

export function validateVoiceGatewayArtifactAdmission(input: unknown): VoiceGatewayArtifactAdmission {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("artifact must be an object");
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.has(key) || key.toLowerCase().includes("secret")) throw new Error(`unknown field: ${key}`);
  if (Object.keys(record).length !== keys.size) throw new Error("missing artifact field");
  const strings = ["schema", "generation", "inventoryDigest", "entryPath", "entrySha256", "protocolPath", "protocolSha256", "nodeVersion", "platform", "arch"] as const;
  for (const key of strings) if (typeof record[key] !== "string" || record[key] === "") throw new Error(`invalid ${key}`);
  if (record.schema !== VOICE_GATEWAY_ARTIFACT_SCHEMA || record.nodeVersion !== "v24.20.0" || record.platform !== "win32" || record.arch !== "x64") throw new Error("unsupported artifact runtime");
  if (!safePath.test(record.entryPath as string) || !safePath.test(record.protocolPath as string)) throw new Error("unsafe artifact path");
  if (!sha256.test(record.entrySha256 as string) || !sha256.test(record.protocolSha256 as string)) throw new Error("invalid sha256");
  return record as VoiceGatewayArtifactAdmission;
}

export function parseVoiceGatewayArtifactAdmission(text: string): VoiceGatewayArtifactAdmission {
  try { return validateVoiceGatewayArtifactAdmission(parseJsonObject(text)); } catch (error) { throw new Error("invalid voice gateway admission artifact", { cause: error }); }
}
