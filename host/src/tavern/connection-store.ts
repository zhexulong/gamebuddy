import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { atomicWriteFile, withPathLock } from "../path-lock.js";
import { readStrictJsonFile } from "../strict-json-reader.js";
import type { CompanionThinkingLevel } from "../runtime-identity.js";
import { PLAYER_MODEL_ID_PATTERN } from "../runtime-identity.js";
import {
  acceptsPlayerModel,
  catalogModel,
  catalogProvider,
  isAllowedThinkingLevel,
  isTavernPiApi,
  type TavernCatalogProvider,
  type TavernPiApi,
} from "./provider-catalog.js";

/**
 * Durable player connection records and the write-only credential store for
 * the Tavern management surface (design/28 §5.2).
 *
 * Two files, two roles, one owner:
 *
 * - `<agentDir>/tavern-connections.json` holds the records and the single
 *   active selection. It never holds a credential: a record keeps only the
 *   opaque `connectionId`, the catalog provider id, the player's own base URL
 *   and model id, the thinking level, and the last probe outcome.
 * - `<agentDir>/auth.json` is the embedded Pi runtime's own credential store,
 *   and the only file a submitted API key is written to. GameBuddy invents no
 *   second credential store: Pi reads this file, so a parallel store would
 *   create two sources of truth for the same secret.
 *
 * Every mutation runs under the connection document's path lock, so the
 * GameBuddy-owned writers serialize; the credential file is replaced by an
 * atomic rename and keeps every unrelated provider entry Pi stored.
 */

export type TavernConnectionReadiness = "unconfigured" | "configured" | "ready" | "failed";

/**
 * Closed, audit-safe probe outcome. It is the exact vocabulary a player notice
 * may render; no raw provider error, status text, header or body is ever
 * carried out of the probe.
 */
export type TavernConnectionProbeFailure =
  | "invalid_endpoint"
  | "not_configured"
  | "unauthorized"
  | "not_found"
  | "unreachable"
  | "timeout"
  | "invalid_response";

export type TavernConnectionProbeResult =
  | Readonly<{ outcome: "ready" }>
  | Readonly<{ outcome: "failed"; failure: TavernConnectionProbeFailure }>;

export type TavernConnectionRecord = Readonly<{
  /** Opaque write handle; never rendered as ordinary UI text. */
  connectionId: string;
  providerId: string;
  /** Player-supplied endpoint fact (escape hatch only); null for catalog endpoints. */
  baseUrl: string | null;
  /** Player-supplied API shape fact (escape hatch only); null when the entry pins it. */
  apiShape: TavernPiApi | null;
  modelId: string;
  thinkingLevel: CompanionThinkingLevel;
  readiness: TavernConnectionReadiness;
  failure: TavernConnectionProbeFailure | null;
  lastCheckedAtMs: number | null;
}>;

export type TavernConnectionDocument = Readonly<{
  revision: number;
  activeConnectionId: string | null;
  connections: readonly TavernConnectionRecord[];
}>;

export type TavernConnectionDraftInput = Readonly<{
  providerId: string;
  apiKey: string | null;
  baseUrl: string | null;
  apiShape: string | null;
  modelId: string | null;
}>;

/** One connection-store mutation: the next document plus its credential side effect. */
type TavernConnectionMutation = Readonly<{
  document: TavernConnectionDocument;
  /** Provider-store entry to write, when this mutation submitted a credential. */
  credentials?: Readonly<{ piProviderId: string; apiKey: string }>;
  /** Per-connection key to write, when this mutation submitted a credential. */
  connectionKey?: Readonly<{ connectionId: string; apiKey: string }>;
  /** Provider-store entry to drop, when this mutation removed a connection. */
  removeCredential?: string;
  /** Per-connection key to drop, when this mutation removed a connection. */
  removeConnectionKey?: string;
}>;

export class TavernConnectionRevisionConflict extends Error {
  constructor() {
    super("tavern_connection_revision_conflict");
  }
}

export class TavernConnectionInputError extends Error {
  constructor(readonly reason: TavernConnectionInputReason) {
    super(reason);
  }
}

