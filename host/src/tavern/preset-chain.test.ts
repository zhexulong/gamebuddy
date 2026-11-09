/**
 * The preset chain driven end to end: `preset-store` -> `preset-assembler` -> `preset-assembly-surface`.
 *
 * WHY THIS FILE EXISTS
 * Every module of that chain has its own test file and every one of them is green: the store round-trips a document,
 * the assembler assembles one, `preset-placement` predicts the buckets, the producer derives the readout, and the
 * browser renders what the producer emitted. What none of them can say is that they agree about ONE stored preset -
 * that the document `read` returns is the document the assembler resolved, and that the numbers on the player's
 * readout are the assembler's own lists rather than a second reading of the same file. That seam is this repository's
 * recurring defect family ("a field accepted, stored, and never consumed"): every unit is green while the joint
 * silently drops or invents an entry.
 *
 * WHERE EACH EXPECTATION COMES FROM
 * - the disabled list, the depth rows and the entry partition are compared against `presetEntryPlacements`, the
 *   document's own placement reading, as well as against the assembler: three readings, so an entry that moves buckets
 *   has to move in all of them;
 * - every set comparison prints its symmetric difference and every count comparison prints its difference, because
 *   "expected 3, got 2" never says WHICH entry went missing;
 * - the one legal mutation (`enabled`) is made through the store and then re-read, so what is proven is that the
 *   switch reaches the assembly, not that a freshly imported fixture happens to be shaped right.
 *
 * The fixture is a realistic chat-completion preset: markers this product supplies and markers it does not, a
 * switched-off entry, an in-chat entry at a depth, a post-history tail, an author key no SillyTavern version defines,
 * a macro the table declares unimplemented, a misspelt macro the table does not define at all, and a shorthand that
 * assigns and reads one variable in one entry.
 *
 * RED PROOF (2026-11-09: each violation injected into the COMPILED artifact under `dist-test`, then restored)
 * - producer publishes `disabledEntries: []` -> "symmetric difference missing=[\"altRegister\"] invented=[]";
 * - producer publishes `unfilledMarkers: []` -> missing=["worldInfoBefore","charPersonality","dialogueExamples"];
 * - producer publishes `depths: [0, 4]` -> "the depths must be the document's own, deepest first; surface=[0,4]
 *   document=[4,0]";
 * - producer publishes `enabled: total` -> "difference=1 (actual=15 expected=14)";
 * - assembler ignores the stored switch -> four tests fire, led by "the surface's disabled count vs the document's own
 *   switched-off order rows: difference=-1 (actual=0 expected=1)";
 * - assembler appends an invented `ghostSlot` to `unfilled` -> "the surface names \"ghostSlot\" as an unfilled slot".
 * The defect this chain found in the real tree: `preset-assembly-surface.ts` reported every RESOLVED variable
 * shorthand as `macro_unknown:.mood` / `macro_unknown:.mood = calm`, because it looked a token's literal text up in a
 * map of table entry names instead of asking `presetMacroEntryFor`. Red before that fix, green after it.
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import {
  type PresetAssemblySurfaceV1,
  type PresetSamplingRowV1,
  presetAssemblySurface,
} from "../preset-assembly-surface.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { assemblePreset, type PresetAssembly } from "./preset-assembler.js";
import { type PresetDocument, type PresetPrompt, promptEntry } from "./preset-document.js";
import { type MacroContext, PRESET_MACROS } from "./preset-macros.js";
import { presetEntryPlacements } from "./preset-placement.js";
import { createPresetStore, type PresetStore } from "./preset-store.js";

// The store writes and deletes through the Host's path lock, whose release needs the reclaimer the runtime binds.
bindWindowsStaleLockReclaimer(createBuildWindowsStaleLockReclaimer());

const PRESET_ID = "chain-fixture";

const MACROS: MacroContext = {
  char: "Mira",
  user: "the player",
  description: "Mira tends the greenhouse at the edge of Pelican Town.",
  personality: "Patient, dry, easily amused.",
  scenario: "A late-summer evening in the valley.",
  persona: "A neighbour with a spare hour.",
  itemId: "assembly",
};

/** The assembly's own slot content: two card fields and one world book. `worldInfoBefore` and the rest get none. */
const MARKERS: Readonly<Record<string, string>> = {
  charDescription: MACROS.description,
  scenario: "{{char}} and {{user}} are closing up the greenhouse for the night.",
  worldInfoAfter: "The valley's lights come on one by one.",
};

