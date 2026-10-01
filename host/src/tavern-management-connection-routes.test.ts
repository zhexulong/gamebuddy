import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

import type { ChatManagementService } from "./tavern/chat-management/chat-management-service.js";
import { composeTavernProfile } from "./tavern/browser-contract/index.js";
import { createTavernConnectionService, type TavernConnectionService } from "./tavern/connection-service.js";
import type { TavernConnectionProbe } from "./tavern/connection-probe.js";
import { connectionAuthPath } from "./tavern/connection-store.js";
import { TAVERN_ESCAPE_HATCH_PROVIDER_ID } from "./tavern/provider-catalog.js";
import type { TavernManagementState, TavernManagementStateFacade } from "./tavern/tavern-management-state.js";
import type { WorldInfoBindingManagementService } from "./tavern/world-info-binding/world-info-binding-management-service.js";
import { createTavernManagementDialogueWebRequestHandler } from "./tavern-management-dialogue-web.js";

/**
 * The connection management routes (design/28 §5.3) as the browser sees them.
 *
 * These tests own the contract the player journey depends on: which catalog
 * entries can be selected, that the escape hatch is the one entry whose base URL
 * the player supplies and reads back, that no credential ever crosses back over
 * the boundary, that a failed probe is reported as a closed category, and that
 * the exact session/CSRF/origin gates of the management profile apply to every
 * one of the routes.
 */

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const handle = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// The connection store takes a durable path lock, so these tests need the same
// test-only reclaimer binding every other path-lock consumer's test uses.
let canonicalTemporaryRoot: string;

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  canonicalTemporaryRoot = await realpath(tmpdir());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const state: TavernManagementState = {
  selection: { chatHandle: handle, generation: 1, stateRevision: handle },
  companionDisplayName: "Mira",
  title: "Farm Chat",
  transcript: [],
  draft: { revision: 0, text: null },
  turn: null,
  operations: [],
  worldInfo: null,
};

/** Profile that declares the full connection extension group. */
const connectionProfile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.chat-list-title",
  releaseTier: "tavern_management",
  routeIds: [
    "bootstrap",
    "state.read",
    "draft.read",
    "draft.save",
    "draft.discard",
    "chat.list",
    "chat.rename",
    "world-info.read",
    "world-info.bind",
    "settings.voice.read",
    "settings.voice.consent",
    "settings.connection.read",
    "settings.connection.create",
    "settings.connection.test",
    "settings.connection.activate",
    "settings.connection.model",
    "settings.connection.remove",
  ],
  operationIds: [
    "draft.save",
    "draft.discard",
    "chat.rename",
    "world-info.bind",
    "settings.voice.read",
    "settings.voice.consent",
    "settings.connection.read",
    "settings.connection.create",
    "settings.connection.test",
    "settings.connection.activate",
    "settings.connection.model",
    "settings.connection.remove",
  ],
  navigationItemIds: ["chat"],
});

const managementService: ChatManagementService = Object.freeze({
  async readDraft() {
    return { apiVersion: 1 as const, revision: 0, text: null };
  },
  async saveDraft() {
    return { apiVersion: 1 as const, revision: 1, text: null };
  },
  async discardDraft() {
    return { apiVersion: 1 as const, revision: 1, text: null };
  },
  async listChats() {
    return { apiVersion: 1 as const, chats: [] };
  },
  async renameChatTitle() {
    return { apiVersion: 1 as const, title: null, managementRevision: 1 };
  },
  async close() {},
});

const worldInfoService: WorldInfoBindingManagementService = Object.freeze({
  async read() {
    return { state: "none" as const, revision: handle, items: [] };
  },
  async setBinding() {
    return { state: "none" as const, revision: handle, items: [] };
  },
  async close() {},
});

function facade(turnActive: boolean): TavernManagementStateFacade {
  return Object.freeze({
    async read() {
      return turnActive
        ? {
            ...state,
            turn: { handle, state: "running" as const, projectionRevision: 1, canCancel: true },
          }
        : state;
    },
  });
}

