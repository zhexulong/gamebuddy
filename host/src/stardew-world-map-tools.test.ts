import assert from "node:assert/strict";
import test from "node:test";

import { createStardewObservationTools } from "./game-tools.js";
import type { StardewBridgeConnection } from "./game-connection.js";

const scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
} as const;

function integration(overrides: Partial<StardewBridgeConnection["state"]> = {}): StardewBridgeConnection {
  return {
    scope,
    module: {} as StardewBridgeConnection["module"],
    state: {
      connected: true,
      sessionId: "session_01",
      capabilities: ["inspect_world_map", "find_destination"],
      catalogRegistrations: [
        { actionId: "inspect_world_map", familyId: "world_navigation", identityVersion: 1, lifecycle: "published", kind: "read_only" },
        { actionId: "find_destination", familyId: "world_navigation", identityVersion: 1, lifecycle: "published", kind: "read_only" },
      ],
      catalogRevision: 1,
      enabledActionIds: [],
      snapshot: {
        revision: 1,
        location: "Farm",
        tile: { x: 1, y: 1 },
        stamina: 100,
        health: 100,
        actionable: true,
        capabilities: ["inspect_world_map", "find_destination"],
        catalogRevision: 1,
        enabledActionIds: [],
        presentationLocale: "en-US",
        activeExecution: null,
      },
      latestReceipt: null,
      latestReasonCode: null,
      ...overrides,
    },
    navigationRead: async (request) => {
      assert.deepEqual(request, { operation: "inspect_world_map", args: {} });
      return { status: "succeeded", reason: "world_map_observed", entries: [] };
    },
  };
}

test("world-map tool mounts only from a fresh Mod read-only capability and returns its exact result", async () => {
  const tools = createStardewObservationTools(integration());
  const tool = tools.find((candidate) => candidate.name === "stardew_inspect_world_map");
  assert.ok(tool);
  const result = await tool.execute("call_01", {}, new AbortController().signal, () => {}, {} as never);
  assert.equal(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    JSON.stringify({ status: "succeeded", reason: "world_map_observed", entries: [] }),
  );
});

test("world-map tool is withheld for stale snapshot, withdrawn capability, or missing read-only registration", () => {
  for (const state of [
    { snapshot: { ...integration().state.snapshot!, catalogRevision: 2 } },
    { capabilities: [], snapshot: { ...integration().state.snapshot!, capabilities: [] } },
    { catalogRegistrations: [] },
  ]) {
    const tools = createStardewObservationTools(integration(state));
    assert.equal(tools.some((candidate) => candidate.name === "stardew_inspect_world_map"), false);
  }
});

test("find-destination tool mounts from its own Mod read-only publication and forwards a bounded query", async () => {
  let request: unknown = null;
  const fixture = integration();
  const tool = createStardewObservationTools({
    ...fixture,
    navigationRead: async (value) => {
      request = value;
      return { status: "resolved", reason: "exact_current_locale", destination: { kind: "label", label: "Mine" } };
    },
  }).find((candidate) => candidate.name === "stardew_find_destination");
  assert.ok(tool);
  const result = await tool.execute("find_01", { query: "mine" }, new AbortController().signal, () => {}, {} as never);
  assert.deepEqual(request, { operation: "find_destination", args: { query: "mine" } });
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", JSON.stringify({ status: "resolved", reason: "exact_current_locale", destination: { kind: "label", label: "Mine" } }));
});

test("find-destination tool rechecks its own live publication before bridge write", async () => {
  let withdrawn = false;
  let writes = 0;
  const fixture = integration();
  const live = {
    ...fixture,
    get state() {
      const state = fixture.state;
      return withdrawn
        ? {
            ...state,
            capabilities: ["inspect_world_map"],
            snapshot: { ...state.snapshot!, capabilities: ["inspect_world_map"] },
          }
        : state;
    },
    navigationRead: async () => {
      writes++;
      return { status: "not_found" as const, reason: "destination_not_found" as const };
    },
  };
  const tool = createStardewObservationTools(live).find((candidate) => candidate.name === "stardew_find_destination");
  assert.ok(tool);
  withdrawn = true;
  await assert.rejects(
    tool.execute("find_after_withdrawal", { query: "mine" }, new AbortController().signal, () => {}, {} as never),
    /bridge_capability_not_ready/,
  );
  assert.equal(writes, 0);
});

test("mounted world-map tool rechecks the live publication before bridge write", async () => {
  let withdrawn = false;
  let writes = 0;
  const fixture = integration();
  const live = {
    ...fixture,
    get state() {
      const state = fixture.state;
      return withdrawn
        ? { ...state, capabilities: [], snapshot: { ...state.snapshot!, capabilities: [] } }
        : state;
    },
    navigationRead: async () => {
      writes++;
      return { status: "succeeded" as const, reason: "world_map_observed" as const, entries: [] };
    },
  };
  const tool = createStardewObservationTools(live).find((candidate) => candidate.name === "stardew_inspect_world_map");
  assert.ok(tool);
  withdrawn = true;
  await assert.rejects(
    tool.execute("call_after_withdrawal", {}, new AbortController().signal, () => {}, {} as never),
    /bridge_capability_not_ready/,
  );
  assert.equal(writes, 0);
});
