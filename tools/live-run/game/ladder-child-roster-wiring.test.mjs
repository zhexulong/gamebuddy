// THE WIRING THAT MAKES `bridge_disconnected` ATTRIBUTABLE, in the two scripts that cannot be run offline.
//
// Measured 2026-11-22 (`round90`, `blocked / bridge_disconnected`): `process-reclamation.json` named ONE process - the
// game, killed - and the Mod's log ended with the pipe's client gone. The Host's own exit was in no artifact, because only
// the game had a row. The behaviour (a host child leaving first, with its own code) is pinned on real children in
// `core/child-roster.test.mjs`; what is checkable here is that both scripts publish that roster instead of one game row.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const LAUNCHER = readFileSync(new URL("./launch-ladder-live.mjs", import.meta.url), "utf8");
const ORCHESTRATOR = readFileSync(new URL("../../_ladder-live-orchestrator.mjs", import.meta.url), "utf8");

test("the launcher records its own child, and stamps the merged record before the account reads it", () => {
  assert.match(
    LAUNCHER,
    /import \{ firstToLeaveLine, mergeChildren, openChildRoster, readChildRecord, writeChildRecord \} from "\.\.\/core\/child-roster\.mjs";/u,
    "one roster implementation, shared with the orchestrator",
  );
  assert.match(LAUNCHER, /const childRoster = openChildRoster\(\);/u);
  assert.match(LAUNCHER, /childRoster\.started\(\{ role: "orchestrator", pid: child\.pid,/u);
  assert.match(LAUNCHER, /childRoster\.ended\(\{ pid: child\.pid, code, signal, atMs: Date\.now\(\) \}\)/u);
  // Written once the child settled and BEFORE the reclamation account is stamped, because that account reads this file.
  const stampAt = LAUNCHER.indexOf("stampChildRecord();");
  const settledAt = LAUNCHER.indexOf("await childSettled;");
  const accountAt = LAUNCHER.indexOf("stampReclamationAccount(fixtureRestore);");
  assert.ok(settledAt > 0 && stampAt > settledAt, "the record is written after the child's own exit is known");
  assert.ok(accountAt > stampAt, "the account must read the merged record, not the orchestrator's half of it");
  // A record with no orchestrator rows is named, never published as a short roster that reads complete.
  assert.match(LAUNCHER, /partial:orchestrator_record_absent/u);
  assert.match(LAUNCHER, /firstToLeave: record\?\.firstToLeave \?\? null,/u, "the ordering reaches the bundle's account");
});

test("the orchestrator gives the game and the host a row each, with the exit their own handles reported", () => {
  assert.match(ORCHESTRATOR, /childRoster\.started\(\{ role: "game", pid: game\.pid,/u);
  assert.match(ORCHESTRATOR, /childRoster\.started\(\{ role: "host", pid: runner\.pid,/u);
  // The Host's row is fed from the runner's OWN `close` pair, which is the fact round90 recorded nowhere.
  assert.match(ORCHESTRATOR, /runner\.once\("close", \(code, signal\) => \{/u);
  assert.match(ORCHESTRATOR, /childRoster\.ended\(\{ pid: runner\.pid, code, signal, atMs: Date\.now\(\) \}\)/u);
  assert.match(ORCHESTRATOR, /writeChildRecord\(\{/u);
  assert.match(ORCHESTRATOR, /firstToLeaveLine\(recorded\.firstToLeave\)/u);
  // The game's pid and exit are its ROW now: one fact, one spelling.
  assert.doesNotMatch(ORCHESTRATOR, /pid: game\?\.pid \?\? null,/u, "the pid is the game's row, not a second field");
  assert.doesNotMatch(ORCHESTRATOR, /exit: game\?\.exit \?\? null,/u, "the exit is the game's row, not a second field");
});
