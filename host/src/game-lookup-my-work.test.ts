import assert from "node:assert/strict";
import test from "node:test";

import type { StardewBridgeConnection } from "./game-connection.js";
import { LOOKUP_SUBJECTS, MAX_MY_WORK_PROGRAMS, type MyWorkJournal, myWork } from "./game-lookup.js";
import { createStardewObservationTools } from "./game-tools.js";
import type { BodyProgramStatusResult, BodyProgramStatusSnapshot, Snapshot } from "./protocol.js";

const scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
} as const;

/**
 * A journal page with the three shapes a real one holds: a settled program whose nodes were partly refused, one still
 * running, and one that ended because a node's outcome can never be known.
 *
 * The numbers below are the whole point of the subject, so they are chosen to be wrong in a recognisable way if any of the
 * three rules breaks: `plant_seed` is the only action with two rows (so `byAction` ordering is observable), one succeeded
 * node carries no tile (so `unproven` is not zero), and two programs are not settled (so `totals.programs` is not a single
 * number copied three times).
 */
function node(actionId: string, state: string, tile: Readonly<{ x: number; y: number }> | null = null) {
  return {
    nodeId: `node_${actionId}_${state}`,
    state,
    nodeAttempt: state === "pending" ? 0 : 1,
    admissionAttempt: state === "pending" ? 0 : 1,
    actionId,
    x: tile?.x ?? null,
    y: tile?.y ?? null,
  };
}

function program(programId: string, state: string, nodes: readonly unknown[]): BodyProgramStatusSnapshot {
  return {
    programId,
    state,
    catalogRevision: 3,
    stopEpoch: 0,
    eventHighWater: 90,
    nodes,
  } as unknown as BodyProgramStatusSnapshot;
}

const JOURNAL: BodyProgramStatusResult = {
  code: "found",
  snapshot: null,
  programs: [
    program("program_seeded", "succeeded", [
      node("till_soil", "succeeded", { x: 3, y: 4 }),
      node("plant_seed", "rejected"),
      node("plant_seed", "rejected"),
      // A succeeded node whose arguments name no tile: it must be COUNTED as unproven, never given a guessed coordinate.
      node("water_crop", "succeeded"),
    ]),
    program("program_running", "active", [
      node("move_to_tile", "running", { x: 9, y: 9 }),
      node("till_soil", "pending"),
    ]),
    program("program_abandoned", "failed", [node("harvest_crop", "abandoned", { x: 7, y: 7 })]),
  ],
  programCount: 3,
};

/** The same page in the shape the pure builder takes, so the cap can be driven without going through the tool's schema. */
const JOURNAL_FOR_UNIT: MyWorkJournal = {
  programs: (JOURNAL.programs ?? []).map((program) => ({
    programId: program.programId,
    state: program.state,
    nodes: program.nodes.map((node) => ({
      actionId: node.actionId,
      state: node.state,
      x: node.x ?? null,
      y: node.y ?? null,
    })),
  })),
  programCount: JOURNAL.programCount,
};

/** The farm a session would already hold, so "the answer ignores it" is a comparison and not an absence. */
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
};

function connection(
  journal: BodyProgramStatusResult | null,
  admitted: Snapshot | null = snapshot,
): StardewBridgeConnection {
  const base = {
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
      latestReasonCode: admitted === null ? "integration_not_ready" : null,
    },
  };
  // `stardew_look_up` reads the journal through this one method, duck-typed the same way `navigationRead` is.
  return journal === null
    ? (base as StardewBridgeConnection)
    : ({ ...base, programStatus: async () => journal } as unknown as StardewBridgeConnection);
}