export type TavernConnectionInputReason =
  | "provider_unknown"
  | "api_key_required"
  | "api_key_not_accepted"
  | "base_url_required"
  | "base_url_not_accepted"
  | "invalid_base_url"
  | "api_shape_required"
  | "api_shape_not_accepted"
  | "invalid_api_shape"
  | "model_not_allowed"
  | "invalid_model_id"
  | "thinking_level_not_allowed"
  | "not_found"
  | "not_ready"
  | "active_connection_cannot_be_removed"
  | "connection_limit_reached";

const SCHEMA_VERSION = 1;
const CONNECTION_DOCUMENT_FILE = "tavern-connections.json";
const CONNECTION_KEYS_FILE = "tavern-connection-keys.json";
const AUTH_FILE = "auth.json";
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_CONNECTIONS = 16;
const MAX_API_KEY_LENGTH = 4096;
const MAX_BASE_URL_LENGTH = 512;

export function connectionDocumentPath(agentDir: string): string {
  return join(agentDir, CONNECTION_DOCUMENT_FILE);
}
export function connectionAuthPath(agentDir: string): string {
  return join(agentDir, AUTH_FILE);
}
export function connectionKeysPath(agentDir: string): string {
  return join(agentDir, CONNECTION_KEYS_FILE);
}

/**
 * Bounded player-supplied endpoint. Only an absolute http(s) URL without
 * credentials or fragment is accepted; the trailing slash is dropped so one
 * endpoint has exactly one spelling. A query string is refused by default — a
 * catalog endpoint is Host-owned and never carries one — and admitted only for
 * the escape hatch, whose endpoint (an Azure-style `?api-version=…` route, say)
 * may require it.
 */
