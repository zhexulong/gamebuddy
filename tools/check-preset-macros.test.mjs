import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PRESET_MACROS } from "../host/src/tavern/preset-macros.ts";
import { auditPresetMacros, FIXTURE_PRESET, PRESET_SEGMENTS, presetStrings } from "./check-preset-macros.mjs";

/**
 * red-proof: the `macro_unknown` branch was replaced by `continue` (an unknown name silently skipped) ->
 * `a macro absent from the table is reported as unknown, not as unimplemented` failed with
 * `actual: 'passed', expected: 'failed'`, and `a repeated violation is reported once` failed with
 * `actual: [], expected: [ 'macro_unknown:mystery' ]`. Restored, green.
 *
 * Also seen red once: `segment === "before"` replaced by `segment === "depth"` -> `a tail-only macro in the
 * before segment is reported with its segment` failed with `actual: [ 'macro_not_implemented:time' ], expected:
 * [ 'macro_not_implemented:time', 'macro_tail_only_in_segment:time:before' ]`; and the `tokens.length === 0`
 * block removed -> `a preset with no macro is blocked, never passed` failed with `actual: 'passed', expected:
 * 'blocked'`.
 *
 * Family red-proof: the reading's `name` taken from `token.name` instead of the resolved entry -> `a shorthand is
 * judged by the family that declares it` failed with `actual: [ '.mood', '.mood = calm' ], expected: [ '.varName',
 * '.varName = value' ]`, and `the global shorthand fails the run under its family name` failed with `actual:
 * 'passed', expected: 'failed'`; restored, green. `$varName` declared `implemented: true` -> the same global test
 * reported status `passed`; restored, green.
 */

const GATE = fileURLToPath(new URL("./check-preset-macros.mjs", import.meta.url));
const IMPLEMENTED = new Set(PRESET_MACROS.filter((entry) => entry.implemented).map((entry) => entry.name));

/** A preset shaped like the real thing, carrying whatever `content` the case is about. */
function presetWith(...content) {
  return {
    name: "case preset",
    prompts: content.map((entry, index) => ({ identifier: `entry-${index}`, content: entry })),
  };
}

function codes(audit) {
  return audit.violations.map((violation) => violation.code);
}

