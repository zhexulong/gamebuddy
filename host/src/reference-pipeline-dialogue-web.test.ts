import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import {
  createReferencePipelineDialogueWebRequestHandler,
  startReferencePipelineDialogueWebServer,
} from "./reference-pipeline-dialogue-web.js";
import { composeTavernProfile } from "./tavern/browser-contract/index.js";
import { createChatEventStream } from "./tavern/chat-event-stream.js";
import type { ChatPipelineService, SubmitResultV1 } from "./tavern/chat-pipeline-service.js";
import type { ReferencePipelineState, ReferencePipelineStateFacade } from "./tavern/reference-pipeline-state.js";

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const handle = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const profile = composeTavernProfile({
  profileId: "gamebuddy.chat-core.reference-pipeline",
  releaseTier: "chat_core",
  routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status", "events"],
  operationIds: ["chat.submit", "chat.cancel"],
  navigationItemIds: ["chat"],
});

const eventStream = createChatEventStream();
const state: ReferencePipelineState = Object.freeze({
  selection: Object.freeze({
    chatHandle: handle,
    generation: 1,
    stateRevision: handle,
  }),
  companionDisplayName: "Companion",
  title: "Reference Chat",
  transcript: Object.freeze([]),
  draft: Object.freeze({ revision: 4, text: "draft" }),
  turn: null,
  operations: Object.freeze([
    Object.freeze({
      operationId: "chat.submit" as const,
      labelKey: "tavern.operation.submit" as const,
      availability: "available" as const,
      routeId: "chat.submit",
    }),
  ]),
  eventStream: Object.freeze({ epoch: eventStream.epoch, cursor: eventStream.cursor }),
});
const facade: ReferencePipelineStateFacade = Object.freeze({
  read: async () => state,
  readDraft: async () => Object.freeze({ apiVersion: 1, revision: 4, text: "draft" }),
});
async function openSse(
  url: string,
  headers: Record<string, string | string[]>,
): Promise<
  Readonly<{
    response: IncomingMessage;
    /** Buffered bytes up to the first complete `\n\n` SSE frame. */
    readFrame(): Promise<string>;
    /** Remaining buffered bytes once the response ends, or empty when already ended. */
    readToEnd(): Promise<string>;
    close(): Promise<void>;
  }>
> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(url, { agent: false, headers }, (response) => {
      resolve(
        Object.freeze({
          response,
          readFrame: () => readSseUntil(response, "frame"),
          readToEnd: () => readSseUntil(response, "end"),
          close: async () => {
            if (response.destroyed) return;
            await new Promise<void>((resolveClose) => {
              response.once("close", resolveClose);
              response.destroy();
              request.destroy();
            });
          },
        }),
      );
    });
    request.once("error", (error) => reject(error));
    request.end();
  });
}

/**
 * Bounded reader so SSE tests fail on a stalled connection instead of
 * hanging: "frame" resolves at the first `\n\n` boundary, "end" resolves
 * when the response completes. Both reject after SSE_STALL_TIMEOUT_MS.
 *
 * Each response keeps ONE persistent `data` listener with a frame buffer:
 * a Node stream stays in flowing mode after its last `data` listener is
 * removed, so a per-read attach/detach scanner would silently discard bytes
 * that arrive between two reads on the same connection. Frame reads consume
 * exactly one `\n\n`-terminated frame from the shared buffer; the remainder
 * stays buffered for the next read.
 */
