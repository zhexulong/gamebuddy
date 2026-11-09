import assert from "node:assert/strict";
import test from "node:test";
import {
  type PresetAssemblySurfaceV1,
  type PresetSamplingRowV1,
  presetAssemblySurface,
} from "./preset-assembly-surface.js";
import { assemblePreset } from "./tavern/preset-assembler.js";
import type { MacroContext } from "./tavern/preset-macros.js";
import { PRESET_SAMPLING_KEYS } from "./tavern/preset-sampling.js";

/**
 * The producer behind the read-only preset surface, held to the four facts plus the sampling reading it publishes.
 *
 * WHY HERE AND NOT ONLY IN THE JOURNEY
 * `dialogue-web/tests/preset-assembly-surface.spec.ts` mounts the panel with this function's REAL output, which is
 * the right place to prove that the browser's mirror renders what the Host derives. What it cannot prove is that
 * the derivation itself is right at its own boundaries - a filled marker that leaks into `unfilledMarkers`, a
 * switched-off entry whose text still reaches a segment, a depth that arrives as zero, a sampling row that reports
 * the preset's written value instead of the one in force. Those are facts about THIS function, and they belong in
 * a test that runs with no browser.
 *
 * WHAT THIS FILE DOES NOT DO
 * The refusal of a body that contradicts itself lives in the browser's own validator
 * (`dialogue-web/src/preset-assembly-surface.ts` `validatePresetAssemblyRead`), and the Host may not import it -
 * `host/tsconfig.json` emits from `host/src` only, and the browser bundle is not a Host dependency. So the refusal
 * is proven where the validator is (`preset-assembly-surface.spec.ts`, "a readout that contradicts itself is
 * refused instead of shown") and this file checks the other half: the producer DERIVES those cross-field facts from
 * one source, so it cannot emit a body that says the same thing twice and disagrees with itself.
 *
 * red-proof: inject  `entries.enabled` published as `total` instead of `total - disabled` (a body that says
 *                    `total` and `enabled + disabled` disagree) -> `the body does not contradict itself, on every
 *                    count the browser's validator compares` failed with `actual: 10, expected: 11`; restored,
 *                    green.
 */

const MACROS: MacroContext = {
  char: "Mira",
  user: "the player",
  description: "Mira tends the greenhouse at the edge of Pelican Town.",
  personality: "Patient, dry, easily amused.",
  scenario: "A late-summer evening in the valley.",
  persona: "A neighbour with a spare hour.",
  itemId: "assembly",
};

/**
 * A realistic chat-completion preset: markers this product supplies, an authored post-history tail, two depth
 * blocks, one entry switched off in the order rather than deleted, and one typo the author shipped.
 */
const PRESET_DOCUMENT = {
  name: "Chat completion - depth aware",
  temperature: 0.7,
  top_p: 1,
  prompts: [
    {
      identifier: "main",
      name: "Main Prompt",
      enabled: true,
      role: "system",
      content: "Write {{char}}'s next reply in this scene. {{char}} never speaks for {{user}}.",
    },
    {
      identifier: "worldInfoBefore",
      name: "World Info (before)",
      marker: true,
      enabled: true,
      role: "system",
      content: "",
    },
    {
      identifier: "charDescription",
      name: "Character Description",
      marker: true,
      enabled: true,
      role: "system",
      content: "",
    },
    { identifier: "scenario", name: "Scenario", marker: true, enabled: true, role: "system", content: "" },
    { identifier: "chatHistory", name: "Chat History", marker: true, enabled: true, role: "system", content: "" },
    {
      identifier: "jailbreak",
      name: "Jailbreak",
      enabled: true,
      role: "system",
      content: "Stay in {{char}}'s voice after the transcript.",
    },
    {
      identifier: "directorNote",
      name: "Director note",
      enabled: true,
      role: "system",
      content: "Keep the pacing slow. {{random::dusk::evening}}",
      injection_position: 1,
      injection_depth: 4,
      injection_order: 100,
    },
    {
      identifier: "styleGuard",
      name: "Style guard",
      enabled: true,
      role: "system",
      content: "No purple prose.",
      injection_position: 1,
      injection_depth: 0,
      injection_order: 100,
    },
    {
      identifier: "nsfwPrompt",
      name: "Alternate tone",
      enabled: false,
      role: "system",
      content: "{{if {{getvar::allowed}}}}A different register for this scene.{{/if}}",
    },
    {
      identifier: "spellingProbe",
      name: "Typo the author shipped",
      enabled: true,
      role: "system",
      content: "Call {{characteristic}} by name.",
    },
  ],
  prompt_order: [
    {
      character_id: 100000,
      order: [
        { identifier: "main", enabled: true },
        { identifier: "worldInfoBefore", enabled: true },
        { identifier: "charDescription", enabled: true },
        { identifier: "scenario", enabled: true },
        { identifier: "chatHistory", enabled: true },
        { identifier: "jailbreak", enabled: true },
        { identifier: "directorNote", enabled: true },
        { identifier: "styleGuard", enabled: true },
        { identifier: "nsfwPrompt", enabled: false },
        { identifier: "spellingProbe", enabled: true },
      ],
    },
  ],
};

