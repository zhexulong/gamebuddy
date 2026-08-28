import type { IncomingMessage, ServerResponse } from "node:http";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import {
  type ComposedTavernProfile,
  TavernBrowserContractV1,
  TavernBrowserValidatorsV1,
} from "./tavern/browser-contract/index.js";
import type { ChatEventStream } from "./tavern/chat-event-stream.js";
import type { ChatPipelineService } from "./tavern/chat-pipeline-service.js";
import type { ReferencePipelineStateFacade } from "./tavern/reference-pipeline-state.js";
import {
  MAX_BOOTSTRAP_BODY_BYTES,
  assertReferenceProfile,
  hasRequestBody,
  isBrowserSameOriginRead,
  isExactLoopbackHost,
  isIdempotencyKey,
  isSameOrigin,
  problemFor,
  readJsonBody,
  sendJson,
  sendJsonAfterFinish,
  sendProblem,
  sendProjectedSnapshot,
  sendSseResync,
  setSecurityHeaders,
  singleHeader,
  writeSseEvent,
  type ReferencePipelineDialogueWebRequestHandler,
} from "./reference-pipeline-dialogue-web.core.js";
import {
  checkComposedReferenceGameBrowserAuthCsrf,
  composedReferenceGameBrowserAuthProjection,
  isComposedReferenceGameBrowserDelegatedAuthCapability,
  verifyComposedReferenceGameBrowserAuth,
  type ComposedReferenceGameBrowserDelegatedAuthCapability,
} from "./composed-reference-game-browser.js";

/**
 * INTERNAL delegated reference-pipeline dispatcher: the only intended
 * consumer is the composed static-shell composition, which mounts it on the
 * broker's single loopback listener. It holds no bootstrap, session, or CSRF
 * state of its own; every admission and projection is brokered through the
 * opaque branded capability minted by `composed-reference-game-browser.ts`.
 * A forged or foreign capability fails here at construction, before any
 * Tavern operation is reachable.
 */

export type ReferencePipelineDialogueWebDelegatedOptions = Readonly<{
  profile: ComposedTavernProfile;
  referenceStateFacade: ReferencePipelineStateFacade;
  pipelineService?: ChatPipelineService;
  eventStream?: ChatEventStream;
  /** The broker-minted opaque branded capability; anything else is rejected. */
  capability: ComposedReferenceGameBrowserDelegatedAuthCapability;
}>;

