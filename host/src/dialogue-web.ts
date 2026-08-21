import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_COMPANION_MODEL_CONFIG, resolveRuntimePaths, type CompanionIdentity, type CompanionModelConfig, type RuntimeSession } from "./runtime-core.js";
import { createChatCompanionRuntime } from "./runtime-chat.js";
import { selectContinuitySession, type SurfaceSession } from "./continuity.js";
import { type IdentityProfile } from "./identity-profile.js";
import { type WorldBookBinding } from "./worldbook.js";
import { DialogueController, type DialogueControllerEvent, validateDialogueInput } from "./dialogue-controller.js";
import { type CompanionTextExpression, type CompanionTextPort, type PresentationRuntime } from "./presentation.js";
import { appendChatTranscript, chatTranscriptPath, readChatTranscript } from "./chat-transcript.js";

const BOOTSTRAP_TTL_MS = 60_000;
const BROWSER_TTL_SECONDS = 60 * 60 * 2;
const MAX_BODY_BYTES = 16 * 1024;
const LOOPBACK_HOST = "127.0.0.1";

export type DialogueWebOptions = Readonly<{
  /** Internal test seam; never accepted from browser/operator configuration. */
  internalMagicContextFeatureTestOverride?: Readonly<{
    memoryEnabled?: boolean;
    historianEnabled?: boolean;
    historianExecuteThresholdTokens?: number;
    historianExecuteThresholdPercentage?: number;
  }>;
  identity: CompanionIdentity;
  runtimeRoot?: string;
  modelConfig?: CompanionModelConfig;
  staticDir?: string;
  initialProfile?: IdentityProfile;
  /** Explicitly resume one existing chat surface; omitted resumes the latest chat surface. */
  surfaceSessionId?: string;
  worldBook?: WorldBookBinding;
}>;

export type DialogueWebServer = Readonly<{
  url: string;
  runtime: RuntimeSession;
  surfaceSession: SurfaceSession;
  /** Bounded test probes may terminate idle local SSE keep-alive sockets first. */
  closeAllConnections(): void;
  close(): Promise<void>;
}>;

type BrowserSession = Readonly<{
  bearer: string;
  csrf: string;
  expiresAtMs: number;
}>;

type OutboundEvent =
  | Readonly<{ type: "presentation_text"; expressionId: string; sourceEventId: string; text: string; locale: string }>
  | DialogueControllerEvent;

/**
 * GameBuddy's loopback-only Dialogue surface. Browser clients never select an
 * identity, model, tool set, runtime path, or Pi session; all are established
 * before the listener begins accepting connections.
 */
