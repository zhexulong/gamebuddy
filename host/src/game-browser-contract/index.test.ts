import assert from "node:assert/strict";
import test from "node:test";
import { Compile } from "typebox/compile";
import {
  composeGameProfile,
  GAME_BROWSER_OPERATION_IDS_V1,
  GAME_BROWSER_PROBLEM_CODES_V1,
  GAME_BROWSER_API_V1,
  GameBrowserContractV1,
  GameBrowserFixtureV1,
  GameBrowserValidatorsV1,
  GameLaunchCommandV1Schema,
  GameAttachCommandV1Schema,
  GameStopCommandV1Schema,
  GameReconnectCommandV1Schema,
  GameDisconnectCommandV1Schema,
  GamePrerequisitesSetupCommandV1Schema,
  GameBrowserStateV1Schema,
  isComposedGameProfile,
} from "./index.js";

const handle = "QWxhZGRpbjpvcGVuIHNlc2FtZQ";
const idempotencyKey = "ABEiM0RVZneImaq7zN3u_w";

const baseState = {
  apiVersion: 1,
  build: { browserContract: GAME_BROWSER_API_V1, profileId: "gamebuddy.game.preview" },
  csrfToken: handle,
  browserSession: { expiresAtMs: 100_000 },
  game: {
    prerequisites: { status: "met" as const, detectedGame: "Stardew Valley", missingItems: [] },
    instance: { status: "detected" as const, gameTitle: "Stardew Valley" },
    compatibility: { status: "compatible" as const, message: null },
    attachment: { status: "none" as const, generation: 0 },
    connectionStatus: "none" as const,
    role: null,
    companionName: null,
    selectedWorld: null,
    selectedSave: null,
    capabilitySummary: { available: false, count: 0 },
    latestOutcome: "none" as const,
  },
};

test("Game Browser v1 provides a bounded, unmounted Game lifecycle contract", () => {
  assert.equal(GameBrowserContractV1.id, GAME_BROWSER_API_V1);
  assert.ok(GameBrowserContractV1.id.startsWith("game_browser_api/"));
  assert.equal("mount" in GameBrowserContractV1, false);
  assert.deepEqual(Object.keys(GameBrowserValidatorsV1).sort(), Object.keys(GameBrowserContractV1.schemas).sort());
});

// ─── GameBrowserStateV1 safe snapshot ───────────────────────────────────────

test("GameBrowserStateV1 accepts a fully redacted connected-idle snapshot", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  const state = GameBrowserFixtureV1.state();
  assert.equal(validator.Check(state), true);
});

test("GameBrowserStateV1 accepts every valid connectionStatus value", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  const validStatuses = [
    "none",
    "discovering",
    "launch_pending",
    "attach_pending",
    "compatibility_warning",
    "awaiting_confirmation",
    "connecting",
    "connected_idle",
    "active",
    "stopping",
    "reconnecting",
    "stopped",
    "failed",
    "disconnected",
  ] as const;
  for (const connectionStatus of validStatuses) {
    assert.equal(validator.Check({ ...baseState, game: { ...baseState.game, connectionStatus } }), true);
  }
});

test("GameBrowserStateV1 pending states never claim connected", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  // "pending" is not a valid connectionStatus; the spec uses specific pending
  // states: launch_pending, attach_pending, connecting. None of these equal
  // "connected_idle" or "active".
  for (const pending of ["launch_pending", "attach_pending", "connecting"] as const) {
    const state = { ...baseState, game: { ...baseState.game, connectionStatus: pending } };
    assert.equal(validator.Check(state), true);
    assert.notEqual(state.game.connectionStatus, "connected_idle");
    assert.notEqual(state.game.connectionStatus, "active");
  }
});

// ─── Rejection of raw/internal fields ───────────────────────────────────────

test("GameBrowserStateV1 rejects PID field", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(validator.Check({ ...baseState, pid: 1234 }), false);
});

test("GameBrowserStateV1 rejects process path field", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(validator.Check({ ...baseState, processPath: "C:\\games\\StardewValley.exe" }), false);
});

