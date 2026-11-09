/**
 * ST-spec conformance: does a REAL SillyTavern preset assemble the way SillyTavern 1.19.0 assembles it?
 *
 * Every other preset test in this tree drives a fixture an author of this repo wrote, so it can only prove
 * that our assembler agrees with our own reading. This file drives the two real presets the repository
 * carries - SillyTavern's own shipped `default/content/presets/openai/Default.json` and the companion
 * product's `assets/tavern/presets/amber-deepseek-v4.1.json` - through the store and the assembler, and
 * every expectation is measured from the file on disk and justified by a line in the SillyTavern checkout
 * at `ref/external/SillyTavern` (read-only) or a section of
 * `design/architecture/tavern-preset-compatibility.md`.
 *
 * THE SILLYTAVERN READINGS EACH TEST NAMES (full table: `.tmp/lane-preset-conformance.md` S1-S12)
 * - order group: `openai.js:696-700` overrides the base class's `dummyId: 100000` (`PromptManager.js:336`)
 *   with `100001` for the chat-completion path, `PromptManager.js:438` copies that id into
 *   `activeCharacter` and `:1207-1209` resolves the group by it - so the group a chat-completion assembly
 *   walks is 100001, and 100000 is the legacy single group our own amber preset carries.
 * - ordering: `PromptManager.js:1516-1521` walks `getPromptOrderForCharacter(activeCharacter)`, and
 *   `:1207-1209` is `prompt_order.find(list => String(list.character_id) === String(character.id))?.order`.
 *   The `prompts[]` array order is never iterated.
 * - markers: `openai.js:1374-1386` builds the slot contents, `:1212-1218` adds each by identifier and
 *   `:1473-1493` REPLACES that index in the collection with the assembly's content; `PromptManager.js:1072-1092`
 *   keeps a marker's own content out of the author's reach.
 * - the cut: `openai.js:886-890` adds a `MessageCollection('chatHistory')` at `prompts.index('chatHistory')`
 *   and emits nothing else for it.
 * - in-chat: `PromptManager.js:37-40` (`ABSOLUTE = 1`), `openai.js:1198-1201` (absolute prompts are skipped
 *   in the relative chain), `:1248-1253` (collected separately, drag order ignored).
 * - depth placement: `openai.js:866-870` splices at `injection_depth` counted from the newest message (the
 *   array `setOpenAIMessages` returns is newest-first: `:578`, `:644`), so the consumer index is
 *   `messages.length - depth`.
 * - empty content: `openai.js:3832-3846` drops a message with no content from the request.
 * - sampler keys: design §5/§8 name the eight a preset carries; `preset-sampling.ts`'s allow-list is that
 *   eight, and its header says why a permissive spread is refused.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED HERE
 * The divergences recorded in `.tmp/lane-preset-conformance.md` §3 are of three kinds, and only the third is
 * asserted:
 *  - D2-D5 (a row with no `enabled`; the blanked `main` anchor; same `(depth, order)` message merging;
 *    depth/order defaults): ST's rule and ours differ only on documents ST's own UI cannot write, and the
 *    two real presets cannot measure either side. Neither ST's behaviour nor ours is asserted for them.
 *  - D6 (a disabled `chatHistory` row): no assertion. ST sends no transcript at all
 *    (`openai.js:886-888`); we keep the cut row present, leave `pastCut` false and place the whole tail in
 *    the prefix (`preset-assembler.ts:100-101`). That is a reported defect, and no file here reaches it.
 *  - D1 (which `character_id` group is assembled): asserted at the end of this file, because it IS
 *    reachable from the shipped Default.json and the two readings disagree about a real file. Resolved: the
 *    runtime wire (`openai.js:698`) is the authority, so the assembly reads 100001 through the ladder in
 *    `preset-placement.ts`'s `selectedPromptOrderGroup`, and the test asserts that selection, the persona slot
 *    it adds and that slot's position in the request.
 *
 * `{{if}}`: neither preset spells a conditional block (asserted below, deliberately, so the exemption
 * expires the moment an author adds one), so design §4.3's `{{if}}` ruling is out of scope for these files.
 *
 * RED PROOF (2026-11-10, one violation injected into the COMPILED artifact under `host/dist-test`, the suite
 * run, the artifact restored - nothing under `host/src` was touched; driver `.tmp/lane-t-red-proof.ps1`)
 * - prefix/tail swap, `(pastCut ? after : before)` -> `(pastCut ? before : after)`: 3 red - the ordering
 *   test, Default.json's partition and amber's partition, each naming the rows it found in the wrong list;
 * - the order row's switch ignored, `if (typeof row.enabled === "boolean")` -> `if (false && ...)`:
 *   2 red - the ordering test (`enhanceDefinitions` joins the prefix) and Default.json's partition, whose
 *   switched-off list no longer matches the file's;
 * - one sampler key dropped from the family, `"min_p",` removed from `PRESET_SAMPLING_KEYS`: 1 red -
 *   the sampler test, printed as `symmetric difference missing=["min_p"]`.
 * Each injection reddened exactly the assertions that own it and left the rest green; the restored artifact
 * ran 8/8 green again.
 *
 * RED PROOF FOR THE D1 CONTRACT (same method: one violation at a time, injected into the compiled artifact
 * under `host/dist-test`, both preset suites run, the artifact restored; driver `.tmp/lane-d1-redproof.mjs`)
 * - the ladder's rungs swapped, `firstWith(CHAT_COMPLETION...) ?? firstWith(LEGACY...)` reversed: 5 red - the
 *   D1 contract, the partition, the marker-slot property, the persona-less case and the placement suite's
 *   ladder test, each naming the group it read;
 * - `personaDescription: "slot",` removed from `PRESET_MARKERS`: 6 red - the same five plus the ordering test,
 *   because the D1 group can then no longer be assembled at all (`preset_marker_not_in_table`);
 * - the persona segment moved to the END of the prefix: 1 red - the D1 contract's `worldInfoBefore /
 *   personaDescription / charDescription` window, i.e. the ordering assertion alone owns that fact;
 * - the unresolved-marker record dropped, `pushOnce(unfilled, identifier)` -> `void 0`: 4 red - the placement
 *   suite's unfilled test, the partition, the marker-slot property and the persona-less case.
 * Every injection left the assertions it does not own green; the restored artifact ran 17/17 green.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { presetAssemblySurface } from "../preset-assembly-surface.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { assemblePreset, depthInsertionIndex, type PresetAssembly } from "./preset-assembler.js";
import { type PresetDocument, type PresetPrompt, promptEntry } from "./preset-document.js";
import type { MacroContext } from "./preset-macros.js";
import { PRESET_SAMPLING_KEYS, presetSamplingParams } from "./preset-sampling.js";
import { createPresetStore, type PresetStore } from "./preset-store.js";

// The store writes through the Host's path lock, whose release needs the reclaimer the runtime binds.
bindWindowsStaleLockReclaimer(createBuildWindowsStaleLockReclaimer());

/** The two files this suite measures. Both are read-only inputs; nothing here writes them. */
const PRESET_FILES = Object.freeze({
  /** SillyTavern 1.19.0's own shipped chat-completion default preset. */
  st: "ref/external/SillyTavern/default/content/presets/openai/Default.json",
  /** This product's authored companion preset (`assets/` is release input, not a fixture). */
  amber: "assets/tavern/presets/amber-deepseek-v4.1.json",
});

