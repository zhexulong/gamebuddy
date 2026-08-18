import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

type ReplayFixture = Readonly<{ messages: readonly unknown[] }>;

async function schemaValidator() {
  const schema = JSON.parse(
    await readFile(fileURLToPath(new URL("../../protocol/bridge-v1.schema.json", import.meta.url)), "utf8"),
  ) as object;
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

async function fixture(name: string): Promise<ReplayFixture> {
  return JSON.parse(
    await readFile(fileURLToPath(new URL(`../../fixtures/bridge-v1/${name}`, import.meta.url)), "utf8"),
  ) as ReplayFixture;
}

test("language-neutral schema validates committed bridge replay payloads", async () => {
  const validate = await schemaValidator();
  for (const name of ["golden-sequence.json", "phase2-terminal-replay.json"]) {
    for (const message of (await fixture(name)).messages) {
      assert.equal(validate(message), true, `${name}: ${JSON.stringify(validate.errors)}`);
    }
  }
});

test("language-neutral schema accepts only fixed player-control acknowledgement payloads", async () => {
  const validate = await schemaValidator();
  const [base] = (await fixture("golden-sequence.json")).messages as readonly Record<string, unknown>[];
  const receipt = {
    ...base,
    messageId: "receipt_01",
    correlationId: "control_01",
    type: "player_control_receipt",
    payload: { controlId: "control_01", sourceEventId: "source_01", status: "accepted" },
  };
  assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...receipt, payload: { ...receipt.payload, status: "rejected" } }), false);
  assert.equal(validate({ ...receipt, payload: { controlId: "control_01", sourceEventId: "source_01" } }), false);
});

test("language-neutral schema accepts all production presentation and system-notice frames", async () => {
  const validate = await schemaValidator();
  const [base] = (await fixture("golden-sequence.json")).messages as readonly Record<string, unknown>[];
  const frames = [
    {
      type: "companion_presentation_request",
      payload: { expressionId: "expression_01", sourceEventId: "source_01", text: "Hello", locale: "en-US", expectedRevision: 0, presentationEpoch: 0 },
    },
    {
      type: "companion_presentation_receipt",
      payload: { expressionId: "expression_01", revision: 0, presentationEpoch: 0 },
    },
    {
      type: "system_notice_request",
      payload: { noticeId: "notice_01", key: "system.stop.active_turn_cancelled", text: "Stopped.", locale: "en-US" },
    },
    {
      type: "system_notice_receipt",
      payload: { noticeId: "notice_01", revision: 0 },
    },
  ];
  for (const frame of frames)
    assert.equal(validate({ ...base, messageId: `${frame.type}_01`, correlationId: "correlation_01", ...frame }), true, `${frame.type}: ${JSON.stringify(validate.errors)}`);
  assert.equal(
    validate({
      ...base,
      messageId: "presentation_extra_01",
      correlationId: "correlation_01",
      type: "companion_presentation_request",
      payload: { expressionId: "expression_01", sourceEventId: "source_01", text: "Hello", locale: "en-US", expectedRevision: 0, presentationEpoch: 0, extra: true },
    }),
    false,
  );
});

test("language-neutral schema accepts body_settled only with its exact stop observation", async () => {
  const validate = await schemaValidator();
  const [base] = (await fixture("golden-sequence.json")).messages as readonly Record<string, unknown>[];
  const bodySettled = {
    ...base,
    messageId: "semantic_body_settled_01",
    correlationId: "correlation_01",
    type: "semantic_event",
    payload: {
      kind: "body_settled",
      revision: 1,
      activeExecution: null,
      reasonCode: "stop_body_settled",
      stopObservation: { kind: "body_settled", stopId: "stop_01", sourceEventId: "source_01", epoch: 1 },
    },
  };
  assert.equal(validate(bodySettled), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({ ...bodySettled, payload: { ...bodySettled.payload, stopObservation: undefined } }),
    false,
  );
  assert.equal(
    validate({
      ...bodySettled,
      payload: {
        ...bodySettled.payload,
        stopObservation: { ...bodySettled.payload.stopObservation, kind: "stop_all" },
      },
    }),
    false,
  );
});

