import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import {
  TAVERN_BROWSER_API_V1,
  TavernBrowserContractV1,
  TavernBrowserValidatorsV1,
  type ComposedTavernProfile,
  type TavernBrowserNavigationItemIdV1,
  type TavernProblemV1,
  type TavernStateSnapshotV1,
} from "./tavern/browser-contract/index.js";
import type { ChatPipelineService } from "./tavern/chat-pipeline-service.js";
import type { ChatEventStream, ChatEventStreamResult } from "./tavern/chat-event-stream.js";
import type { ReferencePipelineStateFacade } from "./tavern/reference-pipeline-state.js";

const LOOPBACK_HOST = "127.0.0.1";
const BROWSER_TTL_MS = 2 * 60 * 60_000;
const MAX_BOOTSTRAP_BODY_BYTES = 4 * 1024;
const REFERENCE_PROFILE_ID = "gamebuddy.chat-core.reference-pipeline";
const REFERENCE_RELEASE_TIER = "chat_core";
const REFERENCE_ROUTE_IDS = [
  "bootstrap",
  "state.read",
  "draft.read",
  "chat.submit",
  "chat.submission_status",
  "events",
] as const;
const REFERENCE_OPERATION_IDS = ["chat.submit"] as const;
const REFERENCE_NAVIGATION_ITEM_IDS = ["chat"] as const;
const bootstrapRequestValidator = Compile(
  (
    TavernBrowserContractV1.routes.find(
      (route) => route.routeId === "bootstrap",
    )! as { request: TSchema }
  ).request,
);

export type ReferencePipelineDialogueWebOptions = Readonly<{
  referenceStateFacade?: ReferencePipelineStateFacade;
  pipelineService?: ChatPipelineService;
  eventStream?: ChatEventStream;
  profile?: ComposedTavernProfile;
  bootstrapToken?: string;
  readonly [key: string]: unknown;
}>;
export type ReferencePipelineDialogueWebServer = Readonly<{
  origin: string;
  closeAllConnections(): void;
  close(): Promise<void>;
}>;
export type ReferencePipelineDialogueWebRequestHandler = Readonly<{
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    origin: string,
  ): void;
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
 * Creates the closed P3 API dispatcher for a listener which already owns the
 * exact loopback origin.  It has no static-shell knowledge and never binds a
 * second port, so a later composer can retain one browser origin.
 */