const SSE_STALL_TIMEOUT_MS = 2_000;
type SseWaiter = {
  until: "frame" | "end";
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};
type SseReader = {
  buffer: string;
  frames: string[];
  ended: boolean;
  waiters: SseWaiter[];
};
const sseReaders = new WeakMap<IncomingMessage, SseReader>();
function readSseUntil(response: IncomingMessage, until: "frame" | "end"): Promise<string> {
  let reader = sseReaders.get(response);
  if (reader === undefined) {
    const created: SseReader = { buffer: "", frames: [], ended: false, waiters: [] };
    reader = created;
    sseReaders.set(response, reader);
    response.on("data", (value: Buffer) => {
      created.buffer += value.toString("utf8");
      breakSseFrames(created);
    });
    response.on("end", () => {
      settleSseReads(created);
    });
    response.on("error", (error: Error) => {
      const cause = error instanceof Error ? error : new Error("sse_read_failed");
      for (const waiter of [...created.waiters]) {
        clearTimeout(waiter.timeout);
        waiter.reject(cause);
      }
      created.waiters = [];
    });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reader.waiters = reader.waiters.filter((waiter) => waiter !== entry);
      reject(new Error(until === "frame" ? "sse_frame_timeout" : "sse_end_timeout"));
    }, SSE_STALL_TIMEOUT_MS);
    if (until === "frame") {
      if (reader.frames.length > 0) {
        const frame = reader.frames.shift();
        if (frame !== undefined) {
          clearTimeout(timeout);
          resolve(frame);
          return;
        }
      }
      if (reader.ended) {
        clearTimeout(timeout);
        resolve(reader.buffer);
        return;
      }
    } else if (reader.ended) {
      clearTimeout(timeout);
      resolve(reader.buffer);
      return;
    }
    const entry: SseWaiter = { until, resolve, reject, timeout };
    reader.waiters.push(entry);
    breakSseFrames(reader);
  });
}
function breakSseFrames(reader: SseReader): void {
  while (true) {
    const frameEnd = reader.buffer.indexOf("\n\n");
    if (frameEnd < 0) return;
    const frame = reader.buffer.slice(0, frameEnd + 2);
    reader.buffer = reader.buffer.slice(frameEnd + 2);
    const index = reader.waiters.findIndex((waiter) => waiter.until === "frame");
    if (index < 0) {
      reader.frames.push(frame);
      continue;
    }
    const waiter = reader.waiters.splice(index, 1)[0];
    if (waiter === undefined) continue;
    clearTimeout(waiter.timeout);
    waiter.resolve(frame);
  }
}
function settleSseReads(reader: SseReader): void {
  reader.ended = true;
  for (const waiter of [...reader.waiters]) {
    clearTimeout(waiter.timeout);
    if (waiter.until === "frame" && reader.frames.length > 0) {
      const frame = reader.frames.shift();
      waiter.resolve(frame === undefined ? reader.buffer : frame);
    } else {
      waiter.resolve(reader.buffer);
    }
  }
  reader.waiters = [];
}

function parseSseFrame(frame: string): Readonly<{
  id: string;
  eventType: string;
  event: {
    apiVersion: number;
    epoch: string;
    sequence: number;
    eventType: string;
    selectionGeneration: number;
    payload: unknown;
  };
}> {
  const lines = frame.split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines[3], "");
  assert.equal(lines[4], "");
  const id = lines[0].slice("id: ".length);
  assert.match(id, /^[A-Za-z0-9_-]{22,}$/);
  const eventType = lines[1].slice("event: ".length);
  assert.notEqual(eventType, lines[1]);
  const data = lines[2];
  assert.ok(data.startsWith("data: "));
  const event = JSON.parse(data.slice("data: ".length)) as {
    apiVersion: number;
    epoch: string;
    sequence: number;
    eventType: string;
    selectionGeneration: number;
    payload: unknown;
  };
  assert.equal(event.apiVersion, 1);
  return Object.freeze({ id, eventType, event });
}

const result: SubmitResultV1 = Object.freeze({
  apiVersion: 1,
  disposition: "accepted",
  message: Object.freeze({
    handle,
    role: "player",
    text: "Hello",
    locale: "en",
    order: 0,
    revision: 1,
  }),
  turn: Object.freeze({
    handle,
    state: "queued",
    projectionRevision: 1,
    canCancel: false,
  }),
});

function service(recorder: {
  starts: number;
  statuses: number;
  closes: number;
  cancels?: string[];
}): ChatPipelineService {
  return Object.freeze({
    async submitAfterResponseCommit(command, idempotencyKey, commit202) {
      assert.equal(command.text, "Hello");
      assert.equal(idempotencyKey, "A".repeat(22));
      assert.equal(recorder.starts, 0);
      await commit202(result);
      recorder.starts += 1;
      return result;
    },
    async readSubmissionStatus(query) {
      recorder.statuses += 1;
      assert.deepEqual(query, {
        apiVersion: 1,
        idempotencyKey: "A".repeat(22),
        selectionGeneration: 1,
      });
      return Object.freeze({
        apiVersion: 1,
        disposition: "accepted" as const,
        committedResult: result,
      });
    },
    async cancel(turnHandle, command) {
      if (command.selectionGeneration !== 1) throw new Error("chat_pipeline_service_selection_conflict");
      recorder.cancels?.push(turnHandle);
      return Object.freeze({ ...result.turn, state: "cancelled" as const });
    },
    async close() {
      recorder.closes += 1;
    },
  });
}

