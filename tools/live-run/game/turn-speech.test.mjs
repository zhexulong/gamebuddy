import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { attributeTurnSpeech, bubbleFragment } from "./turn-speech.mjs";

const piece = (text) => Object.freeze({ text });

// `round87b` (`.live-runs/game-ladder/2026-11-21T13-38-15-600Z-multiday_routine`): day 3's turn settled with
// `spokenLines: []` while `run-progress.jsonl` presented nineteen bubbles after that turn's `turn_started`. The slice was
// taken when the await returned; the speech for the day arrived afterwards.
test("a line that arrives after a turn's await still belongs to that turn", () => {
  const turns = [{ spokenFromIndex: 0 }, { spokenFromIndex: 3 }];
  const pieces = [piece("一"), piece("二"), piece("三"), piece("四"), piece("五")];
  const attributed = attributeTurnSpeech(turns, pieces);
  assert.deepEqual(attributed[0].spokenLines, ["一", "二", "三"]);
  assert.deepEqual(attributed[1].spokenLines, ["四", "五"], "the last turn runs to the end of the population");
  assert.deepEqual(
    [attributed[0].spokenFromIndex, attributed[0].spokenToIndex, attributed[1].spokenToIndex],
    [0, 3, 5],
  );
});

test("the derivation is total: every committed piece belongs to exactly one turn", () => {
  const pieces = Array.from({ length: 58 }, (_, index) => piece(`line ${String(index)}`));
  const turns = [{ spokenFromIndex: 0 }, { spokenFromIndex: 22 }, { spokenFromIndex: 39 }];
  const attributed = attributeTurnSpeech(turns, pieces);
  const spoken = attributed.flatMap((turn) => turn.spokenLines);
  assert.equal(
    spoken.length,
    pieces.length,
    "the sum of the turns IS the population, so the two artifacts cannot drift",
  );
  assert.equal(new Set(spoken).size, pieces.length, "no piece is counted twice");
  // The run this was measured on, by the windows `run-progress.jsonl` was written over: 22 bubbles before day 2's turn
  // opened, 17 before day 3's, and 19 after day 3's - the last of which the turn record lost entirely.
  assert.deepEqual(
    attributed.map((turn) => turn.spokenLines.length),
    [22, 17, 19],
  );
});

test("a piece committed before the first turn's start is the first turn's, not nobody's", () => {
  const attributed = attributeTurnSpeech([{ spokenFromIndex: 0 }], [piece("arrived during launch")]);
  assert.deepEqual(attributed[0].spokenLines, ["arrived during launch"]);
});

// THE CLOCK TRAVELS WITH THE LINE, so a reading that quotes a commitment can date it without holding the presentation
// population: `round98`'s promise was charged with no hour at all, and `null` (nobody recorded when) must stay distinct
// from an index that simply did not line up.
test("each line carries the moment the player was shown it, and an unclocked piece says so", () => {
  const timed = [{ index: 0, text: "这就睡", atMs: 1795000000000 }, { index: 1, text: "都十二点了", atMs: 1795000600000 }];
  const attributed = attributeTurnSpeech([{ spokenFromIndex: 0 }], timed);
  assert.deepEqual(attributed[0].spokenAtMs, [1795000000000, 1795000600000]);
  // A REFUSED BUBBLE IS NOT A LINE, SO ITS CLOCK IS NOT ONE EITHER: the two arrays stay index-aligned with each other.
  const withFragment = [
    { index: 0, text: "b 十五包种子到手", locale: "zh-CN", atMs: 1795000000000 },
    { index: 1, text: "这就睡", locale: "zh-CN", atMs: 1795000600000 },
  ];
  const filtered = attributeTurnSpeech([{ spokenFromIndex: 0 }], withFragment);
  assert.deepEqual(filtered[0].spokenLines, ["这就睡"]);
  assert.deepEqual(filtered[0].spokenAtMs, [1795000600000]);
  assert.deepEqual(attributeTurnSpeech([{ spokenFromIndex: 0 }], [piece("没有钟")])[0].spokenAtMs, [null]);
});

test("a turn carries the window it was read over, and a run with no pieces reads as no lines", () => {
  const empty = attributeTurnSpeech([{ spokenFromIndex: 0 }], []);
  assert.deepEqual(empty[0].spokenLines, []);
  assert.deepEqual([empty[0].spokenFromIndex, empty[0].spokenToIndex], [0, 0]);
  assert.deepEqual(attributeTurnSpeech([], []), []);

  // A turn whose index is missing is read as the first one, and a skipped/duplicated window cannot run backwards.
  const overlapping = attributeTurnSpeech(
    [{ spokenFromIndex: 2 }, { spokenFromIndex: 1 }],
    [piece("头一句"), piece("下一句")],
  );
  assert.deepEqual(
    overlapping.map((turn) => turn.spokenLines.length),
    [0, 1],
    "a later turn's start before an earlier one gives that earlier turn an empty window rather than a negative slice",
  );
});

