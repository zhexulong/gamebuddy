import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import {
  connectionAuthPath,
  connectionDocumentPath,
  connectionKeysPath,
  normalizePlayerBaseUrl,
  TavernConnectionInputError,
  TavernConnectionRevisionConflict,
  TavernConnectionStore,
} from "./connection-store.js";
import { TAVERN_ESCAPE_HATCH_PROVIDER_ID } from "./provider-catalog.js";

// The store takes a durable path lock, so the tests need the same test-only
// reclaimer binding every other path-lock consumer's test uses. Without it the
// release fails closed with `windows_reclaimer_unavailable` and every mutation
// reports a lock failure that has nothing to do with the store.
let canonicalTemporaryRoot: string;

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  canonicalTemporaryRoot = await realpath(tmpdir());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

async function withRoot(run: (root: string, store: TavernConnectionStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(canonicalTemporaryRoot, "gamebuddy-connection-store-"));
  try {
    await run(root, new TavernConnectionStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("an unconfigured root has no connection and writes nothing", async () => {
  await withRoot(async (root, store) => {
    const document = await store.read();
    assert.deepEqual(document, { revision: 0, activeConnectionId: null, connections: [] });
    await assert.rejects(readFile(connectionDocumentPath(root), "utf8"), /ENOENT/);
    await assert.rejects(readFile(connectionAuthPath(root), "utf8"), /ENOENT/);
    assert.equal(await store.active(), null);
  });
});

test("a catalog connection stores only the opaque handle and writes its key to the Pi provider store", async () => {
  await withRoot(async (root, store) => {
    const document = await store.create({
      providerId: "deepseek",
      apiKey: "sk-synthetic-credential",
      baseUrl: null,
      apiShape: null,
      modelId: "deepseek-v4-pro",
    });
    assert.equal(document.revision, 1);
    assert.equal(document.connections.length, 1);
    const connection = document.connections[0]!;
    assert.match(connection.connectionId, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(connection.providerId, "deepseek");
    assert.equal(connection.baseUrl, null);
    assert.equal(connection.modelId, "deepseek-v4-pro");
    assert.equal(connection.readiness, "configured");
    assert.equal(connection.lastCheckedAtMs, null);

    // The credential lives only in Pi's own store, under the catalog's Pi
    // provider id, in the credential shape that store already reads.
    const credentials = JSON.parse(await readFile(connectionAuthPath(root), "utf8"));
    assert.deepEqual(credentials, { deepseek: { type: "api_key", key: "sk-synthetic-credential" } });

    // The record document never carries the secret.
    const persisted = await readFile(connectionDocumentPath(root), "utf8");
    assert.doesNotMatch(persisted, /sk-synthetic-credential/);
    assert.deepEqual(
      Object.keys(JSON.parse(persisted)).sort(),
      ["activeConnectionId", "connections", "revision", "schemaVersion"],
    );
    assert.equal(await store.credentialFor(connection), "sk-synthetic-credential");
  });
});

test("the escape hatch accepts the player's own base URL and model id and reads the URL back", async () => {
  await withRoot(async (root, store) => {
    const document = await store.create({
      providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
      apiKey: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1/",
      apiShape: "openai-completions",
      modelId: "qwen2.5-coder:7b",
    });
    const connection = document.connections[0]!;
    // One endpoint has exactly one spelling: the trailing slash is dropped.
    assert.equal(connection.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(connection.modelId, "qwen2.5-coder:7b");
    const credentials = JSON.parse(await readFile(connectionAuthPath(root), "utf8"));
    assert.deepEqual(credentials, { [TAVERN_ESCAPE_HATCH_PROVIDER_ID]: { type: "api_key", key: "ollama" } });
  });
});

test("same-provider escape-hatch connections keep their own credential, not the provider slot's last write", async () => {
  await withRoot(async (root, store) => {
    const first = await store.create({
      providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
      apiKey: "sk-first-key",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiShape: "openai-completions",
      modelId: "qwen2.5-coder:7b",
    });
    const firstId = first.connections[0]!.connectionId;
    const second = await store.create({
      providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
      apiKey: "sk-second-key",
      baseUrl: "http://127.0.0.1:9999/v1",
      apiShape: "anthropic-messages",
      modelId: "qwen2.5-coder:7b",
    });
    const secondId = second.connections[1]!.connectionId;
    assert.notEqual(firstId, secondId);

    // Each connection probes with the key the player typed for IT, even though
    // the Pi provider slot now holds the second connection's key. The per-
    // connection key file is the Host-owned authority; the provider slot is
    // the runtime's single view and must not leak across connections.
    assert.equal(await store.credentialFor(second.connections[0]!), "sk-first-key");
    assert.equal(await store.credentialFor(second.connections[1]!), "sk-second-key");

    // Removing one connection drops only its key; the other connection's key
    // and credential survive.
    await store.remove(secondId, 2);
    const after = await store.read();
    assert.equal(after.connections.length, 1);
    assert.equal(after.connections[0]!.connectionId, firstId);
    assert.equal(await store.credentialFor(after.connections[0]!), "sk-first-key");
    const keys = JSON.parse(await readFile(connectionKeysPath(root), "utf8"));
    assert.deepEqual(Object.keys(keys), [firstId]);
  });
});

test("catalog providers reject a player-supplied endpoint, and the escape hatch requires one", async () => {
  await withRoot(async (_root, store) => {
    await assert.rejects(
      store.create({ providerId: "openai", apiKey: "k", baseUrl: "http://127.0.0.1:9/v1", apiShape: null, modelId: null }),
      (error: unknown) => error instanceof TavernConnectionInputError && error.reason === "base_url_not_accepted",
    );
    await assert.rejects(
      store.create({ providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID, apiKey: "k", baseUrl: null, apiShape: "openai-completions", modelId: "m" }),
      (error: unknown) => error instanceof TavernConnectionInputError && error.reason === "base_url_required",
    );
    for (const baseUrl of [
      "file:///etc/passwd",
      "http://user:pass@127.0.0.1:11434/v1",
      "http://127.0.0.1:11434/v1#x",
      "not-a-url",
    ])
      await assert.rejects(
        store.create({ providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID, apiKey: "k", baseUrl, apiShape: "openai-completions", modelId: "m" }),
        (error: unknown) => error instanceof TavernConnectionInputError && error.reason === "invalid_base_url",
        `expected ${baseUrl} to be rejected`,
      );
  });
});

test("the environment connection never accepts, stores or reads back a credential", async () => {
  await withRoot(async (root, store) => {
    await assert.rejects(
      store.create({ providerId: "cpa-oai", apiKey: "sk-operator", baseUrl: null, apiShape: null, modelId: null }),
      (error: unknown) => error instanceof TavernConnectionInputError && error.reason === "api_key_not_accepted",
    );
    const document = await store.create({ providerId: "cpa-oai", apiKey: null, baseUrl: null, apiShape: null, modelId: null });
    const connection = document.connections[0]!;
    assert.equal(connection.modelId, "deepseek-v4-flash");
    await assert.rejects(readFile(connectionAuthPath(root), "utf8"), /ENOENT/);
    const previous = process.env.CPA_OAI_API_KEY;
    try {
      delete process.env.CPA_OAI_API_KEY;
      assert.equal(await store.credentialFor(connection), null);
      process.env.CPA_OAI_API_KEY = "sk-synthetic-env";
      assert.equal(await store.credentialFor(connection), "sk-synthetic-env");
    } finally {
      if (previous === undefined) delete process.env.CPA_OAI_API_KEY;
      else process.env.CPA_OAI_API_KEY = previous;
    }
  });
});

test("probe outcomes are recorded as a closed vocabulary and gate activation", async () => {
  await withRoot(async (_root, store) => {
    const created = await store.create({ providerId: "deepseek", apiKey: "k", baseUrl: null, apiShape: null, modelId: null });
    const connectionId = created.connections[0]!.connectionId;
    await assert.rejects(
      store.activate(connectionId, created.revision),
      (error: unknown) => error instanceof TavernConnectionInputError && error.reason === "not_ready",
    );
    const failed = await store.recordProbe(connectionId, { outcome: "failed", failure: "unauthorized" });
    assert.equal(failed.connections[0]!.readiness, "failed");
    assert.equal(failed.connections[0]!.failure, "unauthorized");
    assert.ok(typeof failed.connections[0]!.lastCheckedAtMs === "number");
    await assert.rejects(
      store.activate(connectionId, failed.revision),
      (error: unknown) => error instanceof TavernConnectionInputError && error.reason === "not_ready",
    );
    const ready = await store.recordProbe(connectionId, { outcome: "ready" });
    assert.equal(ready.connections[0]!.readiness, "ready");
    assert.equal(ready.connections[0]!.failure, null);
    const active = await store.activate(connectionId, ready.revision);
    assert.equal(active.activeConnectionId, connectionId);
    assert.equal((await store.active())?.connectionId, connectionId);
  });
});

test("changing the selected model withdraws readiness until it is probed again", async () => {
  await withRoot(async (_root, store) => {
    const created = await store.create({ providerId: "deepseek", apiKey: "k", baseUrl: null, apiShape: null, modelId: null });
    const connectionId = created.connections[0]!.connectionId;
    const ready = await store.recordProbe(connectionId, { outcome: "ready" });
    const changed = await store.selectModel(connectionId, ready.revision, "deepseek-v4-pro", "max");
    assert.equal(changed.connections[0]!.modelId, "deepseek-v4-pro");
    assert.equal(changed.connections[0]!.thinkingLevel, "max");
    assert.equal(changed.connections[0]!.readiness, "configured");
    await assert.rejects(
      store.activate(connectionId, changed.revision),
      (error: unknown) => error instanceof TavernConnectionInputError && error.reason === "not_ready",
    );
    await assert.rejects(
      store.selectModel(connectionId, changed.revision, "deepseek-v4-pro", "medium"),
      (error: unknown) => error instanceof TavernConnectionInputError && error.reason === "thinking_level_not_allowed",
    );
    await assert.rejects(
      store.selectModel(connectionId, changed.revision, "invented-model", "high"),
      (error: unknown) => error instanceof TavernConnectionInputError && error.reason === "model_not_allowed",
    );
  });
});

test("a stale expectedRevision is a durable conflict, never a silent overwrite", async () => {
  await withRoot(async (_root, store) => {
    const created = await store.create({ providerId: "deepseek", apiKey: "k", baseUrl: null, apiShape: null, modelId: null });
    const connectionId = created.connections[0]!.connectionId;
    const ready = await store.recordProbe(connectionId, { outcome: "ready" });
    await store.activate(connectionId, ready.revision);
    await assert.rejects(
      store.activate(connectionId, ready.revision),
      (error: unknown) => error instanceof TavernConnectionRevisionConflict,
    );
  });
});

test("removing a connection drops its stored credential and keeps unrelated provider entries", async () => {
  await withRoot(async (root, store) => {
    await writeFile(
      connectionAuthPath(root),
      JSON.stringify({ anthropic: { type: "api_key", key: "sk-unrelated" } }),
      "utf8",
    );
    const created = await store.create({ providerId: "deepseek", apiKey: "k", baseUrl: null, apiShape: null, modelId: null });
    const connectionId = created.connections[0]!.connectionId;
    const removed = await store.remove(connectionId, created.revision);
    assert.deepEqual(removed.connections, []);
    assert.deepEqual(JSON.parse(await readFile(connectionAuthPath(root), "utf8")), {
      anthropic: { type: "api_key", key: "sk-unrelated" },
    });
  });
});

test("the active connection cannot be removed", async () => {
  await withRoot(async (_root, store) => {
    const created = await store.create({ providerId: "deepseek", apiKey: "k", baseUrl: null, apiShape: null, modelId: null });
    const connectionId = created.connections[0]!.connectionId;
    const ready = await store.recordProbe(connectionId, { outcome: "ready" });
    const active = await store.activate(connectionId, ready.revision);
    await assert.rejects(
      store.remove(connectionId, active.revision),
      (error: unknown) =>
        error instanceof TavernConnectionInputError && error.reason === "active_connection_cannot_be_removed",
    );
    // An unknown handle is an ordinary not-found, never a mutation.
    await assert.rejects(
      store.remove("A".repeat(43), active.revision),
      (error: unknown) => error instanceof TavernConnectionInputError && error.reason === "not_found",
    );
  });
});

test("a corrupted connection document fails closed instead of reading as empty", async () => {
  const root = await mkdtemp(join(canonicalTemporaryRoot, "gamebuddy-connection-store-"));
  try {
    const store = new TavernConnectionStore(root);
    const created = await store.create({ providerId: "deepseek", apiKey: "k", baseUrl: null, apiShape: null, modelId: null });
    const connectionId = created.connections[0]!.connectionId;

    // A dangling active selection must not silently become "no active connection".
    await writeFile(
      connectionDocumentPath(root),
      JSON.stringify({
        schemaVersion: 1,
        revision: 2,
        activeConnectionId: "B".repeat(43),
        connections: [persistedConnection(connectionId)],
      }),
      "utf8",
    );
    await assert.rejects(store.read(), /invalid_tavern_connection_store/);

    // A record may not smuggle an endpoint its catalog entry did not authorize.
    await writeFile(
      connectionDocumentPath(root),
      JSON.stringify({
        schemaVersion: 1,
        revision: 2,
        activeConnectionId: null,
        connections: [{ ...persistedConnection(connectionId), baseUrl: "http://127.0.0.1:9/v1" }],
      }),
      "utf8",
    );
    await assert.rejects(store.read(), /invalid_tavern_connection_store/);

    await writeFile(connectionDocumentPath(root), '{"schemaVersion":1}', "utf8");
    await assert.rejects(store.read(), /invalid_tavern_connection_store/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The two endpoint configurations a fixed `openai-completions` shape and a
 * query-less URL made unreachable, as the store's own input contract states
 * them: the escape hatch is the only entry a player may hand an endpoint and a
 * shape to, and the exact string must be one Pi's adapters speak.
 */
test("a query-string endpoint and an API shape are refused everywhere except the escape hatch", async () => {
  await withRoot(async (_root, store) => {
    // A catalog entry pins its own endpoint and API shape, so neither may be
    // overridden — including a query string on the endpoint we own.
    await assert.rejects(
      store.create({
        providerId: "openai",
        apiKey: "k",
        baseUrl: "https://api.openai.com/v1?api-version=2024-02-01",
        apiShape: null,
        modelId: null,
      }),
      (error: unknown) => error instanceof TavernConnectionInputError && error.reason === "base_url_not_accepted",
    );
    await assert.rejects(
      store.create({ providerId: "openai", apiKey: "k", baseUrl: null, apiShape: "openai-responses", modelId: null }),
      (error: unknown) => error instanceof TavernConnectionInputError && error.reason === "api_shape_not_accepted",
    );
    // The operator-credentialed environment connection is a catalog entry too.
    await assert.rejects(
      store.create({
        providerId: "cpa-oai",
        apiKey: null,
        baseUrl: "https://attacker.example.com/v1?api-version=1",
        apiShape: null,
        modelId: null,
      }),
      (error: unknown) => error instanceof TavernConnectionInputError && error.reason === "base_url_not_accepted",
    );

    // The escape hatch requires one exact shape from Pi's own adapter set.
    await assert.rejects(
      store.create({
        providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
        apiKey: "k",
        baseUrl: "https://gateway.example.com/v1",
        apiShape: null,
        modelId: "m",
      }),
      (error: unknown) => error instanceof TavernConnectionInputError && error.reason === "api_shape_required",
    );
    for (const apiShape of ["openai", "chat-completions", "", "Anthropic-Messages", "openai-responses "]) {
      await assert.rejects(
        store.create({
          providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
          apiKey: "k",
          baseUrl: "https://gateway.example.com/v1",
          apiShape,
          modelId: "m",
        }),
        (error: unknown) => error instanceof TavernConnectionInputError && error.reason === "invalid_api_shape",
        `expected ${JSON.stringify(apiShape)} to be rejected`,
      );
    }
    // A query string stays legal for the escape hatch's own endpoint; a
    // fragment is refused there too. (The pure normalizer test above pins the
    // exact accepted spellings.)
    await assert.rejects(
      store.create({
        providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
        apiKey: "k",
        baseUrl: "https://gateway.example.com/v1#f",
        apiShape: "openai-completions",
        modelId: "m",
      }),
      (error: unknown) => error instanceof TavernConnectionInputError && error.reason === "invalid_base_url",
    );
  });
});

/**
 * The durable record shape a query-string endpoint and a player-chosen API
 * shape must survive, and the two corruptions the reader must fail closed on:
 * a catalog record may not smuggle an API shape, and an escape-hatch record may
 * not name one Pi cannot speak.
 */
test("a durable escape-hatch record keeps its query-string endpoint and API shape, and a smuggled one fails closed", async () => {
  const root = await mkdtemp(join(canonicalTemporaryRoot, "gamebuddy-connection-store-"));
  try {
    const store = new TavernConnectionStore(root);
    const connectionId = "A".repeat(43);
    const endpoint = "https://gateway.example.com/openai/deployments/coder?api-version=2024-02-01";
    const hatchRecord = {
      connectionId,
      providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
      baseUrl: endpoint,
      apiShape: "anthropic-messages",
      modelId: "claude-3-5-sonnet",
      thinkingLevel: "high",
      readiness: "configured",
      failure: null,
      lastCheckedAtMs: null,
    };
    const writeDocument = async (record: unknown) =>
      await writeFile(
        connectionDocumentPath(root),
        JSON.stringify({ schemaVersion: 1, revision: 2, activeConnectionId: null, connections: [record] }),
        "utf8",
      );

    // The exact record the writer persists reads back with both facts intact.
    await writeDocument(hatchRecord);
    const document = await store.read();
    assert.equal(document.connections[0]!.baseUrl, endpoint);
    assert.equal(document.connections[0]!.apiShape, "anthropic-messages");

    // A garbage shape is a corrupted record, never a runtime API id.
    await writeDocument({ ...hatchRecord, apiShape: "invented-messages" });
    await assert.rejects(store.read(), /invalid_tavern_connection_store/);

    // The escape hatch's query string is legal, but a catalog record's is not:
    // the same URL under a pinned provider is a corrupted document.
    await writeDocument({ ...persistedConnection(connectionId), baseUrl: endpoint });
    await assert.rejects(store.read(), /invalid_tavern_connection_store/);

    // A catalog record that carries an API shape at all is equally corrupt.
    await writeDocument({ ...persistedConnection(connectionId), apiShape: "openai-completions" });
    await assert.rejects(store.read(), /invalid_tavern_connection_store/);

    // So is an escape-hatch record that omits the shape it must have chosen.
    await writeDocument({ ...hatchRecord, apiShape: null });
    await assert.rejects(store.read(), /invalid_tavern_connection_store/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function persistedConnection(connectionId: string) {
  return {
    connectionId,
    providerId: "deepseek",
    baseUrl: null,
    apiShape: null,
    modelId: "deepseek-v4-flash",
    thinkingLevel: "high",
    readiness: "configured",
    failure: null,
    lastCheckedAtMs: null,
  };
}

test("player base URL normalization is strict and single-spelled", () => {
  assert.equal(normalizePlayerBaseUrl("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
  assert.equal(normalizePlayerBaseUrl("http://localhost:1234/v1/"), "http://localhost:1234/v1");
  assert.equal(normalizePlayerBaseUrl("https://gateway.example.com"), "https://gateway.example.com");
  assert.equal(normalizePlayerBaseUrl("https://gateway.example.com/"), "https://gateway.example.com");
  assert.equal(normalizePlayerBaseUrl("file:///c:/secrets"), null);
  assert.equal(normalizePlayerBaseUrl("ftp://example.com"), null);
  assert.equal(normalizePlayerBaseUrl("http://user:pw@example.com/v1"), null);
  assert.equal(normalizePlayerBaseUrl("http://example.com/v1?a=1"), null);
  assert.equal(normalizePlayerBaseUrl("http://example.com/v1#f"), null);
  assert.equal(normalizePlayerBaseUrl(""), null);
  assert.equal(normalizePlayerBaseUrl("x".repeat(600)), null);
  assert.equal(normalizePlayerBaseUrl(42), null);
  // Only a caller that owns the endpoint (the escape hatch) may keep a query;
  // a fragment and inline credentials stay refused either way.
  assert.equal(normalizePlayerBaseUrl("http://example.com/v1?a=1", true), "http://example.com/v1?a=1");
  assert.equal(normalizePlayerBaseUrl("http://example.com/v1/?a=1", true), "http://example.com/v1?a=1");
  assert.equal(normalizePlayerBaseUrl("http://example.com/?a=1", true), "http://example.com?a=1");
  assert.equal(normalizePlayerBaseUrl("http://example.com/v1#f", true), null);
  assert.equal(normalizePlayerBaseUrl("http://user:pw@example.com/v1?a=1", true), null);
});
