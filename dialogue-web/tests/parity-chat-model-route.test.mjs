/**
 * One rule, two sides of the wire: can a reply reach a model?
 *
 * The Host answers it in one place (`settings/model-selection.ts`, whose outcome distinguishes
 * `selected` from `no_model` and `unreadable`), and the browser answers it in one place
 * (`dialogue-web/src/chat-model-route.ts`, which classifies what it was served). Two places is
 * already one more than ideal, so this table is what keeps them agreeing: for every state a root can
 * be in it asks BOTH - the Host's own function, and the browser's route over the real Host projection
 * for that same root - and asserts the browser's answer is the one the Host's outcome implies.
 *
 * The two vocabularies are genuinely different and this table says so instead of pretending
 * otherwise: the Host speaks about a *store* (`selected` / `no_model` / `unreadable`), the browser
 * speaks about a *send* (`connection` / `none` / `unknown`). What the table pins is the mapping
 * between them, which is the whole rule, and it is one-to-one:
 *
 *  - a selected model     -> `connection`: the send has a connection to reach;
 *  - no connection        -> `none`: the send has nowhere to go, and the surface says so, because the
 *    player's next step is Settings;
 *  - an unreadable store  -> `unknown`: the surface says NOTHING rather than claiming the player
 *    configured nothing. A corrupt document is a store defect, not a fresh install, and telling the
 *    player to configure a connection they already have is a worse answer than admitting the read
 *    failed. That distinction is the one the old shared `null` collapsed.
 *
 * The projection is the real one: `createTavernConnectionService` over the same `agentDir` the Host's
 * decision read. A fixture standing in for it could agree with the browser by construction and prove
 * nothing.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "../../host/src/path-lock.ts";
import { resolveSurfaceModelSelection } from "../../host/src/settings/model-selection.ts";
import { createTavernConnectionService } from "../../host/src/tavern/connection-service.ts";
import { connectionDocumentPath, TavernConnectionStore } from "../../host/src/tavern/connection-store.ts";
import { createBuildWindowsStaleLockReclaimer } from "../../host/src/windows-stale-lock-reclaimer/index.ts";
import { readChatModelRoute } from "../src/chat-model-route.ts";

const CONNECTION = Object.freeze({ providerId: "deepseek", modelId: "deepseek-v4-pro" });

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

async function root(prefix) {
  const runtimeRoot = await mkdtemp(join(await realpath(tmpdir()), prefix));
  const agentDir = join(runtimeRoot, "contexts", "identity_01", "pi-agent");
  await mkdir(join(runtimeRoot, "settings"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  return Object.freeze({ runtimeRoot, agentDir });
}

async function activateConnection(agentDir) {
  const store = new TavernConnectionStore(agentDir);
  const created = await store.create({
    providerId: CONNECTION.providerId,
    apiKey: "sk-synthetic-connection-key",
    baseUrl: null,
    apiShape: null,
    modelId: CONNECTION.modelId,
  });
  const connectionId = created.connections[0].connectionId;
  const probed = await store.recordProbe(connectionId, { outcome: "ready", modelIds: [CONNECTION.modelId] });
  await store.activate(connectionId, probed.revision);
}

/** The profiles the browser's second read returns; neither names a provider or a model. */
function profiles() {
  return Object.freeze({
    apiVersion: 1,
    chat: Object.freeze({ revision: 0, thinkingLevel: "high" }),
    game: Object.freeze({ revision: 0, thinkingLevel: "high" }),
    recommendedModels: Object.freeze([]),
  });
}

/**
 * The Host's answer for a root, and the browser's answer over the Host's own projection of that same
 * root. A projection the Host refuses is served to the route as the refusal it is, which is exactly
 * what the management client does when a read fails.
 */