/**
 * The repository root, found by walking up from this module until both markers exist.
 *
 * `ref/` is a gitignored read-only mount, so it may be absent from an environment. When it is, the read
 * below fails by name instead of the suite passing over an empty population - a conformance suite with no
 * authority file agrees with itself.
 */
function repositoryRoot(start: string): string {
  let current = start;
  for (;;) {
    if (existsSync(join(current, "host", "package.json")) && existsSync(join(current, "assets", "tavern", "presets")))
      return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`repository_root_not_found:${start}`);
    current = parent;
  }
}

const REPOSITORY_ROOT = repositoryRoot(dirname(fileURLToPath(import.meta.url)));

/** The assembly's own facts: the companion card and the bound world book, as one Chat would supply them. */
const MACROS: MacroContext = {
  char: "琥珀",
  user: "阿远",
  description: "琥珀，24 岁，在星谷接手了祖传农场，手上总带着泥。",
  personality: "嘴硬心软，累了会直说。",
  scenario: "夏末的傍晚，两人刚收完最后一筐防风草。",
  persona: "自小一起长大的发小。",
  itemId: "st-conformance",
};

/**
 * The slot contents, i.e. what `openai.js:1374-1386` puts into the marker entries.
 *
 * `main` and `jailbreak` are deliberately NOT supplied: both real presets author their own text, so a slot
 * for either would exercise the character-card override path (A4 §3.2) instead of the preset.
 *
 * `personaDescription` is the one marker left out on purpose: it is the PLAYER's own text, and a player who
 * never wrote one is the ordinary case - see `PERSONA_DESCRIPTION`.
 */
const SLOTS: Readonly<Record<string, string>> = Object.freeze({
  worldInfoBefore: "【世界书·前置】{{char}}和{{user}}一起接手了星谷的老农场。",
  worldInfoAfter: "【世界书·后置】镇上的人都认得他们。",
  charDescription: MACROS.description,
  charPersonality: MACROS.personality,
  scenario: MACROS.scenario,
  dialogueExamples: "{{user}}：今天下雨。\n{{char}}：那就不用浇水了。",
});

/**
 * The player's own persona description - the slot ST's 100001 group adds (`PromptManager.js:306`,
 * `openai.js:1432-1435`). The default `SLOTS` leaves it empty on purpose, so every test that reads `SLOTS`
 * alone is the persona-less case of design §2.5: the slot is NAMED in `unfilled` and nothing is sent for it.
 */