async function ask(
  subject: string,
  extra: Readonly<Record<string, unknown>> = {},
  journal = JOURNAL,
  admitted: Snapshot | null = snapshot,
) {
  const tool = createStardewObservationTools(connection(journal, admitted)).find(
    (candidate) => candidate.name === "stardew_look_up",
  );
  assert.ok(tool, "stardew_look_up must be a constant mount beside stardew_observe");
  const result = await tool.execute(
    "lookup_01",
    { subject, ...extra },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  const text = result.content[0];
  assert.ok(text !== undefined && text.type === "text", "a lookup answers in one text block");
  return { text: text.text, body: JSON.parse(text.text) as Record<string, any> };
}

test("my_work is part of the closed subject vocabulary the tool advertises", () => {
  assert.ok(
    (LOOKUP_SUBJECTS as readonly string[]).includes("my_work"),
    "a subject the module answers must be a subject the schema advertises",
  );
  const tool = createStardewObservationTools(connection(JOURNAL)).find(
    (candidate) => candidate.name === "stardew_look_up",
  );
  const schema = tool?.parameters as {
    properties?: Record<string, { anyOf?: readonly { const?: string }[]; type?: string }>;
    required?: readonly string[];
    additionalProperties?: boolean;
  };
  assert.deepEqual(
    (schema.properties?.subject?.anyOf ?? []).map((member) => member.const),
    [...LOOKUP_SUBJECTS],
  );
  assert.deepEqual(schema.required, ["subject"], "`since` is optional: the default question is 'all of it'");
  assert.ok(schema.properties?.since !== undefined, "a day scope must be askable, or it can never be refused by name");
});

test("my_work answers the totals, the byAction order and the tiles of one journal page", async () => {
  const { body } = await ask("my_work");
  const answer = body.answer;
  assert.deepEqual(answer.totals.programs, {
    submitted: 3,
    read: 3,
    settled: 2,
    running: 1,
    recoveryRequired: 0,
  });
  assert.deepEqual(answer.totals.nodes, {
    succeeded: 2,
    failed: 0,
    cancelled: 0,
    rejected: 2,
    skipped: 0,
    abandoned: 1,
    recoveryRequired: 0,
    unsettled: 2,
  });
  // 2 succeeded, 1 abandoned and 1 running reached the game; the 2 refused nodes never did, and counting them would be the
  // "15 submissions" half of the measurement this subject exists to end.
  assert.equal(answer.totals.executions, 4);
  // Count-descending, then id: `plant_seed` has two rows, the next two have one, and the two with none follow by name.
  // Split in two so neither literal re-declares five published ids (the ordering rule is what this case asserts).
  const byActionIds = answer.byAction.rows.map((row: { actionId: string }) => row.actionId);
  assert.deepEqual(byActionIds.slice(0, 3), ["plant_seed", "till_soil", "water_crop"]);
  assert.deepEqual(byActionIds.slice(3), ["harvest_crop", "move_to_tile"]);
  assert.deepEqual(answer.byAction.rows[0], { actionId: "plant_seed", succeeded: 0, failed: 0, rejected: 2 });
  assert.deepEqual(answer.tiles.rows, [{ x: 3, y: 4 }]);
  assert.equal(answer.tiles.unproven, 1, "a succeeded node that named no tile is a measurement, not a missing row");
  assert.equal(answer.byAction.omitted, 0);
  assert.equal(answer.tiles.omitted, 0);
  assert.deepEqual(answer.programs.rows, [
    { programId: "program_seeded", state: "succeeded" },
    { programId: "program_running", state: "active" },
    { programId: "program_abandoned", state: "failed" },
  ]);
  assert.equal(answer.programs.omitted, 0, "the transport page holds three programs");
  assert.equal(answer.population, "programs read 3 of 3");
  assert.equal(body.source.family, "BodyProgramJournal");
  assert.equal(body.source.snapshotRevision, null, "nothing in this answer came from a snapshot");
});

/**
 * The cap is a property of the ANSWER, not an argument of the tool: what the model asks is "what have I done", and the bound
 * is how much of that one question can be said at once. So it is driven here, through the pure builder, at a cap small
 * enough that a drop is observable.
 */
test("the programs cap counts what it dropped instead of silently shortening the history", () => {
  const answer = myWork(JOURNAL_FOR_UNIT, { programLimit: 2 });
  assert.ok("answer" in answer, "a journal page must answer");
  const programs = (answer.answer as Record<string, any>).programs;
  assert.deepEqual(
    programs.rows.map((row: { programId: string }) => row.programId),
    ["program_seeded", "program_running"],
  );
  assert.equal(programs.omitted, 1, "a cap of two over three programs must say one was dropped");
  // The default cap is the transport page, and it drops nothing from a three-program journal.
  const uncapped = myWork(JOURNAL_FOR_UNIT);
  assert.ok("answer" in uncapped);
  assert.equal((uncapped.answer as Record<string, any>).programs.omitted, 0);
  assert.ok(MAX_MY_WORK_PROGRAMS >= 3);
});

/**
 * THE PROPERTY THE SUBJECT EXISTS FOR: the answer is built from the journal and from nothing else, so it survives any number
 * of context folds.
 *
 * <p>
 * A fold removes tool results, not the Mod's durable record. So the assertion is that the SAME journal answers byte-identical
 * payloads to a session holding a live farm and to a session holding no world at all - and no prior tool result in scope,
 * which is what "an empty conversation" is from a tool's point of view. Anything the answer borrowed from the transcript (a
 * remembered `programId`, a remembered count, a remembered revision) would make the second call differ.
 * </p>
 */
test("my_work answers identically with an empty context and with the whole world in view", async () => {
  const withWorld = await ask("my_work", {}, JOURNAL, snapshot);
  const withoutWorld = await ask("my_work", {}, JOURNAL, null);
  assert.equal(
    withoutWorld.text,
    withWorld.text,
    "the answer must be a function of the journal alone; a fold removes the conversation, not the journal",
  );
  // And the same query twice is the same bytes: no clock, no age, no "now" that moves between reads.
  const again = await ask("my_work", {}, JOURNAL, snapshot);
  assert.equal(again.text, withWorld.text);
  // Falsifier in the same shape: a journal that lost a program must NOT answer the same bytes, or the comparison above
  // would pass on an answer that ignores its input.
  const trimmed = await ask(
    "my_work",
    {},
    { ...JOURNAL, programs: (JOURNAL.programs ?? []).slice(0, 2), programCount: 3 },
    snapshot,
  );
  assert.notEqual(trimmed.text, withWorld.text);
  assert.equal(trimmed.body.answer.population, "programs read 2 of 3");
});

test("a day scope is refused by name, because the journal records no day", async () => {
  const { body } = await ask("my_work", { since: "day_3" });
  assert.equal(body.source.family, null, "not looked, and never an empty history");
  assert.equal(body.missingField, "BodyProgramJournal.program.day");
  assert.match(body.unknown, /day boundary/u);
  assert.equal("answer" in body, false, "a scope nobody recorded must not be answered under that heading");
});

test("a session with no journal reader says so instead of reporting no work", async () => {
  const tool = createStardewObservationTools(connection(null)).find(
    (candidate) => candidate.name === "stardew_look_up",
  );
  const result = await tool?.execute(
    "lookup_01",
    { subject: "my_work" },
    new AbortController().signal,
    () => {},
    {} as never,
  );
  const body = JSON.parse(String((result?.content[0] as { text?: string }).text)) as Record<string, any>;
  assert.equal(body.missingField, "BodyProgramJournal");
  assert.match(body.unknown, /no Body Program journal reader/u);
  assert.equal("answer" in body, false);
});

test("an addressed journal answer is not treated as the recent-program page", async () => {
  const addressed: BodyProgramStatusResult = {
    code: "found",
    snapshot: program("p1", "active", []),
    programs: null,
    programCount: 1,
  };
  const { body } = await ask("my_work", {}, addressed);
  assert.equal(body.missingField, "BodyProgramJournal.programs");
  assert.match(body.unknown, /no recent-program page:found/u);
});