test("reference handler exposes the exact seven-route profile and starts after response finish", async () => {
  const recorder = { starts: 0, statuses: 0, closes: 0 };
  const server = await startReferencePipelineDialogueWebServer({
    referenceStateFacade: facade,
    pipelineService: service(recorder),
    profile,
    eventStream,
    bootstrapToken: token,
  });
  try {
    const origin = server.origin;
    const bootstrap = await fetch(`${origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    assert.equal(bootstrap.status, 200);
    const snapshot = (await bootstrap.json()) as {
      csrfToken: string;
      operations: unknown[];
      chat: unknown;
    };
    assert.deepEqual(snapshot.operations, state.operations);
    assert.deepEqual(snapshot.chat, {
      companion: { name: "Companion" },
      title: "Reference Chat",
      transcript: [],
      draft: { revision: 4, present: true },
      turn: null,
      worldInfo: null,
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const submit = await fetch(`${origin}/api/tavern/v1/messages`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": snapshot.csrfToken,
        "Idempotency-Key": "A".repeat(22),
      },
      body: JSON.stringify({
        apiVersion: 1,
        selectionGeneration: 1,
        text: "Hello",
        locale: "en",
      }),
    });
    assert.equal(submit.status, 202);
    assert.deepEqual(await submit.json(), result);
    assert.equal(recorder.starts, 1);
    const status = await fetch(`${origin}/api/tavern/v1/message-submission-status`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        apiVersion: 1,
        idempotencyKey: "A".repeat(22),
        selectionGeneration: 1,
      }),
    });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      apiVersion: 1,
      disposition: "accepted",
      committedResult: result,
    });
    assert.equal(recorder.statuses, 1);
    const invalidEvents = await fetch(`${origin}/api/tavern/v1/events`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    assert.equal(invalidEvents.status, 400);
    for (const path of ["/api/tavern/v1/turns/x/cancel", "/api/tavern/v1/memories"]) {
      const response = await fetch(`${origin}${path}`, {
        headers: { Origin: origin, Cookie: cookie },
      });
      assert.equal(response.status, 404);
    }
  } finally {
    await server.close();
  }
  assert.equal(recorder.closes, 1);
});

test("reference handler validates, authenticates, and returns the reread cancellation winner", async () => {
  const recorder = { starts: 0, statuses: 0, closes: 0, cancels: [] as string[] };
  const server = await startReferencePipelineDialogueWebServer({
    referenceStateFacade: facade,
    pipelineService: service(recorder),
    profile,
    eventStream,
    bootstrapToken: token,
  });
  try {
    const bootstrap = await fetch(`${server.origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    assert.equal(bootstrap.status, 200);
    const snapshot = (await bootstrap.json()) as { csrfToken: string };
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const path = `/api/tavern/v1/turns/${handle}/cancel`;
    const unauthorized = await fetch(`${server.origin}${path}`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1 }),
    });
    assert.equal(unauthorized.status, 401);
    const csrfFailed = await fetch(`${server.origin}${path}`, {
      method: "POST",
      headers: {
        Origin: server.origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": "B".repeat(43),
      },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1 }),
    });
    assert.equal(csrfFailed.status, 403);
    const invalid = await fetch(`${server.origin}${path}`, {
      method: "POST",
      headers: {
        Origin: server.origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": snapshot.csrfToken,
      },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 0 }),
    });
    assert.equal(invalid.status, 400);
    const stale = await fetch(`${server.origin}${path}`, {
      method: "POST",
      headers: {
        Origin: server.origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": snapshot.csrfToken,
      },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 2 }),
    });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { code: string }).code, "selection_conflict");
    assert.deepEqual(recorder.cancels, []);
    const cancelled = await fetch(`${server.origin}${path}`, {
      method: "POST",
      headers: {
        Origin: server.origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": snapshot.csrfToken,
      },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1 }),
    });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), {
      apiVersion: 1,
      disposition: "cancelled",
      turn: { ...result.turn, state: "cancelled" },
    });
    assert.deepEqual(recorder.cancels, [handle]);
  } finally {
    await server.close();
  }
  assert.equal(recorder.closes, 1);
});