export function createReferencePipelineDialogueWebRequestHandler(
  options: ReferencePipelineDialogueWebOptions,
): ReferencePipelineDialogueWebRequestHandler {
  if (options.profile === undefined || options.bootstrapToken === undefined)
    throw new Error("reference_pipeline_composition_unavailable");
  const referenceStateFacade = options.referenceStateFacade;
  const pipelineService = options.pipelineService;
  const eventStream = options.eventStream;
  const profile = options.profile;
  const bootstrapToken = options.bootstrapToken;
  if (referenceStateFacade === undefined || pipelineService === undefined)
    throw new Error("reference_pipeline_composition_unavailable");
  assertReferenceProfile(profile);
  if (profile.routeIds.includes("events") !== (eventStream !== undefined))
    throw new Error("reference_pipeline_event_stream_unavailable");
  if (!isOpaqueHandle(bootstrapToken))
    throw new Error("reference_pipeline_bootstrap_token_invalid");

  let browser: BrowserSession | undefined;
  let bootstrapUsed = false;
  let closed = false;
  const activeDispatches = new Set<Promise<void>>();
  const activeStreams = new Set<() => void>();
  const dispatch = async (
    request: IncomingMessage,
    response: ServerResponse,
    origin: string,
  ): Promise<void> => {
    setSecurityHeaders(response);
    const port = new URL(origin).port;
    if (
      new URL(origin).protocol !== "http:" ||
      !/^\d+$/.test(port) ||
      !isExactLoopbackHost(request, Number(port))
    )
      return sendProblem(response, 421, "invalid_request");
    if (closed) return sendProblem(response, 503, "runtime_unavailable");
    const url = new URL(request.url ?? "/", origin);
    try {
      if (
        request.method === "POST" &&
        url.pathname === "/api/tavern/v1/bootstrap"
      ) {
        if (url.search !== "")
          return sendProblem(response, 400, "invalid_request");
        if (!isSameOrigin(request, origin))
          return sendProblem(response, 401, "unauthorized");
        const body = await readJsonBody(request, MAX_BOOTSTRAP_BODY_BYTES);
        if (!bootstrapRequestValidator.Check(body))
          return sendProblem(response, 400, "invalid_request");
        const bootstrap = body as Readonly<{ bootstrapToken: string }>;
        if (
          bootstrapUsed ||
          !tokensEqual(bootstrap.bootstrapToken, bootstrapToken)
        )
          return sendProblem(response, 401, "unauthorized");
        bootstrapUsed = true;
        const session = Object.freeze({
          bearer: randomToken(),
          csrf: randomToken(),
          expiresAtMs: Date.now() + BROWSER_TTL_MS,
        });
        browser = session;
        response.setHeader(
          "Set-Cookie",
          `gb_tavern_session=${session.bearer}; HttpOnly; SameSite=Strict; Path=/`,
        );
        return await sendProjectedSnapshot(
          response,
          referenceStateFacade,
          profile,
          session,
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/tavern/v1/messages"
      ) {
        if (url.search !== "" || !isSameOrigin(request, origin))
          return sendProblem(response, 401, "unauthorized");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        const csrfHeader = singleHeader(request.headers["x-csrf-token"]);
        if (csrfHeader === null)
          return sendProblem(response, 400, "invalid_request");
        if (!tokensEqual(csrfHeader, session.csrf))
          return sendProblem(response, 403, "csrf_failed");
        const idempotencyKey = singleHeader(request.headers["idempotency-key"]);
        if (!isIdempotencyKey(idempotencyKey))
          return sendProblem(response, 400, "invalid_request");
        const body = await readJsonBody(request, MAX_BOOTSTRAP_BODY_BYTES);
        const route = TavernBrowserContractV1.routes.find(
          (entry) => entry.routeId === "chat.submit",
        );
        if (
          route === undefined ||
          !("request" in route) ||
          !Compile(route.request).Check(body)
        )
          return sendProblem(response, 400, "invalid_request");
        const result = await pipelineService.submitAfterResponseCommit(
          body as import("./tavern/browser-contract/index.js").SubmitMessageCommandV1,
          idempotencyKey,
          async (committed) => {
            if (
              !TavernBrowserValidatorsV1.SubmitResultV1Schema.Check(committed)
            )
              throw new Error("chat_pipeline_service_unavailable");
            await sendJsonAfterFinish(response, 202, committed);
          },
        );
        if (!TavernBrowserValidatorsV1.SubmitResultV1Schema.Check(result))
          throw new Error("chat_pipeline_service_unavailable");
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/tavern/v1/message-submission-status"
      ) {
        if (url.search !== "" || !isSameOrigin(request, origin))
          return sendProblem(response, 401, "unauthorized");
        if (authenticate(request, browser, origin) === null)
          return sendProblem(response, 401, "unauthorized");
        const body = await readJsonBody(request, MAX_BOOTSTRAP_BODY_BYTES);
        const route = TavernBrowserContractV1.routes.find(
          (entry) => entry.routeId === "chat.submission_status",
        );
        if (
          route === undefined ||
          !("request" in route) ||
          !Compile(route.request).Check(body)
        )
          return sendProblem(response, 400, "invalid_request");
        const status = await pipelineService.readSubmissionStatus(
          body as import("./tavern/browser-contract/index.js").MessageSubmissionStatusQueryV1,
        );
        if (
          !TavernBrowserValidatorsV1.MessageSubmissionStatusV1Schema.Check(
            status,
          )
        )
          throw new Error("chat_pipeline_service_unavailable");
        return sendJson(response, 200, status);
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/events") {
        if (url.searchParams.has("unexpected") || (await hasRequestBody(request)))
          return sendProblem(response, 400, "invalid_request");
        if (!isSameOrigin(request, origin) || authenticate(request, browser, origin) === null)
          return sendProblem(response, 401, "unauthorized");
        if (eventStream === undefined) return sendProblem(response, 404, "profile_operation_unavailable");
        const apiVersion = url.searchParams.get("apiVersion");
        if (apiVersion !== "1" || url.searchParams.getAll("apiVersion").length !== 1)
          return sendProblem(response, 400, "invalid_request");
        const queryCursor = url.searchParams.get("cursor");
        if (url.searchParams.getAll("cursor").length > 1)
          return sendProblem(response, 400, "invalid_request");
        const headerCursor = singleHeader(request.headers["last-event-id"]);
        const decodedQuery = queryCursor === null ? null : eventStream.decodeCursor(queryCursor);
        const decodedHeader = headerCursor === null ? null : eventStream.decodeCursor(headerCursor);
        if ((queryCursor !== null && decodedQuery === null) || (headerCursor !== null && decodedHeader === null)) {
          return sendSseResync(response, eventStream, "ambiguous_cursor");
        }
        const state = await referenceStateFacade.read();
        if (state.eventStream === null) return sendProblem(response, 409, "stream_resync_required");
        const generation = state.selection.generation;
        const effective = decodedHeader ?? decodedQuery ?? { epoch: eventStream.epoch, sequence: 0 };
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/event-stream; charset=utf-8",
          Connection: "keep-alive",
          "X-Content-Type-Options": "nosniff",
        });
        const connection = eventStream.listen(
          { epoch: effective.epoch, after: effective.sequence, generation },
          (event) => {
            if (!response.destroyed && !response.writableEnded) writeSseEvent(response, event, eventStream);
          },
        );
        if (connection.result.kind === "resync") {
          connection.close();
          return sendSseResync(response, eventStream, connection.result.reason ?? "ambiguous_cursor", generation);
        }
        for (const event of connection.result.events) writeSseEvent(response, event, eventStream);
        const close = () => {
          connection.close();
          activeStreams.delete(close);
        };
        activeStreams.add(close);
        request.once("aborted", close);
        response.once("close", close);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/state") {
        if (url.search !== "" || (await hasRequestBody(request)))
          return sendProblem(response, 400, "invalid_request");
        const session = authenticate(request, browser, origin);
        if (session === null) return sendProblem(response, 401, "unauthorized");
        return await sendProjectedSnapshot(
          response,
          referenceStateFacade,
          profile,
          session,
        );
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/draft") {
        if (url.search !== "" || (await hasRequestBody(request)))
          return sendProblem(response, 400, "invalid_request");
        if (!authenticate(request, browser, origin))
          return sendProblem(response, 401, "unauthorized");
        const draft = await referenceStateFacade.readDraft();
        if (!TavernBrowserValidatorsV1.BrowserDraftV1Schema.Check(draft))
          return sendProblem(response, 409, "state_reconciliation_required");
        return sendJson(response, 200, draft);
      }
      return sendProblem(response, 404, "profile_operation_unavailable");
    } catch (error) {
      const { status, code } = problemFor(error);
      if (!response.writableEnded && !response.destroyed)
        return sendProblem(response, status, code);
    }
  };
  return Object.freeze({
    handle(request, response, origin) {
      const active = dispatch(request, response, origin);
      activeDispatches.add(active);
      void active.finally(() => activeDispatches.delete(active));
    },
    async close() {
      closed = true;
      browser = undefined;
      for (const close of [...activeStreams]) close();
      // Closing sockets interrupts transport but cannot prove an already
      // admitted facade read is no longer using the mounted lease. Drain the
      // tracked dispatches before the composer permits lease closure, then
      // drain the service's post-finish claim/start work as well.
      await Promise.allSettled([...activeDispatches]);
      await pipelineService.close();
    },
  });
}

