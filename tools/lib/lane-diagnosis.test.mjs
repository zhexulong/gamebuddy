// The lane-diagnosis falsifiers: a failed lane's cause must be read from its output, not guessed, and the two
// ways PowerShell hides it (a source line where the message should be; the message on the other stream) are
// exactly what these pin.
import assert from "node:assert/strict";
import test from "node:test";

import {
  appendLaneOutput,
  classifyLaneFailure,
  LANE_FAILURE_CAUSES,
  LANE_OUTPUT_LIMIT,
  laneDiagnosis,
  liveLaneVerdict,
} from "./lane-diagnosis.mjs";

test("a lane failure is classified by what it said, never by default", () => {
  assert.equal(
    classifyLaneFailure("Native-local bridge pipe was not ready before timeout."),
    "second_instance_never_reached_bridge_readiness",
  );
  assert.equal(
    classifyLaneFailure("Native-local SMAPI process exited before bridge smoke."),
    "second_instance_exited_before_bridge",
  );
  assert.equal(
    classifyLaneFailure(
      "Native-local launch identity requires exactly one SMAPI process after pipe readiness (PIDs: 37292,41044).",
    ),
    "exactly_one_smapi_process",
  );
  // A lane that failed for a reason nobody recognized still gets a name, so the gate can never report "unknown".
  assert.equal(classifyLaneFailure("something new"), "lane_failed_without_a_named_cause");
  assert.equal(classifyLaneFailure(""), "lane_failed_without_a_named_cause");
  for (const cause of LANE_FAILURE_CAUSES) assert.equal(typeof cause, "string");
});

test("the diagnosis prefers a cause over a source line", () => {
  // The shape PowerShell actually prints: WHERE first, the message after it.
  const output = [
    "Exception: E:\\repo\\tools\\run-stardew-native-local-player-move-fixture.ps1:322",
    "Line |",
    ' 322 |   if ([DateTime]::UtcNow -ge $deadline) { throw "Native-local bridge pipe was not ready before timeout." }',
    "     |   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~",
    "Native-local bridge pipe was not ready before timeout.",
  ].join("\n");
  const diagnosis = laneDiagnosis(output);
  assert.match(diagnosis, /bridge pipe was not ready/u, diagnosis);
  assert.doesNotMatch(diagnosis, /\.ps1:322/u);

  // Only decorations: the underline rows are dropped and the source line is the fallback, not a blank answer.
  assert.equal(laneDiagnosis("\n  ~~~~~\n  ^^^\n"), "no_output");
  assert.match(laneDiagnosis("some output\nE:\\x.ps1:9\n"), /some output/u);
});

test("both streams are kept, and the tail is what survives", () => {
  // The formatted exception goes to stdout, which is why capturing stderr alone made a failed lane look silent.
  let captured = "";
  captured = appendLaneOutput(captured, '{"state":"bootstrap_prepared"}\n');
  captured = appendLaneOutput(captured, "Native-local bridge pipe was not ready before timeout.\n");
  assert.match(captured, /bootstrap_prepared/u);
  assert.match(captured, /pipe was not ready/u);
  assert.equal(classifyLaneFailure(captured), "second_instance_never_reached_bridge_readiness");

  // A lane cannot flood the record: only the tail is kept, and it stays within the bound.
  const flooded = appendLaneOutput("x".repeat(LANE_OUTPUT_LIMIT * 2), "tail-marker");
  assert.equal(flooded.length, LANE_OUTPUT_LIMIT);
  assert.match(flooded, /tail-marker$/u);
});

test("the live verdict names the blocking capability instead of saying 'unknown'", () => {
  assert.equal(liveLaneVerdict({ lanesRan: true, outcomes: [] }), "ran");
  const blocked = liveLaneVerdict({
    lanesRan: false,
    outcomes: ["Native-local bridge pipe was not ready before timeout.", "Exception: x.ps1:322"],
  });
  assert.match(blocked, /^isolated_lanes_cannot_run_concurrently:/u);
  assert.match(blocked, /second_instance_never_reached_bridge_readiness/u);
  // Distinct causes are all named, sorted, and never repeated.
  const mixed = liveLaneVerdict({
    lanesRan: false,
    outcomes: [
      "Native-local bridge pipe was not ready before timeout.",
      "Native-local bridge pipe was not ready before timeout.",
      "Native-local launch identity requires exactly one SMAPI process after pipe readiness (PIDs: 1,2).",
    ],
  });
  assert.equal(
    mixed,
    "isolated_lanes_cannot_run_concurrently:exactly_one_smapi_process+second_instance_never_reached_bridge_readiness",
  );
});
