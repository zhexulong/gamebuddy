import assert from "node:assert/strict";
import test from "node:test";

import { playerNoteLines } from "./player-note.js";

/**
 * Whose sentence each part of the player's note is, asserted as the text she receives.
 *
 * <p>
 * THE HISTORY THIS REPLAYS. Measured 2026-11-11 on the fishing objective, three attempts: the note
 * `我今天去镇上办事。找片水，钓条鱼回来。你看着办。` reached her as ONE block of his text under
 * `answer what <player-note> says`, and the middle sentence - the assignment - read to her as something HE was doing.
 * `fish_here` was dispatched 0 times in 151 delivered bundles; her thinking in attempt B3 named fish once
 * (`Player's note: he's going fishing.`), and B1 never wrote fish or water at all. The before and after texts of that
 * exact note sit side by side in the `b3_note` test below.
 * </p>
 *
 * <p>
 * The assertions are on the composed lines rather than on the classifier, because the lines are the whole product
 * surface here: what a rule says and what she reads are one thing, and a test that read the classifier would stay green
 * while the block printed the wrong label.
 * </p>
 */

const VERBATIM = "他跟你说的，一个字没改：";
const HIS = "他的事，不是给你做的：";
const HERS = "给你做的：";
const NO_WORK = "上面没有给你做的事：这些是他自己的事，你不用动手。";

/**
 * The rule, one case per line, so a change to it has to move a case and not only a regex.
 *
 * Both languages are here because `PlayerInput.locale` can be `en-US` while the brief stays Chinese; a note in English
 * that fell through to "everything is hers" would be the pre-fix reading with the note block unchanged.
 */
const RULE_CASES: readonly Readonly<{ note: string; line: string; why: string }>[] = [
  { note: "我今天去镇上办事。", line: `${HIS}「我今天去镇上办事。」`, why: "我 is the doer" },
  { note: "咱们明天再挖矿。", line: `${HERS}「咱们明天再挖矿。」`, why: "咱们 includes her" },
  { note: "我们今天去钓鱼。", line: `${HERS}「我们今天去钓鱼。」`, why: "我们 includes her, so it is not his alone" },
  { note: "找片水，钓条鱼回来。", line: `${HERS}「找片水，钓条鱼回来。」`, why: "the imperative dropped its subject" },
  { note: "你看着办。", line: `${HERS}「你看着办。」`, why: "a second-person subject is addressed to her" },
  {
    note: "帮我带点种子回来。",
    line: `${HERS}「帮我带点种子回来。」`,
    why: "a request frame: 我 is the one it is done for, not the one who does it",
  },
  { note: "早", line: `${HERS}「早」`, why: "aimed at her - the direction this rule errs" },
  { note: "I'm going to town today.", line: `${HIS}「I'm going to town today.」`, why: "the English first person" },
  { note: "Catch me a fish.", line: `${HERS}「Catch me a fish.」`, why: "the English imperative" },
  { note: "Catch a fish for me.", line: `${HERS}「Catch a fish for me.」`, why: "the English request frame" },
];

for (const { note, line, why } of RULE_CASES)
  test(`rule: ${JSON.stringify(note)} is labelled ${JSON.stringify(line)} because ${why}`, () => {
    // A note whose every sentence is his asks her for nothing, so the absence is stated with the same call.
    const expected = line.startsWith(HIS) ? [line, NO_WORK] : [line];
    assert.deepEqual(
      playerNoteLines([note]).slice(1),
      expected,
      `the label for ${JSON.stringify(note)} is not the one the rule states: ${why}`,
    );
  });

/**
 * The measured note, through the changed path: the red proof from history.
 *
 * <p>
 * BEFORE, `<player-note>` in `fact-brief.ts` held his text and nothing else:
 * </p>
 *
 * <pre>
 * &lt;player-note&gt;
 * 我今天去镇上办事。找片水，钓条鱼回来。你看着办。
 * &lt;/player-note&gt;
 * </pre>
 *
 * <p>
 * AFTER, for the same bytes:
 * </p>
 *
 * <pre>
 * &lt;player-note&gt;
 * 他跟你说的，一个字没改：
 * 他的事，不是给你做的：「我今天去镇上办事。」
 * 给你做的：「找片水，钓条鱼回来。」「你看着办。」
 * &lt;/player-note&gt;
 * </pre>
 */