export function createReferencePipelineDialogueWebDelegatedHandler(
  options: ReferencePipelineDialogueWebDelegatedOptions,
): ReferencePipelineDialogueWebRequestHandler {
  if (!isComposedReferenceGameBrowserDelegatedAuthCapability(options.capability))
    throw new Error("reference_pipeline_delegated_capability_invalid");
  const referenceStateFacade = options.referenceStateFacade;
  const pipelineService = options.pipelineService;
  const eventStream = options.eventStream;
  const profile = options.profile;
  const capability = options.capability;
  assertReferenceProfile(profile);
  if (profile.routeIds.includes("events") !== (eventStream !== undefined))
    throw new Error("reference_pipeline_event_stream_unavailable");

  let closed = false;
  const activeDispatches = new Set<Promise<void>>();
  const activeStreams = new Set<() => void>();
  const dispatch = async (request: IncomingMessage, response: ServerResponse, origin: string): Promise<void> => {
    setSecurityHeaders(response);
    const port = new URL(origin).port;
    if (new URL(origin).protocol !== "http:" || !/^\d+$/.test(port) || !isExactLoopbackHost(request, Number(port)))
      return sendProblem(response, 421, "invalid_request");
    if (closed) return sendProblem(response, 503, "runtime_unavailable");
    const url = new URL(request.url ?? "/", origin);
    try {
      // The broker owns bootstrap/session/CSRF; the delegated dispatcher
      // never serves a second bootstrap and never issues another cookie.
      if (request.method === "POST" && url.pathname === "/api/tavern/v1/bootstrap")
        return sendProblem(response, 404, "profile_operation_unavailable");
      if (request.method === "POST" && url.pathname === "/api/tavern/v1/messages") {
        if (url.search !== "" || !isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
        const context = verifyComposedReferenceGameBrowserAuth(capability, request, origin);
        if (context === null) return sendProblem(response, 401, "unauthorized");
        if (!checkComposedReferenceGameBrowserAuthCsrf(context, request)) return sendProblem(response, 403, "csrf_failed");
        const idempotencyKey = singleHeader(request.headers["idempotency-key"]);
        if (!isIdempotencyKey(idempotencyKey)) return sendProblem(response, 400, "invalid_request");
        const body = await readJsonBody(request, MAX_BOOTSTRAP_BODY_BYTES);
        const route = TavernBrowserContractV1.routes.find((entry) => entry.routeId === "chat.submit");
        if (route === undefined || !("request" in route) || !Compile(route.request).Check(body))
          return sendProblem(response, 400, "invalid_request");
        if (pipelineService === undefined) return sendProblem(response, 503, "runtime_unavailable");
        const result = await pipelineService.submitAfterResponseCommit(
          body as import("./tavern/browser-contract/index.js").SubmitMessageCommandV1,
          idempotencyKey,
          async (committed) => {
            if (!TavernBrowserValidatorsV1.SubmitResultV1Schema.Check(committed))
              throw new Error("chat_pipeline_service_unavailable");
            await sendJsonAfterFinish(response, 202, committed);
          },
        );
        if (!TavernBrowserValidatorsV1.SubmitResultV1Schema.Check(result))
          throw new Error("chat_pipeline_service_unavailable");
        return;
      }
      if (request.method === "POST" && /^\/api\/tavern\/v1\/turns\/[A-Za-z0-9_-]{22,128}\/cancel$/u.test(url.pathname)) {
        if (url.search !== "" || !isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
        const context = verifyComposedReferenceGameBrowserAuth(capability, request, origin);
        if (context === null) return sendProblem(response, 401, "unauthorized");
        if (!checkComposedReferenceGameBrowserAuthCsrf(context, request)) return sendProblem(response, 403, "csrf_failed");
        const body = await readJsonBody(request, MAX_BOOTSTRAP_BODY_BYTES);
        const route = TavernBrowserContractV1.routes.find((entry) => entry.routeId === "chat.cancel");
        if (route === undefined || !("request" in route) || !Compile(route.request).Check(body))
          return sendProblem(response, 400, "invalid_request");
        if (pipelineService === undefined) return sendProblem(response, 503, "runtime_unavailable");
        const turnHandle = url.pathname.split("/")[5];
        const turn = await pipelineService.cancel(
          turnHandle,
          body as import("./tavern/browser-contract/index.js").CancelTurnCommandV1,
        );
        if (!TavernBrowserValidatorsV1.BrowserTurnV1Schema.Check(turn))
          throw new Error("chat_pipeline_service_unavailable");
        const disposition = turn.state === "cancelled" ? "cancelled" : turn.state === "completed" ? "completion_won" : "already_terminal";
        const result = Object.freeze({ apiVersion: 1 as const, disposition, turn });
        if (!TavernBrowserValidatorsV1.CancelTurnResultV1Schema.Check(result))
          throw new Error("chat_pipeline_service_unavailable");
        return sendJson(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/tavern/v1/message-submission-status") {
        if (url.search !== "" || !isSameOrigin(request, origin)) return sendProblem(response, 401, "unauthorized");
        if (verifyComposedReferenceGameBrowserAuth(capability, request, origin) === null)
          return sendProblem(response, 401, "unauthorized");
        const body = await readJsonBody(request, MAX_BOOTSTRAP_BODY_BYTES);
        const route = TavernBrowserContractV1.routes.find((entry) => entry.routeId === "chat.submission_status");
        if (route === undefined || !("request" in route) || !Compile(route.request).Check(body))
          return sendProblem(response, 400, "invalid_request");
        if (pipelineService === undefined) return sendProblem(response, 503, "runtime_unavailable");
        const status = await pipelineService.readSubmissionStatus(
          body as import("./tavern/browser-contract/index.js").MessageSubmissionStatusQueryV1,
        );
        if (!TavernBrowserValidatorsV1.MessageSubmissionStatusV1Schema.Check(status))
          throw new Error("chat_pipeline_service_unavailable");
        return sendJson(response, 200, status);
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/events") {
        if (url.searchParams.has("unexpected") || (await hasRequestBody(request)))
          return sendProblem(response, 400, "invalid_request");
        if (!isBrowserSameOriginRead(request, origin) || verifyComposedReferenceGameBrowserAuth(capability, request, origin) === null)
          return sendProblem(response, 401, "unauthorized");
        if (eventStream === undefined) return sendProblem(response, 404, "profile_operation_unavailable");
        const apiVersion = url.searchParams.get("apiVersion");
        if (apiVersion !== "1" || url.searchParams.getAll("apiVersion").length !== 1)
          return sendProblem(response, 400, "invalid_request");
        const queryCursor = url.searchParams.get("cursor");
        if (url.searchParams.getAll("cursor").length > 1) return sendProblem(response, 400, "invalid_request");
        const rawHeaderCursor = request.headers["last-event-id"];
        if (Array.isArray(rawHeaderCursor)) return sendSseResync(response, eventStream, "ambiguous_cursor");
        const headerCursor = singleHeader(rawHeaderCursor);
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
        response.flushHeaders();
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
        if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
        const context = verifyComposedReferenceGameBrowserAuth(capability, request, origin);
        if (context === null) return sendProblem(response, 401, "unauthorized");
        const projection = composedReferenceGameBrowserAuthProjection(context);
        return await sendProjectedSnapshot(response, referenceStateFacade, profile, {
          csrf: projection.csrfToken,
          expiresAtMs: projection.browserSessionExpiresAtMs,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/tavern/v1/draft") {
        if (url.search !== "" || (await hasRequestBody(request))) return sendProblem(response, 400, "invalid_request");
        if (verifyComposedReferenceGameBrowserAuth(capability, request, origin) === null)
          return sendProblem(response, 401, "unauthorized");
        const draft = await referenceStateFacade.readDraft();
        if (!TavernBrowserValidatorsV1.BrowserDraftV1Schema.Check(draft))
          return sendProblem(response, 409, "state_reconciliation_required");
        return sendJson(response, 200, draft);
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
      closed = true;
      for (const close of [...activeStreams]) close();
      await Promise.allSettled([...activeDispatches]);
      await pipelineService?.close();
    },
  });
}