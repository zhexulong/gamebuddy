import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BODY_WAY_FORWARD_EN, BODY_WAY_FORWARD_ZH, formatBodyState } from "./game-world-vocabulary.js";
import {
  OBSERVATION_SELECTION_ROWS_LIMIT_MAX,
  TARGET_FAMILY_LABELS,
  axisTileCount,
  selectObservedRows,
  selectTileAreaRows,
  selectionDisagreements,
  selectionGateReport,
  withoutRowFamilies,
} from "./game-world-vocabulary.js";
import type { ObservationSelection } from "./game-world-vocabulary.js";
import { assertReportsWithoutInstructing } from "./fact-block-prose.test-support.js";
import type { Snapshot, TileAreaResult } from "./protocol.js";

/**
 * `body_state_names_a_way_out`: a held body says who holds it and what to do next, never only that it cannot act.
 *
 * <p>
 * MEASURED 2026-11-13 (`round47`, the companion's own debrief, verbatim): "进入农舍后状态变成 身体: 忙（不可行动），我把
 * 「身体忙」读成「这轮不能动」，于是不再提交任何东西。这是判断错误：身体忙说明引擎占着这个 actor，我该做的是查状态/等
 * 结算，看它什么时候释放，而不是默认放弃。" The line she read named neither the holder nor the way out, so the only
 * reading available to her was a prohibition - and she obeyed it for the rest of the run.
 * </p>
 * <p>
 * The same defect class as `soil_not_diggable` before it named a tile: a refusal that names no address. The guard below
 * is the property, not today's wording - the line must carry the holder, whether a command can take the body, and one
 * of the declared way-forward answers, and the word that made her stop submitting must not appear at all.
 * </p>
 */

/** The wire's own schema document: the disposition set the Mod publishes and the Host validates. */
const WIRE_SCHEMA_PATH = fileURLToPath(new URL("../../protocol/bridge-v1.schema.json", import.meta.url));

/**
 * The closed set of `actorDispositionKind` values, read from the wire's schema rather than retyped here.
 *
 * The population has to come from the authority: `protocol.ts` validates every snapshot against this enum
 * (`invalid_snapshot:actorDispositionKind:<value>`), so a kind added to the Mod and the wire without a line here is a
 * body state she would read as `未知` forever - and a hand-written list in this test could never notice.
 */
function wireDispositionKinds(): readonly string[] {
  const schema = JSON.parse(readFileSync(WIRE_SCHEMA_PATH, "utf8")) as unknown;
  const found = findDispositionEnum(schema);
  assert.ok(
    found !== undefined,
    "the wire schema declares no actorDispositionKind enum any more: find its replacement",
  );
  return found;
}

