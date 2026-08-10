import { randomUUID } from "node:crypto";

export const PORTFOLIO_PROTOCOL_VERSION = 1;
export const PORTFOLIO_INTEGRATION_ID = "stardew_portfolio";
export const PORTFOLIO_TOPOLOGY = "single_player_native_companion";
export const PORTFOLIO_MAX_MESSAGE_BYTES = 16 * 1024;

export type PortfolioScope = Readonly<{
  integrationId: typeof PORTFOLIO_INTEGRATION_ID;
  topology: typeof PORTFOLIO_TOPOLOGY;
  saveId: string;
  worldId: string;
  localPlayerId: string;
  companionId: string;
  bindingGeneration: number;
  bindingHash: string;
}>;

export type PortfolioSnapshot = Readonly<{
  protocolVersion: number;
  integrationId: typeof PORTFOLIO_INTEGRATION_ID;
  topology: typeof PORTFOLIO_TOPOLOGY;
  saveId: string;
  worldId: string;
  localPlayerId: string;
  companionId: string;
  bindingGeneration: number;
  bindingHash: string;
  revision: number;
  worldReady: boolean;
  singlePlayer: boolean;
  currentLocalPlayerMatches: boolean;
  state: "ready" | "invalidated";
  reasonCode: string;
}>;

type PortfolioEnvelope<TType extends string, TPayload> = Readonly<{
  protocolVersion: number;
  messageId: string;
  correlationId: string;
  timestampMs: number;
  scope: PortfolioScope;
  type: TType;
  payload: TPayload;
}>;

export type PortfolioMessage =
  | PortfolioEnvelope<"hello", Readonly<{ token: string }>>
  | PortfolioEnvelope<"hello_ack", Readonly<{ sessionId: string; bindingGeneration: number; bindingHash: string }>>
  | PortfolioEnvelope<"observe_request", Readonly<Record<string, never>>>
  | PortfolioEnvelope<"snapshot", PortfolioSnapshot>
  | PortfolioEnvelope<"error", Readonly<{ reasonCode: string }>>;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const HASH = /^[a-f0-9]{64}$/;
const REASON = /^[a-z0-9_:-]{1,128}$/;

export function newPortfolioEnvelope<TType extends PortfolioMessage["type"], TPayload>(type: TType, scope: PortfolioScope, payload: TPayload, correlationId = randomUUID(), timestampMs = Date.now()): PortfolioEnvelope<TType, TPayload> {
  return { protocolVersion: PORTFOLIO_PROTOCOL_VERSION, messageId: randomUUID(), correlationId, timestampMs, scope, type, payload };
}

export function validatePortfolioMessage(value: unknown, expectedScope: PortfolioScope, nowMs = Date.now()): string | null {
  if (!validPortfolioScope(expectedScope) || !isRecord(value) || !hasExactKeys(value, ["protocolVersion", "messageId", "correlationId", "timestampMs", "scope", "type", "payload"])
    || value.protocolVersion !== PORTFOLIO_PROTOCOL_VERSION || !validId(value.messageId) || !validId(value.correlationId)
    || typeof value.timestampMs !== "number" || !Number.isSafeInteger(value.timestampMs) || Math.abs(nowMs - value.timestampMs) > 5 * 60_000
    || !samePortfolioScope(value.scope, expectedScope) || typeof value.type !== "string" || !isRecord(value.payload)) return "invalid_portfolio_envelope";
  switch (value.type) {
    case "hello": return hasExactKeys(value.payload, ["token"]) && validToken(value.payload.token) ? null : "invalid_portfolio_hello";
    case "hello_ack": return hasExactKeys(value.payload, ["sessionId", "bindingGeneration", "bindingHash"])
      && validId(value.payload.sessionId) && value.payload.bindingGeneration === expectedScope.bindingGeneration && value.payload.bindingHash === expectedScope.bindingHash
      ? null : "invalid_portfolio_hello_ack";
    case "observe_request": return hasExactKeys(value.payload, []) ? null : "invalid_portfolio_observe_request";
    case "snapshot": {
      const fault = validatePortfolioSnapshot(value.payload);
      if (fault !== null) return fault;
      return samePortfolioSnapshotScope(value.payload, expectedScope) ? null : "portfolio_snapshot_scope_mismatch";
    }
    case "error": return hasExactKeys(value.payload, ["reasonCode"]) && validReason(value.payload.reasonCode) ? null : "invalid_portfolio_error";
    default: return "portfolio_message_type_rejected";
  }
}

export function validatePortfolioSnapshot(value: unknown): string | null {
  if (!isRecord(value) || !hasExactKeys(value, ["protocolVersion", "integrationId", "topology", "saveId", "worldId", "localPlayerId", "companionId", "bindingGeneration", "bindingHash", "revision", "worldReady", "singlePlayer", "currentLocalPlayerMatches", "state", "reasonCode"]) || value.protocolVersion !== PORTFOLIO_PROTOCOL_VERSION || value.integrationId !== PORTFOLIO_INTEGRATION_ID || value.topology !== PORTFOLIO_TOPOLOGY
    || !validId(value.saveId) || !validId(value.worldId) || !validId(value.localPlayerId) || !validId(value.companionId)
    || !Number.isSafeInteger(value.bindingGeneration) || value.bindingGeneration <= 0 || !validHash(value.bindingHash)
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.worldReady !== "boolean" || typeof value.singlePlayer !== "boolean"
    || typeof value.currentLocalPlayerMatches !== "boolean" || (value.state !== "ready" && value.state !== "invalidated") || !validReason(value.reasonCode)) return "invalid_portfolio_snapshot";
  return null;
}

export function serializePortfolioBounded(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("portfolio_message_not_serializable");
  if (Buffer.byteLength(json, "utf8") > PORTFOLIO_MAX_MESSAGE_BYTES) throw new Error("portfolio_message_too_large");
  return json;
}

function validPortfolioScope(value: PortfolioScope): boolean {
  return value.integrationId === PORTFOLIO_INTEGRATION_ID && value.topology === PORTFOLIO_TOPOLOGY
    && validId(value.saveId) && validId(value.worldId) && validId(value.localPlayerId) && validId(value.companionId)
    && Number.isSafeInteger(value.bindingGeneration) && value.bindingGeneration > 0 && validHash(value.bindingHash);
}
function samePortfolioScope(actual: unknown, expected: PortfolioScope): boolean {
  if (!isRecord(actual) || !hasExactKeys(actual, ["integrationId", "topology", "saveId", "worldId", "localPlayerId", "companionId", "bindingGeneration", "bindingHash"])) return false;
  return actual.integrationId === expected.integrationId && actual.topology === expected.topology && actual.saveId === expected.saveId
    && actual.worldId === expected.worldId && actual.localPlayerId === expected.localPlayerId && actual.companionId === expected.companionId
    && actual.bindingGeneration === expected.bindingGeneration && actual.bindingHash === expected.bindingHash;
}
function samePortfolioSnapshotScope(actual: Record<string, any>, expected: PortfolioScope): boolean {
  return actual.integrationId === expected.integrationId && actual.topology === expected.topology && actual.saveId === expected.saveId
    && actual.worldId === expected.worldId && actual.localPlayerId === expected.localPlayerId && actual.companionId === expected.companionId
    && actual.bindingGeneration === expected.bindingGeneration && actual.bindingHash === expected.bindingHash;
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}
function validId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function validToken(value: unknown): value is string { return typeof value === "string" && TOKEN.test(value); }
function validHash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
function validReason(value: unknown): value is string { return typeof value === "string" && REASON.test(value); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
