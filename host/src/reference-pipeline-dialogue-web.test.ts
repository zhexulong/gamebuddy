import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { composeTavernProfile } from "./tavern/browser-contract/index.js";
import { createChatEventStream } from "./tavern/chat-event-stream.js";
import {
  createReferencePipelineDialogueWebRequestHandler,
  startReferencePipelineDialogueWebServer,
} from "./reference-pipeline-dialogue-web.js";
import type {
  ChatPipelineService,
  SubmitResultV1,
} from "./tavern/chat-pipeline-service.js";
import type {
  ReferencePipelineState,
  ReferencePipelineStateFacade,
} from "./tavern/reference-pipeline-state.js";

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const handle = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const profile = composeTavernProfile({
  profileId: "gamebuddy.chat-core.reference-pipeline",
  releaseTier: "chat_core",
  routeIds: [
    "bootstrap",
    "state.read",
    "draft.read",
    "chat.submit",
    "chat.submission_status",
    "events",
  ],
  operationIds: ["chat.submit"],
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
  readDraft: async () =>
    Object.freeze({ apiVersion: 1, revision: 4, text: "draft" }),
});
async function openSse(
  url: string,
  headers: Record<string, string | string[]>,
): Promise<Readonly<{
  response: IncomingMessage;
  /** Buffered bytes up to the first complete `\n\n` SSE frame. */
  readFrame(): Promise<string>;
  /** Remaining buffered bytes once the response ends, or empty when already ended. */
  readToEnd(): Promise<string>;
  close(): Promise<void>;
}>> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(url, { agent: false, headers }, (response) => {
      resolve(Object.freeze({
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
      }));
    });
    request.once("error", (error) => reject(error));
    request.end();
  });
}

/**
 * Bounded reader so SSE tests fail on a stalled connection instead of
 * hanging: "frame" resolves at the first `\n\n` boundary, "end" resolves
 * when the response completes. Both reject after SSE_STALL_TIMEOUT_MS.
 */
const SSE_STALL_TIMEOUT_MS = 2_000;
function readSseUntil(
  response: IncomingMessage,
  until: "frame" | "end",
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      response.off("data", onData);
      response.off("end", onEnd);
      response.off("error", onError);
    };
    const onData = (value: Buffer) => {
      buffer += value.toString("utf8");
      if (until === "frame" && buffer.includes("\n\n")) {
        settled = true;
        cleanup();
        resolve(buffer);
      }
    };
    const onEnd = () => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(buffer);
      }
    };
    const onError = (error: Error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error("sse_read_failed"));
      }
    };
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(until === "frame" ? "sse_frame_timeout" : "sse_end_timeout"));
      }
    }, SSE_STALL_TIMEOUT_MS);
    if (until === "end" && response.complete) {
      settled = true;
      cleanup();
      resolve("");
      return;
    }
    response.on("data", onData);
    response.on("end", onEnd);
    response.on("error", onError);
  });
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
    async close() {
      recorder.closes += 1;
    },
  });
}

test("reference handler exposes the exact six-route profile and starts after response finish", async () => {
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
    const status = await fetch(
      `${origin}/api/tavern/v1/message-submission-status`,
      {
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
      },
    );
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
    for (const path of [
      "/api/tavern/v1/turns/x/cancel",
      "/api/tavern/v1/memories",
    ]) {
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
  handler.handle(
    input,
    output as unknown as import("node:http").ServerResponse,
    "http://127.0.0.1:7331",
  );
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
    request("POST", "/api/tavern/v1/bootstrap", { origin: "http://127.0.0.1:7331" }, {
      apiVersion: 1,
      bootstrapToken: token,
    }),
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
    const snapshot = (await bootstrap.json()) as { csrfToken: string };
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const first = stream.publish({
      eventType: "draft.changed",
      selectionGeneration: 1,
      payload: { revision: 5, present: true },
    });
    const replay = await openSse(
      `${server.origin}/api/tavern/v1/events?apiVersion=1`,
      { Origin: server.origin, Cookie: cookie, Connection: "close" },
    );
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
  const server = await startReferencePipelineDialogueWebServer({ referenceStateFacade: facade, pipelineService: service(recorder), profile, eventStream: stream, bootstrapToken: token });
  try {
    const bootstrap = await fetch(`${server.origin}/api/tavern/v1/bootstrap`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }) });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const live = await openSse(`${server.origin}/api/tavern/v1/events?apiVersion=1`, { Origin: server.origin, Cookie: cookie });
    assert.equal(live.response.statusCode, 200);
    const next = stream.publish({ eventType: "draft.changed", selectionGeneration: 1, payload: { revision: 6, present: false } });
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
  const server = await startReferencePipelineDialogueWebServer({ referenceStateFacade: facade, pipelineService: service(recorder), profile, eventStream: stream, bootstrapToken: token });
  try {
    const bootstrap = await fetch(`${server.origin}/api/tavern/v1/bootstrap`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }) });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const future = await openSse(`${server.origin}/api/tavern/v1/events?apiVersion=1&cursor=${stream.encodeCursor({ epoch: stream.epoch, sequence: 999 })}`, { Origin: server.origin, Cookie: cookie });
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
  const server = await startReferencePipelineDialogueWebServer({ referenceStateFacade: facade, pipelineService: service(recorder), profile, eventStream: stream, bootstrapToken: token });
  try {
    const bootstrap = await fetch(`${server.origin}/api/tavern/v1/bootstrap`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }) });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const duplicate = await openSse(`${server.origin}/api/tavern/v1/events?apiVersion=1`, { Cookie: cookie, "sec-fetch-site": "same-origin", "last-event-id": [stream.encodeCursor({ epoch: stream.epoch, sequence: 0 }), stream.encodeCursor({ epoch: stream.epoch, sequence: 0 })] });
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
    routeIds: [
      "bootstrap",
      "state.read",
      "draft.read",
      "chat.submit",
      "chat.submission_status",
    ],
    operationIds: ["chat.submit"],
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
