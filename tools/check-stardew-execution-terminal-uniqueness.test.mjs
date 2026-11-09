#!/usr/bin/env node
/**
 * Falsifiers for tools/check-stardew-execution-terminal-uniqueness.mjs.
 *
 * Every pin is a HAND-BUILT artifact: the gate is a per-run verifier, so the suite supplies the run. Each case is the
 * defect the gate exists for, stated as the reading a real run would have produced.
 *
 * red-proof: inject  one request answered twice in a hand-built artifact -> `duplicate_answer:request_feed_01` and
 *   `"duplicated":1`, exit 1, asserted at process level by `runGate` below
 *   (tools/check-stardew-execution-terminal-uniqueness.test.mjs)
 * red-proof: inject  one terminal twice on the fact channel -> `duplicate_fact:execution_feed_01:` +
 *   `hay_placed_in_trough,hay_placed_in_trough`, exit 1, the pre-fix double this gate exists for
 *   (tools/check-stardew-execution-terminal-uniqueness.test.mjs)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyTerminals,
  normalizeReceiptFrame,
  readChannels,
} from "./check-stardew-execution-terminal-uniqueness.mjs";

const GATE = fileURLToPath(new URL("./check-stardew-execution-terminal-uniqueness.mjs", import.meta.url));

/** The live `feed_animal` slice: the fact the Mod pushed, and the answer to the request that asked for it. */
const FACT = Object.freeze({
  requestId: "request_feed_01",
  executionId: "execution_feed_01",
  state: "succeeded",
  reasonCode: "hay_placed_in_trough",
});
const ANSWER = Object.freeze({ ...FACT });

function read(artifact) {
  return classifyTerminals(readChannels(artifact));
}