test("language-neutral schema and Host share closed shapes for every published snapshot target family", async () => {
  const validate = await schemaValidator();
  const [base] = (await fixture("golden-sequence.json")).messages as readonly Record<string, unknown>[];
  const snapshot = {
    ...base,
    messageId: "snapshot_targets_closed_shape_01",
    correlationId: "snapshot_targets_closed_shape_01",
    type: "snapshot",
    payload: {
      revision: 2,
      location: "Farm",
      tile: { x: 10, y: 11 },
      stamina: 100,
      health: 100,
      actionable: true,
      capabilities: [],
      presentationLocale: "en-US",
      activeExecution: null,
    },
  };
  const targets: readonly [string, Record<string, unknown>][] = [
    ["toolSlots", { slot: 1, label: "Axe" }],
    ["wateringCanFacts", { slot: 2, qualifiedItemId: "(T)WateringCan", label: "Watering Can", water: 40, max: 40 }],
    ["refillWateringCanTargets", { targetId: "refill_deadbeef", x: 10, y: 12 }],
    ["forageTargets", { targetId: "forage_deadbeef", x: 10, y: 12, qualifiedItemId: "(O)16", stack: 1 }],
    ["itemTargets", { targetId: "item_deadbeef", x: 10, y: 12, qualifiedItemId: "(O)388", stack: 1 }],
    ["cropTargets", { targetId: "crop_deadbeef", x: 10, y: 12, cropId: "24" }],
    ["harvestTargets", { targetId: "harvest_deadbeef", x: 10, y: 12, cropId: "24", qualifiedHarvestItemId: "(O)24", regrowsAfterHarvest: false }],
    ["seedTargets", { targetId: "seed_deadbeef", slot: 2, x: 10, y: 12, qualifiedItemId: "(O)472" }],
    ["fertilizerTargets", { targetId: "fertilizer_deadbeef", slot: 2, x: 10, y: 12, qualifiedItemId: "(O)368" }],
    ["woodFenceTargets", { targetId: "fence_deadbeef", location: "Farm", slot: 2, x: 10, y: 12, qualifiedItemId: "(O)322" }],
    ["woodFenceResultTargets", { targetId: "fence_deadbeef", location: "Farm", slot: 2, x: 10, y: 12, qualifiedItemId: "(O)322", isFence: true, isGate: false, health: 10, maxHealth: 10 }],
    ["crabPotTargets", { targetId: "crab_pot_deadbeef", location: "Farm", slot: 2, x: 10, y: 12, qualifiedItemId: "(O)710" }],
    ["crabPotResultTargets", { targetId: "crab_pot_deadbeef", location: "Farm", slot: 2, x: 10, y: 12, qualifiedItemId: "(O)710", ownerId: 1, offsetX: 0, offsetY: 0, overlayTiles: [] }],
    ["baitCrabPotTargets", { targetId: "crab_pot_deadbeef", location: "Farm", slot: 2, x: 10, y: 12, qualifiedItemId: "(O)710", baitQualifiedItemId: "(O)685", ownerId: "1", baitStack: 1 }],
    ["baitCrabPotResultTargets", { targetId: "crab_pot_deadbeef", location: "Farm", slot: 2, x: 10, y: 12, qualifiedItemId: "(O)710", baitQualifiedItemId: "(O)685", ownerId: "1", baitStack: 1 }],
    ["debrisTargets", { targetId: "debris_deadbeef", slot: 2, x: 10, y: 12, parentSheetIndex: 752, toolKind: "pickaxe", requiredUpgradeLevel: 0, health: 8 }],
    ["rockSourceTargets", { targetId: "rock_deadbeef", location: "Farm", x: 10, y: 12, qualifiedItemId: "(O)2", health: 1 }],
    ["clearHoeDirtTargets", { targetId: "dirt_deadbeef", location: "Farm", x: 10, y: 12, crop: false, ground: true }],
    ["artifactSpotTargets", { targetId: "artifact_deadbeef", location: "Farm", x: 10, y: 12, qualifiedItemId: "(O)590" }],
    ["artifactSpotResultTargets", { targetId: "artifact_deadbeef", location: "Farm", x: 10, y: 12, crop: false, ground: true }],
    ["machineTargets", { targetId: "machine_deadbeef", x: 10, y: 12, qualifiedItemId: "(BC)12", readyForHarvest: false, minutesUntilReady: 10 }],
    ["treeChopSourceTargets", { targetId: "tree_deadbeef", location: "Farm", x: 10, y: 12, treeType: "Oak", growthStage: 5, health: 1, stump: false, moss: false, tapped: false }],
    ["treeChopResultTargets", { targetId: "tree_deadbeef", location: "Farm", x: 10, y: 12, treeType: "Oak", health: 5, stump: true, moss: false, tapped: false }],
    ["npcRelationshipTargets", { targetId: "npc_deadbeef", x: 10, y: 12, npcName: "Abigail", friendshipPoints: 0, friendshipStatus: "Neutral", talkedToToday: false, giftsToday: 0, giftsThisWeek: 0 }],
    ["petTargets", { targetId: "pet_deadbeef", x: 10, y: 12, petType: "Dog", friendship: 1, pettedToday: false }],
    ["animalProductTargets", { targetId: "animal_deadbeef", slot: 2, x: 10, y: 12, animalType: "Cow", qualifiedProduceItemId: "(O)184", toolKind: "milk_pail", produceStack: 1 }],
    ["feedTroughTargets", { targetId: "trough_deadbeef", slot: 2, x: 10, y: 12, hayStack: 1 }],
    ["inventoryItemFacts", { slot: 2, qualifiedItemId: "(O)184", stack: 1 }],
    ["foodTargets", { slot: 2, qualifiedItemId: "(O)216", stack: 1, edibility: 20, isDrink: false }],
  ];
  for (const [field, target] of targets) {
    const payload = { ...(snapshot.payload as Record<string, unknown>), [field]: [target] };
    assert.equal(validate({ ...snapshot, payload }), true, `${field}: ${JSON.stringify(validate.errors)}`);
    assert.equal(validate({ ...snapshot, payload: { ...payload, [field]: [{ ...target, unexpected: true }] } }), false, field);
  }
});