/** Runs the gate as the caller runs it, so exit codes and the printed line are judged, not just the reading. */
function runGate(args) {
  const result = spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function withPresetFile(preset, body) {
  const directory = mkdtempSync(join(tmpdir(), "gamebuddy-preset-macros-"));
  try {
    const path = join(directory, "preset.json");
    writeFileSync(path, JSON.stringify(preset), "utf8");
    return body(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the shipped fixture preset passes, and every name it carries is an implemented macro", async () => {
  const audit = await auditPresetMacros();
  assert.equal(audit.status, "passed", JSON.stringify(audit.violations));
  assert.deepEqual(audit.violations, []);
  assert.ok(audit.examined > 0, "the fixture must carry macros, or a green run would mean nothing");
  assert.deepEqual(
    audit.names.filter((name) => !IMPLEMENTED.has(name)),
    [],
    "the fixture may only spell macros v1 implements",
  );
});

test("the population is every string in the preset, not only prompts[].content", async () => {
  const strings = presetStrings({
    name: "{{char}} preset",
    prompts: [{ content: "{{user}}" }],
    prompt_order: [{ identifier: "{{personality}}" }],
    temperature: 0.7,
  });
  assert.deepEqual(strings, ["{{char}} preset", "{{user}}", "{{personality}}"]);
  assert.equal((await auditPresetMacros({ preset: { name: "{{char}} {{user}}" } })).examined, 2);
});

test("a macro spelled only inside another macro's argument is still part of the population", async () => {
  const audit = await auditPresetMacros({ preset: presetWith("{{getvar::{{time}}_mood}}") });
  assert.equal(audit.examined, 2);
  assert.deepEqual(codes(audit), ["macro_not_implemented:time"]);
});

test("an unimplemented macro turns the run red and is named", async () => {
  const audit = await auditPresetMacros({ preset: presetWith("{{if mood}}stay{{/if}}") });
  assert.equal(audit.status, "failed");
  assert.deepEqual(codes(audit), ["macro_not_implemented:if", "macro_not_implemented:/if"]);
});

test("a macro absent from the table is reported as unknown, not as unimplemented", async () => {
  const audit = await auditPresetMacros({ preset: presetWith("write to {{support_email}}") });
  assert.equal(audit.status, "failed");
  assert.deepEqual(codes(audit), ["macro_unknown:support_email"]);
});

test("a shorthand is judged by the family that declares it, never as unknown", async () => {
  const audit = await auditPresetMacros({
    preset: presetWith("Mood: {{.mood}}. Then {{.mood = calm}} and {{.mood}}."),
  });
  assert.equal(audit.status, "passed", JSON.stringify(audit.violations));
  assert.equal(audit.examined, 3);
  assert.deepEqual(audit.names, [".varName", ".varName = value"]);
  assert.deepEqual(codes(audit), []);
});

test("the global shorthand fails the run under its family name", async () => {
  const audit = await auditPresetMacros({ preset: presetWith("Global: {{$mood}}.") });
  assert.equal(audit.status, "failed");
  assert.deepEqual(audit.names, ["$varName"]);
  assert.deepEqual(codes(audit), ["macro_not_implemented:$varName"]);
});

test("a tail-only macro in the before segment is reported with its segment", async () => {
  const preset = presetWith("it is {{time}}");
  assert.deepEqual(codes(await auditPresetMacros({ preset, segment: "before" })), [
    "macro_not_implemented:time",
    "macro_tail_only_in_segment:time:before",
  ]);
  assert.deepEqual(codes(await auditPresetMacros({ preset, segment: "after" })), ["macro_not_implemented:time"]);
  assert.deepEqual(codes(await auditPresetMacros({ preset, segment: "depth" })), ["macro_not_implemented:time"]);
  assert.deepEqual(codes(await auditPresetMacros({ preset })), ["macro_not_implemented:time"]);
});

test("every entry's segment policy is one this gate branches on", () => {
  for (const entry of PRESET_MACROS)
    assert.ok(
      ["any", "tail-only"].includes(entry.segmentPolicy),
      `${entry.name} declares segmentPolicy ${JSON.stringify(entry.segmentPolicy)}`,
    );
});

test("a preset with no macro is blocked, never passed", async () => {
  const audit = await auditPresetMacros({ preset: presetWith("write the next reply") });
  assert.equal(audit.examined, 0);
  assert.equal(audit.status, "blocked");
  assert.equal(audit.blocked.code, "preset_macros_none_found");
});

test("a repeated violation is reported once, and every distinct token is counted", async () => {
  const audit = await auditPresetMacros({ preset: presetWith("{{random::a::b}} {{random::a::b}} {{mystery}}") });
  assert.equal(audit.examined, 3);
  assert.deepEqual(codes(audit), ["macro_unknown:mystery"]);
});

test("the command exits 0 and prints the examined count on the shipped fixture", () => {
  const run = runGate([]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /preset_macros examined \d+ macros violations 0 names \d+ status passed/u);
});

test("the command exits 1 and names the offending macro on an injected preset file", () => {
  const run = withPresetFile(presetWith("Write {{char}}'s reply. {{if not interesting}}{{/if}}"), (path) =>
    runGate(["--preset", path]),
  );
  assert.equal(run.status, 1);
  assert.match(run.stdout, /preset_macros examined 3 macros violations 2 names 3 status failed/u);
  assert.match(run.stderr, /macro_not_implemented:if /u);
});

test("the command refuses a segment it does not know", () => {
  const run = runGate(["--segment", "middle"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /preset_macros_segment_invalid:middle/u);
  assert.deepEqual(PRESET_SEGMENTS, ["before", "after", "depth"]);
});

test("the command reports an unreadable preset instead of judging nothing quietly", () => {
  const run = runGate(["--preset", join(tmpdir(), "gamebuddy-preset-that-does-not-exist.json")]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /preset_macros_preset_unreadable:/u);
});

test("the command reports the machine reading with --json", async () => {
  const run = runGate(["--json"]);
  assert.equal(run.status, 0, run.stderr);
  const reading = JSON.parse(run.stdout.trim());
  assert.equal(reading.gate, "preset-macros");
  assert.equal(reading.source, "shipped fixture");
  assert.equal(reading.status, "passed");
  assert.equal(reading.examined, (await auditPresetMacros()).examined);
});

test("the fixture is a preset the gate can read as a file too", () => {
  const run = withPresetFile(FIXTURE_PRESET, (path) => runGate(["--preset", path]));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /status passed/u);
});
