/**
 * The preset assembler: one imported SillyTavern preset document plus the assembly's own card/catalog
 * facts, resolved into the three segments `design/architecture/tavern-preset-compatibility.md` §2.4 rules
 * for. Pure - no store, no persistence, no network: the same document and the same facts always produce
 * the same segments.
 *
 * What each segment IS, in the design's own terms (§2.4):
 *  - `before` - the stable prefix, in the preset's own `prompt_order`, up to the `chatHistory` marker.
 *  - `after` - what follows that marker: the post-history entries, sent after the transcript.
 *  - `depth` - entries with `injection_position === 1`, which ignore the drag order and are placed inside
 *    the transcript by `injection_depth`.
 *
 * The two rulings this module is the single implementation of:
 *  - §2.5 - a marker is a SLOT, not a content source. `worldInfoBefore`/`worldInfoAfter`/`personaDescription`/
 *    `charDescription`/`charPersonality`/`scenario`/`dialogueExamples` are filled from the assembly's own
 *    sources (this product's card, catalogue, world-book material and the player's own persona); a slot with no
 *    source is named in `unfilled` instead of being blanked. There is no "preset world book versus card world
 *    book" order to invent - the marker says where the bound book goes, not what goes in it.
 *  - §6 S3/S4 - a real preset's markers are either filled or named, and the four depth boundaries below are
 *    the only places the depth list's meaning can be lost.
 *
 * `main` and `jailbreak` are content-type entries rather than marker placeholders (A4 §2.1), and the card
 * OVERRIDES them when it wrote its own (`system_prompt` / `post_history_instructions`, A4 §3.2, pref-on by
 * default in SillyTavern). So they need no special case here: `ctx.markers` is consulted for every entry
 * first, and an entry with no source of its own falls back to the text the preset author wrote. Dropping
 * that fallback would discard the Main Prompt of every real preset - the 破限 text §2.7 exists to preserve.
 *
 * The variable table of §2.6 belongs to one ASSEMBLY, and it lives in the evaluator (`preset-macros.ts`).
 * This module hands each entry the same `ctx.macros` object and adds the one field only it can know -
 * `itemId`, the preset entry's own identity, which is what seeds §2.7's content-addressed draws.
 */
import { evaluatePresetText, type MacroContext } from "./preset-macros.js";
import { PRESET_MARKERS, type PresetMarkerKind, selectedPromptOrderGroup } from "./preset-placement.js";

/** The marker table is re-published here because this module is where a marker's MEANING is consumed (§2.5). */
export { PRESET_MARKERS, type PresetMarkerKind };

export type PresetSegment = {
  identifier: string;
  role: "system" | "user" | "assistant";
  text: string;
  unresolved: readonly string[];
};
export type PresetDepthBlock = PresetSegment & { depth: number; order: number };
export type PresetAssembly = {
  /** Entries positioned before the chatHistory marker, in prompt_order sequence. */
  before: readonly PresetSegment[];
  /** Entries after it. */
  after: readonly PresetSegment[];
  /** `injection_position === 1`, sorted by depth DESC then injection_order ASC. */
  depth: readonly PresetDepthBlock[];
  /** Every marker that has no content source yet - named, never silently dropped. */
  unfilled: readonly string[];
  /** Every entry skipped because enabled === false. */
  disabled: readonly string[];
};

/** One prompt definition from `prompts[]`, still raw where a decision has not been made yet. */
type PresetPromptDefinition = {
  identifier: string;
  marker: boolean;
  role: PresetSegment["role"];
  content: string;
  /** The definition's mirror of the switch; `prompt_order[].enabled` wins when both are present. */
  enabled: unknown;
  injectionPosition: unknown;
  injectionDepth: unknown;
  injectionOrder: unknown;
};

/**
 * Turns a preset document into the segments one assembly sends.
 *
 * Refusals are named and thrown (`preset_*` codes) rather than skipped: a `prompt_order` row that names no
 * prompt, a `marker: true` entry outside `PRESET_MARKERS`, and an `injection_position` this product has no
 * placement for are all cases where continuing would mean guessing at a prompt. A switched-OFF entry is not
 * one of them: ST never reads it, so it is listed in `disabled` and its position/trigger fields are not
 * judged (a preset whose off entry carries odd fields still imports).
 */