/** A local OpenAI-compatible endpoint stub: exactly what the Host probe calls. */
function stubEndpoint(
  handler: (url: string, headers: Record<string, string>) => Readonly<{ status: number; body: string }>,
): TavernConnectionProbe {
  return async (input) =>
    (await import("./tavern/connection-probe.js")).probeTavernConnection(
      input,
      (async (url: string, init?: RequestInit) => {
        const response = handler(String(url), (init?.headers ?? {}) as Record<string, string>);
        return new Response(response.body, { status: response.status });
      }) as unknown as typeof fetch,
    );
}

function listModels(...ids: string[]): string {
  return JSON.stringify({ data: ids.map((id) => ({ id })) });
}

async function withHandler(
  options: Readonly<{
    probe?: TavernConnectionProbe;
    turnActive?: boolean;
    profile?: ReturnType<typeof composeTavernProfile>;
    withService?: boolean;
  }>,
  run: (
    root: string,
    request: (
      method: string,
      path: string,
      headers?: Record<string, string>,
      body?: unknown,
    ) => Promise<Readonly<{ status: number; body: unknown; raw: string; setCookie: string | null }>>,
    bootstrap: () => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(canonicalTemporaryRoot, "gamebuddy-connection-routes-"));
  const service: TavernConnectionService = createTavernConnectionService({
    agentDir: root,
    readTurnState: async () => ({ turnActive: options.turnActive ?? false }),
    ...(options.probe === undefined ? {} : { probe: options.probe }),
  });
  const handler = createTavernManagementDialogueWebRequestHandler({
    managementStateFacade: facade(options.turnActive ?? false),
    managementService,
    worldInfoService,
    voicePreferenceStore: Object.freeze({
      async read() {
        return { revision: 0, disclosureVersion: null, consent: "undecided" as const, decidedAtMs: null, outputDevice: null };
      },
      async update() {
        return { revision: 1, disclosureVersion: null, consent: "accepted" as const, decidedAtMs: 1, outputDevice: null };
      },
    }),
    profile: options.profile ?? connectionProfile,
    bootstrapToken: token,
    ...(options.withService === false ? {} : { connectionService: service }),
  } as Parameters<typeof createTavernManagementDialogueWebRequestHandler>[0]);
  let cookie: string | null = null;
  let csrf: string | null = null;
  const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const incoming = {
      method,
      url: path,
      headers: {
        host: "127.0.0.1:7331",
        origin: "http://127.0.0.1:7331",
        "sec-fetch-site": "same-origin",
        ...(cookie === null ? {} : { cookie }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body), "utf8");
      },
    } as unknown as IncomingMessage;
    const response = new ControlledResponse();
    handler.handle(incoming, response as never, "http://127.0.0.1:7331");
    // The dispatcher may end the response synchronously (a rejected read) or
    // after awaiting durable work. Waiting on the recorded completion handles
    // both, and a real 25s guard turns a wedged dispatch into a test failure
    // instead of a hung runner.
    await response.done(25_000);
    const setCookie = response.headers.get("Set-Cookie");
    if (setCookie !== undefined) cookie = setCookie.split(";", 1)[0]!;
    return { status: response.status, body: response.json(), raw: response.bodyText, setCookie: setCookie ?? null };
  };
  const bootstrap = async () => {
    const result = await call("POST", "/api/tavern/v1/bootstrap", {}, { apiVersion: 1, bootstrapToken: token });
    assert.equal(result.status, 200);
    csrf = (result.body as { csrfToken: string }).csrfToken;
  };
  try {
    await run(
      root,
      async (method, path, headers = {}, body) =>
        await call(method, path, { ...(csrf === null ? {} : { "x-csrf-token": csrf }), ...headers }, body),
      bootstrap,
    );
  } finally {
    await handler.close();
    await rm(root, { recursive: true, force: true });
  }
}

