import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

import {
  SNAPSHOT_FAMILY_RULES,
  diagnoseBridgeMessage,
  validateBridgeMessage,
  type Scope,
  type SnapshotFamilyRule,
} from "./protocol.js";

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
        presentationEpoch: 0,
      },
    },
    {
      type: "companion_presentation_receipt",
      payload: { expressionId: "expression_01", presentationEpoch: 0 },
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
      weather: "sunny",
      activeExecution: null,
    },
  };
  // The family list is DERIVED from the Host, never hand-typed: every snapshot field
  // the Host diagnoses by name (`invalid_snapshot:<field>`) must be declared by the
  // language-neutral schema, whose `additionalProperties:false` makes a missing entry
  // unshippable. The array families are declared by `SNAPSHOT_FAMILY_RULES` rather
  // than by a literal, so they are read from that table; the regex below keeps every
  // member that is still diagnosed from a literal. A hand-written `targets` array
  // below once claimed to cover "every published snapshot target family" while
  // stopping at `shippingBinTargets`, so six real families (`fishPondTargets`,
  // `farmBuildingTargets`, `dailyQuestTargets`, `specialOrderTargets`,
  // `museumRewardTargets`, `tailoringTargets`) were never probed and the suite stayed
  // green. The old snake_case tokens below (`missing_required_key`,
  // `unexpected_keys`) come from the generic key helper, not from a field, so the
  // negative lookahead keeps only the field tokens.
  const protocolSource = await readFile(fileURLToPath(new URL("../../host/src/protocol.ts", import.meta.url)), "utf8");
  const schemaDocument = JSON.parse(
    await readFile(fileURLToPath(new URL("../../protocol/bridge-v1.schema.json", import.meta.url)), "utf8"),
  ) as { $defs: { snapshot: { properties: Record<string, unknown> } } };
  const hostSnapshotFields = [
    ...new Set([
      ...[...protocolSource.matchAll(/invalid_snapshot:([a-z][A-Za-z0-9]*)(?![A-Za-z0-9_])/g)]
        .map((match) => match[1])
        .filter((field): field is string => field !== undefined),
      ...SNAPSHOT_FAMILY_RULES.map((rule) => rule.field),
    ]),
  ];
  const schemaSnapshotFields = new Set(Object.keys(schemaDocument.$defs.snapshot.properties));
  for (const field of hostSnapshotFields)
    assert.ok(
      schemaSnapshotFields.has(field),
      `the Host validates snapshot field ${field} but the language-neutral schema does not declare it`,
    );
  const targets: readonly [string, Record<string, unknown>][] = [
    ["toolSlots", { slot: 1, label: "Axe" }],
    ["wateringCanFacts", { slot: 2, qualifiedItemId: "(T)WateringCan", label: "Watering Can", water: 40, max: 40 }],
    ["refillWateringCanTargets", { targetId: "refill_deadbeef", x: 10, y: 12 }],
    [
      "forageTargets",
      {
        targetId: "forage_deadbeef",
        x: 10,
        y: 12,
        qualifiedItemId: "(O)16",
        displayName: "Wild Horseradish",
        stack: 1,
      },
    ],
    [
      "itemTargets",
      { targetId: "item_deadbeef", x: 10, y: 12, qualifiedItemId: "(O)388", displayName: "Wood", stack: 1 },
    ],
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
    [
      "seedTargets",
      { targetId: "seed_deadbeef", slot: 2, x: 10, y: 12, qualifiedItemId: "(O)472", displayName: "Parsnip Seeds" },
    ],
    [
      "fertilizerTargets",
      {
        targetId: "fertilizer_deadbeef",
        slot: 2,
        x: 10,
        y: 12,
        qualifiedItemId: "(O)368",
        displayName: "Quality Fertilizer",
      },
    ],
    [
      "woodFenceTargets",
      {
        targetId: "fence_deadbeef",
        location: "Farm",
        slot: 2,
        x: 10,
        y: 12,
        qualifiedItemId: "(O)322",
        displayName: "Wood Fence",
      },
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
        displayName: "Wood Fence",
        isFence: true,
        isGate: false,
        health: 10,
        maxHealth: 10,
      },
    ],
    [
      "crabPotTargets",
      {
        targetId: "crab_pot_deadbeef",
        location: "Farm",
        slot: 2,
        x: 10,
        y: 12,
        qualifiedItemId: "(O)710",
        displayName: "Crab Pot",
      },
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
        displayName: "Crab Pot",
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
        displayName: "Crab Pot",
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
        displayName: "Crab Pot",
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
      {
        targetId: "rock_deadbeef",
        location: "Farm",
        x: 10,
        y: 12,
        qualifiedItemId: "(O)751",
        displayName: "Copper Node",
        // A mine node's real durability. The sample used to be `1` because the schema was `const 1`, which is what
        // hid every multi-hit rock in the game.
        health: 3,
      },
    ],
    ["clearHoeDirtTargets", { targetId: "dirt_deadbeef", location: "Farm", x: 10, y: 12, crop: false, ground: true }],
    [
      "artifactSpotTargets",
      {
        targetId: "artifact_deadbeef",
        location: "Farm",
        x: 10,
        y: 12,
        qualifiedItemId: "(O)590",
        displayName: "Artifact Spot",
      },
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
        displayName: "Keg",
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
    [
      "petTargets",
      { targetId: "pet_deadbeef", x: 10, y: 12, petType: "Dog", friendship: 1, pettedToday: false, stationary: true },
    ],
    [
      "animalProductTargets",
      {
        targetId: "animal_deadbeef",
        slot: 2,
        x: 10,
        y: 12,
        animalType: "Cow",
        qualifiedProduceItemId: "(O)184",
        displayName: "Milk",
        toolKind: "milk_pail",
        produceStack: 1,
      },
    ],
    ["feedTroughTargets", { targetId: "trough_deadbeef", slot: 2, x: 10, y: 12, hayStack: 1 }],
    ["inventoryItemFacts", { slot: 2, qualifiedItemId: "(O)184", displayName: "Milk", stack: 1 }],
    [
      "foodTargets",
      { slot: 2, qualifiedItemId: "(O)216", displayName: "Bread", stack: 1, edibility: 20, isDrink: false },
    ],
    ["craftingRecipeTargets", { targetId: "Wood_Fence", displayName: "Wood Fence", ingredientsAvailable: true }],
    ["cookingRecipeTargets", { targetId: "Fried_Egg", displayName: "Fried Egg", ingredientsAvailable: false }],
    [
      "cookingStationTargets",
      { targetId: "cooking_station_0123456789abcdef", location: "FarmHouse", x: 4, y: 5, stationKind: "kitchen" },
    ],
    [
      "cookingStationTargets",
      { targetId: "cooking_station_0123456789abcdef", location: "Farm", x: 4, y: 5, stationKind: "cookout_kit" },
    ],
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
    ["weedTargets", { targetId: "weed_deadbeef", location: "Farm", x: 10, y: 12, health: 2 }],
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
      "chests",
      {
        chestId: "chest_deadbeef",
        x: 10,
        y: 12,
        displayName: "Chest",
        isFridge: false,
        items: [{ slot: 0, qualifiedItemId: "(O)388", displayName: "Wood", stack: 1 }],
      },
    ],
    [
      "shippingBinTargets",
      {
        targetId: "shipping_bin_0123456789abcdef",
        x: 71,
        y: 14,
        slot: 2,
        qualifiedItemId: "(O)24",
        displayName: "Parsnip",
        stack: 1,
      },
    ],
    // The remaining published families. `tailoringTargets` and `farmBuildingTargets`
    // carry a `kind` union; `tailoringTargets` also carries the two optional garment
    // members the bridge omits rather than nulls.
    [
      "fishPondTargets",
      {
        targetId: "fish_pond_deadbeef",
        location: "Farm",
        x: 10,
        y: 12,
        buildingType: "(BC)FishPond",
        occupants: 1,
        fishType: "(O)145",
      },
    ],
    [
      "farmBuildingTargets",
      {
        targetId: "farm_building_deadbeef",
        kind: "build_site",
        location: "Farm",
        x: 10,
        y: 12,
        buildingType: "Coop",
        displayName: "Coop",
        buildCost: 4000,
        buildDays: 3,
        buildingId: "",
        daysOfConstructionLeft: -1,
      },
    ],
    ["dailyQuestTargets", { targetId: "daily_quest_deadbeef", questType: 1, title: "Bring Robin 10 Wood" }],
    [
      "specialOrderTargets",
      { targetId: "special_order_deadbeef", questKey: "Robin", orderType: "Town", generationSeed: 1 },
    ],
    ["museumRewardTargets", { targetId: "museum_reward_deadbeef", location: "ArchaeologyHouse", rewardCount: 1 }],
    [
      "tailoringTargets",
      {
        targetId: "tailoring_deadbeef",
        kind: "recipe",
        leftSlot: 2,
        rightSlot: 3,
        leftQualifiedItemId: "(O)428",
        rightQualifiedItemId: "(O)440",
        outputQualifiedItemId: "(S)1000",
      },
    ],
  ];
  for (const [field] of targets)
    assert.ok(hostSnapshotFields.includes(field), `sample ${field} is not a snapshot field the Host diagnoses`);
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