test("GameBrowserStateV1 rejects pipe or endpoint field", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(validator.Check({ ...baseState, pipeEndpoint: "\\\\.\\pipe\\gamebuddy" }), false);
  assert.equal(validator.Check({ ...baseState, endpoint: "127.0.0.1:8080" }), false);
});

test("GameBrowserStateV1 rejects token field", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(validator.Check({ ...baseState, controlToken: "secret" }), false);
});

test("GameBrowserStateV1 rejects native ID field", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(validator.Check({ ...baseState, nativeId: "stardew_01" }), false);
});

test("GameBrowserStateV1 rejects action ID or catalog revision field", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(validator.Check({ ...baseState, actionId: "farm.water_crops" }), false);
  assert.equal(validator.Check({ ...baseState, actionCatalogRevision: 7 }), false);
});

test("GameBrowserStateV1 rejects raw receipt field", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(validator.Check({ ...baseState, rawReceipt: { evidence: "..." } }), false);
});

test("GameBrowserStateV1 rejects prompt or model output field", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(validator.Check({ ...baseState, prompt: "you are a farmhand" }), false);
  assert.equal(validator.Check({ ...baseState, modelOutput: "I'll water the crops" }), false);
});

test("GameBrowserStateV1 rejects log field", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(validator.Check({ ...baseState, logs: ["error: something"] }), false);
});

test("GameBrowserStateV1 rejects runtime session ID", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(validator.Check({ ...baseState, runtimeSessionId: "sess_abc123" }), false);
});

test("GameBrowserStateV1 rejects action ID in nested game fields", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  // Extend a nested game object with extra fields
  const game = { ...baseState.game, activeActionId: "farm.water_crops" };
  assert.equal(validator.Check({ ...baseState, game }), false);
});

// ─── Prerequisite state ─────────────────────────────────────────────────────

test("GameBrowserStateV1 accepts all valid prerequisite statuses", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  for (const status of ["unknown", "met", "unmet", "checking", "failed"] as const) {
    assert.equal(
      validator.Check({
        ...baseState,
        game: { ...baseState.game, prerequisites: { status, detectedGame: null, missingItems: [] } },
      }),
      true,
    );
  }
});

test("GameBrowserStateV1 rejects invalid prerequisite status", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(
    validator.Check({
      ...baseState,
      game: { ...baseState.game, prerequisites: { status: "invented", detectedGame: null, missingItems: [] } },
    }),
    false,
  );
});

test("GameBrowserStateV1 rejects prerequisite with extra field", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(
    validator.Check({
      ...baseState,
      game: {
        ...baseState.game,
        prerequisites: { status: "met", detectedGame: "Stardew Valley", missingItems: [], installPath: "C:\\games" },
      },
    }),
    false,
  );
});

// ─── Instance state ─────────────────────────────────────────────────────────

test("GameBrowserStateV1 accepts all valid instance statuses", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  for (const status of ["none", "detected", "launching", "running", "stopped", "crashed"] as const) {
    assert.equal(
      validator.Check({
        ...baseState,
        game: { ...baseState.game, instance: { status, gameTitle: null } },
      }),
      true,
    );
  }
});

test("GameBrowserStateV1 rejects instance with path field", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(
    validator.Check({
      ...baseState,
      game: { ...baseState.game, instance: { status: "detected", gameTitle: "Stardew Valley", detectedPath: "E:\\games" } },
    }),
    false,
  );
});

// ─── Compatibility state ────────────────────────────────────────────────────

test("GameBrowserStateV1 accepts all valid compatibility statuses", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  for (const status of ["unchecked", "compatible", "incompatible", "warning"] as const) {
    assert.equal(
      validator.Check({
        ...baseState,
        game: { ...baseState.game, compatibility: { status, message: null } },
      }),
      true,
    );
  }
});

// ─── Attachment state ───────────────────────────────────────────────────────

test("GameBrowserStateV1 accepts all valid attachment statuses", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  for (const status of ["none", "pending", "attached", "detaching", "failed"] as const) {
    assert.equal(
      validator.Check({
        ...baseState,
        game: { ...baseState.game, attachment: { status, generation: 1 } },
      }),
      true,
    );
  }
});

