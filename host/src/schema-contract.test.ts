import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

type ReplayFixture = Readonly<{ messages: readonly unknown[] }>;

const snapshotCatalogFacts = Object.freeze({
  catalogRevision: 1,
  enabledActionIds: Object.freeze([]),
});

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
      payload: {
        expressionId: "expression_01",
        sourceEventId: "source_01",
        text: "Hello",
        locale: "en-US",
        expectedRevision: 0,
        presentationEpoch: 0,
      },
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
    assert.equal(
      validate({ ...base, messageId: `${frame.type}_01`, correlationId: "correlation_01", ...frame }),
      true,
      `${frame.type}: ${JSON.stringify(validate.errors)}`,
    );
  assert.equal(
    validate({
      ...base,
      messageId: "presentation_extra_01",
      correlationId: "correlation_01",
      type: "companion_presentation_request",
      payload: {
        expressionId: "expression_01",
        sourceEventId: "source_01",
        text: "Hello",
        locale: "en-US",
        expectedRevision: 0,
        presentationEpoch: 0,
        extra: true,
      },
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
  assert.equal(validate({ ...bodySettled, payload: { ...bodySettled.payload, stopObservation: undefined } }), false);
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
      exhausted: false,
      health: 100,
      actionable: true,
      capabilities: [],
      ...snapshotCatalogFacts,
      presentationLocale: "en-US",
      timeOfDay: 600,
      dayOfMonth: 1,
      seasonIndex: 0,
      year: 1,
      activeExecution: null,
    },
  };
  const targets: readonly [string, Record<string, unknown>][] = [
    ["toolSlots", { slot: 1, label: "Axe" }],
    ["wateringCanFacts", { slot: 2, qualifiedItemId: "(T)WateringCan", label: "Watering Can", water: 40, max: 40 }],
    ["refillWateringCanTargets", { targetId: "refill_deadbeef", x: 10, y: 12 }],
    ["forageTargets", { targetId: "forage_deadbeef", x: 10, y: 12, qualifiedItemId: "(O)16", displayName: "Wild Horseradish", stack: 1 }],
    ["itemTargets", { targetId: "item_deadbeef", x: 10, y: 12, qualifiedItemId: "(O)388", displayName: "Wood", stack: 1 }],
    ["cropTargets", { targetId: "crop_deadbeef", x: 10, y: 12, cropId: "24", displayName: "Parsnip" }],
    [
      "harvestTargets",
      {
        targetId: "harvest_deadbeef",
        x: 10,
        y: 12,
        cropId: "24",
        qualifiedHarvestItemId: "(O)24",
        displayName: "Parsnip",
        regrowsAfterHarvest: false,
      },
    ],
    ["seedTargets", { targetId: "seed_deadbeef", slot: 2, x: 10, y: 12, qualifiedItemId: "(O)472", displayName: "Parsnip Seeds" }],
    ["fertilizerTargets", { targetId: "fertilizer_deadbeef", slot: 2, x: 10, y: 12, qualifiedItemId: "(O)368" }],
    [
      "woodFenceTargets",
      { targetId: "fence_deadbeef", location: "Farm", slot: 2, x: 10, y: 12, qualifiedItemId: "(O)322" },
    ],
    [
      "woodFenceResultTargets",
      {
        targetId: "fence_deadbeef",
        location: "Farm",
        slot: 2,
        x: 10,
        y: 12,
        qualifiedItemId: "(O)322",
        isFence: true,
        isGate: false,
        health: 10,
        maxHealth: 10,
      },
    ],
    [
      "crabPotTargets",
      { targetId: "crab_pot_deadbeef", location: "Farm", slot: 2, x: 10, y: 12, qualifiedItemId: "(O)710" },
    ],
    [
      "crabPotResultTargets",
      {
        targetId: "crab_pot_deadbeef",
        location: "Farm",
        slot: 2,
        x: 10,
        y: 12,
        qualifiedItemId: "(O)710",
        ownerId: 1,
        offsetX: 0,
        offsetY: 0,
        overlayTiles: [],
      },
    ],
    [
      "baitCrabPotTargets",
      {
        targetId: "crab_pot_deadbeef",
        location: "Farm",
        slot: 2,
        x: 10,
        y: 12,
        qualifiedItemId: "(O)710",
        baitQualifiedItemId: "(O)685",
        ownerId: "1",
        baitStack: 1,
      },
    ],
    [
      "baitCrabPotResultTargets",
      {
        targetId: "crab_pot_deadbeef",
        location: "Farm",
        slot: 2,
        x: 10,
        y: 12,
        qualifiedItemId: "(O)710",
        baitQualifiedItemId: "(O)685",
        ownerId: "1",
        baitStack: 1,
      },
    ],
    [
      "debrisTargets",
      {
        targetId: "debris_deadbeef",
        slot: 2,
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
    ["petTargets", { targetId: "pet_deadbeef", x: 10, y: 12, petType: "Dog", friendship: 1, pettedToday: false, stationary: true }],
    [
      "animalProductTargets",
      {
        targetId: "animal_deadbeef",
        slot: 2,
        x: 10,
        y: 12,
        animalType: "Cow",
        qualifiedProduceItemId: "(O)184",
        toolKind: "milk_pail",
        produceStack: 1,
      },
    ],
    ["feedTroughTargets", { targetId: "trough_deadbeef", slot: 2, x: 10, y: 12, hayStack: 1 }],
    ["inventoryItemFacts", { slot: 2, qualifiedItemId: "(O)184", stack: 1 }],
    ["foodTargets", { slot: 2, qualifiedItemId: "(O)216", stack: 1, edibility: 20, isDrink: false }],
    ["craftingRecipeTargets", { targetId: "Wood_Fence", displayName: "Wood Fence", ingredientsAvailable: true }],
    ["cookingRecipeTargets", { targetId: "Fried_Egg", displayName: "Fried Egg", ingredientsAvailable: false }],
    ["cookingStationTargets", { targetId: "cooking_station_0123456789abcdef", location: "FarmHouse", x: 4, y: 5, stationKind: "kitchen" }],
    ["cookingStationTargets", { targetId: "cooking_station_0123456789abcdef", location: "Farm", x: 4, y: 5, stationKind: "cookout_kit" }],
    // The seven families below were live on the wire and validated by the Host
    // before the language-neutral schema declared them, so a promotion message
    // carrying one could not be admitted by the schema leg at all.
    [
      "treeStumpTargets",
      { targetId: "tree_stump_deadbeef", location: "Farm", x: 10, y: 12, treeType: "Oak", health: 5 },
    ],
    [
      "treeSaplingTargets",
      { targetId: "tree_sapling_deadbeef", slot: 2, x: 10, y: 12, qualifiedItemId: "(O)309", displayName: "Acorn" },
    ],
    [
      "weedTargets",
      { targetId: "weed_deadbeef", location: "Farm", x: 10, y: 12, health: 2 },
    ],
    [
      "scytheCropTargets",
      {
        targetId: "scythe_crop_deadbeef",
        location: "Farm",
        x: 10,
        y: 12,
        cropId: "483",
        qualifiedHarvestItemId: "(O)483",
        displayName: "Wheat",
      },
    ],
    [
      "chestStoreTargets",
      { targetId: "chest_deadbeef", x: 10, y: 12, slot: 2, qualifiedItemId: "(O)388", displayName: "Wood", stack: 1 },
    ],
    [
      "chestRetrieveTargets",
      { targetId: "chest_deadbeef", x: 10, y: 12, qualifiedItemId: "(O)388", displayName: "Wood", stack: 1 },
    ],
    [
      "shippingBinTargets",
      { targetId: "shipping_bin_0123456789abcdef", x: 71, y: 14, slot: 2, qualifiedItemId: "(O)24", displayName: "Parsnip", stack: 1 },
    ],
  ];
  for (const [field, target] of targets) {
    const payload = { ...(snapshot.payload as Record<string, unknown>), [field]: [target] };
    assert.equal(validate({ ...snapshot, payload }), true, `${field}: ${JSON.stringify(validate.errors)}`);
    assert.equal(
      validate({ ...snapshot, payload: { ...payload, [field]: [{ ...target, unexpected: true }] } }),
      false,
      field,
    );
  }
});

test("the schema leaves native litter-category item ids open instead of pinning one id", async () => {
  // The Mod owns the native category, and both of these are predicates rather than
  // single ids:
  //   - breakable stone is `Category == -999 && Name == "Stone"` (Object.cs:6082),
  //     with 8/10/12/14/25 durabilities special-cased and every other stone id on
  //     the durability-1 default arm (Object.cs:920-943);
  //   - a diggable artifact spot is `(O)590` OR `(O)SeedSpot` (Object.cs:1310).
  // A `const` in either layer rejected the Mod's own correct discovery, which
  // failed the whole snapshot and blocked every action. This pin is what makes a
  // re-introduced `const` fail here instead of silently at runtime.
  const schema = JSON.parse(
    await readFile(fileURLToPath(new URL("../../protocol/bridge-v1.schema.json", import.meta.url)), "utf8"),
  ) as { $defs: Record<string, { properties: Record<string, unknown> }> };
  for (const definition of ["rockSourceTarget", "artifactSpotTarget"]) {
    const property = schema.$defs[definition]!.properties.qualifiedItemId as Record<string, unknown>;
    assert.equal(property.const, undefined, `${definition}.qualifiedItemId must not pin one item id`);
    assert.equal(property.enum, undefined, `${definition}.qualifiedItemId must not pin an id list`);
    assert.equal(property.type, "string", `${definition}.qualifiedItemId stays a bounded token`);
    assert.ok(
      typeof property.minLength === "number" && property.minLength >= 1,
      `${definition}.qualifiedItemId must reject an empty token`,
    );
    assert.ok(
      typeof property.maxLength === "number" && property.maxLength <= 128,
      `${definition}.qualifiedItemId must stay bounded`,
    );
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
      exhausted: false,
      health: 100,
      actionable: true,
      capabilities: ["clear_debris"],
      ...snapshotCatalogFacts,
      presentationLocale: "en-US",
      timeOfDay: 600,
      dayOfMonth: 1,
      seasonIndex: 0,
      year: 1,
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
  const [_message] = (await fixture("golden-sequence.json")).messages;
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
      exhausted: false,
      health: 100,
      actionable: true,
      capabilities: ["place_wood_fence"],
      ...snapshotCatalogFacts,
      presentationLocale: "en-US",
      timeOfDay: 600,
      dayOfMonth: 1,
      seasonIndex: 0,
      year: 1,
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
      exhausted: false,
      health: 100,
      actionable: true,
      capabilities: ["dig_artifact_spot"],
      ...snapshotCatalogFacts,
      presentationLocale: "en-US",
      timeOfDay: 600,
      dayOfMonth: 1,
      seasonIndex: 0,
      year: 1,
      artifactSpotTargets: [
        { targetId: "artifact_spot_deadbeef", location: "Farm", x: 10, y: 12, qualifiedItemId: "(O)590" },
      ],
    },
  };
  assert.equal(validate(snapshot), true, JSON.stringify(validate.errors));
  // The other legal diggable id is admitted too: `(O)SeedSpot` reaches the same
  // native `t is Hoe` branch as `(O)590` (Object.cs:1310) and both spawn at every
  // artifact-spot site. Pinning `(O)590` rejected a real artifact spot the Mod had
  // correctly discovered, which failed the whole snapshot.
  assert.equal(
    validate({
      ...snapshot,
      payload: {
        ...(snapshot.payload as Record<string, unknown>),
        artifactSpotTargets: [
          { targetId: "artifact_spot_deadbeef", location: "Farm", x: 10, y: 12, qualifiedItemId: "(O)SeedSpot" },
        ],
      },
    }),
    true,
    JSON.stringify(validate.errors),
  );
  // The id stays a bounded non-empty token: hollow values are still rejected, and
  // the native-category authority is the Mod's predicate, not a Host id list.
  for (const invalidId of ["", "x".repeat(129), 590, null]) {
    assert.equal(
      validate({
        ...snapshot,
        payload: {
          ...(snapshot.payload as Record<string, unknown>),
          artifactSpotTargets: [
            { targetId: "artifact_spot_deadbeef", location: "Farm", x: 10, y: 12, qualifiedItemId: invalidId },
          ],
        },
      }),
      false,
      JSON.stringify(invalidId),
    );
  }
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
      exhausted: false,
      health: 100,
      actionable: true,
      capabilities: ["dig_artifact_spot"],
      ...snapshotCatalogFacts,
      presentationLocale: "en-US",
      timeOfDay: 600,
      dayOfMonth: 1,
      seasonIndex: 0,
      year: 1,
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
      exhausted: false,
      health: 100,
      actionable: true,
      capabilities: ["clear_hoedirt"],
      ...snapshotCatalogFacts,
      presentationLocale: "en-US",
      timeOfDay: 600,
      dayOfMonth: 1,
      seasonIndex: 0,
      year: 1,
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
      exhausted: false,
      health: 100,
      actionable: true,
      capabilities: ["chop_tree_source"],
      ...snapshotCatalogFacts,
      presentationLocale: "en-US",
      timeOfDay: 600,
      dayOfMonth: 1,
      seasonIndex: 0,
      year: 1,
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
  for (const action of ["tree_first_hit", "inspect_self", "sop_composite_pipeline"]) {
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


test("language-neutral schema validates exact navigate_to_destination execution selectors", async () => {
  const validate = await schemaValidator();
  const [message] = (await fixture("golden-sequence.json")).messages;
  const request = {
    ...(message as Record<string, unknown>),
    type: "execution_request",
    payload: {
      requestId: "request_01",
      idempotencyKey: "idempotency_01",
      action: "navigate_to_destination",
      args: { destination: { kind: "label", label: "Town" } },
      expectedRevision: 1,
      deadlineMs: 1,
    },
  };

  const canonicalUrlSafeRef = `dr1_${"-_".repeat(10)}AQ`;
  const nonCanonicalSixteenByteRef = `dr1_${"A".repeat(21)}B`;
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({
      ...request,
      payload: { ...request.payload, args: { destination: { kind: "ref", ref: canonicalUrlSafeRef } } },
    }),
    true,
    JSON.stringify(validate.errors),
  );

  for (const destination of [
    { kind: "label", label: "Town", ref: null },
    { kind: "ref", ref: "dr1_AAAAAAAAAAAAAAAAAAAAAA", label: null },
    { kind: "ref", ref: "legacy_ref" },
    { kind: "ref", ref: "dr1_deadbeef" },
    { kind: "ref", ref: "dr1_aaaaaaaaaaaaaaaaaaaaaaa" },
    { kind: "ref", ref: "dr1_AAAAAAAAAAAAAAAAAAAAA!" },
    { kind: "ref", ref: nonCanonicalSixteenByteRef },
    { kind: "label", label: "Town", unexpected: true },
    { kind: "label", label: "" },
    null,
  ])
    assert.equal(
      validate({ ...request, payload: { ...request.payload, args: { destination } } }),
      false,
      `schema must reject ${JSON.stringify(destination)}`,
    );

  assert.equal(
    validate({ ...request, payload: { ...request.payload, args: { destination: { kind: "label", label: "Town" }, destinationRef: "dr1_deadbeef" } } }),
    false,
  );
});


test("language-neutral schema validates exact ride_minecart request arguments", async () => {
  const validate = await schemaValidator();
  const [message] = (await fixture("golden-sequence.json")).messages;
  const request = {
    ...(message as Record<string, unknown>),
    type: "execution_request",
    payload: {
      requestId: "request_01",
      idempotencyKey: "idempotency_01",
      action: "ride_minecart",
      args: { x: 10, y: 10, expectedTargetId: "minecart_0123456789abcdef" },
      expectedRevision: 1,
      deadlineMs: 1,
    },
  };
  assert.equal(validate(request), true, JSON.stringify(validate.errors));

  // The station tile and the opaque selector are both mandatory: `ride_minecart`
  // has no plain-warp form, unlike `travel`.
  for (const args of [
    { x: 10, y: 10 },
    { x: 10, y: 10, expectedTargetId: "minecart_0123456789abcdef", extra: true },
    { x: 10, y: 10, expectedTargetId: "not_a_minecart_id" },
    { x: 10, y: 10, expectedTargetId: 7 },
    { x: -1, y: 10, expectedTargetId: "minecart_0123456789abcdef" },
  ])
    assert.equal(
      validate({ ...request, payload: { ...request.payload, args } }),
      false,
      `schema must reject ${JSON.stringify(args)}`,
    );
});

test("language-neutral schema closes body-node admission challenge and grant frames", async () => {
  const validate = await schemaValidator();
  const [base] = (await fixture("golden-sequence.json")).messages as readonly Record<string, unknown>[];
  const challenge = {
    programId: "program_01", nodeId: "node_01", nodeAttempt: 1, admissionAttempt: 1,
    stopEpoch: 0, catalogRevision: 1, policyIdentity: { value: "policy:01", capabilityRevision: 1 },
    actionId: "navigate", deadlineMs: 9007199254740991,
    canonicalBoundArgs: {
      count: { type: "integer", canonicalValue: "9223372036854775807" },
      text: { type: "string", canonicalValue: "Farm" },
      enabled: { type: "boolean", canonicalValue: "true" },
      destination: { type: "destination_selector", destination: { kind: "label", label: "Farm" } },
      ref: { type: "destination_selector", destination: { kind: "ref", ref: `dr1_${"A".repeat(22)}` } },
    },
    derivedResourceClaims: { actor: "farmhand_01" },
  };
  const binding = { programId: challenge.programId, nodeId: challenge.nodeId, nodeAttempt: 1,
    requestId: "request_01", idempotencyKey: "idempotency_01", executionId: "execution_01" };
  const grant = { ...challenge, grantId: "grant_01", attachmentGeneration: "attachment:01",
    policyRevision: "revision:01", executionBinding: binding };
  const frame = (payload: unknown, type = "body_node_admission_challenge") => ({ ...base, type, payload });
  for (const message of [frame(challenge), frame(grant, "body_node_admission_grant"),
    frame({ ...grant, executionBinding: null }, "body_node_admission_grant")]) {
    assert.equal(validate(message), true, JSON.stringify(validate.errors));
    const record = message as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const missing = { ...record };
      delete missing[key];
      assert.equal(validate(missing), false, `missing envelope ${key}`);
    }
    assert.equal(validate({ ...message, extra: true }), false);
    for (const [key, value] of Object.entries({ protocolVersion: 2, messageId: "!", correlationId: "!",
      timestampMs: 1.5, scope: { ...(base.scope as object), extra: true }, payload: [] })) {
      assert.equal(validate({ ...message, [key]: value }), false, `invalid envelope ${key}`);
    }
  }
  for (const [payload, type] of [[challenge, "body_node_admission_challenge"], [grant, "body_node_admission_grant"]] as const) {
    for (const key of Object.keys(payload)) {
      const missing: Record<string, unknown> = { ...payload };
      delete missing[key];
      assert.equal(validate(frame(missing, type)), false, `missing ${type}.${key}`);
    }
    assert.equal(validate(frame({ ...payload, extra: true }, type)), false);
  }
  assert.equal(validate(frame(grant)), false, "grant is not a challenge");
  assert.equal(validate(frame(challenge, "body_node_admission_grant")), false, "challenge is not a grant");
  assert.equal(validate(frame({ ...challenge,
    nodeAttempt: 2147483647, admissionAttempt: 2147483647,
    canonicalBoundArgs: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`arg_${i}`, { type: "string", canonicalValue: "" }])),
    derivedResourceClaims: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`claim_${i}`, "actor"])),
  })), true, JSON.stringify(validate.errors));
  const badChallenges = [
    { nodeAttempt: 0 }, { admissionAttempt: 2147483648 }, { stopEpoch: -1 },
    { catalogRevision: 9007199254740992 }, { deadlineMs: 0 }, { deadlineMs: 9007199254740992 },
    { policyIdentity: { value: "policy" } }, { policyIdentity: { ...challenge.policyIdentity, extra: true } },
    { policyIdentity: { value: "x".repeat(4097), capabilityRevision: 0 } },
    { policyIdentity: { value: "bad\u0085policy", capabilityRevision: 0 } },
    { policyIdentity: { value: "policy", capabilityRevision: 9007199254740992 } },
    { canonicalBoundArgs: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`arg_${i}`, challenge.canonicalBoundArgs.text])) },
    { canonicalBoundArgs: { "bad key": challenge.canonicalBoundArgs.text } },
    { derivedResourceClaims: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`claim_${i}`, "actor"])) },
    { derivedResourceClaims: { "bad key": "actor" } }, { derivedResourceClaims: { actor: 1 } },
  ];
  for (const patch of badChallenges) {
    assert.equal(validate(frame({ ...challenge, ...patch })), false, JSON.stringify(patch));
    assert.equal(validate(frame({ ...grant, ...patch }, "body_node_admission_grant")), false, JSON.stringify(patch));
  }
  for (const executionBinding of [undefined, {}, { ...binding, extra: true }, { ...binding, nodeAttempt: 0 },
    { ...binding, requestId: "!" }, { ...binding, executionId: null }, { ...binding, idempotencyKey: 1 }]) {
    assert.equal(validate(frame({ ...grant, executionBinding }, "body_node_admission_grant")), false);
  }
  for (const key of ["attachmentGeneration", "policyRevision"]) {
    for (const value of [1, "", "x".repeat(4097), "bad\nvalue", "bad\u007fvalue", "bad\n"]) {
      assert.equal(validate(frame({ ...grant, [key]: value }, "body_node_admission_grant")), false);
    }
  }
  const canonicalFrame = (value: unknown) => frame({ ...challenge, canonicalBoundArgs: { arg: value } });
  for (const value of [
    { type: "destination_selector", selector: { kind: "label", label: "Farm" } },
    { type: "destination_selector", destination: { kind: "label", label: "Farm", ref: null } },
    { type: "destination_selector", destination: { kind: "label", label: " " } },
    { type: "destination_selector", destination: { kind: "label", label: "x".repeat(129) } },
    { type: "destination_selector", destination: { kind: "ref", ref: `dr1_${"A".repeat(21)}B` } },
    { type: "string", canonicalValue: "x".repeat(513) }, { type: "string" },
    { type: "string", canonicalValue: "ok", extra: true }, { type: "boolean", canonicalValue: true },
    { type: "boolean", canonicalValue: "False" },
  ]) assert.equal(validate(canonicalFrame(value)), false, JSON.stringify(value));
  for (const canonicalValue of ["0", "-1", "9223372036854775807", "-9223372036854775808"]) {
    assert.equal(validate(canonicalFrame({ type: "integer", canonicalValue })), true, canonicalValue);
  }
  for (const canonicalValue of ["-0", "+1", "01", "1.0", "1e3", "1\n", "9223372036854775808", "-9223372036854775809", 9007199254740992]) {
    assert.equal(validate(canonicalFrame({ type: "integer", canonicalValue })), false, String(canonicalValue));
  }
  // Exercise every decimal boundary in the Int64 regex against the native BigInt range oracle.
  for (let digits = 0n; digits < 20n; digits++) {
    const step = 10n ** digits;
    for (const limit of [9223372036854775807n, 9223372036854775808n]) {
      const boundary = limit / step * step;
      for (const candidate of [boundary - 1n, boundary, boundary + 1n]) {
        for (const integer of [candidate, -candidate]) {
          assert.equal(validate(canonicalFrame({ type: "integer", canonicalValue: String(integer) })),
            integer >= -9223372036854775808n && integer <= 9223372036854775807n, String(integer));
        }
      }
    }
  }
});
