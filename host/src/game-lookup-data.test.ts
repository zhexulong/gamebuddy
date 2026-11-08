import assert from "node:assert/strict";
import test from "node:test";

import { MAX_DATA_INDEX_BYTES, LOOKUP_SUBJECTS, dataTable } from "./game-lookup.js";
import { createStardewObservationTools } from "./game-tools.js";
import type { StardewBridgeConnection } from "./game-connection.js";
import type { DataQueryRequest, DataQueryResult, Snapshot } from "./protocol.js";
import { newEnvelope, validateBridgeMessage } from "./protocol.js";

/**
 * `stardew_look_up({ subject: "data" })`: the game's OWN content tables.
 *
 * <p>
 * Measured before this existed: a coop needs `Data/Buildings` cost and build days (already published per action), and
 * "what does a chicken cost", "how many days until it matures", "what does it produce" had no channel at all - the
 * player-facing question "how do I get an animal?" was unanswerable. The tables were in the engine's cache the whole
 * time, filed as observation debt.
 * </p>
 * <p>
 * What this file pins is the ANSWER CONTRACT, not the game: `dataTable` is pure over the Mod's result, so the four
 * outcomes that need different corrections - index, found, absent, unknown - are asserted without a bridge, and the
 * end-to-end test drives the same projection through the tool with a real `DataQueryResult` shaped exactly as
 * `BridgeDataQueryResult` serializes.
 * </p>
 */

const scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
} as const;

const snapshot: Snapshot = {
  revision: 7,
  location: "Farm",
  tile: { x: 5, y: 10 },
  stamina: 268,
  health: 100,
  actionable: true,
  capabilities: [],
  catalogRevision: 1,
  enabledActionIds: [],
  presentationLocale: "en-US",
  exhausted: false,
  timeOfDay: 1320,
  dayOfMonth: 6,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
};

/**
 * One `Data/FarmAnimals` row, as the Mod projects it.
 *
 * The field names are the engine's own (`FarmAnimalData.DaysToMature`, `.ProduceItemIds`, `.House`), which is the point:
 * the projection is a claim about engine data, so a rename in a future game version must break the Mod's compile, not
 * quietly answer with a stale key.
 */
const chickenRow: DataQueryResult = {
  status: "row",
  table: "FarmAnimals",
  population: 24,
  ids: null,
  row: {
    id: "White Chicken",
    fields: {
      displayName: "White Chicken",
      house: "Coop",
      daysToMature: 4,
      daysToProduce: 1,
      produce: ["176"],
      deluxeProduce: ["180"],
      harvestType: "DropOvernight",
      harvestTool: null,
      produceOnMature: false,
      purchasePrice: 800,
      sellPrice: 400,
      requiredBuilding: "Coop",
      canGetPregnant: false,
    },
  },
  detail: null,
};

function indexResult(ids: readonly string[], population = ids.length): DataQueryResult {
  return { status: "index", table: "FarmAnimals", population, ids, row: null, detail: null };
}

test("a found row answers under its own name with the fields that decide an action", () => {
  const answer = dataTable(chickenRow, "White Chicken");
  assert.equal(answer.subject, "data");
  assert.equal(answer.source.family, "DataLoader");
  assert.equal(
    answer.source.snapshotRevision,
    null,
    "content data is not snapshot state and must not claim a revision",
  );
  assert.equal(answer.answer.code, "data_row_found:FarmAnimals:White Chicken");
  assert.equal(
    answer.answer.population,
    24,
    "the table's size sits beside the row, so one row is never the whole table",
  );
  const row = answer.answer.row as Readonly<{ id: string; fields: Record<string, unknown> }>;
  assert.equal(row.fields.daysToMature, 4);
  assert.equal(row.fields.house, "Coop");
  assert.equal(row.fields.harvestTool, null, "a hen drops its egg; null is that fact, and it is not an absent field");
  assert.deepEqual(row.fields.produce, ["176"]);
});

test("an absent row names the table, the key and the size of the table it is missing from", () => {
  const answer = dataTable(
    {
      status: "absent_row",
      table: "FarmAnimals",
      population: 24,
      ids: null,
      row: null,
      detail: "`FarmAnimals` has 24 row(s) and none is `Velociraptor`",
    },
    "Velociraptor",
  );
  assert.equal(answer.answer.code, "data_row_absent:FarmAnimals:Velociraptor");
  assert.equal(answer.answer.population, 24, "an absent row is not an absent table");
  assert.equal(answer.answer.matched, 0);
  assert.deepEqual(answer.answer.rows, []);
  assert.equal(answer.source.family, "DataLoader", "the table WAS read; that is why the row can be reported absent");
});

