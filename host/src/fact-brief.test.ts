import assert from "node:assert/strict";
import test from "node:test";

import { CompanionEventPump, type WorldFact } from "./event-pump.js";
import { createStardewObservationTools } from "./game-tools.js";
import {
  FACT_BRIEF_BLOCKS,
  composeFactBrief,
  composeWorldState,
  MAX_EVIDENCE_DETAIL_CHARS,
  unchangedWorldAnswer,
} from "./fact-brief.js";
import { NON_ROW_FAMILIES, TARGET_FAMILY_LABELS, nearbyTargetFamilies } from "./game-world-vocabulary.js";
import { SNAPSHOT_KEYS, type Snapshot } from "./protocol.js";

/**
 * THE FOUR BLOCKS, AS GATES RATHER THAN AS SHAPES SOMEONE REMEMBERED.
 *
 * <p>
 * The model's user message was one stringified object for a year: measured 2026-11-10 (`round44`, 109 delivered
 * batches) it averaged 11,066 characters, carried `worldFacts` and the SAME facts again under `events`, and the
 * player's own note ("找片水，钓条鱼回来") was one array element inside it - 0 of 162 thinking parts mentioned fishing.
 * `fact-brief.ts` replaces it with four named blocks of prose.
 * </p>
 *
 * <p>
 * A prose format is easy to break silently: a block that is not in the closed set, a fact that leaks into the note, a
 * stray JSON envelope in the middle of the text. Each is one assertion below, and each names the member that broke.
 * </p>
 */

const world: Snapshot = {
  revision: 1205,
  location: "Farm",
  tile: { x: 64, y: 15 },
  stamina: 82,
  health: 100,
  actionable: true,
  capabilities: [],
  catalogRevision: 3,
  enabledActionIds: [],
  presentationLocale: "zh-CN",
  exhausted: false,
  timeOfDay: 620,
  dayOfMonth: 3,
  seasonIndex: 0,
  year: 1,
  weather: "rain",
  currentTool: "(T)Hoe",
  currentToolSlot: 0,
  toolSlots: [{ slot: 0, label: "(T)Hoe", category: "hoe", upgradeLevel: 2 }],
  inventoryItemFacts: [
    { slot: 0, qualifiedItemId: "(O)388", displayName: "木头", stack: 47 },
    { slot: 1, qualifiedItemId: "(O)390", displayName: "石头", stack: 12 },
  ],
  cropTargets: [
    { targetId: "crop_1", x: 62, y: 14, cropId: "24", displayName: "Cauliflower" },
    { targetId: "crop_2", x: 63, y: 14, cropId: "24", displayName: "Cauliflower" },
  ],
  // A real farm's families are big: the whole point of naming six tiles and counting the rest is that these rows
  // arrive at 20-64 each.
  weedTargets: Array.from({ length: 20 }, (_, index) => ({ targetId: `weed_${String(index)}`, x: 60 + index, y: 15 })),
  debrisTargets: Array.from({ length: 30 }, (_, index) => ({
    targetId: `debris_${String(index)}`,
    x: 64 + (index % 8),
    y: 11 + Math.floor(index / 8),
  })),
  rockSourceTargets: Array.from({ length: 12 }, (_, index) => ({
    targetId: `rock_${String(index)}`,
    x: 70 + index,
    y: 20,
  })),
  harvestTargets: [],
} as unknown as Snapshot;

function fact(overrides: Partial<WorldFact> & Pick<WorldFact, "kind">): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    correlationId: overrides.kind,
    revision: 1,
    payload: {},
    ...overrides,
  }) as WorldFact;
}

const snapshotFact = (revision: number, payload: Snapshot = { ...world, revision } as Snapshot): WorldFact =>
  fact({ kind: "snapshot", eventId: `snapshot_${String(revision)}`, revision, payload: payload as never });