test("language-neutral schema requires positive ResourceClump health in debris snapshots", async () => {
  const validate = await schemaValidator();
  const [message] = (await fixture("golden-sequence.json")).messages;
  const snapshot = {
    ...(message as Record<string, unknown>),
    type: "snapshot",
    payload: {
      revision: 2,
      location: "Farm",
      tile: { x: 10, y: 11 },
      stamina: 100,
      health: 100,
      actionable: true,
      capabilities: ["clear_debris"],
      presentationLocale: "en-US",
      activeExecution: null,
      debrisTargets: [
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
    },
  };
  assert.equal(validate(snapshot), true, JSON.stringify(validate.errors));
  const payload = snapshot.payload as Record<string, unknown>;
  const target = (payload.debrisTargets as Record<string, unknown>[])[0]!;
  for (const invalid of [
    { ...target, health: 0 },
    { ...target, health: 8.5 },
    (() => {
      const { health: _health, ...withoutHealth } = target;
      return withoutHealth;
    })(),
    { ...target, unexpected: true },
  ])
    assert.equal(validate({ ...snapshot, payload: { ...payload, debrisTargets: [invalid] } }), false);
});

test("language-neutral schema validates exact Wood Fence request and result target facts", async () => {
  const validate = await schemaValidator();
  const [message] = (await fixture("golden-sequence.json")).messages;
  const executionMessage = (await fixture("golden-sequence.json")).messages.find(
    (entry) => (entry as Record<string, unknown>).type === "execution_request",
  ) as Record<string, unknown>;
  const request = {
    ...executionMessage,
    type: "execution_request",
    payload: {
      ...(executionMessage.payload as Record<string, unknown>),
      requestId: "request_01",
      idempotencyKey: "idempotency_01",
      action: "place_wood_fence",
      args: { slot: 4, x: 10, y: 12, expectedQualifiedItemId: "(O)322", expectedTargetId: "wood_fence_deadbeef" },
      expectedRevision: 1,
      deadlineMs: 1,
    },
  };
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({
      ...request,
      payload: {
        ...(request.payload as Record<string, unknown>),
        args: { slot: 4, x: 10, y: 12, expectedQualifiedItemId: "(O)388", expectedTargetId: "wood_fence_deadbeef" },
      },
    }),
    false,
  );
  const snapshotMessage = (await fixture("golden-sequence.json")).messages.find(
    (entry) => (entry as Record<string, unknown>).type === "snapshot",
  ) as Record<string, unknown>;
  const snapshot = {
    ...snapshotMessage,
    type: "snapshot",
    payload: {
      ...(snapshotMessage.payload as Record<string, unknown>),
      revision: 2,
      location: "Farm",
      tile: { x: 10, y: 11 },
      stamina: 100,
      health: 100,
      actionable: true,
      capabilities: ["place_wood_fence"],
      presentationLocale: "en-US",
      activeExecution: null,
      woodFenceResultTargets: [
        {
          targetId: "wood_fence_deadbeef",
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
    },
  };
  assert.equal(validate(snapshot), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({
      ...snapshot,
      payload: {
        ...(snapshot.payload as Record<string, unknown>),
        woodFenceResultTargets: [
          {
            ...((snapshot.payload as Record<string, unknown>).woodFenceResultTargets as unknown as Record<
              string,
              unknown
            >[]),
            isGate: true,
          },
        ],
      },
    }),
    false,
  );
});

test("language-neutral schema validates exact refill_watering_can request arguments", async () => {
  const validate = await schemaValidator();
  const [message] = (await fixture("golden-sequence.json")).messages;
  const request = {
    ...(message as Record<string, unknown>),
    type: "execution_request",
    payload: {
      requestId: "request_01",
      idempotencyKey: "idempotency_01",
      action: "refill_watering_can",
      args: { slot: 4, x: 10, y: 12, expectedTargetId: "watering_can_refill_deadbeef" },
      expectedRevision: 1,
      deadlineMs: 1,
    },
  };
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({
      ...request,
      payload: {
        ...(request.payload as Record<string, unknown>),
        args: { slot: 4, x: 10, y: 12, expectedTargetId: "watering_can_refill_deadbeef", unexpected: true },
      },
    }),
    false,
  );
});

test("language-neutral schema validates exact break_rock_source request arguments", async () => {
  const validate = await schemaValidator();
  const [message] = (await fixture("golden-sequence.json")).messages;
  const request = {
    ...(message as Record<string, unknown>),
    type: "execution_request",
    payload: {
      requestId: "request_01",
      idempotencyKey: "idempotency_01",
      action: "break_rock_source",
      args: { slot: 4, x: 10, y: 12, expectedTargetId: "rock_source_deadbeef" },
      expectedRevision: 1,
      deadlineMs: 1,
    },
  };
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({
      ...request,
      payload: {
        ...(request.payload as Record<string, unknown>),
        args: { slot: 4, x: 10, y: 12, expectedTargetId: "rock_source_deadbeef", unexpected: true },
      },
    }),
    false,
  );
});