function findDispositionEnum(node: unknown): readonly string[] | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const record = node as Record<string, unknown>;
  const properties = record.properties;
  if (properties !== null && typeof properties === "object") {
    const declared = (properties as Record<string, unknown>).actorDispositionKind;
    if (declared !== null && typeof declared === "object") {
      const values = (declared as Record<string, unknown>).enum;
      if (Array.isArray(values) && values.every((value) => typeof value === "string")) return values as string[];
    }
  }
  for (const value of Object.values(record)) {
    const nested = findDispositionEnum(value);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** The answers the line may offer, in both languages, read from the module's own vocabulary rather than retyped. */
const WAY_FORWARD_ZH = Object.values(BODY_WAY_FORWARD_ZH);
const WAY_FORWARD_EN = Object.values(BODY_WAY_FORWARD_EN);

/**
 * The property: a held-body line names its holder, says whether a command can take the body, and names the way
 * forward. Throwing here is what makes the guard reusable as its own falsifier - the pre-change lines are fed to it.
 */
function assertBodyLineNamesAWayOut(line: string, holder: string, zh = true): void {
  const ways = zh ? WAY_FORWARD_ZH : WAY_FORWARD_EN;
  assert.match(
    line,
    new RegExp(zh ? `持有: ${holder}` : `held by: ${holder}`, "u"),
    `the line names the holder: ${line}`,
  );
  assert.match(line, new RegExp(zh ? "可由指令接管: (是|否|未知)" : "command can take over: (yes|no|unknown)", "u"));
  assert.ok(
    ways.some((way) => line.includes(way)),
    `the line names one of the declared ways forward (${ways.join(" / ")}), not only that the body is held: ${line}`,
  );
  assert.ok(
    !line.includes("不可行动") && !line.includes("not actionable"),
    `"cannot act" is the reading that made her stop submitting; a line may not end there: ${line}`,
  );
}

/**
 * The property: a way-forward pair names a state in both halves. Read from `fact-block-prose.test-support` so the same
 * detector covers the world-state note; the falsifier below is the two sentences this repo shipped.
 */
test("body_state_names_a_way_out: neither half of a way-forward pair instructs", () => {
  // Two languages, two claims: `重试可行` reports a feasibility and `retry now` ordered her to act. A pair that disagrees
  // is a second claim nobody owns, so every key is read in both halves rather than the half that happens to be Chinese.
  const chinese = Object.entries(BODY_WAY_FORWARD_ZH);
  const english = new Map(Object.entries(BODY_WAY_FORWARD_EN));
  assert.ok(chinese.length > 0, "a zero population would agree with itself");
  assert.deepEqual(
    [...english.keys()].sort(),
    chinese.map(([key]) => key).sort(),
    "the two halves answer the same keys",
  );
  for (const [key, label] of chinese) {
    assertReportsWithoutInstructing(label, `the Chinese half of ${key}`);
    assertReportsWithoutInstructing(english.get(key) ?? "", `the English half of ${key}`);
  }
});

test("body_state_names_a_way_out: the guard refuses the sentences it was written for", () => {
  assert.throws(
    () => assertReportsWithoutInstructing("body: busy · held by: transient · next: retry now", "the English half"),
    /this one instructs/u,
  );
  assert.throws(
    () =>
      assertReportsWithoutInstructing(
        "没读到的格子不是空的：那几格的 occupant 和 tillable 这次没有人回答，别当成空地。",
        "the unreadable bucket",
      ),
    /this one instructs/u,
  );
});

test("body_state_names_a_way_out: every wire disposition does, in both languages", () => {
  const kinds = wireDispositionKinds();
  assert.ok(kinds.length > 0, "zero population is blocked, never green: no disposition kinds were read");
  const held = kinds.filter((kind) => kind !== "idle");
  assert.ok(held.length > 0, "the disposition set declares no hold at all: this guard would agree with itself");

  for (const kind of held) {
    for (const owned of [false, true]) {
      const line = formatBodyState(
        { actionable: false, actorDispositionKind: kind, actorDispositionActionOwned: owned },
        true,
      );
      assertBodyLineNamesAWayOut(line, kind);
      const english = formatBodyState(
        { actionable: false, actorDispositionKind: kind, actorDispositionActionOwned: owned },
        false,
      );
      assertBodyLineNamesAWayOut(english, kind, false);
    }
  }
});

test("body_state_names_a_way_out: the two lines she actually read are REFUSED by the guard", () => {
  // THE FALSIFIER, quoting `round47`'s prompt. `身体: 忙（不可行动）` is the farmhouse door; `身体: 忙（modal）` is the
  // rendering this repo shipped for a named disposition. Both are held bodies that name no way out, so the guard that
  // the current line passes must reject them - otherwise it is decoration.
  assert.throws(
    () => assertBodyLineNamesAWayOut("身体: 忙（不可行动）", "modal"),
    /the line names the holder|the line names one of the declared ways forward|made her stop submitting/u,
  );
  assert.throws(
    () => assertBodyLineNamesAWayOut("身体: 忙（modal）", "modal"),
    /the line names the holder: 身体|the line names one of the declared ways forward/u,
  );
});

test("body_state_names_a_way_out: a body held by nothing named says 未知, never 不可行动", () => {
  const line = formatBodyState({ actionable: false }, true);
  assertBodyLineNamesAWayOut(line, "未知");
  assert.ok(line.includes("下一步: 未知"), `with no disposition there is no way to name a way forward: ${line}`);
  assert.equal(
    line.includes("空闲"),
    false,
    "a body the Mod says is not actionable is not free, and silence would read as free",
  );
});

test("body_state_names_a_way_out: what the snapshot does not project is silent, not free", () => {
  assert.equal(formatBodyState({}, true), "", "no reading at all must claim nothing");
  assert.equal(formatBodyState({ actorDispositionKind: "idle", actionable: true }, true), "身体: 空闲");
});

test("body_state_names_a_way_out: the ownership flag decides the way forward for a modal", () => {
  // `actorDispositionActionOwned` is the Mod's own statement that the mounted modal belongs to an execution of ours.
  // Reading it is what keeps this from being a second guess: an owned modal is being closed by that execution, so the
  // release is its settlement; a modal nobody owns has to be answered or closed by the world first.
  const owned = formatBodyState(
    { actionable: false, actorDispositionKind: "modal", actorDispositionActionOwned: true },
    true,
  );
  const unowned = formatBodyState(
    { actionable: false, actorDispositionKind: "modal", actorDispositionActionOwned: false },
    true,
  );
  assert.ok(owned.includes("下一步: 等结算"), `an owned modal is settled by us: ${owned}`);
  assert.ok(unowned.includes("下一步: 下一回合"), `a modal nobody owns ends with the world: ${unowned}`);
  assert.notEqual(owned, unowned, "if the flag changed nothing, the line would be guessing");
});

test("body_state_names_a_way_out: a transient hold is the one a command can wait out", () => {
  const transient = formatBodyState({ actionable: false, actorDispositionKind: "transient" }, true);
  assert.ok(transient.includes("可由指令接管: 是"), `a transient hold is retryable: ${transient}`);
  assert.ok(transient.includes("下一步: 重试可行"));
  for (const kind of ["event", "pass_out", "modal"]) {
    const line = formatBodyState({ actionable: false, actorDispositionKind: kind }, true);
    assert.ok(line.includes("可由指令接管: 否"), `nothing shortens a ${kind}: ${line}`);
    assert.equal(line.includes("重试可行"), false, `a ${kind} is not a 2-second window: ${line}`);
  }
});

test("body_state_names_a_way_out: the holder's own detail is named when the wire publishes it", () => {
  const line = formatBodyState(
    { actionable: false, actorDispositionKind: "modal", actorDispositionDetail: "DialogueBox" },
    true,
  );
  assert.ok(line.includes("持有: modal/DialogueBox"), `the holder is what the Mod named, not only its kind: ${line}`);
  const noDetail = formatBodyState(
    { actionable: false, actorDispositionKind: "modal", actorDispositionDetail: null },
    true,
  );
  assert.ok(noDetail.includes("持有: modal ·"), `a null detail adds nothing rather than a placeholder: ${noDetail}`);
});

test("body_state_names_a_way_out: a kind this table has not met stays unknown instead of invented", () => {
  // The population is the wire's enum, so this is about a FUTURE member: the Mod adds a kind, the schema carries it,
  // and this line must say it cannot tell rather than guess a hold the Mod never stated.
  const line = formatBodyState({ actionable: false, actorDispositionKind: "minigame_mount" }, true);
  assert.ok(line.includes("持有: minigame_mount"), `the unknown kind is still named: ${line}`);
  assert.ok(line.includes("下一步: 未知"), `and its way forward is declared unknown: ${line}`);
});

test("body_state_names_a_way_out: the answers are a closed set, so a reader can act on every one", () => {
  // Every way-forward this module can print is one of the four its vocabulary declares: a fifth answer would be a word
  // no caller can branch on. The population is the schema's kinds plus the unheld body, so a new kind is measured too.
  const lines: string[] = [];
  for (const kind of [...wireDispositionKinds(), "minigame_mount"]) {
    for (const owned of [false, true]) {
      lines.push(
        formatBodyState({ actionable: false, actorDispositionKind: kind, actorDispositionActionOwned: owned }, true),
      );
    }
  }
  lines.push(formatBodyState({ actionable: false }, true));
  assert.ok(lines.length > 0, "zero answers measured is not a passing reading");
  for (const line of lines) {
    const matched = /下一步: (?<answer>[^·]+)$/u.exec(line);
    assert.ok(matched?.groups !== undefined, `every held-body line ends with its way forward: ${line}`);
    const answer = (matched.groups.answer ?? "").trim();
    assert.ok(WAY_FORWARD_ZH.includes(answer), `"${answer}" is a fifth answer nobody declared: ${line}`);
  }
});

test("body_state_names_a_way_out: an execution of hers is what she is doing, not 空闲", () => {
  // MEASURED 2026-11-18 (`round76`, mid-`plan_319`): a walk publishes `actionable: true` and `actorDispositionKind:
  // idle` - a programme of hers holds neither field - so the line read `身体: 空闲` while she was walking, she took that
  // as "nothing is running", and submitted the same work again. The Mod publishes the in-flight execution itself.
  const walking = formatBodyState(
    {
      actionable: true,
      actorDispositionKind: "idle",
      activeExecution: {
        executionId: "exec_1",
        requestId: "request_1",
        action: "move_to_tile",
        state: "accepted",
        reasonCode: "accepted",
        evidence: { target_tile: "68,20" },
        phase: "approaching",
        cancelSafe: true,
        interruptible: false,
      },
    },
    true,
  );
  assert.match(walking, /身体: 执行中 move_to_tile/u, `the body says what it is doing while it does it: ${walking}`);
  assert.match(walking, /accepted\/approaching/u, `the phase the Mod named is part of the answer: ${walking}`);
  assert.match(walking, /可由指令接管: 否/u, `the Mod's own interruptible flag answers the takeover half: ${walking}`);
  assert.match(walking, /下一步: 等结算$/u, `and the settlement is what releases it: ${walking}`);
  assert.equal(walking.includes("空闲"), false, `a walking body is not free: ${walking}`);
  const english = formatBodyState(
    {
      actionable: true,
      actorDispositionKind: "idle",
      activeExecution: {
        executionId: "e",
        requestId: "r",
        action: "move_to_tile",
        state: "accepted",
        reasonCode: "accepted",
        evidence: null,
      },
    },
    false,
  );
  assert.match(english, /body: running move_to_tile/u);
  assert.equal(english.includes("free"), false, `a walking body is not free in either language: ${english}`);
});

test("body_state_names_a_way_out: an unmeasured half says what could not be read", () => {
  // THREE `未知` AND NO REASON is a field that cannot be read without saying why (`round76` turn 29).
  const line = formatBodyState({ actionable: false }, true);
  assertBodyLineNamesAWayOut(line, "未知");
  assert.match(line, /持有: 未知（快照没说谁占着/u, `the holder half names what was missing: ${line}`);
  assert.match(
    line,
    /可由指令接管: 未知/u,
    `the takeover half still answers, because there is nothing to take over: ${line}`,
  );
  // A kind the table has not met is a different gap: the holder IS named, and the way out is what nobody declared.
  const unknownKind = formatBodyState({ actionable: false, actorDispositionKind: "minigame_mount" }, true);
  assert.match(unknownKind, /可由指令接管: 未知（这张表还没有 minigame_mount/u, `the gap is named: ${unknownKind}`);
  assert.ok(unknownKind.endsWith("下一步: 未知"), `the way forward stays the last claim: ${unknownKind}`);
});

test("a rectangle read that did not read every tile reports the gap and does not order", () => {
  // The three zeroes are PER TILE on this path, and the block's sentence shipped an order after the fact: `别当成空地`
  // says what `没有人回答` already said, as a command. A fact block reports; the order belongs to nobody here.
  const selection: ObservationSelection = {
    predicates: [{ x: { from: 60, to: 61 }, y: { from: 18, to: 19 } }],
    tiles: [],
  };
  const tile = (x: number, y: number) => ({
    x,
    y,
    occupantKind: "none",
    occupant: "none",
    tillable: true,
    hoed: false,
    watered: false,
    crop: false,
    passable: true,
  });
  const result: TileAreaResult = {
    status: "answered",
    detail: null,
    x: 60,
    y: 18,
    w: 2,
    h: 2,
    location: "Farm",
    revision: 383,
    areaLimit: 100,
    // Three of the four named tiles: the Mod under-read, and the fourth is the third zero rather than an empty tile.
    rows: [tile(60, 18), tile(61, 18), tile(60, 19)],
    omitted: 0,
  };
  const answer = selectTileAreaRows(result, selection, 6, { x: 60, y: 19 });
  assert.equal(answer.tiles.named, 4, "the selection names the rectangle it asked for");
  assert.equal(answer.tiles.unreadable, 1, `the tile nobody answered is unreadable: ${answer.text}`);
  assert.equal(answer.tiles.empty, 3, "and it is not the measured zero beside it");
  assert.match(answer.text, /没读到/u, `the block counts the gap: ${answer.text}`);
  assert.match(
    answer.text,
    /没有人回答/u,
    `the block names what is missing rather than staying silent: ${answer.text}`,
  );
  assertReportsWithoutInstructing(answer.text, "the rectangle answer");
});

// ---------------------------------------------------------------------------------------------------------------
// A SELECTION over the rows an observation already published.
// ---------------------------------------------------------------------------------------------------------------

/**
 * One observation with the shapes a strip question asks about: a 3-wide band of weeds, a row of twigs beyond it, one
 * stump, the soil window underneath, and one row far away so the observation's published extent has an edge.
 */
function selectionSnapshot(): Snapshot {
  const weeds = [60, 61, 62].flatMap((x) => [18, 19, 20, 21].map((y) => ({ targetId: `weed_${x}_${y}`, x, y })));
  const twigs = [60, 61, 62].flatMap((x) => [10, 11].map((y) => ({ targetId: `grass_${x}_${y}`, x, y })));
  const soil = [60, 61, 62].flatMap((x) =>
    Array.from({ length: 14 }, (_unused, index) => ({ x, y: 13 + index, tillable: true })),
  );
  return {
    revision: 383,
    location: "Farm",
    tile: { x: 61, y: 19 },
    weedTargets: weeds,
    grassTargets: twigs,
    treeStumpTargets: [{ targetId: "stump_1", x: 60, y: 12 }],
    soilTiles: soil,
    minecartTargets: [{ targetId: "cart_1", x: 200, y: 40 }],
  } as unknown as Snapshot;
}

const STRIP = Object.freeze({
  predicates: Object.freeze([{ x: { from: 60, to: 62 }, y: { from: 10, to: 29 } }]),
  tiles: Object.freeze([]),
});

test("selection counts every kind the strip holds, and the omission is counted", () => {
  const snapshot = selectionSnapshot();
  const answer = selectObservedRows(snapshot, STRIP, 6);
  const countOf = (kind: string): number => answer.kinds.find((entry) => entry.kind === kind)?.count ?? -1;
  assert.equal(countOf("weedTargets"), 12, "the twelve rows inside the strip are all inside it");
  assert.equal(countOf("grassTargets"), 6);
  assert.equal(countOf("treeStumpTargets"), 1);
  assert.equal(countOf("soilTiles"), 42);
  // The tiles are counted from the axes' own arithmetic, so a wrong stride or an off-by-one is a disagreement here.
  assert.equal(
    answer.tiles.named,
    axisTileCount({ from: 60, to: 62 }) * axisTileCount({ from: 10, to: 29 }),
    "the named tiles are the rectangle the axes describe",
  );
  assert.equal(
    answer.tiles.named,
    answer.tiles.withRows + answer.tiles.empty + answer.tiles.unreadable,
    "every named tile is in exactly one bucket",
  );
  assert.equal(answer.tiles.unreadable, 0, "the whole strip lies inside the observation's published extent");
  const weeds = answer.kinds.find((entry) => entry.kind === "weedTargets");
  assert.ok(weeds !== undefined);
  assert.equal(weeds.shown.length, 6, "the limit names six rows of the twelve");
  assert.equal(weeds.count, weeds.shown.length + weeds.omitted, "and the other six are counted, never silent");
  assert.match(answer.text, /其余 6 格未列出/u, `the row line counts what it did not print: ${answer.text}`);
  assert.match(answer.text, /杂草 12/u, "the summary states the count in one place");
  assert.deepEqual(selectionDisagreements(snapshot, STRIP, answer), [], "the summary agrees with its own rows");
});

test("the three zeroes stay apart: empty, unreadable, and not measured", () => {
  const snapshot = selectionSnapshot();
  // (1) A rectangle inside the observation's published extent that holds no row is EMPTY, and says so.
  const empty = selectObservedRows(
    snapshot,
    { predicates: [{ x: { from: 100, to: 101 }, y: { from: 20, to: 21 } }], tiles: [] },
    6,
  );
  assert.equal(empty.verdict, "empty", `a measured zero is empty, not unreadable: ${empty.text}`);
  assert.equal(empty.tiles.unreadable, 0);
  assert.match(empty.text, /确实是空的/u);
  // (2) A tile outside the extent is UNREADABLE, named with the tile, and never reported as zero rows.
  const beyond = selectObservedRows(snapshot, { predicates: [], tiles: [[300, 5]] }, 6);
  assert.equal(beyond.verdict, "beyond_extent", `a tile this observation never published is not empty: ${beyond.text}`);
  assert.equal(beyond.tiles.unreadable, 1);
  assert.equal(beyond.tiles.empty, 0, "the tile must not fall into the measured-empty bucket as well");
  assert.match(beyond.text, /未覆盖/u);
  assert.match(beyond.text, /300，5/u, `the unreadable tile is named: ${beyond.text}`);
  // (3) A family this observation does not carry is NOT MEASURED, which is neither of the two zeroes above.
  const absent = selectObservedRows(snapshot, { predicates: [{ kinds: ["chests"] }], tiles: [] }, 6);
  assert.equal(absent.kinds.find((entry) => entry.kind === "chests")?.coverage, "not_published");
  assert.equal(absent.verdict, "not_measured");
  assert.match(absent.text, /未测/u);
  assert.match(absent.text, /不是 0/u);
});

test("a stride is counted from the tiles it names, not divided somewhere else", () => {
  const snapshot = selectionSnapshot();
  const stride = { predicates: [{ x: { from: 60, to: 60 }, y: { from: 10, to: 29, step: 2 } }], tiles: [] };
  const answer = selectObservedRows(snapshot, stride, 6);
  // Every other tile of a 20-tile column is TEN tiles, and the answer says ten.
  assert.equal(axisTileCount({ from: 10, to: 29, step: 2 }), 10);
  assert.equal(answer.tiles.named, 10, "step: 2 over y 10…29 names ten tiles");
  const weeds = answer.kinds.find((entry) => entry.kind === "weedTargets");
  assert.equal(weeds?.count, 2, "y 18 and y 20 are the two stride tiles the weeds stand on");
  assert.equal(weeds?.shown.length, 2, "and no weed from y 19 or y 21 leaks into the answer");
});

test("region_summary_disagrees_with_the_rows: the gate refuses a summary that does not add up", () => {
  const snapshot = selectionSnapshot();
  const answer = selectObservedRows(snapshot, STRIP, 6);
  assert.deepEqual(selectionDisagreements(snapshot, STRIP, answer), [], "the shipped construction holds");
  // The gate's own population is printed, and a green reading is not an empty one.
  const clean = selectionGateReport();
  assert.match(clean, /^observations examined [1-9]\d* · kinds [1-9]\d* · disagreeing 0$/u, clean);
  // A count that grew by one no row can back: the code names the selection and the drifting kind.
  const inflated = {
    ...answer,
    kinds: answer.kinds.map((kind) => (kind.kind === "weedTargets" ? { ...kind, count: kind.count + 1 } : kind)),
  };
  const codes = selectionDisagreements(snapshot, STRIP, inflated);
  assert.ok(
    codes.includes(`region_summary_disagrees_with_the_rows:${answer.spelling}:weedTargets`),
    `the refusal names the kind that disagreed: ${codes.join("；")}`,
  );
  // A row the filter should not have kept.
  const leaked = {
    ...answer,
    kinds: answer.kinds.map((kind) =>
      kind.kind === "weedTargets"
        ? { ...kind, shown: [...kind.shown, { x: 900, y: 900, name: undefined, state: "", w: 1, h: 1 }] }
        : kind,
    ),
  };
  const leakCodes = selectionDisagreements(snapshot, STRIP, leaked);
  assert.ok(
    leakCodes.some((code) => code.startsWith(`region_summary_includes_a_row_outside_the_selection:${answer.spelling}`)),
    "a row outside the selection is a leak, not a rounding difference",
  );
  // A tile that landed in no bucket, or in two.
  const lostTile = { ...answer, tiles: { ...answer.tiles, withRows: answer.tiles.withRows - 1 } };
  const tileCodes = selectionDisagreements(snapshot, STRIP, lostTile);
  assert.deepEqual(tileCodes, [`region_tile_accounting_disagrees:${answer.spelling}`]);
  // The counter is evidence, so an injected disagreement must move it: a gate whose verdict never changes is decoration.
  const counted = (report: string): number =>
    Number(/disagreeing (?<count>\d+)$/u.exec(report)?.groups?.count ?? "NaN");
  const after = selectionGateReport();
  assert.equal(
    counted(after),
    counted(clean) + codes.length + leakCodes.length + tileCodes.length,
    `the report counts exactly the disagreements the gate returned: ${after}`,
  );
});

test("a selection reads the observation and never writes it, and the row families are removed only from the copy", () => {
  const snapshot = selectionSnapshot();
  const before = JSON.stringify(snapshot);
  const answer = selectObservedRows(snapshot, STRIP, OBSERVATION_SELECTION_ROWS_LIMIT_MAX);
  assert.equal(JSON.stringify(snapshot), before, "a filter is a reading: the observed snapshot is unchanged");
  assert.equal(
    answer.kinds.reduce((total, kind) => total + kind.count, 0),
    answer.kinds.reduce((total, kind) => total + kind.shown.length + kind.omitted, 0),
    "the whole answer adds up, not only its four kinds",
  );
  const stripped = withoutRowFamilies(snapshot as unknown as Record<string, unknown>);
  for (const family of Object.keys(TARGET_FAMILY_LABELS))
    assert.equal(family in stripped, false, `${family} is a row family and must not print twice`);
  assert.equal(stripped.location, "Farm", "the environment survives the strip");
  assert.deepEqual(stripped.tile, { x: 61, y: 19 });
  assert.ok(Object.keys(TARGET_FAMILY_LABELS).length > 0, "a zero population would agree with itself");
});
