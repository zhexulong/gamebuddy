// The runner-side bundle contract: the two things a live-run bundle gets wrong when nothing checks it.
//  1. The action trace must carry the game clock, or no failure in it can be replayed at the right moment.
//  2. The bundle must be produced through the ONE validator, and a refusal must be reported by name
//     rather than arriving as a smaller artifact.
// Source-level assertions are the right lever here: the runner drives a real game and cannot be unit-run,
// so what is checkable offline is that it wires the shared implementation instead of its own version.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const RUNNER = new URL("./run-stardew-native-local-agent-ab-live.mjs", import.meta.url);
const SOURCE = readFileSync(RUNNER, "utf8");

test("the action trace records the game clock at dispatch, from the bridge snapshot", () => {
  assert.match(SOURCE, /const dispatchClock = \(\) => \{/);
  assert.match(SOURCE, /snapshot\.timeOfDay/);
  assert.match(SOURCE, /const traceClockFields = \(clock\) => \(\{/);
  assert.match(SOURCE, /inGameTime: typeof clock\?\.timeOfDay === "number" \? String\(clock\.timeOfDay\) : null/);
  // Both the success and the rejection path must record it: a rejected dispatch is exactly the kind of step a
  // replay needs to reach again.
  const executeBlock = SOURCE.slice(
    SOURCE.indexOf("client.execute = async (request) => {"),
    SOURCE.indexOf("// Capture the Agent-authored program id"),
  );
  assert.equal(
    (executeBlock.match(/\.\.\.traceClockFields\(clock\)/gu) ?? []).length,
    2,
    "both trace entries must carry the clock",
  );
  assert.equal((executeBlock.match(/dispatchedAtMs: Date\.now\(\)/gu) ?? []).length, 2);
  // An unreadable clock stays null rather than being invented: the bundle contract then refuses the trace.
  assert.doesNotMatch(executeBlock, /inGameTime: "6\d\d"/);
});

test("the runner writes its bundle through the shared validator, and names a refusal", () => {
  assert.match(SOURCE, /import \{ writeEvidenceBundle \} from "\.\.\/\.\.\/lib\/evidence-bundle\.mjs";/);
  assert.match(SOURCE, /import \{ buildFailureSnapshot, buildReproPlan \} from "\.\.\/\.\.\/lib\/failure-dump\.mjs";/);
  assert.match(SOURCE, /async function writeRunBundle\(\{/);
  assert.match(
    SOURCE,
    /const written = await writeEvidenceBundle\(capture\.dir, \{ bundle, timeline, actionTrace \}\);/,
  );
  // A bundle that cannot be written is reported with its own reason code, never silently dropped.
  assert.match(
    SOURCE,
    /return Object\.freeze\(\{ state: "refused", reasonCode: String\(error instanceof Error \? error\.message : error\) \}\);/,
  );
  // Both the success and the failure path publish it on the result.
  assert.match(SOURCE, /result\.bundle = await writeRunBundle\(\{/);
  assert.match(SOURCE, /partialResult\.bundle = await writeRunBundle\(\{/);
  // The recorded timeline count is the fact log's own length, so the on-disk file cannot disagree with the
  // manifest the validator cross-checks.
  assert.match(
    SOURCE,
    /timeline: \{ path: "timeline\.jsonl", records: factLog\.length, sources: \["player", "smapi", "llm"\] \}/,
  );
  assert.match(SOURCE, /const timeline = factLog\.map\(\(entry, index\) => \(\{ index, \.\.\.entry \}\)\);/);
});

test("the failure dump is built from the bridge's own facts and the trace's own budget", () => {
  assert.match(SOURCE, /const failure = failed\n?\s*\? buildFailureSnapshot\(\{/);
  assert.match(
    SOURCE,
    /const repro = failed \? buildReproPlan\(\{ actionTrace, turn: actionTrace\.length, slot, scenario \}\) : null;/,
  );
  // The manifest may only omit the window probes for the headless window mode, and it has to say so.
  assert.match(SOURCE, /reason: process\.env\.GAMEBUDDY_GPU === undefined \? "headless_environment" : null,/);
});

test("the runner imports the same failure-dump module the replay engine and the gate use", () => {
  // One implementation: a second copy of "where was the actor and when" is how two tools come to disagree.
  const dump = readFileSync(new URL("../../lib/failure-dump.mjs", import.meta.url), "utf8");
  const engine = readFileSync(new URL("../../lib/replay-engine.mjs", import.meta.url), "utf8");
  assert.match(dump, /export function buildFailureSnapshot/);
  assert.match(dump, /export function buildReproPlan/);
  assert.match(engine, /import \{ decideReplayDispatch \} from "\.\/replay-clock\.mjs";/);
  assert.match(engine, /export async function replayActionTrace/);
});
