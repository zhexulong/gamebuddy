import assert from "node:assert/strict";
import test from "node:test";
import { runMoveSmoke } from "./run-stardew-native-local-player-move-smoke.mjs";

function snapshot(revision = 7, tile = { x: 2, y: 2 }) {
  return {
    revision,
    tile,
    actionable: true,
    capabilities: ["inspect_self", "cancel_active_execution", "move_to_tile"],
  };
}

test("native-local move runner exercises deterministic mocked bridge contract", async () => {
  let revision = 7;
  let tile = { x: 2, y: 2 };
  const receipts = [];
  const client = {
    state: { snapshot: snapshot() },
    observe: async () => ({ ...snapshot(revision, tile), activeExecution: null }),
    execute: async ({ requestId }) => {
      const executionId = "execution-1";
      revision += 1;
      tile = { x: 2, y: 1 };
      const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
      receipts.push(receipt, { ...receipt, state: "succeeded", reasonCode: "target_reached", revision });
      return receipt;
    },
  };
  const result = await runMoveSmoke(client, receipts, { NativeLocalPlayerFixture: { Enable: true } });
  assert.equal(result.state, "passed");
  assert.equal(result.success.terminal.reasonCode, "target_reached");
  assert.deepEqual(result.success.after.tile, { x: 2, y: 1 });
});

test("native-local move runner rejects a surface missing a required capability", async () => {
  // A superset is legitimate now: the fixture denies nothing, so a live run
  // advertises the whole derived base. What must still fail closed is a surface
  // that omits a capability this run needs.
  const client = {
    state: { snapshot: snapshot() },
    observe: async () => ({
      ...snapshot(),
      capabilities: ["inspect_self", "cancel_active_execution", "travel"],
    }),
  };
  await assert.rejects(
    runMoveSmoke(client, [], { NativeLocalPlayerFixture: { Enable: true } }),
    // The shared code carries the offending capability as a suffix.
    (error) => String(error?.code ?? error?.message ?? "").startsWith("native_required_capability_missing"),
  );
});