test("an unspoken piece is dropped from the lines but still occupies its index", () => {
  const attributed = attributeTurnSpeech(
    [{ spokenFromIndex: 0 }, { spokenFromIndex: 2 }],
    [piece("说的"), piece("   "), piece("也说的")],
  );
  assert.deepEqual(attributed[0].spokenLines, ["说的"], "the whitespace-only commit is not a line");
  assert.deepEqual(attributed[1].spokenLines, ["也说的"], "and the next turn still starts at its own index");
});

// `round89` (`.live-runs/game-ladder/2026-11-21T20-38-52-354Z-multiday_routine`), `presentation.pieces[17]`, verbatim: a
// stray `b ` at the head of her line, put in front of the player. The session record's assistant message #186 carries it
// as the whole of its one `text` part, so this is the provider's own output and not a boundary any layer here drew.
const ROUND89_FRAGMENT_BUBBLE = "b 十五包防风草种子到手，兜里还剩七百六。回农场把它们都点进地里去。";

test("a bubble that carries a fragment is refused by name instead of being counted as her speech", () => {
  const attributed = attributeTurnSpeech([{ spokenFromIndex: 0 }], [
    Object.freeze({ index: 0, text: ROUND89_FRAGMENT_BUBBLE, locale: "zh-CN" }),
  ]);
  assert.deepEqual(attributed[0].spokenLines, [], "the bubble is not read as a line she spoke");
  assert.deepEqual(
    attributed[0].refusedBubbles,
    [{ index: 0, code: "bubble_carried_a_fragment:b 十五包防风草种子到手，兜里还剩七百六" }],
    "and the refusal names the bubble it came from, so it can be found in the bundle",
  );
  assert.equal(ROUND89_FRAGMENT_BUBBLE.slice(0, 20), "b 十五包防风草种子到手，兜里还剩七百六", "the code carries the first 20 characters");
});

test("refusing the fragment does not refuse the line when the fragment is not there", () => {
  const spoken = "十五包防风草种子到手，兜里还剩七百六。回农场把它们都点进地里去。";
  const attributed = attributeTurnSpeech([{ spokenFromIndex: 0 }], [
    Object.freeze({ index: 0, text: spoken, locale: "zh-CN" }),
  ]);
  assert.deepEqual(attributed[0].spokenLines, [spoken]);
  assert.deepEqual(attributed[0].refusedBubbles, []);
});

test("a one-letter word is a word in its own language: `I am` is speech, and a lone character is not", () => {
  assert.equal(bubbleFragment("I am going to the mine.", "en-US"), null);
  assert.equal(bubbleFragment("a cat crossed the road", "en-US"), null, "the head rule reads the bubble's own locale");
  assert.equal(bubbleFragment("Mm. 先割草。", "zh-CN"), null, "a Latin sound joined to Chinese is not a one-letter word");
  assert.equal(bubbleFragment("A 和 B 你选哪个", "zh-CN"), null, "an uppercase label is an option, not a fragment");
  assert.equal(bubbleFragment("b", "zh-CN"), "bubble_carried_a_fragment:b", "a letter is not one utterance");
  assert.equal(bubbleFragment("哦", "zh-CN"), null, "a single character of her own script is an answer");
});

test("the refused bubble is round89's own, when that bundle is still on this machine", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const path = join(root, ".live-runs/game-ladder/2026-11-21T20-38-52-354Z-multiday_routine/result.json");
  if (!existsSync(path)) return;
  const bundle = JSON.parse(readFileSync(path, "utf8"));
  const delivered = bundle.presentation.pieces[17];
  assert.equal(delivered.text, ROUND89_FRAGMENT_BUBBLE);
  assert.equal(
    bubbleFragment(delivered.text, delivered.locale),
    "bubble_carried_a_fragment:b 十五包防风草种子到手，兜里还剩七百六",
  );
  // The window it was attributed to is the bundle's own turn record: day 2's turn, index 17 in its 11..25 range.
  const turn = bundle.sessionTurns.find((entry) => entry.spokenFromIndex <= 17 && entry.spokenToIndex > 17);
  assert.equal(turn.day, 2);
});
