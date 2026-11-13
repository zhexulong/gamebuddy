// Falsifier suite for the preset macro-frequency census.
//
// The census answers one design question - does a REAL SillyTavern preset reach for `{{if}}` - so the proofs that
// matter here are about the POPULATION: the shape decides who is counted, the control shows the filter is load-bearing,
// a name the table gains tomorrow is in `blocked_but_used` the moment it is declared, and an empty population blocks
// instead of printing "no preset uses `{{if}}`" over nothing.
//
// red-proof: `presetPopulation`'s shape test rewritten from `Array.isArray(parsed.prompts)` to
// `parsed.prompts !== undefined` -> `the shape is what makes a document a preset, and a decoy stays out` failed with
// `only the top-level `prompts` ARRAY is SillyTavern's preset shape: 2 !== 1` (the string-prompt decoy became a
// member). Restored, green.
//
// red-proof: `macroName`'s family lookup made to `return spelled` -> 3 of 12 failed, among them `a shorthand is keyed
// by the family entry the table declares` (the ranked table carried `.mood`/`.my-var`/`$gold` instead of `.varName` and
// `$varName`) and `every declared-unimplemented macro a preset spells is named` (`missing: ["$varName"]`, so the one
// unimplemented shorthand went unreported). Restored, green.
import assert from "node:assert/strict";
import test from "node:test";

import {
  presetMacroFrequency,
  jsonDocumentsUnder,
  macroCensus,
  macroCounts,
  formatCensus,
  familyNamesBySigil,
  presetPopulation,
  censusReading,
  verdict,
} from "./audit-preset-macro-frequency.mjs";
import { PRESET_MACROS } from "../host/src/tavern/preset-macros.ts";

const families = familyNamesBySigil(PRESET_MACROS);

const preset = (prompts, extra = {}) => ({
  path: "ref/probe/preset.json",
  document: { prompts, ...extra },
});

test("the shape is what makes a document a preset, and a decoy stays out", () => {
  const population = presetPopulation([
    { path: "a.json", text: JSON.stringify({ prompts: [{ content: "hi" }] }) },
    { path: "b.json", text: JSON.stringify({ oai_settings: { prompts: [{ content: "hi" }] } }) },
    { path: "c.json", text: JSON.stringify({ prompts: "a string is not an array" }) },
    { path: "d.json", text: "{ not json" },
  ]);
  assert.equal(population.examined, 1, "only the top-level `prompts` ARRAY is SillyTavern's preset shape");
  assert.deepEqual(
    population.presets.map((member) => member.path),
    ["a.json"],
  );
  assert.equal(population.rejected, 2, "the nested-prompt document and the string-prompt document are rejected");
  assert.equal(population.unparsed, 1);
});

test("the control removes the shape filter, so the population is the filter's doing", () => {
  const documents = [
    { path: "a.json", text: JSON.stringify({ prompts: [{ content: "hi" }] }) },
    { path: "b.json", text: JSON.stringify({ oai_settings: { prompts: [{ content: "hi" }] } }) },
  ];
  assert.equal(presetPopulation(documents).examined, 1);
  assert.equal(presetPopulation(documents, { shape: "any-json" }).examined, 2);
});

test("counting reads prompts[].content and the top-level main and jailbreak, case-insensitively", () => {
  const counts = macroCounts(
    {
      prompts: [
        { content: "{{char}} and {{CHAR}} and {{char::Rin}}" },
        { identifier: "marker", marker: true },
        { content: "{{RANDOM::a::b}}" },
      ],
      main: "{{Trim}}\ntext",
      jailbreak: "{{User}}",
    },
    families,
  );
  assert.equal(counts.get("char"), 3);
  assert.equal(counts.get("random"), 1, "a macro with arguments is still one occurrence of its name");
  assert.equal(counts.get("trim"), 1, "the top-level `main` field is counted, not only the prompt entries");
  assert.equal(counts.get("user"), 1, "the top-level `jailbreak` field is counted");
});

test("a nested macro keeps the outer name, and the {{#if}} spelling names if", () => {
  const counts = macroCounts(
    { prompts: [{ content: "{{if {{getvar::flag}}}}{{#if personality}}x{{/if}}" }] },
    families,
  );
  assert.equal(counts.get("if"), 2, "the outer conditional and its `#` spelling are both `if`");
  assert.equal(counts.get("/if"), 1);
});

test("a shorthand is keyed by the family entry the table declares", () => {
  const census = censusReading([preset([{ content: "{{.mood}} {{.my-var}} {{$gold}}" }])], { table: PRESET_MACROS });
  const shorthandFamily = PRESET_MACROS.filter((entry) => entry.family !== undefined);
  assert.equal(shorthandFamily.length, 3, "the table is the authority for which sigils are families");
  assert.deepEqual(
    census.names.map((row) => [row.name, row.occurrences]),
    [
      [".varName", 2],
      ["$varName", 1],
    ].sort((left, right) => right[1] - left[1]),
    "both `.` members collapse into the one family entry, which is the name the table carries",
  );
});

