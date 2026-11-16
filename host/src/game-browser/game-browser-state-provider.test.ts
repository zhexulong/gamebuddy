import assert from "node:assert/strict";
import test from "node:test";
import {
  GameBrowserValidatorsV1,
  composeGameProfile,
  type GameBrowserStateV1,
} from "../game-browser-contract/index.js";
import { createGameBrowserStateProvider } from "./game-browser-state-provider.js";
import { createGameEventStream } from "./game-event-stream.js";
import type {
  StardewGameSurfaceActionAuthorityReader,
  StardewGameSurfaceActionAuthorityView,
  StardewGameSurfaceAttachmentReader,
  StardewGameSurfaceAttachmentView,
  StardewGameSurfaceCapabilityReader,
  StardewGameSurfaceCapabilityView,
  StardewGameSurfaceLaunchReadinessReader,
  StardewGameSurfaceLaunchReadinessView,
} from "../stardew-production-lifecycle-coordinator.internal.js";
import type { StardewRoleLifecycleReader, StardewRoleLifecycleView } from "../stardew-role-lifecycle-facade.js";

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
  view: StardewGameSurfaceLaunchReadinessView = Object.freeze({
    generation: 0,
    status: "none",
    playerHostExitCode: null,
  }),
): StardewGameSurfaceLaunchReadinessReader {
  return Object.freeze({ readLaunchReadinessView: () => view });
}

function actionAuthority(
  status: StardewGameSurfaceActionAuthorityView["status"] = "unavailable",
): StardewGameSurfaceActionAuthorityReader {
  return Object.freeze({ readActionAuthorityView: () => Object.freeze({ status }) });
}

function capability(view: StardewGameSurfaceCapabilityView): StardewGameSurfaceCapabilityReader {
  return Object.freeze({ readCapabilityView: () => view });
}

function attachedSurface(): StardewGameSurfaceAttachmentReader {
  return attachment(Object.freeze({ status: "attached", generation: 1, connectionStatus: "connected_idle" }));
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
  const state = await createGameBrowserStateProvider(
    profile(),
    lifecycle(
      Object.freeze({
        schemaVersion: 1,
        playerHost: Object.freeze({ state: "awaiting_attestation", ownership: "gamebuddy_direct_spawn" }),
        aiClient: Object.freeze({ state: "not_started", ownership: "none" }),
      }),
    ),
    attachment(),
    launchReadiness(),
  ).readState(context);
  assert.deepEqual(state.game.prerequisites, { status: "met", detectedGame: "Stardew Valley", missingItems: [] });
  assert.deepEqual(state.game.instance, { status: "launching", gameTitle: "Stardew Valley", generation: 0 });
  assert.equal(JSON.stringify(state).includes("C:\\\\"), false);
});

test("provider projects a failed launch terminality as latestOutcome failed", async () => {
  const state = await createGameBrowserStateProvider(
    profile(),
    lifecycle(notStartedView()),
    attachment(),
    launchReadiness(Object.freeze({ generation: 0, status: "failed", playerHostExitCode: null })),
  ).readState(context);
  assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(state), true);
  assert.equal(state.game.instance.status, "crashed");
  assert.equal(state.game.latestOutcome, "failed");
});

/**
 * The exit code, not the presence of an exit, decides what the game's ending is called.
 *
 * The two projections below are a player who quit Stardew and a player whose game died - the same
 * dead process and the same dead attempt, differing only in the number the OS reported. They must
 * differ in exactly the words that are about failure and in nothing else: `stopped` versus
 * `crashed` for the instance, `none` versus `failed` for the last outcome, and the code itself.
 * Reading the presence of an exit as a crash is what this test keeps out.
 */
test("a normal exit reads as an ending and only a non-zero one reads as a crash", async () => {
  const read = async (playerHostExitCode: number) =>
    await createGameBrowserStateProvider(
      profile(),
      lifecycle(notStartedView()),
      attachment(),
      launchReadiness(Object.freeze({ generation: 0, status: "failed", playerHostExitCode })),
    ).readState(context);

  const quit = await read(0);
  const crashed = await read(86);
  for (const state of [quit, crashed])
    assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(state), true, "the projection stays valid");

  assert.equal(quit.game.instance.status, "stopped", "exit 0 is the OS's normal termination, not a crash");
  assert.equal(quit.game.instance.playerHostExitCode, 0, "the code the OS reported is published as it is");
  assert.equal(quit.game.latestOutcome, "none", "a game the player ended is not a failed outcome");

  assert.equal(crashed.game.instance.status, "crashed");
  assert.equal(crashed.game.instance.playerHostExitCode, 86);
  assert.equal(crashed.game.latestOutcome, "failed");

  // The only differences are the ones justified above: the two words for what happened, and the
  // digit. Everything else a reader sees is the same fact about the same attempt.
  const differing = Object.keys(quit.game).filter(
    (key) =>
      JSON.stringify(quit.game[key as keyof typeof quit.game]) !==
      JSON.stringify(crashed.game[key as keyof typeof crashed.game]),
  );
  assert.deepEqual(
    differing.sort(),
    ["instance", "latestOutcome"],
    "an ending and a crash differ only in the instance row's two facts and the outcome word",
  );
  const instanceKeys = Object.keys(quit.game.instance).filter(
    (key) =>
      JSON.stringify(quit.game.instance[key as keyof typeof quit.game.instance]) !==
      JSON.stringify(crashed.game.instance[key as keyof typeof crashed.game.instance]),
  );
  assert.deepEqual(instanceKeys.sort(), ["playerHostExitCode", "status"]);
});