const PERSONA_DESCRIPTION = "阿远是琥珀的邻居，也是星谷唯一会修水泵的人。";

/** The same assembly once the player HAS written a persona: the persona slot filled like any other. */
const SLOTS_WITH_PERSONA: Readonly<Record<string, string>> = Object.freeze({
  ...SLOTS,
  personaDescription: PERSONA_DESCRIPTION,
});

type MeasuredPreset = Readonly<{
  presetId: string;
  /** The file as parsed on disk: the authority every expectation below is measured from. */
  file: Record<string, unknown>;
  /** The same file's bytes, for the token census the `{{if}}` exemption needs. */
  text: string;
  /** What the store served after the import - the document the assembler actually saw. */
  document: PresetDocument;
}>;

type OrderRow = Readonly<{ identifier: string; enabled: unknown }>;

/**
 * Loads both real presets through the store: `import` once, `read` from then on (design §2.1's read-only
 * rule), and the assembly is driven from the document `read` returned rather than from the file.
 */
async function withRealPresets(
  work: (presets: Readonly<{ st: MeasuredPreset; amber: MeasuredPreset }>) => void,
): Promise<void> {
  const root = await canonicalTestRoot("preset-st-conformance-");
  try {
    const store = createPresetStore({
      runtimeRoot: root,
      playerRoot: join(root, "tavern", "v1", "players", "player"),
    });
    await work({
      st: await importPreset(store, "sillytavern-default", PRESET_FILES.st),
      amber: await importPreset(store, "amber-deepseek-v4.1", PRESET_FILES.amber),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function importPreset(store: PresetStore, presetId: string, relativePath: string): Promise<MeasuredPreset> {
  const path = join(REPOSITORY_ROOT, relativePath);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`preset_file_unreadable:${path}:${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`preset_file_not_an_object:${path}`);
  await store.import({ presetId, document: structuredClone(parsed) });
  const record = await store.read(presetId);
  return Object.freeze({ presetId, file: parsed, text, document: record.document });
}

/** One `prompt_order` group, by the id `PromptManager.js:1207-1209` looks up. */
function orderGroupRows(file: Record<string, unknown>, characterId: number): readonly OrderRow[] {
  const groups = Array.isArray(file.prompt_order) ? file.prompt_order : [];
  const group = groups.find((entry) => isRecord(entry) && entry.character_id === characterId);
  if (group === undefined || !isRecord(group)) throw new Error(`preset_order_group_missing:${characterId}`);
  const order = group.order;
  if (!Array.isArray(order)) throw new Error(`preset_order_group_rows_missing:${characterId}`);
  return Object.freeze(
    order.map((row, index) => {
      if (!isRecord(row) || typeof row.identifier !== "string")
        throw new Error(`preset_order_row_invalid:${characterId}:${index}`);
      return Object.freeze({ identifier: row.identifier, enabled: row.enabled });
    }),
  );
}

function hasOrderGroup(file: Record<string, unknown>, characterId: number): boolean {
  const groups = Array.isArray(file.prompt_order) ? file.prompt_order : [];
  return groups.some((entry) => isRecord(entry) && entry.character_id === characterId);
}

/**
 * The group the assembly must read, read independently of the module: ST's chat-completion id (100001) when
 * the file carries it, otherwise the legacy single group (100000).
 *
 * The two ids are spelled as literals here on purpose - they are the wire's fact (`openai.js:698`,
 * `PromptManager.js:336`), so a drift in the module's own constant has to fail here rather than move with it.
 * The ladder itself - including its third rung and the fact that document order does not decide it - is
 * asserted in the D1 test at the end of this file.
 */
function assembledOrderRows(file: Record<string, unknown>): readonly OrderRow[] {
  return hasOrderGroup(file, 100001) ? orderGroupRows(file, 100001) : orderGroupRows(file, 100000);
}

function requirePrompt(document: PresetDocument, identifier: string): PresetPrompt {
  const entry = promptEntry(document, identifier);
  assert.ok(entry !== undefined, `the file carries no prompt entry "${identifier}"`);
  return entry;
}

/** Every identifier the assembly sends, in the order the consumer receives it. */
function sentIdentifiers(assembly: PresetAssembly): string[] {
  return [...assembly.before, ...assembly.after, ...assembly.depth].map((segment) => segment.identifier);
}

function segmentText(assembly: PresetAssembly, identifier: string): string {
  const segment = [...assembly.before, ...assembly.after, ...assembly.depth].find(
    (entry) => entry.identifier === identifier,
  );
  assert.ok(
    segment !== undefined,
    `"${identifier}" reached no segment; sent=${JSON.stringify(sentIdentifiers(assembly))}`,
  );
  return segment.text;
}

/**
 * The test's own substitution for the only two macros either file spells, used as a CROSS-CHECK against the
 * evaluator: a second method answering the same question, so "the macro rendered" is not measured by asking
 * the thing that rendered it.
 */
function substituteNames(text: string): string {
  return text.replace(/\{\{char\}\}/giu, MACROS.char).replace(/\{\{user\}\}/giu, MACROS.user);
}

/**
 * Set equality with the disagreement named. A symmetric difference is the only reading that tells "the
 * assembly dropped an entry" apart from "it invented one"; a bare `deepEqual` on two arrays says neither.
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

/**
 * What the file's own rows say the assembly must do with each row, derived from the document and the
 * frame's facts alone - never from the assembler's answer.
 *
 * The rules are the ones the tests cite, in the order the assembler applies them: a row switched off is not
 * sent (`PromptManager.js:1523`); a `marker: true` `chatHistory` row is the cut and carries no text
 * (`openai.js:886-890`); a marker whose slot has no source is NAMED and emits nothing (design §2.5); an
 * `injection_position: 1` row leaves the chain for the depth list (`openai.js:1198-1201`); anything else is
 * sent when some source renders text, and is `blank` when none does - the author's own empty entry
 * (`openai.js:3832-3846` drops empty content from the request).
 *
 * The six buckets are one rule each, and together they PARTITION the selected group: `cut` and `blank` are the
 * two ST sends nothing for, so they are the rows the assembly emits no segment for either.
 */
function expectedPlacement(
  document: PresetDocument,
  rows: readonly OrderRow[],
  slots: Readonly<Record<string, string>>,
): Readonly<{ sent: string[]; named: string[]; depth: string[]; disabled: string[]; cut: string[]; blank: string[] }> {
  const sent: string[] = [];
  const named: string[] = [];
  const depth: string[] = [];
  const disabled: string[] = [];
  const cut: string[] = [];
  const blank: string[] = [];
  for (const row of rows) {
    const entry = requirePrompt(document, row.identifier);
    if (row.enabled === false) {
      disabled.push(row.identifier);
      continue;
    }
    if (entry.marker === true && row.identifier === "chatHistory") {
      cut.push(row.identifier);
      continue;
    }
    // A source that is absent or blank is no source: the assembler falls back to the author's own text, so
    // the rule has to as well, or the two readings would disagree about a blank slot.
    const slot = slots[row.identifier];
    const authored = typeof entry.content === "string" ? entry.content : "";
    const text = typeof slot === "string" && slot.trim().length > 0 ? slot : authored;
    if (entry.marker === true && text.trim().length === 0) {
      named.push(row.identifier);
      continue;
    }
    if (entry.injection_position === 1) {
      depth.push(row.identifier);
      continue;
    }
    if (text.trim().length === 0) blank.push(row.identifier);
    else sent.push(row.identifier);
  }
  return Object.freeze({ sent, named, depth, disabled, cut, blank });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HISTORY = Object.freeze(["m0", "m1", "m2", "m3"]);

/** The consumer's own rule, applied in list order against the growing history (`openai.js:866-870`). */
function insertDepthBlocks(history: readonly string[], blocks: PresetAssembly["depth"]): string[] {
  const messages = [...history];
  for (const block of blocks) messages.splice(depthInsertionIndex(messages.length, block.depth), 0, block.identifier);
  return messages;
}

const DEFAULTS_PREFIX = Object.freeze([
  "main",
  "worldInfoBefore",
  "charDescription",
  "charPersonality",
  "scenario",
  "worldInfoAfter",
  "dialogueExamples",
]);

test("the store serves the file it was given, verbatim, for both real presets (design §2.1/§2.2)", async () => {
  await withRealPresets(({ st, amber }) => {
    for (const preset of [st, amber]) {
      assert.deepEqual(
        preset.document,
        preset.file,
        `${preset.presetId}: the stored document must be the file's own field set, value for value`,
      );
      assert.ok(
        preset.document.prompts.length > 0,
        `${preset.presetId}: the file carries no prompts, so nothing below is measured`,
      );
    }
  });
});