/** One batch that exercises every block: a player note, a fresh reading, events, and a settled programme. */
function richBatchFacts(): WorldFact[] {
  return [
    fact({ kind: "world_fact", eventId: "day_3", semanticKind: "day_started", payload: { day: 3 }, gameTime: "600" }),
    fact({
      kind: "world_fact",
      eventId: "dialogue_marnie",
      semanticKind: "npc_dialogue_presented",
      payload: { speaker: "Marnie", pages: ["早呀。"], choices: [] },
      gameTime: "620",
    }),
    fact({
      kind: "execution_receipt",
      eventId: "receipt_water_1",
      executionId: "exec_water",
      payload: {
        actionId: "water_crop",
        state: "rejected",
        reasonCode: "not_adjacent",
        evidence: { detail: "够不到 (74,22)，那块地不可耕" },
      },
      gameTime: "630",
    }),
    ...[2, 3, 4, 5].map((index) =>
      fact({
        kind: "execution_receipt",
        eventId: `receipt_route_${String(index)}`,
        executionId: `exec_route_${String(index)}`,
        payload: { actionId: "navigate_to_destination", state: "succeeded", reasonCode: "arrived" },
        gameTime: "630",
      }),
    ),
    fact({
      kind: "world_fact",
      eventId: "program_settled_plan_1",
      semanticKind: "program_settled",
      payload: {
        total: 2,
        counts: { succeeded: 1 },
        nodes: [{ actionId: "water_crop", state: "failed", reasonCode: "not_adjacent", hint: "先走近一点" }],
      },
    }),
  ];
}

const playerInput = {
  source: "player_text" as const,
  inputId: "input_1",
  text: "找片水，钓条鱼回来",
  locale: "zh-CN",
  timestampMs: 1,
};

function richBrief(): string {
  return composeFactBrief({
    inputs: [playerInput],
    snapshot: { snapshot: world, revision: 1205, ageTurns: 0 },
    events: richBatchFacts(),
    locale: "zh-CN",
  });
}

/** Every block name the text opens, in order. */
function blocksOf(text: string): string[] {
  return [...text.matchAll(/<([a-z-]+)>/gu)].map((match) => match[1] ?? "");
}

test("block_coverage: every block the composer emits is in the closed set, and the set is all four", () => {
  // The population is `FACT_BRIEF_BLOCKS` - the declaration the prompt floor names - so a fifth block cannot be
  // emitted without failing here by name, and a member that no composition ever produces is dead weight in the floor.
  const emitted = new Set(blocksOf(richBrief()));
  const outside = [...emitted].filter((name) => !(FACT_BRIEF_BLOCKS as readonly string[]).includes(name));
  assert.deepEqual(outside, [], `these blocks are not in FACT_BRIEF_BLOCKS: ${outside.join(", ")}`);
  const unproduced = FACT_BRIEF_BLOCKS.filter((name) => !emitted.has(name));
  assert.deepEqual(
    unproduced,
    [],
    `the fixture produces no <${unproduced.join("> or <")}> block, so nothing here proves the composer can emit it`,
  );
  // The same text also proves each block is CLOSED: an opening tag with no closing tag of the same name would leave
  // the model with a block whose end it cannot see.
  const text = richBrief();
  for (const name of FACT_BRIEF_BLOCKS) {
    assert.equal(
      text.split(`<${name}>`).length,
      text.split(`</${name}>`).length,
      `the <${name}> block is opened and closed a different number of times`,
    );
  }
});

test("note_in_own_block: the player's words are in <player-note> and nowhere else", () => {
  const text = richBrief();
  const occurrences = text.split(playerInput.text).length - 1;
  assert.equal(
    occurrences,
    1,
    `the player's note appears ${String(occurrences)} times, and it must appear exactly once`,
  );
  const note = /<player-note>\n([\s\S]*?)\n<\/player-note>/u.exec(text)?.[1];
  assert.equal(note, playerInput.text, "the note block holds the player's words verbatim, and nothing else");
});

test("bare_json_in_model_text: the composed text is prose, not an envelope", () => {
  const text = richBrief();
  // The shape this replaces carried `{"kind":"gamebuddy_fact_batch"` and `":"` between every key and value. Either
  // marker in a block means a JSON object has leaked into the model's message.
  assert.equal(text.includes('{"'), false, `the composed text contains a JSON object: ${text.slice(0, 200)}`);
  assert.equal(text.includes('":"'), false, `the composed text contains a JSON key/value pair: ${text.slice(0, 200)}`);
  assert.equal(text.includes("gamebuddy_fact_batch"), false, "the delivery no longer announces a wire kind at all");
});

test("the world block names its revision and its freshness, and never claims to be the world", () => {
  const fresh = composeWorldState({ snapshot: world, revision: 1205, ageTurns: 0 });
  assert.match(fresh, /^<world-state>\n世界（revision 1205，刚刚更新）$/mu);
  const stale = composeWorldState({ snapshot: world, revision: 1205, ageTurns: 3 });
  assert.match(stale, /^<world-state>\n世界（revision 1205，本轮无新观察）$/mu);
  assert.match(stale, /（这是 3 轮之前看到的，世界已经不一样了）/u, "and how old the reading is, in words");
  const nothing = composeWorldState(undefined);
  assert.equal(nothing, "<world-state>\n世界：尚未收到观察\n</world-state>");
});

