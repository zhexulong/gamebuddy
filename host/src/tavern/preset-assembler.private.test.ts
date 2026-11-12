import assert from "node:assert/strict";
import test from "node:test";
import {
  assemblePreset,
  depthInsertionIndex,
  PRESET_MARKERS,
  type PresetAssembly,
  type PresetDepthBlock,
} from "./preset-assembler.js";
import { evaluatePresetText, type MacroContext } from "./preset-macros.js";

const MACROS: MacroContext = {
  char: "琥珀",
  user: "阿远",
  description: "",
  personality: "",
  scenario: "",
  persona: "",
  itemId: "assembler-fixture",
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

function presetDocument(input: {
  prompts: readonly PromptFixture[];
  order: readonly (string | { identifier: string; enabled: boolean })[];
  characterId?: number;
}): Record<string, unknown> {
  return {
    name: "组装夹具",
    temperature: 1,
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

/**
 * A preset shaped like a real SillyTavern one: A4 §2.1's Default.json order, the markers that order
 * contains, three author-written entries (one of them after the cut), and one in-chat depth entry.
 */
const REALISTIC_PROMPTS: readonly PromptFixture[] = [
  { identifier: "main", content: "你正在扮演{{char}}，与{{user}}对话。" },
  { identifier: "worldInfoBefore", marker: true },
  { identifier: "charDescription", marker: true },
  { identifier: "charPersonality", marker: true },
  { identifier: "scenario", marker: true },
  { identifier: "worldInfoAfter", marker: true },
  { identifier: "dialogueExamples", marker: true },
  { identifier: "style_rules", content: "语气口语化，一次只说一件事。" },
  { identifier: "chatHistory", marker: true },
  { identifier: "jailbreak", content: "记住：全程只用中文。" },
  {
    identifier: "state_note",
    content: "此刻心情：{{getvar::mood}}",
    injection_position: 1,
    injection_depth: 1,
    injection_order: 100,
  },
];
const REALISTIC_ORDER: readonly string[] = [
  "main",
  "worldInfoBefore",
  "charDescription",
  "charPersonality",
  "scenario",
  "worldInfoAfter",
  "dialogueExamples",
  "style_rules",
  "chatHistory",
  "jailbreak",
  "state_note",
];
const REALISTIC_DOC = presetDocument({ prompts: REALISTIC_PROMPTS, order: REALISTIC_ORDER });
/** Every slot the assembly could supply, filled - what a fully wired Chat presents to the assembler. */
const FILLED_MARKERS: Partial<Record<string, string>> = {
  worldInfoBefore: "（世界书·前置）{{char}}和{{user}}一起经营农场。",
  charDescription: "{{char}}，24岁，齐耳短发。",
  charPersonality: "嘴硬心软，累了就直说。",
  scenario: "{{user}}和{{char}}回到星谷接手老农场。",
  worldInfoAfter: "（世界书·后置）镇上的人都认得他们。",
  dialogueExamples: "{{user}}：今天下雨。\n{{char}}：不用浇水了。",
};

function identifiers(segments: readonly { identifier: string }[]): string[] {
  return segments.map((segment) => segment.identifier);
}

function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  assert.ok(value !== undefined, `expected an element at ${index}`);
  return value;
}

/** The consumer's own rule, applied in list order against the growing history (A4 §2.3). */
function insertDepthBlocks(history: readonly string[], blocks: readonly PresetDepthBlock[]): string[] {
  const messages = [...history];
  for (const block of blocks) messages.splice(depthInsertionIndex(messages.length, block.depth), 0, block.identifier);
  return messages;
}

const HISTORY = ["m0", "m1", "m2", "m3"];

test("chatHistory is a cut point: it emits nothing and decides where before ends", () => {
  const assembly = assemblePreset(REALISTIC_DOC, { macros: MACROS, markers: FILLED_MARKERS });

  assert.deepEqual(identifiers(assembly.before), [
    "main",
    "worldInfoBefore",
    "charDescription",
    "charPersonality",
    "scenario",
    "worldInfoAfter",
    "dialogueExamples",
    "style_rules",
  ]);
  assert.deepEqual(identifiers(assembly.after), ["jailbreak"]);
  assert.equal(
    [...assembly.before, ...assembly.after].some((segment) => segment.identifier === "chatHistory"),
    false,
  );
  assert.deepEqual(assembly.unfilled, []);
});

test("entries are ordered by the preset's prompt_order, not by the prompts array order", () => {
  const doc = presetDocument({
    prompts: [
      { identifier: "chatHistory", marker: true },
      { identifier: "main", content: "甲" },
      { identifier: "second", content: "乙" },
      { identifier: "first", content: "丙" },
    ],
    order: ["first", "main", "second", "chatHistory"],
  });

  assert.deepEqual(identifiers(assemblePreset(doc, { macros: MACROS, markers: {} }).before), [
    "first",
    "main",
    "second",
  ]);
});

test("with no source at all, every slot is named in unfilled and the preset's own main/jailbreak still ship", () => {
  const assembly = assemblePreset(REALISTIC_DOC, { macros: MACROS, markers: {} });

  assert.deepEqual(assembly.unfilled, [
    "worldInfoBefore",
    "charDescription",
    "charPersonality",
    "scenario",
    "worldInfoAfter",
    "dialogueExamples",
  ]);
  assert.deepEqual(identifiers(assembly.before), ["main", "style_rules"]);
  assert.deepEqual(identifiers(assembly.after), ["jailbreak"]);
});

/**
 * The population comes from `PRESET_MARKERS`, not from a list written here: a marker added to the table is
 * judged by this test the moment it exists, and a marker that neither ships nor is named fails by name.
 */
test("every marker in the table either publishes a segment or is named in unfilled - never both, never neither", () => {
  const slots = Object.entries(PRESET_MARKERS)
    .filter(([, kind]) => kind === "slot")
    .map(([identifier]) => identifier);
  assert.ok(slots.length > 0, "the marker table must declare at least one slot");
  const doc = presetDocument({
    prompts: [
      ...slots.map((identifier) => ({ identifier, marker: true })),
      { identifier: "chatHistory", marker: true },
    ],
    order: [...slots, "chatHistory"],
  });

  const unfilled = assemblePreset(doc, { macros: MACROS, markers: {} });
  for (const slot of slots) {
    const named = unfilled.unfilled.includes(slot);
    const sent = identifiers([...unfilled.before, ...unfilled.after]).includes(slot);
    assert.ok(
      named !== sent,
      `${slot}: sent=${String(sent)} named=${String(named)} - a slot is filled or named, never both`,
    );
  }
  assert.deepEqual(unfilled.unfilled, slots);

  const filled: Partial<Record<string, string>> = {};
  for (const slot of slots) filled[slot] = `${slot} 的内容`;
  const sourced = assemblePreset(doc, { macros: MACROS, markers: filled });
  assert.deepEqual(sourced.unfilled, []);
  assert.deepEqual(identifiers(sourced.before), slots);
});

test("a whitespace-only source is no source", () => {
  const assembly = assemblePreset(REALISTIC_DOC, {
    macros: MACROS,
    markers: { ...FILLED_MARKERS, charDescription: "  \n\t " },
  });

  assert.ok(assembly.unfilled.includes("charDescription"));
  assert.equal(identifiers(assembly.before).includes("charDescription"), false);
});

/**
 * A4 §2.1: `main` and `jailbreak` are content-type entries, and A4 §3.2: the card's `system_prompt` /
 * `post_history_instructions` override them when non-empty. Both halves are pinned here, because a slot-only
 * reading of `main` discards the preset author's 破限 text and an authored-only reading discards the card's.
 */
test("the card's own main and jailbreak replace the preset's, and the preset's own text is kept when the card wrote none", () => {
  const assembly = assemblePreset(REALISTIC_DOC, {
    macros: MACROS,
    markers: { ...FILLED_MARKERS, main: "卡的 system_prompt：扮演{{char}}。", jailbreak: "卡的收尾指令。" },
  });
  const before = assembly.before.find((segment) => segment.identifier === "main");
  assert.ok(before !== undefined, "main must be sent");
  assert.equal(
    before.text,
    evaluatePresetText("卡的 system_prompt：扮演{{char}}。", { ...MACROS, itemId: "main" }).text,
  );
  const after = assembly.after.find((segment) => segment.identifier === "jailbreak");
  assert.ok(after !== undefined, "jailbreak must be sent");
  assert.equal(after.text, "卡的收尾指令。");

  const authored = assemblePreset(REALISTIC_DOC, { macros: MACROS, markers: FILLED_MARKERS });
  const authoredMain = authored.before.find((segment) => segment.identifier === "main");
  assert.ok(authoredMain !== undefined);
  assert.equal(authoredMain.text, "你正在扮演琥珀，与阿远对话。");
});

test("marker material reaches the model through the preset evaluator, not pasted raw", () => {
  const assembly = assemblePreset(REALISTIC_DOC, { macros: MACROS, markers: FILLED_MARKERS });
  const description = assembly.before.find((segment) => segment.identifier === "charDescription");

  assert.ok(description !== undefined);
  assert.equal(
    description.text,
    evaluatePresetText(FILLED_MARKERS.charDescription ?? "", { ...MACROS, itemId: "charDescription" }).text,
  );
  assert.equal(description.text.includes("{{char}}"), false);
});

test("a macro the evaluator could not resolve is published on the segment, never blanked", () => {
  const text = "剩余 {{time}}，心情 {{no_such_macro}}；{{char}} 在场。";
  const doc = presetDocument({
    prompts: [
      { identifier: "main", content: "开场" },
      { identifier: "chatHistory", marker: true },
      { identifier: "tail", content: text },
    ],
    order: ["main", "chatHistory", "tail"],
  });
  const assembly = assemblePreset(doc, { macros: MACROS, markers: {} });
  const segment = assembly.after.find((entry) => entry.identifier === "tail");
  const outcome = evaluatePresetText(text, { ...MACROS, itemId: "tail" });

  assert.ok(segment !== undefined);
  assert.equal(segment.text, outcome.text);
  assert.ok(segment.unresolved.includes("no_such_macro"), "an unknown macro name must be named");
  assert.ok(segment.unresolved.includes("time"), "a recognised-but-unevaluated macro name must be named");
  for (const name of [...outcome.unresolved, ...outcome.unknown]) assert.ok(segment.unresolved.includes(name));
  assert.equal(segment.unresolved.length, new Set(segment.unresolved).size);
});

test("a disabled entry is skipped, listed, and absent from every segment", () => {
  const doc = presetDocument({
    prompts: [
      { identifier: "main", content: "开场" },
      { identifier: "chatHistory", marker: true },
      { identifier: "off_before", content: "不该出现" },
    ],
    order: ["main", { identifier: "off_before", enabled: false }, "chatHistory"],
  });
  const assembly = assemblePreset(doc, { macros: MACROS, markers: {} });

  assert.deepEqual(assembly.disabled, ["off_before"]);
  assert.deepEqual(identifiers([...assembly.before, ...assembly.after]), ["main"]);
});

test("the order row's switch is authoritative when the two copies disagree", () => {
  const doc = presetDocument({
    prompts: [
      { identifier: "mirror_off", content: "甲", enabled: false },
      { identifier: "mirror_on", content: "乙", enabled: true },
      { identifier: "chatHistory", marker: true },
    ],
    order: ["mirror_off", { identifier: "mirror_on", enabled: false }, "chatHistory"],
  });
  const assembly = assemblePreset(doc, { macros: MACROS, markers: {} });

  assert.deepEqual(identifiers(assembly.before), ["mirror_off"]);
  assert.deepEqual(assembly.disabled, ["mirror_on"]);
});

test("a switched-off entry is not judged: its marker and placement fields are never read", () => {
  const doc = presetDocument({
    prompts: [
      { identifier: "main", content: "开场" },
      { identifier: "personaDescription", marker: true, injection_position: 7 },
      { identifier: "chatHistory", marker: true },
    ],
    order: ["main", { identifier: "personaDescription", enabled: false }, "chatHistory"],
  });
  const assembly = assemblePreset(doc, { macros: MACROS, markers: { personaDescription: "人设" } });

  assert.deepEqual(assembly.disabled, ["personaDescription"]);
  assert.deepEqual(identifiers(assembly.before), ["main"]);
});

function depthDoc(prompts: readonly (PromptFixture & { injection_position: 1 })[]): Record<string, unknown> {
  return presetDocument({
    prompts: [{ identifier: "main", content: "开场" }, { identifier: "chatHistory", marker: true }, ...prompts],
    order: ["main", "chatHistory", ...prompts.map((prompt) => prompt.identifier)],
  });
}

test("depth blocks are placed inside the history by their authored depth", () => {
  const assembly = assemblePreset(
    depthDoc([
      { identifier: "deep", content: "两条之前", injection_position: 1, injection_depth: 2, injection_order: 100 },
      { identifier: "shallow", content: "一条之前", injection_position: 1, injection_depth: 1, injection_order: 100 },
    ]),
    { macros: MACROS, markers: {} },
  );

  assert.deepEqual(identifiers([...assembly.before, ...assembly.after]), ["main"]);
  assert.deepEqual(identifiers(assembly.depth), ["deep", "shallow"]);
  assert.deepEqual(insertDepthBlocks(HISTORY, assembly.depth), ["m0", "m1", "deep", "m2", "shallow", "m3"]);
});

test("boundary depth === 0 is the end of the history, closest to generation", () => {
  const assembly = assemblePreset(
    depthDoc([
      { identifier: "note", content: "状态", injection_position: 1, injection_depth: 0, injection_order: 100 },
    ]),
    { macros: MACROS, markers: {} },
  );

  assert.equal(depthInsertionIndex(HISTORY.length, at(assembly.depth, 0).depth), HISTORY.length);
  assert.deepEqual(insertDepthBlocks(HISTORY, assembly.depth), ["m0", "m1", "m2", "m3", "note"]);
});

test("boundary depth deeper than the history starts it, and the block is never dropped", () => {
  const assembly = assemblePreset(
    depthDoc([{ identifier: "far", content: "很深", injection_position: 1, injection_depth: 9, injection_order: 100 }]),
    { macros: MACROS, markers: {} },
  );
  const block = at(assembly.depth, 0);

  assert.equal(block.depth, 9);
  assert.equal(depthInsertionIndex(HISTORY.length, block.depth), 0);
  assert.deepEqual(insertDepthBlocks(HISTORY, assembly.depth), ["far", "m0", "m1", "m2", "m3"]);
});

test("two blocks at one depth are ordered by injection_order ascending", () => {
  const assembly = assemblePreset(
    depthDoc([
      { identifier: "later", content: "后", injection_position: 1, injection_depth: 1, injection_order: 200 },
      { identifier: "earlier", content: "前", injection_position: 1, injection_depth: 1, injection_order: 100 },
    ]),
    { macros: MACROS, markers: {} },
  );

  assert.deepEqual(identifiers(assembly.depth), ["earlier", "later"]);
  assert.deepEqual(insertDepthBlocks(HISTORY, assembly.depth), ["m0", "m1", "m2", "earlier", "later", "m3"]);
});

test("a depth block whose target row a boundary trim removes survives at the start of the trimmed history", () => {
  const assembly = assemblePreset(
    depthDoc([
      { identifier: "older_note", content: "旧事", injection_position: 1, injection_depth: 5, injection_order: 100 },
    ]),
    { macros: MACROS, markers: {} },
  );
  const trimmed = HISTORY.slice(-2);

  assert.deepEqual(insertDepthBlocks(HISTORY, assembly.depth), ["older_note", "m0", "m1", "m2", "m3"]);
  assert.equal(depthInsertionIndex(trimmed.length, at(assembly.depth, 0).depth), 0);
  assert.deepEqual(insertDepthBlocks(trimmed, assembly.depth), ["older_note", "m2", "m3"]);
});

test("every order row lands in exactly one bucket: sent, named unfilled, or listed disabled", () => {
  const doc = presetDocument({
    prompts: [
      { identifier: "main", content: "开场" },
      { identifier: "charDescription", marker: true },
      { identifier: "chatHistory", marker: true },
      { identifier: "jailbreak", content: "收尾" },
      { identifier: "note", content: "状态", injection_position: 1, injection_depth: 0, injection_order: 10 },
      { identifier: "off", content: "关闭的块" },
    ],
    order: ["main", "charDescription", "chatHistory", "jailbreak", "note", { identifier: "off", enabled: false }],
  });
  const assembly: PresetAssembly = assemblePreset(doc, { macros: MACROS, markers: {} });
  const buckets = [
    identifiers(assembly.before),
    identifiers(assembly.after),
    identifiers(assembly.depth),
    [...assembly.unfilled],
    [...assembly.disabled],
  ];
  const flattened = buckets.flat();

  assert.deepEqual(flattened.slice().sort(), ["charDescription", "jailbreak", "main", "note", "off"]);
  assert.equal(new Set(flattened).size, flattened.length, "an entry may appear in one bucket only");
});

test("unknown injection_position, marker outside the table, and a dangling order row are each refused by name", () => {
  const unknownPosition = presetDocument({
    prompts: [
      { identifier: "main", content: "开场", injection_position: 2 },
      { identifier: "chatHistory", marker: true },
    ],
    order: ["main", "chatHistory"],
  });
  assert.throws(
    () => assemblePreset(unknownPosition, { macros: MACROS, markers: {} }),
    /preset_injection_position_unknown:main:2/,
  );

  const unknownMarker = presetDocument({
    prompts: [
      { identifier: "main", content: "开场" },
      // `quietPrompt` is a real SillyTavern prompt (`openai.js:1229` reads `prompts.get('quietPrompt')`) that
      // this product's table does not carry, so it is the fixture for "a marker outside the table" rather than
      // a name invented for the test.
      { identifier: "quietPrompt", marker: true },
      { identifier: "chatHistory", marker: true },
    ],
    order: ["main", "quietPrompt", "chatHistory"],
  });
  assert.throws(
    () => assemblePreset(unknownMarker, { macros: MACROS, markers: { quietPrompt: "旁白指令" } }),
    /preset_marker_not_in_table:quietPrompt/,
  );

  const dangling = presetDocument({
    prompts: [
      { identifier: "main", content: "开场" },
      { identifier: "chatHistory", marker: true },
    ],
    order: ["main", "ghost", "chatHistory"],
  });
  assert.throws(
    () => assemblePreset(dangling, { macros: MACROS, markers: {} }),
    /preset_order_references_undefined_prompt:ghost/,
  );
});

test("a document whose order cannot decide the prompt is refused by name", () => {
  assert.throws(() => assemblePreset(null, { macros: MACROS, markers: {} }), /preset_document_not_object/);
  assert.throws(() => assemblePreset({ prompts: [] }, { macros: MACROS, markers: {} }), /preset_prompt_order_missing/);
  assert.throws(
    () => assemblePreset({ prompts: {}, prompt_order: [] }, { macros: MACROS, markers: {} }),
    /preset_prompts_not_array/,
  );
  assert.throws(
    () =>
      assemblePreset(presetDocument({ prompts: [{ identifier: "main", content: "开场" }], order: ["main"] }), {
        macros: MACROS,
        markers: {},
      }),
    /preset_cut_point_missing/,
  );
  assert.throws(
    () =>
      assemblePreset(
        presetDocument({
          prompts: [
            { identifier: "main", content: "开场" },
            { identifier: "chatHistory", marker: true },
          ],
          order: ["main", "chatHistory", "chatHistory"],
        }),
        { macros: MACROS, markers: {} },
      ),
    /preset_cut_point_duplicate:chatHistory/,
  );
  assert.throws(
    () =>
      assemblePreset(
        presetDocument({
          prompts: [
            { identifier: "main", content: "开场" },
            { identifier: "main", content: "另一份开场" },
            { identifier: "chatHistory", marker: true },
          ],
          order: ["main", "chatHistory"],
        }),
        { macros: MACROS, markers: {} },
      ),
    /preset_prompt_identifier_duplicate:main/,
  );
  assert.throws(
    () =>
      assemblePreset(
        presetDocument({
          prompts: [
            { identifier: "main", content: "开场" },
            { identifier: "chatHistory", marker: true },
          ],
          order: ["main", { identifier: 7 as unknown as string, enabled: true }, "chatHistory"],
        }),
        { macros: MACROS, markers: {} },
      ),
    /preset_prompt_order_row_invalid:1/,
  );
});

test("a depth field the placement cannot read is refused by name", () => {
  assert.throws(
    () =>
      assemblePreset(
        depthDoc([
          { identifier: "note", content: "状态", injection_position: 1, injection_depth: -1, injection_order: 100 },
        ]),
        { macros: MACROS, markers: {} },
      ),
    /preset_injection_depth_invalid:note:-1/,
  );
  assert.throws(
    () =>
      assemblePreset(
        depthDoc([
          { identifier: "note", content: "状态", injection_position: 1, injection_depth: 1.5, injection_order: 100 },
        ]),
        { macros: MACROS, markers: {} },
      ),
    /preset_injection_depth_invalid:note:1.5/,
  );
  assert.throws(
    () =>
      assemblePreset(
        depthDoc([
          {
            identifier: "note",
            content: "状态",
            injection_position: 1,
            injection_depth: 1,
            injection_order: "high" as unknown as number,
          },
        ]),
        { macros: MACROS, markers: {} },
      ),
    /preset_injection_order_invalid:note:high/,
  );
});

test("depthInsertionIndex clamps a deeper-than-history depth to the start and appends at zero", () => {
  assert.equal(depthInsertionIndex(4, 0), 4);
  assert.equal(depthInsertionIndex(4, 1), 3);
  assert.equal(depthInsertionIndex(4, 4), 0);
  assert.equal(depthInsertionIndex(4, 5), 0);
  assert.equal(depthInsertionIndex(0, 3), 0);
});

test("the assembly is pure: the same document and the same facts produce the same segments", () => {
  const first = assemblePreset(REALISTIC_DOC, { macros: MACROS, markers: FILLED_MARKERS });
  const second = assemblePreset(REALISTIC_DOC, { macros: MACROS, markers: FILLED_MARKERS });

  assert.deepEqual(second, first);
});
