import assert from "node:assert/strict";
import test from "node:test";

import type { ActionPolicy } from "./action-registry.js";
import { createStardewActionTools, createStardewObservationTools, type MoveCapableIntegration } from "./game-tools.js";
import type { StardewBridgeConnection } from "./game-connection.js";
import type { NavigationReadResult } from "./protocol.js";

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
      return {
        status: "succeeded",
        reason: "world_map_observed",
        entries: [],
        nextCursor: null,
        candidates: null,
        destination: null,
        unlockState: null,
      };
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
    JSON.stringify({
      status: "succeeded",
      reason: "world_map_observed",
      entries: [],
      nextCursor: null,
      candidates: null,
      destination: null,
      unlockState: null,
    }),
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
      return {
        status: "resolved",
        reason: "exact_current_locale",
        entries: null,
        nextCursor: null,
        candidates: null,
        destination: { kind: "label", label: "Mine", ref: null },
        unlockState: "unknown",
      };
    },
  }).find((candidate) => candidate.name === "stardew_find_destination");
  assert.ok(tool);
  const result = await tool.execute("find_01", { query: "mine" }, new AbortController().signal, () => {}, {} as never);
  assert.deepEqual(request, { operation: "find_destination", args: { query: "mine" } });
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", JSON.stringify({
    status: "resolved",
    reason: "exact_current_locale",
    entries: null,
    nextCursor: null,
    candidates: null,
    destination: { kind: "label", label: "Mine", ref: null },
    unlockState: "unknown",
  }));
});