test("the world block names the objects she acts on, with their tiles", () => {
  const text = composeWorldState({ snapshot: world, revision: 1205, ageTurns: 0 });
  assert.match(text, /手持: 锄头/u, "the held tool is said in words");
  assert.match(text, /待浇水的作物 \(63,14\)/u, "the nearest dry crop is named with its tile, nearest first");
  assert.match(text, /杂草 \(64,15\)/u, "the nearest weed tile is named");
  assert.match(text, /这一带没有/u, "and a family the Mod published as empty says so");
});

test("a reading that has not changed is one line, not the whole world again", () => {
  const answer = unchangedWorldAnswer(1205);
  assert.equal(answer, "自 revision 1205 以来世界没有变化");
  const full = composeWorldState({ snapshot: world, revision: 1205, ageTurns: 0 });
  // The reading is stated as the two lengths, so a future change that quietly returns the dump cannot pass by
  // looking like a sentence.
  assert.ok(
    answer.length < full.length / 4,
    `the unchanged answer is ${String(answer.length)} chars and the dump is ${String(full.length)} - it must be a line`,
  );
});

test("world_state_present: the pump states the world on EVERY batch, including batches that brought no snapshot", async () => {
  const pump = new CompanionEventPump();
  const batches: string[] = [];
  pump.enqueueFact(snapshotFact(1205));
  pump.enqueueFact(
    fact({ kind: "execution_receipt", eventId: "receipt_1", executionId: "exec_1", payload: { state: "succeeded" } }),
  );
  await pump.flush({
    async deliver(batch) {
      batches.push(batch.text);
    },
  });
  // Three later turns, none of which observes anything: each is opened by a receipt and must still state the world.
  for (let index = 2; index <= 4; index += 1) {
    pump.enqueueFact(
      fact({
        kind: "execution_receipt",
        eventId: `receipt_${String(index)}`,
        executionId: `exec_${String(index)}`,
        payload: { state: "succeeded" },
      }),
    );
    await pump.flush({
      async deliver(batch) {
        batches.push(batch.text);
      },
    });
  }
  const carrying = batches.filter((text) => text.includes("<world-state>")).length;
  assert.equal(carrying, batches.length, `world_state_present ${String(carrying)}/${String(batches.length)}`);
  assert.equal(batches.length, 4, "and the run has four batches to count, so the ratio is not 0/0");
  assert.match(batches[1] ?? "", /本轮无新观察/u, "a batch with no observation says so");
  assert.match(batches[1] ?? "", /体力: 82/u, "and still states what the last observation saw");

  // THE READINGS, printed rather than estimated.
  process.stdout.write(`world_state_present ${String(carrying)}/${String(batches.length)}\n`);
});

test("prose_cost_per_batch: what one delivery costs, against the envelope it replaces", () => {
  const facts = richBatchFacts();
  const inputs = [playerInput];
  const prose = composeFactBrief({
    inputs,
    snapshot: { snapshot: world, revision: 1205, ageTurns: 0 },
    events: facts,
    locale: "zh-CN",
  });
  // round44's own shape, computed from the SAME contents so the two numbers describe one batch: the envelope was
  // `{kind, batchId, disposition, triggerEventIds, playerInputs, worldFacts, events}`, with `events` a second copy of
  // the presentable facts and the whole snapshot under `payload`.
  const envelope = JSON.stringify({
    kind: "gamebuddy_fact_batch",
    batchId: "batch_fixture",
    disposition: "steer",
    triggerEventIds: inputs.map((input) => input.inputId),
    playerInputs: inputs,
    worldFacts: [snapshotFact(1205), ...facts],
    events: [snapshotFact(1205), ...facts.filter((entry) => entry.kind === "world_fact")],
  });
  process.stdout.write(
    `prose_cost_per_batch ${String(prose.length)} chars against the same batch as JSON ${String(envelope.length)} chars\n`,
  );
  assert.ok(
    prose.length < envelope.length,
    `the prose delivery is ${String(prose.length)} chars and the envelope it replaces is ${String(envelope.length)}`,
  );
});