test("read-only provider accepts a reader-only fresh lifecycle and projects only unchecked/none", async () => {
  const reader = lifecycle(notStartedView());
  assert.deepEqual(Object.keys(reader), ["readRoleLifecycleView"]);
  const state = await createGameBrowserStateProvider(profile(), reader, attachment(), launchReadiness()).readState(
    context,
  );
  assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(state), true);
  assert.deepEqual(state.game, {
    prerequisites: { status: "unknown", detectedGame: null, missingItems: [] },
    instance: { status: "none", gameTitle: null, generation: 0 },
    compatibility: { status: "unchecked", message: null },
    attachment: { status: "none", generation: 0 },
    connectionStatus: "none",
    actionAuthority: "unavailable",
    role: null,
    companionName: null,
    selectedWorld: null,
    selectedSave: null,
    capabilitySummary: { status: "not_measured", reason: "no_capability_reader" },
    latestOutcome: "none",
  });
});

test("read-only provider projects unavailable lifecycle without fabricated attachment facts", async () => {
  const state = await createGameBrowserStateProvider(
    profile(),
    lifecycle(unavailableView()),
    attachment(),
    launchReadiness(),
  ).readState(context);
  assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(state), true);
  assert.deepEqual(state.game, {
    prerequisites: { status: "unknown", detectedGame: null, missingItems: [] },
    instance: { status: "unread", gameTitle: null, generation: 0 },
    compatibility: { status: "unchecked", message: null },
    attachment: { status: "none", generation: 0 },
    connectionStatus: "none",
    actionAuthority: "unavailable",
    role: null,
    companionName: null,
    selectedWorld: null,
    selectedSave: null,
    capabilitySummary: { status: "not_measured", reason: "no_capability_reader" },
    latestOutcome: "none",
  });
});

/**
 * The player's game was not read, and that is a different fact from "nothing is
 * running". The facade answers `unavailable` for a read that produced no fact and
 * `unknown` for a player-external game it could not verify; both were projected as
 * `instance.status: "none"`, which is the word for "nothing is running yet", so the
 * surface told a player whose game the Host had not read to set up and activate.
 */
test("a player game the Host has not read is projected as unread, never as nothing running", async () => {
  const unreadSlots = [
    Object.freeze({ state: "unavailable", ownership: "player_external" }),
    Object.freeze({ state: "unknown", ownership: "player_external" }),
  ] as const;
  for (const playerHost of unreadSlots) {
    const state = await createGameBrowserStateProvider(
      profile(),
      lifecycle(
        Object.freeze({
          schemaVersion: 1,
          playerHost,
          aiClient: Object.freeze({ state: "not_started", ownership: "none" }),
        }),
      ),
      attachment(),
      launchReadiness(),
    ).readState(context);
    assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(state), true);
    assert.equal(state.game.instance.status, "unread", `${playerHost.state} is not the fact "nothing is running"`);
    assert.equal(state.game.instance.generation, 0);
  }
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
    // No capability reader is mounted in this construction, so the projection says so (`not_measured` + a reason)
    // instead of publishing the `0` the old literal did.
    assert.deepEqual(state.game.capabilitySummary, { status: "not_measured", reason: "no_capability_reader" });
    assert.equal(state.game.selectedSave, null);
    assert.equal(state.game.selectedWorld, null);
  }
});

/**
 * THE CAPABILITY SUMMARY IS THE LIVE SURFACE'S OWN COUNT, and the three zeros stay apart.
 *
 * `game_browser_api/v1` carries either a measured count (`published`, where `0` means the runtime advertised nothing) or
 * a reason this layer could not measure it (`not_measured`, which carries no count at all). The field used to be the
 * literal `Object.freeze({ available: false, count: 0 })`, so the companion board read "no capability published"
 * whatever the runtime said - the review's finding, and the reason the number is now read from a reader.
 */
