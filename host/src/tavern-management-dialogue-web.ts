import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { VoicePreference, VoicePreferenceUpdate } from "./settings/voice-preference-store.js";
import type { LanguagePreference, LanguagePreferenceUpdate } from "./settings/language-preference-store.js";
import {
  type ChatListQueryV1,
  type ChatRetentionCommandV1,
  type CompanionDetailV1,
  type CompanionListV1,
  type ComposedTavernProfile,
  type CreateCompanionCommandV1,
  type DiscardDraftCommandV1,
  type GreetingUpdateCommandV1,
  type GreetingV1,
  isComposedTavernProfile,
  type MemoryMutationCommandV1,
  type MemoryReadV1,
  type PersonaUpdateCommandV1,
  type PersonaV1,
  type RenameChatTitleCommandV1,
  type SaveDraftCommandV1,
  type ScenarioUpdateCommandV1,
  type ScenarioV1,
  type SetWorldInfoBindingCommandV1,
  TAVERN_BROWSER_API_V1,
  TAVERN_BROWSER_API_VERSION,
  TavernBrowserContractV1,
  type TavernBrowserNavigationItemIdV1,
  TavernBrowserValidatorsV1,
  type TavernConnectionCreateCommandV1,
  type TavernConnectionModelCommandV1,
  type TavernConnectionRevisionCommandV1,
  type TavernLanguagePreferenceCommandV1,
  type TavernLanguagePreferenceV1,
  type TavernProblemV1,
  type TavernStateSnapshotV1,
  type TavernVoicePreferenceConsentCommandV1,
  type TavernVoicePreferenceV1,
  type TavernVoiceDevicesV1,
  type WorldInfoStateV1,
} from "./tavern/browser-contract/index.js";
import type { ChatManagementService } from "./tavern/chat-management/chat-management-service.js";
import type { MemoryManagementService } from "./tavern/memory-management/memory-management.js";
import type { TavernConnectionService } from "./tavern/connection-service.js";
import type { TavernManagementStateFacade } from "./tavern/tavern-management-state.js";
import type {
  WorldInfoStateV1 as ManagedWorldInfoStateV1,
  WorldInfoBindingManagementService,
} from "./tavern/world-info-binding/world-info-binding-management-service.js";

const LOOPBACK_HOST = "127.0.0.1";
const BROWSER_TTL_MS = 2 * 60 * 60_000;
// Draft and message text may carry up to 16 KiB of UTF-8 content plus their
// JSON envelope and opaque handles. Bound the complete request while still
// admitting every contract-valid management command.
export const MAX_BODY_BYTES = 24 * 1024;
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
  "settings.voice.read",
  "settings.voice.consent",
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
  "settings.voice.read",
  "settings.voice.consent",
] as const;
/** Optional language-preference extension: only profiles that declare these
 * routes mount the Tavern language read/update API; other profiles keep the
 * exact legacy surface. A profile advertising them without the Host store
 * fails closed at composition. */
const MANAGEMENT_LANGUAGE_ROUTES = [
  "settings.language.read",
  "settings.language.update",
] as const;
const MANAGEMENT_OPERATION_IDS_WITH_MEMORY = [
  "draft.save",
  "draft.discard",
  "chat.rename",
  "memory.mutate",
  "world-info.bind",
  "settings.voice.read",
  "settings.voice.consent",
] as const;
const MANAGEMENT_OPERATION_IDS_WITHOUT_MEMORY = [
  "draft.save",
  "draft.discard",
  "chat.rename",
  "world-info.bind",
  "settings.voice.read",
  "settings.voice.consent",
] as const;
/** Optional read-only output-device enumeration route/operation (paired with voice read/consent). */
const MANAGEMENT_VOICE_DEVICES = ["settings.voice.devices"] as const;
// Legal navigation projections paired with the route sets above: a profile
// that declares `memory.read` must also declare the `memory` navigation item,
// and a profile without the Memory route must not. Both derive from the same
// production profile (`gamebuddy.tavern-management.chat-list-title`).
/** Optional connection-management extension: only profiles declaring these
 * routes mount the read/create/test/activate/model/remove API. A profile that
 * advertises a route without the exact service fails closed at composition. */