test("every declared-unimplemented macro a preset spells is named, and no implemented one is", () => {
  const unimplemented = PRESET_MACROS.filter((entry) => entry.implemented === false);
  const implemented = PRESET_MACROS.filter((entry) => entry.implemented);
  assert.ok(unimplemented.length > 0, "a table with nothing unimplemented would make this assertion vacuous");

  const spelled = [...unimplemented, ...implemented].map((entry) => {
    const body = entry.family === undefined ? entry.name : `${entry.family.sigil}probeName`;
    return `{{${body}}}`;
  });
  const census = macroCensus([preset([{ content: spelled.join(" ") }])], { table: PRESET_MACROS });

  const blocked = new Set(census.blockedButUsed.map((row) => row.name));
  const missing = unimplemented.map((entry) => entry.name).filter((name) => !blocked.has(name));
  assert.deepEqual(missing, [], "an entry added to PRESET_MACROS tomorrow is judged by this line the moment it exists");
  for (const entry of implemented) assert.ok(!blocked.has(entry.name), `${entry.name} is implemented`);
  assert.equal(census.declaredUnimplementedExamined, unimplemented.length);
});

test("the table is ranked by occurrences then name, and carries the file count", () => {
  const census = macroCensus(
    [
      preset([{ content: "{{user}} {{char}}" }]),
      { path: "ref/probe/other.json", document: { prompts: [{ content: "{{char}} {{char}}" }], main: "{{trim}}" } },
    ],
    { table: PRESET_MACROS },
  );
  assert.deepEqual(
    census.names.map((row) => `${row.name}:${row.occurrences}:${row.files}`),
    ["char:3:2", "trim:1:1", "user:1:1"],
  );
  assert.equal(census.occurrences, 5);
  assert.equal(census.examined, 2);
});

test("an empty population blocks, and says why, instead of reporting a corpus nobody read", () => {
  const lines = formatCensus(censusReading([], { table: PRESET_MACROS }));
  assert.ok(
    lines.some((line) => line.startsWith("examined 0 preset file(s), 0 macro occurrences")),
    "the machine line is printed for a zero population too",
  );
  assert.ok(lines.some((line) => line.startsWith("preset_macro_frequency_no_presets:")));
  assert.ok(lines.includes("preset_macro_frequency: blocked"));
  assert.ok(!lines.some((line) => line.startsWith("preset_macro_frequency: passed")));
  assert.equal(verdict(censusReading([], { table: PRESET_MACROS })), 2, "an empty population is a blocked exit code");
  assert.equal(
    verdict(censusReading([preset([{ content: "{{char}}" }])], { table: PRESET_MACROS })),
    0,
    "a census with a population reports rather than failing",
  );
});

test("the declared-unimplemented line states the population it found none in", () => {
  const lines = formatCensus(censusReading([preset([{ content: "{{char}}" }])], { table: PRESET_MACROS }));
  const line = lines.find((entry) => entry.startsWith("blocked_but_used:"));
  assert.equal(
    line,
    `blocked_but_used: <none> - 0 of ${PRESET_MACROS.filter((entry) => entry.implemented === false).length} ` +
      "declared-unimplemented macro(s) occur in the 1 preset file(s)",
  );
});

test("a name no table entry carries is reported rather than folded into the declared population", () => {
  const lines = formatCensus(censusReading([preset([{ content: "{{support_email}}" }])], { table: PRESET_MACROS }));
  assert.deepEqual(
    lines.filter((line) => line.startsWith("not_declared:")),
    ["not_declared: support_email 1 in 1 - no PRESET_MACROS entry carries this name"],
  );
});

test("the walk skips transient directories and reads only .json", (context) => {
  const root = "tools/fixtures";
  const documents = jsonDocumentsUnder(root);
  assert.ok(documents.length > 0, `expected fixtures under ${root}, found ${documents.length}`);
  assert.ok(documents.every((document) => document.path.toLowerCase().endsWith(".json")));
  context.diagnostic(`${documents.length} json document(s) under ${root}`);
});

test("SillyTavern's own prompt-manager preset is in the population, and its texts are the ones counted", async () => {
  const result = await presetMacroFrequency({
    roots: ["ref/external/SillyTavern/default/content/presets"],
    table: PRESET_MACROS,
  });
  assert.equal(result.examined, 1, "exactly one JSON in that directory carries a top-level `prompts` array");
  assert.equal(result.rejected > 100, true, "the context/instruct/kobold templates are not prompt-manager presets");
  assert.deepEqual(
    result.names.map((row) => row.name),
    ["char", "user"],
    "the stock preset spells only the two context macros",
  );
  assert.deepEqual(result.blockedButUsed, [], "it reaches for no declared-unimplemented macro at all");
});