class ControlledResponse extends EventEmitter {
  writableEnded = false;
  writableFinished = false;
  destroyed = false;
  readonly headers = new Map<string, string>();
  status = 0;
  body = "";
  constructor(private readonly outcome: "finish" | "premature_close") {
    super();
  }
  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
  writeHead(status: number): void {
    this.status = status;
  }
  end(body = ""): void {
    this.body = body;
    this.writableEnded = true;
    if (this.outcome === "finish") {
      this.writableFinished = true;
      this.emit("finish");
      return;
    }
    this.emit("close");
  }
}

function request(
  method: string,
  path: string,
  headers: Record<string, string>,
  body: unknown,
): import("node:http").IncomingMessage {
  const encoded = JSON.stringify(body);
  return Object.assign(Readable.from([encoded]), {
    method,
    url: path,
    headers: {
      host: "127.0.0.1:7331",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(encoded)),
      ...headers,
    },
  }) as unknown as import("node:http").IncomingMessage;
}

async function dispatch(
  handler: ReturnType<typeof createReferencePipelineDialogueWebRequestHandler>,
  input: import("node:http").IncomingMessage,
  output: ControlledResponse,
): Promise<void> {
  handler.handle(input, output as unknown as import("node:http").ServerResponse, "http://127.0.0.1:7331");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("premature response close rejects the continuation and provider start remains zero", async () => {
  const recorder = { starts: 0, statuses: 0, closes: 0 };
  const handler = createReferencePipelineDialogueWebRequestHandler({
    referenceStateFacade: facade,
    pipelineService: service(recorder),
    profile,
    eventStream,
    bootstrapToken: token,
  });
  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request(
      "POST",
      "/api/tavern/v1/bootstrap",
      { origin: "http://127.0.0.1:7331" },
      {
        apiVersion: 1,
        bootstrapToken: token,
      },
    ),
    bootstrap,
  );
  assert.equal(bootstrap.status, 200);
  const csrf = (JSON.parse(bootstrap.body) as { csrfToken: string }).csrfToken;
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  const submit = new ControlledResponse("premature_close");
  await dispatch(
    handler,
    request(
      "POST",
      "/api/tavern/v1/messages",
      {
        origin: "http://127.0.0.1:7331",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": "A".repeat(22),
      },
      {
        apiVersion: 1,
        selectionGeneration: 1,
        text: "Hello",
        locale: "en",
      },
    ),
    submit,
  );
  assert.equal(submit.status, 202);
  assert.equal(recorder.starts, 0);
  await handler.close();
  assert.equal(recorder.closes, 1);
});

