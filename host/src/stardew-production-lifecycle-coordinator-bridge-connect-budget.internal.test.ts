import assert from "node:assert/strict";
import test from "node:test";
import {
  STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS,
  STARDEW_FARMHAND_JOIN_BASE_BUDGET_MS,
  stardewFarmhandBridgeConnectDeadlineMs,
  stardewFarmhandJoinBudgetMs,
} from "./stardew-production-lifecycle-coordinator.internal.js";
import {
  confirmFirstCabin,
  connectedSemanticGameLeaseFixture,
  installLifecycleTestHooks,
  prepareCabinCoordinator,
} from "./stardew-production-lifecycle-coordinator.test-support.js";

installLifecycleTestHooks();

/**
 * The budget of ONE authenticated bridge connect attempt, and why it is not the
 * join.
 *
 * The join budget is a ceiling for a whole attach, and it is a workload term (the
 * player's Mods). A single connect/`hello` attempt used to be handed all of it,
 * so a Mod whose game thread stopped answering owned the entire join - and the
 * exit, which must join an attach already in flight, inherited that ceiling. These
 * readings are the two halves of the fix: the derivation never extends a shorter
 * join, and the coordinator really passes it to the connect instead of the join.
 */
test("one bridge connect attempt owns its own budget, never more than the join still allows", () => {
  const nowMs = 1_800_000_000_000;
  // A whole join - the base budget for a world with no player Mods up to the
  // ten-minute admission ceiling - is not what one attempt gets.
  for (const playerMods of [0, 10, 100, 450, 1_000]) {
    const joinDeadlineMs = nowMs + Math.min(600_000, stardewFarmhandJoinBudgetMs(playerMods));
    assert.equal(
      stardewFarmhandBridgeConnectDeadlineMs(joinDeadlineMs, nowMs),
      nowMs + STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS,
      `a ${playerMods}-player-Mod join must still cap one attempt at the connect budget`,
    );
  }
  // A join with less left than the budget is never extended by it.
  assert.equal(stardewFarmhandBridgeConnectDeadlineMs(nowMs + 10_000, nowMs), nowMs + 10_000);
  // An already-expired join stays expired: the attempt fails closed instead of
  // borrowing time the join no longer has.
  assert.equal(stardewFarmhandBridgeConnectDeadlineMs(nowMs, nowMs), nowMs);
});

test("the connect budget is the number the join budget's own accounting already names", () => {
  // The join docblock says the authenticated pipe connect plus `hello` owns "the
  // last 45 s" of the base budget. The code passes exactly that, so the prose and
  // the number cannot disagree again.
  assert.equal(STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS, 45_000);
  assert.ok(
    STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS < STARDEW_FARMHAND_JOIN_BASE_BUDGET_MS,
    "one attempt must stay inside the join it is part of",
  );
  // A slow-but-legitimate connect must still fit: the cap exists to stop a HUNG
  // attempt, not a late one, so it has to clear the figure the accounting gave the
  // connect rather than sit on it.
  assert.ok(
    STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS > 40_000,
    "a connect that needs most of its documented 45 s must not be cut off by the budget itself",
  );
});

test("the coordinator hands the connect its own budget instead of the whole join", async () => {
  const recorded: { deadlineMs: number; atMs: number }[] = [];
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      connectFarmhandGameRuntimeFacade: async (_connection, deadlineMs) => {
        recorded.push({ deadlineMs, atMs: Date.now() });
        return Object.freeze({
          authority: "SEMANTIC" as const,
          runEnter: async () => connectedSemanticGameLeaseFixture(),
          recoverDeadOwner: async () => undefined,
          pushActionPolicy: () => false,
          close: async () => undefined,
        });
      },
    },
  });
  try {
    await confirmFirstCabin(fixture);
    assert.equal(recorded.length, 1);
    // The join the attempt was admitted under is five minutes out; the attempt
    // itself may spend the connect budget and no more. Read at the instant the
    // attempt was handed the deadline, so the reading is the grant itself.
    const grantedMs = recorded[0]!.deadlineMs - recorded[0]!.atMs;
    assert.ok(
      grantedMs <= STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS,
      `the connect was granted ${grantedMs} ms, which is more than the ${STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS} ms an attempt owns`,
    );
    assert.ok(
      grantedMs > STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS - 5_000,
      `the connect was granted ${grantedMs} ms, which is short of the ${STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS} ms budget`,
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});
