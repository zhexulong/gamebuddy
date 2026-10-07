import assert from "node:assert/strict";
import test from "node:test";
import { runWithdrawSiloHaySmoke } from "./run-stardew-native-local-player-withdraw-silo-hay-smoke.mjs";

const HAY = "(O)178";

const scope = { integrationId: "stardew", saveId: "save", worldId: "world", playerId: "player", companionId: "companion" };

/** A snapshot the runner can act on: one adjacent stocked Silo, no Hay carried. */
function snapshotWith({ revision, siloHay, carried }) {
  return {
    revision,
    location: "Farm",
    tile: { x: 15, y: 8 },
    actionable: true,
    activeExecution: null,
    capabilities: ["cancel_active_execution", "inspect_self", "withdraw_silo_hay"],
    siloTargets: [{ targetId: "silo-target", x: 16, y: 8, hay: siloHay }],
    inventoryItemFacts: carried > 0 ? [{ qualifiedItemId: HAY, stack: carried }] : [],
  };
}

/**
 * The runner is the thing under test, so the client is a real one in shape: it answers the same
 * calls the harness makes and moves the world the way the native call would.
 */
function makeClient({ siloHay, carried }) {
  let snapshot = snapshotWith({ revision: 1, siloHay, carried });
  const receipts = [];
  const client = {
    state: { snapshot },
    // Read through the client, not a closure: a test that rewrites state must change what the
    // runner observes, or it silently tests nothing.
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      const receipt =
        request.args.expectedTargetId === "silo-target" && snapshot.siloTargets[0].hay >= 1
          ? {
              requestId: request.requestId,
              executionId: "silo-execution",
              state: "succeeded",
              reasonCode: "silo_hay_taken",
              revision: snapshot.revision + 1,
              evidence: {
                detail:
                  `target=silo-target;item=${HAY}` +
                  `;silo_hay_before=${snapshot.siloTargets[0].hay};silo_hay_after=${snapshot.siloTargets[0].hay - 1};silo_hay_decreased=true` +
                  `;carried_before=${snapshot.inventoryItemFacts[0]?.stack ?? 0};carried_after=${(snapshot.inventoryItemFacts[0]?.stack ?? 0) + 1};carried_hay_increased=true`,
              },
            }
          : {
              requestId: request.requestId,
              executionId: "silo-execution-refused",
              state: "rejected",
              reasonCode: "silo_empty",
              revision: snapshot.revision + 1,
              evidence: { detail: `target=silo-target;silo_hay=0` },
            };
      if (receipt.state === "succeeded") {
        snapshot = {
          ...snapshot,
          revision: receipt.revision,
          siloTargets: [{ targetId: "silo-target", x: 16, y: 8, hay: 0 }],
          inventoryItemFacts: [{ qualifiedItemId: HAY, stack: (snapshot.inventoryItemFacts[0]?.stack ?? 0) + 1 }],
        };
        client.state.snapshot = snapshot;
      }
      receipts.push(receipt);
      return receipt;
    },
  };
  return { client, receipts };
}

test("withdraw_silo_hay: the transfer is asserted from the world, both halves", async () => {
  const { client, receipts } = makeClient({ siloHay: 1, carried: 0 });
  const result = await runWithdrawSiloHaySmoke(client, receipts, {}, { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "passed");
  assert.equal(result.siloHay.before, 1);
  assert.equal(result.siloHay.after, 0);
  assert.equal(result.carriedHay.before, 0);
  assert.equal(result.carriedHay.after, 1);
});

test("withdraw_silo_hay: a silo that did not lose hay fails the run", async () => {
  // The one-sided case the action's own rule forbids: the actor gained Hay but the silo did not
  // drop, which is duplication rather than a transfer.
  const { client, receipts } = makeClient({ siloHay: 1, carried: 0 });
  const original = client.execute;
  client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded") {
      client.state.snapshot = { ...client.state.snapshot, siloTargets: [{ targetId: "silo-target", x: 16, y: 8, hay: 1 }] };
    }
    return receipt;
  };
  const result = await runWithdrawSiloHaySmoke(client, receipts, {}, { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "blocked", "a silo that still holds its hay must not be a pass");
});

test("withdraw_silo_hay: hay that left the silo without arriving fails the run", async () => {
  // The opposite half of the transfer rule: the silo store drops but the actor gains nothing, so the
  // hay was destroyed rather than moved. Without this case the carried-side guard is untested —
  // mutation testing showed removing it changed no result.
  const { client, receipts } = makeClient({ siloHay: 1, carried: 0 });
  const original = client.execute;
  client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.state === "succeeded") {
      client.state.snapshot = { ...client.state.snapshot, inventoryItemFacts: [] };
    }
    return receipt;
  };
  const result = await runWithdrawSiloHaySmoke(client, receipts, {}, { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "blocked", "hay that vanished between silo and actor must not be a pass");
});

test("withdraw_silo_hay: the emptied silo is refused, and a silent no-op fails", async () => {
  // Negative case. If the second withdrawal were reported as success, or silently no-oped, the run
  // must fail rather than accept a green receipt.
  const { client, receipts } = makeClient({ siloHay: 1, carried: 0 });
  const result = await runWithdrawSiloHaySmoke(client, receipts, {}, { terminalTimeoutMs: 1_000 });
  assert.equal(result.state, "passed");
  assert.equal(result.negative.reasonCode, "silo_empty");

  const forged = makeClient({ siloHay: 1, carried: 0 });
  const original = forged.client.execute;
  forged.client.execute = async (request) => {
    const receipt = await original(request);
    if (receipt.reasonCode === "silo_empty") {
      receipt.state = "succeeded";
      receipt.reasonCode = "silo_hay_taken";
    }
    return receipt;
  };
  const forgedResult = await runWithdrawSiloHaySmoke(forged.client, forged.receipts, {}, { terminalTimeoutMs: 1_000 });
  assert.equal(forgedResult.state, "blocked", "a second withdrawal that claims success must fail the run");
});
