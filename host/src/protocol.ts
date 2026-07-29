import { randomUUID } from "node:crypto";

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_EVENTS_PER_WINDOW = 32;
export const EVENT_WINDOW_MS = 1_000;

export type Scope = Readonly<{
  integrationId: string;
  saveId: string;
  worldId: string;
  playerId: string;
  companionId: string;
}>;

export type Envelope<TType extends string, TPayload> = Readonly<{
  protocolVersion: number;
  messageId: string;
  correlationId: string;
  timestampMs: number;
  scope: Scope;
  type: TType;
  payload: TPayload;
}>;

export const EXECUTION_STATES = [
  "accepted", "running", "meaningful_progress", "blocked", "invalidated",
  "succeeded", "partially_succeeded", "failed", "cancelled", "expired", "rejected", "uncertain",
] as const;
export type ExecutionState = typeof EXECUTION_STATES[number];

export type ActiveExecution = Readonly<{
  executionId: string;
  requestId: string;
  action: string;
  state: ExecutionState;
  reasonCode: string;
  evidence: Readonly<Record<string, unknown>> | null;
}>;

export type Snapshot = Readonly<{
  revision: number;
  location: string;
  tile: Readonly<{ x: number; y: number }>;
  stamina: number;
  health: number;
  actionable: boolean;
  capabilities: readonly string[];
  activeExecution: ActiveExecution | null;
}>;

export type ActionGrant = Readonly<{ token: string; action: "move_to_tile"; expiresAtMs: number; nonce: string }>;

export type ExecutionRequest = Readonly<{
  requestId: string;
  idempotencyKey: string;
  action: "move_to_tile" | "inspect_self";
  args: Readonly<Record<string, unknown>>;
  expectedRevision: number;
  deadlineMs: number;
  permissionToken: string;
}>;

export type ExecutionReceipt = Readonly<{
  executionId: string;
  requestId: string;
  state: ExecutionState;
  reasonCode: string;
  revision: number;
  evidence: Readonly<Record<string, unknown>> | null;
}>;

export type SemanticEvent = Readonly<{
  kind: "snapshot_changed" | "execution_state" | "connection_state" | "lifecycle";
  revision: number;
  activeExecution: ActiveExecution | null;
  reasonCode: string;
}>;

export type BridgeMessage =
  | Envelope<"hello", Readonly<{ token: string }>>
  | Envelope<"hello_ack", Readonly<{ sessionId: string; capabilities: readonly string[]; actionGrants: readonly ActionGrant[] }>>
  | Envelope<"observe_request", Readonly<Record<string, never>>>
  | Envelope<"snapshot", Snapshot>
  | Envelope<"execution_request", ExecutionRequest>
  | Envelope<"cancel_request", Readonly<{ requestId: string; executionId: string; reasonCode: string }>>
  | Envelope<"execution_receipt", ExecutionReceipt>
  | Envelope<"error", Readonly<{ reasonCode: string }>>
  | Envelope<"semantic_event", SemanticEvent>
  | Envelope<"lifecycle", Readonly<{ state: "connected" | "disconnected" | "world_unavailable"; reasonCode: string }>>;

export const BRIDGE_MESSAGE_TYPES = [
  "hello", "hello_ack", "observe_request", "snapshot", "execution_request",
  "cancel_request", "execution_receipt", "error", "semantic_event", "lifecycle",
] as const;

export function newEnvelope<TType extends BridgeMessage["type"], TPayload>(
  type: TType,
  scope: Scope,
  payload: TPayload,
  correlationId: string = randomUUID(),
  timestampMs = Date.now(),
): Envelope<TType, TPayload> {
  return { protocolVersion: PROTOCOL_VERSION, messageId: randomUUID(), correlationId, timestampMs, scope, type, payload };
}

export function validateScope(expected: Scope, actual: Scope): string | null {
  for (const key of Object.keys(expected) as (keyof Scope)[]) {
    if (expected[key] !== actual[key]) return `scope_mismatch:${key}`;
  }
  return null;
}