/** The assembly's own sources: the two card fields a Chat always supplies, and no world book. */
const MARKERS: Readonly<Record<string, string>> = {
  charDescription: MACROS.description,
  scenario: MACROS.scenario,
};

/** The composed model the adapter would send: the preset's own values, plus a level that overrides `top_p`. */
const SAMPLING = {
  model: { samplingParams: { temperature: 0.7, top_p: 1 }, samplingParamsByThinkingLevel: { high: { top_p: 0.5 } } },
  thinkingLevel: "high",
} as const;

function surfaceOf(
  overrides: Partial<Readonly<{ document: unknown; markers: Readonly<Record<string, string>> }>> = {},
  sampling: Readonly<{ model: unknown; thinkingLevel: string }> = SAMPLING,
): PresetAssemblySurfaceV1 {
  return presetAssemblySurface({
    presetId: "chat-completion-depth-aware",
    name: "Chat completion - depth aware",
    revision: 3,
    document: overrides.document ?? PRESET_DOCUMENT,
    macros: MACROS,
    markers: overrides.markers ?? MARKERS,
    sampling: sampling as Readonly<{ model: never; thinkingLevel: string }>,
  });
}

/**
 * The sampling rows the surface reports, or a failure naming the absence.
 *
 * The fifth answer is one of two shapes: rows, or `{ unavailable }` stating why no reading exists. A
 * fixture that took no reading must fail here by name rather than slip through as an empty list.
 */
function samplingRows(surface: PresetAssemblySurfaceV1): readonly PresetSamplingRowV1[] {
  const reading = surface.sampling;
  if ("unavailable" in reading) assert.fail(`the surface reports no sampler reading: ${JSON.stringify(reading)}`);
  return reading;
}

function row(surface: PresetAssemblySurfaceV1, key: string) {
  const found = samplingRows(surface).find((entry) => entry.key === key);
  assert.ok(found !== undefined, `the reading carries no row for "${key}"`);
  return found;
}

test("a marker with a content source never appears among the unfilled ones", () => {
  const surface = surfaceOf();

  for (const marker of Object.keys(MARKERS))
    assert.equal(surface.unfilledMarkers.includes(marker), false, `"${marker}" has a source, so it is filled`);
  assert.deepEqual(surface.unfilledMarkers, ["worldInfoBefore"]);
  assert.ok(surface.entries.enabled > 0);
});

test("a switched-off entry is listed as disabled, counted, and its text reaches no segment", () => {
  const surface = surfaceOf();
  const assembly = assemblePreset(PRESET_DOCUMENT, { macros: MACROS, markers: MARKERS });

  assert.deepEqual(surface.disabledEntries, ["nsfwPrompt"]);
  assert.equal(surface.entries.disabled, 1);
  assert.equal(surface.entries.total, PRESET_DOCUMENT.prompts.length);

  // The surface carries no segment text, so "its text never appears anywhere else" is read where the text is:
  // the assembly this surface is a projection of.
  const sent = [...assembly.before, ...assembly.after, ...assembly.depth];
  assert.equal(
    sent.some((segment) => segment.identifier === "nsfwPrompt"),
    false,
    "a switched-off entry must not be assembled",
  );
  assert.equal(
    sent.some((segment) => segment.text.includes("A different register")),
    false,
    "its text must not reach the transcript by any other entry",
  );
  assert.equal(surface.unfilledMarkers.includes("nsfwPrompt"), false, "it is off, not a slot without a source");
  assert.equal(
    surface.depth.blocks.some((block) => block.identifier === "nsfwPrompt"),
    false,
  );
});

test("an unimplemented macro is reported with its code and the entries that spell it", () => {
  const surface = surfaceOf();
  const byCode = new Map(surface.macros.map((macro) => [macro.code, macro]));

  const info = byCode.get("macro_not_implemented:if");
  assert.ok(info !== undefined, JSON.stringify(surface.macros));
  assert.equal(info.name, "if");
  assert.deepEqual(info.entries, ["nsfwPrompt"]);
  assert.deepEqual(byCode.get("macro_not_implemented:/if")?.entries, ["nsfwPrompt"]);
  assert.deepEqual(byCode.get("macro_unknown:characteristic")?.entries, ["spellingProbe"]);
  assert.equal(byCode.has("macro_not_implemented:char"), false, "an implemented macro is not a finding");
  for (const macro of surface.macros) {
    assert.ok(macro.entries.length > 0, `${macro.code} names no entry, so nothing tells the player where it is`);
    assert.equal(
      macro.code,
      `${macro.code.startsWith("macro_unknown") ? "macro_unknown" : "macro_not_implemented"}:${macro.name}`,
    );
  }
});

test("a depth block's authored depth survives into the readout", () => {
  const surface = surfaceOf();

  assert.equal(surface.depth.count, 2);
  assert.deepEqual(surface.depth.blocks, [
    { identifier: "directorNote", depth: 4 },
    { identifier: "styleGuard", depth: 0 },
  ]);
  assert.deepEqual(surface.depth.depths, [4, 0]);
});

