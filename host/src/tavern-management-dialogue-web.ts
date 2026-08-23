import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import {
  type ChatListQueryV1,
  type ComposedTavernProfile,
  type DiscardDraftCommandV1,
  type MemoryMutationCommandV1,
  type MemoryReadV1,
  type RenameChatTitleCommandV1,
  type SaveDraftCommandV1,
  type SetWorldInfoBindingCommandV1,
  isComposedTavernProfile,
  TAVERN_BROWSER_API_V1,
  TavernBrowserContractV1,
  type TavernBrowserNavigationItemIdV1,
  TavernBrowserValidatorsV1,
  type TavernProblemV1,
  type TavernStateSnapshotV1,
  type WorldInfoStateV1,
} from "./tavern/browser-contract/index.js";
import type { ChatManagementService } from "./tavern/chat-management/chat-management-service.js";
import type { MemoryManagementService } from "./tavern/memory-management/memory-management.js";
import type { TavernManagementStateFacade } from "./tavern/tavern-management-state.js";
import type {
  WorldInfoBindingManagementService,
  WorldInfoStateV1 as ManagedWorldInfoStateV1,
} from "./tavern/world-info-binding/world-info-binding-management-service.js";

const LOOPBACK_HOST = "127.0.0.1";
const BROWSER_TTL_MS = 2 * 60 * 60_000;
// A Memory command may carry the full 4096-byte content field plus JSON
// envelope, opaque handles, and revision. Bound the complete request while
// still admitting every contract-valid command.
const MAX_BODY_BYTES = 5 * 1024;
const MANAGEMENT_PROFILE_ID = "gamebuddy.tavern-management.chat-list-title";
const MANAGEMENT_RELEASE_TIER = "tavern_management";
const MANAGEMENT_ROUTE_IDS = [
  "bootstrap",
  "state.read",
  "draft.read",
  "draft.save",
  "draft.discard",
  "chat.list",
  "chat.rename",
  "memory.read",
  "memory.mutate",
  "world-info.read",
  "world-info.bind",
] as const;
const MANAGEMENT_ROUTE_IDS_WITHOUT_MEMORY = [
  "bootstrap",
  "state.read",
  "draft.read",
  "draft.save",
  "draft.discard",
  "chat.list",
  "chat.rename",
  "world-info.read",
  "world-info.bind",
] as const;
const MANAGEMENT_OPERATION_IDS_WITH_MEMORY = ["draft.save", "draft.discard", "chat.rename", "memory.mutate", "world-info.bind"] as const;
const MANAGEMENT_OPERATION_IDS_WITHOUT_MEMORY = ["draft.save", "draft.discard", "chat.rename", "world-info.bind"] as const;
// Legal navigation projections paired with the route sets above: a profile
// that declares `memory.read` must also declare the `memory` navigation item,
// and a profile without the Memory route must not. Both derive from the same
// production profile (`gamebuddy.tavern-management.chat-list-title`).
const MANAGEMENT_NAVIGATION_ITEM_IDS_WITHOUT_MEMORY = ["chat"] as const;
const MANAGEMENT_NAVIGATION_ITEM_IDS_WITH_MEMORY = ["chat", "memory"] as const;
const bootstrapRequestValidator = Compile(
  (TavernBrowserContractV1.routes.find((route) => route.routeId === "bootstrap")! as { request: TSchema }).request,
);
const listQueryValidator = Compile(TavernBrowserContractV1.schemas.ChatListQueryV1Schema);
const draftSaveValidator = Compile(TavernBrowserContractV1.schemas.SaveDraftCommandV1Schema);
const draftDiscardValidator = Compile(TavernBrowserContractV1.schemas.DiscardDraftCommandV1Schema);
const renameRequestValidator = Compile(TavernBrowserContractV1.schemas.RenameChatTitleCommandV1Schema);
const worldInfoBindValidator = Compile(TavernBrowserContractV1.schemas.SetWorldInfoBindingCommandV1Schema);
const memoryMutationValidator = Compile(TavernBrowserContractV1.schemas.MemoryMutationCommandV1Schema);