test("a chest reports every item it holds, and neither the schema nor the Host bounds its contents", async () => {
  // The invariant, not an incidental: perception mirrors the world. A container that lost items on the way to the
  // Host would answer "this chest is empty" for a chest the player is looking at, which is exactly the defect the
  // flattened (container x item) families could not avoid - they truncated pairs and disclosed the loss with a
  // separate count. So the population below is derived from the CONTAINER CAP and asserted against the more
  // generous side: a chest may hold more than the cap allows containers, and still arrives whole.
  const validate = await schemaValidator();
  const { defs, families } = await snapshotSchema();
  const containerCap = new Map<string, number>(SNAPSHOT_FAMILY_RULES.map((rule) => [rule.field, rule.maxItems])).get(
    "chests",
  );
  assert.ok(containerCap !== undefined, "the Host caps the chests family, so the cap exists to read");
  const chestDefinition = defs.chest as SchemaNode;
  assert.ok(chestDefinition, "the schema declares the chest definition the snapshot family references");
  const items = (chestDefinition.properties as Record<string, SchemaNode>).items as SchemaNode;
  assert.equal(items.maxItems, undefined, "a container's contents carry no schema cap: the mirror is complete");

  const itemsHeld = containerCap + 2;
  const chest = {
    chestId: "chest_0123456789abcdef",
    x: 4,
    y: 5,
    displayName: "Chest",
    isFridge: false,
    items: Array.from({ length: itemsHeld }, (_, slot) => ({
      slot,
      qualifiedItemId: `(O)${100 + slot}`,
      displayName: `Item ${slot}`,
      stack: slot + 1,
    })),
  };
  const message = {
    protocolVersion: 1,
    messageId: "schema_contract_chests",
    correlationId: "schema_contract_chests",
    timestampMs: Date.now(),
    scope: schemaContractScope,
    type: "snapshot",
    payload: { ...schemaContractBase, chests: [chest] },
  };
  assert.equal(validate(message), true, JSON.stringify(validate.errors));
  assert.equal(diagnoseBridgeMessage(message, schemaContractScope), "accepted");
  assert.equal(validateBridgeMessage(message, schemaContractScope), null);
  // The Host hands back what it admitted, item for item: a validator that accepted the frame but a downstream
  // reader that shortened `items` would satisfy the two assertions above and still hide a container's contents.
  const admitted = (message.payload as { chests: readonly { items: readonly { slot: number }[] }[] }).chests[0]!;
  assert.equal(admitted.items.length, itemsHeld);
  assert.deepEqual(
    admitted.items.map((item) => item.slot),
    chest.items.map((item) => item.slot),
  );
  // The bound that DOES apply is the number of containers, and it still refuses one past the cap by name.
  const overCap = {
    ...message,
    payload: { ...message.payload, chests: Array.from({ length: containerCap + 1 }, () => chest) },
  };
  assert.equal(validateBridgeMessage(overCap, schemaContractScope), "invalid_snapshot");
  const refused = diagnoseBridgeMessage(overCap, schemaContractScope);
  assert.ok(
    refused !== null && refused.startsWith("invalid_snapshot:chests"),
    `an over-cap container family was not named: ${refused}`,
  );
  // `families` is the schema's own array list; it must carry the family this test is about.
  assert.ok(
    families.some(([field]) => field === "chests"),
    "the chests family is an array family the schema declares",
  );
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
      weather: "sunny",
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
      weather: "sunny",
      activeExecution: null,
      woodFenceResultTargets: [
        {
          targetId: "wood_fence_deadbeef",
          location: "Farm",
          slot: 4,
          x: 10,
          y: 12,
          qualifiedItemId: "(O)322",
          displayName: "Wood Fence",
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

test("language-neutral schema validates exact break_rock request arguments", async () => {
  const validate = await schemaValidator();
  const [message] = (await fixture("golden-sequence.json")).messages;
  const request = {
    ...(message as Record<string, unknown>),
    type: "execution_request",
    payload: {
      requestId: "request_01",
      idempotencyKey: "idempotency_01",
      action: "break_rock",
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
      weather: "sunny",
      artifactSpotTargets: [
        {
          targetId: "artifact_spot_deadbeef",
          location: "Farm",
          x: 10,
          y: 12,
          qualifiedItemId: "(O)590",
          displayName: "Artifact Spot",
        },
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
          {
            targetId: "artifact_spot_deadbeef",
            location: "Farm",
            x: 10,
            y: 12,
            qualifiedItemId: "(O)SeedSpot",
            displayName: "Artifact Spot",
          },
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
      weather: "sunny",
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
      weather: "sunny",
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

test("language-neutral schema validates exact chop_tree request arguments", async () => {
  const validate = await schemaValidator();
  const [message] = (await fixture("golden-sequence.json")).messages;
  const request = {
    ...(message as Record<string, unknown>),
    type: "execution_request",
    payload: {
      requestId: "request_01",
      idempotencyKey: "idempotency_01",
      action: "chop_tree",
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
      capabilities: ["chop_tree"],
      ...snapshotCatalogFacts,
      presentationLocale: "en-US",
      timeOfDay: 600,
      dayOfMonth: 1,
      seasonIndex: 0,
      year: 1,
      weather: "sunny",
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
    validate({
      ...request,
      payload: {
        ...request.payload,
        args: { destination: { kind: "label", label: "Town" }, destinationRef: "dr1_deadbeef" },
      },
    }),
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
  assert.ok(base !== undefined, "golden-sequence.json must carry a first message");
  const challenge = {
    programId: "program_01",
    nodeId: "node_01",
    nodeAttempt: 1,
    admissionAttempt: 1,
    stopEpoch: 0,
    catalogRevision: 1,
    policyIdentity: { value: "policy:01", capabilityRevision: 1 },
    actionId: "navigate",
    deadlineMs: 9007199254740991,
    canonicalBoundArgs: {
      count: { type: "integer", canonicalValue: "9223372036854775807" },
      text: { type: "string", canonicalValue: "Farm" },
      enabled: { type: "boolean", canonicalValue: "true" },
      destination: { type: "destination_selector", destination: { kind: "label", label: "Farm" } },
      ref: { type: "destination_selector", destination: { kind: "ref", ref: `dr1_${"A".repeat(22)}` } },
    },
    derivedResourceClaims: { actor: "farmhand_01" },
  };
  const binding = {
    programId: challenge.programId,
    nodeId: challenge.nodeId,
    nodeAttempt: 1,
    requestId: "request_01",
    idempotencyKey: "idempotency_01",
    executionId: "execution_01",
  };
  const grant = {
    ...challenge,
    grantId: "grant_01",
    attachmentGeneration: "attachment:01",
    policyRevision: "revision:01",
    executionBinding: binding,
  };
  const frame = (payload: unknown, type = "body_node_admission_challenge") => ({ ...base, type, payload });
  for (const message of [
    frame(challenge),
    frame(grant, "body_node_admission_grant"),
    frame({ ...grant, executionBinding: null }, "body_node_admission_grant"),
  ]) {
    assert.equal(validate(message), true, JSON.stringify(validate.errors));
    const record = message as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const missing = { ...record };
      delete missing[key];
      assert.equal(validate(missing), false, `missing envelope ${key}`);
    }
    assert.equal(validate({ ...message, extra: true }), false);
    for (const [key, value] of Object.entries({
      protocolVersion: 2,
      messageId: "!",
      correlationId: "!",
      timestampMs: 1.5,
      scope: { ...(base.scope as object), extra: true },
      payload: [],
    })) {
      assert.equal(validate({ ...message, [key]: value }), false, `invalid envelope ${key}`);
    }
  }
  for (const [payload, type] of [
    [challenge, "body_node_admission_challenge"],
    [grant, "body_node_admission_grant"],
  ] as const) {
    for (const key of Object.keys(payload)) {
      const missing: Record<string, unknown> = { ...payload };
      delete missing[key];
      assert.equal(validate(frame(missing, type)), false, `missing ${type}.${key}`);
    }
    assert.equal(validate(frame({ ...payload, extra: true }, type)), false);
  }
  assert.equal(validate(frame(grant)), false, "grant is not a challenge");
  assert.equal(validate(frame(challenge, "body_node_admission_grant")), false, "challenge is not a grant");
  assert.equal(
    validate(
      frame({
        ...challenge,
        nodeAttempt: 2147483647,
        admissionAttempt: 2147483647,
        canonicalBoundArgs: Object.fromEntries(
          Array.from({ length: 32 }, (_, i) => [`arg_${i}`, { type: "string", canonicalValue: "" }]),
        ),
        derivedResourceClaims: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`claim_${i}`, "actor"])),
      }),
    ),
    true,
    JSON.stringify(validate.errors),
  );
  const badChallenges = [
    { nodeAttempt: 0 },
    { admissionAttempt: 2147483648 },
    { stopEpoch: -1 },
    { catalogRevision: 9007199254740992 },
    { deadlineMs: 0 },
    { deadlineMs: 9007199254740992 },
    { policyIdentity: { value: "policy" } },
    { policyIdentity: { ...challenge.policyIdentity, extra: true } },
    { policyIdentity: { value: "x".repeat(4097), capabilityRevision: 0 } },
    { policyIdentity: { value: "bad\u0085policy", capabilityRevision: 0 } },
    { policyIdentity: { value: "policy", capabilityRevision: 9007199254740992 } },
    {
      canonicalBoundArgs: Object.fromEntries(
        Array.from({ length: 33 }, (_, i) => [`arg_${i}`, challenge.canonicalBoundArgs.text]),
      ),
    },
    { canonicalBoundArgs: { "bad key": challenge.canonicalBoundArgs.text } },
    { derivedResourceClaims: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`claim_${i}`, "actor"])) },
    { derivedResourceClaims: { "bad key": "actor" } },
    { derivedResourceClaims: { actor: 1 } },
  ];
  for (const patch of badChallenges) {
    assert.equal(validate(frame({ ...challenge, ...patch })), false, JSON.stringify(patch));
    assert.equal(validate(frame({ ...grant, ...patch }, "body_node_admission_grant")), false, JSON.stringify(patch));
  }
  for (const executionBinding of [
    undefined,
    {},
    { ...binding, extra: true },
    { ...binding, nodeAttempt: 0 },
    { ...binding, requestId: "!" },
    { ...binding, executionId: null },
    { ...binding, idempotencyKey: 1 },
  ]) {
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
    { type: "string", canonicalValue: "x".repeat(513) },
    { type: "string" },
    { type: "string", canonicalValue: "ok", extra: true },
    { type: "boolean", canonicalValue: true },
    { type: "boolean", canonicalValue: "False" },
  ])
    assert.equal(validate(canonicalFrame(value)), false, JSON.stringify(value));
  for (const canonicalValue of ["0", "-1", "9223372036854775807", "-9223372036854775808"]) {
    assert.equal(validate(canonicalFrame({ type: "integer", canonicalValue })), true, canonicalValue);
  }
  for (const canonicalValue of [
    "-0",
    "+1",
    "01",
    "1.0",
    "1e3",
    "1\n",
    "9223372036854775808",
    "-9223372036854775809",
    9007199254740992,
  ]) {
    assert.equal(validate(canonicalFrame({ type: "integer", canonicalValue })), false, String(canonicalValue));
  }
  // Exercise every decimal boundary in the Int64 regex against the native BigInt range oracle.
  for (let digits = 0n; digits < 20n; digits++) {
    const step = 10n ** digits;
    for (const limit of [9223372036854775807n, 9223372036854775808n]) {
      const boundary = (limit / step) * step;
      for (const candidate of [boundary - 1n, boundary, boundary + 1n]) {
        for (const integer of [candidate, -candidate]) {
          assert.equal(
            validate(canonicalFrame({ type: "integer", canonicalValue: String(integer) })),
            integer >= -9223372036854775808n && integer <= 9223372036854775807n,
            String(integer),
          );
        }
      }
    }
  }
});

/* ------------------------------------------------------------------------------------------------ *
 * The schema owns the per-family snapshot SHAPE; the Host projects it.
 *
 * `SNAPSHOT_FAMILY_RULES` in `host/src/protocol.ts` is that projection: one declaration per array
 * family, consulted by both `diagnoseSnapshot` and `validateSnapshot`. Every expectation below is
 * derived from `protocol/bridge-v1.schema.json` alone - never from a hand-typed family list - so a
 * family the schema declares and the Host forgets, a bound that changed on one side, and an instance
 * the schema admits while the Host refuses all fail here. The hand-typed probe list this replaces had
 * already drifted: it stopped at `shippingBinTargets` and stayed green while six live families, and
 * then `colorTargets`/`tailoringTargets`, were never probed at all.
 * ------------------------------------------------------------------------------------------------ */

type SchemaNode = Record<string, unknown>;

/** Array members the Host validates outside `SNAPSHOT_FAMILY_RULES`: its two capability lists. Their
 * entries are bare identifiers rather than discovered world targets, and their entry bound is still
 * left to the frame limit, so they are named here rather than silently skipped. */
const SNAPSHOT_ARRAYS_OUTSIDE_THE_FAMILY_TABLE: readonly string[] = Object.freeze(["capabilities", "enabledActionIds"]);

/** Families where the Host is STRICTER than the schema: the language-neutral contract admits an
 * instance the Host would refuse, which is the failure class that once disconnected the bridge.
 * Relaxing them would change what the bridge accepts, so the gap is pinned instead of closed, and the
 * pin fails as soon as the two sides agree so it cannot outlive the divergence. */
const HOST_CAPS_STRICTER_THAN_SCHEMA: ReadonlyMap<string, Readonly<{ host: number; schema: number }>> = new Map([
  ["animalDoorTargets", { host: 32, schema: 64 }],
  ["mineElevatorFloorTargets", { host: 32, schema: 64 }],
  ["obeliskTargets", { host: 32, schema: 64 }],
]);

async function snapshotSchema(): Promise<
  Readonly<{ defs: Record<string, SchemaNode>; families: readonly (readonly [string, SchemaNode])[] }>
> {
  const document = JSON.parse(
    await readFile(fileURLToPath(new URL("../../protocol/bridge-v1.schema.json", import.meta.url)), "utf8"),
  ) as { $defs: Record<string, SchemaNode> };
  const properties = ((document.$defs.snapshot ?? {}) as SchemaNode).properties as Record<string, SchemaNode>;
  return Object.freeze({
    defs: document.$defs,
    families: Object.freeze(Object.entries(properties).filter(([, property]) => property.type === "array")),
  });
}

/** A schema node with its `$ref` inlined, so the generator never needs a second lookup. */
function dereference(defs: Record<string, SchemaNode>, node: SchemaNode): SchemaNode {
  const reference = node.$ref;
  if (typeof reference !== "string") return node;
  const rest: Record<string, unknown> = { ...node };
  delete rest.$ref;
  return { ...(defs[reference.split("/").pop() ?? ""] as SchemaNode), ...rest };
}

/** The characters this suite tries for a pattern's character class, most likely first. It is a plain
 * alphabet rather than a per-property table: membership in a class is decided by that class's OWN
 * regexp (`classWitnesses`), and the finished witness by the whole pattern's own regexp
 * (`patternWitness`), so no string here has to be trusted on its own. */
const WITNESS_ALPHABET: readonly string[] = Object.freeze(["a", "A", "0", "7", "_", "-", "s", "Z", " "]);

/** The characters a character class's own `[...]` admits out of `WITNESS_ALPHABET`, so ranges, escapes
 * and negations are read by the same engine that reads the real frame. */
function classWitnesses(charClass: string): readonly string[] {
  const single = new RegExp(`^[${charClass}]$`);
  return WITNESS_ALPHABET.filter((character) => single.test(character));
}

/** An escape a bare character class does not cover, as the character it matches. */
const ESCAPE_WITNESSES: Readonly<Record<string, string>> = Object.freeze({
  d: "7",
  D: "a",
  w: "a",
  W: "-",
  s: " ",
  S: "a",
});

/** One attempt at a witness: `pass` picks the same-ranked character at every class occurrence, which is
 * enough for the anchored one- and two-class patterns the families carry and stays bounded when a
 * pattern has more. `null` means this walk cannot express the pattern at all - a group, an unclosed
 * class - which `patternWitness` reports rather than guessing past. */
function walkPattern(pattern: string, pass: number): string | null {
  const body = pattern
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\(\?!\[\\s\\S\]\)$/, "");
  let out = "";
  for (let index = 0; index < body.length; ) {
    if (body[index] === "[") {
      const end = body.indexOf("]", index);
      if (end < 0) return null;
      const witnesses = classWitnesses(body.slice(index + 1, end));
      if (witnesses.length === 0) return null;
      const character = witnesses[Math.min(pass, witnesses.length - 1)] as string;
      index = end + 1;
      const quantifier = /^\{(\d+)(?:,\d+)?\}/.exec(body.slice(index));
      if (quantifier === null) {
        out += character;
        continue;
      }
      index += quantifier[0].length;
      out += character.repeat(Number(quantifier[1]));
      continue;
    }
    if (body[index] === "\\") {
      const escaped = body[index + 1] ?? "";
      out += ESCAPE_WITNESSES[escaped] ?? escaped;
      index += 2;
      continue;
    }
    // A group needs a real regexp witness. Refusing loudly keeps an unsupported pattern from silently
    // shrinking this suite's coverage instead of standing in a value the schema itself would refuse.
    if (body[index] === "(") return null;
    // A quantifier applies to whatever preceded it, so it consumes no character of its own.
    if (body[index] === "+" || body[index] === "*" || body[index] === "?") {
      index += 1;
      continue;
    }
    out += body[index];
    index += 1;
  }
  return out;
}

/** A witness the pattern's OWN regexp accepts, or a blocked failure naming where the pattern came from.
 * The previous version built a string from the pattern and returned it unchecked, so a witness the
 * schema itself refuses was then reported as the HOST refusing what the schema declares - which the gate
 * cannot tell apart from the two sides really disagreeing. */
function patternWitness(pattern: string, where: string): string {
  const accepts = new RegExp(pattern);
  const tried = new Set<string>();
  for (let pass = 0; pass < WITNESS_ALPHABET.length; pass += 1) {
    const candidate = walkPattern(pattern, pass);
    if (candidate === null || tried.has(candidate)) continue;
    tried.add(candidate);
    if (accepts.test(candidate)) return candidate;
  }
  throw new Error(`${where}: no witness of the schema's own pattern ${pattern} was found`);
}

/** Whether a conditional's `if` selects the instance it is asked about, answered by the schema's own
 * evaluator rather than by reading the condition here. */
function conditionHolds(condition: SchemaNode, instance: unknown): boolean {
  return new Ajv2020({ strict: false }).compile(condition)(instance) === true;
}

/** The value this node's OWN keywords admit, before any `allOf` narrowing. */
function generateOwnValue(defs: Record<string, SchemaNode>, schema: SchemaNode, where: string, depth: number): unknown {
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (Array.isArray(schema.oneOf)) return generateSchemaValue(defs, schema.oneOf[0] as SchemaNode, where, depth + 1);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length === 1 && types[0] === "null") return null;
  const type = types.find((candidate) => candidate !== "null");
  if (type === "string") {
    if (typeof schema.pattern === "string") return patternWitness(schema.pattern, where);
    const length = Math.max(1, typeof schema.minLength === "number" ? schema.minLength : 1);
    return "s".repeat(typeof schema.maxLength === "number" ? Math.min(length, schema.maxLength) : length);
  }
  if (type === "integer" || type === "number") {
    const base =
      typeof schema.exclusiveMinimum === "number"
        ? schema.exclusiveMinimum + 1
        : Math.max(typeof schema.minimum === "number" ? schema.minimum : 0, 0);
    return typeof schema.maximum === "number" ? Math.min(base, schema.maximum) : base;
  }
  if (type === "boolean") return false;
  if (type === "array") {
    const length = Math.max(1, typeof schema.minItems === "number" ? schema.minItems : 1);
    return Array.from({ length }, () => generateSchemaValue(defs, schema.items as SchemaNode, where, depth + 1));
  }
  if (type === "object" || schema.properties !== undefined) {
    const properties = (schema.properties ?? {}) as Record<string, SchemaNode>;
    const generated: Record<string, unknown> = {};
    for (const key of (schema.required ?? []) as string[])
      generated[key] = generateSchemaValue(defs, properties[key] as SchemaNode, `${where}.${key}`, depth + 1);
    // A member the schema pins to one value is always written by the Mod, so it belongs to the
    // smallest faithful instance even when the schema does not require it.
    for (const [key, property] of Object.entries(properties)) {
      if (key in generated) continue;
      const resolved = dereference(defs, property);
      if (resolved.const !== undefined || Array.isArray(resolved.enum))
        generated[key] = generateSchemaValue(defs, property, `${where}.${key}`, depth + 1);
    }
    return generated;
  }
  throw new Error(`${where}: unsupported schema node: ${JSON.stringify(schema).slice(0, 200)}`);
}

/** The smallest instance the schema admits for this node; throws on a keyword it cannot witness. `where`
 * is the family and property path, so a blocked generation names what it could not witness instead of
 * leaving the reader to guess which family produced it. */
function generateSchemaValue(defs: Record<string, SchemaNode>, node: SchemaNode, where: string, depth = 0): unknown {
  if (depth > 12) throw new Error(`${where}: schema_contract_generation_too_deep`);
  const schema = dereference(defs, node);
  // A def can carry its own shape beside an `allOf` that narrows it, or delegate the whole shape to the
  // parts, so the merge starts from the node's own value and `{}` stands in when there is nothing else.
  const delegatesShape =
    Array.isArray(schema.allOf) &&
    schema.type === undefined &&
    schema.properties === undefined &&
    schema.const === undefined &&
    !Array.isArray(schema.enum) &&
    !Array.isArray(schema.oneOf);
  const own = delegatesShape ? {} : generateOwnValue(defs, schema, where, depth);
  if (!Array.isArray(schema.allOf)) return own;
  if (own === null || typeof own !== "object" || Array.isArray(own))
    throw new Error(`${where}: an allOf narrowed a value that is not an object`);
  let merged = own as Record<string, unknown>;
  for (const part of schema.allOf) {
    const branchNode = dereference(defs, part as SchemaNode);
    // A conditional in the same `allOf` narrows what the parts BEFORE it produced - the families express
    // their coupled shapes this way - so its branch is chosen against the merged instance so far and laid
    // over it. Reading the condition through the schema's own evaluator keeps this walk from owning a
    // second opinion about what it means.
    const chosen =
      branchNode.if === undefined
        ? branchNode
        : conditionHolds(branchNode.if as SchemaNode, merged)
          ? (branchNode.then as SchemaNode | undefined)
          : (branchNode.else as SchemaNode | undefined);
    if (chosen === undefined) continue;
    const narrowed = generateSchemaValue(defs, chosen, where, depth + 1);
    if (narrowed === null || typeof narrowed !== "object" || Array.isArray(narrowed))
      throw new Error(`${where}: an allOf part admitted a value that is not an object`);
    merged = { ...merged, ...(narrowed as Record<string, unknown>) };
  }
  return merged;
}

const schemaContractScope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};