test("an unknown table is named as unknown and reads nothing", () => {
  const answer = dataTable(
    {
      status: "unknown_table",
      table: "Animals",
      population: -1,
      ids: null,
      row: null,
      detail: "the engine has no content table named `Animals`",
    },
    null,
  );
  assert.equal(answer.answer.code, "data_table_unknown:Animals");
  assert.equal(answer.source.family, null, "nothing was read, so no family is claimed");
});

test("a table with zero rows answers population 0, never unknown", () => {
  const answer = dataTable(indexResult([]), null);
  assert.equal(answer.answer.code, "data_table_index:FarmAnimals");
  assert.equal(answer.answer.population, 0);
  assert.equal(answer.answer.matched, 0);
  assert.equal(answer.answer.omitted, 0);
  assert.equal(answer.answer.note, "the table exists and has zero rows");
  assert.equal(answer.source.family, "DataLoader");
});

test("an index is bounded by BYTES, and every dropped id is counted", () => {
  const ids = Array.from({ length: 400 }, (_, index) => `(O)${String(index).padStart(3, "0")}`);
  const answer = dataTable(indexResult(ids), null);
  const rows = answer.answer.rows as readonly string[];
  const omitted = answer.answer.omitted as number;
  assert.ok(rows.length < ids.length, "400 ids cannot fit in the budget");
  assert.equal(rows.length + omitted, ids.length, "the answer accounts for every row: nothing vanishes");
  assert.equal(answer.answer.matched, ids.length, "matched is the measurement; rows is what fitted");
  const bytes = rows.reduce((total, id) => total + id.length + 4, 0);
  assert.ok(
    bytes <= MAX_DATA_INDEX_BYTES,
    `the index spent ${String(bytes)} bytes, over the ${String(MAX_DATA_INDEX_BYTES)} budget`,
  );
});

test("an index that fits reports omitted 0, so 'nothing was dropped' is a measurement", () => {
  const answer = dataTable(indexResult(["White Chicken", "Brown Chicken"]), null);
  assert.equal(answer.answer.omitted, 0);
  assert.deepEqual(answer.answer.rows, ["White Chicken", "Brown Chicken"]);
});

test("a table whose rows are too large refuses by name instead of dumping a fragment", () => {
  const answer = dataTable(
    {
      status: "not_projectable",
      table: "Locations",
      population: -1,
      ids: null,
      row: null,
      detail: "each row is a LocationData whose spawn tables are tens of kilobytes",
    },
    null,
  );
  assert.match(String(answer.answer.code), /^data_table_not_projectable:Locations:/u);
  assert.equal(answer.source.family, null);
});

function integration(dataQuery?: (request: DataQueryRequest) => Promise<DataQueryResult>) {
  const connection: StardewBridgeConnection & {
    dataQuery?: (request: DataQueryRequest) => Promise<DataQueryResult>;
  } = {
    scope,
    module: {} as StardewBridgeConnection["module"],
    state: {
      connected: true,
      sessionId: "session_01",
      capabilities: [],
      catalogRegistrations: [],
      catalogRevision: 1,
      enabledActionIds: [],
      snapshot,
      latestReceipt: null,
      latestReasonCode: null,
    },
    ...(dataQuery === undefined ? {} : { dataQuery }),
  };
  return connection;
}

async function ask(connection: StardewBridgeConnection, params: unknown) {
  const tool = createStardewObservationTools(connection).find((candidate) => candidate.name === "stardew_look_up");
  assert.ok(tool, "stardew_look_up must be a constant mount beside stardew_observe");
  const result = await tool.execute("lookup_data_01", params, new AbortController().signal, () => {}, {} as never);
  const text = result.content[0];
  assert.ok(text !== undefined && text.type === "text", "a lookup answers in one text block");
  return { text: text.text, body: JSON.parse(text.text) as Record<string, any> };
}

test("the tool routes subject data through the Mod's content reader, with the key it was asked for", async () => {
  const asked: DataQueryRequest[] = [];
  const connection = integration(async (request) => {
    asked.push(request);
    return chickenRow;
  });
  const { body } = await ask(connection, { subject: "data", table: "FarmAnimals", key: "White Chicken" });
  assert.deepEqual(asked, [{ table: "FarmAnimals", key: "White Chicken" }]);
  assert.equal(body.answer.code, "data_row_found:FarmAnimals:White Chicken");
  assert.equal(body.answer.row.fields.daysToMature, 4);
});

