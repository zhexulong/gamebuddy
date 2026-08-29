import assert from "node:assert/strict";
import test from "node:test";
import {
  GameBrowserValidatorsV1,
  composeGameProfile,
} from "../game-browser-contract/index.js";
import {
  createGameBrowserStateProvider,
} from "./game-browser-state-provider.js";
import type { StardewGameSurfaceAttachmentReader, StardewGameSurfaceAttachmentView, StardewGameSurfaceLaunchReadinessReader, StardewGameSurfaceLaunchReadinessView } from "../stardew-production-lifecycle-coordinator.internal.js";
import type {
  StardewRoleLifecycleReader,
  StardewRoleLifecycleView,
} from "../stardew-role-lifecycle-facade.js";

const context = {
  csrfToken: "QWxhZGRpbjpvcGVuIHNlc2FtZQ",
  browserSessionExpiresAtMs: 100_000,
};

function profile() {
  return composeGameProfile({
    profileId: "gamebuddy.game.preview",
    releaseTier: "game_preview",
    operationIds: ["game.state.read"],
    navigationItemIds: ["game"],
  });
}

function attachment(
  view: StardewGameSurfaceAttachmentView = Object.freeze({ status: "none", generation: 0, connectionStatus: "none" }),
): StardewGameSurfaceAttachmentReader {
  return Object.freeze({ readAttachmentView: () => view });
}

function launchReadiness(
  view: StardewGameSurfaceLaunchReadinessView = Object.freeze({ generation: 0, status: "none" }),
): StardewGameSurfaceLaunchReadinessReader {
  return Object.freeze({ readLaunchReadinessView: () => view });
}

function lifecycle(view: StardewRoleLifecycleView, onRead = () => {}): StardewRoleLifecycleReader {
  return Object.freeze({
    async readRoleLifecycleView() {
      onRead();
      return view;
    },
  });
}

function notStartedView(): StardewRoleLifecycleView {
  return Object.freeze({
    schemaVersion: 1,
    playerHost: Object.freeze({ state: "not_started", ownership: "none" }),
    aiClient: Object.freeze({ state: "not_started", ownership: "none" }),
  });
}

function unavailableView(): StardewRoleLifecycleView {
  return Object.freeze({
    schemaVersion: 1,
    playerHost: Object.freeze({ state: "unavailable", ownership: "player_external" }),
    aiClient: Object.freeze({
      state: "awaiting_attestation",
      ownership: "gamebuddy_direct_spawn",
      lastStopOutcome: "none",
    }),
  });
}

function authenticatedView(
  compatibility: "verified" | "compatible_unverified" | "below_minimum_warning" | "hard_incompatible",
  attachmentAllowed = compatibility !== "hard_incompatible",
): StardewRoleLifecycleView {
  return Object.freeze({
    schemaVersion: 1,
    playerHost: Object.freeze({
      state: "authenticated",
      ownership: "player_external",
      compatibility,
      attachmentAllowed,
    }),
    aiClient: Object.freeze({ state: "not_started", ownership: "none" }),
  });
}

test("spawned Player Host projects only met prerequisite and truthful launching instance", async () => {
  const state = await createGameBrowserStateProvider(profile(), lifecycle(Object.freeze({
    schemaVersion: 1,
    playerHost: Object.freeze({ state: "awaiting_attestation", ownership: "gamebuddy_direct_spawn" }),
    aiClient: Object.freeze({ state: "not_started", ownership: "none" }),
  })), attachment(), launchReadiness()).readState(context);
  assert.deepEqual(state.game.prerequisites, { status: "met", detectedGame: "Stardew Valley", missingItems: [] });
  assert.deepEqual(state.game.instance, { status: "launching", gameTitle: "Stardew Valley", generation: 0 });
  assert.equal(JSON.stringify(state).includes("C:\\\\"), false);
});

