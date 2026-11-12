import assert from "node:assert/strict";
import test from "node:test";
import { assemblePreset, type PresetAssembly } from "./preset-assembler.js";
import type { MacroContext } from "./preset-macros.js";
import { PRESET_MARKERS, type PresetEntryPlacement, presetEntryPlacements } from "./preset-placement.js";

/**
 * The placement reading is a SECOND derivation of a fact the assembler already decides, and the only thing that
 * keeps two derivations honest is an assertion over the first one's real output. `tools/check-preset-macros.mjs`
 * reports `macro_tail_only_in_segment` from `presetEntryPlacements`; if the assembler ever moved an entry - a new
 * cut, a different order group, a depth row that stops being a depth row - the gate would name the wrong segment
 * and the preset's real assembly would disagree with the report the player sees. So every test below compares
 * this reading against `assemblePreset`'s own buckets, and a drifted entry fails by name.
 *
 * `preset-macros.ts` is the reason this module is import-free; that boundary is pinned by the gate loading it
 * through plain Node, so it is not repeated here.
 */

const MACROS: MacroContext = {
  char: "Mira",
  user: "the player",
  description: "",
  personality: "",
  scenario: "",
  persona: "",
  itemId: "placement-fixture",
};

type PromptFixture = {
  identifier: string;
  content?: string;
  marker?: boolean;
  role?: string;
  enabled?: boolean;
  injection_position?: number;
  injection_depth?: number;
  injection_order?: number;
};

type OrderRow = string | { identifier: string; enabled: boolean };

function presetDocument(input: {
  prompts: readonly PromptFixture[];
  order: readonly OrderRow[];
  characterId?: number;
}): Record<string, unknown> {
  return {
    name: "placement fixture",
    prompts: input.prompts,
    prompt_order: [
      {
        character_id: input.characterId ?? 100000,
        order: input.order.map((row) =>
          typeof row === "string"
            ? { identifier: row, enabled: true }
            : { identifier: row.identifier, enabled: row.enabled },
        ),
      },
    ],
  };
}

/** Every entry the fixture places, in one document: before the cut, after it, at a depth, and switched off. */
const FULL_PROMPTS: readonly PromptFixture[] = [
  { identifier: "main", content: "Write {{char}}'s next reply." },
  { identifier: "worldInfoBefore", marker: true },
  { identifier: "charDescription", marker: true },
  { identifier: "style_rules", content: "Keep it short." },
  { identifier: "chatHistory", marker: true },
  { identifier: "jailbreak", content: "Stay in {{char}}'s voice." },
  {
    identifier: "state_note",
    content: "Mood: {{getvar::mood}}",
    injection_position: 1,
    injection_depth: 2,
    injection_order: 100,
  },
  { identifier: "off_before", content: "Never sent." },
  { identifier: "off_after", content: "Never sent either.", injection_position: 1, injection_depth: 0 },
];
const FULL_ORDER: readonly OrderRow[] = [
  "main",
  "worldInfoBefore",
  "charDescription",
  "style_rules",
  { identifier: "off_before", enabled: false },
  "chatHistory",
  "jailbreak",
  "state_note",
  { identifier: "off_after", enabled: false },
];
const FULL_DOC = presetDocument({ prompts: FULL_PROMPTS, order: FULL_ORDER });

/** Every slot filled, so the assembly emits each placed entry and the two readings can be compared exactly. */
const FILLED_MARKERS: Readonly<Record<string, string>> = {
  worldInfoBefore: "A bound world book.",
  charDescription: "Mira tends the greenhouse.",
};

function identifiers(placements: readonly PresetEntryPlacement[], segment: PresetEntryPlacement["segment"]): string[] {
  return placements.filter((placement) => placement.segment === segment).map((placement) => placement.identifier);
}

function assembledIdentifiers(assembly: PresetAssembly, segment: "before" | "after" | "depth"): string[] {
  return assembly[segment].map((entry) => entry.identifier);
}