const schemaContractBase = Object.freeze({
  revision: 2,
  location: "Farm",
  tile: { x: 10, y: 11 },
  stamina: 100,
  exhausted: false,
  health: 100,
  actionable: true,
  capabilities: [] as readonly string[],
  catalogRevision: 1,
  enabledActionIds: [] as readonly string[],
  presentationLocale: "en-US",
  timeOfDay: 600,
  dayOfMonth: 1,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
  activeExecution: null,
});

function snapshotWith(field: string, entries: readonly unknown[]): unknown {
  return {
    protocolVersion: 1,
    messageId: `schema_contract_${field}`,
    correlationId: `schema_contract_${field}`,
    timestampMs: Date.now(),
    scope: schemaContractScope,
    type: "snapshot",
    payload: { ...schemaContractBase, [field]: entries },
  };
}

test("the schema owns every snapshot family bound the Host projects", async () => {
  const { families } = await snapshotSchema();
  const rules = new Map<string, SnapshotFamilyRule>(SNAPSHOT_FAMILY_RULES.map((rule) => [rule.field, rule]));
  assert.deepEqual(
    families
      .map(([field]) => field)
      .filter((field) => !rules.has(field))
      .sort(),
    [...SNAPSHOT_ARRAYS_OUTSIDE_THE_FAMILY_TABLE].sort(),
    "every array family the schema declares must be validated by the Host, except the named capability lists",
  );
  const schemaFields = new Set(families.map(([field]) => field));
  for (const rule of SNAPSHOT_FAMILY_RULES)
    assert.ok(
      schemaFields.has(rule.field),
      `${rule.field} is validated by the Host but the schema declares no such array family`,
    );
  for (const [field, family] of families) {
    const rule = rules.get(field);
    if (rule === undefined) continue;
    const schemaMaxItems = family.maxItems as number;
    const stricter = HOST_CAPS_STRICTER_THAN_SCHEMA.get(field);
    assert.equal(
      rule.maxItems,
      stricter === undefined ? schemaMaxItems : stricter.host,
      `${field}: the Host cap must be the schema's, or a named divergence`,
    );
    assert.ok(
      rule.maxItems <= schemaMaxItems,
      `${field}: the Host must not admit more entries than the schema declares`,
    );
    if (stricter !== undefined)
      assert.equal(
        schemaMaxItems,
        stricter.schema,
        `${field} now agrees with the schema, so drop it from HOST_CAPS_STRICTER_THAN_SCHEMA`,
      );
  }
});