test("read-only provider accepts a reader-only fresh lifecycle and projects only unchecked/none", async () => {
  const reader = lifecycle(notStartedView());
  assert.deepEqual(Object.keys(reader), ["readRoleLifecycleView"]);
  const state = await createGameBrowserStateProvider(profile(), reader, attachment(), launchReadiness()).readState(context);
  assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(state), true);
  assert.deepEqual(state.game, {
    prerequisites: { status: "unknown", detectedGame: null, missingItems: [] },
    instance: { status: "none", gameTitle: null, generation: 0 },
    compatibility: { status: "unchecked", message: null },
    attachment: { status: "none", generation: 0 },
    connectionStatus: "none",
    role: null,
    companionName: null,
    selectedWorld: null,
    selectedSave: null,
    capabilitySummary: { available: false, count: 0 },
    latestOutcome: "none",
  });
});

test("read-only provider projects unavailable lifecycle without fabricated attachment facts", async () => {
  const state = await createGameBrowserStateProvider(profile(), lifecycle(unavailableView()), attachment(), launchReadiness()).readState(context);
  assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(state), true);
  assert.deepEqual(state.game, {
    prerequisites: { status: "unknown", detectedGame: null, missingItems: [] },
    instance: { status: "none", gameTitle: null, generation: 0 },
    compatibility: { status: "unchecked", message: null },
    attachment: { status: "none", generation: 0 },
    connectionStatus: "none",
    role: null,
    companionName: null,
    selectedWorld: null,
    selectedSave: null,
    capabilitySummary: { available: false, count: 0 },
    latestOutcome: "none",
  });
});

test("compatibility mapping is explicit and does not attest attachment readiness", async () => {
  const cases = [
    ["verified", true, "compatible"],
    ["compatible_unverified", true, "warning"],
    ["below_minimum_warning", true, "warning"],
    ["hard_incompatible", false, "incompatible"],
  ] as const;
  for (const [source, allowed, expected] of cases) {
    const state = await createGameBrowserStateProvider(
      profile(),
      lifecycle(authenticatedView(source, allowed)),
      attachment(),
      launchReadiness(),
    ).readState(context);
    assert.equal(state.game.compatibility.status, expected, source);
    assert.equal(state.game.connectionStatus, "none", source);
    assert.equal(state.game.attachment.status, "none", source);
  }
});

test("provider projects only Host-owned attachment generation and connection state", async () => {
  for (const connectionStatus of ["connected_idle", "stopping", "stopped", "failed"] as const) {
    const state = await createGameBrowserStateProvider(
      profile(),
      lifecycle(authenticatedView("verified")),
      attachment(Object.freeze({ status: "attached", generation: 1, connectionStatus })),
      launchReadiness(),
    ).readState(context);
    assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(state), true);
    assert.deepEqual(state.game.attachment, { status: "attached", generation: 1 });
    assert.equal(state.game.connectionStatus, connectionStatus);
    assert.equal(state.game.capabilitySummary.available, false);
    assert.equal(state.game.selectedSave, null);
    assert.equal(state.game.selectedWorld, null);
  }
});

test("provider requires an exact composed profile with game.state.read mounted", () => {
  assert.throws(
    () => createGameBrowserStateProvider({ ...profile() }, lifecycle(unavailableView()), attachment(), launchReadiness()),
    /game_browser_profile_not_composed/,
  );
  const profileWithoutState = composeGameProfile({
    profileId: "gamebuddy.game.no-state",
    releaseTier: "game_preview",
    operationIds: [],
    navigationItemIds: ["game"],
  });
  assert.throws(
    () => createGameBrowserStateProvider(profileWithoutState, lifecycle(unavailableView()), attachment(), launchReadiness()),
    /game_browser_state_read_not_mounted/,
  );
});

test("provider rejects short or non-canonical CSRF context without reading lifecycle", async () => {
  let lifecycleReads = 0;
  const provider = createGameBrowserStateProvider(profile(), lifecycle(unavailableView(), () => lifecycleReads++), attachment(), launchReadiness());
  for (const csrfToken of ["short", "A".repeat(21) + "!", "B".repeat(22)])
    await assert.rejects(
      () => provider.readState({ csrfToken, browserSessionExpiresAtMs: context.browserSessionExpiresAtMs }),
      /invalid_game_browser_read_state_context/,
    );
  assert.equal(lifecycleReads, 0);
});