const MANAGEMENT_CONNECTION_ROUTES = [
  "settings.connection.read",
  "settings.connection.create",
  "settings.connection.test",
  "settings.connection.activate",
  "settings.connection.model",
  "settings.connection.remove",
] as const;
const MANAGEMENT_NAVIGATION_ITEM_IDS_WITHOUT_MEMORY = ["chat", "characters"] as const;
const MANAGEMENT_NAVIGATION_ITEM_IDS_WITH_MEMORY = ["chat", "memory", "characters"] as const;
/** Legacy navigation variants before the Characters surface (no characters item). */
const MANAGEMENT_NAVIGATION_ITEM_IDS_LEGACY_WITHOUT_MEMORY = ["chat"] as const;
const MANAGEMENT_NAVIGATION_ITEM_IDS_LEGACY_WITH_MEMORY = ["chat", "memory"] as const;
/** Optional Character / Persona / Scenario / Greeting / retention extension. */
const MANAGEMENT_P9_ROUTES = [
  "companion.list",
  "companion.detail",
  "companion.create",
  "persona.read",
  "persona.update",
  "scenario.read",
  "scenario.update",
  "greeting.read",
  "greeting.update",
  "chat.archive",
  "chat.restore",
  "chat.trash",
] as const;
const bootstrapRequestValidator = Compile(
  (TavernBrowserContractV1.routes.find((route) => route.routeId === "bootstrap")! as { request: TSchema }).request,
);
const listQueryValidator = Compile(TavernBrowserContractV1.schemas.ChatListQueryV1Schema);
const draftSaveValidator = Compile(TavernBrowserContractV1.schemas.SaveDraftCommandV1Schema);
const draftDiscardValidator = Compile(TavernBrowserContractV1.schemas.DiscardDraftCommandV1Schema);
const renameRequestValidator = Compile(TavernBrowserContractV1.schemas.RenameChatTitleCommandV1Schema);
const worldInfoBindValidator = Compile(TavernBrowserContractV1.schemas.SetWorldInfoBindingCommandV1Schema);
const memoryMutationValidator = Compile(TavernBrowserContractV1.schemas.MemoryMutationCommandV1Schema);
const connectionCreateValidator = Compile(TavernBrowserContractV1.schemas.TavernConnectionCreateCommandV1Schema);
const connectionRevisionValidator = Compile(TavernBrowserContractV1.schemas.TavernConnectionRevisionCommandV1Schema);
const connectionModelValidator = Compile(TavernBrowserContractV1.schemas.TavernConnectionModelCommandV1Schema);
const voicePreferenceConsentValidator = Compile(
  TavernBrowserContractV1.schemas.TavernVoicePreferenceConsentCommandV1Schema,
);
const languagePreferenceUpdateValidator = Compile(
  TavernBrowserContractV1.schemas.TavernLanguagePreferenceCommandV1Schema,
);
const createCompanionValidator = Compile(TavernBrowserContractV1.schemas.CreateCompanionCommandV1Schema);
const personaUpdateValidator = Compile(TavernBrowserContractV1.schemas.PersonaUpdateCommandV1Schema);
const scenarioUpdateValidator = Compile(TavernBrowserContractV1.schemas.ScenarioUpdateCommandV1Schema);
const greetingUpdateValidator = Compile(TavernBrowserContractV1.schemas.GreetingUpdateCommandV1Schema);
const chatRetentionValidator = Compile(TavernBrowserContractV1.schemas.ChatRetentionCommandV1Schema);