test("assembly order is prompt_order's, never prompts[]'s (PromptManager.js:1516-1521, :1207-1209)", async () => {
  await withRealPresets(({ st, amber }) => {
    const assemble = (preset: MeasuredPreset): PresetAssembly =>
      assemblePreset(preset.document, { macros: MACROS, markers: SLOTS });

    // Default.json is the file that can measure this: its `prompts[]` array and its order group disagree.
    const stRows = assembledOrderRows(st.file);
    const stPromptsOrder = st.document.prompts.map((entry) => entry.identifier);
    assert.notDeepEqual(
      stPromptsOrder,
      stRows.map((row) => row.identifier),
      "Default.json's prompts[] order and prompt_order must differ, or this test measures nothing",
    );
    assert.deepEqual(
      [...assemble(st).before.map((segment) => segment.identifier)],
      [...DEFAULTS_PREFIX],
      "Default.json's prefix must be the ORDER GROUP's sequence - with the cut, the switched-off row, the two empty entries and the persona slot this assembly has no source for removed - not the prompts[] array's",
    );
    assert.notDeepEqual(
      assemble(st).before.map((segment) => segment.identifier),
      stPromptsOrder.slice(0, DEFAULTS_PREFIX.length),
      "the prefix must not be the head of the prompts[] array (PromptManager.js:1516-1521 never iterates it)",
    );

    // amber is the file that cannot distinguish them: that is recorded, not pretended away.
    const amberRows = assembledOrderRows(amber.file);
    assert.deepEqual(
      amber.document.prompts.map((entry) => entry.identifier),
      amberRows.map((row) => row.identifier),
      "amber's prompts[] order and prompt_order are expected to coincide, so its ordering conformance rests on Default.json alone",
    );
    assert.deepEqual(
      assemble(amber).before.map((segment) => segment.identifier),
      [...DEFAULTS_PREFIX],
      "amber's prefix must be its order group's sequence up to the cut",
    );
  });
});

