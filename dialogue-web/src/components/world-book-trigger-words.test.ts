import assert from "node:assert/strict";
import test from "node:test";
import { parseTriggerWords } from "./world-book-trigger-words";

/**
 * The one field both world-book forms split, at the boundary that already shipped a defect here.
 *
 * An entry's trigger words are typed into a single text field and become `keys` on the wire, so the
 * separators this accepts decide whether a player's own words reach her entry at all. Each shape is a
 * different keyboard's comma, and the two silent-loss cases are the separator that used to become an
 * empty key and the whitespace a paste leaves around a word.
 *
 * The separators are spelled by code point rather than typed: this test sits under `src/`, where the
 * raw-text gate forbids a CJK literal outside a catalogue, and the two Chinese commas are exactly that
 * punctuation. What is under test is which code points split a key, never any text a player reads, so
 * the fixtures are code points and the keys are ASCII on purpose.
 */

/** `,` and the two Chinese commas a keyboard and a world book file produce. */
const COMMA = Object.freeze({
  ascii: ",",
  fullwidth: String.fromCharCode(0xff0c),
  ideographic: String.fromCharCode(0x3001),
});

/** A fullwidth colon: a character beside a key that is not a separator. */
const COLON = String.fromCharCode(0xff1a);

test("every comma shape a player types separates keys", () => {
  assert.deepEqual(parseTriggerWords(`greenhouse${COMMA.ascii}fountain`), ["greenhouse", "fountain"]);
  assert.deepEqual(parseTriggerWords(`greenhouse${COMMA.fullwidth}fountain`), ["greenhouse", "fountain"]);
  assert.deepEqual(parseTriggerWords(`greenhouse${COMMA.ideographic}fountain`), ["greenhouse", "fountain"]);
});

test("the shapes mix in one field, because a player types what her keyboard offers", () => {
  assert.deepEqual(
    parseTriggerWords(`greenhouse${COMMA.fullwidth}fountain${COMMA.ideographic}notice board${COMMA.ascii}mail`),
    ["greenhouse", "fountain", "notice board", "mail"],
  );
});

test("whitespace around a key is trimmed, and whitespace inside it is kept", () => {
  assert.deepEqual(parseTriggerWords(` greenhouse ${COMMA.ascii}\tfountain\n`), ["greenhouse", "fountain"]);
  assert.deepEqual(parseTriggerWords("the town square"), ["the town square"]);
});

test("an empty segment is dropped rather than kept as an empty key", () => {
  assert.deepEqual(parseTriggerWords("greenhouse,,fountain"), ["greenhouse", "fountain"]);
  assert.deepEqual(parseTriggerWords("greenhouse, ,fountain"), ["greenhouse", "fountain"]);
  assert.deepEqual(parseTriggerWords(`greenhouse${COMMA.ideographic}`), ["greenhouse"]);
  assert.deepEqual(parseTriggerWords(""), []);
  assert.deepEqual(parseTriggerWords("   "), []);
});

test("a key keeps every character that is not a separator", () => {
  assert.deepEqual(parseTriggerWords(`note${COLON}{{user}}`), [`note${COLON}{{user}}`]);
});
