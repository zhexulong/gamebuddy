/**
 * INTERNAL delegated tavern-management dispatcher for the composed reference-game shell.
 *
 * The management dialogue-web dispatcher owns its own bootstrap/session/CSRF and writes its
 * own cookie, so it cannot share the composed root's single loopback listener where the
 * broker already owns session/CSRF. This delegated dispatcher mirrors the reference-pipeline
 * delegated handler: no bootstrap, session or CSRF of its own; every admission is brokered
 * through the opaque branded capability minted by `composed-reference-game-browser.ts`.
 *
 * Mounted routes (the panels the composed shell exposes):
 *   GET  /api/tavern/v1/chats                      -> chat.list
 *   GET  /api/tavern/v1/memory                     -> memory.read
 *   PUT  /api/tavern/v1/memory                     -> memory.mutate
 *   GET  /api/tavern/v1/world-info                 -> world-info.read
 *   PUT  /api/tavern/v1/world-info                 -> world-info.bind
 *   GET  /api/tavern/v1/settings/voice-preference  -> settings.voice.read
 *   GET  /api/tavern/v1/settings/language          -> settings.language.read
 *
 * Every other /api/tavern/v1/* path is 404 `profile_operation_unavailable`; the reference
 * delegated dispatcher keeps owning Chat operations (submit/cancel/state/draft/events).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  TavernBrowserValidatorsV1,
  type ChatListQueryV1,
  type TavernBrowserOperationIdV1,
  type TavernBrowserRouteIdV1,
  type ComposedTavernProfile,
  type MemoryMutationCommandV1,
  type MemoryReadV1,
  type SetWorldInfoBindingCommandV1,
  type WorldInfoStateV1,
} from "./tavern/browser-contract/index.js";
import type { ChatManagementService } from "./tavern/chat-management/chat-management-service.js";
import type { MemoryManagementService } from "./tavern/memory-management/memory-management.js";
import type { WorldInfoBindingManagementService } from "./tavern/world-info-binding/world-info-binding-management-service.js";
import type { PlayerPreference, PlayerPreferenceUpdate } from "./settings/player-preference-store.js";
import {
  hasRequestBody,
  isBrowserSameOriginRead,
  isExactLoopbackHost,
  isSameOrigin,
  readJsonBody,
  sendJson,
  sendProblem,
  setSecurityHeaders,
} from "./reference-pipeline-dialogue-web.core.js";
import {
  checkComposedReferenceGameBrowserAuthCsrf,
  isComposedReferenceGameBrowserDelegatedAuthCapability,
  verifyComposedReferenceGameBrowserAuth,
  type ComposedReferenceGameBrowserDelegatedAuthCapability,
} from "./composed-reference-game-browser.js";

export type TavernManagementDelegatedOptions = Readonly<{
  profile: ComposedTavernProfile;
  managementService: ChatManagementService;
  memoryService: MemoryManagementService;
  worldInfoService: WorldInfoBindingManagementService;
  playerPreferenceStore?: Readonly<{
    read(): Promise<PlayerPreference>;
    update(expectedRevision: number, update: PlayerPreferenceUpdate): Promise<PlayerPreference>;
  }>;
  /** The broker-minted opaque branded capability; anything else is rejected. */
  capability: ComposedReferenceGameBrowserDelegatedAuthCapability;
}>;

export type TavernManagementDelegatedHandler = Readonly<{
  handle(request: IncomingMessage, response: ServerResponse, origin: string): void;
  close(): Promise<void>;
}>;

