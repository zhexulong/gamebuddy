import type { CompanionThinkingLevel } from "../runtime-identity.js";
import { COMPANION_THINKING_LEVELS } from "../runtime-identity.js";
import {
  type TavernConnectionProbeResult,
  TavernConnectionStore,
  TavernConnectionInputError,
  TavernConnectionRevisionConflict,
  type TavernConnectionRecord,
} from "./connection-store.js";
import { probeTavernConnection, type TavernConnectionProbe } from "./connection-probe.js";
import {
  catalogModel,
  catalogProvider,
  TAVERN_ENVIRONMENT_PROVIDER_ID,
  TAVERN_PROVIDER_CATALOG,
} from "./provider-catalog.js";
import {
  TAVERN_BROWSER_API_VERSION,
  TavernBrowserValidatorsV1,
  type TavernConnectionCreateCommandV1,
  type TavernConnectionModelCommandV1,
  type TavernConnectionProbeV1,
  type TavernConnectionStateV1,
  type TavernConnectionV1,
} from "./browser-contract/index.js";

/**
 * Host-owned connection management service for the tavern_management profile
 * (design/28 §5.3).
 *
 * It is the only place connection records, credentials and the probe meet, and
 * it projects a player-readable read model in which:
 *
 * - `connectionId` is an opaque write handle the browser hands back, never a
 *   rendered result — each row also carries the labels a player reads;
 * - no API key, credential source, Pi provider id or raw provider error can
 *   appear, in a response or in thrown error text;
 * - `baseUrl` is present only when the player typed that endpoint (design/28
 *   §1): the store keeps a URL only for the escape-hatch entry.
 */

export type TavernTurnStateSignal = Readonly<{ turnActive: boolean }>;

export type TavernConnectionService = Readonly<{
  read(): Promise<TavernConnectionStateV1>;
  create(command: TavernConnectionCreateCommandV1): Promise<TavernConnectionStateV1>;
  test(connectionId: string, expectedRevision: number): Promise<TavernConnectionProbeV1>;
  activate(connectionId: string, expectedRevision: number): Promise<TavernConnectionStateV1>;
  selectModel(connectionId: string, command: TavernConnectionModelCommandV1): Promise<TavernConnectionStateV1>;
  remove(connectionId: string, expectedRevision: number): Promise<TavernConnectionStateV1>;
  close(): Promise<void>;
}>;

export type TavernConnectionServiceOptions = Readonly<{
  agentDir: string;
  /** Host-owned durable turn state: an activation may not switch a running turn. */
  readTurnState: () => Promise<TavernTurnStateSignal>;
  probe?: TavernConnectionProbe;
}>;

export class TavernDialogueBusyError extends Error {
  constructor() {
    super("dialogue_busy");
  }
}

export function createTavernConnectionService(options: TavernConnectionServiceOptions): TavernConnectionService {
  const store = new TavernConnectionStore(options.agentDir);
  const probe = options.probe ?? probeTavernConnection;
  let closed = false;
  // One management mutation at a time: the probe crosses the network, so a
  // second mutation would otherwise act on a revision the first is replacing.
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const queued = tail.then(work, work);
    tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };
  const assertOpen = (): void => {
    if (closed) throw new Error("tavern_connection_service_unavailable");
  };
  const project = async (): Promise<TavernConnectionStateV1> => {
    const document = await store.read();
    const active = document.connections.find((entry) => entry.connectionId === document.activeConnectionId) ?? null;
    const state = {
      apiVersion: TAVERN_BROWSER_API_VERSION,
      revision: document.revision,
      active: active === null ? null : projectActiveRecord(active),
      connections: document.connections.map((entry) => projectRecord(entry, entry.connectionId === document.activeConnectionId)),
      providers: projectProviders(),
    } satisfies TavernConnectionStateV1;
    if (!TavernBrowserValidatorsV1.TavernConnectionStateV1Schema.Check(state))
      throw new Error("tavern_connection_projection_invalid");
    return state;
  };
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    assertOpen();
    return await serialize(async () => {
      assertOpen();
      try {
        return await work();
      } catch (error) {
        throw mapStoreError(error);
      }
    });
  };

  return Object.freeze({
    async read(): Promise<TavernConnectionStateV1> {
      assertOpen();
      try {
        return await project();
      } catch (error) {
        throw mapStoreError(error);
      }
    },
    async create(command: TavernConnectionCreateCommandV1): Promise<TavernConnectionStateV1> {
      return await guarded(async () => {
        await store.create({
          providerId: command.providerId,
          apiKey: command.apiKey ?? null,
          baseUrl: command.baseUrl ?? null,
          apiShape: command.apiShape ?? null,
          modelId: command.modelId ?? null,
        });
        return await project();
      });
    },
    async test(connectionId: string, expectedRevision: number): Promise<TavernConnectionProbeV1> {
      return await guarded(async () => {
        const document = await store.read();
        const record = document.connections.find((entry) => entry.connectionId === connectionId);
        if (record === undefined) throw new TavernConnectionInputError("not_found");
        if (document.revision !== expectedRevision) throw new TavernConnectionRevisionConflict();
        const result = await probeRecord(store, probe, record);
        await store.recordProbe(connectionId, result);
        const state = await project();
        const result1 = {
          apiVersion: TAVERN_BROWSER_API_VERSION,
          connectionId,
          outcome: result.outcome,
          failure: result.outcome === "ready" ? null : result.failure,
          state,
        } satisfies TavernConnectionProbeV1;
        if (!TavernBrowserValidatorsV1.TavernConnectionProbeV1Schema.Check(result1))
          throw new Error("tavern_connection_projection_invalid");
        return result1;
      });
    },
    async activate(connectionId: string, expectedRevision: number): Promise<TavernConnectionStateV1> {
      return await guarded(async () => {
        // design/28 §5.3: an activation cannot switch a running turn.
        const turnState = await options.readTurnState();
        if (turnState.turnActive) throw new TavernDialogueBusyError();
        await store.activate(connectionId, expectedRevision);
        return await project();
      });
    },
    async selectModel(connectionId: string, command: TavernConnectionModelCommandV1): Promise<TavernConnectionStateV1> {
      return await guarded(async () => {
        await store.selectModel(
          connectionId,
          command.expectedRevision,
          command.modelId,
          command.thinkingLevel as CompanionThinkingLevel,
        );
        return await project();
      });
    },
    async remove(connectionId: string, expectedRevision: number): Promise<TavernConnectionStateV1> {
      return await guarded(async () => {
        await store.remove(connectionId, expectedRevision);
        return await project();
      });
    },
    async close(): Promise<void> {
      closed = true;
      await tail;
    },
  });
}

