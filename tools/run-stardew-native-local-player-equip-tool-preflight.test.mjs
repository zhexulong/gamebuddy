import assert from "node:assert/strict";
import test from "node:test";
import {
  createEquipToolPreflightForTest,
  runEquipToolPreflight,
} from "./run-stardew-native-local-player-equip-tool-preflight.mjs";

const scope = Object.freeze({
  integrationId: "stardew",
  saveId: "save_redacted",
  worldId: "world_redacted",
  playerId: "player_redacted",
  companionId: "companion_redacted",
});

function snapshot(overrides = {}) {
  return {
    revision: 9,
    location: "Farm",
    tile: { x: 1, y: 2 },
    actionable: true,
    activeExecution: null,
    capabilities: ["cancel_active_execution", "equip_tool"],
    toolSlots: [
      { slot: 0, label: "Axe" },
      { slot: 1, label: "Hoe" },
    ],
    currentTool: "Axe",
    ...overrides,
  };
}

function factory({ observed = snapshot(), published = ["equip_tool"], execute, scope: injectedScope = scope } = {}) {
  let observes = 0;
  let closes = 0;
  const client = {
    state: { snapshot: observed },
    observe: async () => {
      observes += 1;
      return observed;
    },
    ...(execute ? { execute } : {}),
  };
  const preflight = createEquipToolPreflightForTest({
    client,
    scope: injectedScope,
    readPublishedActionIds: async () => published,
    close: () => {
      closes += 1;
    },
  });
  return {
    preflight,
    counts: () => ({ observes, closes }),
    close: () => {
      closes += 1;
    },
  };
}

async function runCase(options) {
  const fixture = factory(options);
  try {
    const result = await fixture.preflight.run();
    return { result, counts: fixture.counts() };
  } finally {
    if (fixture.counts().closes === 0) fixture.close();
  }
}

test("READY observes exactly one fresh snapshot, checks publication parity, and never executes", async () => {
  let executeCalls = 0;
  const { result, counts } = await runCase({ execute: async () => { executeCalls += 1; } });
  assert.equal(result.state, "READY");
  assert.equal(result.freshSnapshotCount, 1);
  assert.equal(result.capabilityDeclared, true);
  assert.equal(result.publicationDeclared, true);
  assert.equal(result.eligibleToolSlotCount, 2);
  assert.deepEqual(result.reasons, []);
  assert.equal(executeCalls, 0);
  assert.deepEqual(counts, { observes: 1, closes: 1 });
  assert.equal(JSON.stringify(result).includes("save_redacted"), false);
  assert.equal(JSON.stringify(result).includes("player_redacted"), false);
});

test("each required blocked reason fails closed without execute", async () => {
  const cases = [
    [{ observed: snapshot({ actionable: false }) }, "snapshot_non_actionable"],
    [{ observed: snapshot({ activeExecution: { executionId: "opaque", requestId: "opaque", state: "running" } }) }, "active_execution"],
    [{ observed: snapshot({ capabilities: ["cancel_active_execution"] }) }, "capability_mismatch"],
    [{ published: ["move_to_tile"] }, "publication_mismatch"],
    [{ observed: snapshot({ toolSlots: [] }) }, "no_eligible_tool_slot"],
    [{ scope: { ...scope, integrationId: "other" } }, "scope_mismatch"],
    [{ observed: null }, "snapshot_unavailable"],
    [{ published: null }, "publication_mismatch"],
  ];
  for (const [options, reason] of cases) {
    const fixture = factory(options);
    try {
      const result = await fixture.preflight.run();
      assert.equal(result.state, "BLOCKED", reason);
      assert.equal(result.ready, false, reason);
      assert.equal(result.reasons.includes(reason), true, reason);
      assert.equal(result.freshSnapshotCount <= 1, true, reason);
    } finally {
      if (fixture.counts().closes === 0) fixture.close();
    }
  }
});

test("malformed and unavailable dependencies are blocked and output stays redacted", async () => {
  const unavailable = await runEquipToolPreflight({ client: null, scope });
  assert.equal(unavailable.state, "BLOCKED");
  assert.equal(unavailable.reasons.includes("bridge_unavailable"), true);

  const malformed = await runEquipToolPreflight({
    client: { observe: async () => ({ revision: "bad" }) },
    scope,
    readPublishedActionIds: async () => ["equip_tool"],
  });
  assert.equal(malformed.state, "BLOCKED");
  assert.equal(malformed.reasons.includes("snapshot_unavailable"), true);
  assert.equal(JSON.stringify(malformed).includes("opaque"), false);
  assert.equal(JSON.stringify(malformed).includes("save_redacted"), false);
  assert.equal(JSON.stringify(malformed).includes("player_redacted"), false);
});

test("factory closes in blocked paths and no branch calls execute", async () => {
  let executeCalls = 0;
  for (const options of [
    { observed: snapshot({ actionable: false }) },
    { published: ["other_action"] },
    { observed: snapshot({ toolSlots: [] }) },
  ]) {
    const fixture = factory({ ...options, execute: async () => { executeCalls += 1; } });
    try {
      assert.equal((await fixture.preflight.run()).state, "BLOCKED");
    } finally {
      if (fixture.counts().closes === 0) fixture.close();
    }
    assert.deepEqual(fixture.counts(), { observes: 1, closes: 1 });
  }
  assert.equal(executeCalls, 0);
});
