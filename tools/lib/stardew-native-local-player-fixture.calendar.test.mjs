import assert from "node:assert/strict";
import test from "node:test";

import { assertSaveCalendarConsistent } from "./stardew-native-local-player-fixture.mjs";

// Every case is a REAL save from this machine, not an invented one: a test written from a guess passes against the guess.
const save = ({ dayOfMonth, daysPlayed, season = "spring" }) =>
  `<SaveGame><currentSeason>${season}</currentSeason><dayOfMonth>${dayOfMonth}</dayOfMonth>` +
  `<player><stats><Values><item><key><string>daysPlayed</string></key>` +
  `<value><unsignedInt>${daysPlayed}</unsignedInt></value></item></Values></stats></player></SaveGame>`;

test("a fresh save start is accepted: the stat counts days INCLUDING today", () => {
  // This is the template every live run loads, and it is CORRECT. Reading the stat as "days before today" would make
  // this the inconsistent case in a false red.
  assert.deepEqual(assertSaveCalendarConsistent(save({ dayOfMonth: 1, daysPlayed: 1 })), {
    dayOfMonth: 1,
    daysPlayed: 1,
    season: "spring",
  });
  assert.deepEqual(assertSaveCalendarConsistent(save({ dayOfMonth: 2, daysPlayed: 2 })).dayOfMonth, 2);
});

test("the save a five-day jump produced is refused, with the numbers in the code", () => {
  // Measured 2026-11-03 (`round28`): the template above loaded as "spring 1", and ONE NewDay left the save at
  // `dayOfMonth=6, daysPlayed=2`. Those two fields cannot both be true.
  assert.throws(
    () => assertSaveCalendarConsistent(save({ dayOfMonth: 6, daysPlayed: 2 })),
    (error) => {
      assert.match(error.message, /^native_local_fixture_calendar_inconsistent:/u);
      assert.match(error.message, /dayOfMonth=6/u);
      assert.match(error.message, /daysPlayed=2/u);
      assert.match(error.message, /expected_dayOfMonth=2/u);
      return true;
    },
  );
});

test("the check reads both fields, so a save that only disagrees on dayOfMonth is caught", () => {
  assert.throws(() => assertSaveCalendarConsistent(save({ dayOfMonth: 3, daysPlayed: 2 })), /expected_dayOfMonth=2/u);
});

test("a save whose calendar cannot be read is refused by name, not treated as consistent", () => {
  assert.throws(() => assertSaveCalendarConsistent("<SaveGame></SaveGame>"), /calendar_unreadable/u);
});