/**
 * The composed model the adapter would send: every sampler key the preset wrote, and a level that overrides `top_p`.
 *
 * Those three values are the composer's half of the chain and are deliberately not copied from the document by this
 * test: a key the preset writes and the composition drops is refused by `effectivePresetSampling` by name
 * (`preset_sampling_not_applied:<key>`), which is the seam that keeps "stored" from meaning "sent".
 */
const SAMPLING = {
  model: {
    samplingParams: { temperature: 0.8, top_p: 0.95, repetition_penalty: 1.05 },
    samplingParamsByThinkingLevel: { high: { top_p: 0.5 } },
  },
  thinkingLevel: "high",
} as const;

const PRESET = Object.freeze({
  name: "Chain fixture - depth aware",
  temperature: 0.8,
  top_p: 0.95,
  repetition_penalty: 1.05,
  x_author_note: "an unrecognised document key",
  prompts: [
    {
      identifier: "main",
      name: "Main Prompt",
      role: "system",
      enabled: true,
      content: "Write {{char}}'s next reply to {{user}}.",
    },
    { identifier: "worldInfoBefore", marker: true, role: "system", enabled: true, content: "" },
    { identifier: "charDescription", marker: true, role: "system", enabled: true, content: "" },
    { identifier: "charPersonality", marker: true, role: "system", enabled: true, content: "" },
    { identifier: "scenario", marker: true, role: "system", enabled: true, content: "" },
    { identifier: "worldInfoAfter", marker: true, role: "system", enabled: true, content: "" },
    { identifier: "dialogueExamples", marker: true, role: "system", enabled: true, content: "" },
    { identifier: "chatHistory", marker: true, role: "system", enabled: true, content: "" },
    {
      identifier: "jailbreak",
      name: "Jailbreak",
      role: "system",
      enabled: true,
      content: "Stay in {{char}}'s voice after the transcript.",
    },
    {
      identifier: "moodSetup",
      name: "Mood",
      role: "system",
      enabled: true,
      content: "{{.mood = calm}}Mood on arrival: {{.mood}}.",
    },
    {
      identifier: "spellingProbe",
      name: "Typo the author shipped",
      role: "system",
      enabled: true,
      content: "Ask {{lastusermesage}} how the evening ended.",
    },
    {
      identifier: "tailNote",
      name: "Pacing",
      role: "system",
      enabled: true,
      content: "Keep the pacing slow; one thing at a time.",
    },
    {
      identifier: "clockNote",
      name: "Clock",
      role: "system",
      enabled: true,
      content: "The scene is lit as it is at {{time}}.",
      injection_position: 1,
      injection_depth: 4,
      injection_order: 100,
    },
    {
      identifier: "styleGuard",
      name: "Style guard",
      role: "user",
      enabled: true,
      content: "No purple prose. {{random::dusk::late evening}}",
      injection_position: 1,
      injection_depth: 0,
      injection_order: 100,
    },
    {
      identifier: "altRegister",
      name: "Alternate register",
      role: "system",
      enabled: false,
      content: "A different register for this scene.",
    },
  ],
  prompt_order: [
    {
      character_id: 100000,
      order: [
        { identifier: "main", enabled: true },
        { identifier: "worldInfoBefore", enabled: true },
        { identifier: "charDescription", enabled: true },
        { identifier: "charPersonality", enabled: true },
        { identifier: "scenario", enabled: true },
        { identifier: "worldInfoAfter", enabled: true },
        { identifier: "dialogueExamples", enabled: true },
        { identifier: "chatHistory", enabled: true },
        { identifier: "jailbreak", enabled: true },
        { identifier: "moodSetup", enabled: true },
        { identifier: "spellingProbe", enabled: true },
        { identifier: "tailNote", enabled: true },
        { identifier: "clockNote", enabled: true },
        { identifier: "styleGuard", enabled: true },
        { identifier: "altRegister", enabled: false },
      ],
    },
  ],
});

