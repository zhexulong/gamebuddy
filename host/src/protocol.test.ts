import assert from "node:assert/strict";
import test from "node:test";

import {
  diagnoseBridgeMessage,
  MAX_MESSAGE_BYTES,
  newEnvelope,
  type Scope,
  type Snapshot,
  serializeBounded,
  validateBridgeMessage,
  validateEnvelope,
  validateExecutionRequest,
} from "./protocol.js";

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};
const snapshot: Snapshot = {
  revision: 4,
  location: "Farm",
  tile: { x: 10, y: 11 },
  stamina: 270,
  health: 100,
  actionable: true,
  capabilities: ["move_to_tile"],
  catalogRevision: 1,
  enabledActionIds: ["move_to_tile"],
  presentationLocale: "en-US",
  activeExecution: null,
};
const now = 1_700_000_000_000;

test("current Mod hello acknowledgement wire projection is admitted", () => {
  const valid = newEnvelope(
    "hello_ack",
    scope,
    { sessionId: "session_01", capabilities: ["move_to_tile"], catalogRevision: 1, enabledActionIds: ["move_to_tile"], runtimeRole: "farmhand_client", launchGeneration: "generation_01", presentationLocale: "en-US", registrations: [{"actionId":"move_to_tile","familyId":"movement_navigation","identityVersion":1,"lifecycle":"published","kind":"execution"}] },
    "hello_01",
    now,
  );
  assert.equal(validateBridgeMessage(valid, scope, now), null);
  assert.equal(
    validateBridgeMessage(
      { ...valid, payload: { ...valid.payload, launchGeneration: null } },
      scope,
      now,
    ),
    "invalid_hello_ack",
  );
  assert.equal(
    validateBridgeMessage(
      newEnvelope(
        "hello_ack",
        scope,
        { sessionId: "invalid session", capabilities: [], catalogRevision: 1, enabledActionIds: [], runtimeRole: "farmhand_client", launchGeneration: "generation_01", presentationLocale: "en-US", registrations: [{"actionId":"move_to_tile","familyId":"movement_navigation","identityVersion":1,"lifecycle":"published","kind":"execution"}] },
        "hello_02",
        now,
      ),
      scope,
      now,
    ),
    "invalid_hello_ack",
  );
  assert.equal(
    validateBridgeMessage(
      newEnvelope(
        "hello_ack",
        scope,
        { sessionId: "session_01", capabilities: [1], catalogRevision: 1, enabledActionIds: [], runtimeRole: "farmhand_client", launchGeneration: "generation_01", presentationLocale: "en-US", registrations: [{"actionId":"move_to_tile","familyId":"movement_navigation","identityVersion":1,"lifecycle":"published","kind":"execution"}] },
        "hello_03",
        now,
      ),
      scope,
      now,
    ),
    "invalid_hello_ack",
  );
});

test("catalog updates are exact and bounded", () => {
  const valid = newEnvelope(
    "catalog_update",
    scope,
    { catalogRevision: 2, enabledActionIds: ["move_to_tile"] },
    "catalog_01",
    now,
  );
  assert.equal(validateBridgeMessage(valid, scope, now), null);
  assert.equal(
    validateBridgeMessage({ ...valid, payload: { ...valid.payload, extra: true } }, scope, now),
    "invalid_catalog_update",
  );
});

test("hello acknowledgement and snapshot reject missing or invalid presentation locales", () => {
  const validHello = newEnvelope(
    "hello_ack",
    scope,
    { sessionId: "session_01", capabilities: ["move_to_tile"], catalogRevision: 1, enabledActionIds: ["move_to_tile"], runtimeRole: "farmhand_client", launchGeneration: "generation_01", presentationLocale: "en-US", registrations: [{"actionId":"move_to_tile","familyId":"movement_navigation","identityVersion":1,"lifecycle":"published","kind":"execution"}] },
    "hello_locale_01",
    now,
  );
  const { presentationLocale: _helloLocale, ...helloWithoutLocale } = validHello.payload;
  assert.equal(validateBridgeMessage({ ...validHello, payload: helloWithoutLocale }, scope, now), "invalid_hello_ack");
  assert.equal(
    validateBridgeMessage({ ...validHello, payload: { ...validHello.payload, presentationLocale: "" } }, scope, now),
    "invalid_hello_ack",
  );
  assert.equal(
    validateBridgeMessage({ ...validHello, payload: { ...validHello.payload, presentationLocale: 1 } }, scope, now),
    "invalid_hello_ack",
  );

  const validSnapshot = newEnvelope("snapshot", scope, snapshot, "snapshot_locale_01", now);
  const { presentationLocale: _snapshotLocale, ...snapshotWithoutLocale } = validSnapshot.payload;
  assert.equal(
    validateBridgeMessage({ ...validSnapshot, payload: snapshotWithoutLocale }, scope, now),
    "invalid_snapshot",
  );
  assert.equal(
    validateBridgeMessage(
      { ...validSnapshot, payload: { ...validSnapshot.payload, presentationLocale: "not a locale" } },
      scope,
      now,
    ),
    "invalid_snapshot",
  );
  assert.equal(
    validateBridgeMessage(
      { ...validSnapshot, payload: { ...validSnapshot.payload, presentationLocale: null } },
      scope,
      now,
    ),
    "invalid_snapshot",
  );
  assert.equal(
    diagnoseBridgeMessage({ ...validSnapshot, payload: snapshotWithoutLocale }, scope, now),
    "invalid_snapshot:presentationLocale",
  );
});

test("execution envelope accepts published bait_crab_pot", () => {
  const request = newEnvelope(
    "execution_request",
    scope,
    {
      requestId: "request_bait_01",
      idempotencyKey: "idempotency_bait_01",
      action: "bait_crab_pot",
      args: { slot: 1, x: 4, y: 8, expectedQualifiedItemId: "(O)685", expectedTargetId: "bait_target_01" },
      expectedRevision: 4,
      deadlineMs: now + 10_000,
    },
    "execution_bait_01",
    now,
  );
  assert.equal(validateBridgeMessage(request, scope, now), null);
});