test("capability_summary: a published count reaches the browser, and an unmeasured reading carries no count", async () => {
  const read = (view: StardewGameSurfaceCapabilityView): Promise<GameBrowserStateV1> =>
    createGameBrowserStateProvider(
      profile(),
      lifecycle(authenticatedView("verified")),
      attachment(Object.freeze({ status: "attached", generation: 1, connectionStatus: "connected_idle" })),
      launchReadiness(),
      actionAuthority("active"),
      undefined,
      undefined,
      Object.freeze({ readCapabilityView: () => view }),
    ).readState(context);

  // The count is the reader's own: two different counts must reach two different projections.
  const three = await read(Object.freeze({ status: "published", count: 3 }));
  const nine = await read(Object.freeze({ status: "published", count: 9 }));
  assert.deepEqual(three.game.capabilitySummary, { status: "published", count: 3 });
  assert.deepEqual(nine.game.capabilitySummary, { status: "published", count: 9 });

  // A MEASURED ZERO IS NOT "NOT MEASURED": the runtime answered and advertised nothing.
  const zero = await read(Object.freeze({ status: "published", count: 0 }));
  assert.deepEqual(zero.game.capabilitySummary, { status: "published", count: 0 });

  // And an unmeasured reading carries the reader's reason and NO count - never `count: 0` as a stand-in.
  const unmeasured = await read(Object.freeze({ status: "not_measured", reason: "host_game_state_mismatch" }));
  assert.deepEqual(unmeasured.game.capabilitySummary, {
    status: "not_measured",
    reason: "host_game_state_mismatch",
  });
});

test("provider requires an exact composed profile with game.state.read mounted", () => {
  assert.throws(
    () =>
      createGameBrowserStateProvider({ ...profile() }, lifecycle(unavailableView()), attachment(), launchReadiness()),
    /game_browser_profile_not_composed/,
  );
  const profileWithoutState = composeGameProfile({
    profileId: "gamebuddy.game.no-state",
    releaseTier: "game_preview",
    operationIds: [],
    navigationItemIds: ["game"],
  });
  assert.throws(
    () =>
      createGameBrowserStateProvider(
        profileWithoutState,
        lifecycle(unavailableView()),
        attachment(),
        launchReadiness(),
      ),
    /game_browser_state_read_not_mounted/,
  );
});

test("provider projects the coordinator-owned action authority exactly and defaults closed without a reader", async () => {
  const lifecycleView = lifecycle(authenticatedView("verified"));
  const attached = attachment(Object.freeze({ status: "attached", generation: 1, connectionStatus: "connected_idle" }));
  const readiness = launchReadiness();
  for (const status of ["unavailable", "active", "paused"] as const) {
    const state = await createGameBrowserStateProvider(
      profile(),
      lifecycleView,
      attached,
      readiness,
      actionAuthority(status),
    ).readState(context);
    assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(state), true);
    assert.equal(state.game.actionAuthority, status);
    // The authority is a distinct dimension: a paused resume authority still
    // coexists with an attached connected_idle surface.
    assert.equal(state.game.connectionStatus, "connected_idle");
  }
  // Without a reader the projection defaults to unavailable and never invents
  // active/paused from the attachment or connection facts.
  const noReader = await createGameBrowserStateProvider(profile(), lifecycleView, attached, readiness).readState(
    context,
  );
  assert.equal(noReader.game.actionAuthority, "unavailable");
  assert.equal(noReader.game.connectionStatus, "connected_idle");
  assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(noReader), true);
});

test("provider rejects short or non-canonical CSRF context without reading lifecycle", async () => {
  let lifecycleReads = 0;
  const provider = createGameBrowserStateProvider(
    profile(),
    lifecycle(unavailableView(), () => lifecycleReads++),
    attachment(),
    launchReadiness(),
  );
  for (const csrfToken of ["short", `${"A".repeat(21)}!`, "B".repeat(22)])
    await assert.rejects(
      () => provider.readState({ csrfToken, browserSessionExpiresAtMs: context.browserSessionExpiresAtMs }),
      /invalid_game_browser_read_state_context/,
    );
  assert.equal(lifecycleReads, 0);
});