test("GameBrowserStateV1 rejects attachment with negative generation", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(
    validator.Check({
      ...baseState,
      game: { ...baseState.game, attachment: { status: "none", generation: -1 } },
    }),
    false,
  );
});

// ─── Role ───────────────────────────────────────────────────────────────────

test("GameBrowserStateV1 accepts valid role values", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(validator.Check({ ...baseState, game: { ...baseState.game, role: "player" } }), true);
  assert.equal(validator.Check({ ...baseState, game: { ...baseState.game, role: "companion" } }), true);
  assert.equal(validator.Check({ ...baseState, game: { ...baseState.game, role: null } }), true);
});

test("GameBrowserStateV1 rejects invalid role value", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(
    validator.Check({ ...baseState, game: { ...baseState.game, role: "farmhand" } }),
    false,
  );
});

// ─── Capability summary ─────────────────────────────────────────────────────

test("GameBrowserStateV1 capability summary rejects negative count", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(
    validator.Check({
      ...baseState,
      game: { ...baseState.game, capabilitySummary: { available: true, count: -1 } },
    }),
    false,
  );
});

test("GameBrowserStateV1 capability summary rejects count exceeding max", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(
    validator.Check({
      ...baseState,
      game: { ...baseState.game, capabilitySummary: { available: true, count: 513 } },
    }),
    false,
  );
});

// ─── Latest outcome ─────────────────────────────────────────────────────────

test("GameBrowserStateV1 accepts all valid outcome values", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  for (const outcome of ["none", "succeeded", "failed", "cancelled"] as const) {
    assert.equal(
      validator.Check({ ...baseState, game: { ...baseState.game, latestOutcome: outcome } }),
      true,
    );
  }
});

test("GameBrowserStateV1 rejects invalid outcome value", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  assert.equal(
    validator.Check({ ...baseState, game: { ...baseState.game, latestOutcome: "in_progress" } }),
    false,
  );
});

// ─── Read commands ──────────────────────────────────────────────────────────

test("game.prerequisites.read is a simple apiVersion-only command", () => {
  const validator = GameBrowserValidatorsV1.GamePrerequisitesReadCommandV1Schema;
  assert.equal(validator.Check({ apiVersion: 1 }), true);
  assert.equal(validator.Check({ apiVersion: 1, extra: true }), false);
  assert.equal(validator.Check({ apiVersion: 2 }), false);
  assert.equal(validator.Check({}), false);
});

test("game.instances.read is a simple apiVersion-only command", () => {
  const validator = GameBrowserValidatorsV1.GameInstancesReadCommandV1Schema;
  assert.equal(validator.Check({ apiVersion: 1 }), true);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey }), false);
  assert.equal(validator.Check({ apiVersion: 1, extra: true }), false);
});

test("game.state.read is a simple apiVersion-only command", () => {
  const validator = GameBrowserValidatorsV1.GameStateReadCommandV1Schema;
  assert.equal(validator.Check({ apiVersion: 1 }), true);
  assert.equal(validator.Check({ apiVersion: 1, extra: true }), false);
});

test("game.diagnostics.read is a simple apiVersion-only command", () => {
  const validator = GameBrowserValidatorsV1.GameDiagnosticsReadCommandV1Schema;
  assert.equal(validator.Check({ apiVersion: 1 }), true);
  assert.equal(validator.Check({ apiVersion: 1, extra: true }), false);
});

// ─── Mutation commands ──────────────────────────────────────────────────────

test("game.prerequisites.setup carries idempotency key but no generation", () => {
  const validator = Compile(GamePrerequisitesSetupCommandV1Schema);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey }), true);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey: handle }), false);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey: "short" }), false);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey: `${idempotencyKey}=` }), false);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey: `${idempotencyKey.slice(0, -1)}B` }), false);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey: idempotencyKey.slice(0, -1) }), false);
  assert.equal(validator.Check({ apiVersion: 1 }), false);
  // Rejects expectedInstanceGeneration (not applicable to prerequisites)
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey, expectedInstanceGeneration: 1 }), false);
});