/** What one stored preset reads as, through the three real functions in the order production calls them. */
type StoredChain = Readonly<{
  presetId: string;
  revision: number;
  document: PresetDocument;
  assembly: PresetAssembly;
  surface: PresetAssemblySurfaceV1;
}>;

/**
 * The chain itself: `read` the store serves -> `assemblePreset` -> `presetAssemblySurface`.
 *
 * A function rather than three lines inlined in each test, so the switched-off case below reads the SAME chain after
 * the mutation instead of a second, hand-written copy of it.
 */
async function observeStoredChain(store: PresetStore, presetId: string): Promise<StoredChain> {
  const record = await store.read(presetId);
  const assembly = assemblePreset(record.document, { macros: MACROS, markers: MARKERS });
  const surface = presetAssemblySurface({
    presetId: record.presetId,
    name: record.summary.name,
    revision: record.revision,
    document: record.document,
    macros: MACROS,
    markers: MARKERS,
    sampling: SAMPLING,
  });
  return Object.freeze({
    presetId: record.presetId,
    revision: record.revision,
    document: record.document,
    assembly,
    surface,
  });
}

async function withChain(
  work: (chain: StoredChain & Readonly<{ store: PresetStore }>) => Promise<void>,
): Promise<void> {
  const root = await canonicalTestRoot("preset-chain-");
  try {
    const store = createPresetStore({
      runtimeRoot: root,
      playerRoot: join(root, "tavern", "v1", "players", "player"),
    });
    await store.import({ presetId: PRESET_ID, document: structuredClone(PRESET) });
    await work({ store, ...(await observeStoredChain(store, PRESET_ID)) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * The sampling rows the surface reports, or a failure naming the absence.
 *
 * The fifth answer is one of two shapes - rows, or `{ unavailable }` stating why no reading exists - and this
 * chain always supplies the composed model, so an absence here is the chain losing the runtime's facts rather
 * than something to skip past.
 */
function samplingRows(surface: PresetAssemblySurfaceV1): readonly PresetSamplingRowV1[] {
  const reading = surface.sampling;
  if ("unavailable" in reading) assert.fail(`the chain lost its sampler reading: ${JSON.stringify(reading)}`);
  return reading;
}

/**
 * Set equality with the disagreement named. A symmetric difference is the only reading that tells "the producer
 * dropped an entry" apart from "the producer invented one" - and a bare `deepEqual` on two arrays says neither.
 */
function assertSameSet(label: string, actual: readonly string[], expected: readonly string[]): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((name) => !actualSet.has(name));
  const invented = [...actualSet].filter((name) => !expectedSet.has(name));
  assert.deepEqual(
    { missing, invented },
    { missing: [], invented: [] },
    `${label}: symmetric difference missing=${JSON.stringify(missing)} invented=${JSON.stringify(invented)}; actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
  );
}

/** Count equality with the difference named: "expected 12, got 9" never says which three rows vanished. */
function assertSameCount(label: string, actual: number, expected: number): void {
  assert.equal(actual, expected, `${label}: difference=${actual - expected} (actual=${actual} expected=${expected})`);
}

/** Every identifier the assembly actually sends, in assembly order: the stable prefix, the tail, then the depths. */
function sentIdentifiers(assembly: PresetAssembly): string[] {
  return [...assembly.before, ...assembly.after, ...assembly.depth].map((segment) => segment.identifier);
}

function segmentOf(assembly: PresetAssembly, identifier: string) {
  const segment = [...assembly.before, ...assembly.after, ...assembly.depth].find(
    (entry) => entry.identifier === identifier,
  );
  assert.ok(
    segment !== undefined,
    `"${identifier}" reached no segment; sent=${JSON.stringify(sentIdentifiers(assembly))}`,
  );
  return segment;
}

function requiredPrompt(document: PresetDocument, identifier: string): PresetPrompt {
  const entry = promptEntry(document, identifier);
  assert.ok(entry !== undefined, `the document carries no entry "${identifier}"`);
  return entry;
}

/** One in-chat row's authored depth, read from the document rather than assumed. */
function depthOf(entry: PresetPrompt): number {
  const depth = entry.injection_depth;
  if (typeof depth !== "number")
    assert.fail(
      `the document's in-chat row "${entry.identifier}" carries no numeric injection_depth: ${String(depth)}`,
    );
  return depth;
}

test("the surface's entry counts partition the stored document, and its label is the store's own", async () => {
  await withChain(async ({ presetId, revision, document, surface }) => {
    assert.equal(surface.presetId, presetId);
    assert.equal(surface.revision, revision);
    assert.equal(surface.name, document.name, "the surface must be labelled with the name the store derived");

    const placements = presetEntryPlacements(document);
    assertSameSet(
      "every prompt in the document appears in the order that assembles it",
      placements.map((placement) => placement.identifier),
      document.prompts.map((entry) => entry.identifier),
    );
    assertSameCount(
      "the order rows vs the document's own prompt count (equal lengths beside set equality means each prompt once)",
      placements.length,
      document.prompts.length,
    );

    assertSameCount(
      "the surface's entry total vs the document's own prompt count",
      surface.entries.total,
      document.prompts.length,
    );
    assertSameCount(
      "the surface's disabled count vs the document's own switched-off order rows",
      surface.entries.disabled,
      placements.filter((placement) => placement.segment === "disabled").length,
    );
    assertSameCount(
      "the surface's enabled count vs the document's own switched-on order rows",
      surface.entries.enabled,
      placements.filter((placement) => placement.segment !== "disabled" && placement.segment !== "unplaced").length,
    );
    assertSameCount(
      "the surface's total vs its own enabled + disabled",
      surface.entries.total,
      surface.entries.enabled + surface.entries.disabled,
    );
  });
});

test("the surface's disabled entries are the assembler's, as a set", async () => {
  await withChain(async ({ document, assembly, surface }) => {
    assert.ok(
      assembly.disabled.length > 0,
      "the fixture must carry a switched-off entry, or this test measures nothing",
    );

    assertSameSet(
      "the surface's disabled list vs the assembler's disabled list",
      surface.disabledEntries,
      assembly.disabled,
    );
    assertSameSet(
      "the assembler's disabled list vs the document's own switched-off order rows",
      assembly.disabled,
      presetEntryPlacements(document)
        .filter((placement) => placement.segment === "disabled")
        .map((placement) => placement.identifier),
    );
    for (const identifier of surface.disabledEntries) {
      assert.equal(
        sentIdentifiers(assembly).includes(identifier),
        false,
        `"${identifier}" is reported as switched off and also reached a segment`,
      );
      assert.equal(
        assembly.unfilled.includes(identifier),
        false,
        `"${identifier}" is switched off, not a slot with no source`,
      );
    }
  });
});

test("every name in the surface's unfilled markers is the assembler's, and each is a slot the document declares", async () => {
  await withChain(async ({ document, assembly, surface }) => {
    assert.ok(assembly.unfilled.length > 0, "the fixture must leave a slot unfilled, or this test measures nothing");

    assertSameSet(
      "the surface's unfilled markers vs the assembler's unfilled list",
      surface.unfilledMarkers,
      assembly.unfilled,
    );

    const markerIdentifiers = document.prompts
      .filter((entry) => entry.marker === true)
      .map((entry) => entry.identifier);
    for (const identifier of surface.unfilledMarkers)
      assert.ok(
        markerIdentifiers.includes(identifier),
        `the surface names "${identifier}" as an unfilled slot; the document's marker entries are ${JSON.stringify(markerIdentifiers)}`,
      );
    for (const identifier of assembly.unfilled)
      assert.equal(
        sentIdentifiers(assembly).includes(identifier),
        false,
        `"${identifier}" is named as unfilled and also reached a segment`,
      );
  });
});

test("the depth count and the depths themselves are the document's own in-chat rows", async () => {
  await withChain(async ({ document, assembly, surface }) => {
    const inChat = document.prompts.filter((entry) => entry.injection_position === 1);
    assert.ok(inChat.length > 0, "the fixture must carry an in-chat row, or this test measures nothing");
    const documentDepths = inChat.map(depthOf).sort((left, right) => right - left);

    assertSameCount(
      "the surface's depth block count vs the document's own in-chat rows",
      surface.depth.count,
      inChat.length,
    );
    assertSameSet(
      "the surface's depth blocks vs the document's own in-chat rows",
      surface.depth.blocks.map((block) => block.identifier),
      inChat.map((entry) => entry.identifier),
    );
    assert.deepEqual(
      surface.depth.depths,
      [...new Set(documentDepths)],
      `the depths must be the document's own, deepest first; surface=${JSON.stringify(surface.depth.depths)} document=${JSON.stringify(documentDepths)}`,
    );
    for (const block of surface.depth.blocks)
      assert.equal(
        block.depth,
        depthOf(requiredPrompt(document, block.identifier)),
        `the surface reports depth ${block.depth} for "${block.identifier}"; the document wrote another one`,
      );
    assert.deepEqual(
      surface.depth.blocks,
      assembly.depth.map((block) => ({ identifier: block.identifier, depth: block.depth })),
      "the surface's blocks must be the assembler's depth segments, in the assembler's own insertion order",
    );
  });
});

test("an entry whose macro the table declares unimplemented is named with that declaration's code", async () => {
  await withChain(async ({ surface }) => {
    const declared = PRESET_MACROS.find((entry) => entry.name === "time");
    assert.ok(
      declared !== undefined,
      'the macro table no longer declares "time", so the fixture spells a name it lost',
    );
    assert.equal(
      declared.implemented,
      false,
      `the table now implements "${declared.name}", so it is no longer a finding`,
    );

    const finding = surface.macros.find((row) => row.name === declared.name);
    assert.ok(
      finding !== undefined,
      `the surface reports no finding for "${declared.name}": ${JSON.stringify(surface.macros)}`,
    );
    assert.equal(finding.code, `macro_not_implemented:${declared.name}`);
    assert.deepEqual(finding.entries, ["clockNote"], "the finding must name the entry that spells the macro");
    for (const row of surface.macros)
      assert.equal(
        PRESET_MACROS.some((entry) => entry.name === row.name && entry.implemented),
        false,
        `the surface reports implemented macro "${row.name}" as one the player cannot rely on`,
      );
  });
});

test("the assignment half and the read half of the variable table are one table, inside the assembly", async () => {
  await withChain(async ({ document, assembly, surface }) => {
    const authored = requiredPrompt(document, "moodSetup").content;
    assert.equal(typeof authored, "string");
    assert.ok(
      (authored as string).includes("{{.mood = calm}}"),
      "the stored document must still spell the shorthand: the store preserves it verbatim",
    );

    const segment = segmentOf(assembly, "moodSetup");
    assert.equal(segment.text, "Mood on arrival: calm.");
    assert.equal(segment.text.includes("{{"), false, "an unresolved shorthand would leave its own braces in the text");
    assert.deepEqual(segment.unresolved, []);
    assert.deepEqual(
      surface.macros.filter((row) => row.name.includes("mood")),
      [],
      `the assembly resolved the shorthand, so the surface may not report it as one the player cannot rely on; findings=${JSON.stringify(surface.macros)}`,
    );
  });
});

test("a spelling no authority defines is still reported as unknown, with its code", async () => {
  await withChain(async ({ surface }) => {
    const typo = "lastusermesage";
    assert.equal(
      PRESET_MACROS.some((entry) => entry.name === typo),
      false,
      `the macro table now defines "${typo}", so the fixture no longer spells an undeclared name`,
    );

    const finding = surface.macros.find((row) => row.name === typo);
    assert.ok(
      finding !== undefined,
      `the surface reports no finding for the undeclared spelling "${typo}": ${JSON.stringify(surface.macros)}`,
    );
    assert.equal(finding.code, `macro_unknown:${typo}`);
    assert.deepEqual(finding.entries, ["spellingProbe"]);
  });
});

test("switching an entry off through the store moves it into disabled, on the assembler and the surface alike", async () => {
  await withChain(async ({ store, revision, assembly, surface }) => {
    assert.ok(
      assembly.after.some((segment) => segment.identifier === "tailNote"),
      `the fixture's tail must be sent before the switch; after=${JSON.stringify(assembly.after.map((segment) => segment.identifier))}`,
    );
    assert.equal(surface.disabledEntries.includes("tailNote"), false);
    const disabledBefore = surface.entries.disabled;

    const switchedOff = await store.setEnabled(PRESET_ID, "tailNote", false);
    assertSameCount(
      "the revision after the one legal mutation vs the stored revision + 1",
      switchedOff.revision,
      revision + 1,
    );

    const off = await observeStoredChain(store, PRESET_ID);
    assertSameSet("the assembler's disabled list after the switch", off.assembly.disabled, [
      ...assembly.disabled,
      "tailNote",
    ]);
    assertSameSet("the surface's disabled list after the switch", off.surface.disabledEntries, off.assembly.disabled);
    assertSameCount(
      "the surface's disabled count after the switch vs before",
      off.surface.entries.disabled,
      disabledBefore + 1,
    );
    assert.equal(off.surface.revision, switchedOff.revision);
    assert.equal(
      sentIdentifiers(off.assembly).includes("tailNote"),
      false,
      "a switched-off entry must reach no segment after the switch",
    );
    assert.equal(off.assembly.unfilled.includes("tailNote"), false, "it is switched off, not a slot with no source");

    // And back: the seam reads the stored document again, it does not latch the first reading it saw.
    await store.setEnabled(PRESET_ID, "tailNote", true);
    const on = await observeStoredChain(store, PRESET_ID);
    assertSameSet("the assembler's disabled list after switching it back on", on.assembly.disabled, assembly.disabled);
    assert.ok(on.assembly.after.some((segment) => segment.identifier === "tailNote"));
    assertSameCount(
      "the surface's disabled count after switching it back on",
      on.surface.entries.disabled,
      disabledBefore,
    );
  });
});

test("nothing the assembler skipped is silently dropped: every switched-on row is sent or named", async () => {
  await withChain(async ({ document, assembly, surface }) => {
    const placements = presetEntryPlacements(document);
    const switchedOn = placements
      .filter(
        (placement) => placement.segment === "before" || placement.segment === "after" || placement.segment === "depth",
      )
      .map((placement) => placement.identifier);
    const sent = sentIdentifiers(assembly);

    assertSameSet(
      "the rows the assembler sent or named vs the rows the document switches on",
      [...sent, ...assembly.unfilled],
      switchedOn,
    );
    assertSameCount(
      "the assembler's whole account (sent + named unfilled + disabled + the cut row) vs the order it read",
      sent.length +
        assembly.unfilled.length +
        assembly.disabled.length +
        placements.filter((placement) => placement.segment === "cut").length,
      placements.length,
    );
    assertSameCount(
      "the surface's depth blocks vs the assembler's depth segments",
      surface.depth.blocks.length,
      assembly.depth.length,
    );
  });
});

test("every sampler key the preset wrote reaches the surface's reading of what the runtime will send", async () => {
  await withChain(async ({ document, surface }) => {
    const rows = samplingRows(surface);
    const temperature = rows.find((row) => row.key === "temperature");
    assert.ok(temperature !== undefined, `the reading carries no temperature row: ${JSON.stringify(surface.sampling)}`);
    assert.equal(temperature.source, "preset");
    assert.equal(
      temperature.value,
      document.temperature,
      "the value the preset wrote must be the value the reading reports the runtime sending",
    );

    const topP = rows.find((row) => row.key === "top_p");
    assert.ok(topP !== undefined);
    assert.equal(topP.source, "thinking-level", "the level overrode top_p, so the preset's value is not what is sent");
    assert.notEqual(topP.value, document.top_p);
  });
});