test("Default.json's selected group partitions exactly: every row is sent, named, cut, off or blank, and no row is two of them", async () => {
  await withRealPresets(({ st }) => {
    const rows = assembledOrderRows(st.file);
    const expected = expectedPlacement(st.document, rows, SLOTS);
    const assembly = assemblePreset(st.document, { macros: MACROS, markers: SLOTS });

    // The buckets are RULES (`expectedPlacement`), so the ONE number this test carries is the group's own row
    // count, and it is read from the file: where the ladder decides which group is assembled, a literal here
    // would be the old reading's arithmetic - which is exactly what D1 changed.
    const buckets = {
      sent: expected.sent,
      named: expected.named,
      cut: expected.cut,
      disabled: expected.disabled,
      blank: expected.blank,
      depth: expected.depth,
    } as const;
    const flattened = Object.values(buckets).flat();
    assert.equal(flattened.length, rows.length, "the six rules must sum to the group's own row count");
    assert.equal(new Set(flattened).size, flattened.length, "no row may fall in two buckets");
    assertSameSet(
      "the rules account for the group's rows",
      flattened,
      rows.map((row) => row.identifier),
    );

    // The assembly's own readings against those rules. `cut` and `blank` are the two rows no segment carries
    // and no bucket names, so they are derived as the silent rest and split by ST's own cut name
    // (`openai.js:886-890`): a row the assembly dropped for any other reason would land in `blank` and fail.
    const accounts = new Set([
      ...[...assembly.before, ...assembly.after, ...assembly.depth].map((segment) => segment.identifier),
      ...assembly.unfilled,
      ...assembly.disabled,
    ]);
    const silent = rows.map((row) => row.identifier).filter((identifier) => !accounts.has(identifier));
    assert.deepEqual(
      {
        sent: [...assembly.before, ...assembly.after].map((segment) => segment.identifier),
        named: [...assembly.unfilled],
        cut: silent.filter((identifier) => identifier === "chatHistory"),
        disabled: [...assembly.disabled],
        blank: silent.filter((identifier) => identifier !== "chatHistory"),
        depth: assembly.depth.map((block) => block.identifier),
      },
      buckets,
      `${st.presetId}: the assembly's six buckets must be the rules' six buckets; rows=${JSON.stringify(rows.map((row) => row.identifier))}`,
    );

    // An empty bucket is reported as empty, not omitted: `after` is the one this preset leaves empty.
    assert.deepEqual(
      assembly.after.map((segment) => segment.identifier),
      [],
    );

    for (const identifier of expected.blank) {
      assert.equal(
        sentIdentifiers(assembly).includes(identifier),
        false,
        `"${identifier}" authors no text and has no slot, so it must reach no segment (openai.js:3832-3846 sends nothing for it either)`,
      );
      assert.equal(
        assembly.disabled.includes(identifier),
        false,
        `"${identifier}" is switched ON in the order; reporting it as off would be a second, wrong reading`,
      );
      assert.equal(
        assembly.unfilled.includes(identifier),
        false,
        `"${identifier}" is not a marker, so it is not a slot the assembly owes content`,
      );
    }

    // The same reading for the named bucket: a marker with no source is a slot this assembly owes, so it is
    // neither sent nor called switched off (design §2.5).
    for (const identifier of expected.named) {
      assert.equal(
        sentIdentifiers(assembly).includes(identifier),
        false,
        `"${identifier}" is a marker with no source, so no segment may carry text for it`,
      );
      assert.equal(assembly.disabled.includes(identifier), false, `"${identifier}" is switched ON in the order`);
    }
  });
});