test("the Host admits the schema's own smallest instance of every snapshot family", async (t) => {
  const validate = await schemaValidator();
  const { defs, families } = await snapshotSchema();
  assert.ok(families.length > 0, "the schema declares snapshot families, so this population cannot be zero");
  t.diagnostic(`families examined ${families.length}`);
  // Three readings per family, and the order matters: the first asks whether the SAMPLE is a value the
  // schema itself admits, and only then whether the Host agrees with it. Before this, a witness the
  // schema refused was reported as `invalid_snapshot:<family>` - a Host/Mod disagreement that did not
  // exist - because the generator returned a pattern witness without checking it against the pattern.
  // Every family is sampled and reported, not just the first that breaks.
  const disagreed: string[] = [];
  for (const [field, family] of families) {
    const sample = generateSchemaValue(defs, family.items as SchemaNode, field);
    const message = snapshotWith(field, [sample]);
    if (validate(message) !== true)
      disagreed.push(
        `${field}: the generator built ${JSON.stringify(sample)}, which the schema itself refuses: ${JSON.stringify(validate.errors)}`,
      );
    const host = diagnoseBridgeMessage(message, schemaContractScope);
    if (host !== "accepted") disagreed.push(`${field}: the Host answered ${host} for ${JSON.stringify(sample)}`);
    const detail = validateBridgeMessage(message, schemaContractScope);
    if (detail !== null)
      disagreed.push(`${field}: the Host's typed reader answered ${detail} for ${JSON.stringify(sample)}`);
  }
  assert.deepEqual(disagreed, [], `families examined ${families.length}: both sides must admit every sample`);
});

