import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  comparePresetDocuments,
  FIXTURE_PRESET,
  presetRoundTripStatus,
  roundTripPreset,
  uncoveredDocumentedFields,
} from "./check-preset-round-trip.mjs";

/**
 * The gate's falsifier. `comparePresetDocuments` is the whole rule, and the two directions are measured here: a
 * flattened export must be NAMED field by field, and an untouched round trip must say nothing at all. The end-to-end
 * cases then drive the real store, because "the comparator notices a dropped key" and "a preset survives import and
 * export" are different claims and CI depends on the second.
 *
 * red-proof: inject  a store that drops `injection_depth` from every entry on write -> the gate's own entry exits 1
 *                    with `preset_round_trip_field_missing:prompts[main].injection_depth` for each of the fixture's five
 *                    in-chat entries, beside the green run's `examined 14 prompt entries` (tools/check-preset-round-trip.mjs)
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gatePath = join(repositoryRoot, "tools", "check-preset-round-trip.mjs");
const builtStore = join(repositoryRoot, "host", "dist-test", "tavern", "preset-store.js");
const REQUIRES_HOST_BUILD = existsSync(builtStore)
  ? false
  : "requires a built Host (host/dist-test); run `pnpm --dir host build:test`";

const clone = () => structuredClone(FIXTURE_PRESET);

test("a dropped field is named with its entry and its field, not as 'the documents differ'", () => {
  const flattened = clone();
  for (const entry of flattened.prompts) {
    if (Object.hasOwn(entry, "injection_depth")) delete entry.injection_depth;
  }
  const findings = comparePresetDocuments(FIXTURE_PRESET, flattened);
  const dropped = findings.filter((finding) => finding.code === "field_missing");
  assert.deepEqual(
    dropped.map((finding) => finding.path),
    [
      "prompts[main].injection_depth",
      "prompts[nsfw].injection_depth",
      "prompts[jailbreak].injection_depth",
      "prompts[my_rules_prompt].injection_depth",
      "prompts[style_reinforcement].injection_depth",
    ],
  );
  for (const finding of dropped) assert.match(finding.path, /^prompts\[.+\]\.injection_depth$/u);
});

test("a marker entry flattened into a content-only entry is named on every field it lost", () => {
  const flattened = clone();
  flattened.prompts = flattened.prompts.map((entry) =>
    entry.identifier === "chatHistory" ? { identifier: "chatHistory", content: "" } : entry,
  );
  const findings = comparePresetDocuments(FIXTURE_PRESET, flattened);
  assert.deepEqual(findings.map((finding) => `${finding.code}:${finding.path}`).sort(), [
    "field_added:prompts[chatHistory].content",
    "field_missing:prompts[chatHistory].marker",
    "field_missing:prompts[chatHistory].name",
    "field_missing:prompts[chatHistory].system_prompt",
  ]);
});

test("a changed value is named with both readings", () => {
  const changed = clone();
  const style = changed.prompts.find((entry) => entry.identifier === "style_reinforcement");
  style.injection_depth = 40;
  style.injection_trigger = ["normal"];
  const findings = comparePresetDocuments(FIXTURE_PRESET, changed);
  assert.deepEqual(
    findings.map((finding) => `${finding.code}:${finding.path}`),
    [
      "field_value_changed:prompts[style_reinforcement].injection_depth",
      "field_value_changed:prompts[style_reinforcement].injection_trigger",
    ],
  );
  assert.match(findings[0].detail, /4 -> 40/u);
});

test("a lost entry, an added entry and a reordered preset are all named", () => {
  const changed = clone();
  changed.prompts = changed.prompts.filter((entry) => entry.identifier !== "scenario");
  changed.prompts.push({ identifier: "ghost_entry", name: "Ghost" });
  const findings = comparePresetDocuments(FIXTURE_PRESET, changed);
  assert.deepEqual(
    findings.filter((finding) => finding.code.startsWith("entry_")).map((finding) => `${finding.code}:${finding.path}`),
    ["entry_missing:prompts[scenario]", "entry_added:prompts[ghost_entry]"],
  );
});

test("a reordered preset names the entries that moved", () => {
  const changed = clone();
  const [main] = changed.prompts.splice(0, 1);
  changed.prompts.splice(2, 0, main);
  const findings = comparePresetDocuments(FIXTURE_PRESET, changed);
  assert.deepEqual(
    findings.map((finding) => `${finding.code}:${finding.path}`),
    ["entry_order_changed:prompts[0]", "entry_order_changed:prompts[1]", "entry_order_changed:prompts[2]"],
  );
});

test("an untouched document produces no finding at all", () => {
  // The silence direction: a gate that always finds something is a gate nobody reads.
  assert.deepEqual(comparePresetDocuments(FIXTURE_PRESET, clone()), []);
});

test("a document key the store forgot is named", () => {
  const changed = clone();
  delete changed.prompt_order;
  delete changed.temperature;
  changed.sampler_profile = "invented";
  const findings = comparePresetDocuments(FIXTURE_PRESET, changed);
  assert.deepEqual(
    findings.map((finding) => `${finding.code}:${finding.path}`),
    [
      "document_field_missing:temperature",
      "document_field_missing:prompt_order",
      "document_field_added:sampler_profile",
    ],
  );
});

test("the verdict refuses an empty population instead of passing it", () => {
  assert.equal(presetRoundTripStatus({ entries: 0, findings: 0, uncovered: 0 }), "blocked");
  assert.equal(presetRoundTripStatus({ entries: 14, findings: 0, uncovered: 0 }), "passed");
  assert.equal(presetRoundTripStatus({ entries: 14, findings: 1, uncovered: 0 }), "failed");
  assert.equal(presetRoundTripStatus({ entries: 14, findings: 0, uncovered: 1 }), "failed");
});

test("the documented field set is covered by the fixture, so no field of A4 §2.2 goes unexamined", async (t) => {
  if (REQUIRES_HOST_BUILD !== false) {
    t.skip(REQUIRES_HOST_BUILD);
    return;
  }
  // Derived from `PRESET_PROMPT_FIELDS`, which is A4 §2.2 - so a field added to the authority that the fixture does
  // not carry is red here, rather than silently unexamined.
  const result = await roundTripPreset();
  assert.deepEqual(uncoveredDocumentedFields(result.fields, FIXTURE_PRESET), []);
  assert.deepEqual(uncoveredDocumentedFields([...result.fields, "hyphothetical_field"], FIXTURE_PRESET), [
    "hyphothetical_field",
  ]);
});

test("a real preset survives import, export and re-import through the store", async (t) => {
  if (REQUIRES_HOST_BUILD !== false) {
    t.skip(REQUIRES_HOST_BUILD);
    return;
  }
  const result = await roundTripPreset();
  assert.equal(result.measured, true);
  assert.equal(result.entries.length, FIXTURE_PRESET.prompts.length);
  for (const reading of result.readings) assert.deepEqual(reading.findings, [], reading.id);
  assert.equal(result.imported.promptCount, FIXTURE_PRESET.prompts.length);
  assert.deepEqual(result.imported.markerIdentifiers, [
    "dialogueExamples",
    "chatHistory",
    "worldInfoAfter",
    "worldInfoBefore",
    "charDescription",
    "charPersonality",
    "scenario",
    "personaDescription",
  ]);
  assert.deepEqual(result.imported.depthInjectionIdentifiers, ["style_reinforcement"]);
});

test("the gate's own entry prints a passed report and exits 0", async (t) => {
  if (REQUIRES_HOST_BUILD !== false) {
    t.skip(REQUIRES_HOST_BUILD);
    return;
  }
  const { stdout } = await promisify(execFile)(process.execPath, [gatePath], { cwd: repositoryRoot });
  assert.match(stdout, /examined 14 prompt entries/u);
  const report = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .at(-1);
  assert.ok(report, stdout);
  const parsed = JSON.parse(report);
  assert.equal(parsed.gate, "preset_round_trip");
  assert.equal(parsed.status, "passed");
  assert.equal(parsed.examined, 14);
  assert.ok(parsed.checks.length >= 5, report);
});