test("amber's 9 rows are 7 sent + 1 cut + 1 in-chat: jailbreak (position 1, depth 0) leaves the tail empty", async () => {
  await withRealPresets(({ amber }) => {
    const rows = assembledOrderRows(amber.file);
    const expected = expectedPlacement(amber.document, rows, SLOTS);
    const assembly = assemblePreset(amber.document, { macros: MACROS, markers: SLOTS });

    assert.equal(rows.length, 9, "amber's row count this suite was measured against has changed");
    assert.deepEqual(expected.sent, [...DEFAULTS_PREFIX]);
    assert.deepEqual(expected.cut, ["chatHistory"]);
    assert.deepEqual(expected.depth, ["jailbreak"]);
    assert.deepEqual(expected.disabled, []);
    assert.deepEqual(expected.blank, []);
    assert.deepEqual(
      expected.named,
      [],
      "amber has no marker without a source, so the ladder's second rung must not start naming slots for it",
    );

    assert.deepEqual(
      assembly.before.map((segment) => segment.identifier),
      expected.sent,
    );
    assert.deepEqual(
      assembly.after.map((segment) => segment.identifier),
      [],
      "jailbreak follows the cut in prompt_order but carries injection_position 1, so it cannot be tail content (openai.js:1198-1201)",
    );
    assertSameSet("amber's unfilled slots", assembly.unfilled, []);
    assertSameSet("amber's switched-off rows", assembly.disabled, []);

    const block = assembly.depth[0];
    assert.ok(block !== undefined, `amber's in-chat row reached no depth block: ${JSON.stringify(assembly.depth)}`);
    assert.equal(block.identifier, "jailbreak");
    assert.equal(
      block.depth,
      requirePrompt(amber.document, "jailbreak").injection_depth,
      "the depth the block carries must be the one the file wrote",
    );
    assert.equal(block.depth, 0, "the file writes injection_depth 0, so the block belongs after the last message");
    assert.deepEqual(
      insertDepthBlocks(HISTORY, assembly.depth),
      [...HISTORY, "jailbreak"],
      "depth 0 must land at messages.length, i.e. after the whole transcript (openai.js:866-870)",
    );
    assert.equal(
      block.text,
      substituteNames(String(requirePrompt(amber.document, "jailbreak").content)),
      "the in-chat block's text is the preset's own, with {{char}}/{{user}} rendered from the assembly's facts",
    );

    assertSameSet(
      "every row of the order accounted for",
      [
        ...expected.sent,
        ...expected.named,
        ...expected.cut,
        ...expected.disabled,
        ...expected.blank,
        ...expected.depth,
      ],
      rows.map((row) => row.identifier),
    );
  });
});

test("a marker is a slot: filled from the assembly and never emitted as the entry's own content (openai.js:1473-1493)", async () => {
  await withRealPresets(({ st, amber }) => {
    for (const preset of [st, amber]) {
      // The population is the group the assembly READS, not a group named here: personaDescription is a marker
      // of ST's group only, and leaving it out would mean this property silently stopped covering the newest
      // member of the closed table.
      const rows = assembledOrderRows(preset.file);
      const markerRows = rows.filter((row) => requirePrompt(preset.document, row.identifier).marker === true);
      assert.ok(markerRows.length >= 7, `${preset.presetId}: fewer marker rows than measured, so this measures less`);

      const empty = assemblePreset(preset.document, { macros: MACROS, markers: {} });
      const filled = assemblePreset(preset.document, { macros: MACROS, markers: SLOTS_WITH_PERSONA });

      for (const row of markerRows) {
        const entry = requirePrompt(preset.document, row.identifier);
        assert.equal(
          "content" in entry,
          false,
          `${preset.presetId}:${row.identifier}: a marker entry carrying its own content would make the slot ambiguous`,
        );
        if (row.identifier === "chatHistory") {
          assert.equal(
            sentIdentifiers(filled).includes("chatHistory"),
            false,
            `${preset.presetId}: chatHistory is the cut and emits nothing (openai.js:886-890)`,
          );
          assert.equal(empty.unfilled.includes("chatHistory"), false, "the cut point is not an unfilled slot");
          continue;
        }
        assert.equal(
          empty.unfilled.includes(row.identifier),
          true,
          `${preset.presetId}:${row.identifier}: a slot with no source must be NAMED (design §2.5), not blanked`,
        );
        assert.equal(
          sentIdentifiers(empty).includes(row.identifier),
          false,
          `${preset.presetId}:${row.identifier}: an unfilled slot must reach no segment`,
        );

        assert.equal(
          sentIdentifiers(filled).includes(row.identifier),
          true,
          `${preset.presetId}:${row.identifier}: the slot's content must be sent at the marker's position`,
        );
        const slot = SLOTS_WITH_PERSONA[row.identifier];
        assert.ok(slot !== undefined, `${preset.presetId}: the frame supplies no slot for "${row.identifier}"`);
        assert.equal(
          segmentText(filled, row.identifier),
          substituteNames(slot),
          `${preset.presetId}:${row.identifier}: the sent text must be the assembly's slot content, rendered - not anything the preset wrote`,
        );
      }
    }
  });
});