export function assemblePreset(
  doc: unknown,
  ctx: { macros: MacroContext; markers: Partial<Record<string, string>> },
): PresetAssembly {
  const definitions = readPromptDefinitions(doc);
  const order = readPromptOrder(doc);
  const before: PresetSegment[] = [];
  const after: PresetSegment[] = [];
  const depth: PresetDepthBlock[] = [];
  const unfilled: string[] = [];
  const disabled: string[] = [];
  let cutRowPresent = false;
  let cutSeen = false;
  let pastCut = false;

  for (const row of order) {
    const identifier = row.identifier;
    const definition = definitions.get(identifier);
    if (definition === undefined) throw new Error(`preset_order_references_undefined_prompt:${identifier}`);
    const kind = definition.marker ? markerKindOf(identifier) : undefined;
    if (kind === "cut") cutRowPresent = true;
    if (!switchIsOn(row, definition)) {
      pushOnce(disabled, identifier);
      continue;
    }
    if (definition.marker && kind === undefined) throw new Error(`preset_marker_not_in_table:${identifier}`);
    if (kind === "cut") {
      if (cutSeen) throw new Error(`preset_cut_point_duplicate:${identifier}`);
      cutSeen = true;
      pastCut = true;
      continue;
    }

    const injectionPosition = injectionPositionOf(identifier, definition);
    const segment = resolveSegment(identifier, definition, ctx);
    if (segment === undefined) {
      if (definition.marker) pushOnce(unfilled, identifier);
      continue;
    }
    if (injectionPosition === 1) {
      depth.push({
        ...segment,
        depth: injectionDepthOf(identifier, definition),
        order: injectionOrderOf(identifier, definition),
      });
      continue;
    }
    (pastCut ? after : before).push(segment);
  }

  if (!cutRowPresent) throw new Error("preset_cut_point_missing");
  depth.sort(compareDepthBlocks);
  return { before, after, depth, unfilled, disabled };
}

/**
 * Where the consumer inserts one depth block: `messages.length - depth`, clamped to the start of the history
 * region.
 *
 * Handed the CURRENT length, once per block, in `depth` order - which is what makes the list's ordering
 * mean something (A4 §2.3, SillyTavern's own splice loop):
 *  - `depth === 0` - `historyLength`, i.e. after the last message, closest to generation.
 *  - `depth === historyLength` (or deeper) - `0`: the block starts the history. A depth deeper than the
 *    history is a position the trimmed history no longer has, not a reason to drop the text; a boundary trim
 *    removes rows from the OLD end, and a depth is measured from the new end, so no trim can orphan it.
 *  - several blocks at one depth, ascending `injection_order` - each insertion lands after the previous one,
 *    so the lower order ends up earlier in the request, exactly as A4 §2.3 states.
 */
export function depthInsertionIndex(historyLength: number, depth: number): number {
  return Math.max(0, historyLength - depth);
}

/** Deepest first, then ascending `injection_order`; ties keep `prompt_order`, which the sort is stable on. */
function compareDepthBlocks(a: PresetDepthBlock, b: PresetDepthBlock): number {
  return b.depth - a.depth || a.order - b.order;
}

function markerKindOf(identifier: string): PresetMarkerKind | undefined {
  return Object.hasOwn(PRESET_MARKERS, identifier)
    ? (PRESET_MARKERS as Readonly<Record<string, PresetMarkerKind>>)[identifier]
    : undefined;
}

/**
 * The text one entry contributes, or `undefined` when it contributes none.
 *
 * One resolution for slots and content entries alike: the assembly's own source for that identifier first,
 * then the text the preset author wrote. A source that is absent or blank is no source.
 *
 * An entry that renders to zero characters is not sent - it would reach the model as nothing, and a
 * `{{setvar}}`-only entry exists for its side effect. Only a MARKER is named in `unfilled` when it has no
 * content: a slot with nothing in it is a wiring fact about this product, while an author's empty entry is
 * the author's own text.
 */
