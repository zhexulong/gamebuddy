import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

import {
  EXPECTED_EVIDENCE_KEYS,
  assertColorPlacedObjectPostconditions,
} from "./run-stardew-native-local-player-color-placed-object-smoke.mjs";

/**
 * The color_placed_object live judgement, tested DIRECTLY.
 *
 * The judgement is pure, so it is exercised here with no transport at all - which is also what makes
 * these cases meaningful: each one is a way the LIVE run could lie about the world. The last case is
 * the mutation check: it breaks one of the judgement's own checks in a scratch copy of the runner and
 * requires the happy-path case to go red, so a check that cannot fail is reported instead of passing.
 */

const TARGET = { targetId: "color_0123456789abcdef", location: "Farm", x: 10, y: 12, color: "85,85,255" };
const SELECTION = 2;
const DETAIL =
  "target=color_0123456789abcdef;tile=10,12;location=Farm;color_selection=2;color_before=85,85,255;color_after=119,191,255;color_changed=true";
const EVIDENCE = {
  target: TARGET.targetId,
  tile: "10,12",
  location: "Farm",
  color_selection: "2",
  color_before: "85,85,255",
  color_after: "119,191,255",
  color_changed: "true",
};
const AFTER = { color: "119,191,255" };

function judge(overrides = {}) {
  return assertColorPlacedObjectPostconditions({
    target: TARGET,
    selection: SELECTION,
    detail: DETAIL,
    evidence: EVIDENCE,
    before: { color: TARGET.color },
    after: AFTER,
    ...overrides,
  });
}

/** The names the runner's own failure filter would surface. */
function red(checks) {
  return Object.entries(checks)
    .filter(([, ok]) => ok === false || ok === "not_checked")
    .map(([name]) => name);
}

test("the honest happy path passes every check", () => {
  const checks = judge();
  assert.deepEqual(checks, {
    evidenceShapeExact: true,
    receiptNamesTheTarget: true,
    receiptNamesTheSelection: true,
    receiptColourMoved: true,
    receiptAgreesWithObservedBefore: true,
    worldShowsColourAfter: true,
    worldShowsColourMoved: true,
  });
  assert.deepEqual(red(checks), []);
});

test("a receipt naming a different target fails", () => {
  const checks = judge({ evidence: { ...EVIDENCE, target: "color_ffffffffffffffff" } });
  assert.equal(checks.receiptNamesTheTarget, false);
  assert.deepEqual(red(checks), ["receiptNamesTheTarget"]);
});

test("a receipt naming a different tile fails", () => {
  const checks = judge({ evidence: { ...EVIDENCE, tile: "11,12" } });
  assert.equal(checks.receiptNamesTheTarget, false);
});

test("a receipt naming a different location fails", () => {
  const checks = judge({ evidence: { ...EVIDENCE, location: "FarmHouse" } });
  assert.equal(checks.receiptNamesTheTarget, false);
});

test("a receipt naming a different palette index fails", () => {
  const checks = judge({ evidence: { ...EVIDENCE, color_selection: "3" } });
  assert.equal(checks.receiptNamesTheSelection, false);
});

test("a receipt claiming a repaint that did not move the colour fails", () => {
  const checks = judge({ evidence: { ...EVIDENCE, color_before: "119,191,255", color_after: "119,191,255" } });
  assert.equal(checks.receiptColourMoved, false);
});

test("a receipt whose color_changed flag is false fails", () => {
  const checks = judge({ evidence: { ...EVIDENCE, color_changed: "false" } });
  assert.equal(checks.receiptColourMoved, false);
});

test("a receipt whose before colour disagrees with the observation fails", () => {
  const checks = judge({ evidence: { ...EVIDENCE, color_before: "0,0,0" } });
  assert.equal(checks.receiptAgreesWithObservedBefore, false);
});

test("a fresh observation disagreeing with the receipt's after colour fails", () => {
  const checks = judge({ after: { color: "255,0,0" } });
  assert.equal(checks.worldShowsColourAfter, false);
});

test("a world colour that did not move fails", () => {
  const checks = judge({ after: { color: TARGET.color } });
  assert.equal(checks.worldShowsColourMoved, false);
});