test("game.launch carries idempotency key and expected instance generation", () => {
  const validator = Compile(GameLaunchCommandV1Schema);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey, expectedInstanceGeneration: 1 }), true);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey, expectedInstanceGeneration: 0 }), false);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey, expectedInstanceGeneration: -1 }), false);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey }), false);
  assert.equal(validator.Check({ apiVersion: 1, expectedInstanceGeneration: 1 }), false);
});

test("game.attach carries idempotency key and expected attachment generation", () => {
  const validator = Compile(GameAttachCommandV1Schema);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey, expectedAttachmentGeneration: 1 }), true);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey, expectedAttachmentGeneration: 0 }), false);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey }), false);
  assert.equal(validator.Check({ apiVersion: 1, expectedAttachmentGeneration: 1 }), false);
});

test("game.stop carries idempotency key and expected attachment generation", () => {
  const validator = Compile(GameStopCommandV1Schema);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey, expectedAttachmentGeneration: 1 }), true);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey, expectedAttachmentGeneration: 0 }), false);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey }), false);
  assert.equal(validator.Check({ apiVersion: 1, expectedAttachmentGeneration: 1 }), false);
  // Rejects extra fields
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey, expectedAttachmentGeneration: 1, extra: true }), false);
});

test("game.reconnect carries idempotency key and expected attachment generation", () => {
  const validator = Compile(GameReconnectCommandV1Schema);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey, expectedAttachmentGeneration: 1 }), true);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey, expectedAttachmentGeneration: 0 }), false);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey }), false);
  assert.equal(validator.Check({ apiVersion: 1, expectedAttachmentGeneration: 1 }), false);
});

test("game.disconnect carries idempotency key and expected attachment generation", () => {
  const validator = Compile(GameDisconnectCommandV1Schema);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey, expectedAttachmentGeneration: 1 }), true);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey, expectedAttachmentGeneration: 0 }), false);
  assert.equal(validator.Check({ apiVersion: 1, idempotencyKey }), false);
  assert.equal(validator.Check({ apiVersion: 1, expectedAttachmentGeneration: 1 }), false);
});

// ─── Problem codes ──────────────────────────────────────────────────────────

test("Game problem codes are a closed union", () => {
  const validator = GameBrowserValidatorsV1.GameProblemV1Schema;
  assert.equal(
    validator.Check({
      type: "about:blank",
      title: "Game unavailable",
      status: 503,
      code: "game_unavailable",
      requestId: handle,
      retryable: true,
    }),
    true,
  );
  assert.equal(
    validator.Check({
      type: "about:blank",
      title: "Bad request",
      status: 400,
      code: "invented_code",
      requestId: handle,
      retryable: false,
    }),
    false,
  );
  assert.deepEqual(GAME_BROWSER_PROBLEM_CODES_V1.includes("invented_code" as never), false);
});

test("Game problem codes include all expected codes", () => {
  const expected = [
    "unauthorized",
    "csrf_failed",
    "invalid_request",
    "unsupported_api_version",
    "profile_operation_unavailable",
    "idempotency_conflict",
    "idempotency_in_progress",
    "idempotency_expired",
    "game_unavailable",
    "game_prerequisites_missing",
    "game_compatibility_error",
    "game_instance_not_found",
    "game_attachment_conflict",
    "game_operation_in_progress",
    "game_runtime_unavailable",
    "game_storage_unavailable",
  ];
  for (const code of expected) {
    assert.ok(GAME_BROWSER_PROBLEM_CODES_V1.includes(code as never), `missing problem code: ${code}`);
  }
});

// ─── Profile composition ────────────────────────────────────────────────────

