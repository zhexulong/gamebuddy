import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readForEachLoop } from "./body-program-for-each.js";
import type { StardewBridgeConnection } from "./game-connection.js";
import { createStardewObservationTools } from "./game-tools.js";
import { TILE_OCCUPANT_NONE } from "./game-world-vocabulary.js";
import type { Scope, Snapshot, TileAreaRequest, TileAreaResult, TileAreaRow } from "./protocol.js";

/**
 * `tool_capability_lost_in_a_merge:<capability>`: one tool absorbed another, so every promise has to be re-earned.
 *
 * <p>
 * WHY THIS FILE EXISTS. `stardew_inspect_tiles` was deleted - one tool is the owner's ruling - and a deletion is the
 * merge that loses things quietly: the tool's schema, its mount, and its tests all go, and what it PROMISED the model
 * survives only as a sentence somebody remembers. So the promises are the population here, written down as capabilities
 * rather than as prose, and each one is driven through the tool that is supposed to answer it now.
 * </p>
 * <p>
 * THE POPULATION COMES FROM THE AUTHORITIES, not from this file's memory of them: the fields a row must carry are read
 * out of the wire's own `isTileAreaRow`, and the occupant words are read out of the Mod's `TileOccupantKind` and
 * `FarmhandForEachHealing` - so a field added to the frame, or a word added on the game side, is red here until the
 * answer delivers it. A hand-written copy of either would agree with itself forever.
 * </p>
 * <p>
 * THE VERDICT LINE is `capabilities examined N · delivered M · lost K`. K>0 fails and names the capability, the tool and
 * the field: `tool_capability_lost_in_a_merge:occupant_kind_in_the_where_vocabulary:stardew_observe:occupantKind`. A zero
 * population is blocked rather than green.
 * </p>
 */

// THE SOURCES THIS GATE READS ARE READ FROM THE TREE, not from the artifact: a suite that ran from `dist-test` and looked
// for `protocol.ts` beside itself would find nothing and report a blocked population on a healthy tree.
const hostRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(hostRoot, "..");
const read = (relative: string): string => readFileSync(resolve(hostRoot, "src", relative), "utf8");
const readRepository = (relative: string): string => readFileSync(resolve(repositoryRoot, relative), "utf8");

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
  tile: { x: 44, y: 12 },
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

/**
 * The fields one tile row carries, read from the wire's own validator.
 *
 * A field added to `isTileAreaRow` and not delivered by the answer is then red here rather than invisible, which is the
 * whole reason the population is derived instead of listed.
 */
function wireRowFields(): readonly string[] {
  const source = read("protocol.ts");
  const declaration = source.indexOf("function isTileAreaRow(");
  assert.notEqual(declaration, -1, "the wire must still declare isTileAreaRow; this gate reads the row from it");
  const keys = /hasExactKeys\(value, \[([^\]]*)\]\)/u.exec(source.slice(declaration));
  assert.ok(
    keys?.[1] !== undefined,
    "isTileAreaRow must still name its exact keys; this gate reads the row from there",
  );
  const fields = keys[1]
    .split(",")
    .map((field) => field.trim().replace(/^"|"$/gu, ""))
    .filter((field) => field.length > 0);
  assert.ok(fields.length > 0, "blocked: the wire declares a row of no fields, so nothing was examined");
  return Object.freeze(fields);
}

/**
 * Every word the Mod publishes for what stands on a tile, resolved through its own constants.
 *
 * `Published` lists NAMES and the values live on the constants beside it, so both halves are read: a word whose value
 * changed is a different word, and a name added to the list without a value is a declaration this gate cannot resolve.
 */
function modOccupantKinds(): readonly string[] {
  const source = readRepository("integrations/stardew/src/Core/TileOccupantKind.cs");
  const values = new Map(
    [...source.matchAll(/public const string (\w+) = "([^"]+)";/gu)].map((match) => [match[1]!, match[2]!]),
  );
  const published = /public static readonly IReadOnlyList<string> Published = new\[\]\s*\{([\s\S]*?)\};/u.exec(source);
  assert.ok(
    published?.[1] !== undefined,
    "the Mod must still declare TileOccupantKind.Published; this gate reads the vocabulary from there",
  );
  const names = published[1]
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  assert.ok(names.length > 0, "blocked: the Mod publishes no occupant kind, so no word was examined");
  return Object.freeze(
    names.map((name) => {
      const value = values.get(name);
      assert.ok(value !== undefined, `TileOccupantKind.Published names ${name}, which carries no declared value`);
      return value;
    }),
  );
}