test("language-neutral schema validates exact dig_artifact_spot request arguments and target facts", async () => {
  const validate = await schemaValidator();
  const [message] = (await fixture("golden-sequence.json")).messages;
  const request = {
    ...(message as Record<string, unknown>),
    type: "execution_request",
    payload: {
      requestId: "request_01",
      idempotencyKey: "idempotency_01",
      action: "dig_artifact_spot",
      args: { slot: 4, x: 10, y: 12, expectedTargetId: "artifact_spot_deadbeef" },
      expectedRevision: 1,
      deadlineMs: 1,
    },
  };
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({
      ...request,
      payload: {
        ...(request.payload as Record<string, unknown>),
        args: { slot: 4, x: 10, y: 12, expectedTargetId: "artifact_spot_deadbeef", unexpected: true },
      },
    }),
    false,
  );
  const snapshot = {
    ...(message as Record<string, unknown>),
    type: "snapshot",
    payload: {
      revision: 2,
      location: "Farm",
      tile: { x: 10, y: 11 },
      stamina: 100,
      health: 100,
      actionable: true,
      capabilities: ["dig_artifact_spot"],
      presentationLocale: "en-US",
      artifactSpotTargets: [
        { targetId: "artifact_spot_deadbeef", location: "Farm", x: 10, y: 12, qualifiedItemId: "(O)590" },
      ],
    },
  };
  assert.equal(validate(snapshot), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({
      ...snapshot,
      payload: {
        ...(snapshot.payload as Record<string, unknown>),
        artifactSpotTargets: [
          { targetId: "artifact_spot_deadbeef", location: "Farm", x: 10, y: 12, qualifiedItemId: "(O)388" },
        ],
      },
    }),
    false,
  );
  assert.equal(
    validate({
      ...snapshot,
      payload: {
        ...(snapshot.payload as Record<string, unknown>),
        artifactSpotTargets: [
          {
            targetId: "artifact_spot_deadbeef",
            location: "Farm",
            x: 10,
            y: 12,
            qualifiedItemId: "(O)590",
            unexpected: true,
          },
        ],
      },
    }),
    false,
  );
  const artifactResultSnapshot = {
    ...(message as Record<string, unknown>),
    type: "snapshot",
    payload: {
      revision: 2,
      location: "Farm",
      tile: { x: 10, y: 11 },
      stamina: 100,
      health: 100,
      actionable: true,
      capabilities: ["dig_artifact_spot"],
      presentationLocale: "en-US",
      artifactSpotResultTargets: [
        { targetId: "artifact_result_deadbeef", location: "Farm", x: 10, y: 12, crop: false, ground: true },
      ],
    },
  };
  assert.equal(validate(artifactResultSnapshot), true, JSON.stringify(validate.errors));
  const artifactResultTarget = (
    (artifactResultSnapshot.payload as Record<string, unknown>).artifactSpotResultTargets as Record<string, unknown>[]
  )[0]!;
  for (const invalid of [
    { ...artifactResultTarget, crop: true },
    { ...artifactResultTarget, ground: false },
    { ...artifactResultTarget, unexpected: true },
    { ...artifactResultTarget, targetId: "not opaque" },
    (() => {
      const { targetId: _targetId, ...withoutTargetId } = artifactResultTarget;
      return withoutTargetId;
    })(),
  ])
    assert.equal(
      validate({
        ...artifactResultSnapshot,
        payload: {
          ...(artifactResultSnapshot.payload as Record<string, unknown>),
          artifactSpotResultTargets: [invalid],
        },
      }),
      false,
    );
});