export type TavernManagementDialogueWebOptions = Readonly<{
  managementStateFacade?: TavernManagementStateFacade;
  managementService?: ChatManagementService;
  memoryService?: MemoryManagementService;
  worldInfoService?: WorldInfoBindingManagementService;
  profile?: ComposedTavernProfile;
  bootstrapToken?: string;
  readonly [key: string]: unknown;
}>;
export type TavernManagementDialogueWebServer = Readonly<{
  origin: string;
  closeAllConnections(): void;
  close(): Promise<void>;
}>;
export type TavernManagementDialogueWebRequestHandler = Readonly<{
  handle(request: IncomingMessage, response: ServerResponse, origin: string): void;
  /** Rejects future API work and drains facade reads already admitted. */
  close(): Promise<void>;
}>;
type BrowserSession = Readonly<{
  bearer: string;
  csrf: string;
  expiresAtMs: number;
}>;
type ProblemCode = TavernProblemV1["code"];

/**
 * Closed dispatcher for the independent tavern_management profile. It mounts
 * only `bootstrap`, `state.read`, draft read/save/discard, `chat.list` and `chat.rename`; the frozen
 * five-route reference profile and dispatcher are untouched, and no route
 * outside the exact management profile can ever be admitted here.
 */
export function createTavernManagementDialogueWebRequestHandler(
  options: TavernManagementDialogueWebOptions,
): TavernManagementDialogueWebRequestHandler {
  if (options.profile === undefined || options.bootstrapToken === undefined)
    throw new Error("tavern_management_composition_unavailable");
  const managementStateFacade = options.managementStateFacade;
  const managementService = options.managementService;
  const memoryService = options.memoryService;
  const worldInfoService = options.worldInfoService;
  const profile = options.profile;
  const bootstrapToken = options.bootstrapToken;
  if (managementStateFacade === undefined || managementService === undefined)
    throw new Error("tavern_management_composition_unavailable");
  assertManagementProfile(profile);
  // The production profile declares `memory.read`; it is reachable only when a
  // Host-owned MemoryManagementService is injected. A profile that advertises
  // the capability without the bound service fails closed before any route.
  if ((profile.routeIds.includes("memory.read") || profile.routeIds.includes("memory.mutate")) && memoryService === undefined)
    throw new Error("tavern_management_composition_unavailable");
  // The World Info routes are mounted only when the exact binding service is
  // injected; a profile that advertises either route without the bound
  // service fails closed before any dispatch.
  if (
    (profile.routeIds.includes("world-info.read") || profile.routeIds.includes("world-info.bind")) &&
    worldInfoService === undefined
  )
    throw new Error("tavern_management_composition_unavailable");
  if (!isOpaqueHandle(bootstrapToken)) throw new Error("tavern_management_bootstrap_token_invalid");

  let browser: BrowserSession | undefined;
  let bootstrapUsed = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const activeDispatches = new Set<Promise<void>>();
  const dispatch = async (request: IncomingMessage, response: ServerResponse, origin: string): Promise<void> => {
    setSecurityHeaders(response);
    const port = new URL(origin).port;
    if (new URL(origin).protocol !== "http:" || !/^\d+$/.test(port) || !isExactLoopbackHost(request, Number(port)))
      return sendProblem(response, 421, "invalid_request");
    if (closed) return sendProblem(response, 503, "runtime_unavailable");
    const url = new URL(request.url ?? "/", origin);
    try {
      if (request.method === "POST" && url.pathname === "/api/tavern/v1/bootstrap") {
        if (url.search !== "") return sendProblem(response, 400, "invalid_request");
        if (!isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
        const body = await readJsonBody(request, MAX_BODY_BYTES);
        if (!bootstrapRequestValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
        const bootstrap = body as Readonly<{ bootstrapToken: string }>;
        if (bootstrapUsed || !tokensEqual(bootstrap.bootstrapToken, bootstrapToken))
          return sendProblem(response, 401, "unauthorized");
        bootstrapUsed = true;
        const session = Object.freeze({
          bearer: randomToken(),
          csrf: randomToken(),
          expiresAtMs: Date.now() + BROWSER_TTL_MS,
        });
        browser = session;
        response.setHeader("Set-Cookie", `gb_tavern_session=${session.bearer}; HttpOnly; SameSite=Strict; Path=/`);
        return await sendProjectedSnapshot(response, managementStateFacade, profile, session, memoryService, worldInfoService);
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/state") {
        if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        return await sendProjectedSnapshot(response, managementStateFacade, profile, session, memoryService, worldInfoService);
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/world-info") {
        if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        if (!profile.routeIds.includes("world-info.read") || worldInfoService === undefined)
          return sendProblem(response, 404, "profile_operation_unavailable");
        const worldInfo = await worldInfoService.read();
        if (!TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check(worldInfo))
          throw new Error("world_info_binding_service_unavailable");
        return sendJson(response, 200, worldInfo);
      }
      if (request.method === "PUT" && url.pathname === "/api/tavern/v1/world-info") {
        if (url.search !== "" || !isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        const csrfHeader = singleHeader(request.headers["x-csrf-token"]);
        if (csrfHeader === null) return sendProblem(response, 400, "invalid_request");
        if (!tokensEqual(csrfHeader, session.csrf)) return sendProblem(response, 403, "csrf_failed");
        if (
          !profile.routeIds.includes("world-info.bind") ||
          !profile.operationIds.includes("world-info.bind") ||
          worldInfoService === undefined
        )
          return sendProblem(response, 404, "profile_operation_unavailable");
        const body = await readJsonBody(request, MAX_BODY_BYTES);
        if (!worldInfoBindValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
        const worldInfo = await worldInfoService.setBinding(body as SetWorldInfoBindingCommandV1);
        if (!TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check(worldInfo))
          throw new Error("world_info_binding_service_unavailable");
        return sendJson(response, 200, worldInfo);
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/draft") {
        if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        const draft = await managementService.readDraft();
        if (!TavernBrowserValidatorsV1.BrowserDraftV1Schema.Check(draft))
          throw new Error("chat_management_service_unavailable");
        return sendJson(response, 200, draft);
      }
      if (request.method === "PUT" && url.pathname === "/api/tavern/v1/draft") {
        if (url.search !== "" || !isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        if (!tokensEqual(singleHeader(request.headers["x-csrf-token"]) ?? "", session.csrf))
          return sendProblem(response, 403, "csrf_failed");
        const body = await readJsonBody(request, MAX_BODY_BYTES);
        if (!draftSaveValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
        const draft = await managementService.saveDraft(body as SaveDraftCommandV1);
        if (!TavernBrowserValidatorsV1.BrowserDraftV1Schema.Check(draft))
          throw new Error("chat_management_service_unavailable");
        return sendJson(response, 200, draft);
      }
      if (request.method === "DELETE" && url.pathname === "/api/tavern/v1/draft") {
        if (url.search !== "" || !isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        if (!tokensEqual(singleHeader(request.headers["x-csrf-token"]) ?? "", session.csrf))
          return sendProblem(response, 403, "csrf_failed");
        const body = await readJsonBody(request, MAX_BODY_BYTES);
        if (!draftDiscardValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
        const draft = await managementService.discardDraft(body as DiscardDraftCommandV1);
        if (!TavernBrowserValidatorsV1.BrowserDraftV1Schema.Check(draft))
          throw new Error("chat_management_service_unavailable");
        return sendJson(response, 200, draft);
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/chats") {
        if (await hasRequestBody(request)) return sendProblem(response, 400, "invalid_request");
        if (authenticate(request, browser, origin) === null) return sendProblem(response, 401, "unauthorized");
        const queryValue: Record<string, string | number> = {};
        const seen = new Set<string>();
        for (const [key, value] of url.searchParams) {
          if (seen.has(key) || (key !== "apiVersion" && key !== "state"))
            return sendProblem(response, 400, "invalid_request");
          seen.add(key);
          // Query parameters are strings on the wire; the contract keeps the
          // integer apiVersion literal, so the dispatcher parses it exactly.
          queryValue[key] = key === "apiVersion" ? Number(value) : value;
        }
        if (!listQueryValidator.Check(queryValue)) return sendProblem(response, 400, "invalid_request");
        const list = await managementService.listChats(queryValue as ChatListQueryV1);
        if (!TavernBrowserValidatorsV1.ChatListV1Schema.Check(list))
          throw new Error("chat_management_service_unavailable");
        return sendJson(response, 200, list);
      }
      if (request.method === "PUT" && url.pathname === "/api/tavern/v1/chat/title") {
        if (url.search !== "" || !isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        const csrfHeader = singleHeader(request.headers["x-csrf-token"]);
        if (csrfHeader === null) return sendProblem(response, 400, "invalid_request");
        if (!tokensEqual(csrfHeader, session.csrf)) return sendProblem(response, 403, "csrf_failed");
        const body = await readJsonBody(request, MAX_BODY_BYTES);
        if (!renameRequestValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
        const result = await managementService.renameChatTitle(body as RenameChatTitleCommandV1);
        if (!TavernBrowserValidatorsV1.ChatTitleV1Schema.Check(result))
          throw new Error("chat_management_service_unavailable");
        return sendJson(response, 200, result);
      }
      if (request.method === "PUT" && url.pathname === "/api/tavern/v1/memory") {
        if (url.search !== "" || !isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        if (!tokensEqual(singleHeader(request.headers["x-csrf-token"]) ?? "", session.csrf))
          return sendProblem(response, 403, "csrf_failed");
        if (
          !profile.routeIds.includes("memory.mutate") ||
          !profile.operationIds.includes("memory.mutate") ||
          memoryService === undefined ||
          memoryService.mutate === undefined
        )
          return sendProblem(response, 404, "profile_operation_unavailable");
        const body = await readJsonBody(request, MAX_BODY_BYTES);
        if (!memoryMutationValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
        const memory = await memoryService.mutate(body as MemoryMutationCommandV1);
        if (!TavernBrowserValidatorsV1.MemoryMutationResultV1Schema.Check(memory))
          throw new Error("memory_read_service_unavailable");
        return sendJson(response, 200, memory);
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/memory") {
        if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
        if (authenticate(request, browser, origin) === null) return sendProblem(response, 401, "unauthorized");
        if (!profile.routeIds.includes("memory.read") || memoryService === undefined)
          return sendProblem(response, 404, "profile_operation_unavailable");
        const memory: MemoryReadV1 = await memoryService.read();
        if (!TavernBrowserValidatorsV1.MemoryReadV1Schema.Check(memory))
          throw new Error("memory_read_service_unavailable");
        return sendJson(response, 200, memory);
      }
      return sendProblem(response, 404, "profile_operation_unavailable");
    } catch (error) {
      const { status, code } = problemFor(error);
      if (!response.writableEnded && !response.destroyed) return sendProblem(response, status, code);
    }
  };
  return Object.freeze({
    handle(request, response, origin) {
      const active = dispatch(request, response, origin);
      activeDispatches.add(active);
      void active.finally(() => activeDispatches.delete(active));
    },
    async close() {
      closePromise ??= (async () => {
        closed = true;
        browser = undefined;
        await Promise.allSettled([...activeDispatches]);
        await managementService.close();
        await memoryService?.close();
        // The binding service's close is idempotent; the handler drain above
        // guarantees it runs only after admitted dispatches have settled.
        await worldInfoService?.close();
      })();
      await closePromise;
    },
  });
}

/** Standalone management API listener, retained for API-level tests and diagnostics. */
export async function startTavernManagementDialogueWebServer(
  options: TavernManagementDialogueWebOptions,
): Promise<TavernManagementDialogueWebServer> {
  const handler = createTavernManagementDialogueWebRequestHandler(options);
  let closed = false;
  const server = createServer((request, response) => {
    const port = (server.address() as { port: number }).port;
    handler.handle(request, response, `http://${LOOPBACK_HOST}:${port}`);
  });
  const port = await listenLoopback(server);
  return Object.freeze({
    origin: `http://${LOOPBACK_HOST}:${port}`,
    closeAllConnections: () => server.closeAllConnections(),
    async close() {
      if (closed) return;
      closed = true;
      const handlerDrain = handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await handlerDrain;
    },
  });
}

async function sendProjectedSnapshot(
  response: ServerResponse,
  facade: TavernManagementStateFacade,
  profile: ComposedTavernProfile,
  browser: BrowserSession,
  memoryService?: MemoryManagementService,
  worldInfoService?: WorldInfoBindingManagementService,
): Promise<void> {
  const [state, memoryResult] = await Promise.all([
    facade.read(),
    profile.routeIds.includes("memory.read") && memoryService !== undefined
      ? memoryService.read().catch(() => undefined)
      : undefined,
  ]);
  const memoryProjection = memoryResult !== undefined
    ? ({
        readAvailable: true as const,
        mutationAvailable: profile.routeIds.includes("memory.mutate") && profile.operationIds.includes("memory.mutate"),
        projectionRevision: memoryResult.projectionRevision,
      } as const)
    : ({ readAvailable: false as const, mutationAvailable: false as const, projectionRevision: null } as const);
  // A World Info-capable profile always projects a validated World Info
  // state: the facade supplies it in production; handler-level stubs obtain
  // it from the bound service and it is re-validated before projection.
  let worldInfo: WorldInfoStateV1 | null = state.worldInfo;
  if (profile.routeIds.includes("world-info.read") && worldInfo === null && worldInfoService !== undefined) {
    worldInfo = toWorldInfoStateV1(await worldInfoService.read());
  }
  if (
    profile.routeIds.includes("world-info.read") &&
    (worldInfo === null || !TavernBrowserValidatorsV1.WorldInfoStateV1Schema.Check(worldInfo))
  )
    throw new Error("world_info_binding_service_unavailable");
  if (!profile.routeIds.includes("world-info.read") && worldInfo !== null)
    throw new Error("world_info_binding_service_unavailable");
  const snapshot = {
    apiVersion: 1,
    build: {
      browserContract: TAVERN_BROWSER_API_V1,
      profileId: profile.profileId,
    },
    csrfToken: browser.csrf,
    browserSession: { expiresAtMs: browser.expiresAtMs },
    operations: [...state.operations],
    navigation: profile.navigationItemIds.map((itemId) => navigationItem(itemId, memoryProjection.readAvailable)),
    selection: state.selection,
    chat: {
      companion: { name: state.companionDisplayName },
      title: state.title,
      transcript: [...state.transcript],
      draft: {
        revision: state.draft.revision,
        present: state.draft.text !== null,
      },
      turn: state.turn,
      worldInfo,
    },
    memory: memoryProjection,
    eventStream: null,
  } satisfies TavernStateSnapshotV1;
  if (!TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check(snapshot))
    return sendProblem(response, 409, "state_reconciliation_required");
  return sendJson(response, 200, snapshot);
}

function navigationItem(itemId: TavernBrowserNavigationItemIdV1, memoryReadAvailable: boolean) {
  if (itemId === "chat")
    return {
      itemId,
      labelKey: "tavern.nav.chat" as const,
      availability: "available" as const,
    };
  // The Memory navigation item is projected only when the mounted profile
  // declares it AND the exact-bound read actually succeeded; it never claims
  // capability on false read availability.
  return {
    itemId,
    labelKey: "tavern.nav.memory" as const,
    availability: memoryReadAvailable ? ("available" as const) : ("unavailable" as const),
  };
}

function assertManagementProfile(profile: ComposedTavernProfile): void {
  // Canonical WeakSet identity gate (same authority as the binding service
  // and state facade): an Object.freeze structural clone of a composed
  // profile has the exact management shape but is never branded by
  // composeTavernProfile, so this HTTP ingress rejects it before any dispatch
  // or injected-service use. The exact shape checks below still apply.
  if (!isComposedTavernProfile(profile)) throw new Error("tavern_management_profile_operation_unavailable");
  const mutableMemory =
    profile.profileId === MANAGEMENT_PROFILE_ID &&
    profile.releaseTier === MANAGEMENT_RELEASE_TIER &&
    sameOrderedValues(profile.routeIds, MANAGEMENT_ROUTE_IDS) &&
    sameOrderedValues(profile.operationIds, MANAGEMENT_OPERATION_IDS_WITH_MEMORY) &&
    sameOrderedValues(profile.navigationItemIds, MANAGEMENT_NAVIGATION_ITEM_IDS_WITH_MEMORY);
  const readOnlyMemory =
    profile.profileId === MANAGEMENT_PROFILE_ID &&
    profile.releaseTier === MANAGEMENT_RELEASE_TIER &&
    sameOrderedValues(
      profile.routeIds,
      MANAGEMENT_ROUTE_IDS.filter((routeId) => routeId !== "memory.mutate"),
    ) &&
    sameOrderedValues(profile.operationIds, MANAGEMENT_OPERATION_IDS_WITHOUT_MEMORY) &&
    sameOrderedValues(profile.navigationItemIds, MANAGEMENT_NAVIGATION_ITEM_IDS_WITH_MEMORY);
  const withoutMemory =
    profile.profileId === MANAGEMENT_PROFILE_ID &&
    profile.releaseTier === MANAGEMENT_RELEASE_TIER &&
    sameOrderedValues(profile.routeIds, MANAGEMENT_ROUTE_IDS_WITHOUT_MEMORY) &&
    sameOrderedValues(profile.operationIds, MANAGEMENT_OPERATION_IDS_WITHOUT_MEMORY) &&
    sameOrderedValues(profile.navigationItemIds, MANAGEMENT_NAVIGATION_ITEM_IDS_WITHOUT_MEMORY);
  // A memory-capable profile must declare the Memory navigation item and the
  // inverse (Memory route but no Memory navigation) fails closed.
  if (!mutableMemory && !readOnlyMemory && !withoutMemory)
    throw new Error("tavern_management_profile_operation_unavailable");
}

function sameOrderedValues(values: readonly string[], expected: readonly string[]): boolean {
  return values.length === expected.length && values.every((value, index) => value === expected[index]);
}

function problemFor(error: unknown): Readonly<{ status: number; code: ProblemCode }> {
  const message = error instanceof Error ? error.message : "";
  if (message === "invalid_request") return { status: 400, code: "invalid_request" };
  if (message === "chat_management_selection_conflict") return { status: 409, code: "selection_conflict" };
  if (message === "chat_management_revision_conflict") return { status: 409, code: "draft_conflict" };
  if (message === "world_info_binding_conflict" || message === "world_info_binding_locked")
    return { status: 409, code: "state_reconciliation_required" };
  if (
    message === "world_info_binding_service_unavailable" ||
    message === "world_info_binding_service_closed"
  )
    return { status: 503, code: "runtime_unavailable" };
  if (message === "world_info_binding_storage_unavailable") return { status: 503, code: "storage_unavailable" };
  if (message === "chat_management_service_unavailable" || message === "chat_management_service_closed")
    return { status: 503, code: "runtime_unavailable" };
  if (message === "memory_read_service_unavailable" || message === "memory_read_unavailable")
    return { status: 503, code: "runtime_unavailable" };
  if (message === "memory_read_storage_unavailable") return { status: 503, code: "storage_unavailable" };
  if (message === "memory_mutation_conflict" || message === "memory_projection_conflict")
    return { status: 409, code: "state_reconciliation_required" };
  if (message === "invalid_request") return { status: 400, code: "invalid_request" };
  if (/storage|sqlite|eio|enoent/i.test(message)) return { status: 503, code: "storage_unavailable" };
  if (/runtime|lease|mount/i.test(message)) return { status: 503, code: "runtime_unavailable" };
  return { status: 409, code: "state_reconciliation_required" };
}

/**
 * Contract-shaped copy of the binding service's readonly World Info
 * projection; the exact snapshot facts are revalidated by the frozen schema
 * before any response is written.
 */
function toWorldInfoStateV1(value: ManagedWorldInfoStateV1): WorldInfoStateV1 {
  return {
    state: value.state,
    revision: value.revision,
    items: value.items.map((item) => ({
      handle: item.handle,
      title: item.title,
      summary: item.summary,
      selected: item.selected,
    })),
  };
}

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== LOOPBACK_HOST)
    throw new Error("dialogue_loopback_bind_failed");
  return address.port;
}
async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")) throw new Error("invalid_request");
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maxBytes))
    throw new Error("invalid_request");
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if ((bytes += part.length) > maxBytes) throw new Error("invalid_request");
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new Error("invalid_request");
  }
}

async function hasRequestBody(request: IncomingMessage): Promise<boolean> {
  const contentLength = request.headers["content-length"];
  let hasBody = contentLength !== undefined && contentLength !== "0";
  for await (const chunk of request) {
    if ((Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)) > 0) hasBody = true;
  }
  return hasBody;
}
function authenticate(
  request: IncomingMessage,
  browser: BrowserSession | undefined,
  origin: string,
): BrowserSession | null {
  if (
    browser === undefined ||
    browser.expiresAtMs < Date.now() ||
    !isBrowserSameOriginRead(request, origin) ||
    !tokensEqual(cookie(request.headers.cookie, "gb_tavern_session") ?? "", browser.bearer)
  )
    return null;
  return browser;
}
function isSameOrigin(request: IncomingMessage, origin: string): boolean {
  return request.headers.origin === origin;
}
/**
 * Browsers do not permit script to set Origin and may omit it on same-origin
 * safe-method fetches. A management read therefore accepts an exact Origin
 * when it exists, or an origin-less browser same-origin Fetch Metadata
 * request. It still requires the unguessable Strict browser-session cookie.
 */
function isBrowserSameOriginRead(request: IncomingMessage, origin: string): boolean {
  const requestOrigin = request.headers.origin;
  if (requestOrigin !== undefined) return requestOrigin === origin;
  return request.headers["sec-fetch-site"] === "same-origin";
}
function sendProblem(response: ServerResponse, status: number, code: ProblemCode): void {
  const problem: TavernProblemV1 = {
    type: `urn:gamebuddy:tavern:${code}`,
    title: code.replaceAll("_", " "),
    status,
    code,
    requestId: randomToken(),
    retryable: code === "storage_unavailable" || code === "runtime_unavailable",
  };
  if (!TavernBrowserValidatorsV1.TavernProblemV1Schema.Check(problem)) throw new Error("invalid_problem");
  response.writeHead(status, {
    "Content-Type": "application/problem+json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(problem));
}
function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
}
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}
function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}
function isExactLoopbackHost(request: IncomingMessage, port: number): boolean {
  return request.headers.host === `${LOOPBACK_HOST}:${port}`;
}
function randomToken(): string {
  return randomBytes(32).toString("base64url");
}
function isOpaqueHandle(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}
function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function cookie(header: string | undefined, name: string): string | undefined {
  return header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