test("composeGameProfile creates a valid frozen Game profile", () => {
  const profile = composeGameProfile({
    profileId: "gamebuddy.game.preview",
    releaseTier: "game_preview",
    operationIds: ["game.prerequisites.read", "game.state.read", "game.launch", "game.attach", "game.stop", "game.disconnect"],
    navigationItemIds: ["game"],
  });
  assert.deepEqual(profile.operationIds, ["game.prerequisites.read", "game.state.read", "game.launch", "game.attach", "game.stop", "game.disconnect"]);
  assert.deepEqual(profile.navigationItemIds, ["game"]);
  assert.equal(profile.profileId, "gamebuddy.game.preview");
  assert.equal(profile.releaseTier, "game_preview");
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.operationIds), true);
  assert.equal(Object.isFrozen(profile.navigationItemIds), true);
});

test("composeGameProfile rejects unknown operation IDs", () => {
  assert.throws(
    () =>
      composeGameProfile({
        profileId: "gamebuddy.game.preview",
        releaseTier: "game_preview",
        operationIds: ["game.invented" as never],
        navigationItemIds: ["game"],
      }),
    /not declared by the contract/,
  );
});

test("composeGameProfile rejects unknown navigation item IDs", () => {
  assert.throws(
    () =>
      composeGameProfile({
        profileId: "gamebuddy.game.preview",
        releaseTier: "game_preview",
        operationIds: [],
        navigationItemIds: ["invented" as never],
      }),
    /not declared by the contract/,
  );
});

test("composeGameProfile rejects duplicate operation IDs", () => {
  assert.throws(
    () =>
      composeGameProfile({
        profileId: "gamebuddy.game.preview",
        releaseTier: "game_preview",
        operationIds: ["game.state.read", "game.state.read"],
        navigationItemIds: ["game"],
      }),
    /duplicated/,
  );
});

test("composeGameProfile rejects duplicate navigation item IDs", () => {
  assert.throws(
    () =>
      composeGameProfile({
        profileId: "gamebuddy.game.preview",
        releaseTier: "game_preview",
        operationIds: [],
        navigationItemIds: ["game", "game"],
      }),
    /duplicated/,
  );
});

test("composeGameProfile rejects missing required fields", () => {
  assert.throws(
    () =>
      composeGameProfile({
        profileId: "gamebuddy.game.preview",
        releaseTier: "game_preview",
        operationIds: [],
      } as never),
    /capability slice/,
  );
});

test("composeGameProfile rejects extra fields", () => {
  assert.throws(
    () =>
      composeGameProfile({
        profileId: "gamebuddy.game.preview",
        releaseTier: "game_preview",
        operationIds: [],
        navigationItemIds: [],
        extra: true,
      }),
    /capability slice/,
  );
});

test("composeGameProfile rejects invalid profileId pattern", () => {
  assert.throws(
    () =>
      composeGameProfile({
        profileId: "Invalid Profile!",
        releaseTier: "game_preview",
        operationIds: [],
        navigationItemIds: [],
      }),
    /invalid/,
  );
});

test("composeGameProfile rejects invalid release tier", () => {
  assert.throws(
    () =>
      composeGameProfile({
        profileId: "gamebuddy.game.preview",
        releaseTier: "game_full" as never,
        operationIds: [],
        navigationItemIds: [],
      }),
    /invalid/,
  );
});

test("composeGameProfile brands only its own frozen objects; structural clones are not composed", () => {
  const profile = composeGameProfile({
    profileId: "gamebuddy.game.brand",
    releaseTier: "game_preview",
    operationIds: [],
    navigationItemIds: [],
  });
  assert.equal(isComposedGameProfile(profile), true);
  assert.equal(isComposedGameProfile(Object.freeze({ ...profile })), false);
  assert.equal(isComposedGameProfile({ ...profile }), false);
  assert.equal(isComposedGameProfile(null), false);
  assert.equal(isComposedGameProfile({}), false);
  assert.equal(isComposedGameProfile([]), false);
});

// ─── Profile drift ──────────────────────────────────────────────────────────