test("reference handler replays an existing SSE cursor", async () => {
  const stream = createChatEventStream();
  const recorder = { starts: 0, statuses: 0, closes: 0 };
  const server = await startReferencePipelineDialogueWebServer({
    referenceStateFacade: facade,
    pipelineService: service(recorder),
    profile,
    eventStream: stream,
    bootstrapToken: token,
  });
  try {
    const bootstrap = await fetch(`${server.origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    const _snapshot = (await bootstrap.json()) as { csrfToken: string };
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const first = stream.publish({
      eventType: "draft.changed",
      selectionGeneration: 1,
      payload: { revision: 5, present: true },
    });
    const replay = await openSse(`${server.origin}/api/tavern/v1/events?apiVersion=1`, {
      Origin: server.origin,
      Cookie: cookie,
      Connection: "close",
    });
    assert.equal(replay.response.statusCode, 200);
    const parsed = parseSseFrame(await replay.readFrame());
    assert.equal(parsed.eventType, "draft.changed");
    assert.deepEqual(stream.decodeCursor(parsed.id), {
      epoch: stream.epoch,
      sequence: first.sequence,
    });
    assert.equal(parsed.event.epoch, first.epoch);
    assert.equal(parsed.event.sequence, first.sequence);
    await replay.close();
  } finally {
    server.closeAllConnections();
    await server.close();
  }
});

test("reference handler streams a live SSE publication", async () => {
  const stream = createChatEventStream();
  const recorder = { starts: 0, statuses: 0, closes: 0 };
  const server = await startReferencePipelineDialogueWebServer({
    referenceStateFacade: facade,
    pipelineService: service(recorder),
    profile,
    eventStream: stream,
    bootstrapToken: token,
  });
  try {
    const bootstrap = await fetch(`${server.origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const live = await openSse(`${server.origin}/api/tavern/v1/events?apiVersion=1`, {
      Origin: server.origin,
      Cookie: cookie,
    });
    assert.equal(live.response.statusCode, 200);
    const next = stream.publish({
      eventType: "draft.changed",
      selectionGeneration: 1,
      payload: { revision: 6, present: false },
    });
    const parsed = parseSseFrame(await live.readFrame());
    assert.equal(parsed.eventType, "draft.changed");
    assert.deepEqual(stream.decodeCursor(parsed.id), {
      epoch: stream.epoch,
      sequence: next.sequence,
    });
    assert.equal(parsed.event.epoch, next.epoch);
    assert.equal(parsed.event.sequence, next.sequence);
    await live.close();
    await live.close();
  } finally {
    server.closeAllConnections();
    await server.close();
  }
});

test("reference handler closes an SSE resync response for an ambiguous cursor", async () => {
  const stream = createChatEventStream();
  const recorder = { starts: 0, statuses: 0, closes: 0 };
  const server = await startReferencePipelineDialogueWebServer({
    referenceStateFacade: facade,
    pipelineService: service(recorder),
    profile,
    eventStream: stream,
    bootstrapToken: token,
  });
  try {
    const bootstrap = await fetch(`${server.origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const future = await openSse(
      `${server.origin}/api/tavern/v1/events?apiVersion=1&cursor=${stream.encodeCursor({ epoch: stream.epoch, sequence: 999 })}`,
      { Origin: server.origin, Cookie: cookie },
    );
    assert.equal(future.response.statusCode, 200);
    const parsed = parseSseFrame(await future.readFrame());
    assert.equal(parsed.eventType, "stream.resync_required");
    assert.deepEqual(parsed.event.payload, { reason: "ambiguous_cursor" });
    assert.equal(await future.readToEnd(), "");
    await future.close();
  } finally {
    server.closeAllConnections();
    await server.close();
  }
});

test("reference handler accepts origin-less same-origin SSE and rejects duplicate Last-Event-ID", async () => {
  const stream = createChatEventStream();
  const recorder = { starts: 0, statuses: 0, closes: 0 };
  const server = await startReferencePipelineDialogueWebServer({
    referenceStateFacade: facade,
    pipelineService: service(recorder),
    profile,
    eventStream: stream,
    bootstrapToken: token,
  });
  try {
    const bootstrap = await fetch(`${server.origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const duplicate = await openSse(`${server.origin}/api/tavern/v1/events?apiVersion=1`, {
      Cookie: cookie,
      "sec-fetch-site": "same-origin",
      "last-event-id": [
        stream.encodeCursor({ epoch: stream.epoch, sequence: 0 }),
        stream.encodeCursor({ epoch: stream.epoch, sequence: 0 }),
      ],
    });
    assert.equal(duplicate.response.statusCode, 200);
    const parsed = parseSseFrame(await duplicate.readFrame());
    assert.equal(parsed.eventType, "stream.resync_required");
    assert.deepEqual(parsed.event.payload, { reason: "ambiguous_cursor" });
    assert.equal(await duplicate.readToEnd(), "");
    await duplicate.close();
  } finally {
    server.closeAllConnections();
    await server.close();
  }
});

test("reference handler rejects non-exact profile before binding a listener", async () => {
  const recorder = { starts: 0, statuses: 0, closes: 0 };
  const invalid = composeTavernProfile({
    profileId: "gamebuddy.chat-core.reference-pipeline",
    releaseTier: "chat_core",
    routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status"],
    operationIds: ["chat.submit", "chat.cancel"],
    navigationItemIds: ["chat"],
  });
  await assert.rejects(
    startReferencePipelineDialogueWebServer({
      referenceStateFacade: facade,
      pipelineService: service(recorder),
      profile: invalid,
      bootstrapToken: token,
    }),
    /reference_pipeline_profile_operation_unavailable/,
  );
});

test("reference handler fails closed when a present-but-invalid cursor accompanies a valid one", async () => {
  const stream = createChatEventStream();
  const recorder = { starts: 0, statuses: 0, closes: 0 };
  const server = await startReferencePipelineDialogueWebServer({
    referenceStateFacade: facade,
    pipelineService: service(recorder),
    profile,
    eventStream: stream,
    bootstrapToken: token,
  });
  try {
    const bootstrap = await fetch(`${server.origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    stream.publish({ eventType: "draft.changed", selectionGeneration: 1, payload: { revision: 1, present: true } });
    const good = stream.encodeCursor({ epoch: stream.epoch, sequence: 1 });
    const matrix = [
      {
        url: `${server.origin}/api/tavern/v1/events?apiVersion=1&cursor=not-a-cursor`,
        headers: { Origin: server.origin, Cookie: cookie, "last-event-id": good },
      },
      {
        url: `${server.origin}/api/tavern/v1/events?apiVersion=1&cursor=${good}`,
        headers: { Origin: server.origin, Cookie: cookie, "last-event-id": "not-a-cursor" },
      },
      {
        url: `${server.origin}/api/tavern/v1/events?apiVersion=1`,
        headers: { Origin: server.origin, Cookie: cookie, "last-event-id": "" },
      },
    ];
    for (const entry of matrix) {
      const connection = await openSse(entry.url, entry.headers);
      assert.equal(connection.response.statusCode, 200);
      const parsed = parseSseFrame(await connection.readFrame());
      assert.equal(parsed.eventType, "stream.resync_required");
      assert.deepEqual(parsed.event.payload, { reason: "ambiguous_cursor" });
      assert.equal(await connection.readToEnd(), "");
      await connection.close();
    }
    const duplicate = await fetch(`${server.origin}/api/tavern/v1/events?apiVersion=1&cursor=${good}&cursor=${good}`, {
      headers: { Origin: server.origin, Cookie: cookie },
    });
    assert.equal(duplicate.status, 400);
  } finally {
    server.closeAllConnections();
    await server.close();
  }
});

test("reference handler prefers Last-Event-ID over a valid query cursor", async () => {
  const stream = createChatEventStream();
  const recorder = { starts: 0, statuses: 0, closes: 0 };
  const server = await startReferencePipelineDialogueWebServer({
    referenceStateFacade: facade,
    pipelineService: service(recorder),
    profile,
    eventStream: stream,
    bootstrapToken: token,
  });
  try {
    const bootstrap = await fetch(`${server.origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    stream.publish({ eventType: "draft.changed", selectionGeneration: 1, payload: { revision: 1, present: true } });
    stream.publish({ eventType: "draft.changed", selectionGeneration: 1, payload: { revision: 2, present: false } });
    stream.publish({ eventType: "draft.changed", selectionGeneration: 1, payload: { revision: 3, present: true } });
    const headerCursor = stream.encodeCursor({ epoch: stream.epoch, sequence: 2 });
    const queryCursor = stream.encodeCursor({ epoch: stream.epoch, sequence: 0 });
    const connection = await openSse(`${server.origin}/api/tavern/v1/events?apiVersion=1&cursor=${queryCursor}`, {
      Origin: server.origin,
      Cookie: cookie,
      "last-event-id": headerCursor,
    });
    assert.equal(connection.response.statusCode, 200);
    const first = parseSseFrame(await connection.readFrame());
    assert.equal(first.eventType, "draft.changed");
    assert.deepEqual(stream.decodeCursor(first.id), { epoch: stream.epoch, sequence: 3 });
    const live = stream.publish({
      eventType: "draft.changed",
      selectionGeneration: 1,
      payload: { revision: 4, present: false },
    });
    const next = parseSseFrame(await connection.readFrame());
    assert.deepEqual(stream.decodeCursor(next.id), { epoch: stream.epoch, sequence: live.sequence });
    assert.deepEqual(next.event.payload, { revision: 4, present: false });
    await connection.close();
  } finally {
    server.closeAllConnections();
    await server.close();
  }
});

test("reference handler serves two concurrent readers with equivalent header-only and query-only replay and independent lifecycle", async () => {
  const stream = createChatEventStream();
  const recorder = { starts: 0, statuses: 0, closes: 0 };
  const server = await startReferencePipelineDialogueWebServer({
    referenceStateFacade: facade,
    pipelineService: service(recorder),
    profile,
    eventStream: stream,
    bootstrapToken: token,
  });
  try {
    const bootstrap = await fetch(`${server.origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    stream.publish({ eventType: "draft.changed", selectionGeneration: 1, payload: { revision: 1, present: true } });
    stream.publish({ eventType: "draft.changed", selectionGeneration: 1, payload: { revision: 2, present: false } });
    const afterOne = stream.encodeCursor({ epoch: stream.epoch, sequence: 1 });
    const queryReader = await openSse(`${server.origin}/api/tavern/v1/events?apiVersion=1&cursor=${afterOne}`, {
      Origin: server.origin,
      Cookie: cookie,
    });
    const headerReader = await openSse(`${server.origin}/api/tavern/v1/events?apiVersion=1`, {
      Origin: server.origin,
      Cookie: cookie,
      "last-event-id": afterOne,
    });
    assert.equal(queryReader.response.statusCode, 200);
    assert.equal(headerReader.response.statusCode, 200);
    const queryReplay = parseSseFrame(await queryReader.readFrame());
    const headerReplay = parseSseFrame(await headerReader.readFrame());
    assert.deepEqual(stream.decodeCursor(queryReplay.id), { epoch: stream.epoch, sequence: 2 });
    assert.deepEqual(stream.decodeCursor(headerReplay.id), { epoch: stream.epoch, sequence: 2 });
    assert.deepEqual(headerReplay.event.payload, queryReplay.event.payload);
    const third = stream.publish({
      eventType: "draft.changed",
      selectionGeneration: 1,
      payload: { revision: 3, present: true },
    });
    assert.deepEqual(stream.decodeCursor(parseSseFrame(await queryReader.readFrame()).id), {
      epoch: stream.epoch,
      sequence: third.sequence,
    });
    assert.deepEqual(stream.decodeCursor(parseSseFrame(await headerReader.readFrame()).id), {
      epoch: stream.epoch,
      sequence: third.sequence,
    });
    await queryReader.close();
    const fourth = stream.publish({
      eventType: "draft.changed",
      selectionGeneration: 1,
      payload: { revision: 4, present: false },
    });
    assert.deepEqual(stream.decodeCursor(parseSseFrame(await headerReader.readFrame()).id), {
      epoch: stream.epoch,
      sequence: fourth.sequence,
    });
    await headerReader.close();
  } finally {
    server.closeAllConnections();
    await server.close();
  }
});

test("reference handler resyncs a reconnect from a previous host epoch and serves a clean post-resync reconnect", async () => {
  const previous = createChatEventStream();
  const first = previous.publish({
    eventType: "draft.changed",
    selectionGeneration: 1,
    payload: { revision: 1, present: true },
  });
  const second = previous.publish({
    eventType: "draft.changed",
    selectionGeneration: 1,
    payload: { revision: 2, present: false },
  });
  const previousCursor = previous.encodeCursor({ epoch: previous.epoch, sequence: second.sequence });
  assert.equal(first.epoch, previous.epoch);
  const stream = createChatEventStream();
  const recorder = { starts: 0, statuses: 0, closes: 0 };
  const server = await startReferencePipelineDialogueWebServer({
    referenceStateFacade: facade,
    pipelineService: service(recorder),
    profile,
    eventStream: stream,
    bootstrapToken: token,
  });
  try {
    const bootstrap = await fetch(`${server.origin}/api/tavern/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const reconnect = await openSse(`${server.origin}/api/tavern/v1/events?apiVersion=1`, {
      Origin: server.origin,
      Cookie: cookie,
      "last-event-id": previousCursor,
    });
    assert.equal(reconnect.response.statusCode, 200);
    const resyncFrame = parseSseFrame(await reconnect.readFrame());
    assert.equal(resyncFrame.eventType, "stream.resync_required");
    assert.deepEqual(resyncFrame.event.payload, { reason: "epoch_changed" });
    assert.deepEqual(stream.decodeCursor(resyncFrame.id), { epoch: stream.epoch, sequence: 1 });
    assert.equal(await reconnect.readToEnd(), "");
    await reconnect.close();
    const fresh = await openSse(`${server.origin}/api/tavern/v1/events?apiVersion=1`, {
      Origin: server.origin,
      Cookie: cookie,
      "last-event-id": resyncFrame.id,
    });
    assert.equal(fresh.response.statusCode, 200);
    const publication = stream.publish({
      eventType: "draft.changed",
      selectionGeneration: 1,
      payload: { revision: 3, present: true },
    });
    const liveFrame = parseSseFrame(await fresh.readFrame());
    assert.equal(liveFrame.eventType, "draft.changed");
    assert.deepEqual(stream.decodeCursor(liveFrame.id), { epoch: stream.epoch, sequence: publication.sequence });
    await fresh.close();
  } finally {
    server.closeAllConnections();
    await server.close();
  }
});