test("the Host refuses a snapshot family entry the schema's shape does not allow, naming the field", async () => {
  const { defs, families } = await snapshotSchema();
  const caps = new Map<string, number>(SNAPSHOT_FAMILY_RULES.map((rule) => [rule.field, rule.maxItems]));
  for (const [field, family] of families) {
    const sample = generateSchemaValue(defs, family.items as SchemaNode, field);
    const maxItems = caps.get(field);
    if (maxItems !== undefined) {
      const message = snapshotWith(
        field,
        Array.from({ length: maxItems + 1 }, () => sample),
      );
      assert.equal(
        validateBridgeMessage(message, schemaContractScope),
        "invalid_snapshot",
        `${field} accepted ${maxItems + 1} entries`,
      );
      const refused = diagnoseBridgeMessage(message, schemaContractScope);
      assert.ok(
        refused !== null && refused.startsWith(`invalid_snapshot:${field}`),
        `${field} over its cap was not named: ${refused}`,
      );
    }
    if (sample === null || typeof sample !== "object" || Array.isArray(sample)) continue;
    const message = snapshotWith(field, [{ ...sample, unexpected: true }]);
    assert.equal(
      validateBridgeMessage(message, schemaContractScope),
      "invalid_snapshot",
      `${field} accepted an unknown key`,
    );
    const refused = diagnoseBridgeMessage(message, schemaContractScope);
    assert.ok(
      refused !== null && refused.startsWith(`invalid_snapshot:${field}`),
      `${field} with an unknown key was not named: ${refused}`,
    );
  }
});