test("target_family_labels: every row family the wire publishes has a word, or a stated reason it is not a place", () => {
  // THE POPULATION IS THE WIRE'S OWN KEY LIST. A hand-maintained table of families to print would go stale the next
  // time the Mod grew one - and the failure would be silent: a family with no label renders nothing.
  const families = SNAPSHOT_KEYS.filter((key) => /(?:Targets|Sites|Slots)$/u.test(key));
  const missing = families.filter((key) => !(key in TARGET_FAMILY_LABELS) && !(key in NON_ROW_FAMILIES));
  assert.deepEqual(
    missing,
    [],
    `these wire families have no label and no NON_ROW_FAMILIES reason: ${missing.join(", ")}`,
  );
  assert.ok(families.length >= 60, `examined ${String(families.length)} families, which is too few to be the wire`);
  // And the label table may not name a family the wire does not publish: that is a word for nothing.
  const unknown = Object.keys(TARGET_FAMILY_LABELS).filter(
    (key) => !(SNAPSHOT_KEYS as readonly string[]).includes(key),
  );
  assert.deepEqual(unknown, [], `these labels name families the wire does not publish: ${unknown.join(", ")}`);
  process.stdout.write(`target_family_labels examined ${String(families.length)} families\n`);
});

test("nearbyTargetFamilies reads the snapshot it is given, and says which families it did not measure", () => {
  const families = nearbyTargetFamilies(world);
  const crops = families.find((family) => family.family === "cropTargets");
  assert.equal(crops?.total, 2);
  assert.equal(crops?.rendered, "待浇水的作物 (63,14) (62,14)");
  const harvest = families.find((family) => family.family === "harvestTargets");
  assert.equal(harvest?.total, 0, "a published empty family is a measured zero");
  assert.equal(harvest?.rendered, undefined, "and prints on the empty line rather than as a row");
  assert.equal(
    families.some((family) => family.family === "chests"),
    false,
    "a family the snapshot does not carry is not measured, and must not print",
  );
});

test("the composed delivery is deterministic: the same batch renders the same bytes", () => {
  assert.equal(richBrief(), richBrief());
});

/**
 * `observe_result_chars` and `observe_unchanged_revision_answers`, measured through the real tool.
 *
 * The baseline is `round44`'s own: 31 calls, median 20,980 characters, 648,059 in total, 81.1% of every tool-result byte
 * in the run - spent asking the Mod for a world the turn's batch already carried in 28 of those 31 calls.
 */
test("observe_result_chars: the observation answer is the state block, and an unchanged revision is one line", async () => {
  const state: Record<string, unknown> = {
    connected: true,
    sessionId: "session_1",
    capabilities: [],
    catalogRegistrations: [],
    catalogRevision: 3,
    enabledActionIds: [],
    snapshot: { ...world, revision: 1205 },
    latestReceipt: null,
    latestReasonCode: null,
  };
  const connection = {
    scope: { integrationId: "stardew", saveId: "save_1", worldId: "world_1", playerId: "player_1" },
    module: {},
    state,
    async observe() {
      return state.snapshot;
    },
  };
  const tool = createStardewObservationTools(connection as never).find(
    (candidate) => candidate.name === "stardew_observe",
  );
  assert.ok(tool !== undefined, "stardew_observe must be mounted");

  const answers: string[] = [];
  let revision = 1205;
  for (let call = 0; call < 31; call += 1) {
    // Two thirds of the calls find a new revision, one third find the one they already stated - the shape round44's
    // 28-of-31 measurement describes.
    if (call % 3 !== 2) revision += 1;
    state.snapshot = { ...world, revision };
    const result = await tool.execute("t", {}, new AbortController().signal, () => {}, {} as never);
    answers.push(result.content[0]?.type === "text" ? result.content[0].text : "");
  }

  const lengths = answers.map((answer) => answer.length).sort((left, right) => left - right);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  const total = lengths.reduce((sum, value) => sum + value, 0);
  const unchanged = answers.filter((answer) => answer.startsWith("自 revision ")).length;
  process.stdout.write(
    `observe_result_chars median ${String(median)} total ${String(total)} over ${String(answers.length)} calls ` +
      `(round44 baseline median 20980, total 648059 over 31)\n`,
  );
  process.stdout.write(`observe_unchanged_revision_answers ${String(unchanged)}/${String(answers.length)}\n`);

  assert.equal(unchanged, 10, "every observation that found the revision it already stated answered in one line");
  assert.ok(
    median < 20_980 / 4,
    `the observation answer is ${String(median)} chars at the median, against round44's 20,980-char dump`,
  );
  assert.ok(answers.every((answer) => answer.startsWith("<world-state>") || answer.startsWith("自 revision ")));
});

