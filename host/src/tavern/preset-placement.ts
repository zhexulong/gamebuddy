/**
 * Where each of a preset's entries lands: `design/architecture/tavern-preset-compatibility.md` §2.4's three
 * segments plus the three ways an entry reaches none of them.
 *
 * This is a DIFFERENT question from "what text does the entry contribute" (`preset-assembler.ts`), and it is
 * answered from the document's own `prompt_order` alone: enabled or not, on which side of the `chatHistory` cut,
 * and whether `injection_position === 1` sends it into the transcript by depth.
 *
 * Why the marker table lives here rather than in the assembler: `tools/check-preset-macros.mjs` has to judge
 * §4.2's segment policy on the ORIGINAL document, and Node loads a TypeScript module for that gate only when the
 * module carries no relative imports (`preset-assembler.ts` imports `./preset-macros.js`, which Node cannot
 * resolve back to the source). So the closed marker set and the placement reading sit in one import-free module,
 * and the assembler imports them from here - one table, one reading, no second copy to drift.
 *
 * `preset-placement.private.test.ts` holds this module to the assembler's REAL output: every entry's segment here must
 * be the bucket `assemblePreset` put it in, for a document that exercises all of them.
 */

/** What a marker in a preset's `prompt_order` does: cut the prompt in two, or hold a slot's content. */
export type PresetMarkerKind = "cut" | "slot";

/**
 * The marker table - the closed set of preset `identifier`s whose content this product supplies or whose
 * position it must honour. Exactly one entry cuts the prompt in two; the rest are slots.
 *
 * `chatHistory` emits nothing at all (A4 §2.3: it is the marker that says where the transcript goes), so it
 * is neither a slot nor counted as unfilled. Everything else is filled from the assembly's markers and named
 * as unfilled when that source is absent - including `main` and `jailbreak`, which the preset itself may
 * textually fill.
 *
 * `personaDescription` is the player's own persona, not the card's: `PromptManager.js:306` lists it among the
 * prompt sources and `openai.js:1432-1435` pushes it as a `system` message under exactly this identifier. It
 * is a slot like the card fields, so an assembly with no persona source - the ordinary player who never wrote
 * one - names it in `unfilled` (design §2.5) instead of refusing the document or dropping it silently. Its
 * position is visible in the request, which is why the group it comes from matters at all (see
 * `selectedPromptOrderGroup`).
 */
export const PRESET_MARKERS = Object.freeze({
  chatHistory: "cut",
  worldInfoBefore: "slot",
  worldInfoAfter: "slot",
  personaDescription: "slot",
  charDescription: "slot",
  charPersonality: "slot",
  scenario: "slot",
  dialogueExamples: "slot",
  main: "slot",
  jailbreak: "slot",
} as const satisfies Readonly<Record<string, PresetMarkerKind>>);

/**
 * The segments an entry can land in, plus the three that carry no text: `cut` is the marker that decides where
 * `before` ends, `disabled` is a switched-off row, and `unplaced` is a row naming a prompt the document does not
 * define (SillyTavern never sends it either).
 */
export type PresetEntrySegment = "before" | "after" | "depth" | "cut" | "disabled" | "unplaced";

/** One `prompt_order` row, in the order the preset assembles it, with the segment it lands in. */
export type PresetEntryPlacement = Readonly<{ identifier: string; segment: PresetEntrySegment }>;

/**
 * The chat-completion prompt order id. `PromptManager.js:336` is the base class default -
 * `promptOrder: { strategy: 'global', dummyId: 100000 }`, the single group a preset written by the stock
 * prompt manager ships - and `openai.js:696-700` OVERRIDES it for the chat-completion path this product runs:
 * `promptOrder: { strategy: 'global', dummyId: 100001 }`. `PromptManager.js:438` copies that id into
 * `activeCharacter` and `:1207-1209` then finds the group as
 * `prompt_order.find(list => String(list.character_id) === String(character.id))`, so 100001 is the id the
 * wire really reads. It is the group that carries the extra `personaDescription` slot.
 */
const CHAT_COMPLETION_PROMPT_ORDER_ID = 100001;
/** The base class default (`PromptManager.js:336`): the only group a legacy preset ships on its own. */
const LEGACY_PROMPT_ORDER_ID = 100000;

/**
 * The one refusal that means "this document declares no placement at all", which a caller must read differently
 * from "the order is broken": a single prompt entry is not a preset whose segments were checked.
 */
export const PRESET_SEGMENTS_ORDER_MISSING = "preset_segments_order_missing";

type PresetPlacementDefinition = {
  readonly marker: boolean;
  readonly enabled: unknown;
  readonly injectionPosition: unknown;
};

type PresetPlacementRow = { readonly identifier: string; readonly enabled: unknown };

/**
 * Every entry the preset's chosen `prompt_order` rows place, in assembly order.
 *
 * The refusals are the three facts without which there is no order to read at all, and they are named instead
 * of defaulted: a document with no order has no segments, which the caller must report rather than treat as
 * "nothing landed in `before`". Content-level refusals (a marker outside the table, a duplicate cut, a depth
 * field that cannot be read) belong to the assembler, which refuses the whole document before it sends anything.
 */