test("protocol envelope rejects mismatched identity, version, stale timestamps, and unknown types", () => {
  const valid = newEnvelope("observe_request", scope, {}, "correlation_01", now);
  assert.equal(validateEnvelope(valid, scope, now), null);
  assert.equal(validateEnvelope({ ...valid, protocolVersion: 2 }, scope, now), "unsupported_protocol_version");
  assert.equal(
    validateEnvelope({ ...valid, scope: { ...scope, saveId: "other_save" } }, scope, now),
    "scope_mismatch:saveId",
  );
  assert.equal(validateEnvelope({ ...valid, timestampMs: now - 300_001 }, scope, now), "stale_or_invalid_timestamp");
  assert.equal(validateEnvelope({ ...valid, type: "teleport" }, scope, now), "unknown_message_type");
  assert.equal(validateBridgeMessage(valid, scope, now), null);
  assert.equal(validateBridgeMessage({ ...valid, payload: { extra: true } }, scope, now), "invalid_observe_request");
});

test("player-control receipts accept only the fixed acknowledged payload", () => {
  const receipt = newEnvelope(
    "player_control_receipt",
    scope,
    { controlId: "control_01", sourceEventId: "source_01", status: "accepted" },
    "control_01",
    now,
  );
  assert.equal(validateBridgeMessage(receipt, scope, now), null);
  assert.equal(
    validateBridgeMessage({ ...receipt, payload: { ...receipt.payload, status: "rejected" } }, scope, now),
    "invalid_player_control_receipt",
  );
  assert.equal(
    validateBridgeMessage({ ...receipt, payload: { controlId: "control_01", sourceEventId: "source_01" } }, scope, now),
    "invalid_player_control_receipt",
  );
});