/**
 * Audit-safe error mapping. A store or filesystem message can carry a path and
 * a probe can carry provider text, so only closed categories cross this
 * boundary; every input reason keeps its exact name so the HTTP layer can map
 * it to one problem code.
 */
function mapStoreError(error: unknown): Error {
  if (
    error instanceof TavernConnectionInputError ||
    error instanceof TavernConnectionRevisionConflict ||
    error instanceof TavernDialogueBusyError
  )
    return error;
  const message = error instanceof Error ? error.message : "";
  if (message === "invalid_tavern_connection_store" || message === "invalid_tavern_auth_store")
    return new Error("tavern_connection_storage_unavailable");
  if (message === "tavern_connection_readback_mismatch") return new Error("tavern_connection_storage_unavailable");
  return new Error("tavern_connection_service_unavailable");
}

async function probeRecord(
  store: TavernConnectionStore,
  probe: TavernConnectionProbe,
  record: TavernConnectionRecord,
): Promise<TavernConnectionProbeResult> {
  const provider = catalogProvider(record.providerId);
  if (provider === null) return Object.freeze({ outcome: "failed", failure: "not_configured" });
  // The environment connection is the one provider whose credential this
  // surface never stores; its key is read from the operator environment only.
  const apiKey = await store.credentialFor(record);
  const baseUrl = record.baseUrl ?? provider.baseUrl;
  if (baseUrl === null) return Object.freeze({ outcome: "failed", failure: "invalid_endpoint" });
  return await probe({ provider, baseUrl, apiKey, modelId: record.modelId });
}

function projectRecord(
  record: TavernConnectionRecord,
  active: boolean,
): TavernConnectionV1 {
  const provider = catalogProvider(record.providerId);
  if (provider === null) throw new Error("tavern_connection_projection_invalid");
  const model = catalogModel(provider, record.modelId);
  return Object.freeze({
    connectionId: record.connectionId,
    label: `${provider.label} · ${record.modelId}`.slice(0, 256),
    providerId: record.providerId,
    providerLabel: provider.label,
    configured: record.readiness !== "unconfigured",
    readiness: record.readiness,
    active,
    modelId: record.modelId,
    modelLabel: model?.modelLabel ?? record.modelId,
    thinkingLevel: record.thinkingLevel,
    // The levels this record's model accepts: a catalog model declares its own, and a
    // player-supplied endpoint gets the vocabulary the embedded runtime accepts.
    allowedThinkingLevels: [...(model?.allowedThinkingLevels ?? COMPANION_THINKING_LEVELS)],
    // Non-null only for the escape hatch, whose URL the player typed.
    baseUrl: record.baseUrl,
    failure: record.failure,
    lastCheckedAtMs: record.lastCheckedAtMs,
  });
}

/**
 * The active selection projection (design/28 §5.1). It carries the same
 * player-readable facts as a row; the row-only `providerId`/`configured`/
 * `active` flags would be redundant on the one selected record.
 */
function projectActiveRecord(record: TavernConnectionRecord): NonNullable<TavernConnectionStateV1["active"]> {
  const row = projectRecord(record, true);
  return {
    connectionId: row.connectionId,
    label: row.label,
    providerLabel: row.providerLabel,
    modelId: row.modelId,
    modelLabel: row.modelLabel,
    thinkingLevel: row.thinkingLevel,
    readiness: row.readiness,
    baseUrl: row.baseUrl,
    failure: row.failure,
    lastCheckedAtMs: row.lastCheckedAtMs,
  };
}

function projectProviders(): TavernConnectionStateV1["providers"] {
  return TAVERN_PROVIDER_CATALOG.map((provider) => ({
    providerId: provider.providerId,
    label: provider.label,
    setupFields: [...provider.setupFields],
    allowedPlayerModels: provider.allowedPlayerModels.map((model) => ({
      modelId: model.modelId,
      modelLabel: model.modelLabel,
      allowedThinkingLevels: [...model.allowedThinkingLevels],
      defaultThinkingLevel: model.defaultThinkingLevel,
    })),
    escapeHatch: provider.escapeHatch,
    environmentManaged: provider.providerId === TAVERN_ENVIRONMENT_PROVIDER_ID,
  }));
}
