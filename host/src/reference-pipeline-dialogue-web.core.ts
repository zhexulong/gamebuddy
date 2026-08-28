import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type ComposedTavernProfile,
  TAVERN_BROWSER_API_V1,
  type TavernBrowserNavigationItemIdV1,
  TavernBrowserValidatorsV1,
  type TavernProblemV1,
} from "./tavern/browser-contract/index.js";
import type { ChatEventStream } from "./tavern/chat-event-stream.js";
import type { ReferencePipelineStateFacade } from "./tavern/reference-pipeline-state.js";

/**
 * Shared engine for the standalone and delegated reference-pipeline API
 * dispatchers. Nothing here is product authority: it holds no session,
 * service, or capability state and cannot mint an authenticated request.
 */

export const LOOPBACK_HOST = "127.0.0.1";
export const MAX_BOOTSTRAP_BODY_BYTES = 4 * 1024;
const REFERENCE_PROFILE_ID = "gamebuddy.chat-core.reference-pipeline";
const REFERENCE_RELEASE_TIER = "chat_core";
const REFERENCE_ROUTE_IDS = [
  "bootstrap",
  "state.read",
  "draft.read",
  "chat.submit",
  "chat.cancel",
  "chat.submission_status",
  "events",
] as const;
const REFERENCE_OPERATION_IDS = ["chat.submit", "chat.cancel"] as const;
const REFERENCE_NAVIGATION_ITEM_IDS = ["chat"] as const;

export type ReferencePipelineDialogueWebRequestHandler = Readonly<{
  handle(request: IncomingMessage, response: ServerResponse, origin: string): void;
  /** Rejects future API work and drains facade reads already admitted. */
  close(): Promise<void>;
}>;
export type BrowserSession = Readonly<{
  bearer: string;
  csrf: string;
  expiresAtMs: number;
}>;
type ProblemCode = TavernProblemV1["code"];

export async function sendProjectedSnapshot(
  response: ServerResponse,
  facade: ReferencePipelineStateFacade,
  profile: ComposedTavernProfile,
  browser: Readonly<Pick<BrowserSession, "csrf" | "expiresAtMs">>,
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
    eventStream: profile.routeIds.includes("events") && state.eventStream !== null ? state.eventStream : null,
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

export function assertReferenceProfile(profile: ComposedTavernProfile): void {
  if (
    profile.profileId !== REFERENCE_PROFILE_ID ||
    profile.releaseTier !== REFERENCE_RELEASE_TIER ||
    !sameOrderedValues(profile.routeIds, REFERENCE_ROUTE_IDS) ||
    !sameOrderedValues(profile.operationIds, REFERENCE_OPERATION_IDS) ||
    !sameOrderedValues(profile.navigationItemIds, REFERENCE_NAVIGATION_ITEM_IDS)
  )
    throw new Error("reference_pipeline_profile_operation_unavailable");
}

function sameOrderedValues(values: readonly string[], expected: readonly string[]): boolean {
  return values.length === expected.length && values.every((value, index) => value === expected[index]);
}

export function problemFor(error: unknown): Readonly<{ status: number; code: ProblemCode }> {
  const message = error instanceof Error ? error.message : "";
  if (message === "invalid_request") return { status: 400, code: "invalid_request" };
  if (message === "turn_busy") return { status: 409, code: "turn_busy" };
  if (message === "idempotency_conflict") return { status: 409, code: "idempotency_conflict" };
  if (message === "chat_draft_revision_conflict") return { status: 409, code: "draft_conflict" };
  if (message === "chat_pipeline_service_selection_conflict") return { status: 409, code: "selection_conflict" };
  if (
    message === "chat_pipeline_service_commit_rejected" ||
    message === "chat_pipeline_service_closed" ||
    message === "chat_pipeline_service_unavailable"
  )
    return { status: 503, code: "runtime_unavailable" };
  if (/storage|sqlite|eio|enoent/i.test(message)) return { status: 503, code: "storage_unavailable" };
  if (/runtime|lease|mount/i.test(message)) return { status: 503, code: "runtime_unavailable" };
  return { status: 409, code: "state_reconciliation_required" };
}

export async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
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

export async function hasRequestBody(request: IncomingMessage): Promise<boolean> {
  const contentLength = request.headers["content-length"];
  const transferEncoding = request.headers["transfer-encoding"];
  if (contentLength === undefined && transferEncoding === undefined) return false;
  let hasBody = contentLength !== undefined && contentLength !== "0";
  if (!hasBody && transferEncoding === undefined) return false;
  for await (const chunk of request) {
    if ((Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)) > 0) hasBody = true;
  }
  return hasBody;
}

export function isSameOrigin(request: IncomingMessage, origin: string): boolean {
  return request.headers.origin === origin;
}

/**
 * Browsers do not permit script to set Origin and may omit it on same-origin
 * safe-method fetches.  A reference-pipeline read therefore accepts an exact Origin when it
 * exists, or an origin-less browser same-origin Fetch Metadata request.  It
 * still requires the unguessable Strict browser-session cookie.
 */
export function isBrowserSameOriginRead(request: IncomingMessage, origin: string): boolean {
  const requestOrigin = request.headers.origin;
  if (requestOrigin !== undefined) return requestOrigin === origin;
  return request.headers["sec-fetch-site"] === "same-origin";
}

export function sendProblem(response: ServerResponse, status: number, code: ProblemCode): void {
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

export function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
}

export function writeSseEvent(
  response: ServerResponse,
  event: import("./tavern/browser-contract/index.js").BrowserEventV1,
  stream: ChatEventStream,
): void {
  const id = stream.encodeCursor({ epoch: event.epoch, sequence: event.sequence });
  response.write(`id: ${id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function sendSseResync(
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

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export function sendJsonAfterFinish(response: ServerResponse, status: number, body: unknown): Promise<void> {
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

export function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

export function isIdempotencyKey(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9_-]{22}$/u.test(value);
}

export function isExactLoopbackHost(request: IncomingMessage, port: number): boolean {
  return request.headers.host === `${LOOPBACK_HOST}:${port}`;
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}