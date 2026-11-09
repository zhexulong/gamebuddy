import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PRESET_MACROS } from "../host/src/tavern/preset-macros.ts";
import {
  auditPreset,
  auditPresetMacros,
  auditPresetSegments,
  FIXTURE_PRESET,
  PRESET_SEGMENTS,
  presetStrings,
  presetStringsByOwner,
} from "./check-preset-macros.mjs";

/**
 * red-proof: inject  the `macro_unknown` branch replaced by `continue` (an unknown name silently skipped) ->
 *                    `a macro absent from the table is reported as unknown, not as unimplemented` failed with
 *                    `actual: 'passed', expected: 'failed'`, and `a repeated violation is reported once` failed
 *                    with `actual: [], expected: [ 'macro_unknown:mystery' ]`. Restored, green.
 *
 * Also seen red once: the `tokens.length === 0` block removed -> `a preset with no macro is blocked, never
 * passed` failed with `actual: 'passed', expected: 'blocked'`.
 *
 * Segment red-proof: inject  a `{{time}}` entry placed BEFORE the `chatHistory` cut in a `--preset` file ->
 *                    the gate printed `preset_segments mode derived examined 1 occurrences tail_only 1
 *                    unplaced 0 placements before=1 after=1 depth=0 cut=1 disabled=0 unplaced=0 violations 1
 *                    status failed`, stderr `macro_segment_violation:time:before`, exit 1; the same entry moved
 *                    after the cut -> `violations 0 status passed`, and as a depth entry -> `placements
 *                    before=1 after=0 depth=1 ... violations 0 status passed`.
 *
 * Family red-proof: the reading's `name` taken from `token.name` instead of the resolved entry -> `a shorthand is
 * judged by the family that declares it` failed with `actual: [ '.mood', '.mood = calm' ], expected: [ '.varName',
 * '.varName = value' ]`, and `the global shorthand fails the run under its family name` failed with `actual:
 * 'passed', expected: 'failed'`; restored, green. `$varName` declared `implemented: true` -> the same global test
 * reported status `passed`; restored, green.
 */

const GATE = fileURLToPath(new URL("./check-preset-macros.mjs", import.meta.url));
const IMPLEMENTED = new Set(PRESET_MACROS.filter((entry) => entry.implemented).map((entry) => entry.name));
const TAIL_ONLY = PRESET_MACROS.filter((entry) => entry.segmentPolicy === "tail-only").map((entry) => entry.name);

/** A preset shaped like the real thing, carrying whatever `content` the case is about. */
function presetWith(...content) {
  return {
    name: "case preset",
    prompts: content.map((entry, index) => ({ identifier: `entry-${index}`, content: entry })),
  };
}

/**
 * A WHOLE preset: each entry placed by the document's own order, so the segment judgement has a document whose
 * placements it can derive. `disabled` rows come last and are switched off in the order, which is what a real
 * preset does instead of deleting the entry.
 */
