import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { GameBrowserValidatorsV1, composeGameProfile } from "../game-browser-contract/index.js";
import {
  openProductionContinuityStore,
  type ProductionBootstrapInput,
  type ProductionContinuityStore,
} from "../continuity-semantic-store/continuity-semantic-production-store.js";
import {
  createStardewWorldBindingResolver,
  type StardewWorldBindingResolver,
} from "../stardew-owned-farmhand-game-world-binding-resolver.internal.js";
import { createStardewGameSurfaceWorldBindingReader } from "../stardew-production-lifecycle-coordinator.internal.js";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
import { createGameBrowserStateProvider } from "./game-browser-state-provider.js";

const context = { csrfToken: "QWxhZGRpbjpvcGVuIHNlc2FtZQ", browserSessionExpiresAtMs: 100_000 };

const bootstrap: ProductionBootstrapInput = {
  principal: {
    continuityId: "continuity-world-projection",
    companionId: "companion-world-projection",
    playerId: "player-world-projection",
  },
  bootstrapOperationId: "bootstrap-world-projection",
  authorityGeneration: 1,
  authorityRootIdentity: "c".repeat(64),
};

type StoreView = ReturnType<ProductionContinuityStore["bindBootstrapContext"]>;

function profile() {
  return composeGameProfile({
    profileId: "gamebuddy.game.preview",
    releaseTier: "game_preview",
    operationIds: ["game.state.read"],
    navigationItemIds: ["game"],
  });
}

/** The one production resolver over the real store's durable world-binding row. */
function resolverOver(store: StoreView): StardewWorldBindingResolver {
  return createStardewWorldBindingResolver((input) => Promise.resolve(store.readGameSessionWorldBinding(input)));
}

/**
 * The browser read exactly as `games/stardew/provider.ts` composes it: the
 * coordinator's own lifecycle/attachment/readiness readers (reduced here to the
 * facts this property needs) plus the world-binding reader under test. Nothing
 * in this fixture re-implements the reader - it is the production one.
 */
async function projectWorld(store: StoreView, activeGameSessionId: () => string | undefined) {
  return createGameBrowserStateProvider(
    profile(),
    Object.freeze({
      async readRoleLifecycleView() {
        return Object.freeze({
          schemaVersion: 1 as const,
          playerHost: Object.freeze({
            state: "authenticated" as const,
            ownership: "player_external" as const,
            compatibility: "verified" as const,
            attachmentAllowed: true,
          }),
          aiClient: Object.freeze({ state: "not_started" as const, ownership: "none" as const }),
        });
      },
    }),
    Object.freeze({
      readAttachmentView: () =>
        Object.freeze({ status: "attached" as const, generation: 1, connectionStatus: "connected_idle" as const }),
    }),
    Object.freeze({
      readLaunchReadinessView: () =>
        Object.freeze({ generation: 1, status: "ready" as const, playerHostExitCode: null }),
    }),
    undefined,
    undefined,
    createStardewGameSurfaceWorldBindingReader(resolverOver(store), activeGameSessionId),
  ).readState(context);
}

/** Every key path in the projection, so a launch fact is found wherever it is nested. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    keyPaths(child, prefix === "" ? key : `${prefix}.${key}`),
  );
}

const LAUNCH_FACT_KEYS = new Set([
  "root",
  "dataroot",
  "identityroot",
  "installroot",
  "pid",
  "processid",
  "pipe",
  "pipepath",
  "token",
  "bridgetoken",
  "sessiontoken",
  "frame",
  "nativeframe",
  "savepath",
  "datapath",
  "exepath",
]);

async function withStore(body: (store: StoreView) => Promise<void>): Promise<void> {
  const root = canonicalTestRootSync("world-projection-");
  const control = openProductionContinuityStore({ runtimeRoot: root });
  try {
    const metadata = control.bootstrapFresh(bootstrap);
    await body(control.bindBootstrapContext({ bootstrap, metadata }));
  } finally {
    control.close();
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* Windows SQLite cleanup is best effort */
    }
  }
}