function runGate(artifact) {
  const directory = mkdtempSync(join(tmpdir(), "stardew-terminal-uniqueness-"));
  const path = join(directory, "artifact.json");
  try {
    writeFileSync(path, JSON.stringify(artifact, null, 2));
    const result = spawnSync(process.execPath, [GATE, "--artifact", path], { encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("one execution delivered once per channel is one fact and one answer, not two terminals", () => {
  const reading = read({ facts: [FACT], answers: [ANSWER] });
  assert.equal(reading.examined, 2);
  assert.equal(reading.answers, 1);
  assert.equal(reading.facts, 1);
  assert.equal(reading.unsolicited, 0, "the fact belongs to a request that was answered, so it is not unsolicited");
  assert.deepEqual(reading.findings, []);
});

test("one request answered twice is duplicate_answer", () => {
  const reading = read({ answers: [ANSWER, { ...ANSWER, reasonCode: "farm_animal_already_petted_today" }] });
  assert.deepEqual(
    reading.findings.map((finding) => finding.code),
    ["duplicate_answer:request_feed_01"],
  );
  assert.match(reading.findings[0].detail, /2 answers for one request/u);
});

test("a replayed request is a second ANSWER to the same execution, which is legitimate", () => {
  const replay = { ...ANSWER, requestId: "request_feed_02" };
  const reading = read({ facts: [FACT], answers: [ANSWER, replay] });
  assert.equal(reading.answers, 2);
  assert.equal(reading.answerRequests, 2, "two asks, one execution");
  assert.deepEqual(reading.findings, [], "one answer per request is the contract, whatever execution it names");
});

test("the same terminal reaching the fact listeners twice is the pre-fix double, named duplicate_fact", () => {
  // The measured defect, as a reading: the pushed fact AND the answer that carried the same bytes both reached the
  // fact listeners, so one `feed_animal` execution looked like two `succeeded/hay_placed_in_trough` terminals.
  const reading = read({ facts: [FACT, ANSWER], answers: [ANSWER] });
  assert.deepEqual(
    reading.findings.map((finding) => finding.code),
    ["duplicate_fact:execution_feed_01:hay_placed_in_trough,hay_placed_in_trough"],
  );
  assert.match(reading.findings[0].detail, /2 terminals reached the fact listeners for one execution/u);
});

test("two unsolicited terminals for one execution are duplicate_fact, naming the execution and the reasons", () => {
  const parked = { ...FACT, requestId: "request_parked_expiry_01" };
  const reading = read({
    receipts: [parked, { ...parked, state: "rejected", reasonCode: "waiting_for_body:body_owned_by_activity" }],
  });
  assert.equal(reading.examined, 2);
  assert.equal(reading.unsolicited, 2, "nothing answered this execution, so both terminals arrived as facts");
  assert.deepEqual(
    reading.findings.map((finding) => finding.code),
    ["duplicate_fact:execution_feed_01:hay_placed_in_trough,waiting_for_body:body_owned_by_activity"],
  );
  assert.match(reading.findings[0].detail, /2 terminals reached the fact listeners for one execution/u);
});

test("a progress receipt is not a terminal and is not counted", () => {
  const reading = read({ receipts: [{ ...FACT, state: "accepted", reasonCode: "accepted" }, FACT] });
  assert.equal(reading.examined, 1, "only terminals are the population");
  assert.deepEqual(reading.findings, []);
});

test("a runner's own block and a raw pipe frame are read through the one shape", () => {
  assert.deepEqual(readChannels({ terminals: [FACT] }).facts, [FACT]);
  assert.deepEqual(readChannels({ receipts: [FACT] }).facts, [FACT]);
  assert.deepEqual(readChannels([FACT]).facts, [FACT]);
  assert.deepEqual(readChannels({ ...FACT }).facts, [FACT], "a bare receipt frame is a fact stream of one");
  assert.deepEqual(
    normalizeReceiptFrame({ type: "execution_receipt", correlationId: "c", payload: { ...FACT } }),
    FACT,
  );
});

test("an artifact that records no answer channel says so instead of reading clean", () => {
  const reading = read({ terminals: [FACT] });
  assert.equal(reading.answerChannelPresent, false);
  assert.equal(reading.answers, 0);
  assert.deepEqual(reading.findings, [], "the fact rules still run, and they are not renamed by a missing channel");
});

test("a real run's reading passes, and a duplicated answer fails it by name", () => {
  const clean = runGate({ facts: [FACT], answers: [ANSWER] });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /"status":"passed"/u);
  assert.match(clean.stdout, /"population":2,"answers":1,"answerRequests":1,"facts":1,"unsolicited":0,"duplicated":0/u);
  assert.doesNotMatch(clean.stdout, /answer channel not recorded/u);

  const duplicated = runGate({ facts: [FACT], answers: [ANSWER, { ...ANSWER, reasonCode: "accepted" }] });
  assert.equal(duplicated.status, 1);
  assert.match(duplicated.stderr, /duplicate_answer:request_feed_01/u);
  assert.match(duplicated.stdout, /"duplicated":1/u);
});

test("a fact-stream duplicate of the same terminal fails the gate by name", () => {
  const duplicated = runGate({
    receipts: [FACT, { ...FACT, state: "rejected", reasonCode: "feed_trough_target_changed" }],
  });
  assert.equal(duplicated.status, 1);
  assert.match(duplicated.stderr, /duplicate_fact:execution_feed_01:hay_placed_in_trough,feed_trough_target_changed/u);
  assert.match(duplicated.stdout, /"duplicated":1/u);
});

test("an artifact with no receipt frame is not_measured, never green", () => {
  const empty = runGate({ terminals: [] });
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /^stardew_execution_terminal_uniqueness_skipped:/mu);
  const missing = spawnSync(process.execPath, [GATE], { encoding: "utf8" });
  assert.equal(missing.status, 0);
  assert.match(missing.stdout, /^stardew_execution_terminal_uniqueness_skipped: needs --artifact/mu);
});

test("the gate is reachable from the repository the same way its siblings are", () => {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  assert.match(
    scripts["check:stardew-execution-terminal-uniqueness"],
    /check-stardew-execution-terminal-uniqueness\.mjs/u,
  );
  assert.match(
    scripts["test:stardew-execution-terminal-uniqueness"],
    /--test tools\/check-stardew-execution-terminal-uniqueness\.test\.mjs/u,
  );
});