test("an observation surface with no colour reports not_checked, NEVER a pass", () => {
  // The distinction this case exists for: "I could not look" must not read as "the colour was right" -
  // and the runner treats `not_checked` as a failure, so a surface with no `colorTargets` colour cannot
  // silently bless a run.
  const checks = judge({ after: {} });
  assert.equal(checks.receiptAgreesWithObservedBefore, true);
  assert.equal(checks.worldShowsColourAfter, "not_checked");
  assert.equal(checks.worldShowsColourMoved, "not_checked");
  assert.deepEqual(red(checks), ["worldShowsColourAfter", "worldShowsColourMoved"]);
});

test("the evidence shape is exactly the seven frozen keys, in order", () => {
  assert.equal(EXPECTED_EVIDENCE_KEYS.length, 7);
  assert.equal(judge().evidenceShapeExact, true);
  // A missing key.
  assert.equal(judge({ detail: DETAIL.replace(";color_changed=true", "") }).evidenceShapeExact, false);
  // An extra key.
  assert.equal(judge({ detail: `${DETAIL};extra=1` }).evidenceShapeExact, false);
  // A '=' smuggled into a value: the Host's ';'-split would parse it as a different key.
  assert.equal(judge({ detail: DETAIL.replace("location=Farm", "location=Farm=FarmHouse") }).evidenceShapeExact, false);
  // A ';' smuggled into a value splits the list, so a key goes missing.
  assert.equal(judge({ detail: DETAIL.replace("location=Farm", "location=Farm;site=west") }).evidenceShapeExact, false);
  // An empty value.
  assert.equal(judge({ detail: DETAIL.replace("location=Farm", "location=") }).evidenceShapeExact, false);
  // The keys in a different order.
  assert.equal(
    judge({
      detail:
        "tile=10,12;target=color_0123456789abcdef;location=Farm;color_selection=2;color_before=85,85,255;color_after=119,191,255;color_changed=true",
    }).evidenceShapeExact,
    false,
  );
});

/**
 * The mutation check, required by the task: break the judgement's own world-did-move check in a scratch
 * copy of the runner and require the happy-path case to go red. A check that survives the mutation is
 * not load-bearing, and this reports the observed result either way.
 */
test("mutation: breaking the world-did-move check turns the happy path red", async () => {
  const runnerPath = fileURLToPath(new URL("./run-stardew-native-local-player-color-placed-object-smoke.mjs", import.meta.url));
  const mutationDir = fileURLToPath(new URL("../scratch/.tmp/", import.meta.url));
  const anchor = 'worldShowsColourMoved: worldObservable ? afterColour !== beforeColour : "not_checked",';
  const broken = 'worldShowsColourMoved: worldObservable ? afterColour === beforeColour : "not_checked",';

  const original = await readFile(runnerPath, "utf8");
  assert.ok(original.includes(anchor), "the mutation anchor must exist in the runner under test");
  const mutated = original
    .split(anchor)
    .join(broken)
    // The scratch copy lives outside `tools/`, so its relative imports are re-pointed at the same libs.
    .split('"./lib/')
    .join('"../../tools/lib/');
  assert.notEqual(mutated, original, "the mutation must actually change the source");

  await mkdir(mutationDir, { recursive: true });
  const mutatedPath = join(mutationDir, `color-placed-object-mutated-${process.pid}.mjs`);
  await writeFile(mutatedPath, mutated, "utf8");
  try {
    const mutatedModule = await import(`${pathToFileURL(mutatedPath).href}?mutation=${Date.now()}`);
    const observed = mutatedModule.assertColorPlacedObjectPostconditions({
      target: TARGET,
      selection: SELECTION,
      detail: DETAIL,
      evidence: EVIDENCE,
      before: { color: TARGET.color },
      after: AFTER,
    }).worldShowsColourMoved;
    console.log(
      `MUTATION-CHECK worldShowsColourMoved original=${JSON.stringify(judge().worldShowsColourMoved)} mutated=${JSON.stringify(observed)} caught=${String(observed === false)}`,
    );
    assert.equal(observed, false, "the mutated check must be red for a colour that really moved");
  } finally {
    await rm(mutatedPath, { force: true });
  }
});
