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
  headers: Record<string, string>,
): Promise<Readonly<{
  response: IncomingMessage;
  readChunk(): Promise<string>;
  close(): Promise<void>;
}>> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(url, { agent: false, headers }, (response) => {
      let readSettled = false;
      let readResolve: (value: string) => void;
      let readReject: (error: Error) => void;
      const chunk = new Promise<string>((chunkResolve, chunkReject) => {
        readResolve = chunkResolve;
        readReject = chunkReject;
      });
      response.once("data", (value: Buffer) => {
        if (!readSettled) {
          readSettled = true;
          readResolve(value.toString("utf8"));
        }
      });
      response.once("error", (error) => {
        if (!readSettled) {
          readSettled = true;
          readReject(error instanceof Error ? error : new Error("sse_read_failed"));
        }
      });
      resolve(Object.freeze({
        response,
        readChunk: () => chunk,
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

test("reference handler streams live events and replays an existing cursor", async () => {
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
    const replayChunk = await replay.readChunk();
    assert.match(replayChunk, new RegExp(`event: draft\\.changed`));
    assert.match(replayChunk, new RegExp(`data: .*${first.epoch}.*${first.sequence}`));
    await replay.close();

    const live = await openSse(
      `${server.origin}/api/tavern/v1/events?apiVersion=1&cursor=${stream.encodeCursor({ epoch: stream.epoch, sequence: first.sequence })}`,
      { Origin: server.origin, Cookie: cookie },
    );
    assert.equal(live.response.statusCode, 200);
    const next = stream.publish({
      eventType: "draft.changed",
      selectionGeneration: 1,
      payload: { revision: 6, present: false },
    });
    const liveChunk = await live.readChunk();
    assert.match(liveChunk, new RegExp(`event: draft\\.changed`));
    assert.match(liveChunk, new RegExp(`data: .*${next.epoch}.*${next.sequence}`));
    await live.close();

    const future = await openSse(
      `${server.origin}/api/tavern/v1/events?apiVersion=1&cursor=${stream.encodeCursor({ epoch: stream.epoch, sequence: 999 })}`,
      { Origin: server.origin, Cookie: cookie },
    );
    assert.equal(future.response.statusCode, 200);
    const futureBody = await future.readChunk();
    assert.match(futureBody, /event: stream\.resync_required/);
    assert.match(futureBody, /"reason":"ambiguous_cursor"/);
    await future.close();
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