test("bridge message payloads fail closed", () => {
  const hello = newEnvelope("hello", scope, { token: "a".repeat(16) }, "hello_01", now);
  assert.equal(validateBridgeMessage(hello, scope, now), null);
  assert.equal(validateBridgeMessage({ ...hello, payload: { token: "short" } }, scope, now), "invalid_hello_token");
  const snapshotWithPresentationLocale = newEnvelope(
    "snapshot",
    scope,
    { ...snapshot, presentationLocale: "en-US" },
    "snapshot_locale_01",
    now,
  );
  assert.equal(validateBridgeMessage(snapshotWithPresentationLocale, scope, now), null);
  const receipt = newEnvelope(
    "execution_receipt",
    scope,
    {
      executionId: "execution_01",
      requestId: "request_01",
      state: "succeeded",
      reasonCode: "target_reached",
      revision: 5,
      evidence: { tile: "11,12" },
    },
    "receipt_01",
    now,
  );
  assert.equal(validateBridgeMessage(receipt, scope, now), null);
  assert.equal(
    validateBridgeMessage({ ...receipt, payload: { ...receipt.payload, state: "made_up" } }, scope, now),
    "invalid_receipt",
  );
  const cancellationReceiptWithoutEvidence = newEnvelope(
    "execution_receipt",
    scope,
    {
      executionId: "execution_02",
      requestId: "request_02",
      state: "cancelled",
      reasonCode: "player_stop",
      revision: 6,
      evidence: null,
    },
    "receipt_02",
    now,
  );
  assert.equal(validateBridgeMessage(cancellationReceiptWithoutEvidence, scope, now), null);
  const cancellationReceiptWithOmittedEvidence = newEnvelope(
    "execution_receipt",
    scope,
    {
      executionId: "execution_03",
      requestId: "request_03",
      state: "cancelled",
      reasonCode: "player_stop",
      revision: 7,
    },
    "receipt_03",
    now,
  );
  assert.equal(validateBridgeMessage(cancellationReceiptWithOmittedEvidence, scope, now), "invalid_receipt");
  const validBodyTrace = newEnvelope(
    "semantic_event",
    scope,
    {
      kind: "execution_settled_succeeded",
      revision: 8,
      activeExecution: null,
      reasonCode: "body_trace",
      bodyTrace: {
        category: "execution_settled_succeeded",
        executionId: "execution_04",
        requestId: "request_04",
        tick: 12,
        revision: 8,
        location: "Farm",
        tile: { x: 10, y: 12 },
      },
    },
    "semantic_trace_01",
    now,
  );
  assert.equal(validateBridgeMessage(validBodyTrace, scope, now), null);
  const validPlayerInput = newEnvelope(
    "semantic_event",
    scope,
    {
      kind: "player_input",
      revision: 8,
      activeExecution: null,
      reasonCode: "player_control",
      playerControl: {
        kind: "player_input",
        controlId: "control_01",
        sourceEventId: "source_01",
        text: "Go mine.",
        locale: "en-US",
        issuerPlayerId: "host_01",
      },
    },
    "semantic_player_input_01",
    now,
  );
  assert.equal(validateBridgeMessage(validPlayerInput, scope, now), null);
  assert.equal(
    validateBridgeMessage(
      {
        ...validPlayerInput,
        payload: {
          ...validPlayerInput.payload,
          playerControl: { ...validPlayerInput.payload.playerControl, issuerPlayerId: "" },
        },
      },
      scope,
      now,
    ),
    "invalid_semantic_event",
  );
  assert.equal(
    validateBridgeMessage(
      {
        ...validPlayerInput,
        payload: {
          ...validPlayerInput.payload,
          playerControl: { ...validPlayerInput.payload.playerControl, text: "/stop" },
        },
      },
      scope,
      now,
    ),
    null,
  );
  const validStop = newEnvelope(
    "semantic_event",
    scope,
    {
      kind: "stop_all",
      revision: 9,
      activeExecution: null,
      reasonCode: "player_control",
      playerControl: {
        kind: "stop_all",
        controlId: "control_02",
        sourceEventId: "source_02",
        locale: "en-US",
        issuerPlayerId: "host_01",
      },
    },
    "semantic_stop_01",
    now,
  );
  assert.equal(validateBridgeMessage(validStop, scope, now), null);
  const validBodySettled = newEnvelope(
    "semantic_event",
    scope,
    {
      kind: "body_settled",
      revision: 10,
      activeExecution: null,
      reasonCode: "stop_body_settled",
      stopObservation: {
        kind: "body_settled",
        stopId: "stop_01",
        sourceEventId: "source_03",
        epoch: 1,
      },
    },
    "semantic_body_settled_01",
    now,
  );
  assert.equal(validateBridgeMessage(validBodySettled, scope, now), null);
  assert.equal(
    validateBridgeMessage(
      { ...validBodySettled, payload: { ...validBodySettled.payload, stopObservation: undefined } },
      scope,
      now,
    ),
    "invalid_semantic_event",
  );
  assert.equal(
    validateBridgeMessage(
      {
        ...validBodySettled,
        payload: {
          ...validBodySettled.payload,
          stopObservation: { ...validBodySettled.payload.stopObservation, epoch: 0 },
        },
      },
      scope,
      now,
    ),
    "invalid_semantic_event",
  );
  assert.equal(
    validateBridgeMessage(
      {
        ...validStop,
        payload: { ...validStop.payload, playerControl: { ...validStop.payload.playerControl, text: "not_allowed" } },
      },
      scope,
      now,
    ),
    "invalid_semantic_event",
  );
  assert.equal(
    validateBridgeMessage(
      {
        ...validBodyTrace,
        payload: {
          ...validBodyTrace.payload,
          bodyTrace: { ...validBodyTrace.payload.bodyTrace, category: "body_idle" },
        },
      },
      scope,
      now,
    ),
    "invalid_semantic_event",
  );
  assert.equal(
    validateBridgeMessage(
      { ...validBodyTrace, payload: { ...validBodyTrace.payload, bodyTrace: undefined } },
      scope,
      now,
    ),
    "invalid_semantic_event",
  );
  const malformedSnapshot = newEnvelope(
    "snapshot",
    scope,
    {
      revision: 1,
      location: "Farm",
      tile: { x: Number.NaN, y: 1 },
      stamina: 1,
      health: 1,
      actionable: true,
      capabilities: [],
      presentationLocale: "en-US",
      activeExecution: null,
    },
    "snapshot_01",
    now,
  );
  assert.equal(validateBridgeMessage(malformedSnapshot, scope, now), "invalid_snapshot");
  const nativeSnapshotWithoutNullableActive = newEnvelope(
    "snapshot",
    scope,
    { ...snapshot, currentTool: "(T)Axe", inventorySlots: 12, activeExecution: undefined },
    "snapshot_native_01",
    now,
  );
  assert.equal(validateBridgeMessage(nativeSnapshotWithoutNullableActive, scope, now), null);
  const badActive = newEnvelope(
    "snapshot",
    scope,
    {
      ...snapshot,
      activeExecution: {
        executionId: "execution_01",
        requestId: "request_01",
        action: "move_to_tile",
        state: "made_up",
        reasonCode: "bad",
        evidence: null,
      },
    },
    "snapshot_02",
    now,
  );
  assert.equal(validateBridgeMessage(badActive, scope, now), "invalid_snapshot");
  assert.equal(
    validateBridgeMessage(
      newEnvelope("error", scope, { reasonCode: "authentication_failed" }, "error_01", now),
      scope,
      now,
    ),
    null,
  );
  const snapshotWithSoilTiles = newEnvelope(
    "snapshot",
    scope,
    {
      ...snapshot,
      doorTargets: [{ sourceX: 10, sourceY: 11, targetLocation: "FarmHouse", targetX: 9, targetY: 9 }],
      soilTiles: [
        { x: 10, y: 12 },
        { x: 11, y: 12 },
      ],
      forageTargets: [{ targetId: "forage_deadbeef", x: 10, y: 12, qualifiedItemId: "(O)399", stack: 1 }],
      itemTargets: [{ targetId: "item_0_0_deadbeef", x: 10, y: 12, qualifiedItemId: "(O)388", stack: 1 }],
      cropTargets: [{ targetId: "crop_deadbeef", x: 10, y: 12, cropId: "24" }],
      harvestTargets: [
        {
          targetId: "harvest_deadbeef",
          x: 10,
          y: 12,
          cropId: "24",
          qualifiedHarvestItemId: "(O)24",
          regrowsAfterHarvest: false,
        },
      ],
      seedTargets: [{ targetId: "seed_deadbeef", slot: 2, x: 10, y: 12, qualifiedItemId: "(O)472" }],
      fertilizerTargets: [{ targetId: "fertilizer_deadbeef", slot: 3, x: 10, y: 12, qualifiedItemId: "(O)368" }],
      debrisTargets: [
        {
          targetId: "debris_deadbeef",
          slot: 4,
          x: 10,
          y: 12,
          parentSheetIndex: 600,
          toolKind: "axe",
          requiredUpgradeLevel: 1,
          health: 10,
        },
      ],
      npcRelationshipTargets: [
        {
          targetId: "npc_deadbeef",
          x: 10,
          y: 12,
          npcName: "Abigail",
          friendshipPoints: 500,
          friendshipStatus: "Friendly",
          talkedToToday: false,
          giftsToday: 0,
          giftsThisWeek: 0,
        },
      ],
      petTargets: [{ targetId: "pet_deadbeef", x: 10, y: 12, petType: "Dog", friendship: 500, pettedToday: false }],
      animalProductTargets: [
        {
          targetId: "animal_product_deadbeef",
          slot: 6,
          x: 10,
          y: 12,
          animalType: "Cow",
          qualifiedProduceItemId: "(O)184",
          toolKind: "milk_pail",
          produceStack: 1,
        },
      ],
      feedTroughTargets: [{ targetId: "feed_trough_deadbeef", slot: 7, x: 10, y: 11, hayStack: 2 }],
      inventoryItemFacts: [{ slot: 8, qualifiedItemId: "(O)184", stack: 1 }],
      foodTargets: [{ slot: 5, qualifiedItemId: "(O)216", stack: 3, edibility: 20, isDrink: false }],
    },
    "snapshot_soil_01",
    now,
  );
  assert.equal(validateBridgeMessage(snapshotWithSoilTiles, scope, now), null);
  assert.equal(
    validateBridgeMessage(
      newEnvelope(
        "snapshot",
        scope,
        {
          ...snapshot,
          warps: Array.from({ length: 513 }, () => ({
            sourceX: 1,
            sourceY: 1,
            targetLocation: "Farm",
            targetX: 1,
            targetY: 1,
          })),
        },
        "snapshot_warps_01",
        now,
      ),
      scope,
      now,
    ),
    "invalid_snapshot",
  );
  assert.equal(
    validateBridgeMessage(
      newEnvelope("snapshot", scope, { ...snapshot, soilTiles: [{ x: -1, y: 12 }] }, "snapshot_soil_02", now),
      scope,
      now,
    ),
    "invalid_snapshot",
  );
  assert.equal(
    validateBridgeMessage(
      newEnvelope(
        "snapshot",
        scope,
        { ...snapshot, forageTargets: [{ targetId: "forage_deadbeef", x: 10, y: 12, qualifiedItemId: "", stack: 1 }] },
        "snapshot_forage_01",
        now,
      ),
      scope,
      now,
    ),
    "invalid_snapshot",
  );
  assert.equal(
    validateBridgeMessage(
      newEnvelope(
        "snapshot",
        scope,
        { ...snapshot, seedTargets: [{ targetId: "seed_deadbeef", slot: 2, x: 10, y: 12, qualifiedItemId: "" }] },
        "snapshot_seed_01",
        now,
      ),
      scope,
      now,
    ),
    "invalid_snapshot",
  );
  assert.equal(
    validateBridgeMessage(
      newEnvelope(
        "snapshot",
        scope,
        {
          ...snapshot,
          debrisTargets: [
            {
              targetId: "debris_deadbeef",
              slot: 4,
              x: 10,
              y: 12,
              parentSheetIndex: 752,
              toolKind: "pickaxe",
              requiredUpgradeLevel: 0,
            },
          ],
        },
        "snapshot_debris_missing_health_01",
        now,
      ),
      scope,
      now,
    ),
    "invalid_snapshot",
  );
  assert.equal(
    validateBridgeMessage(
      newEnvelope(
        "snapshot",
        scope,
        {
          ...snapshot,
          debrisTargets: [
            {
              targetId: "debris_deadbeef",
              slot: 4,
              x: 10,
              y: 12,
              parentSheetIndex: 752,
              toolKind: "pickaxe",
              requiredUpgradeLevel: 0,
              health: 0,
            },
          ],
        },
        "snapshot_debris_invalid_health_01",
        now,
      ),
      scope,
      now,
    ),
    "invalid_snapshot",
  );
  assert.equal(
    validateBridgeMessage(
      newEnvelope(
        "snapshot",
        scope,
        { ...snapshot, inventoryItemFacts: [{ slot: 3, qualifiedItemId: "(O)184", stack: 0 }] },
        "snapshot_inventory_01",
        now,
      ),
      scope,
      now,
    ),
    "invalid_snapshot",
  );
});

