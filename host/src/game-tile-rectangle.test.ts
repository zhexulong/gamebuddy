import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

import type { StardewBridgeConnection } from "./game-connection.js";
import { createStardewObservationTools } from "./game-tools.js";
import {
  newEnvelope,
  type Scope,
  type Snapshot,
  type TileAreaRequest,
  type TileAreaResult,
  validateBridgeMessage,
} from "./protocol.js";

/**
 * One RECTANGLE of the live world, through `stardew_observe` - the tool that absorbed the rectangle query.
 *
 * <p>
 * Measured round42, live: a 3-wide x 20-long strip was asked for, the observation's soil family is a square window
 * around the actor with a cap, and the run produced a 7x8 blob at 55% density over 21 two-or-three-node scripts while
 * the companion re-observed every three or four tiles. The missing channel was the whole finding: nothing she could ask
 * answered "what is at (44..46, 12..31)".
 * </p>
 * <p>
 * What this file pins is the FRAME and the ANSWER CONTRACT of that channel, now that the tool which used to own it is
 * gone: a selection naming a rectangle forwards exactly that rectangle, the Mod's answer reaches the model verbatim in
 * its own facts (including its own refusals - the Host does not decide the area bound), and the bytes on the wire are
 * the bytes the protocol validator and the committed schema both admit. The frame half matters because a key the Host
 * does not know rejects the WHOLE envelope, which this repo has paid for three times.
 * </p>
 * <p>
 * THE CAPABILITIES the deleted tool promised are not asserted here: they belong to
 * `tool-capability-lost-in-a-merge.test.ts`, which reads its population from the wire and from the Mod instead of from
 * this file's memory.
 * </p>
 */

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};

const snapshot: Snapshot = {
  revision: 412,
  location: "Farm",
  tile: { x: 47, y: 15 },
  stamina: 270,
  health: 100,
  actionable: true,
  capabilities: [],
  catalogRevision: 1,
  enabledActionIds: [],
  presentationLocale: "en-US",
  exhausted: false,
  timeOfDay: 620,
  dayOfMonth: 3,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
};

/** The answer the Mod sends for a 3x20 strip: sixty rows, every one a fact read from the live world. */
function answered(x: number, y: number, w: number, h: number): TileAreaResult {
  const rows = [];
  for (let tileY = y; tileY < y + h; tileY += 1)
    for (let tileX = x; tileX < x + w; tileX += 1)
      rows.push({
        x: tileX,
        y: tileY,
        tillable: tileY % 7 !== 0,
        occupant: tileY % 7 !== 0 ? "none" : "tree",
        occupantKind: tileY % 7 !== 0 ? "none" : "tree",
        hoed: false,
        watered: false,
        crop: false,
        passable: tileY % 7 !== 0,
      });
  return {
    status: "answered",
    detail: null,
    x,
    y,
    w,
    h,
    location: "Farm",
    revision: snapshot.revision,
    areaLimit: 100,
    rows,
    omitted: 0,
  };
}

/** The Mod's own refusal for a rectangle over its area bound. */
function overTheArea(x: number, y: number, w: number, h: number): TileAreaResult {
  return {
    status: "area_too_large",
    detail: `inspect_tiles_area_too_large:100:${String(w)}x${String(h)}`,
    x,
    y,
    w,
    h,
    location: null,
    revision: snapshot.revision,
    areaLimit: 100,
    rows: null,
    omitted: 0,
  };
}

function integration(tileArea?: (request: TileAreaRequest) => Promise<TileAreaResult>) {
  const connection: StardewBridgeConnection = {
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
    ...(tileArea === undefined ? {} : { tileArea }),
  };
  return connection;
}

/** The strip as a selection: `x` and `y` together are the rectangle, and nothing else is a shape. */
const strip = (x: number, y: number, w: number, h: number) => ({
  select: [{ x: { from: x, to: x + w - 1 }, y: { from: y, to: y + h - 1 } }],
});

async function ask(connection: StardewBridgeConnection, params: unknown) {
  const tool = createStardewObservationTools(connection).find((candidate) => candidate.name === "stardew_observe");
  assert.ok(tool, "the rectangle is a question stardew_observe answers; it is the observation class's one tool for it");
  const result = await tool.execute("observe_01", params as never, new AbortController().signal, () => {}, {} as never);
  const content = result.content[0];
  assert.ok(content !== undefined && content.type === "text", "the answer is one text block, like every observation");
  return { text: content.text, details: result.details as unknown as Record<string, unknown> };
}