export function validateEnvelope(value: unknown, expectedScope: Scope, nowMs = Date.now()): string | null {
  if (!isRecord(value)) return "invalid_envelope";
  if (value.protocolVersion !== PROTOCOL_VERSION) return "unsupported_protocol_version";
  if (typeof value.messageId !== "string" || !isOpaqueId(value.messageId)) return "invalid_message_id";
  if (typeof value.correlationId !== "string" || !isOpaqueId(value.correlationId)) return "invalid_correlation_id";
  if (typeof value.timestampMs !== "number" || !Number.isFinite(value.timestampMs) || Math.abs(nowMs - value.timestampMs) > 5 * 60_000) return "stale_or_invalid_timestamp";
  if (!isScope(value.scope)) return "invalid_scope";
  if (typeof value.type !== "string" || !BRIDGE_MESSAGE_TYPES.includes(value.type as (typeof BRIDGE_MESSAGE_TYPES)[number])) return "unknown_message_type";
  if (!("payload" in value) || !isRecord(value.payload)) return "invalid_payload";
  return validateScope(expectedScope, value.scope);
}

export function validateBridgeMessage(value: unknown, expectedScope: Scope, nowMs = Date.now()): string | null {
  const envelopeError = validateEnvelope(value, expectedScope, nowMs);
  if (envelopeError !== null) return envelopeError;
  const message = value as BridgeMessage;
  const payload = message.payload as Record<string, unknown>;
  switch (message.type) {
    case "hello": return validToken(payload.token) ? null : "invalid_hello_token";
    case "hello_ack": return isOpaqueId(payload.sessionId) && isStringArray(payload.capabilities) && validActionGrants(payload.actionGrants, payload.capabilities, nowMs) ? null : "invalid_hello_ack";
    case "observe_request": return Object.keys(payload).length === 0 ? null : "invalid_observe_request";
    case "snapshot": return validateSnapshot(payload);
    case "execution_request": return validateExecutionRequestEnvelope(payload);
    case "cancel_request": return isOpaqueId(payload.requestId) && isOpaqueId(payload.executionId) && isReasonCode(payload.reasonCode) ? null : "invalid_cancel_request";
    case "execution_receipt": return validateReceipt(payload);
    case "error": return isReasonCode(payload.reasonCode) ? null : "invalid_error";
    case "semantic_event": return validateSemanticEvent(payload);
    case "lifecycle": return (payload.state === "connected" || payload.state === "disconnected" || payload.state === "world_unavailable") && isReasonCode(payload.reasonCode) ? null : "invalid_lifecycle";
  }
}

export function validateExecutionRequest(value: unknown, snapshot: Snapshot, nowMs = Date.now()): string | null {
  if (!isRecord(value)) return "invalid_request";
  if (!isOpaqueId(value.requestId) || !isOpaqueId(value.idempotencyKey)) return "invalid_request_id";
  if (value.action !== "move_to_tile" && value.action !== "inspect_self") return "unknown_action";
  if (!isRecord(value.args)) return "invalid_args";
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision !== snapshot.revision) return "stale_snapshot";
  if (typeof value.deadlineMs !== "number" || !Number.isFinite(value.deadlineMs) || value.deadlineMs < nowMs || value.deadlineMs > nowMs + 60_000) return "invalid_deadline";
  if (!validToken(value.permissionToken)) return "invalid_permission";
  if (!snapshot.actionable && value.action !== "inspect_self") return "player_not_actionable";
  if (!snapshot.capabilities.includes(value.action)) return "capability_not_declared";
  if (value.action === "move_to_tile") {
    const x = value.args.x;
    const y = value.args.y;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1000 || y > 1000) return "invalid_target_tile";
  }
  return null;
}