test("language-neutral schema validates exact clear_hoedirt request arguments and target facts", async () => {
  const validate = await schemaValidator();
  const [message] = (await fixture("golden-sequence.json")).messages;
  const request = {
    ...(message as Record<string, unknown>),
    type: "execution_request",
    payload: {
      requestId: "request_01",
      idempotencyKey: "idempotency_01",
      action: "clear_hoedirt",
      args: { slot: 4, x: 10, y: 12, expectedTargetId: "hoedirt_deadbeef" },
      expectedRevision: 1,
      deadlineMs: 1,
    },
  };
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({
      ...request,
      payload: {
        ...(request.payload as Record<string, unknown>),
        args: { slot: 4, x: 10, y: 12, expectedTargetId: "hoedirt_deadbeef", unexpected: true },
      },
    }),
    false,
  );
  const snapshot = {
    ...(message as Record<string, unknown>),
    type: "snapshot",
    payload: {
      revision: 2,
      location: "Farm",
      tile: { x: 10, y: 11 },
      stamina: 100,
      health: 100,
      actionable: true,
      capabilities: ["clear_hoedirt"],
      presentationLocale: "en-US",
      clearHoeDirtTargets: [
        { targetId: "hoedirt_deadbeef", location: "Farm", x: 10, y: 12, crop: false, ground: true },
      ],
    },
  };
  assert.equal(validate(snapshot), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({
      ...snapshot,
      payload: {
        ...(snapshot.payload as Record<string, unknown>),
        clearHoeDirtTargets: [
          { targetId: "hoedirt_deadbeef", location: "Farm", x: 10, y: 12, crop: false, ground: true, unexpected: true },
        ],
      },
    }),
    false,
  );
  assert.equal(
    validate({
      ...snapshot,
      payload: {
        ...(snapshot.payload as Record<string, unknown>),
        clearHoeDirtTargets: [
          { targetId: "hoedirt_deadbeef", location: "Farm", x: 10, y: 12, crop: true, ground: true },
        ],
      },
    }),
    false,
  );
});