function placedPreset({ before = [], after = [], depth = [], disabled = [] }) {
  const groups = [
    { segment: "before", contents: before, enabled: true },
    { segment: "cut", contents: [null], enabled: true },
    { segment: "after", contents: after, enabled: true },
    { segment: "depth", contents: depth, enabled: true },
    { segment: "disabled", contents: disabled, enabled: false },
  ];
  const prompts = [];
  const order = [];
  for (const group of groups) {
    if (group.segment === "cut") {
      prompts.push({ identifier: "chatHistory", marker: true, content: "" });
      order.push({ identifier: "chatHistory", enabled: true });
      continue;
    }
    group.contents.forEach((content, index) => {
      const identifier = `${group.segment}-${index}`;
      prompts.push(
        group.segment === "depth"
          ? { identifier, content, injection_position: 1, injection_depth: 1, injection_order: 100 }
          : { identifier, content },
      );
      order.push({ identifier, enabled: group.enabled });
    });
  }
  return { name: "placed preset", prompts, prompt_order: [{ character_id: 100000, order }] };
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

test("the shipped fixture is a whole preset, so the shipping run derives placements instead of skipping them", async () => {
  const segments = await auditPresetSegments();
  assert.equal(segments.mode, "derived");
  assert.equal(segments.status, "passed", JSON.stringify(segments.violations));
  assert.ok(segments.examined > 0, "the fixture's placed entries must spell macros, or the judgement judged nothing");
  assert.ok(segments.placements.before > 0 && segments.placements.after > 0, "the fixture spans the cut");
  assert.equal(segments.placements.cut, 1);
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

test("the segment scan attributes every string to an owner, and covers exactly the macro scan's population", () => {
  const owned = presetStringsByOwner(FIXTURE_PRESET).map((entry) => entry.text);
  assert.deepEqual(owned, presetStrings(FIXTURE_PRESET));
  const owners = presetStringsByOwner({ prompts: [{ identifier: "entry-0", content: "{{char}}" }] }).filter(
    (entry) => entry.text === "{{char}}",
  );
  assert.deepEqual(owners, [{ owner: "entry-0", text: "{{char}}" }]);
  assert.deepEqual(presetStringsByOwner({ name: "{{char}}" }), [{ owner: "name", text: "{{char}}" }]);
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

test("every entry's segment policy is one this gate branches on", () => {
  for (const entry of PRESET_MACROS)
    assert.ok(
      ["any", "tail-only"].includes(entry.segmentPolicy),
      `${entry.name} declares segmentPolicy ${JSON.stringify(entry.segmentPolicy)}`,
    );
  assert.ok(TAIL_ONLY.length > 0, "the table must declare tail-only entries, or the policy has no population");
});

/**
 * The population of the policy is the table, and this test is derived from it rather than from a remembered
 * list: every entry the table declares `tail-only` must be refused in `before`, and every other entry must not.
 * An entry added to `PRESET_MACROS` tomorrow is judged by this line the moment it exists.
 */
test("the policy population is derived from PRESET_MACROS, and only its tail-only members are refused before", async () => {
  const spelled = PRESET_MACROS.map((entry) => `{{${entry.name}}}`).join(" ");
  const before = await auditPresetSegments({ preset: placedPreset({ before: [spelled] }) });
  const after = await auditPresetSegments({ preset: placedPreset({ after: [spelled] }) });

  assert.equal(before.examined, PRESET_MACROS.length, "every table name is one token in the population");
  assert.equal(before.tailOnly, TAIL_ONLY.length);
  assert.deepEqual(codes(before).sort(), TAIL_ONLY.map((name) => `macro_segment_violation:${name}:before`).sort());
  assert.deepEqual(codes(after), [], "the same macros after the cut violate nothing");
  assert.equal(after.examined, PRESET_MACROS.length);
});

test("a tail-only macro is refused in the stable prefix and allowed in the tail and at a depth", async () => {
  const before = await auditPresetSegments({ preset: placedPreset({ before: ["It is {{time}} here."] }) });
  assert.equal(before.status, "failed");
  assert.deepEqual(codes(before), ["macro_segment_violation:time:before"]);

  for (const segment of ["after", "depth"]) {
    const allowed = await auditPresetSegments({ preset: placedPreset({ [segment]: ["It is {{time}} here."] }) });
    assert.equal(allowed.status, "passed", JSON.stringify(allowed.violations));
    assert.deepEqual(codes(allowed), []);
    assert.equal(allowed.examined, 1);
    assert.equal(allowed.placements[segment], 1);
  }
});

test("a tail-only macro in a switched-off entry or in a top-level field lands in no judged segment", async () => {
  const preset = placedPreset({ before: ["Speak as {{char}}."], disabled: ["It is {{time}}."] });
  preset.name = "{{time}}";
  const audit = await auditPresetSegments({ preset });

  assert.deepEqual(codes(audit), []);
  assert.equal(audit.placements.disabled, 1);
  assert.equal(audit.unplaced, 1, "the top-level `name` field reaches no segment");
  assert.equal(audit.examined, 2, "the enabled entry and the switched-off one both landed in a segment");
  assert.equal(audit.tailOnly, 1, "the switched-off entry's macro was seen, and it violated nothing");
});

test("the declared segment is the whole file's segment, for a file that is one entry", async () => {
  const preset = presetWith("It is {{time}} now.");
  const before = await auditPresetSegments({ preset, segment: "before" });
  assert.equal(before.mode, "declared");
  assert.deepEqual(codes(before), ["macro_segment_violation:time:before"]);
  for (const segment of ["after", "depth"]) {
    const allowed = await auditPresetSegments({ preset, segment });
    assert.equal(allowed.mode, "declared");
    assert.deepEqual(codes(allowed), []);
  }
});

test("a document that declares no placement is not applicable, never a green segment judgement", async () => {
  const audit = await auditPresetSegments({ preset: presetWith("It is {{time}} now.") });
  assert.equal(audit.status, "not_applicable");
  assert.equal(audit.mode, "not_applicable");
  assert.equal(audit.examined, 0);
  assert.match(audit.reason, /preset_segments_order_missing/u);
});

test("a table with no tail-only entry blocks the policy judgement instead of passing it", async () => {
  const table = PRESET_MACROS.filter((entry) => entry.segmentPolicy !== "tail-only");
  const audit = await auditPresetSegments({ preset: placedPreset({ before: ["It is {{time}} here."] }), table });
  assert.equal(audit.status, "blocked");
  assert.equal(audit.blocked.code, "preset_segment_policy_population_empty");
});

test("a placed population with no macro blocks, and a cut-less order blocks", async () => {
  const none = await auditPresetSegments({ preset: placedPreset({ before: ["plain words"] }) });
  assert.equal(none.status, "blocked");
  assert.equal(none.blocked.code, "preset_segments_none_found");
  assert.equal(none.placements.cut, 1);

  const uncut = {
    name: "no cut",
    prompts: [{ identifier: "main", content: "{{time}}" }],
    prompt_order: [{ character_id: 100000, order: [{ identifier: "main", enabled: true }] }],
  };
  const audit = await auditPresetSegments({ preset: uncut });
  assert.equal(audit.status, "blocked");
  assert.equal(audit.blocked.code, "preset_segments_cut_point_missing");
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

test("both judgements are reported together, and a segment violation fails the run", async () => {
  const audit = await auditPreset({ preset: placedPreset({ before: ["It is {{time}}."] }) });
  assert.equal(audit.status, "failed");
  assert.equal(audit.macroStatus, "failed");
  assert.equal(audit.segments.status, "failed");
  assert.deepEqual(codes(audit).sort(), ["macro_not_implemented:time", "macro_segment_violation:time:before"]);
});

test("the command exits 0 and prints the examined count on the shipped fixture", () => {
  const run = runGate([]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /preset_macros examined \d+ macros violations 0 names \d+ status passed/u);
  assert.match(run.stdout, /preset_segments mode derived examined \d+ occurrences tail_only 0 .*status passed/u);
});

test("the command exits 1 and names the offending macro on an injected preset file", () => {
  const run = withPresetFile(presetWith("Write {{char}}'s reply. {{if not interesting}}{{/if}}"), (path) =>
    runGate(["--preset", path]),
  );
  assert.equal(run.status, 1);
  assert.match(run.stdout, /preset_macros examined 3 macros violations 2 names 3 status failed/u);
  assert.match(run.stderr, /macro_not_implemented:if /u);
});

test("the command reports a tail-only macro that reaches the stable prefix, and only then", () => {
  const reaching = withPresetFile(placedPreset({ before: ["It is {{time}}."] }), (path) => runGate(["--preset", path]));
  assert.equal(reaching.status, 1);
  assert.match(reaching.stderr, /macro_segment_violation:time:before /u);
  assert.match(reaching.stdout, /placements before=1 after=0 depth=0 cut=1 disabled=0 unplaced=0 violations 1/u);

  const staying = withPresetFile(placedPreset({ depth: ["It is {{time}}."] }), (path) => runGate(["--preset", path]));
  assert.match(staying.stdout, /placements before=0 after=0 depth=1 cut=1 disabled=0 unplaced=0 violations 0/u);
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
  assert.equal(reading.segments.mode, "derived");
  assert.deepEqual(
    reading.checks.map((check) => check.id),
    [
      "population_is_non_empty",
      "declared_table_covers_every_macro_in_the_preset",
      "segment_policy_population_is_non_empty",
      "every_tail_only_macro_stays_out_of_the_stable_prefix",
    ],
  );
  assert.ok(reading.checks.every((check) => check.status === "passed"));
});

test("the fixture is a preset the gate can read as a file too", () => {
  const run = withPresetFile(FIXTURE_PRESET, (path) => runGate(["--preset", path]));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /status passed/u);
});