test("provider rejects invalid or non-finite expiry context without reading lifecycle", async () => {
  let lifecycleReads = 0;
  const provider = createGameBrowserStateProvider(profile(), lifecycle(unavailableView(), () => lifecycleReads++), attachment(), launchReadiness());
  for (const browserSessionExpiresAtMs of [-1, 100_000.5, Number.NaN, Number.POSITIVE_INFINITY])
    await assert.rejects(
      () => provider.readState({ csrfToken: context.csrfToken, browserSessionExpiresAtMs }),
      /invalid_game_browser_read_state_context/,
    );
  assert.equal(lifecycleReads, 0);
});

test("provider response redacts lifecycle internals and has no ready claim", async () => {
  const state = await createGameBrowserStateProvider(
    profile(),
    lifecycle(authenticatedView("verified")),
    attachment(),
    launchReadiness(),
  ).readState(context);
  const serialized = JSON.stringify(state);
  for (const forbidden of [
    "pid",
    "creation",
    "handle",
    "endpoint",
    "token",
    "saveId",
    "worldId",
    "actionId",
    "receipt",
    "prompt",
    "model",
    "connected",
    "attached",
    "ready",
    "active",
  ])
    assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("provider projects the coordinator-owned launch generation exactly and never fabricates one", async () => {
  const launchedView = lifecycle(Object.freeze({
    schemaVersion: 1,
    playerHost: Object.freeze({ state: "pending", ownership: "gamebuddy_direct_spawn" }),
    aiClient: Object.freeze({ state: "not_started", ownership: "none" }),
  }));
  // A staged coordinator-owned instance exposes its exact expected generation.
  const staged = await createGameBrowserStateProvider(
    profile(),
    launchedView,
    attachment(),
    launchReadiness(Object.freeze({ generation: 1, status: "ready" })),
  ).readState(context);
  assert.equal(staged.game.instance.status, "launching");
  assert.equal(staged.game.instance.generation, 1);
  assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(staged), true);

  // With no staged instance the generation is 0 even though prerequisites are met.
  const idle = await createGameBrowserStateProvider(
    profile(),
    launchedView,
    attachment(),
    launchReadiness(),
  ).readState(context);
  assert.equal(idle.game.instance.status, "launching");
  assert.equal(idle.game.instance.generation, 0);
  assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(idle), true);

  // A launch-ready but not-yet-launched projection carries the generation without a numeric UI leak.
  // In real coordinator flow, staged-but-not-launched means the lifecycle facade reports
  // no spawned player host (ownership "none") while the coordinator's readiness reader
  // exposes the exact generation, proving no process is implied.
  const readyToLaunch = await createGameBrowserStateProvider(
    profile(),
    lifecycle(Object.freeze({
      schemaVersion: 1,
      playerHost: Object.freeze({ state: "not_started", ownership: "none" }),
      aiClient: Object.freeze({ state: "not_started", ownership: "none" }),
    })),
    attachment(),
    launchReadiness(Object.freeze({ generation: 1, status: "ready" })),
  ).readState(context);
  assert.deepEqual(readyToLaunch.game.instance, { status: "none", gameTitle: null, generation: 1 });
  assert.equal(readyToLaunch.game.prerequisites.status, "met");
  assert.equal(readyToLaunch.game.prerequisites.detectedGame, "Stardew Valley");
  assert.equal(JSON.stringify(readyToLaunch.game).includes("player-generation"), false);
  assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(readyToLaunch), true);
});


test("terminal launch failure remains met/crashed without a retry generation", async () => {
  const failed = await createGameBrowserStateProvider(
    profile(),
    lifecycle(notStartedView()),
    attachment(),
    launchReadiness(Object.freeze({ generation: 0, status: "failed" })),
  ).readState(context);

  assert.deepEqual(failed.game.prerequisites, {
    status: "met",
    detectedGame: "Stardew Valley",
    missingItems: [],
  });
  assert.deepEqual(failed.game.instance, {
    status: "crashed",
    gameTitle: "Stardew Valley",
    generation: 0,
  });
  assert.equal(failed.game.connectionStatus, "none");
  assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(failed), true);
});