export function presetEntryPlacements(doc: unknown): readonly PresetEntryPlacement[] {
  const definitions = readDefinitions(doc);
  const placements: PresetEntryPlacement[] = [];
  let pastCut = false;
  for (const row of readOrderRows(doc)) {
    const definition = definitions.get(row.identifier);
    if (definition === undefined) {
      placements.push(Object.freeze({ identifier: row.identifier, segment: "unplaced" }));
      continue;
    }
    if (!switchIsOn(row, definition)) {
      placements.push(Object.freeze({ identifier: row.identifier, segment: "disabled" }));
      continue;
    }
    if (definition.marker && markerKindOf(row.identifier) === "cut") {
      pastCut = true;
      placements.push(Object.freeze({ identifier: row.identifier, segment: "cut" }));
      continue;
    }
    if (definition.injectionPosition === 1)
      placements.push(Object.freeze({ identifier: row.identifier, segment: "depth" }));
    else placements.push(Object.freeze({ identifier: row.identifier, segment: pastCut ? "after" : "before" }));
  }
  return Object.freeze(placements);
}

/**
 * The authoritative switch, as `preset-assembler.ts` reads it: `prompt_order[].enabled` wins, `prompts[].enabled`
 * is the leftover mirror, and a row carrying neither is on.
 */
function switchIsOn(row: PresetPlacementRow, definition: PresetPlacementDefinition): boolean {
  if (typeof row.enabled === "boolean") return row.enabled;
  if (typeof definition.enabled === "boolean") return definition.enabled;
  return true;
}

function markerKindOf(identifier: string): PresetMarkerKind | undefined {
  return Object.hasOwn(PRESET_MARKERS, identifier)
    ? (PRESET_MARKERS as Readonly<Record<string, PresetMarkerKind>>)[identifier]
    : undefined;
}

function readDefinitions(doc: unknown): ReadonlyMap<string, PresetPlacementDefinition> {
  const record = asRecord(doc);
  if (record === undefined) throw new Error("preset_segments_document_not_object");
  if (!Array.isArray(record.prompts)) throw new Error("preset_segments_prompts_not_array");
  const byIdentifier = new Map<string, PresetPlacementDefinition>();
  for (const entry of record.prompts) {
    const definition = asRecord(entry);
    if (definition === undefined || typeof definition.identifier !== "string")
      throw new Error("preset_segments_prompt_invalid");
    byIdentifier.set(definition.identifier, {
      marker: definition.marker === true,
      enabled: definition.enabled,
      injectionPosition: definition.injection_position,
    });
  }
  return byIdentifier;
}

/**
 * Which `prompt_order` group a preset assembles, first match wins - a LADDER, never one hardcoded id:
 *
 *  1. `character_id === 100001` - SillyTavern 1.19's chat-completion group (`openai.js:698` overriding
 *     `PromptManager.js:336`), the one that also carries `personaDescription`;
 *  2. `character_id === 100000` - the base class's single group, which is all a legacy preset ships (our own
 *     `assets/tavern/presets/amber-deepseek-v4.1.json` is one, and ST's `PromptManager` writes presets in
 *     this shape);
 *  3. the document's first readable group - an id neither of the two above, which ST would only reach for that
 *     one character.
 *
 * Two ids rather than one because an official preset and a legacy preset disagree about which groups exist:
 * selecting 100001 alone makes every single-group 100000 preset unreadable, and selecting 100000 alone is what
 * ST's chat-completion path does not do. The ladder is what lets a legacy preset keep working while an official
 * one picks up its extra slot.
 *
 * Both readers - this module's placements and `preset-assembler.ts` - call this function, so "which group" is
 * one decision in one place; `undefined` means the document declares no readable group at all, which each
 * caller names with its own code.
 */
export function selectedPromptOrderGroup(promptOrder: readonly unknown[]): Record<string, unknown> | undefined {
  const groups: Record<string, unknown>[] = [];
  for (const entry of promptOrder) {
    const candidate = asRecord(entry);
    if (candidate === undefined || !Array.isArray(candidate.order)) continue;
    groups.push(candidate);
  }
  // Compared as strings, exactly as `PromptManager.js:1207-1209` does, so a document that wrote the id as a
  // string is read the same way SillyTavern reads it.
  const firstWith = (characterId: number): Record<string, unknown> | undefined =>
    groups.find((group) => String(group.character_id) === String(characterId));
  return firstWith(CHAT_COMPLETION_PROMPT_ORDER_ID) ?? firstWith(LEGACY_PROMPT_ORDER_ID) ?? groups[0];
}

/**
 * The rows the preset actually assembles: the ladder's group, in its own row sequence.
 */
function readOrderRows(doc: unknown): readonly PresetPlacementRow[] {
  const record = asRecord(doc);
  if (record === undefined) throw new Error("preset_segments_document_not_object");
  const chosen = selectedPromptOrderGroup(Array.isArray(record.prompt_order) ? record.prompt_order : []);
  if (chosen === undefined) throw new Error(PRESET_SEGMENTS_ORDER_MISSING);
  return (chosen.order as readonly unknown[]).map((row, position) => {
    const order = asRecord(row);
    if (order === undefined || typeof order.identifier !== "string")
      throw new Error(`preset_segments_order_row_invalid:${position}`);
    return { identifier: order.identifier, enabled: order.enabled };
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