test("the language-neutral schema admits a whereabouts row with no tile and refuses one with half a tile", async () => {
  // The Mod omits the pair for every map the actor is not standing on, so a schema consumer that demanded both would
  // refuse the snapshot the Mod actually sends - and one that accepted half a tile would let `x` and `y` come from
  // different readings of one address. Both directions are asserted here because the schema, not the Host, is what a
  // non-TypeScript consumer validates against.
  const validate = await schemaValidator();
  const families: readonly (readonly [string, Record<string, number>])[] = [
    ["harvestWhereabouts", { readyForHarvestCount: 3 }],
    ["wateringWhereabouts", { needsWaterCount: 12 }],
  ];
  for (const [field, count] of families) {
    const row = { location: "Farm", ...count };
    assert.equal(validate(snapshotWith(field, [row])), true, `${field}: ${JSON.stringify(validate.errors)}`);
    assert.equal(
      validate(snapshotWith(field, [{ ...row, nearestX: 4, nearestY: 9 }])),
      true,
      `${field}: ${JSON.stringify(validate.errors)}`,
    );
    for (const half of [{ nearestX: 4 }, { nearestY: 9 }]) {
      assert.equal(
        validate(snapshotWith(field, [{ ...row, ...half }])),
        false,
        `${field} admitted ${JSON.stringify(half)}`,
      );
      // The Host applies the same rule to the same row: a schema that is looser than the Host is a frame the Mod may send
      // and the bridge then refuses whole.
      assert.equal(
        validateBridgeMessage(snapshotWith(field, [{ ...row, ...half }]), schemaContractScope),
        "invalid_snapshot",
      );
    }
  }
});