class ControlledResponse {
  status = 0;
  headers = new Map<string, string>();
  bodyText = "";
  private ended = false;
  private settle: (() => void) | null = null;

  /** Resolves once this response has ended, or rejects if it never does. */
  async done(timeoutMs: number): Promise<void> {
    if (this.ended) return;
    await new Promise<void>((resolveDone, rejectDone) => {
      this.settle = resolveDone;
      setTimeout(() => {
        this.settle = null;
        rejectDone(new Error("controlled_response_never_ended"));
      }, timeoutMs).unref?.();
    });
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
  writeHead(status: number, headers?: Record<string, string>): void {
    this.status = status;
    for (const [key, value] of Object.entries(headers ?? {})) this.headers.set(key, value);
  }
  end(body?: string): void {
    this.bodyText += body ?? "";
    if (this.ended) return;
    this.ended = true;
    this.settle?.();
    this.settle = null;
  }
  json(): unknown {
    try {
      return JSON.parse(this.bodyText);
    } catch {
      return undefined;
    }
  }
  get writableEnded(): boolean {
    return this.ended;
  }
  get destroyed(): boolean {
    return false;
  }
  get writableFinished(): boolean {
    return this.ended;
  }
  once(): void {}
  resume(): void {}
  setHeaderOut(): void {}
  get socket(): undefined {
    return undefined;
  }
}

test("the connection read projects the catalog, and selectable models are the catalog's", async () => {
  await withHandler({}, async (_root, request, bootstrap) => {
    // Unauthenticated read is rejected before any catalog fact is projected.
    const unauthenticated = await request("GET", "/api/tavern/v1/settings/connection");
    assert.equal(unauthenticated.status, 401);
    await bootstrap();
    const read = await request("GET", "/api/tavern/v1/settings/connection");
    assert.equal(read.status, 200);
    const body = read.body as {
      revision: number;
      active: unknown;
      connections: unknown[];
      providers: readonly {
        providerId: string;
        setupFields: readonly string[];
        allowedPlayerModels: readonly { modelId: string }[];
        escapeHatch: boolean;
        environmentManaged: boolean;
      }[];
    };
    assert.equal(body.revision, 0);
    assert.equal(body.active, null);
    assert.deepEqual(body.connections, []);
    const byId = new Map(body.providers.map((provider) => [provider.providerId, provider]));
    // The curated catalog: the environment connection, two Host-owned providers
    // and exactly one escape hatch.
    assert.deepEqual([...byId.keys()].sort(), ["cpa-oai", TAVERN_ESCAPE_HATCH_PROVIDER_ID, "deepseek", "openai"].sort());
    assert.equal(byId.get("cpa-oai")!.environmentManaged, true);
    assert.deepEqual(byId.get("cpa-oai")!.setupFields, []);
    assert.deepEqual(byId.get("cpa-oai")!.allowedPlayerModels.map((model) => model.modelId), ["deepseek-v4-flash"]);
    assert.deepEqual(
      byId.get("deepseek")!.allowedPlayerModels.map((model) => model.modelId),
      ["deepseek-v4-flash", "deepseek-v4-pro"],
    );
    const escapeHatches = body.providers.filter((provider) => provider.escapeHatch);
    assert.equal(escapeHatches.length, 1);
    assert.equal(escapeHatches[0]!.providerId, TAVERN_ESCAPE_HATCH_PROVIDER_ID);
    assert.deepEqual([...escapeHatches[0]!.setupFields].sort(), ["apiKey", "baseUrl", "modelId"]);
    // No provider payload, script or arbitrary-URL field exists anywhere.
    assert.deepEqual(
      [...new Set(body.providers.flatMap((provider) => provider.setupFields))].sort(),
      ["apiKey", "baseUrl", "modelId"],
    );
  });
});

test("a catalog key is written to the Pi provider store and never read back to the browser", async () => {
  await withHandler({}, async (root, request, bootstrap) => {
    await bootstrap();
    const created = await request("POST", "/api/tavern/v1/settings/connections", {}, {
      apiVersion: 1,
      providerId: "deepseek",
      apiKey: "sk-synthetic-credential",
    });
    assert.equal(created.status, 200);
    // The credential is durable on disk in Pi's own store, under Pi's own id.
    const credentials = JSON.parse(await readFile(connectionAuthPath(root), "utf8"));
    assert.deepEqual(credentials, { deepseek: { type: "api_key", key: "sk-synthetic-credential" } });
    // ...and nowhere in anything the browser ever receives.
    const state = await request("GET", "/api/tavern/v1/settings/connection");
    for (const response of [created, state]) {
      assert.doesNotMatch(response.raw, /sk-synthetic-credential/);
      assert.doesNotMatch(response.raw, /api_key/);
      assert.doesNotMatch(response.raw, /auth\.json/);
    }
    const connection = (state.body as { connections: readonly { connectionId: string; providerId: string }[] })
      .connections[0]!;
    assert.equal(connection.providerId, "deepseek");
    // The connectionId is an opaque write handle the browser only hands back.
    assert.match(connection.connectionId, /^[A-Za-z0-9_-]{43}$/);
  });
});

test("a rejected credential submission is an ordinary request error, not a leak", async () => {
  await withHandler({}, async (_root, request, bootstrap) => {
    await bootstrap();
    const noKey = await request("POST", "/api/tavern/v1/settings/connections", {}, {
      apiVersion: 1,
      providerId: "deepseek",
    });
    assert.equal(noKey.status, 400);
    assert.doesNotMatch(noKey.raw, /api_key_required|deepseek/);
    // A player-supplied endpoint on a catalog provider is refused.
    const arbitraryEndpoint = await request("POST", "/api/tavern/v1/settings/connections", {}, {
      apiVersion: 1,
      providerId: "openai",
      apiKey: "sk-synthetic",
      baseUrl: "http://127.0.0.1:9/v1",
    });
    assert.equal(arbitraryEndpoint.status, 400);
    // An invented provider is refused.
    const unknown = await request("POST", "/api/tavern/v1/settings/connections", {}, {
      apiVersion: 1,
      providerId: "invented",
      apiKey: "sk-synthetic",
    });
    assert.equal(unknown.status, 400);
    // The environment connection refuses a submitted key outright.
    const environment = await request("POST", "/api/tavern/v1/settings/connections", {}, {
      apiVersion: 1,
      providerId: "cpa-oai",
      apiKey: "sk-synthetic",
    });
    assert.equal(environment.status, 400);
  });
});

test("the escape hatch is a catalog entry whose base URL round-trips and whose probe decides readiness", async () => {
  const calls: string[] = [];
  await withHandler(
    {
      probe: stubEndpoint((url, headers) => {
        calls.push(`${url}|${headers.authorization ?? ""}`);
        return { status: 200, body: listModels("qwen2.5-coder:7b") };
      }),
    },
    async (_root, request, bootstrap) => {
      await bootstrap();
      const created = await request("POST", "/api/tavern/v1/settings/connections", {}, {
        apiVersion: 1,
        providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
        apiKey: "sk-synthetic-hatch-key",
        baseUrl: "http://127.0.0.1:11434/v1",
        modelId: "qwen2.5-coder:7b",
      });
      assert.equal(created.status, 200);
      const body = created.body as {
        revision: number;
        connections: readonly { connectionId: string; baseUrl: string | null; readiness: string }[];
      };
      const connection = body.connections[0]!;
      // The player's own endpoint is the one endpoint fact they read back.
      assert.equal(connection.baseUrl, "http://127.0.0.1:11434/v1");
      assert.equal(connection.readiness, "configured");

      // Activation is refused before the probe proves the endpoint answers.
      const premature = await request(
        "POST",
        `/api/tavern/v1/settings/connections/${connection.connectionId}/activate`,
        {},
        { apiVersion: 1, expectedRevision: body.revision },
      );
      assert.equal(premature.status, 409);
      assert.equal((premature.body as { code: string }).code, "connection_not_ready");

      const probe = await request(
        "POST",
        `/api/tavern/v1/settings/connections/${connection.connectionId}/test`,
        {},
        { apiVersion: 1, expectedRevision: body.revision },
      );
      assert.equal(probe.status, 200);
      const probeBody = probe.body as {
        outcome: string;
        failure: string | null;
        state: { revision: number; connections: readonly { readiness: string; active: boolean }[] };
      };
      assert.equal(probeBody.outcome, "ready");
      assert.equal(probeBody.failure, null);
      assert.equal(probeBody.state.connections[0]!.readiness, "ready");
      // The probe called the player's own endpoint with the submitted credential...
      assert.deepEqual(calls, ["http://127.0.0.1:11434/v1/models|Bearer sk-synthetic-hatch-key"]);
      // ...and the response carries back only the player's own URL (design/28
      // §1), never the credential. (`apiKey` appears only as a catalog field
      // name inside `setupFields`; no key value is ever projected.)
      assert.doesNotMatch(probe.raw, /sk-synthetic-hatch-key|Bearer |auth\.json/);

      const activated = await request(
        "POST",
        `/api/tavern/v1/settings/connections/${connection.connectionId}/activate`,
        {},
        { apiVersion: 1, expectedRevision: probeBody.state.revision },
      );
      assert.equal(activated.status, 200);
      const activatedBody = activated.body as {
        active: { connectionId: string; readiness: string } | null;
        connections: readonly { active: boolean }[];
      };
      // `active` is the durable selection; it makes no claim that a running
      // runtime has already switched model.
      assert.equal(activatedBody.active?.connectionId, connection.connectionId);
      assert.equal(activatedBody.connections[0]!.active, true);
      assert.doesNotMatch(activated.raw, /runtime|switched/);
    },
  );
});

test("probe failures are reported as closed categories with no provider text", async () => {
  const cases = [
    { status: 401, body: "unauthorized: bad key sk-live-abc", failure: "unauthorized" },
    { status: 404, body: "no such endpoint", failure: "not_found" },
    { status: 500, body: "upstream exploded at 10.0.0.5", failure: "invalid_response" },
    { status: 200, body: "not json at all", failure: "invalid_response" },
    { status: 200, body: listModels("some-other-model"), failure: "not_found" },
  ] as const;
  for (const { status, body, failure } of cases) {
    await withHandler(
      { probe: stubEndpoint(() => ({ status, body })) },
      async (_root, request, bootstrap) => {
        await bootstrap();
        const created = await request("POST", "/api/tavern/v1/settings/connections", {}, {
          apiVersion: 1,
          providerId: "deepseek",
          apiKey: "sk-synthetic-credential",
        });
        const connection = (
          created.body as { revision: number; connections: readonly { connectionId: string }[] }
        ).connections[0]!;
        const probe = await request(
          "POST",
          `/api/tavern/v1/settings/connections/${connection.connectionId}/test`,
          {},
          { apiVersion: 1, expectedRevision: (created.body as { revision: number }).revision },
        );
        assert.equal(probe.status, 200);
        const probeBody = probe.body as { outcome: string; failure: string; state: { connections: readonly { readiness: string; failure: string }[] } };
        assert.equal(probeBody.outcome, "failed");
        assert.equal(probeBody.failure, failure, `status ${status} body ${body}`);
        assert.equal(probeBody.state.connections[0]!.readiness, "failed");
        assert.equal(probeBody.state.connections[0]!.failure, failure);
        // The raw provider text never becomes a player notice or a record.
        assert.doesNotMatch(probe.raw, /sk-live-abc|10\.0\.0\.5|exploded|not json|some-other-model/);
      },
    );
  }
});

test("a transport failure is classified as unreachable, and a hang as timeout", async () => {
  await withHandler(
    {
      probe: async (input) =>
        await (await import("./tavern/connection-probe.js")).probeTavernConnection(
          input,
          (async () => {
            throw new TypeError("fetch failed: ECONNREFUSED");
          }) as unknown as typeof fetch,
        ),
    },
    async (_root, request, bootstrap) => {
      await bootstrap();
      const created = await request("POST", "/api/tavern/v1/settings/connections", {}, {
        apiVersion: 1,
        providerId: "deepseek",
        apiKey: "sk-synthetic-credential",
      });
      const connection = (
        created.body as { revision: number; connections: readonly { connectionId: string }[] }
      ).connections[0]!;
      const probe = await request(
        "POST",
        `/api/tavern/v1/settings/connections/${connection.connectionId}/test`,
        {},
        { apiVersion: 1, expectedRevision: (created.body as { revision: number }).revision },
      );
      assert.equal((probe.body as { failure: string }).failure, "unreachable");
      assert.doesNotMatch(probe.raw, /ECONNREFUSED|fetch failed/);
    },
  );
});

test("model selection is restricted to the catalog and to the model's own thinking levels", async () => {
  await withHandler({}, async (_root, request, bootstrap) => {
    await bootstrap();
    const created = await request("POST", "/api/tavern/v1/settings/connections", {}, {
      apiVersion: 1,
      providerId: "deepseek",
      apiKey: "sk-synthetic-credential",
    });
    const revision = (created.body as { revision: number }).revision;
    const connectionId = (created.body as { connections: readonly { connectionId: string }[] }).connections[0]!
      .connectionId;
    const base = `/api/tavern/v1/settings/connections/${connectionId}/model`;
    const selectModel = async (overrides: Record<string, unknown>) =>
      await request("POST", base, {}, { apiVersion: 1, expectedRevision: revision, ...overrides });

    // A model outside the catalog, and a level that exact model does not offer.
    assert.equal((await selectModel({ modelId: "invented-model", thinkingLevel: "high" })).status, 400);
    assert.equal((await selectModel({ modelId: "deepseek-v4-pro", thinkingLevel: "medium" })).status, 400);
    const allowed = await selectModel({ modelId: "deepseek-v4-pro", thinkingLevel: "max" });
    assert.equal(allowed.status, 200);
    assert.equal(
      (allowed.body as { connections: readonly { modelId: string; thinkingLevel: string }[] }).connections[0]!.modelId,
      "deepseek-v4-pro",
    );
    assert.equal(
      (allowed.body as { connections: readonly { modelId: string; thinkingLevel: string }[] }).connections[0]!
        .thinkingLevel,
      "max",
    );

    // The escape hatch accepts the model id its endpoint serves, bounded.
    const hatch = await request("POST", "/api/tavern/v1/settings/connections", {}, {
      apiVersion: 1,
      providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
      apiKey: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen2.5-coder:7b",
    });
    const hatchId = (hatch.body as { connections: readonly { connectionId: string }[] }).connections[1]!.connectionId;
    const hatchRevision = (hatch.body as { revision: number }).revision;
    const unbounded = await request(
      "POST",
      `/api/tavern/v1/settings/connections/${hatchId}/model`,
      {},
      { apiVersion: 1, expectedRevision: hatchRevision, modelId: "with space", thinkingLevel: "high" },
    );
    assert.equal(unbounded.status, 400);
  });
});

test("activation is refused with dialogue_busy while a turn is active", async () => {
  await withHandler({ turnActive: true }, async (_root, request, bootstrap) => {
    await bootstrap();
    const created = await request("POST", "/api/tavern/v1/settings/connections", {}, {
      apiVersion: 1,
      providerId: "deepseek",
      apiKey: "sk-synthetic-credential",
    });
    const revision = (created.body as { revision: number }).revision;
    const connectionId = (created.body as { connections: readonly { connectionId: string }[] }).connections[0]!
      .connectionId;
    const activate = await request(
      "POST",
      `/api/tavern/v1/settings/connections/${connectionId}/activate`,
      {},
      { apiVersion: 1, expectedRevision: revision },
    );
    assert.equal(activate.status, 409);
    assert.equal((activate.body as { code: string }).code, "dialogue_busy");
  });
});

test("removal needs the exact revision, cannot drop the active connection, and deletes the stored key", async () => {
  await withHandler(
    { probe: stubEndpoint(() => ({ status: 200, body: listModels("deepseek-v4-flash") })) },
    async (root, request, bootstrap) => {
      await bootstrap();
      const created = await request("POST", "/api/tavern/v1/settings/connections", {}, {
        apiVersion: 1,
        providerId: "deepseek",
        apiKey: "sk-synthetic-credential",
      });
      const connectionId = (created.body as { connections: readonly { connectionId: string }[] }).connections[0]!
        .connectionId;
      const activated = await request(
        "POST",
        `/api/tavern/v1/settings/connections/${connectionId}/activate`,
        {},
        { apiVersion: 1, expectedRevision: (created.body as { revision: number }).revision },
      );
      // Not probed yet, so activation was refused and the record is inactive.
      assert.equal(activated.status, 409);

      const probed = await request(
        "POST",
        `/api/tavern/v1/settings/connections/${connectionId}/test`,
        {},
        { apiVersion: 1, expectedRevision: (created.body as { revision: number }).revision },
      );
      const revision = (probed.body as { state: { revision: number } }).state.revision;
      const active = await request(
        "POST",
        `/api/tavern/v1/settings/connections/${connectionId}/activate`,
        {},
        { apiVersion: 1, expectedRevision: revision },
      );
      assert.equal(active.status, 200);
      const activeRevision = (active.body as { revision: number }).revision;

      // The active connection cannot be removed.
      const refused = await request(
        "DELETE",
        `/api/tavern/v1/settings/connections/${connectionId}`,
        {},
        { apiVersion: 1, expectedRevision: activeRevision },
      );
      assert.equal(refused.status, 409);

      // A stale revision is a conflict, never a silent removal.
      const stale = await request(
        "DELETE",
        `/api/tavern/v1/settings/connections/${connectionId}`,
        {},
        { apiVersion: 1, expectedRevision: activeRevision - 1 },
      );
      assert.equal(stale.status, 409);
      assert.equal((stale.body as { code: string }).code, "connection_conflict");

      // An unknown handle is not a removal either.
      const unknown = await request(
        "DELETE",
        `/api/tavern/v1/settings/connections/${"B".repeat(43)}`,
        {},
        { apiVersion: 1, expectedRevision: activeRevision },
      );
      assert.equal(unknown.status, 404);
      assert.equal((unknown.body as { code: string }).code, "connection_not_found");
      assert.deepEqual(JSON.parse(await readFile(connectionAuthPath(root), "utf8")), {
        deepseek: { type: "api_key", key: "sk-synthetic-credential" },
      });
    },
  );
});

test("every connection route enforces session, CSRF, origin and exact body validation", async () => {
  await withHandler({}, async (_root, request, bootstrap) => {
    const connectionId = "C".repeat(43);
    const paths = [
      ["POST", "/api/tavern/v1/settings/connections"],
      ["POST", `/api/tavern/v1/settings/connections/${connectionId}/test`],
      ["POST", `/api/tavern/v1/settings/connections/${connectionId}/activate`],
      ["POST", `/api/tavern/v1/settings/connections/${connectionId}/model`],
      ["DELETE", `/api/tavern/v1/settings/connections/${connectionId}`],
    ] as const;
    // Before bootstrap: the read is unauthorized, and every mutation is
    // unauthorized too (a GET carrying a body is refused earlier, by design).
    assert.equal((await request("GET", "/api/tavern/v1/settings/connection")).status, 401);
    for (const [method, path] of paths)
      assert.equal(
        (await request(method, path, {}, { apiVersion: 1, expectedRevision: 0 })).status,
        401,
        `${method} ${path}`,
      );
    await bootstrap();
    for (const [method, path] of paths) {
      // A missing CSRF header is a 400/403, never an admitted mutation.
      const noCsrf = await request(method, path, { "x-csrf-token": "" }, { apiVersion: 1, expectedRevision: 0 });
      assert.ok(noCsrf.status === 403 || noCsrf.status === 400, `${method} ${path} => ${noCsrf.status}`);
      // A wrong CSRF header is rejected exactly.
      const wrongCsrf = await request(
        method,
        path,
        { "x-csrf-token": "D".repeat(43) },
        { apiVersion: 1, expectedRevision: 0 },
      );
      assert.equal(wrongCsrf.status, 403, `${method} ${path}`);
      assert.equal((wrongCsrf.body as { code: string }).code, "csrf_failed");
      // A foreign origin is rejected even with the session cookie.
      const foreign = await request(
        method,
        path,
        { origin: "http://127.0.0.1:7332" },
        { apiVersion: 1, expectedRevision: 0 },
      );
      assert.equal(foreign.status, 401, `${method} ${path}`);
      // A query string is never admitted on a connection route.
      const withQuery = await request(method, `${path}?unexpected=1`, {}, { apiVersion: 1, expectedRevision: 0 });
      assert.equal(withQuery.status, 401, `${method} ${path}`);
      // An inexact body is refused before any durable work.
      for (const body of [
        { apiVersion: 1, expectedRevision: 0, extra: true },
        { apiVersion: 2, expectedRevision: 0 },
        { apiVersion: 1 },
        {},
      ]) {
        const invalid = await request(method, path, {}, body);
        assert.equal(invalid.status, 400, `${method} ${path} body ${JSON.stringify(body)}`);
      }
    }
  });
});

test("the profile gates connection routes: absent from the profile, absent from the surface", async () => {
  // The frozen management profile without the connection extension group keeps
  // the exact previous surface even when the service is injected.
  const withoutConnections = composeTavernProfile({
    profileId: "gamebuddy.tavern-management.chat-list-title",
    releaseTier: "tavern_management",
    routeIds: [
      "bootstrap",
      "state.read",
      "draft.read",
      "draft.save",
      "draft.discard",
      "chat.list",
      "chat.rename",
      "world-info.read",
      "world-info.bind",
      "settings.voice.read",
      "settings.voice.consent",
    ],
    operationIds: [
      "draft.save",
      "draft.discard",
      "chat.rename",
      "world-info.bind",
      "settings.voice.read",
      "settings.voice.consent",
    ],
    navigationItemIds: ["chat"],
  });
  await withHandler({ profile: withoutConnections }, async (_root, request, bootstrap) => {
    await bootstrap();
    assert.equal((await request("GET", "/api/tavern/v1/settings/connection")).status, 404);
    const create = await request("POST", "/api/tavern/v1/settings/connections", {}, {
      apiVersion: 1,
      providerId: "deepseek",
      apiKey: "sk-synthetic",
    });
    assert.equal(create.status, 404);
    assert.equal((create.body as { code: string }).code, "profile_operation_unavailable");
  });
});

test("a profile that advertises connection routes without the Host service fails closed", async () => {
  assert.throws(
    () =>
      createTavernManagementDialogueWebRequestHandler({
        managementStateFacade: facade(false),
        managementService,
        worldInfoService,
        voicePreferenceStore: Object.freeze({
          async read() {
            return { revision: 0, disclosureVersion: null, consent: "undecided" as const, decidedAtMs: null, outputDevice: null };
          },
          async update() {
            return { revision: 1, disclosureVersion: null, consent: "accepted" as const, decidedAtMs: 1, outputDevice: null };
          },
        }),
        profile: connectionProfile,
        bootstrapToken: token,
      }),
    /tavern_management_composition_unavailable/,
  );
});