test("snapshot target facts reject schema-forbidden extra keys before Host consumers use them", () => {
  const crabPot = {
    targetId: "crab_pot_deadbeef",
    location: "Farm",
    slot: 4,
    x: 10,
    y: 12,
    qualifiedItemId: "(O)710",
  };
  const families: readonly [string, Record<string, unknown>][] = [
    ["toolSlots", { slot: 4, label: "Axe" }],
    ["wateringCanFacts", { slot: 4, qualifiedItemId: "(T)WateringCan", label: "Watering Can", water: 40, max: 40 }],
    ["refillWateringCanTargets", { targetId: "refill_deadbeef", x: 10, y: 12 }],
    ["forageTargets", { targetId: "forage_deadbeef", x: 10, y: 12, qualifiedItemId: "(O)16", stack: 1 }],
    ["itemTargets", { targetId: "item_deadbeef", x: 10, y: 12, qualifiedItemId: "(O)388", stack: 1 }],
    ["cropTargets", { targetId: "crop_deadbeef", x: 10, y: 12, cropId: "24" }],
    [
      "harvestTargets",
      {
        targetId: "harvest_deadbeef",
        x: 10,
        y: 12,
        cropId: "24",
        qualifiedHarvestItemId: "(O)24",
        regrowsAfterHarvest: false,
      },
    ],
    [
      "woodFenceTargets",
      { targetId: "fence_deadbeef", location: "Farm", slot: 4, x: 10, y: 12, qualifiedItemId: "(O)322" },
    ],
    [
      "woodFenceResultTargets",
      {
        targetId: "fence_deadbeef",
        location: "Farm",
        slot: 4,
        x: 10,
        y: 12,
        qualifiedItemId: "(O)322",
        isFence: true,
        isGate: false,
        health: 10,
        maxHealth: 10,
      },
    ],
    ["crabPotTargets", crabPot],
    ["crabPotResultTargets", { ...crabPot, ownerId: 1, offsetX: 0, offsetY: 0, overlayTiles: [] }],
    ["baitCrabPotTargets", { ...crabPot, baitQualifiedItemId: "(O)685", ownerId: "1", baitStack: 1 }],
    ["baitCrabPotResultTargets", { ...crabPot, baitQualifiedItemId: "(O)685", ownerId: "1", baitStack: 1 }],
    ["seedTargets", { targetId: "seed_deadbeef", slot: 2, x: 10, y: 12, qualifiedItemId: "(O)472" }],
    [
      "debrisTargets",
      {
        targetId: "debris_deadbeef",
        slot: 4,
        x: 10,
        y: 12,
        parentSheetIndex: 752,
        toolKind: "pickaxe",
        requiredUpgradeLevel: 0,
        health: 8,
      },
    ],
    [
      "rockSourceTargets",
      { targetId: "rock_deadbeef", location: "Farm", x: 10, y: 12, qualifiedItemId: "(O)2", health: 1 },
    ],
    ["clearHoeDirtTargets", { targetId: "dirt_deadbeef", location: "Farm", x: 10, y: 12, crop: false, ground: true }],
    [
      "artifactSpotTargets",
      { targetId: "artifact_deadbeef", location: "Farm", x: 10, y: 12, qualifiedItemId: "(O)590" },
    ],
    [
      "artifactSpotResultTargets",
      { targetId: "artifact_deadbeef", location: "Farm", x: 10, y: 12, crop: false, ground: true },
    ],
    [
      "machineTargets",
      {
        targetId: "machine_deadbeef",
        x: 10,
        y: 12,
        qualifiedItemId: "(BC)12",
        readyForHarvest: false,
        minutesUntilReady: 10,
      },
    ],
    [
      "treeChopSourceTargets",
      {
        targetId: "tree_deadbeef",
        location: "Farm",
        x: 10,
        y: 12,
        treeType: "Oak",
        growthStage: 5,
        health: 1,
        stump: false,
        moss: false,
        tapped: false,
      },
    ],
    [
      "treeChopResultTargets",
      {
        targetId: "tree_deadbeef",
        location: "Farm",
        x: 10,
        y: 12,
        treeType: "Oak",
        health: 5,
        stump: true,
        moss: false,
        tapped: false,
      },
    ],
    [
      "npcRelationshipTargets",
      {
        targetId: "npc_deadbeef",
        x: 10,
        y: 12,
        npcName: "Abigail",
        friendshipPoints: 0,
        friendshipStatus: "Neutral",
        talkedToToday: false,
        giftsToday: 0,
        giftsThisWeek: 0,
      },
    ],
    ["petTargets", { targetId: "pet_deadbeef", x: 10, y: 12, petType: "Dog", friendship: 1, pettedToday: false }],
    [
      "animalProductTargets",
      {
        targetId: "animal_deadbeef",
        slot: 4,
        x: 10,
        y: 12,
        animalType: "Cow",
        qualifiedProduceItemId: "(O)184",
        toolKind: "milk_pail",
        produceStack: 1,
      },
    ],
    ["feedTroughTargets", { targetId: "trough_deadbeef", slot: 4, x: 10, y: 12, hayStack: 1 }],
    ["inventoryItemFacts", { slot: 4, qualifiedItemId: "(O)184", stack: 1 }],
    ["foodTargets", { slot: 4, qualifiedItemId: "(O)216", stack: 1, edibility: 20, isDrink: false }],
  ];
  for (const [field, target] of families) {
    assert.equal(
      validateBridgeMessage(
        newEnvelope(
          "snapshot",
          scope,
          { ...snapshot, [field]: [{ ...target, unexpected: true }] },
          `snapshot_${field}_extra`,
          now,
        ),
        scope,
        now,
      ),
      "invalid_snapshot",
      field,
    );
  }
});