test("language-neutral schema validates exact chop_tree_source request arguments", async () => {
  const validate = await schemaValidator();
  const [message] = (await fixture("golden-sequence.json")).messages;
  const request = {
    ...(message as Record<string, unknown>),
    type: "execution_request",
    payload: {
      requestId: "request_01",
      idempotencyKey: "idempotency_01",
      action: "chop_tree_source",
      args: { slot: 4, x: 10, y: 12, expectedTargetId: "tree_chop_deadbeef" },
      expectedRevision: 1,
      deadlineMs: 1,
    },
  };
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({
      ...request,
      payload: {
        ...(request.payload as Record<string, unknown>),
        args: { slot: 4, x: 10, y: 12, expectedTargetId: "tree_chop_deadbeef", unexpected: true },
      },
    }),
    false,
  );
});

test("language-neutral schema validates strict chop-tree result snapshot facts", async () => {
  const validate = await schemaValidator();
  const [message] = (await fixture("golden-sequence.json")).messages;
  const snapshot = {
    ...(message as Record<string, unknown>),
    type: "snapshot",
    payload: {
      revision: 2,
      location: "Farm",
      tile: { x: 10, y: 11 },
      stamina: 100,
      health: 100,
      actionable: true,
      capabilities: ["chop_tree_source"],
      presentationLocale: "en-US",
      activeExecution: null,
      treeChopResultTargets: [
        {
          targetId: "tree_chop_result_deadbeef",
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
  };
  assert.equal(validate(snapshot), true, JSON.stringify(validate.errors));
  const payload = snapshot.payload as Record<string, unknown>;
  const target = (payload.treeChopResultTargets as Record<string, unknown>[])[0]!;
  for (const invalid of [
    { ...target, health: 4 },
    { ...target, stump: false },
    { ...target, moss: true },
    { ...target, tapped: true },
    { ...target, unexpected: true },
  ])
    assert.equal(validate({ ...snapshot, payload: { ...payload, treeChopResultTargets: [invalid] } }), false);
});

test("language-neutral schema rejects retired tree_first_hit and inspect_self execution requests", async () => {
  const validate = await schemaValidator();
  const [message] = (await fixture("golden-sequence.json")).messages;
  for (const action of ["tree_first_hit", "inspect_self"]) {
    assert.equal(
      validate({
        ...(message as Record<string, unknown>),
        type: "execution_request",
        payload: {
          requestId: "request_01",
          idempotencyKey: "idempotency_01",
          action,
          args: {},
          expectedRevision: 1,
          deadlineMs: 1,
        },
      }),
      false,
      `${action} must not be schema-valid as an execution request`,
    );
  }
});

test("language-neutral schema rejects malformed and retired typed payloads", async () => {
  const validate = await schemaValidator();
  const [message] = (await fixture("golden-sequence.json")).messages;
  assert.equal(
    validate({
      ...(message as Record<string, unknown>),
      type: "execution_receipt",
      payload: { executionId: "exec_01" },
    }),
    false,
  );
  assert.equal(
    validate({
      ...(message as Record<string, unknown>),
      type: "execution_request",
      payload: {
        requestId: "request_01",
        idempotencyKey: "idempotency_01",
        action: "collect_resource",
        args: {},
        expectedRevision: 1,
        deadlineMs: 1,
      },
    }),
    false,
  );
});