test("the tool answers the index when no key is given, and asks for key null", async () => {
  const asked: DataQueryRequest[] = [];
  const connection = integration(async (request) => {
    asked.push(request);
    return indexResult(["White Chicken", "Brown Chicken"]);
  });
  const { body } = await ask(connection, { subject: "data", table: "FarmAnimals" });
  assert.deepEqual(asked, [{ table: "FarmAnimals", key: null }]);
  assert.equal(body.answer.population, 2);
  assert.deepEqual(body.answer.rows, ["White Chicken", "Brown Chicken"]);
});

test("a session with no content reader says so instead of answering an empty table", async () => {
  const { body } = await ask(integration(), { subject: "data", table: "FarmAnimals" });
  assert.equal(body.source.family, null);
  assert.equal(body.missingField, "dataQuery");
});

test("subject data without a table names the missing argument rather than reading anything", async () => {
  const { body } = await ask(
    integration(async () => chickenRow),
    { subject: "data" },
  );
  assert.equal(body.source.family, null);
  assert.match(String(body.unknown), /needs a `table`/u);
});

test("the answer stays cheaper than an observation", async () => {
  const ids = Array.from({ length: 900 }, (_, index) => `(O)${String(index)}`);
  const connection = integration(async () => indexResult(ids, 900));
  const { text } = await ask(connection, { subject: "data", table: "Objects" });
  assert.ok(text.length <= 2048, `a content-table index cost ${String(text.length)} bytes; an observation is ~8 KB`);
});

test("data is part of the advertised subject vocabulary", () => {
  assert.ok(
    LOOKUP_SUBJECTS.includes("data"),
    "the schema is derived from LOOKUP_SUBJECTS, so the subject must be there",
  );
});

/**
 * The WIRE half: the frame the Mod sends must be the frame the Host validator knows.
 *
 * <p>
 * A field the Mod sends and the Host does not know rejects the WHOLE frame - that is the bug this pair has hit twice,
 * once on a snapshot family and once on a program result - so the exact payload `BridgeDataQueryResult` serializes is
 * run through the Host's own validator here. The status vocabulary is closed on both sides for the same reason: a
 * status the Host has never heard of must be a refusal, not an answer it silently renders as an empty table.
 * </p>
 */
test("the frame the Mod sends for a content-table answer is the frame the Host validates", () => {
  const scope = {
    integrationId: "stardew",
    saveId: "save_01",
    worldId: "world_01",
    playerId: "player_01",
    companionId: "companion_01",
  } as const;
  const now = 1_700_000_000_000;
  const request = newEnvelope("data_query_request", scope, { table: "FarmAnimals", key: null }, "corr_01", now);
  assert.equal(validateBridgeMessage(request, scope, now), null);

  const rowAnswer = newEnvelope(
    "data_query_result",
    scope,
    {
      status: "row",
      table: "FarmAnimals",
      population: 24,
      ids: null,
      row: chickenRow.status === "row" ? chickenRow.row : null,
      detail: null,
    },
    "corr_01",
    now,
  );
  assert.equal(validateBridgeMessage(rowAnswer, scope, now), null, "the Mod's own row payload must be admitted whole");

  const indexAnswer = newEnvelope(
    "data_query_result",
    scope,
    { status: "index", table: "Objects", population: 900, ids: ["(O)16", "(O)18"], row: null, detail: null },
    "corr_01",
    now,
  );
  assert.equal(validateBridgeMessage(indexAnswer, scope, now), null);

  const unknownAnswer = newEnvelope(
    "data_query_result",
    scope,
    { status: "unknown_table", table: "Animals", population: -1, ids: null, row: null, detail: "no such table" },
    "corr_01",
    now,
  );
  assert.equal(validateBridgeMessage(unknownAnswer, scope, now), null);

  const extraField = newEnvelope(
    "data_query_result",
    scope,
    { status: "index", table: "Objects", population: 0, ids: [], row: null, detail: null, surprise: 1 },
    "corr_01",
    now,
  );
  assert.notEqual(validateBridgeMessage(extraField, scope, now), null, "an unknown key is a defect, not an extension");

  const unknownStatus = newEnvelope(
    "data_query_result",
    scope,
    { status: "partial", table: "Objects", population: 0, ids: [], row: null, detail: null },
    "corr_01",
    now,
  );
  assert.notEqual(validateBridgeMessage(unknownStatus, scope, now), null, "the status vocabulary is closed");
});
