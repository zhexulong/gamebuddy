import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import {
  createComposedReferenceGameBrowserRequestHandler,
  type ComposedReferenceGameBrowserReadContext,
} from "./composed-reference-game-browser.js";
import { composeReferenceGameBrowserProfile } from "./composed-browser-contract/index.js";
import { composeTavernProfile, TavernBrowserFixtureV1 } from "./tavern/browser-contract/index.js";
import { createComposedReferenceGameBrowserClient } from "./composed-reference-game-browser-client.js";

const bootstrapToken = "QWxhZGRpbjpvcGVuIHNlc2FtZQ";
const tavernProfile = composeTavernProfile({
  profileId: "gamebuddy.chat-core.reference-pipeline",
  releaseTier: "chat_core",
  routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status", "events"],
  operationIds: ["chat.submit", "chat.cancel"],
  navigationItemIds: ["chat"],
});

function stateForChat(context: ComposedReferenceGameBrowserReadContext) {
  const base = TavernBrowserFixtureV1.snapshot();
  return {
    ...base,
    build: { ...base.build, profileId: tavernProfile.profileId },
    csrfToken: context.csrfToken,
    browserSession: { expiresAtMs: context.browserSessionExpiresAtMs },
  };
}

async function start(
  handler: ReturnType<typeof createComposedReferenceGameBrowserRequestHandler>,
): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((request, response) =>
    handler.handle(request, response, `http://127.0.0.1:${(server.address() as { port: number }).port}`),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const closeServer = async () =>
    await new Promise<void>((resolve) => server.close(() => resolve()));
  return {
    origin,
    async close() {
      await handler.close();
      await closeServer();
    },
  };
}

function testFetch(
  testOrigin: string,
  interceptor?: (url: string, init: RequestInit) => Promise<Response> | undefined,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const originalFetch = globalThis.fetch;
  let cookieJar: string | undefined;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const resolved = url.startsWith("/") ? `${testOrigin}${url}` : url;
    const headers: Record<string, string> = { ...init?.headers as Record<string, string>, origin: testOrigin };
    if (cookieJar !== undefined) headers.cookie = cookieJar;
    const requestInit = { ...init, headers };
    if (interceptor) {
      const intercepted = await interceptor(url, requestInit);
      if (intercepted !== undefined) {
        const setCookie = intercepted.headers.get("set-cookie");
        if (setCookie !== null) cookieJar = setCookie.split(";", 1)[0]!;
        return intercepted;
      }
    }
    const response = await originalFetch(resolved, requestInit);
    const setCookie = response.headers.get("set-cookie");
    if (setCookie !== null) cookieJar = setCookie.split(";", 1)[0]!;
    return response;
  };
}

test("composed client bootstraps and returns a validated composed root with chat", async () => {
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) {
      return stateForChat(context) as any;
    },
  });
  const server = await start(handler);
  try {
    const client = createComposedReferenceGameBrowserClient();
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = testFetch(server.origin);
      const root = await client.bootstrap(bootstrapToken);
      assert.equal(root.apiVersion, 1);
      assert.equal(root.build.browserContract, "composed_reference_game_browser_api/v1");
      assert.equal(root.game, null);
      assert.notEqual(root.chat, null);
      assert.equal(root.chat.build.profileId, tavernProfile.profileId);
      assert.equal(typeof root.chat.csrfToken, "string");
      assert.equal(typeof root.chat.browserSession.expiresAtMs, "number");
      assert.equal(root.chat.apiVersion, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await server.close();
  }
});

test("composed client readState returns the composed root with chat snapshot", async () => {
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) {
      return stateForChat(context) as any;
    },
  });
  const server = await start(handler);
  try {
    const client = createComposedReferenceGameBrowserClient();
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = testFetch(server.origin);
      // Bootstrap first to establish session.
      const bootRoot = await client.bootstrap(bootstrapToken);
      assert.notEqual(bootRoot.chat, null);
      // Read state with the established session cookie.
      const stateRoot = await client.readState();
      assert.equal(stateRoot.apiVersion, 1);
      assert.equal(stateRoot.build.browserContract, "composed_reference_game_browser_api/v1");
      assert.equal(stateRoot.game, null);
      assert.notEqual(stateRoot.chat, null);
      assert.equal(stateRoot.chat.build.profileId, tavernProfile.profileId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await server.close();
  }
});

test("composed client rejects malformed composed root with a protocol error", async () => {
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) {
      return stateForChat(context) as any;
    },
  });
  const server = await start(handler);
  try {
    const client = createComposedReferenceGameBrowserClient();
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = testFetch(server.origin, (url) => {
        if (url.includes("/bootstrap")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ apiVersion: 1, build: { browserContract: "wrong" }, chat: null, game: null }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        return undefined;
      });
      await assert.rejects(
        () => client.bootstrap(bootstrapToken),
        (error: unknown) =>
          error instanceof Error && error.message.includes("invalid_composed_root"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await server.close();
  }
});

test("composed client problem response throws a typed problem error", async () => {
  const handler = createComposedReferenceGameBrowserRequestHandler({
    profile: composeReferenceGameBrowserProfile({ tavernProfile }),
    bootstrapToken,
    async readChat(context) {
      return stateForChat(context) as any;
    },
  });
  const server = await start(handler);
  try {
    const client = createComposedReferenceGameBrowserClient();
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({ code: "unauthorized", status: 401, requestId: "req_01" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      };
      await assert.rejects(
        () => client.bootstrap("wrong_token"),
        (error: unknown) =>
          error instanceof Error &&
          error.name === "ComposedReferenceGameProblemError" &&
          (error as any).code === "unauthorized",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await server.close();
  }
});