export function createTavernManagementDialogueWebDelegatedHandler(
  options: TavernManagementDelegatedOptions,
): TavernManagementDelegatedHandler {
  if (!isComposedReferenceGameBrowserDelegatedAuthCapability(options.capability))
    throw new Error("tavern_management_delegated_capability_invalid");

  const { profile, managementService, memoryService, worldInfoService } = options;
  const playerPreferenceStore = options.playerPreferenceStore;
  const capability = options.capability;

  const mounted = (routeId: TavernBrowserRouteIdV1): boolean => profile.routeIds.includes(routeId);
  const mountedMutation = (routeId: TavernBrowserRouteIdV1, operationId: TavernBrowserOperationIdV1): boolean =>
    profile.routeIds.includes(routeId) && profile.operationIds.includes(operationId);

  let closed = false;
  const activeDispatches = new Set<Promise<void>>();

  const dispatch = async (request: IncomingMessage, response: ServerResponse, origin: string): Promise<void> => {
    setSecurityHeaders(response);
    const originUrl = new URL(origin);
    const port = originUrl.port;
    if (originUrl.protocol !== "http:" || !/^\d+$/.test(port) || !isExactLoopbackHost(request, Number(port)))
      return sendProblem(response, 421, "invalid_request");
    if (closed) return sendProblem(response, 503, "runtime_unavailable");
    const url = new URL(request.url ?? "/", origin);

    // ---- GET /api/tavern/v1/chats ----------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/tavern/v1/chats") {
      if (!mounted("chat.list")) return sendProblem(response, 404, "profile_operation_unavailable");
      if (await hasRequestBody(request)) return sendProblem(response, 400, "invalid_request");
      const apiVersions = url.searchParams.getAll("apiVersion");
      const states = url.searchParams.getAll("state");
      if (apiVersions.length > 1 || states.length > 1) return sendProblem(response, 400, "invalid_request");
      const apiVersion = apiVersions[0] === undefined ? 1 : Number(apiVersions[0]);
      if (!Number.isInteger(apiVersion) || apiVersion !== 1) return sendProblem(response, 400, "invalid_request");
      if (!isBrowserSameOriginRead(request, origin)) return sendProblem(response, 401, "unauthorized");
      const context = verifyComposedReferenceGameBrowserAuth(capability, request, origin);
      if (context === null) return sendProblem(response, 401, "unauthorized");
      const state = states[0];
      const query: ChatListQueryV1 = (state === undefined ? { apiVersion: 1 } : { apiVersion: 1, state: state as "active" }) as ChatListQueryV1;
      if (!TavernBrowserValidatorsV1.ChatListQueryV1Schema.Check(query as unknown))
        return sendProblem(response, 400, "invalid_request");
      let list;
      try {
        list = await managementService.listChats(query);
      } catch {
        return sendProblem(response, 409, "state_reconciliation_required");
      }
      if (!TavernBrowserValidatorsV1.ChatListV1Schema.Check(JSON.parse(JSON.stringify(list))))
        return sendProblem(response, 409, "state_reconciliation_required");
      return sendJson(response, 200, list);
    }

    // ---- GET /api/tavern/v1/memory ------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/tavern/v1/memory") {
      if (!mounted("memory.read")) return sendProblem(response, 404, "profile_operation_unavailable");
      if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
      if (!isBrowserSameOriginRead(request, origin)) return sendProblem(response, 401, "unauthorized");
      if (verifyComposedReferenceGameBrowserAuth(capability, request, origin) === null)
        return sendProblem(response, 401, "unauthorized");
      const memory: MemoryReadV1 = await memoryService.read();
      if (!TavernBrowserValidatorsV1.MemoryReadV1Schema.Check(memory))
        return sendProblem(response, 409, "state_reconciliation_required");
      return sendJson(response, 200, memory);
    }

    // ---- PUT /api/tavern/v1/memory ------------------------------------------------
    if (request.method === "PUT" && url.pathname === "/api/tavern/v1/memory") {
      if (!mountedMutation("memory.mutate", "memory.mutate") || memoryService.mutate === undefined)
        return sendProblem(response, 404, "profile_operation_unavailable");
      if (!isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
      const context = verifyComposedReferenceGameBrowserAuth(capability, request, origin);
      if (context === null) return sendProblem(response, 401, "unauthorized");
      if (!checkComposedReferenceGameBrowserAuthCsrf(context, request)) return sendProblem(response, 403, "csrf_failed");
      const body = await readJsonBody(request, 24 * 1024);
      if (!TavernBrowserValidatorsV1.MemoryMutationCommandV1Schema.Check(body))
        return sendProblem(response, 400, "invalid_request");
      const result = await memoryService.mutate(body as MemoryMutationCommandV1);
      if (!TavernBrowserValidatorsV1.MemoryMutationResultV1Schema.Check(result))
        return sendProblem(response, 409, "state_reconciliation_required");
      return sendJson(response, 200, result);
    }

    // ---- GET /api/tavern/v1/world-info ----------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/tavern/v1/world-info") {
      if (!mounted("world-info.read")) return sendProblem(response, 404, "profile_operation_unavailable");
      if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
      if (!isBrowserSameOriginRead(request, origin)) return sendProblem(response, 401, "unauthorized");
      if (verifyComposedReferenceGameBrowserAuth(capability, request, origin) === null)
        return sendProblem(response, 401, "unauthorized");
      const worldInfo: WorldInfoStateV1 = await worldInfoService.read() as WorldInfoStateV1;
      if (!TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check(JSON.parse(JSON.stringify(worldInfo))))
        return sendProblem(response, 409, "state_reconciliation_required");
      return sendJson(response, 200, worldInfo);
    }

    // ---- PUT /api/tavern/v1/world-info ----------------------------------------------
    if (request.method === "PUT" && url.pathname === "/api/tavern/v1/world-info") {
      if (!mountedMutation("world-info.bind", "world-info.bind")) return sendProblem(response, 404, "profile_operation_unavailable");
      if (!isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
      const context = verifyComposedReferenceGameBrowserAuth(capability, request, origin);
      if (context === null) return sendProblem(response, 401, "unauthorized");
      if (!checkComposedReferenceGameBrowserAuthCsrf(context, request)) return sendProblem(response, 403, "csrf_failed");
      const body = await readJsonBody(request, 24 * 1024);
      if (!TavernBrowserValidatorsV1.SetWorldInfoBindingCommandV1Schema.Check(body))
        return sendProblem(response, 400, "invalid_request");
      const result = await worldInfoService.setBinding(body as SetWorldInfoBindingCommandV1);
      if (!TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check(result))
        return sendProblem(response, 409, "state_reconciliation_required");
      return sendJson(response, 200, result);
    }

    // ---- GET /api/tavern/v1/settings/voice-preference ---------------------------------
    if (request.method === "GET" && url.pathname === "/api/tavern/v1/settings/voice-preference") {
      if (!mounted("settings.voice.read") || playerPreferenceStore === undefined)
        return sendProblem(response, 404, "profile_operation_unavailable");
      if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
      if (!isBrowserSameOriginRead(request, origin)) return sendProblem(response, 401, "unauthorized");
      if (verifyComposedReferenceGameBrowserAuth(capability, request, origin) === null)
        return sendProblem(response, 401, "unauthorized");
      const preference = await playerPreferenceStore.read();
      const voice = {
        revision: preference.revision ?? 0,
        disclosureVersion: preference.disclosureVersion ?? null,
        consent: preference.consent,
        decidedAtMs: preference.decidedAtMs ?? null,
        outputDevice: preference.outputDevice ?? null,
      };
      if (!TavernBrowserValidatorsV1.TavernVoicePreferenceV1Schema.Check(voice))
        return sendProblem(response, 409, "state_reconciliation_required");
      return sendJson(response, 200, voice);
    }

    // ---- GET /api/tavern/v1/settings/language ----------------------------------------
    if (request.method === "GET" && url.pathname === "/api/tavern/v1/settings/language") {
      if (!mounted("settings.language.read") || playerPreferenceStore === undefined)
        return sendProblem(response, 404, "profile_operation_unavailable");
      if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
      if (!isBrowserSameOriginRead(request, origin)) return sendProblem(response, 401, "unauthorized");
      if (verifyComposedReferenceGameBrowserAuth(capability, request, origin) === null)
        return sendProblem(response, 401, "unauthorized");
      const preference = await playerPreferenceStore.read();
      return sendJson(response, 200, { revision: preference.revision ?? 0, locale: preference.locale ?? null });
    }

    return sendProblem(response, 404, "profile_operation_unavailable");
  };

  return Object.freeze({
    handle(request: IncomingMessage, response: ServerResponse, origin: string): void {
      const active = dispatch(request, response, origin);
      activeDispatches.add(active);
      void active.finally(() => activeDispatches.delete(active));
    },
    async close(): Promise<void> {
      closed = true;
      await Promise.allSettled([...activeDispatches]);
    },
  });
}