test("navigate-to-destination mounts only from its live Mod execution publication and forwards the strict selector", async () => {
  let received: unknown = null;
  const fixture = integration();
  const executionIntegration: MoveCapableIntegration = {
    ...fixture,
    state: {
      ...fixture.state,
      capabilities: ["navigate_to_destination"],
      catalogRegistrations: [
        {
          actionId: "navigate_to_destination",
          familyId: "world_navigation",
          identityVersion: 1,
          lifecycle: "published",
          kind: "execution",
        },
      ],
      snapshot: {
        ...fixture.state.snapshot!,
        capabilities: ["navigate_to_destination"],
      },
    },
    async execute(request) {
      received = request;
      return {
        executionId: "execution_navigation_01",
        requestId: request.requestId,
        actionId: "navigate_to_destination",
        state: "accepted",
        reasonCode: "accepted",
        revision: 1,
        evidence: {},
      };
    },
    async cancel() {
      throw new Error("unexpected_cancel");
    },
  };
  const admission = {
    owner: { ownerId: "navigation_projection", epoch: 1 },
    observer: {
      beforeWrite: () => undefined,
      bindReceipt: () => undefined,
      markUncertain: () => undefined,
    },
    async cancelExact() {
      throw new Error("unexpected_cancel");
    },
  };

  const tool = createStardewActionTools(
    executionIntegration,
    undefined,
    () => admission,
  ).find((candidate) => candidate.name === "stardew_navigate_to_destination");
  assert.ok(tool);
  const result = await tool.execute(
    "navigate_01",
    {
      destination: { kind: "label", label: "Mine" },
      requestId: "request_navigation_01",
      idempotencyKey: "idempotency_navigation_01",
    },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.deepEqual((received as { action: string; args: unknown }).action, "navigate_to_destination");
  assert.deepEqual((received as { args: unknown }).args, {
    destination: { kind: "label", label: "Mine" },
  });
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /\"state\":\"accepted\"/);

  const readOnlyRegistration: MoveCapableIntegration = {
    ...executionIntegration,
    state: {
      ...executionIntegration.state,
      catalogRegistrations: executionIntegration.state.catalogRegistrations!.map((registration) => ({
        ...registration,
        kind: "read_only" as const,
      })),
    },
  };
  assert.equal(
    createStardewActionTools(readOnlyRegistration, undefined, () => admission).some(
      (candidate) => candidate.name === "stardew_navigate_to_destination",
    ),
    false,
  );

  const denied = {
    policyVersion: 1,
    deniedActions: ["navigate_to_destination"],
    deniedFamilies: [],
  } satisfies ActionPolicy;
  assert.equal(
    createStardewActionTools(executionIntegration, denied, () => admission).some(
      (candidate) => candidate.name === "stardew_navigate_to_destination",
    ),
    false,
  );
});

test("navigation policy denied action and denied family each prevent tool mounting", () => {
  const deniedActionPolicy = {
    policyVersion: 1,
    deniedActions: ["find_destination"],
    deniedFamilies: [],
  } satisfies ActionPolicy;
  const deniedFamilyPolicy = {
    policyVersion: 1,
    deniedActions: [],
    deniedFamilies: ["world_navigation"],
  } satisfies ActionPolicy;

  assert.equal(
    createStardewObservationTools(integration(), deniedActionPolicy).some(
      (tool) => tool.name === "stardew_find_destination",
    ),
    false,
  );
  assert.equal(
    createStardewObservationTools(integration(), deniedFamilyPolicy).some(
      (tool) => tool.name === "stardew_find_destination",
    ),
    false,
  );
});

test("mounted find-destination tool rechecks mutable policy before bridge write", async () => {
  let writes = 0;
  const deniedFamilies: Array<"world_navigation"> = [];
  const policy = {
    policyVersion: 1,
    deniedActions: [],
    deniedFamilies,
  } satisfies ActionPolicy;
  const fixture = integration();
  const tool = createStardewObservationTools(
    {
      ...fixture,
      navigationRead: async () => {
        writes++;
        throw new Error("unexpected_navigation_write");
      },
    },
    policy,
  ).find((candidate) => candidate.name === "stardew_find_destination");
  assert.ok(tool);

  policy.deniedFamilies.push("world_navigation");
  await assert.rejects(
    tool.execute("find_after_policy_denial", { query: "mine" }, new AbortController().signal, () => {}, {} as never),
    /bridge_capability_not_ready/,
  );
  assert.equal(writes, 0);
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
      return {
        status: "not_found" as const,
        reason: "destination_not_found" as const,
        entries: null,
        nextCursor: null,
        candidates: null,
        destination: null,
        unlockState: null,
      } satisfies NavigationReadResult;
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
      return {
        status: "succeeded" as const,
        reason: "world_map_observed" as const,
        entries: [],
        nextCursor: null,
        candidates: null,
        destination: null,
        unlockState: null,
      };
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


test("navigation tools reject missing bridge, revision drift, and every exact registration mismatch", () => {
  const mismatches = [
    { lifecycle: "experimental" },
    { kind: "execution" },
    { familyId: "movement_navigation" },
    { actionId: "other" },
    { identityVersion: 2 },
  ] as const;
  for (const mismatch of mismatches) {
    const registrations = integration().state.catalogRegistrations!.map((registration) =>
      registration.actionId === "find_destination"
        ? { ...registration, ...mismatch }
        : registration,
    );
    const tools = createStardewObservationTools(
      integration({ catalogRegistrations: registrations as never }),
    );
    assert.equal(tools.some((tool) => tool.name === "stardew_find_destination"), false);
  }

  const missingRead = integration();
  delete (missingRead as { navigationRead?: unknown }).navigationRead;
  assert.equal(
    createStardewObservationTools(missingRead).some((tool) =>
      tool.name.startsWith("stardew_inspect_world_map") ||
      tool.name.startsWith("stardew_find_destination"),
    ),
    false,
  );
  assert.equal(
    createStardewObservationTools(
      integration({ catalogRevision: 2 }),
    ).some((tool) => tool.name === "stardew_find_destination"),
    false,
  );
});

test("world-map inspection forwards only empty, nodeRef, or cursor arguments", async () => {
  const requests: unknown[] = [];
  const fixture = integration();
  const tool = createStardewObservationTools({
    ...fixture,
    navigationRead: async (request) => {
      requests.push(request);
      return {
        status: "succeeded",
        reason: "world_map_observed",
        entries: [],
        nextCursor: null,
        candidates: null,
        destination: null,
        unlockState: null,
      };
    },
  }).find((candidate) => candidate.name === "stardew_inspect_world_map");
  assert.ok(tool);
  for (const params of [{}, { nodeRef: "node:Farm" }, { cursor: "page:2" }])
    await tool.execute("inspect", params, new AbortController().signal, () => {}, {} as never);
  assert.deepEqual(requests, [
    { operation: "inspect_world_map", args: {} },
    { operation: "inspect_world_map", args: { nodeRef: "node:Farm" } },
    { operation: "inspect_world_map", args: { cursor: "page:2" } },
  ]);
  for (const invalid of [
    { nodeRef: "node:Farm", cursor: "page:2" },
    { extra: "value" },
    { nodeRef: "" },
    { cursor: "x".repeat(129) },
  ])
    await assert.rejects(
      tool.execute("invalid", invalid as never, new AbortController().signal, () => {}, {} as never),
      /invalid_tool_parameters/,
    );
  assert.equal(requests.length, 3);
});

test("find destination returns seven-key candidates verbatim without mutating integration state", async () => {
  const fixture = integration();
  const before = JSON.stringify(fixture.state);
  const exactResult = {
    status: "candidates",
    reason: "ambiguous_exact",
    entries: null,
    nextCursor: null,
    candidates: [
      {
        label: "Mines",
        contextLabel: "Mountain",
        destination: { kind: "ref", label: null, ref: null },
        unlockState: "unknown",
      },
      {
        label: "Quarry Mine",
        contextLabel: "Quarry",
        destination: { kind: "ref", label: null, ref: null },
        unlockState: "unknown",
      },
    ],
    destination: null,
    unlockState: null,
  } satisfies NavigationReadResult;
  const tool = createStardewObservationTools({
    ...fixture,
    navigationRead: async () => exactResult,
  }).find((candidate) => candidate.name === "stardew_find_destination");
  assert.ok(tool);
  const result = await tool.execute("find", { query: "mine" }, new AbortController().signal, () => {}, {} as never);
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", JSON.stringify(exactResult));
  assert.deepEqual(result.details, { result: exactResult });
  assert.equal(JSON.stringify(fixture.state), before);
});
