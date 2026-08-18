import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import { composeTavernProfile } from "./tavern/browser-contract/index.js";
import {
  createTavernManagementDialogueWebRequestHandler,
  startTavernManagementDialogueWebServer,
} from "./tavern-management-dialogue-web.js";
import type { ChatManagementService } from "./tavern/chat-management/chat-management-service.js";
import type { TavernManagementState, TavernManagementStateFacade } from "./tavern/tavern-management-state.js";

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const handle = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const profile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: ["bootstrap", "state.read", "draft.read", "draft.save", "draft.discard", "chat.list", "chat.rename"],
  operationIds: ["draft.save", "draft.discard", "chat.rename"],
  navigationItemIds: ["chat"],
});

const state: TavernManagementState = {
  selection: {
    chatHandle: handle,
    generation: 1,
    stateRevision: handle,
  },
  companionDisplayName: "Mira",
  title: "Farm Chat",
  transcript: [],
  draft: { revision: 0, text: null },
  turn: null,
  operations: [
    {
      operationId: "draft.save",
      labelKey: "tavern.operation.draft.save",
      availability: "available",
      routeId: "draft.save",
    },
    {
      operationId: "draft.discard",
      labelKey: "tavern.operation.draft.discard",
      availability: "available",
      routeId: "draft.discard",
    },
    {
      operationId: "chat.rename",
      labelKey: "tavern.operation.rename",
      availability: "available",
      routeId: "chat.rename",
    },
  ],
};
const facade: TavernManagementStateFacade = Object.freeze({
  read: async () => state,
});
const list: import("./tavern/browser-contract/index.js").ChatListV1 = {
  apiVersion: 1,
  chats: [
    {
      handle,
      title: "Farm Chat",
      status: "active",
      managementRevision: 1,
      isSelected: true,
    },
  ],
};
const renameResult: import("./tavern/browser-contract/index.js").ChatTitleV1 = {
  apiVersion: 1,
  title: "New Farm Chat",
  managementRevision: 2,
};

function service(recorder: {
  lists: number;
  renames: number;
  draftReads: number;
  draftSaves: number;
  draftDiscards: number;
  closes: number;
  renameError?: Error;
  draftError?: Error;
}): ChatManagementService {
  return Object.freeze({
    async readDraft() {
      recorder.draftReads += 1;
      if (recorder.draftError !== undefined) throw recorder.draftError;
      return { apiVersion: 1, revision: state.draft.revision, text: state.draft.text };
    },
    async saveDraft(command) {
      recorder.draftSaves += 1;
      if (recorder.draftError !== undefined) throw recorder.draftError;
      return { apiVersion: 1, revision: command.expectedRevision + 1, text: command.text };
    },
    async discardDraft(command) {
      recorder.draftDiscards += 1;
      if (recorder.draftError !== undefined) throw recorder.draftError;
      return { apiVersion: 1, revision: command.expectedRevision + 1, text: null };
    },
    async listChats(query) {
      recorder.lists += 1;
      assert.equal(query.apiVersion, 1);
      return list;
    },
    async renameChatTitle(command) {
      recorder.renames += 1;
      if (recorder.renameError !== undefined) throw recorder.renameError;
      assert.equal(command.title, "New Farm Chat");
      return renameResult;
    },
    async close() {
      recorder.closes += 1;
    },
  });
}