async function answers(value) {
  const host = await resolveSurfaceModelSelection({ ...value, surface: "chat" });
  const service = createTavernConnectionService({ agentDir: value.agentDir });
  try {
    let state;
    let refusal = null;
    try {
      state = await service.read();
    } catch (error) {
      refusal = error;
    }
    const route = await readChatModelRoute({
      readConnection: async () => {
        if (refusal !== null) throw refusal;
        return state;
      },
      readModelProfiles: async () => profiles(),
    });
    return { host, route, projected: refusal === null, refusal: refusal?.message ?? null };
  } finally {
    await service.close();
  }
}

/**
 * The states a root can be in, each with the *pair* of answers the rule says are the same fact.
 *
 * `sawModel` is what the table itself compares: whether a send from this root would reach a model.
 * The two vocabularies are mapped onto that one question, which is why a new state needs one entry
 * and not one test.
 */
const STATES = Object.freeze([
  {
    id: "connection-active",
    async arrange(value) {
      await activateConnection(value.agentDir);
    },
    host: "selected",
    browser: "connection",
    sawModel: true,
    /** The projection must be servable: a send reaches a model only through one. */
    projected: true,
  },
  {
    id: "connection-absent",
    async arrange() {},
    host: "no_model",
    browser: "none",
    sawModel: false,
    projected: true,
  },
  {
    id: "connection-unreadable",
    async arrange(value) {
      await writeFile(connectionDocumentPath(value.agentDir), "{ not a connection document", "utf8");
    },
    host: "unreadable",
    /**
     * The Host refuses to project a document it cannot validate, so the browser is served that
     * refusal - and a refusal it cannot attribute is the one it does not classify, which is the
     * `unknown` route: the surface says nothing instead of claiming the player configured nothing.
     * That is what the Host's own `unreadable` means, and the two agree that this root is not a
     * root with a model to send through.
     */
    browser: "unknown",
    sawModel: false,
    projected: false,
  },
]);

test("the Host's answer and the browser's route agree about whether a reply can reach a model", async (t) => {
  for (const state of STATES) {
    const value = await root(`parity-model-route-${state.id}-`);
    try {
      await state.arrange(value);
      const { host, route, projected, refusal } = await answers(value);
      assert.equal(host.status, state.host, `${state.id}: the Host's own answer`);
      assert.equal(projected, state.projected, `${state.id}: whether the Host can project this store`);
      assert.equal(
        route.kind,
        state.browser,
        `${state.id}: the browser's route, over the Host's own ${projected ? "projection" : `refusal (${refusal})`}`,
      );
      const browserSawModel = route.kind === "connection";
      assert.equal(
        host.status === "selected",
        browserSawModel,
        `${state.id}: the two sides must agree that a reply can reach a model`,
      );
      assert.equal(browserSawModel, state.sawModel, `${state.id}: the rule's own answer`);
      t.diagnostic(`${state.id}: host=${host.status} browser=${route.kind} projected=${projected}`);
    } finally {
      await rm(value.runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});

test("the two vocabularies are one mapping, and every member of each is covered", () => {
  // Every state the Host's outcome declares has to appear above, so adding an outcome without saying
  // what the browser does about it fails here rather than in a live session.
  const byHost = new Map(STATES.map((state) => [state.host, state.browser]));
  assert.deepEqual(
    [...byHost.keys()].sort(),
    ["no_model", "selected", "unreadable"],
    "every outcome the Host's answer declares is a state this table drives",
  );
  // ... the mapping is one-to-one: two Host outcomes must never collapse onto one route, because that
  // is precisely how a store defect came to read as a fresh install.
  assert.equal(
    new Set(byHost.values()).size,
    byHost.size,
    `each Host outcome must have its own route, got ${JSON.stringify([...byHost])}`,
  );
  // ... and every route the browser declares is produced by one of them.
  assert.deepEqual(
    [...new Set(byHost.values())].sort(),
    ["connection", "none", "unknown"],
    "every route the browser declares is the translation of one Host outcome",
  );
});