test("the sampler keys carried are exactly the ones each file declares, as sets (design §5/§8)", async () => {
  await withRealPresets(({ st, amber }) => {
    /**
     * The keys the FILE declares out of the eight the family names, read from the file rather than from the
     * carrier: the directional comparison below is what makes "no extras, none dropped" measurable.
     */
    const declaredOf = (preset: MeasuredPreset): string[] => PRESET_SAMPLING_KEYS.filter((key) => key in preset.file);

    for (const preset of [st, amber]) {
      const declared = declaredOf(preset);
      const carried = presetSamplingParams(preset.document);
      assertSameSet(
        `${preset.presetId}: the sampler keys carried vs the ones the file declares`,
        Object.keys(carried),
        declared,
      );
      for (const key of declared) {
        assert.equal(
          carried[key as (typeof PRESET_SAMPLING_KEYS)[number]],
          preset.file[key],
          `${preset.presetId}:${key}: the carried value must be the file's own`,
        );
      }
      for (const key of PRESET_SAMPLING_KEYS) {
        if (declared.includes(key)) continue;
        assert.equal(
          carried[key],
          undefined,
          `${preset.presetId}:${key}: the file declares nothing, so the carrier must invent nothing`,
        );
      }
    }

    assert.equal(
      declaredOf(st).length,
      PRESET_SAMPLING_KEYS.length,
      "SillyTavern's own Default.json declares the whole eight-key family; a shortfall means the family grew or the file changed",
    );
    assert.deepEqual(
      declaredOf(st),
      [...PRESET_SAMPLING_KEYS],
      "the shipped default preset must carry all eight, in the family's own order",
    );
    assert.equal(
      declaredOf(amber).length,
      PRESET_SAMPLING_KEYS.length - 2,
      "amber is the file that declares six of the eight",
    );
    assertSameSet(
      "amber's omitted sampler keys (compared as a set: the family's declaration order is not a fact about the preset)",
      PRESET_SAMPLING_KEYS.filter((key) => !(key in amber.file)),
      ["top_a", "min_p"],
    );

    // The non-sampler keys both files carry must not ride along: a permissive spread would let a preset
    // rewrite the request (design §5's "不整篇 spread").
    for (const key of ["openai_max_context", "openai_max_tokens", "seed", "n", "stream_openai"]) {
      if (!(key in st.file) && !(key in amber.file)) continue;
      assert.equal(
        Object.hasOwn(presetSamplingParams(st.document), key) ||
          Object.hasOwn(presetSamplingParams(amber.document), key),
        false,
        `"${key}" is a budget/transport field, not a sampler key (openai.js:1567 sets the budget), so it must not be carried`,
      );
    }
  });
});

test("neither preset spells a conditional block, so design §4.3's {{if}} stays out of scope for these files", async () => {
  await withRealPresets(({ st, amber }) => {
    for (const preset of [st, amber]) {
      for (const token of ["{{if", "{{#if", "{{else", "{{/if"]) {
        assert.equal(
          countOccurrences(preset.text, token),
          0,
          `${preset.presetId}: "${token}" now appears, so this exemption has expired - the suite must gain a {{if}} case (design §4.3)`,
        );
      }
    }
  });
});

/** Non-overlapping occurrences of one token in a text; the census above is per token and per file. */
function countOccurrences(text: string, token: string): number {
  let count = 0;
  let index = text.indexOf(token);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(token, index + token.length);
  }
  return count;
}

/**
 * D1, RESOLVED: the group this product assembles is the one SillyTavern 1.19's chat-completion path assembles.
 *
 * The two readings that disagreed:
 *  - `PromptManager.js:336` is the BASE CLASS default - `promptOrder: { strategy: 'global', dummyId: 100000 }`,
 *    the single group a preset written by the stock prompt manager carries;
 *  - `openai.js:696-700` OVERRIDES it for the chat-completion manager this product runs:
 *    `promptOrder: { strategy: 'global', dummyId: 100001 }`. `PromptManager.js:438` copies that id into
 *    `activeCharacter`, and `:1207-1209` resolves the group as
 *    `prompt_order.find(list => String(list.character_id) === String(character.id))`.
 *
 * So the wire walks 100001 - the group that carries `personaDescription` (`PromptManager.js:306` lists it as a
 * prompt source, `openai.js:1432-1435` pushes it as a `system` message). A4 §2.1 (line 94) reads 100001 as the
 * group-chat default and therefore as not ours; the runtime says otherwise and the runtime is the authority,
 * recorded in `design/architecture/tavern-preset-compatibility.md` §2.8. That is why the ladder in
 * `preset-placement.ts` tries 100001 first and 100000 second.
 *
 * What makes this a conformance CONTRACT rather than a note: the two groups differ by exactly one row, so a
 * ladder that picked the legacy group would drop the persona slot from the request, and every assertion below
 * names that difference.
 */