/** P3 standalone API listener, retained only for API-level tests and diagnostics. */
export async function startReferencePipelineDialogueWebServer(
  options: ReferencePipelineDialogueWebOptions,
): Promise<ReferencePipelineDialogueWebServer> {
  const handler = createReferencePipelineDialogueWebRequestHandler(options);
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
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
      await handlerDrain;
    },
  });
}

async function sendProjectedSnapshot(
  response: ServerResponse,
  facade: ReferencePipelineStateFacade,
  profile: ComposedTavernProfile,
  browser: BrowserSession,
): Promise<void> {
  const state = await facade.read();
  const snapshot = {
    apiVersion: 1,
    build: {
      browserContract: TAVERN_BROWSER_API_V1,
      profileId: profile.profileId,
    },
    csrfToken: browser.csrf,
    browserSession: { expiresAtMs: browser.expiresAtMs },
    operations: state.operations,
    navigation: profile.navigationItemIds.map(navigationItem),
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
      worldInfo: null,
    },
    memory: {
      readAvailable: false,
      mutationAvailable: false,
      projectionRevision: null,
    },
    eventStream: profile.routeIds.includes("events") && state.eventStream !== null
      ? state.eventStream
      : null,
  };
  if (!TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check(snapshot))
    return sendProblem(response, 409, "state_reconciliation_required");
  return sendJson(response, 200, snapshot);
}

function navigationItem(itemId: TavernBrowserNavigationItemIdV1) {
  if (itemId === "chat")
    return {
      itemId,
      labelKey: "tavern.nav.chat" as const,
      availability: "available" as const,
    };
  return {
    itemId,
    labelKey: "tavern.nav.memory" as const,
    availability: "unavailable" as const,
  };
}

function assertReferenceProfile(profile: ComposedTavernProfile): void {
  if (
    profile.profileId !== REFERENCE_PROFILE_ID ||
    profile.releaseTier !== REFERENCE_RELEASE_TIER ||
    !sameOrderedValues(profile.routeIds, REFERENCE_ROUTE_IDS) ||
    !sameOrderedValues(profile.operationIds, REFERENCE_OPERATION_IDS) ||
    !sameOrderedValues(profile.navigationItemIds, REFERENCE_NAVIGATION_ITEM_IDS)
  )
    throw new Error("reference_pipeline_profile_operation_unavailable");
}