/** The Mod's word for a tile nothing stands on, out of the healing declaration the classifier returns it from. */
function modNoOccupant(): string {
  const source = readRepository("integrations/stardew/src/Core/Policy/FarmhandForEachHealing.cs");
  const declared = /NoOccupant\s*=\s*"([^"]+)"/u.exec(source);
  assert.ok(
    declared?.[1] !== undefined,
    "FarmhandForEachHealing must still declare NoOccupant; this gate reads it there",
  );
  return declared[1];
}

/** One tile of the synthetic farm: the occupant word the Mod classifies it as, and the engine's own name for it. */
type TileFacts = Readonly<{ occupantKind: string; occupant: string }>;

/**
 * A synthetic farm with a strip on it, classified in the Mod's words.
 *
 * `violation` is how this gate is made red on purpose: an occupant word outside the vocabulary, or a row with a field
 * missing, is exactly the shape of a merge that dropped something.
 */
type Violation = Readonly<{ kind?: string; drop?: string }> | null;

function factsAt(x: number, y: number): TileFacts {
  if ((x + y) % 7 === 0) return { occupantKind: "stone", occupant: "stone" };
  if ((x * 3 + y) % 5 === 0) return { occupantKind: "weed", occupant: "object" };
  if (x === 45 && y === 13) return { occupantKind: "tree_stump", occupant: "stump" };
  if (x === 46 && y === 31) return { occupantKind: "grass", occupant: "grass" };
  return { occupantKind: TILE_OCCUPANT_NONE, occupant: TILE_OCCUPANT_NONE };
}

/** The farm's own answer to one rectangle: a row per tile, and the Mod's refusal over its area bound. */
function modAnswer(request: TileAreaRequest, areaLimit: number, violation: Violation): TileAreaResult {
  const echoed = { x: request.x, y: request.y, w: request.w, h: request.h, revision: snapshot.revision };
  if (request.w * request.h > areaLimit)
    return {
      ...echoed,
      status: "area_too_large",
      detail: `inspect_tiles_area_too_large:${String(areaLimit)}:${String(request.w)}x${String(request.h)}`,
      location: null,
      areaLimit,
      rows: null,
      omitted: 0,
    };
  const rows: TileAreaRow[] = [];
  for (let y = request.y; y < request.y + request.h; y += 1)
    for (let x = request.x; x < request.x + request.w; x += 1) {
      const facts = factsAt(x, y);
      const row: Record<string, unknown> = {
        x,
        y,
        tillable: facts.occupantKind === TILE_OCCUPANT_NONE,
        occupant: facts.occupant,
        occupantKind: violation?.kind ?? facts.occupantKind,
        hoed: false,
        watered: false,
        crop: false,
        passable: facts.occupantKind === TILE_OCCUPANT_NONE,
      };
      if (violation?.drop !== undefined) delete row[violation.drop];
      rows.push(row as unknown as TileAreaRow);
    }
  return {
    ...echoed,
    status: "answered",
    detail: null,
    location: "Farm",
    areaLimit,
    rows,
    omitted: 0,
  };
}

/** A session whose rectangle reader is the farm above, with every request it was asked written down. */
function farmSession(violation: Violation = null, areaLimit = 100) {
  const asked: TileAreaRequest[] = [];
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
    tileArea: async (request: TileAreaRequest) => {
      asked.push(request);
      return modAnswer(request, areaLimit, violation);
    },
  };
  return { tools: createStardewObservationTools(connection), asked };
}

type Answer = Readonly<{
  text: string;
  details: {
    selection?: {
      rowType?: string;
      verdict?: string;
      tiles?: { named?: number; withRows?: number; empty?: number; unreadable?: number };
      kinds?: readonly { kind: string; count: number; omitted: number; shown: readonly TileAreaRow[] }[];
    } | null;
    reasonCode?: string;
    selectionRefusal?: string | null;
  };
}>;