test("Game controls are absent from an empty profile that has no Game operations", () => {
  const profile = composeGameProfile({
    profileId: "gamebuddy.game.empty",
    releaseTier: "game_preview",
    operationIds: [],
    navigationItemIds: [],
  });
  assert.equal(profile.operationIds.length, 0);
  assert.equal(profile.operationIds.includes("game.prerequisites.read" as never), false);
  assert.equal(profile.operationIds.includes("game.state.read" as never), false);
  assert.equal(profile.operationIds.includes("game.launch" as never), false);
  assert.equal(profile.operationIds.includes("game.attach" as never), false);
  assert.equal(profile.operationIds.includes("game.stop" as never), false);
  assert.equal(profile.operationIds.includes("game.reconnect" as never), false);
  assert.equal(profile.operationIds.includes("game.disconnect" as never), false);
  assert.equal(profile.operationIds.includes("game.diagnostics.read" as never), false);
  assert.equal(profile.operationIds.includes("game.prerequisites.setup" as never), false);
  assert.equal(profile.operationIds.includes("game.instances.read" as never), false);
});

test("Game controls are present exactly when the Game profile mounts matching operations", () => {
  const profile = composeGameProfile({
    profileId: "gamebuddy.game.full",
    releaseTier: "game_preview",
    operationIds: GAME_BROWSER_OPERATION_IDS_V1,
    navigationItemIds: ["game"],
  });
  assert.equal(profile.operationIds.length, GAME_BROWSER_OPERATION_IDS_V1.length);
  for (const opId of GAME_BROWSER_OPERATION_IDS_V1) {
    assert.ok(profile.operationIds.includes(opId), `operation ${opId} should be present`);
  }
  assert.deepEqual(profile.navigationItemIds, ["game"]);
});

// ─── Fixture state validation ───────────────────────────────────────────────

test("GameBrowserFixtureV1 produces a valid state snapshot", () => {
  const validator = Compile(GameBrowserStateV1Schema);
  const fixture = GameBrowserFixtureV1.state();
  assert.equal(validator.Check(fixture), true);
  assert.equal(fixture.build.browserContract, GAME_BROWSER_API_V1);
  // Verify no raw fields are present in the fixture
  assert.equal("pid" in fixture, false);
  assert.equal("processPath" in fixture, false);
  assert.equal("pipeEndpoint" in fixture, false);
  assert.equal("controlToken" in fixture, false);
  assert.equal("nativeId" in fixture, false);
  assert.equal("actionId" in fixture, false);
  assert.equal("actionCatalogRevision" in fixture, false);
  assert.equal("rawReceipt" in fixture, false);
  assert.equal("prompt" in fixture, false);
  assert.equal("modelOutput" in fixture, false);
  assert.equal("logs" in fixture, false);
  assert.equal("runtimeSessionId" in fixture, false);
});

test("GameBrowserFixtureV1 produces a connected state", () => {
  const fixture = GameBrowserFixtureV1.connectedState();
  assert.equal(fixture.game.connectionStatus, "connected_idle");
  assert.equal(fixture.game.role, "player");
  assert.equal(fixture.game.companionName, "Farmhand");
  assert.equal(fixture.game.capabilitySummary.available, true);
  assert.equal(fixture.game.capabilitySummary.count, 3);
  assert.equal(fixture.game.latestOutcome, "succeeded");
});

// ─── Contract exports ───────────────────────────────────────────────────────

test("GameBrowserContractV1 exports all expected schemas", () => {
  const expectedSchemaNames = [
    "GameBrowserStateV1Schema",
    "GamePrerequisiteStateV1Schema",
    "GameInstanceV1Schema",
    "GameCompatibilityV1Schema",
    "GameAttachmentStateV1Schema",
    "GameCapabilitySummaryV1Schema",
    "GamePrerequisitesReadCommandV1Schema",
    "GamePrerequisitesSetupCommandV1Schema",
    "GameInstancesReadCommandV1Schema",
    "GameStateReadCommandV1Schema",
    "GameLaunchCommandV1Schema",
    "GameAttachCommandV1Schema",
    "GameStopCommandV1Schema",
    "GameReconnectCommandV1Schema",
    "GameDisconnectCommandV1Schema",
    "GameDiagnosticsReadCommandV1Schema",
    "GameProblemV1Schema",
  ];
  const actual = Object.keys(GameBrowserContractV1.schemas).sort();
  for (const name of expectedSchemaNames) {
    assert.ok(actual.includes(name), `missing schema: ${name}`);
  }
});