export function serializeBounded(value: unknown): string {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { throw new Error("message_not_serializable"); }
  if (json === undefined) throw new Error("message_not_serializable");
  if (Buffer.byteLength(json, "utf8") > MAX_MESSAGE_BYTES) throw new Error("message_too_large");
  return json;
}

function validateSnapshot(value: Record<string, unknown>): string | null {
  return Number.isSafeInteger(value.revision) && typeof value.location === "string" && isRecord(value.tile)
    && isFiniteNumber(value.tile.x) && isFiniteNumber(value.tile.y)
    && isFiniteNumber(value.stamina) && isFiniteNumber(value.health) && typeof value.actionable === "boolean"
    && isStringArray(value.capabilities) && (value.activeExecution === null || (isRecord(value.activeExecution) && validateActiveExecution(value.activeExecution) === null)) ? null : "invalid_snapshot";
}

function validateExecutionRequestEnvelope(value: Record<string, unknown>): string | null {
  return isOpaqueId(value.requestId) && isOpaqueId(value.idempotencyKey)
    && (value.action === "move_to_tile" || value.action === "inspect_self")
    && isRecord(value.args) && Number.isSafeInteger(value.expectedRevision)
    && typeof value.deadlineMs === "number" && Number.isFinite(value.deadlineMs)
    && validToken(value.permissionToken) ? null : "invalid_execution_request";
}

function validActionGrants(value: unknown, capabilities: unknown, nowMs: number): value is readonly ActionGrant[] {
  if (!Array.isArray(value) || value.length > 8 || !isStringArray(capabilities)) return false;
  const tokens = new Set<string>(); const nonces = new Set<string>();
  return value.every((grant) => {
    if (!isRecord(grant) || !validToken(grant.token) || grant.action !== "move_to_tile" || !capabilities.includes(grant.action)
      || typeof grant.expiresAtMs !== "number" || !Number.isFinite(grant.expiresAtMs) || grant.expiresAtMs <= nowMs || grant.expiresAtMs > nowMs + 60_000
      || !isOpaqueId(grant.nonce) || tokens.has(grant.token) || nonces.has(grant.nonce)) return false;
    tokens.add(grant.token); nonces.add(grant.nonce); return true;
  });
}

function validateReceipt(value: Record<string, unknown>): string | null {
  return isOpaqueId(value.executionId) && isOpaqueId(value.requestId) && typeof value.state === "string"
    && EXECUTION_STATES.includes(value.state as ExecutionState) && isReasonCode(value.reasonCode)
    && Number.isSafeInteger(value.revision) && (value.evidence === null || isRecord(value.evidence)) ? null : "invalid_receipt";
}

function validateSemanticEvent(value: Record<string, unknown>): string | null {
  return (value.kind === "snapshot_changed" || value.kind === "execution_state" || value.kind === "connection_state" || value.kind === "lifecycle")
    && Number.isSafeInteger(value.revision) && isReasonCode(value.reasonCode)
    && (value.activeExecution === null || (isRecord(value.activeExecution) && validateActiveExecution(value.activeExecution) === null)) ? null : "invalid_semantic_event";
}

function validateActiveExecution(value: Record<string, unknown>): string | null {
  return isOpaqueId(value.executionId) && isOpaqueId(value.requestId) && typeof value.action === "string" && value.action.length <= 128
    && typeof value.state === "string" && EXECUTION_STATES.includes(value.state as ExecutionState) && isReasonCode(value.reasonCode)
    && (value.evidence === null || isRecord(value.evidence)) ? null : "invalid_active_execution";
}
function isScope(value: unknown): value is Scope {
  return isRecord(value) && ["integrationId", "saveId", "worldId", "playerId", "companionId"].every((key) => typeof value[key] === "string" && isOpaqueId(value[key]));
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isOpaqueId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function isReasonCode(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9_:-]{1,128}$/.test(value); }
function validToken(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(value); }
function isStringArray(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length <= 128); }
function isFiniteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