export function normalizePlayerBaseUrl(value: unknown, allowQuery = false): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BASE_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hash !== "") return null;
  if (url.search !== "" && !allowQuery) return null;
  if (url.hostname === "") return null;
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}${url.search}`;
}

export class TavernConnectionStore {
  constructor(private readonly agentDir: string) {}

  get documentPath(): string {
    return connectionDocumentPath(this.agentDir);
  }

  async read(): Promise<TavernConnectionDocument> {
    return await this.load();
  }

  /** Creates one draft record and writes its credential into the Pi provider store. */
  async create(input: TavernConnectionDraftInput): Promise<TavernConnectionDocument> {
    const provider = catalogProvider(input.providerId);
    if (provider === null) throw new TavernConnectionInputError("provider_unknown");
    const baseUrl = this.resolveBaseUrl(provider, input.baseUrl);
    const apiShape = this.resolveApiShape(provider, input.apiShape);
    const modelId = this.resolveModelId(provider, input.modelId);
    const apiKey = this.resolveApiKey(provider, input.apiKey);
    return await this.mutate((current) => {
      if (current.connections.length >= MAX_CONNECTIONS) throw new TavernConnectionInputError("connection_limit_reached");
      const connectionId = randomBytes(32).toString("base64url");
      const record: TavernConnectionRecord = Object.freeze({
        connectionId,
        providerId: provider.providerId,
        baseUrl,
        apiShape,
        modelId,
        thinkingLevel:
          catalogModel(provider, modelId)?.defaultThinkingLevel ??
          provider.allowedPlayerModels[0]?.defaultThinkingLevel ??
          "high",
        readiness: "configured",
        failure: null,
        lastCheckedAtMs: null,
      });
      return {
        document: { ...current, connections: [...current.connections, record] },
        ...(apiKey === null
          ? {}
          : {
              // Pi's provider store keeps its single provider-key slot; the
              // per-connection key file keeps every connection's own key so two
              // escape-hatch records for the same provider do not overwrite
              // each other's credential (design/28 §5.3: each player-supplied
              // endpoint has its own credential).
              connectionKey: { connectionId, apiKey },
              credentials: { piProviderId: provider.piProviderId, apiKey },
            }),
      };
    });
  }

  /** Records one probe outcome for an existing connection. */
  async recordProbe(connectionId: string, result: TavernConnectionProbeResult): Promise<TavernConnectionDocument> {
    return await this.mutate((current) => {
      const record = requireConnection(current, connectionId);
      const next: TavernConnectionRecord = Object.freeze({
        ...record,
        readiness: result.outcome === "ready" ? "ready" : "failed",
        failure: result.outcome === "ready" ? null : result.failure,
        lastCheckedAtMs: Date.now(),
      });
      return { document: replaceConnection(current, next) };
    });
  }

  /** Selects the allowed model/thinking level; a changed model needs a fresh probe. */
  async selectModel(
    connectionId: string,
    expectedRevision: number,
    modelId: string,
    thinkingLevel: CompanionThinkingLevel,
  ): Promise<TavernConnectionDocument> {
    return await this.mutate(
      (current) => {
        const record = requireConnection(current, connectionId);
        const provider = catalogProvider(record.providerId);
        if (provider === null) throw new TavernConnectionInputError("provider_unknown");
        const model = catalogModel(provider, modelId);
        if (model === null) {
          if (!acceptsPlayerModel(provider) || !PLAYER_MODEL_ID_PATTERN.test(modelId))
            throw new TavernConnectionInputError("model_not_allowed");
          if (!PLAYER_MODEL_THINKING_LEVELS.includes(thinkingLevel))
            throw new TavernConnectionInputError("thinking_level_not_allowed");
          return {
            document: replaceConnection(
              current,
              Object.freeze({ ...record, modelId, thinkingLevel, readiness: "configured", failure: null }),
            ),
          };
        }
        if (!isAllowedThinkingLevel(model, thinkingLevel))
          throw new TavernConnectionInputError("thinking_level_not_allowed");
        // The previous probe proved the previous model answered; a different
        // model may not answer at all, so readiness is withdrawn until the new
        // selection is probed.
        const changed = record.modelId !== modelId || record.thinkingLevel !== thinkingLevel;
        return {
          document: replaceConnection(
            current,
            Object.freeze({
              ...record,
              modelId,
              thinkingLevel,
              ...(changed ? { readiness: "configured" as const, failure: null } : {}),
            }),
          ),
        };
      },
      expectedRevision,
    );
  }

  async activate(connectionId: string, expectedRevision: number): Promise<TavernConnectionDocument> {
    return await this.mutate(
      (current) => {
        const record = requireConnection(current, connectionId);
        if (record.readiness !== "ready") throw new TavernConnectionInputError("not_ready");
        return { document: { ...current, activeConnectionId: connectionId } };
      },
      expectedRevision,
    );
  }

  /** Removes an inactive record together with its stored credential. */
  async remove(connectionId: string, expectedRevision: number): Promise<TavernConnectionDocument> {
    return await this.mutate(
      (current) => {
        const record = requireConnection(current, connectionId);
        if (current.activeConnectionId === connectionId)
          throw new TavernConnectionInputError("active_connection_cannot_be_removed");
        const provider = catalogProvider(record.providerId);
        const connections = current.connections.filter((entry) => entry.connectionId !== connectionId);
        return {
          document: { ...current, connections },
          ...(provider === null || provider.environmentVariable !== null
            ? {}
            : {
                removeCredential: provider.piProviderId,
                removeConnectionKey: connectionId,
              }),
        };
      },
      expectedRevision,
    );
  }

  /** The one active record, or null while no player connection is selected. */
  async active(): Promise<TavernConnectionRecord | null> {
    const document = await this.load();
    return document.connections.find((entry) => entry.connectionId === document.activeConnectionId) ?? null;
  }

  /** The API key or environment credential the probe and activation resolve. */
  async credentialFor(record: TavernConnectionRecord): Promise<string | null> {
    const provider = catalogProvider(record.providerId);
    if (provider === null) return null;
    if (provider.environmentVariable !== null) {
      const value = process.env[provider.environmentVariable];
      return typeof value === "string" && value.length > 0 ? value : null;
    }
    // Per-connection key first: two escape-hatch connections for the same
    // catalog provider must probe with their own credential, not the Pi
    // provider slot's single key (which the last create overwrote).
    const keys = await this.loadConnectionKeys();
    const ownKey = keys[record.connectionId];
    if (typeof ownKey === "string" && ownKey.length > 0) return ownKey;
    const credentials = await this.loadCredentials();
    const entry = credentials[provider.piProviderId];
    if (entry === null || typeof entry !== "object") return null;
    const value = (entry as { readonly key?: unknown }).key;
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  private resolveBaseUrl(provider: TavernCatalogProvider, value: string | null): string | null {
    if (provider.baseUrl !== null) {
      if (value !== null) throw new TavernConnectionInputError("base_url_not_accepted");
      return null;
    }
    if (value === null) throw new TavernConnectionInputError("base_url_required");
    const normalized = normalizePlayerBaseUrl(value, provider.escapeHatch);
    if (normalized === null) throw new TavernConnectionInputError("invalid_base_url");
    return normalized;
  }

  /**
   * The API shape the emitted Pi provider entry will carry. A catalog entry
   * pins its own, so a submitted value is refused; the escape hatch has none
   * and requires the player's one exact shape from Pi's adapter set.
   */
  private resolveApiShape(provider: TavernCatalogProvider, value: string | null): TavernPiApi | null {
    if (provider.piApi !== null) {
      if (value !== null) throw new TavernConnectionInputError("api_shape_not_accepted");
      return null;
    }
    if (value === null) throw new TavernConnectionInputError("api_shape_required");
    if (!isTavernPiApi(value)) throw new TavernConnectionInputError("invalid_api_shape");
    return value;
  }

  private resolveModelId(provider: TavernCatalogProvider, value: string | null): string {
    if (acceptsPlayerModel(provider)) {
      if (value === null || !PLAYER_MODEL_ID_PATTERN.test(value)) throw new TavernConnectionInputError("invalid_model_id");
      return value;
    }
    if (value !== null && catalogModel(provider, value) === null)
      throw new TavernConnectionInputError("model_not_allowed");
    const model = value === null ? provider.allowedPlayerModels[0] : catalogModel(provider, value);
    if (model === null || model === undefined) throw new TavernConnectionInputError("model_not_allowed");
    return model.modelId;
  }

  private resolveApiKey(provider: TavernCatalogProvider, value: string | null): string | null {
    // An environment-provided credential is never submitted, stored or shown.
    if (provider.environmentVariable !== null) {
      if (value !== null) throw new TavernConnectionInputError("api_key_not_accepted");
      return null;
    }
    if (!provider.setupFields.includes("apiKey")) {
      if (value !== null) throw new TavernConnectionInputError("api_key_not_accepted");
      return null;
    }
    if (value === null) throw new TavernConnectionInputError("api_key_required");
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_API_KEY_LENGTH) throw new TavernConnectionInputError("api_key_required");
    if (hasUnpairedUtf16Surrogate(trimmed)) throw new TavernConnectionInputError("api_key_required");
    return trimmed;
  }

  private async mutate(
    change: (current: TavernConnectionDocument) => TavernConnectionMutation,
    expectedRevision?: number,
  ): Promise<TavernConnectionDocument> {
    return await withPathLock(this.documentPath, async () => {
      const current = await this.load();
      if (expectedRevision !== undefined && current.revision !== expectedRevision)
        throw new TavernConnectionRevisionConflict();
      const result = change(current);
      const next: TavernConnectionDocument = Object.freeze({ ...result.document, revision: current.revision + 1 });
      if (
        result.credentials !== undefined ||
        result.removeCredential !== undefined ||
        result.connectionKey !== undefined ||
        result.removeConnectionKey !== undefined
      ) {
        await this.updateCredentials(
          result.credentials,
          result.removeCredential,
          result.connectionKey,
          result.removeConnectionKey,
        );
      }
      await writeAtomically(this.documentPath, serialize(next));
      const readBack = await this.load();
      if (JSON.stringify(readBack) !== JSON.stringify(next)) throw new Error("tavern_connection_readback_mismatch");
      return readBack;
    });
  }

  private async updateCredentials(
    write: Readonly<{ piProviderId: string; apiKey: string }> | undefined,
    removeProviderId: string | undefined,
    connectionKey: Readonly<{ connectionId: string; apiKey: string }> | undefined,
    removeConnectionKey: string | undefined,
  ): Promise<void> {
    const path = connectionAuthPath(this.agentDir);
    const credentials = await this.loadCredentials();
    const next: Record<string, unknown> = { ...credentials };
    if (removeProviderId !== undefined) delete next[removeProviderId];
    if (write !== undefined) next[write.piProviderId] = { type: "api_key", key: write.apiKey };
    await atomicWriteFile(path, JSON.stringify(next, null, 2));
    // The per-connection key file is Host-owned: one entry per connection, so
    // same-provider connections keep their own credential regardless of the
    // Pi provider slot (which is intentionally a single key for the runtime).
    const keysPath = connectionKeysPath(this.agentDir);
    const keys = await this.loadConnectionKeys();
    const nextKeys: Record<string, unknown> = { ...keys };
    if (removeConnectionKey !== undefined) delete nextKeys[removeConnectionKey];
    if (connectionKey !== undefined) nextKeys[connectionKey.connectionId] = connectionKey.apiKey;
    await atomicWriteFile(keysPath, JSON.stringify(nextKeys, null, 2));
  }

  private async loadConnectionKeys(): Promise<Record<string, unknown>> {
    try {
      const value = await readStrictJsonFile(connectionKeysPath(this.agentDir));
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_tavern_connection_keys");
      return value as Record<string, unknown>;
    } catch (error) {
      if (isNotFound(error)) return {};
      throw new Error("invalid_tavern_connection_keys");
    }
  }

  private async loadCredentials(): Promise<Record<string, unknown>> {
    try {
      const value = await readStrictJsonFile(connectionAuthPath(this.agentDir));
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_tavern_auth_store");
      // The file is Pi's; entries this surface does not own are preserved verbatim.
      return value as Record<string, unknown>;
    } catch (error) {
      if (isNotFound(error)) return {};
      throw new Error("invalid_tavern_auth_store");
    }
  }

  private async load(): Promise<TavernConnectionDocument> {
    try {
      return validateDocument(await readStrictJsonFile(this.documentPath));
    } catch (error) {
      if (isNotFound(error)) return EMPTY_DOCUMENT;
      throw new Error("invalid_tavern_connection_store");
    }
  }
}

const EMPTY_DOCUMENT: TavernConnectionDocument = Object.freeze({
  revision: 0,
  activeConnectionId: null,
  connections: Object.freeze([]),
});

/**
 * Thinking levels accepted for a player-supplied model id. The catalog cannot
 * describe an arbitrary compatible endpoint's model, so the bounded Host-owned
 * vocabulary is offered for it instead of any provider payload.
 */
const PLAYER_MODEL_THINKING_LEVELS: readonly CompanionThinkingLevel[] = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function requireConnection(document: TavernConnectionDocument, connectionId: string): TavernConnectionRecord {
  const record = document.connections.find((entry) => entry.connectionId === connectionId);
  if (record === undefined) throw new TavernConnectionInputError("not_found");
  return record;
}

function replaceConnection(
  document: TavernConnectionDocument,
  record: TavernConnectionRecord,
): TavernConnectionDocument {
  return {
    ...document,
    connections: document.connections.map((entry) => (entry.connectionId === record.connectionId ? record : entry)),
  };
}

function serialize(document: TavernConnectionDocument): string {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    revision: document.revision,
    activeConnectionId: document.activeConnectionId,
    connections: document.connections.map((entry) => ({
      connectionId: entry.connectionId,
      providerId: entry.providerId,
      baseUrl: entry.baseUrl,
      apiShape: entry.apiShape,
      modelId: entry.modelId,
      thinkingLevel: entry.thinkingLevel,
      readiness: entry.readiness,
      failure: entry.failure,
      lastCheckedAtMs: entry.lastCheckedAtMs,
    })),
  });
}

const THINKING_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);
const READINESS: ReadonlySet<string> = new Set(["unconfigured", "configured", "ready", "failed"]);
const PROBE_FAILURES: ReadonlySet<string> = new Set([
  "invalid_endpoint",
  "not_configured",
  "unauthorized",
  "not_found",
  "unreachable",
  "timeout",
  "invalid_response",
]);

function validateDocument(value: unknown): TavernConnectionDocument {
  if (
    !record(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !isRevision(value.revision) ||
    (value.activeConnectionId !== null && !isConnectionId(value.activeConnectionId)) ||
    !Array.isArray(value.connections) ||
    value.connections.length > MAX_CONNECTIONS ||
    !hasExactKeys(value, ["schemaVersion", "revision", "activeConnectionId", "connections"])
  )
    throw new Error("invalid_tavern_connection_store");
  const connections = value.connections.map(validateRecord);
  const seen = new Set(connections.map((entry) => entry.connectionId));
  if (seen.size !== connections.length) throw new Error("invalid_tavern_connection_store");
  const activeConnectionId = value.activeConnectionId as string | null;
  // The active selection must name a record that exists; a dangling selection
  // is a corrupted document, never a silently empty active connection.
  if (activeConnectionId !== null && !seen.has(activeConnectionId)) throw new Error("invalid_tavern_connection_store");
  return Object.freeze({ revision: value.revision, activeConnectionId, connections: Object.freeze(connections) });
}

function validateRecord(value: unknown): TavernConnectionRecord {
  if (
    !record(value) ||
    !isConnectionId(value.connectionId) ||
    typeof value.providerId !== "string" ||
    catalogProvider(value.providerId) === null ||
    (value.baseUrl !== null && typeof value.baseUrl !== "string") ||
    (value.apiShape !== null && typeof value.apiShape !== "string") ||
    typeof value.modelId !== "string" ||
    value.modelId.length === 0 ||
    value.modelId.length > 128 ||
    typeof value.thinkingLevel !== "string" ||
    !THINKING_LEVELS.has(value.thinkingLevel) ||
    typeof value.readiness !== "string" ||
    !READINESS.has(value.readiness) ||
    (value.failure !== null && (typeof value.failure !== "string" || !PROBE_FAILURES.has(value.failure))) ||
    !isTimestampOrNull(value.lastCheckedAtMs) ||
    !hasExactKeys(value, [
      "connectionId",
      "providerId",
      "baseUrl",
      "apiShape",
      "modelId",
      "thinkingLevel",
      "readiness",
      "failure",
      "lastCheckedAtMs",
    ])
  )
    throw new Error("invalid_tavern_connection_store");
  const provider = catalogProvider(value.providerId as string)!;
  // A record's endpoint, API shape and model must still match its catalog
  // entry: a record may never smuggle an endpoint or an API shape the catalog
  // did not authorize. Only the escape hatch carries a player-supplied URL, and
  // only there is a query string a legitimate part of that URL.
  if ((provider.baseUrl === null) !== (value.baseUrl !== null)) throw new Error("invalid_tavern_connection_store");
  if (value.baseUrl !== null && normalizePlayerBaseUrl(value.baseUrl, provider.escapeHatch) !== value.baseUrl)
    throw new Error("invalid_tavern_connection_store");
  if (provider.piApi !== null) {
    if (value.apiShape !== null) throw new Error("invalid_tavern_connection_store");
  } else if (!isTavernPiApi(value.apiShape)) {
    throw new Error("invalid_tavern_connection_store");
  }
  if (!provider.allowedPlayerModels.some((model) => model.modelId === value.modelId)) {
    if (!acceptsPlayerModel(provider) || !PLAYER_MODEL_ID_PATTERN.test(value.modelId as string))
      throw new Error("invalid_tavern_connection_store");
  }
  const recordValue = value as unknown as TavernConnectionRecord;
  if (recordValue.readiness === "ready" && recordValue.failure !== null)
    throw new Error("invalid_tavern_connection_store");
  if (recordValue.readiness === "failed" && recordValue.failure === null)
    throw new Error("invalid_tavern_connection_store");
  return Object.freeze({
    connectionId: recordValue.connectionId,
    providerId: recordValue.providerId,
    baseUrl: recordValue.baseUrl,
    apiShape: recordValue.apiShape,
    modelId: recordValue.modelId,
    thinkingLevel: recordValue.thinkingLevel,
    readiness: recordValue.readiness,
    failure: recordValue.failure,
    lastCheckedAtMs: recordValue.lastCheckedAtMs,
  });
}

function isConnectionId(value: unknown): value is string {
  return typeof value === "string" && CONNECTION_ID_PATTERN.test(value);
}
function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isTimestampOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}
function hasUnpairedUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function writeAtomically(path: string, content: string): Promise<void> {
  await atomicWriteFile(path, content);
}