test("the rectangle is forwarded exactly as asked, and the Mod's rows reach the model", async () => {
  const asked: TileAreaRequest[] = [];
  const connection = integration(async (request) => {
    asked.push(request);
    return answered(request.x, request.y, request.w, request.h);
  });

  const { text, details } = await ask(connection, strip(44, 12, 3, 20));

  assert.deepEqual(asked, [{ x: 44, y: 12, w: 3, h: 20 }], "the four numbers are the whole request");
  const selection = (details as unknown as { selection: { rowType: string; revision?: number } }).selection;
  assert.equal(selection.rowType, "tile", "a rectangle answers in the tile row type");
  assert.equal(asked.length, 1, "one round trip, which is the whole point of asking for a rectangle");
  // Sixty tiles, of which the ones with a tree are the ones the strip's own rows report.
  assert.match(text, /3×20 = 60 格/u, `the answer states the shape it read: ${text}`);
  assert.match(text, /格子：/u, "and how many tiles hold something");
  assert.match(text, /revision 412/u, "the answer names the snapshot it describes");
});

test("an over-area answer is the MOD's refusal, delivered with the limit and the size that was asked for", async () => {
  const asked: TileAreaRequest[] = [];
  const connection = integration(async (request) => {
    asked.push(request);
    return overTheArea(request.x, request.y, request.w, request.h);
  });

  const { text, details } = await ask(connection, strip(0, 0, 11, 10));

  assert.equal(asked.length, 1, "the bound is the Mod's to enforce; the Host must not pre-empt it with a schema error");
  assert.match(text, /11×10/u, `the refusal names the size that was asked for: ${text}`);
  assert.match(text, /100 格/u, `and the limit it broke: ${text}`);
  assert.equal((details as unknown as { selection: unknown }).selection, null, "a refusal publishes no rows");
});

test("a session with no rectangle reader says so instead of answering an empty rectangle", async () => {
  const { text, details } = await ask(integration(), strip(44, 12, 3, 20));
  assert.match(text, /^tile_area_query_unavailable/u, text);
  assert.equal((details as unknown as { reasonCode: string }).reasonCode, "tile_area_query_unavailable");
});

test("a rectangle is still a READ: no argument and no selection is exactly the whole world", async () => {
  const connection = integration(async (request) => answered(request.x, request.y, request.w, request.h));
  const plain = await ask(connection, {});
  assert.equal(plain.text.includes("矩形（"), false, "the plain observation is not a rectangle read");
  assert.equal((plain.details as unknown as { selection: unknown }).selection, null);
});

test("the frames both sides send are the frames the protocol validator and the committed schema admit", async () => {
  const validate = await schemaValidator();
  const now = Date.now();

  const request = newEnvelope("tile_area_request", scope, { x: 44, y: 12, w: 3, h: 20 }, "corr_01", now);
  assert.equal(validateBridgeMessage(request, scope, now), null);
  assert.equal(validate(request), true, JSON.stringify(validate.errors));

  const result = newEnvelope("tile_area_result", scope, answered(44, 12, 3, 20), "corr_01", now);
  assert.equal(validateBridgeMessage(result, scope, now), null);
  assert.equal(validate(result), true, JSON.stringify(validate.errors));

  const refusal = newEnvelope("tile_area_result", scope, overTheArea(0, 0, 11, 10), "corr_01", now);
  assert.equal(validateBridgeMessage(refusal, scope, now), null);
  assert.equal(validate(refusal), true, JSON.stringify(validate.errors));

  // An empty side and an unknown key are both refused before the Mod reads anything.
  for (const payload of [
    { x: 0, y: 0, w: 0, h: 5 },
    { x: 0, y: 0, w: 3, h: 5, radius: 4 },
  ])
    assert.equal(
      validateBridgeMessage(newEnvelope("tile_area_request", scope, payload, "corr_01", now), scope, now),
      "invalid_tile_area_request",
    );
});

test("an answered rectangle that does not account for its own tiles is refused by the Host validator", async () => {
  const now = Date.now();
  const short = answered(44, 12, 3, 20);
  const truncated: TileAreaResult = { ...short, rows: (short.rows ?? []).slice(0, 59) };

  assert.equal(
    validateBridgeMessage(newEnvelope("tile_area_result", scope, truncated, "corr_01", now), scope, now),
    "invalid_tile_area_result",
    "rows plus omitted must be the rectangle: a bound that drops a row without counting it is the defect this exists for",
  );
  const counted: TileAreaResult = { ...truncated, omitted: 1 };
  assert.equal(
    validateBridgeMessage(newEnvelope("tile_area_result", scope, counted, "corr_01", now), scope, now),
    null,
    "and the same answer IS admitted when the dropped row is counted",
  );
});

async function schemaValidator() {
  const schema = JSON.parse(
    await readFile(fileURLToPath(new URL("../../protocol/bridge-v1.schema.json", import.meta.url)), "utf8"),
  ) as object;
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}