function sameOrderedValues(
  values: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    values.length === expected.length &&
    values.every((value, index) => value === expected[index])
  );
}

function problemFor(
  error: unknown,
): Readonly<{ status: number; code: ProblemCode }> {
  const message = error instanceof Error ? error.message : "";
  if (message === "invalid_request")
    return { status: 400, code: "invalid_request" };
  if (message === "turn_busy") return { status: 409, code: "turn_busy" };
  if (message === "idempotency_conflict")
    return { status: 409, code: "idempotency_conflict" };
  if (message === "chat_draft_revision_conflict")
    return { status: 409, code: "draft_conflict" };
  if (message === "chat_pipeline_service_selection_conflict")
    return { status: 409, code: "selection_conflict" };
  if (
    message === "chat_pipeline_service_commit_rejected" ||
    message === "chat_pipeline_service_closed" ||
    message === "chat_pipeline_service_unavailable"
  )
    return { status: 503, code: "runtime_unavailable" };
  if (/storage|sqlite|eio|enoent/i.test(message))
    return { status: 503, code: "storage_unavailable" };
  if (/runtime|lease|mount/i.test(message))
    return { status: 503, code: "runtime_unavailable" };
  return { status: 409, code: "state_reconciliation_required" };
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
  if (
    !address ||
    typeof address === "string" ||
    address.address !== LOOPBACK_HOST
  )
    throw new Error("dialogue_loopback_bind_failed");
  return address.port;
}
async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? ""))
    throw new Error("invalid_request");
  const contentLength = request.headers["content-length"];
  if (
    contentLength !== undefined &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > maxBytes)
  )
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
  const transferEncoding = request.headers["transfer-encoding"];
  if (contentLength === undefined && transferEncoding === undefined) return false;
  let hasBody = contentLength !== undefined && contentLength !== "0";
  if (!hasBody && transferEncoding === undefined) return false;
  for await (const chunk of request) {
    if ((Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)) > 0)
      hasBody = true;
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
    !tokensEqual(
      cookie(request.headers.cookie, "gb_tavern_session") ?? "",
      browser.bearer,
    )
  )
    return null;
  return browser;
}
function isSameOrigin(request: IncomingMessage, origin: string): boolean {
  return request.headers.origin === origin;
}
/**
 * Browsers do not permit script to set Origin and may omit it on same-origin
 * safe-method fetches.  A P3 read therefore accepts an exact Origin when it
 * exists, or an origin-less browser same-origin Fetch Metadata request.  It
 * still requires the unguessable Strict browser-session cookie.
 */
function isBrowserSameOriginRead(
  request: IncomingMessage,
  origin: string,
): boolean {
  const requestOrigin = request.headers.origin;
  if (requestOrigin !== undefined) return requestOrigin === origin;
  return request.headers["sec-fetch-site"] === "same-origin";
}
function sendProblem(
  response: ServerResponse,
  status: number,
  code: ProblemCode,
): void {
  const problem: TavernProblemV1 = {
    type: `urn:gamebuddy:tavern:${code}`,
    title: code.replaceAll("_", " "),
    status,
    code,
    requestId: randomToken(),
    retryable: code === "storage_unavailable" || code === "runtime_unavailable",
  };
  if (!TavernBrowserValidatorsV1.TavernProblemV1Schema.Check(problem))
    throw new Error("invalid_problem");
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
function writeSseEvent(
  response: ServerResponse,
  event: import("./tavern/browser-contract/index.js").BrowserEventV1,
  stream: ChatEventStream,
): void {
  const id = stream.encodeCursor({ epoch: event.epoch, sequence: event.sequence });
  response.write(`id: ${id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
}

function sendSseResync(
  response: ServerResponse,
  stream: ChatEventStream,
  reason: import("./tavern/chat-event-stream.js").ResyncReason,
  generation = 1,
): void {
  if (!response.headersSent) {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    });
  }
  writeSseEvent(response, stream.resync(reason, generation), stream);
  response.end();
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sendJsonAfterFinish(
  response: ServerResponse,
  status: number,
  body: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      response.off("finish", onFinish);
      response.off("error", onError);
      response.off("close", onClose);
    };
    const onFinish = () => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    const onError = () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error("response_commit_failed"));
      }
    };
    const onClose = () => {
      if (!settled && !response.writableFinished) {
        settled = true;
        cleanup();
        reject(new Error("response_commit_failed"));
      }
    };
    response.once("finish", onFinish);
    response.once("error", onError);
    response.once("close", onClose);
    try {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(body));
    } catch {
      onError();
    }
  });
}

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function isIdempotencyKey(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9_-]{22}$/u.test(value);
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
