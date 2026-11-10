/**
 * The directive authority's own rules, as assertions rather than as prose.
 *
 * The defect these protect against is measured (`round44`): the day's note was an utterance, the work it superseded was
 * state, and 25 minutes later the note had 0 carriers in the emitted context while 31 described the older work. So the
 * tests are about the two claims that fix has to make - the record has a day and a state, and a plan carries the stamp
 * of the directive that authorized it - plus the reading that must not print 0/0 as a pass.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  currentDirectiveIdOf,
  directiveText,
  expireForWorldDay,
  hostOwnedStampField,
  HOST_OWNED_STAMP_FIELDS,
  issueDirective,
  MAX_DIRECTIVE_TEXT_BYTES,
  measureDirectiveAlignment,
  sameWorldDay,
  supersedeDirective,
  worldDayFrom,
  type GameDirective,
  type WorldDay,
} from "./game-directive.js";
import { MAX_CONTROL_TEXT_BYTES } from "./companion-control-protocol.js";

const DAY_SIX: WorldDay = Object.freeze({ year: 1, seasonIndex: 0, dayOfMonth: 6 });
const DAY_SEVEN: WorldDay = Object.freeze({ year: 1, seasonIndex: 0, dayOfMonth: 7 });

function issued(id: string, text: string, previous: GameDirective | null = null, worldDay = DAY_SIX): GameDirective {
  return issueDirective({ directiveId: id, text, worldDay, supersedes: previous });
}

test("a directive is current and names the directive it replaced", () => {
  const first = issued("d_6_aaaa", "找片水，钓条鱼回来。");
  assert.equal(first.state, "current");
  assert.equal(first.supersedes, null);
  const second = issued("d_6_bbbb", "去镇上买种。", first);
  assert.equal(second.supersedes, "d_6_aaaa");
  // The older record is not rewritten by the newer one: superseding is an act on a copy, so a reader holding the old
  // record cannot be shown a newer one's text under an older id.
  assert.equal(first.text, "找片水，钓条鱼回来。");
});

test("the record carries no clock: only the world day it is for", () => {
  const directive = issued("d_6_aaaa", "钓鱼。");
  assert.deepEqual(Object.keys(directive).sort(), ["directiveId", "state", "supersedes", "text", "worldDay"]);
  assert.deepEqual(directive.worldDay, DAY_SIX);
});

test("superseding is a one-way transition, so calling it twice cannot look newly retired", () => {
  const current = issued("d_6_aaaa", "钓鱼。");
  const retired = supersedeDirective(current);
  assert.equal(retired.state, "superseded");
  assert.equal(supersedeDirective(retired), retired);
  assert.equal(currentDirectiveIdOf(retired), null);
  assert.equal(currentDirectiveIdOf(current), "d_6_aaaa");
  assert.equal(currentDirectiveIdOf(null), null);
});

test("the world day is the snapshot's triple, and a partial calendar is not a day", () => {
  assert.deepEqual(worldDayFrom({ year: 1, seasonIndex: 0, dayOfMonth: 6 }), DAY_SIX);
  // Zero is a value: the Mod's own winter has a day 0, and truthiness would silently drop it.
  assert.deepEqual(worldDayFrom({ year: 0, seasonIndex: 3, dayOfMonth: 0 }), {
    year: 0,
    seasonIndex: 3,
    dayOfMonth: 0,
  });
  assert.equal(worldDayFrom({ year: 1, seasonIndex: 0 }), null);
  assert.equal(worldDayFrom({ year: 1, seasonIndex: 0, dayOfMonth: 6.5 }), null);
  assert.equal(worldDayFrom({ year: "1", seasonIndex: 0, dayOfMonth: 6 }), null);
  assert.equal(worldDayFrom(null), null);
  assert.equal(sameWorldDay(DAY_SIX, { ...DAY_SIX }), true);
  assert.equal(sameWorldDay(DAY_SIX, DAY_SEVEN), false);
});

test("a directive expires when the world moves to another day, and not before", () => {
  const current = issued("d_6_aaaa", "钓鱼。");
  assert.equal(expireForWorldDay(current, { ...DAY_SIX }), current);
  const expired = expireForWorldDay(current, DAY_SEVEN);
  assert.equal(expired.state, "expired");
  assert.equal(expired.worldDay.dayOfMonth, 6, "the day it WAS for is kept, not rewritten to the new one");
  // A record that is already retired stays in the state it retired in: expiry must not overwrite supersession, or the
  // artifact could not tell "she replaced this" from "the day ended".
  const superseded = supersedeDirective(current);
  assert.equal(expireForWorldDay(superseded, DAY_SEVEN), superseded);
});

test("directive text obeys the player-text byte limit without splitting a code point", () => {
  assert.equal(MAX_DIRECTIVE_TEXT_BYTES, MAX_CONTROL_TEXT_BYTES);
  assert.equal(directiveText("  钓鱼。  "), "钓鱼。");
  const long = "鱼".repeat(MAX_DIRECTIVE_TEXT_BYTES);
  const bounded = directiveText(long);
  assert.ok(Buffer.byteLength(bounded, "utf8") <= MAX_DIRECTIVE_TEXT_BYTES);
  assert.ok(bounded.length > 0);
  // Every code point survives whole: a cut byte would make the record's own text an invalid string.
  assert.equal(
    [...bounded].every((character) => character === "鱼"),
    true,
  );
  assert.deepEqual(issued("d_6_aaaa", long).text, bounded);
});

test("an empty directive text is refused rather than stored", () => {
  assert.throws(() => issueDirective({ directiveId: "d_6_aaaa", text: "   ", worldDay: DAY_SIX, supersedes: null }), {
    message: "empty_directive_text",
  });
  assert.throws(() => issueDirective({ directiveId: "not opaque!", text: "x", worldDay: DAY_SIX, supersedes: null }), {
    message: "invalid_directive_id",
  });
});

test("a model-supplied stamp field is named, so the refusal says which guess was wrong", () => {
  assert.deepEqual([...HOST_OWNED_STAMP_FIELDS], ["directiveId", "directiveWorldDay"]);
  assert.equal(hostOwnedStampField({ programId: "p", nodes: [], directiveId: "d_6_aaaa" }), "directiveId");
  assert.equal(hostOwnedStampField({ programId: "p", directiveWorldDay: DAY_SIX }), "directiveWorldDay");
  assert.equal(hostOwnedStampField({ programId: "p", nodes: [] }), null);
  assert.equal(hostOwnedStampField(null), null);
  // Only an OWN field counts: a prototype member is not something the model's JSON decoded into.
  assert.equal(hostOwnedStampField(Object.create({ directiveId: "d_6_aaaa" })), null);
});

test("alignment: an empty denominator is not_measured, and it names the population that was empty", () => {
  const none = measureDirectiveAlignment({
    deliveredTurns: 0,
    turnsWithDirective: 0,
    currentDirectiveId: "d_6_aaaa",
    stamps: [],
  });
  assert.deepEqual(none.presence, { state: "not_measured", missingField: "game_session.deliveredTurns" });
  assert.deepEqual(none.alignment, { state: "not_measured", missingField: "game_session.planSubmissions" });
  assert.equal(none.plansUnderCurrent, 0);
  assert.equal(none.plansUnderRetired, 0);
  assert.equal(none.staleWork, 0);
});

test("alignment: presence is the share of delivered turns that carried a directive", () => {
  const reading = measureDirectiveAlignment({
    deliveredTurns: 4,
    turnsWithDirective: 4,
    currentDirectiveId: "d_6_aaaa",
    stamps: [],
  });
  assert.deepEqual(reading.presence, { state: "measured", numerator: 4, denominator: 4, value: 1 });
});

test("alignment: a plan admitted under a retired directive is retired, not current", () => {
  const reading = measureDirectiveAlignment({
    deliveredTurns: 2,
    turnsWithDirective: 2,
    // A was superseded by B: the plan was stamped with A when it was admitted, and the batch now carries B.
    currentDirectiveId: "d_6_bbbb",
    stamps: [{ directiveId: "d_6_aaaa", settled: false }],
  });
  assert.deepEqual(reading.alignment, { state: "measured", numerator: 0, denominator: 1, value: 0 });
  assert.equal(reading.plansUnderCurrent, 0);
  assert.equal(reading.plansUnderRetired, 1);
  assert.equal(reading.plansWithoutDirective, 0);
  assert.equal(reading.staleWork, 1, "a retired plan that has not settled is the work a refusal will have to name");
  assert.equal(
    measureDirectiveAlignment({
      deliveredTurns: 2,
      turnsWithDirective: 2,
      currentDirectiveId: "d_6_bbbb",
      stamps: [{ directiveId: "d_6_aaaa", settled: true }],
    }).staleWork,
    0,
    "a settled plan is history, not stale work",
  );
});

test("alignment: the partition covers every plan, including her own undirected work", () => {
  const reading = measureDirectiveAlignment({
    deliveredTurns: 3,
    turnsWithDirective: 1,
    currentDirectiveId: "d_6_bbbb",
    stamps: [
      { directiveId: "d_6_bbbb", settled: false },
      { directiveId: "d_6_aaaa", settled: false },
      { directiveId: null, settled: false },
    ],
  });
  assert.equal(reading.plansUnderCurrent, 1);
  assert.equal(reading.plansUnderRetired, 1);
  assert.equal(reading.plansWithoutDirective, 1);
  assert.equal(reading.staleWork, 1, "a plan with no directive never claimed authority, so no day boundary revokes it");
  assert.deepEqual(reading.alignment, { state: "measured", numerator: 1, denominator: 3, value: 1 / 3 });
  assert.deepEqual(reading.presence, { state: "measured", numerator: 1, denominator: 3, value: 1 / 3 });
});