async function observe(tools: ReturnType<typeof createStardewObservationTools>, params: unknown): Promise<Answer> {
  const tool = tools.find((candidate) => candidate.name === "stardew_observe");
  assert.ok(tool, "stardew_observe is the one observation tool and must be mounted");
  const result = await tool.execute("observe_01", params as never, new AbortController().signal, () => {}, {} as never);
  const content = result.content[0];
  assert.ok(content !== undefined && content.type === "text", "an observation answers in one text block");
  return { text: content.text, details: result.details as Answer["details"] };
}

/** What one capability clause is examined through: the mounted tool and the answers it gave this session. */
type Probe = Readonly<{
  tools: ReturnType<typeof createStardewObservationTools>;
  asked: readonly TileAreaRequest[];
  wireFields: readonly string[];
  occupantKinds: readonly string[];
  noOccupant: string;
}>;

/** One capability the merged tool must still deliver, named so a loss points at the tool and the field to fix. */
type MergedCapability = Readonly<{
  capability: string;
  tool: string;
  field: string;
  /** `null` when the capability is delivered; otherwise the sentence saying what is missing. */
  deliver: (probe: Probe) => Promise<string | null>;
}>;

const STRIP = { select: [{ x: { from: 44, to: 46 }, y: { from: 12, to: 31 } }] };
const WIDE = { select: [{ x: { from: 0, to: 100 }, y: { from: 0, to: 0 } }] };

const MERGED_CAPABILITIES: readonly MergedCapability[] = Object.freeze([
  {
    // "Read any RECTANGLE of the current location in one call."
    capability: "rectangle_read_in_one_round_trip",
    tool: "stardew_observe",
    field: "select",
    deliver: async (probe) => {
      const before = probe.asked.length;
      const answer = await observe(probe.tools, STRIP);
      const reads = probe.asked.length - before;
      if (reads !== 1) return `the rectangle cost ${String(reads)} reads of the world; it must be one`;
      const request = probe.asked[probe.asked.length - 1];
      if (request === undefined || request.w * request.h !== 60)
        return `the read asked for ${JSON.stringify(request)} and a 3x20 strip is 60 tiles`;
      const rows = answer.details.selection?.kinds?.flatMap((kind) => kind.shown) ?? [];
      if (rows.length === 0) return "the answer carried no tile row at all";
      const row = rows[0] as unknown as Record<string, unknown>;
      const missing = probe.wireFields.filter((field) => !(field in row));
      return missing.length === 0 ? null : `a row lost ${missing.join(",")}, which the wire's row declares`;
    },
  },
  {
    // "w*h is at most 100, and a bigger rectangle is REFUSED by name with the limit and the size you asked for."
    capability: "rectangle_size_limit_refused_by_name",
    tool: "stardew_observe",
    field: "select",
    deliver: async (probe) => {
      const answer = await observe(probe.tools, WIDE);
      if (answer.details.selection !== null && answer.details.selection !== undefined)
        return "an over-limit rectangle was answered instead of refused";
      if (!answer.text.includes("101")) return `the refusal does not state the size asked for: ${answer.text}`;
      if (!answer.text.includes("100")) return `the refusal does not state the limit: ${answer.text}`;
      return null;
    },
  },
  {
    // "occupantKind (what stands there in the words a for_each where filter uses ... so a row can be filtered in
    // JavaScript with the same word a loop's where writes)".
    capability: "occupant_kind_in_the_where_vocabulary",
    tool: "stardew_observe",
    field: "occupantKind",
    deliver: async (probe) => {
      const answer = await observe(probe.tools, STRIP);
      const rows = answer.details.selection?.kinds?.flatMap((kind) => kind.shown) ?? [];
      if (rows.length === 0) return "the answer carried no tile row, so no occupant word was examined";
      const allowed = new Set([...probe.occupantKinds, probe.noOccupant]);
      for (const row of rows) {
        if (!answer.text.includes(row.occupantKind))
          return `the row's occupantKind ${row.occupantKind} is not printed, so the model never reads it`;
        if (!allowed.has(row.occupantKind))
          return `a row published occupantKind ${row.occupantKind}, which the Mod's vocabulary does not have`;
        const loop = readForEachLoop(
          { source: { area: { x: 44, y: 12, w: 3, h: 1 } }, where: [{ occupant: row.occupantKind }], do: null },
          null,
        );
        if (!loop.ok) return `the where filter refused the word ${row.occupantKind}: ${loop.code}`;
        if (loop.loop.where?.[0]?.occupant !== row.occupantKind)
          return `the where filter did not keep the word ${row.occupantKind} it was given`;
      }
      return null;
    },
  },
  {
    // "occupant (the engine's own name for what is stored on it, 'none' when it is free)".
    capability: "occupant",
    tool: "stardew_observe",
    field: "occupant",
    deliver: async (probe) => {
      const answer = await observe(probe.tools, STRIP);
      const rows = answer.details.selection?.kinds?.flatMap((kind) => kind.shown) ?? [];
      if (rows.length === 0) return "the answer carried no tile row, so no occupant was examined";
      for (const row of rows)
        if (typeof row.occupant !== "string" || !answer.text.includes(`occupant=${row.occupant}`))
          return `the row's occupant ${String(row.occupant)} is not printed beside its tile`;
      const free = rows.find((row) => row.occupantKind === probe.noOccupant);
      if (free !== undefined && free.occupant !== probe.noOccupant)
        return `a free tile published occupant ${free.occupant} rather than ${probe.noOccupant}`;
      return null;
    },
  },
]);