test("management handler exposes the draft-capable profile and CSRF-protected mutations", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const server = await startTavernManagementDialogueWebServer({
    managementStateFacade: facade,
    managementService: service(recorder),
    profile,
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
      build: { profileId: string };
      operations: unknown[];
      selection: unknown;
    };
    assert.equal(snapshot.build.profileId, "gamebuddy.tavern-management.chat-list-title");
    assert.deepEqual(snapshot.operations, state.operations);
    assert.deepEqual(snapshot.selection, state.selection);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;

    const chats = await fetch(`${origin}/api/tavern/v1/chats?apiVersion=1&state=active`, {
      headers: { Origin: origin, Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(chats.status, 200);
    assert.deepEqual(await chats.json(), list);
    assert.equal(recorder.lists, 1);

    const draftRead = await fetch(`${origin}/api/tavern/v1/draft`, {
      headers: { Origin: origin, Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(draftRead.status, 200);
    assert.deepEqual(await draftRead.json(), { apiVersion: 1, revision: 0, text: null });

    const draftSave = await fetch(`${origin}/api/tavern/v1/draft`, {
      method: "PUT",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": snapshot.csrfToken },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1, expectedRevision: 0, text: "Remember the orchard" }),
    });
    assert.equal(draftSave.status, 200);
    assert.deepEqual(await draftSave.json(), { apiVersion: 1, revision: 1, text: "Remember the orchard" });

    const draftDiscard = await fetch(`${origin}/api/tavern/v1/draft`, {
      method: "DELETE",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": snapshot.csrfToken },
      body: JSON.stringify({ apiVersion: 1, selectionGeneration: 1, expectedRevision: 1 }),
    });
    assert.equal(draftDiscard.status, 200);
    assert.deepEqual(await draftDiscard.json(), { apiVersion: 1, revision: 2, text: null });
    assert.equal(recorder.draftReads, 1);
    assert.equal(recorder.draftSaves, 1);
    assert.equal(recorder.draftDiscards, 1);

    const rename = await fetch(`${origin}/api/tavern/v1/chat/title`, {
      method: "PUT",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": snapshot.csrfToken,
      },
      body: JSON.stringify({
        apiVersion: 1,
        selectionGeneration: 1,
        chatHandle: handle,
        expectedManagementRevision: 1,
        title: "New Farm Chat",
      }),
    });
    assert.equal(rename.status, 200);
    assert.deepEqual(await rename.json(), renameResult);
    assert.equal(recorder.renames, 1);

    // The frozen reference routes are absent from the management profile.
    for (const path of [
      "/api/tavern/v1/messages",
      "/api/tavern/v1/message-submission-status",
      "/api/tavern/v1/events",
    ]) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 404);
    }
  } finally {
    await server.close();
  }
  assert.equal(recorder.closes, 1);
});

test("management handler maps foreign binding, wrong generation and stale revision to existing problem semantics", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0, renameError: undefined as Error | undefined };
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    profile,
    bootstrapToken: token,
  });
  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request("POST", "/api/tavern/v1/bootstrap", { origin: "http://127.0.0.1:7331" }, { apiVersion: 1, bootstrapToken: token }),
    bootstrap,
  );
  assert.equal(bootstrap.status, 200);
  const csrf = (JSON.parse(bootstrap.body) as { csrfToken: string }).csrfToken;
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  const rename = (overrides: Record<string, unknown>) =>
    request(
      "PUT",
      "/api/tavern/v1/chat/title",
      { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
      {
        apiVersion: 1,
        selectionGeneration: 1,
        chatHandle: handle,
        expectedManagementRevision: 1,
        title: "New Farm Chat",
        ...overrides,
      },
    );
  const problemFor = async (input: import("node:http").IncomingMessage) => {
    const output = new ControlledResponse("finish");
    await dispatch(handler, input, output);
    assert.equal(output.status, 409);
    return (JSON.parse(output.body) as { code: string }).code;
  };

  recorder.renameError = new Error("chat_management_selection_conflict");
  assert.equal(await problemFor(rename({ chatHandle: "A".repeat(42) + "E" })), "selection_conflict");
  assert.equal(await problemFor(rename({ selectionGeneration: 99 })), "selection_conflict");
  recorder.renameError = new Error("chat_management_revision_conflict");
  assert.equal(await problemFor(rename({ expectedManagementRevision: 7 })), "draft_conflict");
  await handler.close();
});