export type TavernManagementDialogueWebOptions = Readonly<{
  managementStateFacade?: TavernManagementStateFacade;
  managementService?: ChatManagementService;
  memoryService?: MemoryManagementService;
  worldInfoService?: WorldInfoBindingManagementService;
  voicePreferenceStore?: Readonly<{
    read(): Promise<VoicePreference>;
    update(expectedRevision: number, update: VoicePreferenceUpdate): Promise<VoicePreference>;
  }>;
  /**
   * Optional read-only output endpoint enumeration forwarded to the Voice
   * Gateway. Absent (or an empty list) means no enumerable endpoint is
   * available; the browser still offers the Windows default selection.
   */
  listVoiceOutputDevices?: () => Promise<readonly Readonly<{ id: string; name: string }>[]>;
  /** Single configuration point for the companion language (frontend-set). */
  languagePreferenceStore?: Readonly<{
    read(): Promise<LanguagePreference>;
    update(expectedRevision: number, update: LanguagePreferenceUpdate): Promise<LanguagePreference>;
  }>;
  /**
   * Host-owned connection/model management (design/28 §5.3). Present only when
   * the mounted profile declares the connection routes; the routes themselves
   * stay unavailable otherwise.
   */
  connectionService?: TavernConnectionService;
  /**
   * Host-owned companion library / persona / scenario / greeting management
   * (design/28 §2 Character + Persona rows). Each service is bound exactly
   * like the others: the profile must declare the route, the production
   * composition must inject the exact service, and a missing service with an
   * advertised route fails closed before any dispatch.
   */
  libraryService?: Readonly<{
    /**
     * Projects the exact companion library: opaque handles, display names and
     * the current marker. The Host composition mints handles through the
     * mounted lease projection so the browser can never decode a durable
     * companion identifier.
     */
    listCompanions(): Promise<readonly Readonly<{ handle: string; name: string; isCurrent: boolean }>[]>;
  }>;
  /**
   * Read-only safe companion detail, keyed by the exact opaque handle from
   * `libraryService.listCompanions`. Any other handle resolves to null and is
   * reported 404; the underlying service never names a durable identity.
   */
  companionDetailService?: Readonly<{
    read(handle: string): Promise<Readonly<{ name: string }> | null>;
  }>;
  /**
   * Host-owned new-companion provisioner. The browser sends a display name
   * only; the Host mints every durable identity and returns the safe name.
   */
  newCompanionProvisioner?: Readonly<{
    create(name: string): Promise<Readonly<{ name: string }>>;
  }>;
  personaService?: Readonly<{
    read(): Promise<Readonly<{ revision: number; name: string; description?: string }> | null>;
    update(
      request: Readonly<{ expectedRevision: number; name: string; description?: string }>,
    ): Promise<Readonly<{ revision: number; name: string; description?: string }>>;
  }>;
  scenarioService?: Readonly<{
    read(): Promise<Readonly<{ revision: number; name: string; description: string; preview: string }> | null>;
    update(
      request: Readonly<{ expectedRevision: number; name: string; description: string }>,
    ): Promise<Readonly<{ revision: number; name: string; description: string; preview: string }>>;
  }>;
  greetingService?: Readonly<{
    read(): Promise<
      | Readonly<{ revision: number; label?: string; variants: readonly Readonly<{ label?: string; text: string }>[] }>
      | null
    >;
    update(
      request: Readonly<{
        expectedRevision: number;
        label?: string;
        variants: readonly Readonly<{ label?: string; text: string }>[];
      }>,
    ): Promise<
      Readonly<{ revision: number; label?: string; variants: readonly Readonly<{ label?: string; text: string }>[] }>
    >;
  }>;
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
type ProblemCode = TavernProblemV1["code"] | "payload_too_large" | "settings_revision_conflict";

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
  const voicePreferenceStore = options.voicePreferenceStore;
  const listVoiceOutputDevices = options.listVoiceOutputDevices;
  const languagePreferenceStore = options.languagePreferenceStore;
  const connectionService = options.connectionService;
  const libraryService = options.libraryService;
  const companionDetailService = options.companionDetailService;
  const newCompanionProvisioner = options.newCompanionProvisioner;
  const personaService = options.personaService;
  const scenarioService = options.scenarioService;
  const greetingService = options.greetingService;
  const profile = options.profile;
  const bootstrapToken = options.bootstrapToken;
  if (managementStateFacade === undefined || managementService === undefined)
    throw new Error("tavern_management_composition_unavailable");
  assertManagementProfile(profile);
  // The production profile declares `memory.read`; it is reachable only when a
  // Host-owned MemoryManagementService is injected. A profile that advertises
  // the capability without the bound service fails closed before any route.
  if (
    (profile.routeIds.includes("memory.read") || profile.routeIds.includes("memory.mutate")) &&
    memoryService === undefined
  )
    throw new Error("tavern_management_composition_unavailable");
  // The World Info routes are mounted only when the exact binding service is
  // injected; a profile that advertises either route without the bound
  // service fails closed before any dispatch.
  if (
    (profile.routeIds.includes("world-info.read") || profile.routeIds.includes("world-info.bind")) &&
    worldInfoService === undefined
  )
    throw new Error("tavern_management_composition_unavailable");
  if (
    (profile.routeIds.includes("settings.voice.read") || profile.routeIds.includes("settings.voice.consent")) &&
    voicePreferenceStore === undefined
  )
    throw new Error("tavern_management_composition_unavailable");
  if (
    (profile.routeIds.includes("settings.language.read") || profile.routeIds.includes("settings.language.update")) &&
    languagePreferenceStore === undefined
  )
    throw new Error("tavern_management_composition_unavailable");
  if (!isOpaqueHandle(bootstrapToken)) throw new Error("tavern_management_bootstrap_token_invalid");
  // The connection routes are mounted only when the exact service is injected;
  // a profile that advertises any of them without it fails closed before any
  // dispatch, so no route can claim a management capability it cannot serve.
  if (profile.routeIds.some((routeId) => (MANAGEMENT_CONNECTION_ROUTES as readonly string[]).includes(routeId))) {
    if (connectionService === undefined) throw new Error("tavern_management_composition_unavailable");
    for (const routeId of MANAGEMENT_CONNECTION_ROUTES) {
      if (profile.routeIds.includes(routeId) && !profile.operationIds.includes(routeId))
        throw new Error("tavern_management_composition_unavailable");
    }
  }
  // The Character / Persona / Scenario / Greeting routes are mounted only when
  // the exact service is injected; a profile that advertises any of them
  // without the bound service fails closed before any dispatch, so no route
  // can claim a management capability it cannot serve. Reads stay optional
  // (read-only projections are additive), but every advertised mutation must
  // also be declared in operationIds.
  const P9_ROUTE_SERVICES = [
    ["companion.list", libraryService],
    ["companion.detail", libraryService],
    ["companion.create", libraryService],
    ["persona.read", personaService],
    ["persona.update", personaService],
    ["scenario.read", scenarioService],
    ["scenario.update", scenarioService],
    ["greeting.read", greetingService],
    ["greeting.update", greetingService],
  ] as const;
  for (const [routeId, bound] of P9_ROUTE_SERVICES) {
    if (profile.routeIds.includes(routeId) && bound === undefined)
      throw new Error("tavern_management_composition_unavailable");
  }
  for (const routeId of ["companion.create", "persona.update", "scenario.update", "greeting.update"] as const) {
    if (profile.routeIds.includes(routeId) && !profile.operationIds.includes(routeId))
      throw new Error("tavern_management_composition_unavailable");
  }

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
        return await sendProjectedSnapshot(
          response,
          managementStateFacade,
          profile,
          session,
          memoryService,
          worldInfoService,
        );
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/state") {
        if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        return await sendProjectedSnapshot(
          response,
          managementStateFacade,
          profile,
          session,
          memoryService,
          worldInfoService,
        );
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/settings/voice-preference") {
        if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
        if (authenticate(request, browser, origin) === null) return sendProblem(response, 401, "unauthorized");
        if (
          !profile.routeIds.includes("settings.voice.read") ||
          !profile.operationIds.includes("settings.voice.read") ||
          voicePreferenceStore === undefined
        )
          return sendProblem(response, 404, "profile_operation_unavailable");
        const preference: TavernVoicePreferenceV1 = await voicePreferenceStore.read();
        if (!TavernBrowserValidatorsV1.TavernVoicePreferenceV1Schema.Check(preference))
          throw new Error("voice_preference_store_unavailable");
        return sendJson(response, 200, preference);
      }
      if (request.method === "PUT" && url.pathname === "/api/tavern/v1/settings/voice-preference") {
        if (url.search !== "" || !isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        if (!tokensEqual(singleHeader(request.headers["x-csrf-token"]) ?? "", session.csrf))
          return sendProblem(response, 403, "csrf_failed");
        if (
          !profile.routeIds.includes("settings.voice.consent") ||
          !profile.operationIds.includes("settings.voice.consent") ||
          voicePreferenceStore === undefined
        )
          return sendProblem(response, 404, "profile_operation_unavailable");
        const body = await readJsonBody(request, MAX_BODY_BYTES);
        if (!voicePreferenceConsentValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
        const command = body as TavernVoicePreferenceConsentCommandV1;
        const { expectedRevision, ...update } = command;
        const preference = await voicePreferenceStore.update(expectedRevision, update);
        if (!TavernBrowserValidatorsV1.TavernVoicePreferenceV1Schema.Check(preference))
          throw new Error("voice_preference_store_unavailable");
        return sendJson(response, 200, preference);
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/settings/voice-devices") {
        if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
        if (authenticate(request, browser, origin) === null) return sendProblem(response, 401, "unauthorized");
        if (
          !profile.routeIds.includes("settings.voice.devices") ||
          !profile.operationIds.includes("settings.voice.devices")
        )
          return sendProblem(response, 404, "profile_operation_unavailable");
        // Reads are strictly non-mutating and never touch the preference file.
        // Absent enumerator or non-Windows resolves to an empty list; the
        // Windows default endpoint is always selectable through the preference.
        const devices = listVoiceOutputDevices === undefined ? [] : await listVoiceOutputDevices();
        const bounded = devices
          .filter(
            (device): device is { id: string; name: string } =>
              typeof device.id === "string" &&
              /^waveout:[0-9]{1,4}$/.test(device.id) &&
              typeof device.name === "string" &&
              device.name.length >= 1 &&
              device.name.length <= 128,
          )
          .slice(0, 32);
        const result: TavernVoiceDevicesV1 = Object.freeze({ devices: bounded.map((device) => Object.freeze({ id: device.id, name: device.name })), defaultSelectable: true });
        if (!TavernBrowserValidatorsV1.TavernVoiceDevicesV1Schema.Check(result))
          throw new Error("voice_devices_unavailable");
        return sendJson(response, 200, result);
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/settings/language") {
        if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
        if (authenticate(request, browser, origin) === null) return sendProblem(response, 401, "unauthorized");
        if (
          !profile.routeIds.includes("settings.language.read") ||
          !profile.operationIds.includes("settings.language.read") ||
          languagePreferenceStore === undefined
        )
          return sendProblem(response, 404, "profile_operation_unavailable");
        const preference: TavernLanguagePreferenceV1 = await languagePreferenceStore.read();
        if (!TavernBrowserValidatorsV1.TavernLanguagePreferenceV1Schema.Check(preference))
          throw new Error("language_preference_store_unavailable");
        return sendJson(response, 200, preference);
      }
      if (request.method === "PUT" && url.pathname === "/api/tavern/v1/settings/language") {
        if (url.search !== "" || !isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        if (!tokensEqual(singleHeader(request.headers["x-csrf-token"]) ?? "", session.csrf))
          return sendProblem(response, 403, "csrf_failed");
        if (
          !profile.routeIds.includes("settings.language.update") ||
          !profile.operationIds.includes("settings.language.update") ||
          languagePreferenceStore === undefined
        )
          return sendProblem(response, 404, "profile_operation_unavailable");
        const body = await readJsonBody(request, MAX_BODY_BYTES);
        if (!languagePreferenceUpdateValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
        const command = body as TavernLanguagePreferenceCommandV1;
        const { expectedRevision, ...update } = command;
        const preference = await languagePreferenceStore.update(expectedRevision, update);
        if (!TavernBrowserValidatorsV1.TavernLanguagePreferenceV1Schema.Check(preference))
          throw new Error("language_preference_store_unavailable");
        return sendJson(response, 200, preference);
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
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/settings/connection") {
        if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
        if (authenticate(request, browser, origin) === null) return sendProblem(response, 401, "unauthorized");
        if (!connectionRouteAvailable(profile, "settings.connection.read", connectionService))
          return sendProblem(response, 404, "profile_operation_unavailable");
        return sendJson(response, 200, await connectionService!.read());
      }
      if (request.method === "POST" && url.pathname === "/api/tavern/v1/settings/connections") {
        if (url.search !== "" || !isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        if (!tokensEqual(singleHeader(request.headers["x-csrf-token"]) ?? "", session.csrf))
          return sendProblem(response, 403, "csrf_failed");
        if (!connectionRouteAvailable(profile, "settings.connection.create", connectionService))
          return sendProblem(response, 404, "profile_operation_unavailable");
        const body = await readJsonBody(request, MAX_BODY_BYTES);
        if (!connectionCreateValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
        return sendJson(response, 200, await connectionService!.create(body as TavernConnectionCreateCommandV1));
      }
      const connectionRoute = matchConnectionRoute(request.method, url.pathname);
      if (connectionRoute !== null) {
        if (url.search !== "" || !isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        if (!tokensEqual(singleHeader(request.headers["x-csrf-token"]) ?? "", session.csrf))
          return sendProblem(response, 403, "csrf_failed");
        if (!connectionRouteAvailable(profile, connectionRoute.operationId, connectionService))
          return sendProblem(response, 404, "profile_operation_unavailable");
        const body = await readJsonBody(request, MAX_BODY_BYTES);
        const connection = connectionService!;
        if (connectionRoute.operationId === "settings.connection.test") {
          if (!connectionRevisionValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
          const command = body as TavernConnectionRevisionCommandV1;
          return sendJson(response, 200, await connection.test(connectionRoute.connectionId, command.expectedRevision));
        }
        if (connectionRoute.operationId === "settings.connection.activate") {
          if (!connectionRevisionValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
          const command = body as TavernConnectionRevisionCommandV1;
          return sendJson(response, 200, await connection.activate(connectionRoute.connectionId, command.expectedRevision));
        }
        if (connectionRoute.operationId === "settings.connection.model") {
          if (!connectionModelValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
          return sendJson(
            response,
            200,
            await connection.selectModel(connectionRoute.connectionId, body as TavernConnectionModelCommandV1),
          );
        }
        if (!connectionRevisionValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
        const command = body as TavernConnectionRevisionCommandV1;
        return sendJson(response, 200, await connection.remove(connectionRoute.connectionId, command.expectedRevision));
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/companions") {
        if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
        if (authenticate(request, browser, origin) === null) return sendProblem(response, 401, "unauthorized");
        if (!profile.routeIds.includes("companion.list") || libraryService === undefined)
          return sendProblem(response, 404, "profile_operation_unavailable");
        const companions = await libraryService.listCompanions();
        const list: CompanionListV1 = Object.freeze({
          apiVersion: TAVERN_BROWSER_API_VERSION,
          companions: companions.map((companion) =>
            Object.freeze({
              handle: companion.handle,
              name: companion.name,
              isCurrent: companion.isCurrent,
            }),
          ),
        });
        if (!TavernBrowserValidatorsV1.CompanionListV1Schema.Check(list)) throw new Error("companion_list_service_unavailable");
        return sendJson(response, 200, list);
      }
      {
        const companionDetailHandle = matchCompanionDetailRoute(request.method, url.pathname);
        if (companionDetailHandle !== null) {
          // companion.detail: the exact opaque handle the list projected. A
          // foreign handle is answered by the bound service as null (404), so
          // browser input can never name another durable companion identity.
          if (url.search !== "" || (await hasRequestBody(request)))
            return sendProblem(response, 400, "invalid_request");
          if (authenticate(request, browser, origin) === null) return sendProblem(response, 401, "unauthorized");
          if (
            !profile.routeIds.includes("companion.detail") ||
            libraryService === undefined ||
            companionDetailService === undefined
          )
            return sendProblem(response, 404, "profile_operation_unavailable");
          const detail = await companionDetailService.read(companionDetailHandle);
          if (detail === null) return sendProblem(response, 404, "companion_not_found");
          const result: CompanionDetailV1 = Object.freeze({
            apiVersion: TAVERN_BROWSER_API_VERSION,
            name: detail.name,
          });
          if (!TavernBrowserValidatorsV1.CompanionDetailV1Schema.Check(result))
            throw new Error("companion_detail_service_unavailable");
          return sendJson(response, 200, result);
        }
      }
      if (request.method === "POST" && url.pathname === "/api/tavern/v1/companions") {
        if (url.search !== "" || !isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        if (!tokensEqual(singleHeader(request.headers["x-csrf-token"]) ?? "", session.csrf))
          return sendProblem(response, 403, "csrf_failed");
        if (!profile.routeIds.includes("companion.create") || libraryService === undefined)
          return sendProblem(response, 404, "profile_operation_unavailable");
        const body = await readJsonBody(request, MAX_BODY_BYTES);
        if (!createCompanionValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
        const { name } = body as CreateCompanionCommandV1;
        if (newCompanionProvisioner === undefined) return sendProblem(response, 503, "runtime_unavailable");
        const provisioned = await newCompanionProvisioner.create(name);
        const result: CompanionDetailV1 = Object.freeze({
          apiVersion: TAVERN_BROWSER_API_VERSION,
          name: provisioned.name,
        });
        if (!TavernBrowserValidatorsV1.CompanionDetailV1Schema.Check(result))
          throw new Error("companion_create_service_unavailable");
        return sendJson(response, 200, result);
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/persona") {
        if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
        if (authenticate(request, browser, origin) === null) return sendProblem(response, 401, "unauthorized");
        if (!profile.routeIds.includes("persona.read") || personaService === undefined)
          return sendProblem(response, 404, "profile_operation_unavailable");
        const persona = await personaService.read();
        const result: PersonaV1 = Object.freeze({
          apiVersion: TAVERN_BROWSER_API_VERSION,
          present: persona !== null,
          revision: persona?.revision ?? null,
          name: persona?.name ?? null,
          description: persona?.description ?? null,
        });
        if (!TavernBrowserValidatorsV1.PersonaV1Schema.Check(result)) throw new Error("persona_service_unavailable");
        return sendJson(response, 200, result);
      }
      if (request.method === "PUT" && url.pathname === "/api/tavern/v1/persona") {
        if (url.search !== "" || !isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        if (!tokensEqual(singleHeader(request.headers["x-csrf-token"]) ?? "", session.csrf))
          return sendProblem(response, 403, "csrf_failed");
        if (
          !profile.routeIds.includes("persona.update") ||
          !profile.operationIds.includes("persona.update") ||
          personaService === undefined
        )
          return sendProblem(response, 404, "profile_operation_unavailable");
        const body = await readJsonBody(request, MAX_BODY_BYTES);
        if (!personaUpdateValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
        const command = body as PersonaUpdateCommandV1;
        const persona = await personaService.update({
          expectedRevision: command.expectedRevision,
          name: command.name,
          ...(command.description === undefined ? {} : { description: command.description }),
        });
        const result: PersonaV1 = Object.freeze({
          apiVersion: TAVERN_BROWSER_API_VERSION,
          present: true,
          revision: persona.revision,
          name: persona.name,
          description: persona.description ?? null,
        });
        if (!TavernBrowserValidatorsV1.PersonaV1Schema.Check(result)) throw new Error("persona_service_unavailable");
        return sendJson(response, 200, result);
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/scenario") {
        if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
        if (authenticate(request, browser, origin) === null) return sendProblem(response, 401, "unauthorized");
        if (!profile.routeIds.includes("scenario.read") || scenarioService === undefined)
          return sendProblem(response, 404, "profile_operation_unavailable");
        const scenario = await scenarioService.read();
        const result: ScenarioV1 = Object.freeze({
          apiVersion: TAVERN_BROWSER_API_VERSION,
          present: scenario !== null,
          revision: scenario?.revision ?? null,
          name: scenario?.name ?? null,
          description: scenario?.description ?? null,
          preview: scenario?.preview ?? null,
        });
        if (!TavernBrowserValidatorsV1.ScenarioV1Schema.Check(result)) throw new Error("scenario_service_unavailable");
        return sendJson(response, 200, result);
      }
      if (request.method === "PUT" && url.pathname === "/api/tavern/v1/scenario") {
        if (url.search !== "" || !isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        if (!tokensEqual(singleHeader(request.headers["x-csrf-token"]) ?? "", session.csrf))
          return sendProblem(response, 403, "csrf_failed");
        if (
          !profile.routeIds.includes("scenario.update") ||
          !profile.operationIds.includes("scenario.update") ||
          scenarioService === undefined
        )
          return sendProblem(response, 404, "profile_operation_unavailable");
        const body = await readJsonBody(request, MAX_BODY_BYTES);
        if (!scenarioUpdateValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
        const command = body as ScenarioUpdateCommandV1;
        const scenario = await scenarioService.update({
          expectedRevision: command.expectedRevision,
          name: command.name,
          description: command.description,
        });
        const result: ScenarioV1 = Object.freeze({
          apiVersion: TAVERN_BROWSER_API_VERSION,
          present: true,
          revision: scenario.revision,
          name: scenario.name,
          description: scenario.description,
          preview: scenario.preview,
        });
        if (!TavernBrowserValidatorsV1.ScenarioV1Schema.Check(result)) throw new Error("scenario_service_unavailable");
        return sendJson(response, 200, result);
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/greeting") {
        if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
        if (authenticate(request, browser, origin) === null) return sendProblem(response, 401, "unauthorized");
        if (!profile.routeIds.includes("greeting.read") || greetingService === undefined)
          return sendProblem(response, 404, "profile_operation_unavailable");
        const greeting = await greetingService.read();
        const result: GreetingV1 = Object.freeze({
          apiVersion: TAVERN_BROWSER_API_VERSION,
          present: greeting !== null,
          revision: greeting?.revision ?? null,
          label: greeting?.label ?? null,
          variants: (greeting?.variants ?? []).map((variant) =>
            Object.freeze({ label: variant.label ?? null, text: variant.text }),
          ),
        });
        if (!TavernBrowserValidatorsV1.GreetingV1Schema.Check(result)) throw new Error("greeting_service_unavailable");
        return sendJson(response, 200, result);
      }
      if (request.method === "PUT" && url.pathname === "/api/tavern/v1/greeting") {
        if (url.search !== "" || !isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        if (!tokensEqual(singleHeader(request.headers["x-csrf-token"]) ?? "", session.csrf))
          return sendProblem(response, 403, "csrf_failed");
        if (
          !profile.routeIds.includes("greeting.update") ||
          !profile.operationIds.includes("greeting.update") ||
          greetingService === undefined
        )
          return sendProblem(response, 404, "profile_operation_unavailable");
        const body = await readJsonBody(request, MAX_BODY_BYTES);
        if (!greetingUpdateValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
        const command = body as GreetingUpdateCommandV1;
        const greeting = await greetingService.update({
          expectedRevision: command.expectedRevision,
          ...(command.label === undefined ? {} : { label: command.label }),
          variants: command.variants.map((variant) =>
            Object.freeze({ ...(variant.label === undefined ? {} : { label: variant.label }), text: variant.text }),
          ),
        });
        const result: GreetingV1 = Object.freeze({
          apiVersion: TAVERN_BROWSER_API_VERSION,
          present: true,
          revision: greeting.revision,
          label: greeting.label ?? null,
          variants: greeting.variants.map((variant) =>
            Object.freeze({ label: variant.label ?? null, text: variant.text }),
          ),
        });
        if (!TavernBrowserValidatorsV1.GreetingV1Schema.Check(result)) throw new Error("greeting_service_unavailable");
        return sendJson(response, 200, result);
      }
      {
        const retentionRoute = matchRetentionRoute(request.method, url.pathname);
        if (retentionRoute !== null) {
          if (url.search !== "" || !isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
          const session = authenticate(request, browser, origin);
          if (session === null) return sendProblem(response, 401, "unauthorized");
          if (!tokensEqual(singleHeader(request.headers["x-csrf-token"]) ?? "", session.csrf))
            return sendProblem(response, 403, "csrf_failed");
          if (
            !profile.routeIds.includes(retentionRoute.operationId) ||
            !profile.operationIds.includes(retentionRoute.operationId) ||
            managementService?.transitionLifecycle === undefined
          )
            return sendProblem(response, 404, "profile_operation_unavailable");
          const body = await readJsonBody(request, MAX_BODY_BYTES);
          if (!chatRetentionValidator.Check(body)) return sendProblem(response, 400, "invalid_request");
          const wire = body as ChatRetentionCommandV1;
          const result = await managementService.transitionLifecycle(
            Object.freeze({
              apiVersion: wire.apiVersion,
              selectionGeneration: wire.selectionGeneration,
              chatHandle: retentionRoute.chatHandle,
              expectedManagementRevision: wire.expectedManagementRevision,
              operation: retentionRoute.operation,
            }),
          );
          if (!TavernBrowserValidatorsV1.ChatRetentionResultV1Schema.Check(result))
            throw new Error("chat_management_service_unavailable");
          return sendJson(response, 200, result);
        }
      }
      return sendProblem(response, 404, "profile_operation_unavailable");
    } catch (error) {
      const { status, code } = problemFor(error);
      if (!response.writableEnded && !response.destroyed) {
        if (status === 413) {
          response.setHeader("Connection", "close");
          sendProblem(response, status, code);
          const destroySocket = () => {
            request.socket?.destroy();
          };
          if (response.writableFinished) {
            destroySocket();
          } else {
            response.once("finish", destroySocket);
            response.once("close", destroySocket);
          }
          return;
        }
        return sendProblem(response, status, code);
      }
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
        // The connection service drains after the handler has drained, so no
        // admitted probe or mutation is still holding the credential path.
        await connectionService?.close();
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
  const memoryProjection =
    memoryResult !== undefined
      ? ({
          readAvailable: true as const,
          mutationAvailable:
            profile.routeIds.includes("memory.mutate") && profile.operationIds.includes("memory.mutate"),
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
  if (itemId === "characters")
    return {
      itemId,
      labelKey: "tavern.nav.characters" as const,
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
  if (profile.profileId !== MANAGEMENT_PROFILE_ID || profile.releaseTier !== MANAGEMENT_RELEASE_TIER)
    throw new Error("tavern_management_profile_operation_unavailable");
  // A memory-capable profile must declare the Memory navigation item and the
  // inverse (Memory route but no Memory navigation) fails closed. The
  // Characters item is present on the current-facing profile; legacy profiles
  // that predate the Characters surface keep the old navigation shape.
  const withMemory = profile.routeIds.includes("memory.read");
  const navigationMatches =
    sameOrderedValues(profile.navigationItemIds, withMemory ? MANAGEMENT_NAVIGATION_ITEM_IDS_WITH_MEMORY : MANAGEMENT_NAVIGATION_ITEM_IDS_WITHOUT_MEMORY) ||
    sameOrderedValues(profile.navigationItemIds, withMemory ? MANAGEMENT_NAVIGATION_ITEM_IDS_LEGACY_WITH_MEMORY : MANAGEMENT_NAVIGATION_ITEM_IDS_LEGACY_WITHOUT_MEMORY);
  if (!navigationMatches) throw new Error("tavern_management_profile_operation_unavailable");
  // The core surface and the three extension groups are declared per profile
  // revision. A profile may declare any subset of the optional groups, and only
  // them, in the frozen canonical order: core, output devices, language,
  // connections. A partially applied group, an undeclared route or a reordered
  // list fails closed, so no route is mounted that this dispatcher cannot serve.
  const coreRoutes = withMemory
    ? profile.operationIds.includes("memory.mutate")
      ? MANAGEMENT_ROUTE_IDS
      : MANAGEMENT_ROUTE_IDS.filter((routeId) => routeId !== "memory.mutate")
    : MANAGEMENT_ROUTE_IDS_WITHOUT_MEMORY;
  const coreOperations = profile.operationIds.includes("memory.mutate")
    ? MANAGEMENT_OPERATION_IDS_WITH_MEMORY
    : MANAGEMENT_OPERATION_IDS_WITHOUT_MEMORY;
  if (
    !isCanonicalGroupSelection(
      profile.routeIds,
      [coreRoutes, MANAGEMENT_VOICE_DEVICES, MANAGEMENT_LANGUAGE_ROUTES, MANAGEMENT_CONNECTION_ROUTES, MANAGEMENT_P9_ROUTES],
      coreRoutes,
    ) ||
    !isCanonicalGroupSelection(
      profile.operationIds,
      [coreOperations, MANAGEMENT_VOICE_DEVICES, MANAGEMENT_LANGUAGE_ROUTES, MANAGEMENT_CONNECTION_ROUTES, MANAGEMENT_P9_ROUTES],
      coreOperations,
    )
  )
    throw new Error("tavern_management_profile_operation_unavailable");
  // Every operation must be backed by its own route: a profile cannot advertise
  // an operation the mounted dispatcher would refuse to serve.
  for (const operationId of profile.operationIds) {
    if (!profile.routeIds.includes(operationId))
      throw new Error("tavern_management_profile_operation_unavailable");
  }
}

/**
 * True when `values` is exactly the required core group plus any subset of the
 * optional groups that follow it, always in the declared order. A group is
 * all-or-nothing: a partially declared group is a capability the profile claims
 * but the mounted dispatcher cannot serve. Ordering is part of the check, so a
 * reordered profile is a different capability slice and is rejected.
 */
function isCanonicalGroupSelection(
  values: readonly string[],
  groups: readonly (readonly string[])[],
  required: readonly string[],
): boolean {
  const expected: string[] = [];
  for (const group of groups) {
    const present = group === required || values.some((value) => group.includes(value));
    if (!present) continue;
    if (!group.every((entry) => values.includes(entry))) return false;
    expected.push(...group);
  }
  return expected.length === values.length && expected.every((entry, index) => entry === values[index]);
}

function sameOrderedValues(values: readonly string[], expected: readonly string[]): boolean {
  return values.length === expected.length && values.every((value, index) => value === expected[index]);
}

/**
 * One connection sub-route: `/settings/connections/:connectionId/<operation>`.
 * The handle is matched exactly as one 43-character opaque segment so no path
 * can address a record the player's session never received.
 */
const CONNECTION_SUBROUTES = Object.freeze([
  Object.freeze({ operationId: "settings.connection.test", suffix: "test" as const, method: "POST" as const }),
  Object.freeze({ operationId: "settings.connection.activate", suffix: "activate" as const, method: "POST" as const }),
  Object.freeze({ operationId: "settings.connection.model", suffix: "model" as const, method: "POST" as const }),
  Object.freeze({ operationId: "settings.connection.remove", suffix: "" as const, method: "DELETE" as const }),
]);

function matchConnectionRoute(
  method: string | undefined,
  pathname: string,
): Readonly<{ operationId: string; connectionId: string }> | null {
  const match = /^\/api\/tavern\/v1\/settings\/connections\/([A-Za-z0-9_-]{43})(?:\/([a-z]+))?$/.exec(pathname);
  if (match === null) return null;
  const connectionId = match[1]!;
  const suffix = match[2] ?? "";
  const route = CONNECTION_SUBROUTES.find((entry) => entry.suffix === suffix && entry.method === method);
  return route === null || route === undefined ? null : Object.freeze({ operationId: route.operationId, connectionId });
}

/** Chat lifecycle retention subroutes: archive / restore / trash on an exact handle. */
const RETENTION_SUBROUTES = [
  Object.freeze({ operationId: "chat.archive" as const, suffix: "archive", method: "POST" as const }),
  Object.freeze({ operationId: "chat.restore" as const, suffix: "restore", method: "POST" as const }),
  Object.freeze({ operationId: "chat.trash" as const, suffix: "trash", method: "POST" as const }),
];

function matchRetentionRoute(
  method: string | undefined,
  pathname: string,
): Readonly<{ operationId: "chat.archive" | "chat.restore" | "chat.trash"; chatHandle: string; operation: "archive" | "restore" | "trash" }> | null {
  const match = /^\/api\/tavern\/v1\/chats\/([A-Za-z0-9_-]{43})\/(archive|restore|trash)$/.exec(pathname);
  if (match === null) return null;
  const route = RETENTION_SUBROUTES.find(
    (entry) => entry.suffix === match[2] && entry.method === method,
  );
  return route === undefined
    ? null
    : Object.freeze({
        operationId: route.operationId,
        chatHandle: match[1]!,
        operation: match[2] as "archive" | "restore" | "trash",
      });
}

function matchCompanionDetailRoute(method: string | undefined, pathname: string): string | null {
  if (method !== "GET") return null;
  const match = /^\/api\/tavern\/v1\/companions\/([A-Za-z0-9_-]{43})$/.exec(pathname);
  return match === null ? null : match[1]!;
}

/**
 * A connection route is mounted only when the mounted profile declares both the
 * route and its operation and the exact Host service backs it. The inverse
 * (profile advertises, service absent) already fails closed at composition.
 */
function connectionRouteAvailable(
  profile: ComposedTavernProfile,
  operationId: string,
  service: TavernConnectionService | undefined,
): boolean {
  const routeIds: readonly string[] = profile.routeIds;
  const operationIds: readonly string[] = profile.operationIds;
  return service !== undefined && routeIds.includes(operationId) && operationIds.includes(operationId);
}

function problemFor(error: unknown): Readonly<{ status: number; code: ProblemCode }> {
  const message = error instanceof Error ? error.message : "";
  if (message === "payload_too_large") return { status: 413, code: "payload_too_large" };
  if (message === "invalid_request") return { status: 400, code: "invalid_request" };
  if (message === "chat_management_selection_conflict") return { status: 409, code: "selection_conflict" };
  if (message === "chat_management_revision_conflict") return { status: 409, code: "draft_conflict" };
  if (message === "chat_management_lifecycle_invalid") return { status: 409, code: "state_reconciliation_required" };
  if (message === "world_info_binding_conflict" || message === "world_info_binding_locked")
    return { status: 409, code: "state_reconciliation_required" };
  if (message === "context_unavailable") return { status: 503, code: "runtime_unavailable" };
  if (message === "world_info_binding_service_unavailable" || message === "world_info_binding_service_closed")
    return { status: 503, code: "runtime_unavailable" };
  if (message === "world_info_binding_storage_unavailable") return { status: 503, code: "storage_unavailable" };
  if (message === "chat_management_service_unavailable" || message === "chat_management_service_closed")
    return { status: 503, code: "runtime_unavailable" };
  if (message === "memory_read_service_unavailable" || message === "memory_read_unavailable")
    return { status: 503, code: "runtime_unavailable" };
  if (message === "memory_read_storage_unavailable") return { status: 503, code: "storage_unavailable" };
  if (message === "voice_preference_revision_conflict") return { status: 409, code: "settings_revision_conflict" };
  if (message === "invalid_voice_preference_update") return { status: 400, code: "invalid_request" };
  if (message === "voice_preference_store_unavailable") return { status: 503, code: "runtime_unavailable" };
  if (message === "dialogue_busy") return { status: 409, code: "dialogue_busy" };
  if (message === "connection_limit_reached") return { status: 409, code: "connection_limit_reached" };
  if (message === "tavern_connection_revision_conflict") return { status: 409, code: "connection_conflict" };
  if (
    message === "provider_unknown" ||
    message === "api_key_required" ||
    message === "api_key_not_accepted" ||
    message === "base_url_required" ||
    message === "base_url_not_accepted" ||
    message === "invalid_base_url" ||
    message === "model_not_allowed" ||
    message === "invalid_model_id" ||
    message === "thinking_level_not_allowed"
  )
    return { status: 400, code: "invalid_request" };
  if (message === "not_found") return { status: 404, code: "connection_not_found" };
  if (message === "not_ready") return { status: 409, code: "connection_not_ready" };
  if (message === "active_connection_cannot_be_removed") return { status: 409, code: "connection_conflict" };
  if (message === "tavern_connection_storage_unavailable") return { status: 503, code: "storage_unavailable" };
  if (message === "tavern_connection_service_unavailable") return { status: 503, code: "runtime_unavailable" };
  if (message === "invalid_voice_preference_store" || message === "voice_preference_readback_mismatch")
    return { status: 503, code: "storage_unavailable" };
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
      pending: item.pending,
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
  if (contentLength !== undefined && !/^\d+$/u.test(contentLength)) throw new Error("invalid_request");
  if (contentLength !== undefined && Number(contentLength) > maxBytes) {
    request.resume();
    setImmediate(() => request.socket?.destroy());
    throw new Error("payload_too_large");
  }
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if ((bytes += part.length) > maxBytes) {
      request.resume();
      setImmediate(() => request.socket?.destroy());
      throw new Error("payload_too_large");
    }
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
  const problem = {
    type: `urn:gamebuddy:tavern:${code}`,
    title: code.replaceAll("_", " "),
    status,
    code,
    requestId: randomToken(),
    retryable: code === "storage_unavailable" || code === "runtime_unavailable",
  };
  if (code !== "payload_too_large" && !TavernBrowserValidatorsV1.TavernProblemV1Schema.Check(problem))
    throw new Error("invalid_problem");
  response.writeHead(status, {
    "Content-Type": "application/problem+json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(status === 413 ? { Connection: "close" } : {}),
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