test("execution validation fails closed for stale, unknown, malformed, and unactionable requests", () => {
  const valid = {
    requestId: "request_01",
    idempotencyKey: "idempotency_01",
    action: "move_to_tile",
    args: { x: 11, y: 12 },
    expectedRevision: 4,
    deadlineMs: now + 10_000,
  };
  assert.equal(validateExecutionRequest(valid, snapshot, now), null);
  assert.equal(
    validateExecutionRequest({ ...valid, args: { ...valid.args, unexpected: true } }, snapshot, now),
    "invalid_args",
  );
  assert.equal(validateExecutionRequest({ ...valid, expectedRevision: 3 }, snapshot, now), "stale_snapshot");
  assert.equal(validateExecutionRequest({ ...valid, action: "sell_item" }, snapshot, now), "unknown_action");
  assert.equal(
    validateExecutionRequest(
      { ...valid, action: "sop_composite_pipeline", args: { pipelinePayload: {} } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "sop_composite_pipeline"] },
      now,
    ),
    "unknown_action",
  );
  const travel = { ...valid, action: "travel", args: { x: 10, y: 10 } };
  assert.equal(
    validateExecutionRequest(travel, { ...snapshot, capabilities: [...snapshot.capabilities, "travel"] }, now),
    null,
  );
  const enterExit = { ...valid, action: "enter_exit", args: { x: 10, y: 11 } };
  assert.equal(
    validateExecutionRequest(enterExit, { ...snapshot, capabilities: [...snapshot.capabilities, "enter_exit"] }, now),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...enterExit, args: { x: -1, y: 11 } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "enter_exit"] },
      now,
    ),
    "invalid_door_target",
  );
  assert.equal(
    validateExecutionRequest(
      { ...travel, args: { x: -1, y: 10 } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "travel"] },
      now,
    ),
    "invalid_warp_source",
  );
  assert.equal(validateExecutionRequest({ ...valid, args: { x: -1, y: 12 } }, snapshot, now), "invalid_target_tile");
  assert.equal(validateExecutionRequest({ ...valid, args: { x: 11.5, y: 12 } }, snapshot, now), "invalid_target_tile");
  assert.equal(validateExecutionRequest(valid, { ...snapshot, actionable: false }, now), "player_not_actionable");
  const equip = { ...valid, action: "equip_tool", args: { slot: 2 } };
  assert.equal(validateExecutionRequest(equip, snapshot, now), "capability_not_declared");
  assert.equal(
    validateExecutionRequest(
      { ...equip, args: { slot: 37 } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "equip_tool"] },
      now,
    ),
    "invalid_tool_slot",
  );
  assert.equal(
    validateExecutionRequest(
      { ...equip },
      { ...snapshot, capabilities: [...snapshot.capabilities, "equip_tool"] },
      now,
    ),
    null,
  );
  const tillSoil = { ...valid, action: "till_soil", args: { x: 10, y: 12 } };
  const waterCrop = { ...valid, action: "water_crop", args: { x: 10, y: 12, expectedTargetId: "crop_deadbeef" } };
  const refillWateringCan = {
    ...valid,
    action: "refill_watering_can",
    args: { slot: 4, x: 10, y: 12, expectedTargetId: "watering_can_refill_deadbeef" },
  };
  const harvestCrop = {
    ...valid,
    action: "harvest_crop",
    args: { x: 10, y: 12, expectedQualifiedItemId: "(O)24", expectedTargetId: "harvest_deadbeef" },
  };
  const pickupForage = {
    ...valid,
    action: "pickup_forage",
    args: { x: 10, y: 12, expectedQualifiedItemId: "(O)399", expectedTargetId: "forage_deadbeef" },
  };
  const pickupItem = {
    ...valid,
    action: "pickup_item",
    args: { x: 10, y: 12, expectedQualifiedItemId: "(O)388", expectedTargetId: "item_0_0_deadbeef" },
  };
  const plantSeed = {
    ...valid,
    action: "plant_seed",
    args: { slot: 2, x: 10, y: 12, expectedQualifiedItemId: "(O)472", expectedTargetId: "seed_deadbeef" },
  };
  assert.equal(
    validateExecutionRequest(plantSeed, { ...snapshot, capabilities: [...snapshot.capabilities, "plant_seed"] }, now),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...plantSeed, args: { ...plantSeed.args, unexpected: true } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "plant_seed"] },
      now,
    ),
    "invalid_args",
  );
  const fertilizeTile = {
    ...valid,
    action: "fertilize_tile",
    args: { slot: 3, x: 10, y: 12, expectedQualifiedItemId: "(O)368", expectedTargetId: "fertilizer_deadbeef" },
  };
  assert.equal(
    validateExecutionRequest(
      { ...fertilizeTile, args: { ...fertilizeTile.args, unexpected: true } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "fertilize_tile"] },
      now,
    ),
    "invalid_args",
  );
  const clearDebris = {
    ...valid,
    action: "clear_debris",
    args: { slot: 4, x: 10, y: 12, expectedTargetId: "debris_deadbeef" },
  };
  const machineInspect = {
    ...valid,
    action: "machine_inspect",
    args: { x: 10, y: 12, expectedTargetId: "machine_deadbeef" },
  };
  const machineLoad = {
    ...valid,
    action: "machine_load",
    args: { slot: 5, x: 10, y: 12, expectedQualifiedItemId: "(O)433", expectedTargetId: "machine_deadbeef" },
  };
  const npcRelationship = {
    ...valid,
    action: "npc_relationship",
    args: { x: 10, y: 12, expectedTargetId: "npc_deadbeef" },
  };
  const petAnimal = { ...valid, action: "pet_animal", args: { x: 10, y: 12, expectedTargetId: "pet_deadbeef" } };
  const collectAnimalProduct = {
    ...valid,
    action: "collect_animal_product",
    args: { slot: 6, x: 10, y: 12, expectedTargetId: "animal_product_deadbeef" },
  };
  const feedAnimal = {
    ...valid,
    action: "feed_animal",
    args: { slot: 7, x: 10, y: 11, expectedTargetId: "feed_trough_deadbeef" },
  };
  const useItem = { ...valid, action: "use_item", args: { slot: 5, expectedQualifiedItemId: "(O)216" } };
  const breakRockSource = {
    ...valid,
    action: "break_rock_source",
    args: { slot: 4, x: 10, y: 12, expectedTargetId: "rock_source_deadbeef" },
  };
  assert.equal(
    validateExecutionRequest(
      breakRockSource,
      { ...snapshot, capabilities: [...snapshot.capabilities, "break_rock_source"] },
      now,
    ),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...breakRockSource, args: { ...breakRockSource.args, unexpected: true } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "break_rock_source"] },
      now,
    ),
    "invalid_args",
  );
  const digArtifactSpot = {
    ...valid,
    action: "dig_artifact_spot",
    args: { slot: 4, x: 10, y: 12, expectedTargetId: "artifact_spot_deadbeef" },
  };
  assert.equal(
    validateExecutionRequest(
      digArtifactSpot,
      { ...snapshot, capabilities: [...snapshot.capabilities, "dig_artifact_spot"] },
      now,
    ),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...digArtifactSpot, args: { ...digArtifactSpot.args, unexpected: true } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "dig_artifact_spot"] },
      now,
    ),
    "invalid_args",
  );
  assert.equal(
    validateExecutionRequest(
      { ...digArtifactSpot, args: { ...digArtifactSpot.args, slot: 37 } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "dig_artifact_spot"] },
      now,
    ),
    "invalid_dig_artifact_spot_target",
  );
  const artifactSnapshot = newEnvelope(
    "snapshot",
    scope,
    {
      ...snapshot,
      artifactSpotTargets: [
        { targetId: "artifact_spot_deadbeef", location: "Farm", x: 10, y: 12, qualifiedItemId: "(O)590" },
      ],
      artifactSpotFarmSourceCount: 1,
    },
    "snapshot_artifact_01",
    now,
  );
  assert.equal(diagnoseBridgeMessage(artifactSnapshot, scope, now), "accepted");
  assert.equal(
    diagnoseBridgeMessage(
      { ...artifactSnapshot, payload: { ...artifactSnapshot.payload, artifactSpotFarmSourceCount: -1 } },
      scope,
      now,
    ),
    "invalid_snapshot:artifactSpotFarmSourceCount",
  );
  assert.equal(
    diagnoseBridgeMessage(
      { ...artifactSnapshot, payload: { ...artifactSnapshot.payload, artifactSpotFarmSourceCount: null } },
      scope,
      now,
    ),
    "accepted",
  );
  assert.equal(
    diagnoseBridgeMessage(
      {
        ...artifactSnapshot,
        payload: {
          ...artifactSnapshot.payload,
          artifactSpotTargets: [
            { targetId: "artifact_spot_deadbeef", location: "Farm", x: 10, y: 12, qualifiedItemId: "(O)388" },
          ],
        },
      },
      scope,
      now,
    ),
    "invalid_snapshot:artifactSpotTargets",
  );
  const artifactResultSnapshot = newEnvelope(
    "snapshot",
    scope,
    {
      ...snapshot,
      artifactSpotResultTargets: [
        { targetId: "artifact_result_deadbeef", location: "Farm", x: 10, y: 12, crop: false, ground: true },
      ],
    },
    "snapshot_artifact_result_01",
    now,
  );
  assert.equal(diagnoseBridgeMessage(artifactResultSnapshot, scope, now), "accepted");
  const artifactResultTarget = {
    targetId: "artifact_result_deadbeef",
    location: "Farm",
    x: 10,
    y: 12,
    crop: false,
    ground: true,
  };
  for (const invalid of [
    { ...artifactResultTarget, crop: true },
    { ...artifactResultTarget, ground: false },
    { ...artifactResultTarget, unexpected: true },
    { ...artifactResultTarget, targetId: "not opaque" },
    (({ targetId: _targetId, ...withoutTargetId }) => withoutTargetId)(artifactResultTarget),
  ])
    assert.equal(
      diagnoseBridgeMessage(
        {
          ...artifactResultSnapshot,
          payload: { ...artifactResultSnapshot.payload, artifactSpotResultTargets: [invalid] },
        },
        scope,
        now,
      ),
      "invalid_snapshot:artifactSpotResultTargets",
    );
  const clearHoeDirt = {
    ...valid,
    action: "clear_hoedirt",
    args: { slot: 4, x: 10, y: 12, expectedTargetId: "hoedirt_deadbeef" },
  };
  assert.equal(
    validateExecutionRequest(
      clearHoeDirt,
      { ...snapshot, capabilities: [...snapshot.capabilities, "clear_hoedirt"] },
      now,
    ),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...clearHoeDirt, args: { ...clearHoeDirt.args, unexpected: true } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "clear_hoedirt"] },
      now,
    ),
    "invalid_args",
  );
  assert.equal(
    validateExecutionRequest(
      { ...clearHoeDirt, args: { ...clearHoeDirt.args, slot: 37 } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "clear_hoedirt"] },
      now,
    ),
    "invalid_clear_hoedirt_target",
  );
  const clearHoeDirtSnapshot = newEnvelope(
    "snapshot",
    scope,
    {
      ...snapshot,
      clearHoeDirtTargets: [{ targetId: "hoedirt_01", location: "Farm", x: 10, y: 12, crop: false, ground: true }],
    },
    "snapshot_hoedirt_01",
    now,
  );
  assert.equal(diagnoseBridgeMessage(clearHoeDirtSnapshot, scope, now), "accepted");
  assert.equal(
    diagnoseBridgeMessage(
      {
        ...clearHoeDirtSnapshot,
        payload: {
          ...clearHoeDirtSnapshot.payload,
          clearHoeDirtTargets: [
            { targetId: "hoedirt_01", location: "Farm", x: 10, y: 12, crop: false, ground: true, unexpected: true },
          ],
        },
      },
      scope,
      now,
    ),
    "invalid_snapshot:clearHoeDirtTargets",
  );
  assert.equal(
    diagnoseBridgeMessage(
      {
        ...clearHoeDirtSnapshot,
        payload: {
          ...clearHoeDirtSnapshot.payload,
          clearHoeDirtTargets: [{ targetId: "hoedirt_01", location: "Farm", x: 10, y: 12, crop: true, ground: true }],
        },
      },
      scope,
      now,
    ),
    "invalid_snapshot:clearHoeDirtTargets",
  );
  const treeFirstHit = {
    ...valid,
    action: "tree_first_hit",
    args: { slot: 4, x: 10, y: 12, expectedTargetId: "tree_deadbeef" },
  };
  const chopTreeSource = {
    ...valid,
    action: "chop_tree_source",
    args: { slot: 4, x: 10, y: 12, expectedTargetId: "tree_chop_deadbeef" },
  };
  assert.equal(
    validateExecutionRequest(
      chopTreeSource,
      { ...snapshot, capabilities: [...snapshot.capabilities, "chop_tree_source"] },
      now,
    ),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...chopTreeSource, args: { ...chopTreeSource.args, unexpected: true } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "chop_tree_source"] },
      now,
    ),
    "invalid_args",
  );
  assert.equal(
    validateExecutionRequest(
      { ...chopTreeSource, args: { ...chopTreeSource.args, slot: 37 } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "chop_tree_source"] },
      now,
    ),
    "invalid_chop_tree_source_target",
  );
  assert.equal(
    validateExecutionRequest(
      treeFirstHit,
      { ...snapshot, capabilities: [...snapshot.capabilities, "tree_first_hit"] },
      now,
    ),
    "unknown_action",
  );
  assert.equal(
    validateExecutionRequest(
      fertilizeTile,
      { ...snapshot, capabilities: [...snapshot.capabilities, "fertilize_tile"] },
      now,
    ),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...fertilizeTile, args: { ...fertilizeTile.args, expectedTargetId: "bad target" } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "fertilize_tile"] },
      now,
    ),
    "invalid_fertilizer_target",
  );
  assert.equal(
    validateExecutionRequest(
      { ...plantSeed, args: { ...plantSeed.args, expectedTargetId: "bad target" } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "plant_seed"] },
      now,
    ),
    "invalid_seed_target",
  );
  assert.equal(
    validateExecutionRequest(
      { ...plantSeed, args: { ...plantSeed.args, slot: 37 } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "plant_seed"] },
      now,
    ),
    "invalid_seed_target",
  );
  assert.equal(
    validateExecutionRequest(
      { ...fertilizeTile, args: { ...fertilizeTile.args, expectedQualifiedItemId: "" } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "fertilize_tile"] },
      now,
    ),
    "invalid_fertilizer_target",
  );
  assert.equal(
    validateExecutionRequest(
      clearDebris,
      { ...snapshot, capabilities: [...snapshot.capabilities, "clear_debris"] },
      now,
    ),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...clearDebris, args: { ...clearDebris.args, expectedTargetId: "bad target" } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "clear_debris"] },
      now,
    ),
    "invalid_debris_target",
  );
  assert.equal(
    validateExecutionRequest(
      machineInspect,
      { ...snapshot, capabilities: [...snapshot.capabilities, "machine_inspect"] },
      now,
    ),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...machineInspect, args: { ...machineInspect.args, expectedTargetId: "bad target" } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "machine_inspect"] },
      now,
    ),
    "invalid_machine_target",
  );
  assert.equal(
    validateExecutionRequest(
      machineLoad,
      { ...snapshot, capabilities: [...snapshot.capabilities, "machine_load"] },
      now,
    ),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...machineLoad, args: { ...machineLoad.args, expectedQualifiedItemId: "(O)472" } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "machine_load"] },
      now,
    ),
    "invalid_machine_load_target",
  );
  assert.equal(
    validateExecutionRequest(
      { ...machineLoad, args: { ...machineLoad.args, unexpected: true } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "machine_load"] },
      now,
    ),
    "invalid_args",
  );
  assert.equal(
    validateExecutionRequest(
      { ...valid, action: "collect_resource", args: { slot: 4, x: 10, y: 12, expectedTargetId: "resource_deadbeef" } },
      snapshot,
      now,
    ),
    "unknown_action",
  );
  assert.equal(
    validateExecutionRequest(
      npcRelationship,
      { ...snapshot, capabilities: [...snapshot.capabilities, "npc_relationship"] },
      now,
    ),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...npcRelationship, args: { ...npcRelationship.args, expectedTargetId: "bad target" } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "npc_relationship"] },
      now,
    ),
    "invalid_npc_relationship_target",
  );
  assert.equal(
    validateExecutionRequest(petAnimal, { ...snapshot, capabilities: [...snapshot.capabilities, "pet_animal"] }, now),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...petAnimal, args: { ...petAnimal.args, expectedTargetId: "bad target" } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "pet_animal"] },
      now,
    ),
    "invalid_pet_target",
  );
  assert.equal(
    validateExecutionRequest(
      collectAnimalProduct,
      { ...snapshot, capabilities: [...snapshot.capabilities, "collect_animal_product"] },
      now,
    ),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...collectAnimalProduct, args: { ...collectAnimalProduct.args, slot: 37 } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "collect_animal_product"] },
      now,
    ),
    "invalid_animal_product_target",
  );
  assert.equal(
    validateExecutionRequest(
      { ...collectAnimalProduct, args: { ...collectAnimalProduct.args, expectedTargetId: "bad target" } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "collect_animal_product"] },
      now,
    ),
    "invalid_animal_product_target",
  );
  assert.equal(
    validateExecutionRequest(feedAnimal, { ...snapshot, capabilities: [...snapshot.capabilities, "feed_animal"] }, now),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...feedAnimal, args: { ...feedAnimal.args, slot: 37 } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "feed_animal"] },
      now,
    ),
    "invalid_feed_trough_target",
  );
  assert.equal(
    validateExecutionRequest(
      { ...feedAnimal, args: { ...feedAnimal.args, expectedTargetId: "bad target" } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "feed_animal"] },
      now,
    ),
    "invalid_feed_trough_target",
  );
  assert.equal(
    validateExecutionRequest(useItem, { ...snapshot, capabilities: [...snapshot.capabilities, "use_item"] }, now),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...useItem, args: { ...useItem.args, slot: 37 } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "use_item"] },
      now,
    ),
    "invalid_item_use_target",
  );
  assert.equal(
    validateExecutionRequest(
      { ...useItem, args: { ...useItem.args, expectedQualifiedItemId: "" } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "use_item"] },
      now,
    ),
    "invalid_item_use_target",
  );
  assert.equal(
    validateExecutionRequest(pickupItem, { ...snapshot, capabilities: [...snapshot.capabilities, "pickup_item"] }, now),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...pickupItem, args: { x: 10, y: 12, expectedQualifiedItemId: "(O)388" } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "pickup_item"] },
      now,
    ),
    "invalid_args",
  );
  assert.equal(
    validateExecutionRequest(
      pickupForage,
      { ...snapshot, capabilities: [...snapshot.capabilities, "pickup_forage"] },
      now,
    ),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...pickupForage, args: { x: 10, y: 12 } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "pickup_forage"] },
      now,
    ),
    "invalid_args",
  );
  assert.equal(
    validateExecutionRequest(tillSoil, { ...snapshot, capabilities: [...snapshot.capabilities, "till_soil"] }, now),
    null,
  );
  const treeChopSnapshot = newEnvelope(
    "snapshot",
    scope,
    {
      ...snapshot,
      treeChopSourceTargets: [
        {
          targetId: "tree_chop_01",
          location: "Farm",
          x: 10,
          y: 12,
          treeType: "Oak",
          growthStage: 5,
          health: 1,
          stump: false,
          moss: false,
          tapped: false,
        },
      ],
    },
    "snapshot_tree_chop_01",
    now,
  );
  assert.equal(diagnoseBridgeMessage(treeChopSnapshot, scope, now), "accepted");
  assert.equal(
    diagnoseBridgeMessage(
      {
        ...treeChopSnapshot,
        payload: {
          ...treeChopSnapshot.payload,
          treeChopSourceTargets: [
            {
              targetId: "tree_chop_01",
              location: "Farm",
              x: 10,
              y: 12,
              treeType: "Oak",
              growthStage: 5,
              health: 2,
              stump: false,
              moss: false,
              tapped: false,
            },
          ],
        },
      },
      scope,
      now,
    ),
    "invalid_snapshot:treeChopSourceTargets",
  );
  const treeChopResultSnapshot = newEnvelope(
    "snapshot",
    scope,
    {
      ...snapshot,
      treeChopResultTargets: [
        {
          targetId: "tree_chop_result_01",
          location: "Farm",
          x: 10,
          y: 12,
          treeType: "Oak",
          health: 5,
          stump: true,
          moss: false,
          tapped: false,
        },
      ],
    },
    "snapshot_tree_chop_result_01",
    now,
  );
  assert.equal(diagnoseBridgeMessage(treeChopResultSnapshot, scope, now), "accepted");
  assert.equal(
    diagnoseBridgeMessage(
      {
        ...treeChopResultSnapshot,
        payload: {
          ...treeChopResultSnapshot.payload,
          treeChopResultTargets: [
            {
              targetId: "tree_chop_result_01",
              location: "Farm",
              x: 10,
              y: 12,
              treeType: "Oak",
              health: 4,
              stump: true,
              moss: false,
              tapped: false,
            },
          ],
        },
      },
      scope,
      now,
    ),
    "invalid_snapshot:treeChopResultTargets",
  );
  assert.equal(
    diagnoseBridgeMessage(
      {
        ...treeChopResultSnapshot,
        payload: {
          ...treeChopResultSnapshot.payload,
          treeChopResultTargets: [
            {
              targetId: "tree_chop_result_01",
              location: "Farm",
              x: 10,
              y: 12,
              treeType: "Oak",
              health: 5,
              stump: false,
              moss: false,
              tapped: false,
            },
          ],
        },
      },
      scope,
      now,
    ),
    "invalid_snapshot:treeChopResultTargets",
  );
  assert.equal(
    validateExecutionRequest(
      { ...tillSoil, args: { x: 10.5, y: 12 } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "till_soil"] },
      now,
    ),
    "invalid_soil_target",
  );
  assert.equal(
    validateExecutionRequest(waterCrop, { ...snapshot, capabilities: [...snapshot.capabilities, "water_crop"] }, now),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      refillWateringCan,
      { ...snapshot, capabilities: [...snapshot.capabilities, "refill_watering_can"] },
      now,
    ),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...refillWateringCan, args: { ...refillWateringCan.args, unexpected: true } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "refill_watering_can"] },
      now,
    ),
    "invalid_args",
  );
  assert.equal(
    validateExecutionRequest(
      { ...waterCrop, args: { x: 10, y: 12 } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "water_crop"] },
      now,
    ),
    "invalid_args",
  );
  assert.equal(
    validateExecutionRequest(
      harvestCrop,
      { ...snapshot, capabilities: [...snapshot.capabilities, "harvest_crop"] },
      now,
    ),
    null,
  );
  assert.equal(
    validateExecutionRequest(
      { ...harvestCrop, args: { ...harvestCrop.args, expectedQualifiedItemId: "" } },
      { ...snapshot, capabilities: [...snapshot.capabilities, "harvest_crop"] },
      now,
    ),
    "invalid_harvest_target",
  );
});

test("protocol serialization rejects oversized, undefined, and circular values", () => {
  assert.throws(() => serializeBounded({ payload: "x".repeat(MAX_MESSAGE_BYTES + 1) }), /message_too_large/);
  assert.throws(() => serializeBounded(undefined), /message_not_serializable/);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.throws(() => serializeBounded(circular), /message_not_serializable/);
});