test("management handler enforces session, CSRF, origin and exact query/body validation", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade,
    managementService: service(recorder),
    profile,
    bootstrapToken: token,
  });
  const bootstrap = new ControlledResponse("finish");
  await dispatch(
    handler,
    request("POST", "/api/tavern/v1/bootstrap", { origin: "http://127.0.0.1:7331" }, { apiVersion: 1, bootstrapToken: token }),
    bootstrap,
  );
  assert.equal(bootstrap.status, 200);
  const csrf = (JSON.parse(bootstrap.body) as { csrfToken: string }).csrfToken;
  const cookie = bootstrap.headers.get("Set-Cookie")!.split(";", 1)[0]!;

  const run = async (input: import("node:http").IncomingMessage) => {
    const output = new ControlledResponse("finish");
    await dispatch(handler, input, output);
    return { status: output.status, body: output.body };
  };

  // Chat list requires the browser session cookie and exact query shape.
  assert.equal((await run(request("GET", "/api/tavern/v1/chats?apiVersion=1", { "sec-fetch-site": "same-origin" }))).status, 401);
  assert.equal(
    (await run(request("GET", "/api/tavern/v1/chats?apiVersion=1&invented=1", { cookie, "sec-fetch-site": "same-origin" }))).status,
    400,
  );
  assert.equal(
    (await run(request("GET", "/api/tavern/v1/chats?apiVersion=1&apiVersion=2", { cookie, "sec-fetch-site": "same-origin" }))).status,
    400,
  );
  assert.equal(
    (await run(request("GET", "/api/tavern/v1/chats?apiVersion=1", { cookie, "sec-fetch-site": "same-origin" }))).status,
    200,
  );

  // Rename requires origin, session, CSRF and a valid command.
  assert.equal(
    (
      await run(
        request(
          "PUT",
          "/api/tavern/v1/chat/title",
          { cookie, "x-csrf-token": csrf },
          { apiVersion: 1, selectionGeneration: 1, chatHandle: handle, expectedManagementRevision: 1, title: "New Farm Chat" },
        ),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await run(
        request(
          "PUT",
          "/api/tavern/v1/chat/title",
          { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": "B".repeat(43) },
          { apiVersion: 1, selectionGeneration: 1, chatHandle: handle, expectedManagementRevision: 1, title: "New Farm Chat" },
        ),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await run(
        request(
          "PUT",
          "/api/tavern/v1/chat/title",
          { origin: "http://127.0.0.1:7331", cookie, "x-csrf-token": csrf },
          { apiVersion: 1, selectionGeneration: 1, chatHandle: handle, expectedManagementRevision: 1 },
        ),
      )
    ).status,
    400,
  );
  assert.equal(recorder.renames, 0);
  await handler.close();
});

test("management handler rejects the frozen reference profile before binding a listener", async () => {
  const recorder = { lists: 0, renames: 0, draftReads: 0, draftSaves: 0, draftDiscards: 0, closes: 0 };
  const referenceProfile = composeTavernProfile({
    profileId: "gamebuddy.chat-core.reference-pipeline",
    releaseTier: "chat_core",
    routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.submission_status"],
    operationIds: ["chat.submit"],
    navigationItemIds: ["chat"],
  });
  await assert.rejects(
    startTavernManagementDialogueWebServer({
      managementStateFacade: facade,
      managementService: service(recorder),
      profile: referenceProfile,
      bootstrapToken: token,
    }),
    /tavern_management_profile_operation_unavailable/,
  );
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
  body?: unknown,
): import("node:http").IncomingMessage {
  const hasBody = body !== undefined;
  const encoded = hasBody ? JSON.stringify(body) : "";
  return Object.assign(Readable.from([encoded]), {
    method,
    url: path,
    headers: {
      host: "127.0.0.1:7331",
      ...(hasBody
        ? {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(encoded)),
          }
        : {}),
      ...headers,
    },
  }) as unknown as import("node:http").IncomingMessage;
}

async function dispatch(
  handler: ReturnType<typeof createTavernManagementDialogueWebRequestHandler>,
  input: import("node:http").IncomingMessage,
  output: ControlledResponse,
): Promise<void> {
  handler.handle(input, output as unknown as import("node:http").ServerResponse, "http://127.0.0.1:7331");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
