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
  assert.equal(
    (executeBlock.match(/^\s+dispatchedAtMs,$/gmu) ?? []).length,
    2,
    "both trace entries must carry the DISPATCH stamp (captured before the call, not after it)",
  );
  assert.equal(
    (executeBlock.match(/settledAtMs: Date\.now\(\),/gu) ?? []).length,
    2,
    "both trace entries must carry the settle stamp, so exec and think can be told apart",
  );
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
  assert.match(SOURCE, /return Object\.freeze\(\{ state: "refused", reasonCode \}\);/);
  // The refusal also reports WHICH facts the dump had, so a reason code is not the only clue.
  assert.match(SOURCE, /console\.error\(\s*"EVIDENCE_BUNDLE_REFUSED",\s*JSON\.stringify\(\{/);
  assert.match(SOURCE, /snapshotFields: snapshot === null \? \[\] : Object\.keys\(snapshot\)\.sort\(\),/);
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
    /const repro = failed\n?\s*\? buildReproPlan\(\{[\s\S]{0,300}?slot,\n\s*scenario,\n\s*\/\/ The nights this run had already crossed[\s\S]{0,200}?crossings: multidayOutcome\?\.crossings \?\? 0,/,
  );
  // ...and the plan must say what it can reach: a failure after a night cannot be re-entered by a day-level
  // replay, and the contract refuses a repro that does not state its reach.
  assert.match(SOURCE, /const repro = failed/);
  assert.match(SOURCE, /crossings: multidayOutcome\?\.crossings \?\? 0,/);
  // The manifest may only omit the window probes for the headless window mode, and it has to say so.
  assert.match(SOURCE, /reason: headlessWindowMode \? "headless_environment" : null,/);
  // A non-headless run MEASURES the adapter and the display: leaving them null is what refused every foreground
  // bundle (the contract accepts null facts only for a headless mode, with that reason).
  assert.match(SOURCE, /function measureEnvironmentFacts\(\)/u);
  assert.match(SOURCE, /const environmentFacts = headlessWindowMode/u);
});

test("the run's own narrative is judged and folded into the verdict", () => {
  // Reflection's only input is what the Historian wrote, so a run whose prose is a technical changelog has nothing
  // worth reflecting on. The judgement is made ONCE, published in the manifest, and folded into the verdict - a
  // report that says `passed` while the rubric found a violation would be the "gate passes while the behaviour is
  // absent" shape the plan names.
  assert.match(
    SOURCE,
    /import \{ checkHistorianRubric, readCompartments \} from "\.\.\/\.\.\/lib\/historian-rubric\.mjs";/,
  );
  assert.match(SOURCE, /function judgeRunHistorianRubric\(runtimeRoot\) \{/);
  assert.match(SOURCE, /historianRubricOutcome = judgeRunHistorianRubric\(runtimeRoot\);/);
  assert.match(SOURCE, /const historianRubricPassed = historianRubricOutcome\.state !== "failed";/);
  // `unmeasured` is deliberately NOT red: "there was nothing to judge" and "the narrative was bad" differ.
  // Formatting-insensitive: what matters is that the no-narrative case is its own named state.
  assert.match(SOURCE, /state: "unmeasured",[\s\S]{0,60}?no_compartments_written/);
  assert.match(SOURCE, /historian_rubric_violation:\$\{entry\.obligation\}@\$\{entry\.where\}/);
  // The verdict reads it, and the manifest carries it next to the voice lane.
  const verdict = SOURCE.slice(SOURCE.indexOf("      worldBookPassed &&"), SOURCE.indexOf('        ? "passed"'));
  assert.ok(verdict.includes("historianRubricPassed"), "the verdict must read the narrative obligation");
  assert.match(SOURCE, /historianRubric: \{\n      state: historianRubricOutcome\.state,/);
  // The failure path reports it too, which is why the variable is declared outside the try.
  assert.match(SOURCE, /let historianRubricOutcome = null;/);
});

test("the world snapshot and the capability face are sampled during the run, not re-read after teardown", () => {
  // Measured live 2026-10-16: the bundle was assembled after the session ended, when the bridge had already
  // cleared `#snapshot`, so the failure dump was all nulls (the contract refused it) and the presence projection
  // saw zero visible actions. Sampling during the run is the only correct source.
  assert.match(SOURCE, /let lastObservedSnapshot = null;/);
  assert.match(SOURCE, /function rememberObservation\(\) \{/);
  // The snapshot is taken at dispatch: the world as the actor saw it just before acting.
  const execute = SOURCE.slice(
    SOURCE.indexOf("client.execute = async (request) => {"),
    SOURCE.indexOf("client.programSubmit"),
  );
  assert.match(execute, /rememberObservation\(\);/);
  assert.match(SOURCE, /settlement: \{ snapshot: lastObservedSnapshot, reasonCode: null, component: null \},/);
  assert.match(
    SOURCE,
    /settlement: \{ snapshot: lastObservedSnapshot, reasonCode: partialResult\.error, component: "runner" \},/,
  );
  assert.match(
    SOURCE,
    /const snapshot =\s*settlement\?\.snapshot \?\? lastObservedSnapshot \?\? lastObservedPose \?\? null;/,
  );
  // The pose comes from the execution receipt's own local observation (the snapshot carries no facing).
  assert.match(SOURCE, /rememberPose\(receipt\?\.observation\);/);
  // No bundle path may fall back to the post-teardown read.
  assert.doesNotMatch(SOURCE, /settlement: \{ snapshot: client\.state\?\.snapshot/);
  assert.match(SOURCE, /const visibleActionIds = \[\.\.\.advertisedActionSamples\];/);
  assert.doesNotMatch(SOURCE, /const visibleActionIds = Array\.isArray\(client\.state\.snapshot/);
});

test("a transport that dies mid-run is recorded, and is its own verdict", () => {
  // Measured live 2026-10-16: the pipe dropped while the Agent was still working. The Agent then wrote a
  // truthful line about losing the connection, nothing presented it (the bridge was gone), and the run reported
  // `silent` - "the companion said nothing" - for a transport fault. Both the record and the verdict are needed:
  // the reason code alone would not say how far in it happened.
  assert.match(SOURCE, /const bridgeDisconnections = \[\];/);
  assert.match(SOURCE, /client\.onConnectionFact\(\(fact\) => \{/);
  assert.match(SOURCE, /dispatchesSoFar: actionTrace\.length,/);
  assert.match(SOURCE, /console\.error\("BRIDGE_DISCONNECTED", JSON\.stringify\(entry\)\);/);
  // The verdict arm sits before `silent`: a dead pipe explains silence, so it must not be reported as silence.
  const verdict = SOURCE.slice(SOURCE.indexOf("const sessionVerdict ="), SOURCE.indexOf("const morningRoutinePassed"));
  const disconnectedAt = verdict.indexOf('"bridge_disconnected"');
  const silentAt = verdict.indexOf('"silent"');
  assert.ok(disconnectedAt >= 0 && silentAt > disconnectedAt, "bridge_disconnected must be decided before silent");
  assert.match(SOURCE, /bridgeDisconnections,/);
});

test("a disposable root lives in the repository's own scratch area, never the product root", () => {
  // The product's durable runtime root must never be the target of a test, and the OS temp tree is shared with
  // every other tool. Memory writes and voice preferences made by a run belong in `.tmp/` (git-ignored).
  assert.match(
    SOURCE,
    /const disposableParent = join\(fileURLToPath\(new URL\("\.\.\/\.\.\/\.\.", import\.meta\.url\)\), "\.tmp"\);/,
  );
  assert.match(SOURCE, /await mkdir\(disposableParent, \{ recursive: true \}\);/);
  assert.match(
    SOURCE,
    /const root = usesDisposableRoot \? await mkdtemp\(join\(disposableParent, "gamebuddy-agent-ab-"\)\) : configuredRuntimeRoot;/,
  );
  assert.doesNotMatch(SOURCE, /from "node:os"/);
});

test("the launcher and the runner agree about the window mode the bundle reports", () => {
  // Measured live 2026-10-16: the launcher set only GAMEBUDDY_LADDER_WINDOW_MODE (which the ORCHESTRATOR reads
  // for the game child), so the runner believed it was `visible`, left GPU/resolution null and still claimed
  // `headless_environment`. The bundle contract refused the bundle - correctly - and the run's own evidence was
  // missing. Both names must be set, from the one vocabulary.
  const launcher = readFileSync(new URL("./launch-ladder-live.mjs", import.meta.url), "utf8");
  assert.match(launcher, /import \{ normalizeLiveRunWindowMode \} from "\.\.\/\.\.\/lib\/stardew-live-run\.mjs";/);
  assert.match(
    launcher,
    /const windowMode = normalizeLiveRunWindowMode\(process\.env\.GAMEBUDDY_LADDER_WINDOW_MODE \?\? "hidden"\);/,
  );
  assert.match(launcher, /GAMEBUDDY_LADDER_WINDOW_MODE: windowMode,\n\s+GAMEBUDDY_WINDOW_MODE: windowMode,/);
  assert.doesNotMatch(launcher, /GAMEBUDDY_LADDER_WINDOW_MODE: process\.env\.GAMEBUDDY_LADDER_WINDOW_MODE/);
});

test("the launcher tells the runner which slot to return to", () => {
  // Measured live 2026-10-16: no slot reached the runner, so a failed run could not publish a repro command and
  // the bundle contract refused it. The slot is run identity, so the launcher passes it.
  const launcher = readFileSync(new URL("./launch-ladder-live.mjs", import.meta.url), "utf8");
  assert.match(launcher, /GAMEBUDDY_DAY_START_SLOT: saveName,/);
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

test("the action cadence is split into exec, think and idle, stamped honestly", () => {
  // A review asked why the companion "feels laggy" and the only answer the data could give was ONE number, which
  // also lied: `dispatchedAtMs` was stamped when the RECEIPT returned, so the "gap" contained the next action's
  // execution while the field name said otherwise. The runner now stamps it before the call, records `settledAtMs`,
  // and publishes the split.
  assert.match(SOURCE, /const dispatchedAtMs = Date\.now\(\);/);
  const stampAt = SOURCE.indexOf("const dispatchedAtMs = Date.now();");
  const callAt = SOURCE.indexOf("const receipt = await originalExecute(request);");
  assert.ok(stampAt > 0 && callAt > stampAt, "the dispatch stamp must precede the call it names");
  assert.match(SOURCE, /settledAtMs: Date\.now\(\),/);
  assert.match(SOURCE, /actionCadence: summarizeActionCadence\(actionTrace\),/);
  assert.match(SOURCE, /import \{ summarizeActionCadence \} from "\.\.\/\.\.\/lib\/action-cadence\.mjs";/);
});

test("both result paths carry the run window, so the tail is measurable even when the bundle is refused", () => {
  // The review asked where a 15-minute run's time went and the artifacts could not say: the deepest run's directory
  // held a result with no window at all (its bundle was refused, so no manifest). The TAIL - last dispatch to the
  // end - is the number that question needs, and it must survive the failure path too.
  // Each result literal owns its own window, checked INSIDE the literal rather than by a global count: the runner
  // legitimately mentions the phase clock elsewhere (a run-identity record), so a count would be asserting the
  // wrong thing and would break the day an unrelated use appears.
  for (const marker of ["const result = {", "const partialResult = {"]) {
    const from = SOURCE.indexOf(marker);
    assert.ok(from > 0, `${marker} must exist`);
    const block = SOURCE.slice(from, from + 400);
    assert.match(block, /startedAtMs: phaseTimings\.runStartedAtMs,/u, `${marker} must carry the start`);
    assert.match(block, /endedAtMs: Date\.now\(\),/u, `${marker} must carry the end`);
  }
  assert.match(SOURCE, /runStartedAtMs: Date\.now\(\)/u, "the phase clock is the start the results publish");
});