type CapabilityVerdict = Readonly<{
  examined: number;
  delivered: number;
  lost: number;
  findings: readonly string[];
  report: string;
}>;

/** Runs every capability clause against one session and reports the three counts the gate prints. */
async function capabilityVerdict(violation: Violation = null, areaLimit = 100): Promise<CapabilityVerdict> {
  const session = farmSession(violation, areaLimit);
  const probe: Probe = Object.freeze({
    tools: session.tools,
    asked: session.asked,
    wireFields: wireRowFields(),
    occupantKinds: modOccupantKinds(),
    noOccupant: modNoOccupant(),
  });
  const findings: string[] = [];
  let delivered = 0;
  for (const capability of MERGED_CAPABILITIES) {
    const missing = await capability.deliver(probe);
    if (missing === null) {
      delivered += 1;
      continue;
    }
    findings.push(
      `tool_capability_lost_in_a_merge:${capability.capability}:${capability.tool}:${capability.field} - ${missing}`,
    );
  }
  return Object.freeze({
    examined: MERGED_CAPABILITIES.length,
    delivered,
    lost: findings.length,
    findings: Object.freeze(findings),
    report: `capabilities examined ${String(MERGED_CAPABILITIES.length)} · delivered ${String(
      delivered,
    )} · lost ${String(findings.length)}`,
  });
}

test("the host's word for a free tile is the Mod's own NoOccupant", () => {
  assert.equal(
    TILE_OCCUPANT_NONE,
    modNoOccupant(),
    "the empty bucket is decided by this word, so a Mod-side rename must be red here",
  );
});

test("every capability the deleted tool promised is delivered by the tool that absorbed it", async () => {
  const verdict = await capabilityVerdict();
  assert.ok(verdict.examined > 0, "blocked: no capability was examined, so nothing was checked");
  assert.deepEqual(verdict.findings, [], verdict.report);
  assert.equal(verdict.delivered, verdict.examined, verdict.report);
  assert.match(verdict.report, /^capabilities examined \d+ · delivered \d+ · lost \d+$/u);
  assert.equal(verdict.lost, 0, verdict.report);
  // The deleted tool is gone from the observation class; a capability it promised may not be re-declared under it.
  const session = farmSession();
  const mounted = session.tools.map((tool) => tool.name);
  assert.equal(
    mounted.includes("stardew_inspect_tiles"),
    false,
    "the rectangle's own tool is deleted, not left beside",
  );
  assert.ok(mounted.includes("stardew_observe"), `the merged tool is the one that must answer: ${mounted.join(",")}`);
});

