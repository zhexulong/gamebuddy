// The source gate: a printed value names the file it was read from, or it fails by the name of the reading.
//
// Every case here is built on the ledger itself, because the property is about what the ledger counts from the text each
// tool prints - not about a flag a caller passes. A reading whose value says `not_measured` is the other honest half: it
// names what no artifact answers, and it is not a reading at all.
import assert from "node:assert/strict";
import test from "node:test";

import { createReadingLedger, FROM_RESULT, FROM_RUNNER_LOG, SOURCE_GATE } from "./reading-source.mjs";

const summary = (ledger) => ledger.lines().find((line) => line.startsWith(`${SOURCE_GATE} readings`)) ?? "";

test("the population is what the tool printed, split by the file each reading was read from", () => {
  const ledger = createReadingLedger();
  ledger.fromResult("breadth.attempted", 24);
  ledger.fromResult("breadth.addressable", 54);
  ledger.fromLog("work.executions", 469);
  assert.match(
    summary(ledger),
    /readings examined 3 · from-result 2 · from-log 1 · unmeasured 0$/u,
    "three readings were printed and each one's file is counted",
  );
  assert.equal(ledger.failed(), false);
});

test("a value printed with no file behind it fails the gate, naming the reading", () => {
  const ledger = createReadingLedger();
  ledger.fromResult("work.executions", 74);
  ledger.unsourced("work.answer", 0);
  assert.equal(ledger.failed(), true, "a number nobody can re-derive must not exit clean");
  assert.match(
    ledger.lines()[0],
    /^a_reading_names_the_source_it_read:work\.answer - printed a value and named no file/u,
  );
  assert.match(summary(ledger), /readings examined 2 · from-result 1 · from-log 0 · unmeasured 1$/u);
});

test("a not_measured value is an absence, not a reading, and never fails the gate", () => {
  const ledger = createReadingLedger();
  ledger.fromResult("work.executions", 74);
  ledger.fromResult("multiday.crossings", "not_measured (this run publishes no multiday)");
  assert.equal(ledger.failed(), false);
  assert.deepEqual(ledger.absences(), ["multiday.crossings"]);
  assert.match(summary(ledger), /readings examined 1 · from-result 1 · from-log 0 · unmeasured 0$/u);
});

test("a tool that printed no reading at all is blocked, because 0 of 0 agrees with itself", () => {
  const ledger = createReadingLedger();
  ledger.fromLog("verdict", "not_measured:the run has published no result.json");
  assert.equal(ledger.failed(), true);
  assert.match(ledger.lines()[0], /^a_reading_names_the_source_it_read:blocked - readings examined 0/u);
});

test("a tool whose readings are one block beside other rows still says when it took none", () => {
  // `round-verdict` adds this block to rows that read other files, so a run with no log has no reading to take - and the
  // absence is printed by the block itself. The summary is printed either way, so `examined 0` is never silent.
  const ledger = createReadingLedger({ requireReadings: false });
  assert.equal(ledger.failed(), false);
  assert.match(summary(ledger), /readings examined 0 · from-result 0 · from-log 0 · unmeasured 0$/u);
  assert.equal(
    ledger.lines().some((line) => line.includes(":blocked -")),
    false,
  );
  // A value with no source still fails it: the exemption is about an empty population, not about naming one.
  ledger.unsourced("work.answer", 0);
  assert.equal(ledger.failed(), true);
});

test("every reading carries a name a failure can point at", () => {
  const ledger = createReadingLedger();
  assert.throws(() => ledger.fromLog("", 3), /reading_source_unnamed_reading/u);
});

test("the two source names are the two files, never a third spelling", () => {
  assert.equal(FROM_RESULT, "result.json");
  assert.equal(FROM_RUNNER_LOG, "live-runner.log");
});