test("a world bound by create reaches the browser projection through the integration-private resolver", async () => {
  await withStore(async (store) => {
    const session = store.createGameSessionMetadata({
      creationRequestId: "create-world-projection",
      integrationId: "stardew",
      continuityIdentityId: bootstrap.principal.continuityId,
    });
    const registered = store.registerGameSessionWorldBinding({
      gameSessionId: session.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_341209384",
      operationId: "bind-world-projection",
      holderHandle: "holder-world-projection",
    });
    store.completeGameSessionBinding({
      creationRequestId: "create-world-projection",
      gameSessionId: session.gameSessionId,
      expectedRevision: 1,
    });

    const state = await projectWorld(store, () => session.gameSessionId);

    assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(state), true);
    assert.equal(state.game.selectedWorld, registered.bindingRef);
    // The world identity is the store's own row, never a value the projection minted.
    assert.equal(registered.status, "registered");
  });
});

test("a world whose binding was never persisted projects no world at all", async () => {
  await withStore(async (store) => {
    const session = store.createGameSessionMetadata({
      creationRequestId: "create-world-unbound",
      integrationId: "stardew",
      continuityIdentityId: bootstrap.principal.continuityId,
    });
    const state = await projectWorld(store, () => session.gameSessionId);
    assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(state), true);
    assert.equal(state.game.selectedWorld, null);
  });
});

test("a terminal world is not projected as the selected world", async () => {
  await withStore(async (store) => {
    const session = store.createGameSessionMetadata({
      creationRequestId: "create-world-terminal",
      integrationId: "stardew",
      continuityIdentityId: bootstrap.principal.continuityId,
    });
    store.registerGameSessionWorldBinding({
      gameSessionId: session.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_999999999",
      operationId: "bind-world-terminal",
      holderHandle: "holder-world-terminal",
    });
    store.completeGameSessionBinding({
      creationRequestId: "create-world-terminal",
      gameSessionId: session.gameSessionId,
      expectedRevision: 1,
    });
    store.markGameSessionWorldBindingTerminal({
      gameSessionId: session.gameSessionId,
      integrationId: "stardew",
      expectedRevision: 1,
      operationId: "bind-world-terminal",
    });
    const state = await projectWorld(store, () => session.gameSessionId);
    assert.equal(state.game.selectedWorld, null);
  });
});

test("the projection carries no launch fact and the contract refuses one that tries", async () => {
  await withStore(async (store) => {
    const session = store.createGameSessionMetadata({
      creationRequestId: "create-world-redaction",
      integrationId: "stardew",
      continuityIdentityId: bootstrap.principal.continuityId,
    });
    store.registerGameSessionWorldBinding({
      gameSessionId: session.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_341209384",
      operationId: "bind-world-redaction",
      holderHandle: "holder-world-redaction",
    });
    store.completeGameSessionBinding({
      creationRequestId: "create-world-redaction",
      gameSessionId: session.gameSessionId,
      expectedRevision: 1,
    });

    const state = await projectWorld(store, () => session.gameSessionId);

    const paths = keyPaths(state);
    const named = paths.filter((path) => LAUNCH_FACT_KEYS.has(path.split(".").at(-1)!.toLowerCase()));
    assert.deepEqual(named, [], `projection names launch facts ${named.join(", ")}: ${paths.join(", ")}`);
    // A path can only reach the browser inside a string, and there is none.
    assert.equal(/[A-Za-z]:\\\\|\\\\\.\\pipe/.test(JSON.stringify(state)), false);

    // The gate, not just the reading: a Host that adds a launch fact to this
    // projection is refused by the published contract rather than by convention.
    const withProcessFact = {
      ...state,
      game: { ...state.game, pid: 4242 },
    };
    assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(withProcessFact), false);
  });
});