test("the placement reading and the assembler agree on every entry's segment", () => {
  const placements = presetEntryPlacements(FULL_DOC);
  const assembly = assemblePreset(FULL_DOC, { macros: MACROS, markers: FILLED_MARKERS });

  for (const segment of ["before", "after", "depth"] as const)
    assert.deepEqual(
      identifiers(placements, segment),
      assembledIdentifiers(assembly, segment),
      `the "${segment}" segment is not the one the assembler built`,
    );
  assert.deepEqual(identifiers(placements, "disabled"), [...assembly.disabled]);
  assert.deepEqual(identifiers(placements, "cut"), ["chatHistory"]);
  assert.equal(identifiers(placements, "unplaced").length, 0);

  // The four facts a document cannot restate: one entry per row, and the cut reaches neither side.
  assert.equal(placements.length, FULL_ORDER.length);
  for (const segment of ["before", "after", "depth"] as const)
    assert.equal(identifiers(placements, segment).includes("chatHistory"), false, `the cut landed in "${segment}"`);
});

test("a slot with no source is still placed, and the assembler names it unfilled instead of sending it", () => {
  const placements = presetEntryPlacements(FULL_DOC);
  const assembly = assemblePreset(FULL_DOC, { macros: MACROS, markers: {} });

  assert.ok(identifiers(placements, "before").includes("charDescription"));
  assert.ok(assembly.unfilled.includes("charDescription"));
  assert.equal(assembledIdentifiers(assembly, "before").includes("charDescription"), false);
  for (const placement of placements)
    if (placement.segment === "before" || placement.segment === "after" || placement.segment === "depth")
      assert.ok(
        [...assembledIdentifiers(assembly, placement.segment), ...assembly.unfilled].includes(placement.identifier),
        `${placement.identifier} is placed in "${placement.segment}" but the assembler neither sent nor named it`,
      );
});

test("a switched-off row is disabled in both readings, before and after the cut", () => {
  const placements = presetEntryPlacements(FULL_DOC);
  const assembly = assemblePreset(FULL_DOC, { macros: MACROS, markers: FILLED_MARKERS });

  assert.deepEqual(identifiers(placements, "disabled"), ["off_before", "off_after"]);
  for (const segment of ["before", "after", "depth"] as const) {
    assert.equal(identifiers(placements, segment).includes("off_before"), false);
    assert.equal(identifiers(placements, segment).includes("off_after"), false);
  }
  assert.deepEqual([...assembly.disabled].sort(), ["off_after", "off_before"]);
});

test("the order row's switch is the authoritative one, as the assembler reads it", () => {
  const doc = presetDocument({
    prompts: [
      { identifier: "mirror_off", content: "kept", enabled: false },
      { identifier: "mirror_on", content: "dropped", enabled: true },
      { identifier: "chatHistory", marker: true },
    ],
    order: ["mirror_off", { identifier: "mirror_on", enabled: false }, "chatHistory"],
  });
  const assembly = assemblePreset(doc, { macros: MACROS, markers: {} });

  assert.deepEqual(identifiers(presetEntryPlacements(doc), "before"), assembledIdentifiers(assembly, "before"));
  assert.deepEqual(identifiers(presetEntryPlacements(doc), "disabled"), [...assembly.disabled]);
});

/**
 * The ladder: ST's chat-completion group first (`openai.js:698` overriding `PromptManager.js:336`), the legacy
 * single group second, any other group last.
 *
 * Every rung is measured against `assemblePreset`'s own buckets as well as this module's placements, and every
 * document below carries a row its neighbours do not - a rung is only measurable if selecting the wrong group
 * changes something. The 100001 and 100000 groups here differ by one row (`personaDescription` vs `legacy_only`),
 * so "which group won" is a reading rather than an assumption.
 */