/**
 * The cross-field facts the browser's validator compares are DERIVED here from a single source, so the producer
 * cannot emit a body that states one of them twice and disagrees with itself: `total` is the document's own entry
 * count, `disabled` is the assembly's own list, `count` is the blocks beside it, and `depths` is those blocks.
 */
test("the body does not contradict itself, on every count the browser's validator compares", () => {
  const surface = surfaceOf();
  const document = PRESET_DOCUMENT;

  assert.equal(surface.entries.total, surface.entries.enabled + surface.entries.disabled);
  assert.equal(surface.entries.total, document.prompts.length);
  assert.equal(surface.disabledEntries.length, surface.entries.disabled);
  assert.equal(surface.depth.count, surface.depth.blocks.length);
  assert.deepEqual(surface.depth.depths, [...new Set(surface.depth.blocks.map((block) => block.depth))]);
  assert.equal(surface.name, document.name);
  assert.equal(surface.revision, 3);

  // And a document that contradicts itself is refused by the producer, named by the member that drifted.
  const danglingOrder = {
    ...document,
    prompt_order: [{ character_id: 100000, order: [{ identifier: "ghost", enabled: true }] }],
  };
  assert.throws(() => surfaceOf({ document: danglingOrder }), /preset_order_references_undefined_prompt:ghost/u);
});

test("a sampling row reports the layer in force, not the value the preset wrote", () => {
  const surface = surfaceOf();

  const topP = row(surface, "top_p");
  assert.deepEqual(topP, { key: "top_p", value: 0.5, source: "thinking-level" });
  assert.notEqual(topP.value, PRESET_DOCUMENT.top_p, "the level won, so the preset's own value is not the answer");
  assert.deepEqual(row(surface, "temperature"), { key: "temperature", value: 0.7, source: "preset" });
});

test("every sampling key has a row, and an unset one reads null on the wire instead of disappearing", () => {
  const surface = surfaceOf();

  assert.deepEqual(
    samplingRows(surface).map((entry) => entry.key),
    [...PRESET_SAMPLING_KEYS],
  );
  const unset = samplingRows(surface).filter((entry) => entry.source === "unset");
  assert.ok(unset.length > 0, "the fixture must leave a key unset, or the null path is untested");
  for (const entry of unset) assert.equal(entry.value, null, `${entry.key} is unset, so the value is null`);

  // The reason `null` and not `undefined`: JSON drops an undefined member, so the row would vanish and the player
  // would read "there is no such setting" instead of "nothing is sent".
  const wire = JSON.parse(JSON.stringify(samplingRows(surface))) as readonly { key: string; value: unknown }[];
  assert.deepEqual(
    wire.map((entry) => entry.key),
    [...PRESET_SAMPLING_KEYS],
  );
  for (const entry of wire) assert.ok("value" in entry, `${entry.key} lost its value member on the wire`);
  assert.deepEqual(
    wire,
    samplingRows(surface).map((entry) => ({ key: entry.key, value: entry.value, source: entry.source })),
  );
});

test("a layer that sets a key to something no request can carry is refused, never narrowed to null", () => {
  assert.throws(
    () =>
      surfaceOf(
        {},
        {
          model: {
            samplingParams: { temperature: 0.7, top_p: 1 },
            samplingParamsByThinkingLevel: { high: { top_p: "0.5" } },
          },
          thinkingLevel: "high",
        },
      ),
    /preset_sampling_not_a_number:top_p:thinking-level:0.5/u,
  );
});

test("a composed model that disagrees with what the preset wrote fails closed and names the key", () => {
  assert.throws(
    () => surfaceOf({}, { model: { samplingParams: { temperature: 0.2 } }, thinkingLevel: "high" }),
    /preset_sampling_not_applied:temperature:preset=0.7:composed=0.2/u,
  );
});

test("a preset with nothing to report says so on every count, and its sampling reading still lists every key", () => {
  const clean = presetAssemblySurface({
    presetId: "clean",
    name: "A preset with nothing to report",
    revision: 1,
    document: {
      name: "Clean",
      prompts: [
        { identifier: "main", enabled: true, role: "system", content: "Write {{char}}'s next reply." },
        { identifier: "worldInfoBefore", marker: true, enabled: true, role: "system", content: "" },
        { identifier: "chatHistory", marker: true, enabled: true, role: "system", content: "" },
      ],
      prompt_order: [
        {
          character_id: 100000,
          order: [
            { identifier: "main", enabled: true },
            { identifier: "worldInfoBefore", enabled: true },
            { identifier: "chatHistory", enabled: true },
          ],
        },
      ],
    },
    macros: MACROS,
    markers: { worldInfoBefore: "A bound world book." },
    sampling: { model: {}, thinkingLevel: "high" },
  });

  assert.deepEqual(clean.disabledEntries, []);
  assert.deepEqual(clean.unfilledMarkers, []);
  assert.deepEqual(clean.macros, []);
  assert.deepEqual(clean.depth, { count: 0, depths: [], blocks: [] });
  assert.equal(samplingRows(clean).length, PRESET_SAMPLING_KEYS.length);
  assert.ok(samplingRows(clean).every((entry) => entry.source === "unset" && entry.value === null));
});