test("the gate is red on a row that loses a field the wire declares", async () => {
  const verdict = await capabilityVerdict({ drop: "passable" });
  assert.ok(verdict.lost > 0, "a row missing a field must be a lost capability, not a shorter row");
  assert.ok(
    verdict.findings.some((finding) =>
      finding.startsWith("tool_capability_lost_in_a_merge:rectangle_read_in_one_round_trip:stardew_observe:select"),
    ),
    verdict.report,
  );
  assert.match(verdict.findings.join("\n"), /passable/u, "the finding names the field that went missing");
});

test("the gate is red on an occupant word the Mod's vocabulary does not have", async () => {
  const verdict = await capabilityVerdict({ kind: "objectish" });
  assert.ok(verdict.lost > 0, "an invented occupant word must be red: a filter written on it matches nothing");
  assert.ok(
    verdict.findings.some((finding) =>
      finding.startsWith(
        "tool_capability_lost_in_a_merge:occupant_kind_in_the_where_vocabulary:stardew_observe:occupantKind",
      ),
    ),
    verdict.report,
  );
});

test("a 101-tile rectangle is refused by name with the limit and the size that was asked for", async () => {
  const session = farmSession();
  const answer = await observe(session.tools, WIDE);
  const code = answer.text.split("。")[0] ?? "";
  assert.equal(
    code,
    "observation_rectangle_refused:area_too_large:101:100",
    `the refusal states the size asked for and the limit, and nothing else in it needs decoding: ${answer.text}`,
  );
  assert.equal(answer.details.selection, null, "a refused rectangle publishes no rows that could read as an answer");
  assert.equal(
    session.asked.length,
    1,
    "the bound is the Mod's to enforce: the Host forwards the request and reads why",
  );
  assert.equal(
    answer.details.selectionRefusal,
    "inspect_tiles_area_too_large:100:101x1",
    "the Mod's own words stay in the operator evidence",
  );
  assert.equal(
    answer.text.includes("inspect_tiles"),
    false,
    "the model may not be taught the name of a tool that no longer exists",
  );
});

test("a 3x20 strip answers per tile, and its kind is the word a for_each where filter takes", async () => {
  const session = farmSession();
  const answer = await observe(session.tools, STRIP);
  assert.deepEqual(session.asked, [{ x: 44, y: 12, w: 3, h: 20 }], "the four numbers are the whole request");
  assert.equal(answer.details.selection?.rowType, "tile", "a rectangle answers in the tile row type");
  assert.equal(answer.details.selection?.tiles?.named, 60, "a 3x20 strip names sixty tiles");
  const kinds = answer.details.selection?.kinds ?? [];
  const total = kinds.reduce((sum, kind) => sum + kind.count, 0);
  assert.equal(total, 60, "every named tile lands in exactly one kind's count");
  const rows = kinds.flatMap((kind) => kind.shown);
  assert.ok(rows.length > 0);
  // THE FALSIFIER: one row's own word, fed straight into the filter a loop is written with.
  for (const row of rows) {
    const loop = readForEachLoop(
      { source: { area: { x: row.x, y: row.y, w: 1, h: 1 } }, where: [{ occupant: row.occupantKind }], do: null },
      null,
    );
    assert.ok(loop.ok, `${row.occupantKind} must be a word the where filter accepts`);
    assert.equal(loop.loop.where?.[0]?.occupant, row.occupantKind, "and it must travel as the caller wrote it");
    assert.match(answer.text, new RegExp(`\\(${String(row.x)},${String(row.y)}\\) ${row.occupantKind}`, "u"));
  }
  // The three zeroes are per tile here: read and empty, and every tile accounted for.
  const tiles = answer.details.selection?.tiles;
  assert.equal(
    tiles?.named,
    (tiles?.withRows ?? 0) + (tiles?.empty ?? 0) + (tiles?.unreadable ?? 0),
    "every named tile is in exactly one bucket",
  );
  assert.equal(tiles?.unreadable, 0, "the Mod answered the whole rectangle");
  assert.ok((tiles?.empty ?? 0) > 0, "the strip holds free ground, and it is MEASURED EMPTY rather than absent");
});
