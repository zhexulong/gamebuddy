import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const protocolPath = new URL("../integrations/stardew/PortfolioForageActionProtocol.cs", import.meta.url);
const coordinatorPath = new URL("../integrations/stardew/PortfolioForageActionCoordinator.cs", import.meta.url);

async function sources() {
  return Promise.all([readFile(protocolPath, "utf8"), readFile(coordinatorPath, "utf8")]);
}

test("M3 spawned forage protocol stays distinct from Debris pickup_item and permits no generic pickup", async () => {
  const [protocol] = await sources();
  assert.match(protocol, /const string Action = "pickup_forage"/);
  assert.match(protocol, /SpawnedForageTargetKind = "spawned_forage_object"/);
  assert.match(protocol, /Debris is a separate[\s\S]*pickup_item/);
  assert.doesNotMatch(protocol, /generic pickup/i);
});

test("M3 coordinator binds fresh selector target and range/capacity guards, then fails closed before dispatch", async () => {
  const [, coordinator] = await sources();
  for (const required of [
    "InRange",
    "InventoryCapacityAvailable",
    "SpawnedForagePresent",
    "ExpectedRevision",
    "DeadlineMs",
    "forage_source_semantic_edge_unestablished",
  ])
    assert.match(coordinator, new RegExp(required));
  for (const forbidden of [
    "Game1.tryToCheckAt",
    "GameLocation.checkAction",
    ".checkAction\\(",
    "reflection",
    "SaveGame",
    "NewDay",
  ])
    assert.doesNotMatch(coordinator, new RegExp(forbidden));
  assert.match(coordinator, /phases, scope, targetId, false, 0/);
});
