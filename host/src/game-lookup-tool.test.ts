import assert from "node:assert/strict";
import test from "node:test";

import { LOOKUP_SUBJECTS } from "./game-lookup.js";
import { createStardewObservationTools } from "./game-tools.js";
import type { StardewBridgeConnection } from "./game-connection.js";
import type { Snapshot } from "./protocol.js";

const scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
} as const;

const snapshot: Snapshot = {
  revision: 41,
  location: "Farm",
  tile: { x: 5, y: 10 },
  stamina: 268,
  health: 100,
  actionable: true,
  capabilities: [],
  catalogRevision: 1,
  enabledActionIds: [],
  presentationLocale: "zh-CN",
  exhausted: false,
  timeOfDay: 1320,
  dayOfMonth: 6,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
  cropTargets: [],
  wateringWhereabouts: [{ location: "Farm", needsWaterCount: 34, nearestX: 12, nearestY: 20 }],
  harvestWhereabouts: [{ location: "Farm", readyForHarvestCount: 3, nearestX: 14, nearestY: 21 }],
  inventoryItemFacts: [{ slot: 0, qualifiedItemId: "(O)380", displayName: "Iron Ore", stack: 12 }],
  chests: [
    {
      chestId: "chest_a",
      x: 8,
      y: 9,
      displayName: "Chest",
      isFridge: false,
      items: [{ slot: 0, qualifiedItemId: "(O)380", displayName: "Iron Ore", stack: 12 }],
    },
  ],
  chestsSummary: { chestCount: 1, itemCount: 1, fullCount: 0 },
  villagerWhereabouts: [
    { npcName: "Abigail", displayName: "Abigail", location: "Town", x: 40, y: 12, inCurrentLocation: false },
  ],
};

/** A connected session holding `admitted` as its authoritative snapshot. `observe` counts fresh solicitations. */
function integration(admitted: Snapshot | null = snapshot, observeCalls: { count: number } = { count: 0 }) {
  const connection: StardewBridgeConnection & { observe: () => Promise<Snapshot> } = {
    scope,
    module: {} as StardewBridgeConnection["module"],
    state: {
      connected: admitted !== null,
      sessionId: "session_01",
      capabilities: [],
      catalogRegistrations: [],
      catalogRevision: 1,
      enabledActionIds: [],
      snapshot: admitted,
      latestReceipt: null,
      latestReasonCode: null,
    },
    observe: async () => {
      observeCalls.count++;
      return admitted ?? snapshot;
    },
  };
  return connection;
}

function lookupTool(connection: StardewBridgeConnection) {
  const tool = createStardewObservationTools(connection).find((candidate) => candidate.name === "stardew_look_up");
  assert.ok(tool, "stardew_look_up must be a constant mount beside stardew_observe");
  return tool;
}

async function ask(connection: StardewBridgeConnection, params: unknown) {
  const tool = lookupTool(connection);
  const result = await tool.execute("lookup_01", params, new AbortController().signal, () => {}, {} as never);
  const text = result.content[0];
  assert.ok(text !== undefined && text.type === "text", "a lookup answers in one text block");
  return { text: text.text, body: JSON.parse(text.text) as Record<string, any> };
}

/**
 * The tool is only worth its schema if the model can reach it: registered by name, with the subject closed to the table
 * this module answers from and the filter optional. The subject list is read back out of the schema, so a subject added to
 * `LOOKUP_SUBJECTS` without reaching the schema - or a schema advertising a subject the module refuses - fails here.
 */
test("stardew_look_up is registered with the subject table as its closed vocabulary", () => {
  const tool = lookupTool(integration());
  const schema = tool.parameters as {
    properties?: Record<string, { anyOf?: readonly { const?: string }[]; type?: string }>;
    required?: readonly string[];
    additionalProperties?: boolean;
  };
  const subjectSchema = schema.properties?.subject;
  const advertised = (subjectSchema?.anyOf ?? []).map((member) => member.const);
  assert.deepEqual(
    advertised,
    [...LOOKUP_SUBJECTS],
    "the schema must advertise exactly the subjects the module answers",
  );
  assert.deepEqual(schema.required, ["subject"]);
  assert.equal(schema.additionalProperties, false, "the arguments are closed: no argument the module does not read");
  assert.ok(schema.properties?.query !== undefined, "the filter is part of the schema, or no subject can be narrowed");
});

test("every subject answers through the tool and names the family it read", async () => {
  const connection = integration();
  const filters: Record<string, unknown> = { chests: "iron", inventory: "iron", npcs: "abi" };
  for (const subject of LOOKUP_SUBJECTS) {
    const { body } = await ask(connection, { subject, ...(subject in filters ? { query: filters[subject] } : {}) });
    assert.ok(typeof body.source?.family === "string", `${subject} must name its source family`);
    assert.equal(body.source.snapshotRevision, snapshot.revision, `${subject} must name the revision it describes`);
  }
});

test("a lookup answers from the snapshot the session holds and never solicits a fresh observation", async () => {
  // `stardew_observe` is the tool that asks the Mod; this one is the question you can ask without waking the world. If it
  // ever calls `observe` itself, every lookup silently doubles the bridge traffic of an observation.
  const calls = { count: 0 };
  const { body } = await ask(integration(snapshot, calls), { subject: "crops" });
  assert.equal(calls.count, 0);
  assert.equal(body.source.family, "wateringWhereabouts");
});

test("a subject the snapshot does not carry answers source.family null through the tool", async () => {
  const { inventoryItemFacts: _dropped, ...withoutInventory } = snapshot;
  const { body } = await ask(integration(withoutInventory as Snapshot), { subject: "inventory", query: "ore" });
  assert.equal(body.source.family, null, "not looked must never be reported as an empty inventory");
  assert.equal(body.missingField, "inventoryItemFacts");
  assert.equal("rows" in body, false, "an empty list would be a claim about the world");
});

test("a session with no snapshot answers not-looked and names the reason code", async () => {
  const { body } = await ask(integration(null), { subject: "crops" });
  assert.equal(body.source.family, null);
  assert.equal(body.source.snapshotRevision, null);
  assert.equal(body.missingField, "snapshot");
});

test("a subject outside the table is refused with the derived list rather than answered", async () => {
  const { body } = await ask(integration(), { subject: "rocks" });
  assert.match(body.refused, /unknown_subject:rocks/u);
  assert.deepEqual(body.subjects, [...LOOKUP_SUBJECTS]);
  assert.equal(body.source.family, null);
});

test("a typical answer is a question-sized payload, not a second observation", async () => {
  // The point of a bounded answer: the model can afford to ask this mid-plan. An observation is 800-1500 tokens, so a
  // lookup that costs a kilobyte has already failed at being a question.
  const { text } = await ask(integration(), { subject: "crops" });
  const bytes = Buffer.byteLength(text, "utf8");
  assert.ok(bytes <= 1024, `the crops answer is ${String(bytes)} bytes; a lookup must stay question-sized`);
  // Falsifier in the same shape: the same subject on a farm whose whole-map summaries are empty still answers, and does
  // not pad itself up to a floor.
  const { text: emptyText } = await ask(integration({ ...snapshot, wateringWhereabouts: [], harvestWhereabouts: [] }), {
    subject: "crops",
  });
  assert.ok(Buffer.byteLength(emptyText, "utf8") < bytes, "an empty farm must not answer larger than a busy one");
});