test("Default.json assembles ST 1.19's 100001 group: personaDescription is sent between worldInfoBefore and charDescription (openai.js:698; PromptManager.js:438,1207-1209)", async () => {
  await withRealPresets(({ st }) => {
    const stGroup = orderGroupRows(st.file, 100001).map((row) => row.identifier);
    const legacyGroup = orderGroupRows(st.file, 100000).map((row) => row.identifier);
    assert.deepEqual(
      {
        onlyInSt: stGroup.filter((identifier) => !legacyGroup.includes(identifier)),
        onlyInLegacy: legacyGroup.filter((identifier) => !stGroup.includes(identifier)),
      },
      { onlyInSt: ["personaDescription"], onlyInLegacy: [] },
      `the two Default.json groups must differ by exactly the persona slot, or "which group" is not measurable; ST's=${JSON.stringify(stGroup)} legacy=${JSON.stringify(legacyGroup)}`,
    );

    const rows = assembledOrderRows(st.file);
    const assembly = assemblePreset(st.document, { macros: MACROS, markers: SLOTS_WITH_PERSONA });
    const sent = assembly.before.map((segment) => segment.identifier);

    // The selection: ST's group, row for row...
    assert.deepEqual(
      rows.map((row) => row.identifier),
      stGroup,
      "the assembly must read ST's 100001 group, in that group's own row sequence",
    );
    // ... and NOT the legacy group's, which is a measurably shorter request (11 rows, one fewer slot).
    assert.notDeepEqual(
      sent,
      expectedPlacement(st.document, orderGroupRows(st.file, 100000), SLOTS_WITH_PERSONA).sent,
      "the prefix must not be the legacy 100000 group's: the two groups differ by the persona row, so a request built from the legacy one is missing a message",
    );
    assert.deepEqual(
      sent,
      expectedPlacement(st.document, rows, SLOTS_WITH_PERSONA).sent,
      "the prefix must be the rules' reading of ST's group",
    );

    // The persona slot is in the request, and its POSITION is the whole player-visible effect.
    assert.ok(
      sentIdentifiers(assembly).includes("personaDescription"),
      `the persona slot must be sent; sent=${JSON.stringify(sentIdentifiers(assembly))}`,
    );
    assert.deepEqual(
      sent.slice(sent.indexOf("worldInfoBefore"), sent.indexOf("worldInfoBefore") + 3),
      ["worldInfoBefore", "personaDescription", "charDescription"],
      "the persona slot must sit between worldInfoBefore and charDescription, in that order: that ordering is the difference ST's group makes to the request",
    );
  });
});

/**
 * The same assembly with no persona source - the ordinary player who never wrote one.
 *
 * Design §2.5: the slot is NAMED in `unfilled` (which `presetAssemblySurface`'s `unfilledMarkers` carries to the
 * player) and nothing is sent for it. Neither refusing the document nor dropping the row silently is allowed: a
 * refusal would make importing SillyTavern's own default preset fail for most players, and a silent drop would
 * hide a region the preset declares and this product could not fill.
 */
test("a persona-less assembly names personaDescription and sends nothing for it (design §2.5)", async () => {
  await withRealPresets(({ st }) => {
    const assembly = assemblePreset(st.document, { macros: MACROS, markers: SLOTS });

    assertSameSet("the unfilled slot a player without a persona sees", assembly.unfilled, ["personaDescription"]);
    assert.equal(
      sentIdentifiers(assembly).includes("personaDescription"),
      false,
      `a slot with no source must reach no segment; sent=${JSON.stringify(sentIdentifiers(assembly))}`,
    );
    assert.equal(
      assembly.disabled.includes("personaDescription"),
      false,
      "the row is switched ON in the order; naming it as an unfilled slot is not disabling it",
    );

    // ... and the player-facing readout is where that name has to arrive: the readout carries `unfilled`
    // through as `unfilledMarkers`, so a slot nobody could fill is visible rather than silent (design §2.5).
    const surface = presetAssemblySurface({
      presetId: st.presetId,
      name: null,
      revision: 1,
      document: st.document,
      macros: MACROS,
      markers: SLOTS,
      sampling: null,
    });
    assert.deepEqual(
      surface.unfilledMarkers,
      ["personaDescription"],
      "the preset readout must name the persona slot a player without a persona cannot fill",
    );
  });
});

/*
 * REPORTED DEFECT (D6), recorded here and asserted nowhere, because no file in this repository can reach it:
 * a `chatHistory` row switched OFF in `prompt_order`.
 *
 * ST: `openai.js:886-888` `if (!prompts.has('chatHistory')) return;` - a disabled row never enters the
 * collection, so ST sends NO transcript at all.
 * Ours: `preset-assembler.ts:100-101` sets `cutRowPresent` before the switch check, so a disabled cut row
 * does not refuse; `pastCut` stays false and the whole tail lands in `before`, i.e. post-history
 * instructions are sent as prefix content. Design §2.4 makes the marker the cut, so degrading silently is
 * the wrong side of that ruling; the fix needs a `preset_*` code of its own, which does not exist yet.
 * Both real presets enable the row, so there is nothing here to measure - and a test that mutated the file
 * into a shape it does not have would be measuring this suite's imagination, not the preset.
 */