export async function startDialogueWebServer(options: DialogueWebOptions): Promise<DialogueWebServer> {
  if (options.identity.continuityId === undefined) throw new Error("dialogue_continuity_id_required");
  const continuityPaths = resolveRuntimePaths(options.identity, options.runtimeRoot);
  const selection = await selectContinuitySession(continuityPaths, options.identity, { surface: "chat", ...(options.surfaceSessionId === undefined ? {} : { sessionId: options.surfaceSessionId }) });
  const presentation = new DialoguePresentationPort();
  const runtime = await createChatCompanionRuntime({
    identity: options.identity,
    root: options.runtimeRoot,
    modelConfig: options.modelConfig ?? DEFAULT_COMPANION_MODEL_CONFIG,
    presentation: {
      profile: { locale: "zh-CN", text: true, speech: null },
      surface: "chat",
      sessionId: selection.session.sessionId,
      textPort: presentation,
    } satisfies PresentationRuntime,
    initialProfile: options.initialProfile,
    surfaceSessionId: selection.session.sessionId,
    worldBook: options.worldBook,
    internalMagicContextFeatureTestOverride: options.internalMagicContextFeatureTestOverride,
  });
  const toolNames = runtime.session.agent.state.tools.map((tool) => tool.name).sort();
  const expectedTools = ["companion_status", "companion_text", "todowrite", ...(options.worldBook === undefined ? [] : ["companion_worldbook_catalog", "companion_worldbook_query"])].sort();
  if (JSON.stringify(toolNames) !== JSON.stringify(expectedTools)) {
    runtime.session.dispose();
    throw new Error("dialogue_tool_isolation_failed");
  }

  const transcriptPath = chatTranscriptPath(runtime.paths);
  const transcript = await readChatTranscript(transcriptPath, selection.session.sessionId);
  // Each queued browser turn must produce an explicit companion_text event.
  // Ordinary assistant output remains private and cannot complete the turn.
  let activePresentationCount = 0;
  const controller = new DialogueController(runtime.session, Date.now, () => activePresentationCount > 0);
  const bootstrap = randomToken();
  const bootstrapExpiresAtMs = Date.now() + BOOTSTRAP_TTL_MS;
  let bootstrapConsumed = false;
  let browser: BrowserSession | undefined;
  let eventStream: ServerResponse | undefined;
  let closed = false;
  const staticDir = options.staticDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../dialogue-web/dist");
  const isWorldBookBound = options.worldBook !== undefined;

  const publish = (event: OutboundEvent): void => {
    if (eventStream === undefined || eventStream.destroyed) return;
    eventStream.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const detachPresentation = presentation.subscribe((expression) => {
    activePresentationCount++;
    void appendChatTranscript(transcriptPath, selection.session.sessionId, { entryId: expression.expressionId, role: "companion", text: expression.text, occurredAtMs: Date.now(), sourceEventId: expression.sourceEventId });
    publish({ type: "presentation_text", expressionId: expression.expressionId, sourceEventId: expression.sourceEventId, text: expression.text, locale: expression.locale });
  });
  const detachController = controller.subscribe((event) => {
    if (event.type === "turn_started") activePresentationCount = 0;
    publish(event);
  });

  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response);
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: "request_failed" });
      else response.end();
    }
  });

  const port = await listenLoopback(server);
  const origin = `http://${LOOPBACK_HOST}:${port}`;
  const url = `${origin}/#boot=${bootstrap}`;

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", origin);
    if (!isExactLoopbackHost(request, port)) return sendJson(response, 403, { error: "forbidden" });
    setSecurityHeaders(response);
    if (request.method === "OPTIONS") return sendJson(response, 405, { error: "method_not_allowed" });

    if (request.method === "GET" && requestUrl.pathname === "/events") {
      const active = authenticate(request, false);
      if (active === null) return sendJson(response, 401, { error: "unauthorized" });
      eventStream?.end();
      eventStream = response;
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      response.write("event: ready\ndata: {}\n\n");
      request.on("close", () => { if (eventStream === response) eventStream = undefined; });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/bootstrap") {
      if (!isExactOrigin(request, origin)) return sendJson(response, 403, { error: "forbidden" });
      const body = await readJsonBody(request);
      if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.token !== "string"
        || bootstrapConsumed || Date.now() > bootstrapExpiresAtMs || !tokensEqual(body.token, bootstrap)) {
        return sendJson(response, 401, { error: "unauthorized" });
      }
      bootstrapConsumed = true;
      browser = Object.freeze({ bearer: randomToken(), csrf: randomToken(), expiresAtMs: Date.now() + BROWSER_TTL_SECONDS * 1_000 });
      response.setHeader("Set-Cookie", `gb_dialogue_session=${browser.bearer}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${BROWSER_TTL_SECONDS}`);
      return sendJson(response, 200, {
        csrf: browser.csrf,
        companion: { name: runtime.profile.identity.name, profileId: runtime.identityProfile.profileId, revision: runtime.identityProfile.revision },
        session: { id: selection.session.sessionId, surface: selection.session.surface },
        continuity: { id: options.identity.continuityId ?? null },
        transcript: transcript.entries.map((entry) => ({ entryId: entry.entryId, role: entry.role, text: entry.text, occurredAtMs: entry.occurredAtMs })),
        worldBook: isWorldBookBound ? { worldBookId: options.worldBook!.metadata.worldBookId, revision: options.worldBook!.metadata.revision } : null,
      });
    }

    if (request.method === "POST" && requestUrl.pathname === "/message") {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      try {
        const input = validateDialogueInput(body);
        const result = await controller.submit(input);
        if (result === "accepted") {
          await appendChatTranscript(transcriptPath, selection.session.sessionId, { entryId: input.clientMessageId, role: "player", text: input.text, occurredAtMs: Date.now(), sourceEventId: input.clientMessageId });
        }
        return sendJson(response, 202, { accepted: result === "accepted", duplicate: result === "duplicate" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return sendJson(response, message === "dialogue_queue_full" ? 429 : 400, { error: message === "dialogue_queue_full" ? "busy" : "invalid_request" });
      }
    }

    if (request.method === "POST" && requestUrl.pathname === "/stop") {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.clientStopId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.clientStopId)) {
        return sendJson(response, 400, { error: "invalid_request" });
      }
      await controller.stop();
      return sendJson(response, 202, { accepted: true });
    }

    if (request.method === "GET") return serveStatic(requestUrl.pathname, response, staticDir);
    return sendJson(response, 404, { error: "not_found" });
  }

  function authenticate(request: IncomingMessage, requireCsrf: boolean): BrowserSession | null {
    if (browser === undefined || browser.expiresAtMs < Date.now()) return null;
    if ((requireCsrf && !isExactOrigin(request, origin)) || !isSameSiteFetch(request)) return null;
    const bearer = cookie(request.headers.cookie, "gb_dialogue_session");
    if (bearer === undefined || !tokensEqual(bearer, browser.bearer)) return null;
    if (requireCsrf && (typeof request.headers["x-gamebuddy-csrf"] !== "string" || !tokensEqual(request.headers["x-gamebuddy-csrf"], browser.csrf))) return null;
    return browser;
  }

  return Object.freeze({
    url,
    runtime,
    surfaceSession: selection.session,
    closeAllConnections(): void { server.closeAllConnections(); },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      browser = undefined;
      eventStream?.end();
      detachPresentation();
      detachController();
      controller.close();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      runtime.session.dispose();
    },
  });
}