test("the schema and the Host agree on the seed supply address half: exactly one of three", async () => {
  // The Mod writes EXACTLY ONE of these three on every supply row, and the language-neutral schema is what a
  // non-TypeScript consumer validates against - so a schema that admitted a row with none (or with two) would let a
  // frame through that the Host then refuses whole, and a schema that refused one of the three would refuse a snapshot
  // the Mod genuinely sends. Both ends are asserted over the same rows for that reason.
  const validate = await schemaValidator();
  const counter = { location: "SeedShop", targetId: "shop_0123456789abcdef", tile: { x: 12, y: 14 }, label: "Pierre" };
  const seed = (address: Record<string, unknown>): Record<string, unknown> => ({
    qualifiedItemId: "(O)472",
    displayName: "Parsnip Seeds",
    ...address,
  });
  const admitted = [
    seed({ shopDestination: counter }),
    seed({ shopLocation: "SeedShop" }),
    seed({ shopLocationUnknown: "no_shop_stocks_this_seed" }),
    // Both bounds at their edges: the tile's own 0..1000 and the two string bounds.
    seed({ shopDestination: { ...counter, tile: { x: 0, y: 1000 } } }),
    seed({ shopLocation: "s".repeat(256) }),
    seed({ shopLocationUnknown: "s".repeat(64) }),
  ];
  for (const row of admitted) {
    assert.equal(validate(snapshotWith("seedSupplyTargets", [row])), true, `${JSON.stringify(validate.errors)}`);
    assert.equal(diagnoseBridgeMessage(snapshotWith("seedSupplyTargets", [row]), schemaContractScope), "accepted");
  }
  const refusedRows = [
    ["no address at all", seed({})],
    ["a destination and a location", seed({ shopLocation: "SeedShop", shopDestination: counter })],
    ["a destination and a reason", seed({ shopDestination: counter, shopLocationUnknown: "shop_location_unreadable" })],
    ["a minted id", seed({ shopDestination: { ...counter, targetId: "counter_0123456789abcdef" } })],
    ["a short id", seed({ shopDestination: { ...counter, targetId: "shop_0123456789abcde" } })],
    ["a tile below zero", seed({ shopDestination: { ...counter, tile: { x: -1, y: 14 } } })],
    ["a tile above 1000", seed({ shopDestination: { ...counter, tile: { x: 1001, y: 14 } } })],
    ["a fifth destination key", seed({ shopDestination: { ...counter, ownerTileX: 12 } })],
    ["an empty location", seed({ shopLocation: "" })],
    ["a 65-character reason", seed({ shopLocationUnknown: "s".repeat(65) })],
  ] as const;
  for (const [label, row] of refusedRows) {
    assert.equal(validate(snapshotWith("seedSupplyTargets", [row])), false, `the schema admitted ${label}`);
    assert.equal(
      validateBridgeMessage(snapshotWith("seedSupplyTargets", [row]), schemaContractScope),
      "invalid_snapshot",
      `the Host admitted ${label}`,
    );
  }
});