/**
 * A FAILURE LINE CARRIES BOTH HALVES OF A REFUSAL: the Mod's sentence AND its evidence.
 *
 * Measured at `516e2559`: `failureWords` printed `hint ?? detail`, so a node carrying both reached her with the short
 * sentence alone - and the numbers that make a refusal actionable (`owner=Pierre;owner_tile=4,17;actor_tile=5,19;
 * radius=1`) are exactly what the detail holds and the hint never repeats. A refusal she cannot decode is a refusal she
 * answers by guessing, and that guess is where an invented world fact comes from.
 *
 * The population is the fixture's own nodes: every one carrying a non-empty `reasonDetail` must reach
 * `<execution-result>`, whatever else it carries, and the count is asserted so a fixture that stopped carrying details
 * fails here instead of passing with nothing to examine.
 */
test("execution_result_evidence: every settled node's refusal detail reaches the model beside its hint", () => {
  const detail = "owner=Pierre;owner_tile=4,17;actor_tile=5,19;radius=1";
  const longDetail = `${"far=".repeat(60)}end`;
  const nodes = [
    {
      nodeId: "n01",
      actionId: "water_crop",
      state: "failed",
      reasonCode: "npc_in_the_way",
      hint: "请 Pierre 让开",
      reasonDetail: detail,
    },
    // A detail with NO hint: the evidence is all this node has to say for itself.
    {
      nodeId: "n02",
      actionId: "shop_purchase",
      state: "failed",
      reasonCode: "out_of_stock",
      reasonDetail: "item=(O)388;stock=0",
    },
    // A hint with NO detail: the fallback must not be lost by the change that keeps both.
    { nodeId: "n03", actionId: "till_soil", state: "cancelled", reasonCode: "stopped", hint: "被打断了" },
    // Neither: the reason code alone is the whole account the Mod gave.
    { nodeId: "n04", actionId: "harvest_crop", state: "rejected", reasonCode: "not_ready" },
    // Past the bound: printed up to it, with the cut named rather than silent.
    { nodeId: "n05", actionId: "plant_seed", state: "failed", reasonCode: "blocked", reasonDetail: longDetail },
  ];
  const text = composeFactBrief({
    inputs: [],
    snapshot: undefined,
    events: [
      fact({
        kind: "world_fact",
        eventId: "program_settled_evidence",
        semanticKind: "program_settled",
        payload: { total: nodes.length, counts: { succeeded: 0 }, nodes },
      }),
    ],
    locale: "zh-CN",
  });
  const opened = text.indexOf("<execution-result>");
  const block = opened === -1 ? "" : text.slice(opened, text.indexOf("</execution-result>"));
  assert.notEqual(opened, -1, "the fixture's programme must render one <execution-result> block");

  const withDetail: readonly Readonly<{ nodeId: string; reasonDetail: string }>[] = nodes.flatMap((node) =>
    typeof node.reasonDetail === "string" && node.reasonDetail.trim() !== ""
      ? [{ nodeId: node.nodeId, reasonDetail: node.reasonDetail }]
      : [],
  );
  assert.equal(
    withDetail.length,
    3,
    "the fixture must carry nodes with a refusal detail, or this gate examines nothing (blocked, not green)",
  );
  for (const node of withDetail) {
    const expected = node.reasonDetail.trim();
    const shown = expected.slice(0, MAX_EVIDENCE_DETAIL_CHARS);
    assert.ok(
      block.includes(shown),
      `${node.nodeId}: its refusal detail ${JSON.stringify(expected)} never reaches the model; the line it should be ` +
        `in says ${JSON.stringify(block)}`,
    );
  }

  // BOTH, NOT ONE INSTEAD OF THE OTHER: the node that carries a sentence and its evidence prints the two of them.
  assert.ok(block.includes("请 Pierre 让开"), "n01's hint is the sentence");
  assert.ok(block.includes(detail), "and n01's detail is its evidence, not a casualty of the sentence");
  // The cut is NAMED. A silent truncation would be the same defect one layer down: she would read a partial coordinate
  // list as the whole one.
  assert.ok(!block.includes(longDetail), "n05's detail is bounded, not printed whole");
  assert.ok(
    block.includes(`${longDetail.slice(0, MAX_EVIDENCE_DETAIL_CHARS)}…`),
    "n05's detail is printed up to the bound, and marked",
  );
  // AND THE HALVES THAT ARE ALONE STAY: a detail without a hint, a hint without a detail, and a node with neither.
  assert.ok(block.includes("item=(O)388;stock=0"), "n02's detail is its whole account");
  assert.ok(block.includes("被打断了"), "n03's hint survives, and no detail was invented for it");
  assert.ok(block.includes("not_ready"), "n04 is explained by the Mod's own code");
});
