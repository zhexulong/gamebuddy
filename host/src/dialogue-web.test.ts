import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { composeTavernProfile } from "./tavern/browser-contract/index.js";
import { startDialogueWebServer } from "./dialogue-web.js";
import type {
  ChatPipelineService,
  SubmitResultV1,
} from "./tavern/chat-pipeline-service.js";
import type {
  ReferencePipelineState,
  ReferencePipelineStateFacade,
} from "./tavern/reference-pipeline-state.js";
import type {
  P3ExactChatState,
  P3ExactChatStateFacade,
} from "./tavern/p3-exact-chat-state.js";

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const handle = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const profile = composeTavernProfile({
  profileId: "gamebuddy.chat-core.p3",
  releaseTier: "chat_core",
  routeIds: ["bootstrap", "state.read", "draft.read"],
  operationIds: [],
  navigationItemIds: ["chat"],
});

function state(revision = 2, text: string | null = "draft"): P3ExactChatState {
  return Object.freeze({
    selection: Object.freeze({
      chatHandle: handle,
      generation: 1,
      stateRevision: handle,
    }),
    companionDisplayName: "Companion",
    title: "Exact Chat",
    transcript: Object.freeze([
      Object.freeze({
        handle,
        role: "player" as const,
        text: "Hello",
        locale: "und" as const,
        order: 0,
        revision: 1,
      }),
    ]),
    draft: Object.freeze({ revision, text }),
  });
}
function fakeFacade(
  read: () => Promise<P3ExactChatState>,
): P3ExactChatStateFacade {
  return Object.freeze({ read });
}
function bootstrapUrl(server: { origin: string }): string {
  return `${server.origin}/api/tavern/v1/bootstrap`;
}
function rawRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode!,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("P3 mounts only profile-authorized v1 bootstrap, state, and draft reads", async () => {
  let reads = 0;
  const server = await startDialogueWebServer({
    p3Facade: fakeFacade(async () => state(++reads)),
    profile,
    bootstrapToken: token,
  });
  try {
    const origin = server.origin;
    const bootstrap = await fetch(bootstrapUrl(server), {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    assert.equal(bootstrap.status, 200);
    const snapshot = (await bootstrap.json()) as {
      operations: unknown[];
      navigation: unknown[];
      eventStream: unknown;
      memory: unknown;
      chat: { draft: { revision: number; present: boolean } };
    };
    assert.deepEqual(snapshot.operations, []);
    assert.deepEqual(snapshot.navigation, [
      {
        itemId: "chat",
        labelKey: "tavern.nav.chat",
        availability: "available",
      },
    ]);
    assert.equal(snapshot.eventStream, null);
    assert.deepEqual(snapshot.memory, {
      readAvailable: false,
      mutationAvailable: false,
      projectionRevision: null,
    });
    assert.deepEqual(snapshot.chat.draft, { revision: 1, present: true });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const reread = await fetch(`${origin}/api/tavern/v1/state`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    assert.equal(reread.status, 200);
    assert.equal(reads, 2);
    const draft = await fetch(`${origin}/api/tavern/v1/draft`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    assert.deepEqual(await draft.json(), {
      apiVersion: 1,
      revision: 3,
      text: "draft",
    });
    assert.equal(reads, 3);
    for (const path of [
      "/bootstrap",
      "/events",
      "/message",
      "/memories",
      "/api/tavern/v1/events",
    ]) {
      const response = await fetch(`${origin}${path}`, {
        headers: { Origin: origin, Cookie: cookie },
      });
      assert.equal(response.status, 404);
      assert.equal(
        ((await response.json()) as { code: string }).code,
        "profile_operation_unavailable",
      );
    }
  } finally {
    await server.close();
  }
});

test("P3 bootstrap is strict and one-time; subsequent reads require same-origin browser session", async () => {
  const server = await startDialogueWebServer({
    p3Facade: fakeFacade(async () => state()),
    profile,
    bootstrapToken: token,
  });
  try {
    const origin = server.origin;
    const malformed = await fetch(bootstrapUrl(server), {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        apiVersion: 1,
        bootstrapToken: token,
        extra: true,
      }),
    });
    assert.equal(malformed.status, 400);
    assert.equal(
      ((await malformed.json()) as { code: string }).code,
      "invalid_request",
    );
    const bootstrap = await fetch(bootstrapUrl(server), {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const replay = await fetch(bootstrapUrl(server), {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    assert.equal(replay.status, 401);
    assert.equal(
      (
        await fetch(`${origin}/api/tavern/v1/state`, {
          headers: { Cookie: cookie },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/tavern/v1/state`, {
          headers: { Origin: "http://evil.invalid", Cookie: cookie },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/tavern/v1/state`, {
          headers: { Origin: origin, Cookie: cookie },
        })
      ).status,
      200,
    );
  } finally {
    await server.close();
  }
});

test("P3 rejects every query and GET body, and bootstrap malformed input is v1 invalid_request", async () => {
  const server = await startDialogueWebServer({
    p3Facade: fakeFacade(async () => state()),
    profile,
    bootstrapToken: token,
  });
  try {
    const origin = server.origin;
    for (const response of [
      await fetch(`${bootstrapUrl(server)}?unexpected=1`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
      }),
      await fetch(bootstrapUrl(server), {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: "{",
      }),
      await fetch(bootstrapUrl(server), {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "text/plain" },
        body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
      }),
      await fetch(bootstrapUrl(server), {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: `{"apiVersion":1,"bootstrapToken":"${token}","padding":"${"x".repeat(4_096)}"}`,
      }),
    ]) {
      assert.equal(response.status, 400);
      assert.equal(
        ((await response.json()) as { code: string }).code,
        "invalid_request",
      );
    }
    const bootstrap = await fetch(bootstrapUrl(server), {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    for (const path of [
      "/api/tavern/v1/state?unexpected=1",
      "/api/tavern/v1/draft?unexpected=1",
    ]) {
      const response = await fetch(`${origin}${path}`, {
        headers: { Origin: origin, Cookie: cookie },
      });
      assert.equal(response.status, 400);
      assert.equal(
        ((await response.json()) as { code: string }).code,
        "invalid_request",
      );
    }
    for (const path of ["/api/tavern/v1/state", "/api/tavern/v1/draft"]) {
      const response = await rawRequest(
        `${origin}${path}`,
        "GET",
        { Origin: origin, Cookie: cookie, "Content-Length": "2" },
        "{}",
      );
      assert.equal(response.status, 400);
      assert.equal(
        (JSON.parse(response.body) as { code: string }).code,
        "invalid_request",
      );
    }
  } finally {
    await server.close();
  }
});

test("P3 reports facade failure as closed v1 state reconciliation problem", async () => {
  const server = await startDialogueWebServer({
    p3Facade: fakeFacade(async () => {
      throw new Error("p3_exact_chat_state_unavailable");
    }),
    profile,
    bootstrapToken: token,
  });
  try {
    const origin = server.origin;
    const response = await fetch(bootstrapUrl(server), {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    assert.equal(response.status, 409);
    const problem = (await response.json()) as { code: string; status: number };
    assert.equal(problem.code, "state_reconciliation_required");
    assert.equal(problem.status, 409);
  } finally {
    await server.close();
  }
});

test("P3 accepts a browser same-origin Fetch Metadata read when browsers omit Origin on GET", async () => {
  const server = await startDialogueWebServer({
    p3Facade: fakeFacade(async () => state()),
    profile,
    bootstrapToken: token,
  });
  try {
    const origin = server.origin;
    const bootstrap = await fetch(bootstrapUrl(server), {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const response = await fetch(`${origin}/api/tavern/v1/draft`, {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(response.status, 200);
  } finally {
    await server.close();
  }
});

test("P3 rejects profiles other than its frozen exact profile", async () => {
  for (const invalid of [
    composeTavernProfile({
      profileId: "gamebuddy.chat-core.wide",
      releaseTier: "chat_core",
      routeIds: ["bootstrap", "state.read", "draft.read", "events"],
      operationIds: [],
      navigationItemIds: ["chat"],
    }),
    composeTavernProfile({
      profileId: "gamebuddy.chat-core.p3",
      releaseTier: "chat_core",
      routeIds: ["state.read", "bootstrap", "draft.read"],
      operationIds: [],
      navigationItemIds: ["chat"],
    }),
    composeTavernProfile({
      profileId: "gamebuddy.chat-core.p3",
      releaseTier: "chat_core",
      routeIds: ["bootstrap", "state.read", "draft.read"],
      operationIds: [],
      navigationItemIds: ["memory"],
    }),
    composeTavernProfile({
      profileId: "gamebuddy.chat-core.p3",
      releaseTier: "chat_core",
      routeIds: ["bootstrap", "state.read", "draft.read"],
      operationIds: [],
      navigationItemIds: [],
    }),
  ]) {
    await assert.rejects(
      startDialogueWebServer({
        p3Facade: fakeFacade(async () => state()),
        profile: invalid,
        bootstrapToken: token,
      }),
      /p3_profile_operation_unavailable/,
    );
  }
});