test("b3_note: his errand and the job he is giving her are told apart", () => {
  assert.deepEqual(playerNoteLines(["我今天去镇上办事。找片水，钓条鱼回来。你看着办。"]), [
    VERBATIM,
    `${HIS}「我今天去镇上办事。」`,
    `${HERS}「找片水，钓条鱼回来。」「你看着办。」`,
  ]);
});

/** His characters, in his order, each exactly once: the labels are the only added text, and quoting is not paraphrase. */
test("his_words: the note is reproduced character for character, in his order", () => {
  for (const note of [
    "我今天去镇上办事。找片水，钓条鱼回来。你看着办。",
    "找片水，钓条鱼回来",
    "  我今天去镇上办事。  找片水  ",
    "帮我带点种子回来。\n顺便把昨天的信寄了。",
  ]) {
    const quoted = playerNoteLines([note]).flatMap((line) =>
      [...line.matchAll(/「([^」]*)」/gu)].map((match) => match[1] ?? ""),
    );
    assert.equal(
      quoted.join("").replace(/\s+/gu, ""),
      note.replace(/\s+/gu, ""),
      `the quoted runs of ${JSON.stringify(note)} are not his words in his order: ${quoted.join("|")}`,
    );
  }
});

/** A note that only tells her about his day has to say so, or she is left to infer that nothing was asked of her. */
test("no_task: a note that asks her for nothing says so, in a sentence of its own", () => {
  assert.deepEqual(playerNoteLines(["我今天去镇上办事，晚上回来。"]), [
    VERBATIM,
    `${HIS}「我今天去镇上办事，晚上回来。」`,
    NO_WORK,
  ]);
});

/** His words are the content and the labels are the headings, so a run of one reading carries one label. */
test("one_label_per_run: consecutive sentences with the same reading share a label", () => {
  const lines = playerNoteLines(["我今天去镇上办事。我晚上回来。找片水，钓条鱼回来。你看着办。"]);
  assert.deepEqual(lines, [
    VERBATIM,
    `${HIS}「我今天去镇上办事。」「我晚上回来。」`,
    `${HERS}「找片水，钓条鱼回来。」「你看着办。」`,
  ]);
});

/**
 * The error direction, on the shape it costs most: his plan carried into a second sentence that does not repeat its
 * subject.
 *
 * It is read as hers, because no exclusive first person means nobody in the sentence is the doer but her. Carrying the
 * subject across the sentence end would close this case and reopen the measured one (`我今天去镇上办事。找片水，钓条鱼回来。`
 * has exactly the same shape), so the rule takes the cheaper error and says so.
 */
test("elided_subject: a plan continued into a subjectless sentence is offered to her, and that is the stated direction", () => {
  assert.deepEqual(playerNoteLines(["我今天去镇上办事。晚上回来。"]), [
    VERBATIM,
    `${HIS}「我今天去镇上办事。」`,
    `${HERS}「晚上回来。」`,
  ]);
});

/** Two inputs in one batch are two notes, and the absence of work is stated per note rather than for the batch. */
test("every_note_is_read: two player inputs keep their own readings", () => {
  assert.deepEqual(playerNoteLines(["我今天去镇上办事。", "找片水，钓条鱼回来。"]), [
    VERBATIM,
    `${HIS}「我今天去镇上办事。」`,
    NO_WORK,
    `${HERS}「找片水，钓条鱼回来。」`,
  ]);
});

/** Nothing said, nothing sent: the block is omitted rather than emitted empty. */
test("no_note_no_block: an input list of blank notes composes nothing", () => {
  assert.deepEqual(playerNoteLines([]), []);
  assert.deepEqual(playerNoteLines(["", "   "]), []);
});

/** The bound of the splitter, stated instead of discovered: a note with no sentence end is ONE utterance. */
test("no_sentence_end: an unpunctuated note is one utterance, and its subject decides the whole note", () => {
  assert.deepEqual(playerNoteLines(["我今天去镇上办事 找片水 钓条鱼回来"]), [
    VERBATIM,
    `${HIS}「我今天去镇上办事 找片水 钓条鱼回来」`,
    NO_WORK,
  ]);
});

/** Two renderings of the same note are the same bytes: the text is folded into a session's cached history. */
test("deterministic: the same note composes the same lines", () => {
  const note = "我今天去镇上办事。找片水，钓条鱼回来。你看着办。";
  assert.deepEqual(playerNoteLines([note]), playerNoteLines([note]));
});