test("provider rejects invalid or non-finite expiry context without reading lifecycle", async () => {
  let lifecycleReads = 0;
  const provider = createGameBrowserStateProvider(
    profile(),
    lifecycle(unavailableView(), () => lifecycleReads++),
    attachment(),
    launchReadiness(),
  );
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

test("provider maps a launch in flight to launching and a launch-ready attempt to nothing running", async () => {
  const launchInFlightView = lifecycle(
    Object.freeze({
      schemaVersion: 1,
      playerHost: Object.freeze({ state: "pending", ownership: "gamebuddy_direct_spawn" }),
      aiClient: Object.freeze({ state: "not_started", ownership: "none" }),
    }),
  );
  // `pending` is the composed lifecycle word for a launch actually in flight.
  const launching = await createGameBrowserStateProvider(
    profile(),
    launchInFlightView,
    attachment(),
    launchReadiness(Object.freeze({ generation: 1, status: "ready", playerHostExitCode: null })),
  ).readState(context);
  assert.equal(launching.game.instance.status, "launching");
  assert.equal(launching.game.instance.generation, 1);
  assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(launching), true);

  // With no staged instance the generation is 0 even though prerequisites are met.
  const idle = await createGameBrowserStateProvider(
    profile(),
    launchInFlightView,
    attachment(),
    launchReadiness(),
  ).readState(context);
  assert.equal(idle.game.instance.status, "launching");
  assert.equal(idle.game.instance.generation, 0);
  assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(idle), true);

  // A launch-ready but not-yet-launched projection carries the generation without a numeric UI leak.
  // The coordinator composes exactly this slot shape for a staged attempt, whose
  // launch reservation is an authorization rather than a running role
  // (stardew-role-lifecycle-projection.internal.ts), and this is the shape the
  // client's launch gate requires.
  const readyToLaunch = await createGameBrowserStateProvider(
    profile(),
    lifecycle(
      Object.freeze({
        schemaVersion: 1,
        playerHost: Object.freeze({ state: "not_started", ownership: "none" }),
        aiClient: Object.freeze({ state: "not_started", ownership: "none" }),
      }),
    ),
    attachment(),
    launchReadiness(Object.freeze({ generation: 1, status: "ready", playerHostExitCode: null })),
  ).readState(context);
  assert.deepEqual(readyToLaunch.game.instance, { status: "none", gameTitle: null, generation: 1 });
  assert.equal(readyToLaunch.game.prerequisites.status, "met");
  assert.equal(readyToLaunch.game.prerequisites.detectedGame, "Stardew Valley");
  assert.equal(JSON.stringify(readyToLaunch.game).includes("player-generation"), false);
  assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(readyToLaunch), true);
});

test("a running lifecycle still projects running and is never a launch-from-idle state", async () => {
  const state = await createGameBrowserStateProvider(
    profile(),
    lifecycle(authenticatedView("verified")),
    attachment(),
    launchReadiness(),
  ).readState(context);
  assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(state), true);
  assert.equal(state.game.instance.status, "running");
  assert.equal(state.game.instance.generation, 0);
});

test("terminal launch failure remains met/crashed without a retry generation", async () => {
  const failed = await createGameBrowserStateProvider(
    profile(),
    lifecycle(notStartedView()),
    attachment(),
    launchReadiness(Object.freeze({ generation: 0, status: "failed", playerHostExitCode: null })),
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

/**
 * The push channel's own projection.
 *
 * A frame must name exactly what `/game` names, so the two entry points are one projection: these tests hold the
 * snapshot and the fact group to each other, field by field, rather than to a second hand-written copy.
 */
test("the game snapshot publishes the stream checkpoint and each fact group matches the snapshot", async () => {
  const stream = createGameEventStream();
  const provider = createGameBrowserStateProvider(
    profile(),
    lifecycle(authenticatedView("verified")),
    attachedSurface(),
    launchReadiness(),
    actionAuthority("paused"),
    undefined,
    undefined,
    capability(Object.freeze({ status: "published", count: 12 })),
    stream,
  );

  const state = await provider.readState(context);
  assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(state), true);
  assert.deepEqual(state.eventStream, { epoch: stream.epoch, cursor: stream.cursor });

  const instance = await provider.readFact("instance");
  assert.deepEqual(instance, {
    fact: "instance",
    game: {
      instance: state.game.instance,
      compatibility: state.game.compatibility,
      latestOutcome: state.game.latestOutcome,
    },
  });
  const attached = await provider.readFact("attachment");
  assert.deepEqual(attached, {
    fact: "attachment",
    game: {
      attachment: state.game.attachment,
      connectionStatus: state.game.connectionStatus,
      capabilitySummary: state.game.capabilitySummary,
    },
  });
  const world = await provider.readFact("selectedWorld");
  assert.deepEqual(world, { fact: "selectedWorld", game: { selectedWorld: state.game.selectedWorld } });

  // Every published frame is a frame the contract accepts.
  for (const patch of [instance, attached, world]) {
    assert.equal(GameBrowserValidatorsV1.GameFactPatchV1Schema.Check(patch), true);
    assert.equal(GameBrowserValidatorsV1.GameEventV1Schema.Check(stream.publish(patch)), true);
  }
});

test("a mount that holds no stream publishes no checkpoint rather than an empty one", async () => {
  const state = await createGameBrowserStateProvider(
    profile(),
    lifecycle(notStartedView()),
    attachment(),
    launchReadiness(),
  ).readState(context);
  assert.equal(Object.hasOwn(state, "eventStream"), false);
  assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(state), true);
});
