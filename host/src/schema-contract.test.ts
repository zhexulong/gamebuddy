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

test("language-neutral schema validates exact tree_first_hit request arguments", async () => {
  const validate = await schemaValidator();
  const [message] = (await fixture("golden-sequence.json")).messages;
  const request = {
    ...(message as Record<string, unknown>),
    type: "execution_request",
    payload: {
      requestId: "request_01",
      idempotencyKey: "idempotency_01",
      action: "tree_first_hit",
      args: { slot: 4, x: 10, y: 12, expectedTargetId: "tree_deadbeef" },
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
        args: { slot: 37, x: 10, y: 12, expectedTargetId: "tree_deadbeef" },
      },
    }),
    false,
  );
  assert.equal(
    validate({
      ...request,
      payload: {
        ...(request.payload as Record<string, unknown>),
        args: { slot: 4, x: 10.5, y: 12, expectedTargetId: "tree_deadbeef" },
      },
    }),
    false,
  );
  assert.equal(
    validate({
      ...request,
      payload: {
        ...(request.payload as Record<string, unknown>),
        args: { slot: 4, x: 10, y: 12, expectedTargetId: "bad target" },
      },
    }),
    false,
  );
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