function resolveSegment(
  identifier: string,
  definition: PresetPromptDefinition,
  ctx: { macros: MacroContext; markers: Partial<Record<string, string>> },
): PresetSegment | undefined {
  const marker = ctx.markers[identifier];
  const source = typeof marker === "string" && marker.trim().length > 0 ? marker : definition.content;
  if (source.trim().length === 0) return undefined;
  const outcome = evaluatePresetText(source, { ...ctx.macros, itemId: identifier });
  if (outcome.text.trim().length === 0) return undefined;
  const unresolved = [...outcome.unresolved];
  for (const name of outcome.unknown) if (!unresolved.includes(name)) unresolved.push(name);
  return { identifier, role: definition.role, text: outcome.text, unresolved };
}

/**
 * The authoritative switch. SillyTavern reads `prompt_order[].enabled`; `prompts[].enabled` is the leftover
 * mirror, consulted only for a document that carries one of the two.
 */
function switchIsOn(row: PresetOrderRow, definition: PresetPromptDefinition): boolean {
  if (typeof row.enabled === "boolean") return row.enabled;
  if (typeof definition.enabled === "boolean") return definition.enabled;
  return true;
}

function injectionPositionOf(identifier: string, definition: PresetPromptDefinition): 0 | 1 {
  const value = definition.injectionPosition;
  if (value === undefined) return 0;
  if (value === 0 || value === 1) return value;
  throw new Error(`preset_injection_position_unknown:${identifier}:${String(value)}`);
}

function injectionDepthOf(identifier: string, definition: PresetPromptDefinition): number {
  const value = definition.injectionDepth;
  if (value === undefined) return 0;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new Error(`preset_injection_depth_invalid:${identifier}:${String(value)}`);
}

function injectionOrderOf(identifier: string, definition: PresetPromptDefinition): number {
  const value = definition.injectionOrder;
  if (value === undefined) return 0;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  throw new Error(`preset_injection_order_invalid:${identifier}:${String(value)}`);
}

function pushOnce(list: string[], identifier: string): void {
  if (!list.includes(identifier)) list.push(identifier);
}

function readPromptDefinitions(doc: unknown): ReadonlyMap<string, PresetPromptDefinition> {
  const record = asRecord(doc);
  if (record === undefined) throw new Error("preset_document_not_object");
  if (!Array.isArray(record.prompts)) throw new Error("preset_prompts_not_array");
  const byIdentifier = new Map<string, PresetPromptDefinition>();
  for (const entry of record.prompts) {
    const definition = asRecord(entry);
    if (definition === undefined || typeof definition.identifier !== "string")
      throw new Error("preset_prompt_definition_invalid");
    const identifier = definition.identifier;
    if (byIdentifier.has(identifier)) throw new Error(`preset_prompt_identifier_duplicate:${identifier}`);
    byIdentifier.set(identifier, {
      identifier,
      marker: definition.marker === true,
      role: roleOf(definition.role),
      content: typeof definition.content === "string" ? definition.content : "",
      enabled: definition.enabled,
      injectionPosition: definition.injection_position,
      injectionDepth: definition.injection_depth,
      injectionOrder: definition.injection_order,
    });
  }
  return byIdentifier;
}

/** One validated `prompt_order[].order` row: the identifier it names and the switch it carries. */
type PresetOrderRow = { identifier: string; enabled: unknown };

/**
 * The `order` rows this preset actually assembles, in their own sequence.
 *
 * Which group is `preset-placement.ts`'s ladder and not a second decision here: ST's chat-completion path reads
 * `character_id` 100001 (`openai.js:698` overriding `PromptManager.js:336`), a legacy preset carries only
 * 100000, and the ladder picks the first of those the document has. The two readings - this assembly and that
 * module's placements - must never disagree about it.
 */
function readPromptOrder(doc: unknown): readonly PresetOrderRow[] {
  const record = asRecord(doc);
  if (record === undefined) throw new Error("preset_document_not_object");
  const chosen = selectedPromptOrderGroup(Array.isArray(record.prompt_order) ? record.prompt_order : []);
  if (chosen === undefined) throw new Error("preset_prompt_order_missing");
  return (chosen.order as readonly unknown[]).map((row, position) => {
    const order = asRecord(row);
    if (order === undefined || typeof order.identifier !== "string")
      throw new Error(`preset_prompt_order_row_invalid:${position}`);
    return { identifier: order.identifier, enabled: order.enabled };
  });
}

function roleOf(value: unknown): PresetSegment["role"] {
  return value === "user" || value === "assistant" ? value : "system";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