test("the ladder reads ST's chat-completion group first, the legacy group second, any other group last", () => {
  const LADDER_MARKERS: Readonly<Record<string, string>> = { personaDescription: "the player's own description" };

  // Same two groups, opposite document order: the ladder names the id, so position must not decide it.
  const chatFirst = ladderDocument([
    { characterId: 100001, identifiers: ["main", "personaDescription", "chatHistory"] },
    { characterId: 100000, identifiers: ["main", "legacy_only", "chatHistory"] },
  ]);
  const legacyFirst = ladderDocument([
    { characterId: 100000, identifiers: ["main", "legacy_only", "chatHistory"] },
    { characterId: 100001, identifiers: ["main", "personaDescription", "chatHistory"] },
  ]);
  for (const doc of [chatFirst, legacyFirst]) {
    const assembly = assemblePreset(doc, { macros: MACROS, markers: LADDER_MARKERS });
    assert.deepEqual(
      assembledIdentifiers(assembly, "before"),
      ["main", "personaDescription"],
      "the 100001 group must win wherever it sits in the document, and its own rows must be the ones assembled",
    );
    assert.deepEqual(identifiers(presetEntryPlacements(doc), "before"), assembledIdentifiers(assembly, "before"));
  }

  const legacyOnly = ladderDocument([{ characterId: 100000, identifiers: ["main", "legacy_only", "chatHistory"] }]);
  const legacyAssembly = assemblePreset(legacyOnly, { macros: MACROS, markers: LADDER_MARKERS });
  assert.deepEqual(
    assembledIdentifiers(legacyAssembly, "before"),
    ["main", "legacy_only"],
    "a preset that ships only the legacy group must keep assembling exactly as it did",
  );
  assert.deepEqual(
    identifiers(presetEntryPlacements(legacyOnly), "before"),
    assembledIdentifiers(legacyAssembly, "before"),
  );

  const neither = ladderDocument([{ characterId: 7, identifiers: ["main", "other_group", "chatHistory"] }]);
  const otherAssembly = assemblePreset(neither, { macros: MACROS, markers: LADDER_MARKERS });
  assert.deepEqual(
    assembledIdentifiers(otherAssembly, "before"),
    ["main", "other_group"],
    "a document naming neither id falls to its first readable group, which is the only order it declares",
  );
  assert.deepEqual(
    identifiers(presetEntryPlacements(neither), "before"),
    assembledIdentifiers(otherAssembly, "before"),
  );
});

/**
 * A document with one `prompt_order` group per entry given, in the order given, and a prompt pool wide enough
 * for every rung: `personaDescription` (100001's own row), `legacy_only` (100000's), `other_group`.
 */
function ladderDocument(
  groups: readonly { characterId: number; identifiers: readonly string[] }[],
): Record<string, unknown> {
  return {
    name: "ladder fixture",
    prompts: [
      { identifier: "main", content: "opening" },
      { identifier: "personaDescription", marker: true },
      { identifier: "legacy_only", content: "legacy row" },
      { identifier: "other_group", content: "other row" },
      { identifier: "chatHistory", marker: true },
    ],
    prompt_order: groups.map((group) => ({
      character_id: group.characterId,
      order: group.identifiers.map((identifier) => ({ identifier, enabled: true })),
    })),
  };
}

test("an order row naming a prompt the document does not define is unplaced here and refused there", () => {
  const doc = presetDocument({
    prompts: [
      { identifier: "main", content: "opening" },
      { identifier: "chatHistory", marker: true },
    ],
    order: ["main", "ghost", "chatHistory"],
  });

  assert.deepEqual(identifiers(presetEntryPlacements(doc), "unplaced"), ["ghost"]);
  assert.throws(
    () => assemblePreset(doc, { macros: MACROS, markers: {} }),
    /preset_order_references_undefined_prompt:ghost/u,
  );
});

test("a document with no readable order is refused by name, never read as everything-before", () => {
  assert.throws(() => presetEntryPlacements(null), /preset_segments_document_not_object/u);
  assert.throws(() => presetEntryPlacements({ prompts: {} }), /preset_segments_prompts_not_array/u);
  assert.throws(() => presetEntryPlacements({ prompts: [] }), /preset_segments_order_missing/u);
  assert.throws(
    () => presetEntryPlacements({ prompts: [{ identifier: "main" }], prompt_order: [{ order: [{ identifier: 7 }] }] }),
    /preset_segments_order_row_invalid:0/u,
  );
  assert.throws(
    () => presetEntryPlacements({ prompts: [{}], prompt_order: [{ order: [] }] }),
    /preset_segments_prompt_invalid/u,
  );
});

test("every marker in the table is either the one cut or a slot, and exactly one says cut", () => {
  const kinds = Object.values(PRESET_MARKERS);
  assert.equal(kinds.filter((kind) => kind === "cut").length, 1);
  assert.ok(kinds.filter((kind) => kind === "slot").length > 0);
});