class DialoguePresentationPort implements CompanionTextPort {
  readonly #listeners = new Set<(expression: CompanionTextExpression) => void>();
  public present(expression: CompanionTextExpression): void { for (const listener of this.#listeners) listener(expression); }
  public subscribe(listener: (expression: CompanionTextExpression) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => { server.off("error", rejectListen); resolveListen(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== LOOPBACK_HOST) throw new Error("dialogue_loopback_bind_failed");
  return address.port;
}

async function serveStatic(pathname: string, response: ServerResponse, staticDir: string): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^[A-Za-z0-9._/-]{1,512}$/.test(relative) || relative.includes("..")) return sendJson(response, 404, { error: "not_found" });
  try {
    const path = join(staticDir, relative);
    const content = await readFile(path);
    const type = extname(path) === ".js" ? "text/javascript; charset=utf-8" : extname(path) === ".css" ? "text/css; charset=utf-8" : "text/html; charset=utf-8";
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    response.end(content);
  } catch { sendJson(response, 404, { error: "not_found" }); }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")) throw new Error("invalid_content_type");
  const parts: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("body_too_large");
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
}
function sendJson(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(body)); }
function isExactLoopbackHost(request: IncomingMessage, port: number): boolean { return request.headers.host === `${LOOPBACK_HOST}:${port}`; }
function isExactOrigin(request: IncomingMessage, origin: string): boolean { return request.headers.origin === origin; }
function isSameSiteFetch(request: IncomingMessage): boolean { const site = request.headers["sec-fetch-site"]; return site === undefined || site === "same-origin" || site === "none"; }
function randomToken(): string { return randomBytes(32).toString("base64url"); }
function tokensEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function cookie(header: string | undefined, name: string): string | undefined { return header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
