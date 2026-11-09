/**
 * The preset macro evaluator: the one reading of a SillyTavern preset's `{{...}}` tokens.
 *
 * Two boundaries here are design rulings, not implementation choices
 * (`design/architecture/tavern-preset-compatibility.md`):
 *
 *  - §2.6 - the variable table is ASSEMBLY-scoped. `{{setvar}}` / `{{getvar}}` / `{{addvar}}` live and die
 *    inside one `evaluatePresetText` call, so two calls never see each other's variables and nothing reaches
 *    durable storage. `addvar` is append, which is the only use a real preset has for it: collecting several
 *    switch-selected fragments into one string during the assembly that reads them.
 *  - §2.7 - `{{random}}` / `{{pick}}` are CONTENT-ADDRESSED. A turn index, a clock or `Math.random` may not
 *    enter the seed: the stable prefix has to be byte-identical on every turn of a conversation, or the
 *    prompt cache that prefix exists for is lost on the next turn.
 *
 * A macro this evaluator cannot resolve is never blanked. The token stays in the text and its name is
 * reported in `unresolved` (recognised, deliberately not evaluated) or `unknown` (absent from
 * `PRESET_MACROS`); the caller decides what the player sees.
 */

export type MacroContext = {
  char: string;
  user: string;
  description: string;
  personality: string;
  scenario: string;
  persona: string;
  /** Stable identity of the preset entry being rendered; seeds content-addressed picks. */
  itemId: string;
};

export type MacroOutcome = {
  text: string;
  /** Macro names that were recognised but NOT evaluated. Never silently emptied. */
  unresolved: readonly string[];
  /** Names absent from the table: spellings no authority defines, never macros this product declined. */
  unknown: readonly string[];
};

/** `tail-only` macros read state that changes every turn, so the stable prefix must not carry them. */
export type PresetMacroSegmentPolicy = "any" | "tail-only";

export type PresetMacroTableEntry = {
  readonly name: string;
  readonly implemented: boolean;
  readonly segmentPolicy: PresetMacroSegmentPolicy;
  readonly reason: string;
};

function presetMacro(
  name: string,
  implemented: boolean,
  segmentPolicy: PresetMacroSegmentPolicy,
  reason: string,
): PresetMacroTableEntry {
  return Object.freeze({ name, implemented, segmentPolicy, reason });
}

/**
 * Every macro name this product has a position on. A preset may spell any of them; only the entries whose
 * `implemented` is true are evaluated, and the rest are reported by name instead of disappearing.
 *
 * The population is A4 §7.2: every macro name that guide's table lists has an entry here, either implemented or
 * declared unimplemented with the concrete blocker in `reason`. `unknown` is therefore reserved for a spelling no
 * authority defines - a typo - and never for a macro this product has read and declined.
 *
 * The table is also the population `tools/check-preset-macros.mjs` judges a real preset against, so a name that is
 * absent here is a name the gate reports as unknown rather than one that silently renders empty.
 */
export const PRESET_MACROS: readonly PresetMacroTableEntry[] = Object.freeze([
  presetMacro("char", true, "any", "The companion's name, taken from the assembly context."),
  presetMacro("user", true, "any", "The player's name, taken from the assembly context."),
  presetMacro("description", true, "any", "The character description field the assembly was given."),
  presetMacro("personality", true, "any", "The personality field the assembly was given."),
  presetMacro("scenario", true, "any", "The scenario field the assembly was given."),
  presetMacro("persona", true, "any", "The player persona field the assembly was given."),
  presetMacro("trim", true, "any", "Renders nothing and removes the whitespace around the entry it appears in."),
  presetMacro("newline", true, "any", "Renders one newline."),
  presetMacro(
    "setvar",
    true,
    "any",
    "Writes the assembly-scoped variable table and renders nothing; the table dies with the call (§2.6).",
  ),
  presetMacro("getvar", true, "any", "Reads the assembly-scoped variable table; an unset name reads empty."),
  presetMacro("addvar", true, "any", "Appends to the assembly-scoped variable table (§2.6)."),
  presetMacro(
    "random",
    true,
    "any",
    "Content-addressed draw (§2.7): the same entry and candidates pick the same option on every turn.",
  ),
  presetMacro("pick", true, "any", "The same content-addressed draw as `random` (§2.7)."),
  presetMacro(
    "if",
    false,
    "any",
    "The `{{if}}`/`{{else}}`/`{{/if}}` block needs a scoped conditional evaluator, which is separate work from this table.",
  ),
  presetMacro("else", false, "any", "Part of the `{{if}}` block; the block is not evaluated."),
  presetMacro("/if", false, "any", "Part of the `{{if}}` block; the block is not evaluated."),
  presetMacro(
    "incvar",
    false,
    "any",
    "Numeric accumulation is cross-turn state by definition, which §2.6 rules out of an assembly-scoped table.",
  ),
  presetMacro("decvar", false, "any", "The decrement half of the same cross-turn accumulation §2.6 rules out."),
  presetMacro(
    "lastusermessage",
    false,
    "tail-only",
    "Reads the conversation, so it changes every turn and would rewrite the cached prefix each turn.",
  ),
  presetMacro(
    "lastcharmessage",
    false,
    "tail-only",
    "Reads the conversation, so it changes every turn and would rewrite the cached prefix each turn.",
  ),
  presetMacro(
    "lastmessage",
    false,
    "tail-only",
    "Reads the conversation, so it changes every turn and would rewrite the cached prefix each turn.",
  ),
  presetMacro("lastchar", false, "tail-only", "The character-side message read, with the same per-turn change."),
  presetMacro("time", false, "tail-only", "Reads the clock, which changes on every turn of the same conversation."),
  presetMacro("date", false, "tail-only", "The same clock at day granularity: still changes between assemblies."),
  presetMacro("name", false, "any", "Instruct-track only; this product has no Instruct track (A4 §1)."),

  // requires_persistent_vars - a store that outlives one assembly, which §2.6 forbids this evaluator to have.
  presetMacro(
    "getglobalvar",
    false,
    "any",
    "Reads a global variable from SillyTavern's settings: a value that outlives the chat, where §2.6 has no store.",
  ),
  presetMacro(
    "setglobalvar",
    false,
    "any",
    "The write half of that settings store: the value has to survive the assembly, which §2.6 rules out.",
  ),
  presetMacro("addglobalvar", false, "any", "Appends to a global variable, so the result has to outlive the assembly."),
  presetMacro(
    "incglobalvar",
    false,
    "any",
    "Accumulates a global variable across turns, the cross-turn state §2.6 rules out.",
  ),
  presetMacro("decglobalvar", false, "any", "The decrement half of the same cross-turn global accumulation."),
  presetMacro(
    "delglobalvar",
    false,
    "any",
    "Deletes a global variable; §2.6's table dies with the call, so nothing outlives it for a delete to reach.",
  ),
  presetMacro(
    "deletevar",
    false,
    "any",
    "Deletes a variable that is meant to outlive the assembly; §2.6's table dies with the call, so there is nothing to delete.",
  ),

  // requires_scoped_evaluator - needs the scoped conditional evaluator the `if` entry above is also waiting on.
  presetMacro(
    "hasvar",
    false,
    "any",
    "Answers true/false for a variable name, and its only consumer is a `{{if}}` condition - the block this table cannot evaluate.",
  ),

  // requires_runtime_fact - a value the Host would have to measure or supply, which no assembly input carries.
  presetMacro(
    "system",
    false,
    "any",
    "Names the system prompt this assembly is producing, so at macro time the Host has no such value to substitute.",
  ),
  presetMacro(
    "original",
    false,
    "any",
    "Means the preset text a card's prompt override replaced; the evaluator is handed the override only, never the text it displaced.",
  ),
  presetMacro(
    "weekday",
    false,
    "tail-only",
    "Reads the clock at day granularity, so the value changes between assemblies.",
  ),
  presetMacro(
    "datetimeformat",
    false,
    "tail-only",
    "Formats the clock with a Moment.js pattern; any pattern finer than a day changes on every turn.",
  ),
  presetMacro(
    "isotime",
    false,
    "tail-only",
    "The clock at minute granularity, so it changes on every turn of one conversation.",
  ),
  presetMacro(
    "idleduration",
    false,
    "tail-only",
    "Times how long since the player last spoke: a fact the Host would have to measure, and one that changes every turn.",
  ),
  presetMacro(
    "model",
    false,
    "any",
    "The provider model in use: a Host fact, fixed for as long as the player keeps the model.",
  ),
  presetMacro("ismobile", false, "any", "The client form factor: a Host fact, fixed for the session."),
  presetMacro(
    "maxprompt",
    false,
    "any",
    "The context-window size the Host configured: a Host fact, fixed for the session.",
  ),

  // requires_not_implemented_track - the Instruct sequence this product does not have (A4 §1).
  presetMacro(
    "mesexamples",
    false,
    "any",
    "Formats the card's example dialogue into the Instruct sequence; this product has no Instruct track (A4 §1).",
  ),

  // out_of_scope_v1 - a mechanism this product's assembly does not have, for a reason that outlives v1.
  presetMacro(
    "mesexamplesraw",
    false,
    "any",
    "The raw example block is the `dialogueExamples` slot, which this assembly fills from the card itself; a macro re-injecting it would duplicate that slot.",
  ),
  presetMacro(
    "outlet",
    false,
    "any",
    "An outlet places a World Info entry from a prompt field; this assembly fills World Info slots by marker, so an in-prompt outlet has no target.",
  ),
  presetMacro(
    "roll",
    false,
    "any",
    "Dice are a tabletop mechanic: the companion's world state comes from the running game, so a rolled die has no consumer.",
  ),
  presetMacro(
    "summary",
    false,
    "tail-only",
    "The chat summary is written by SillyTavern's Summarize extension, which this product does not run.",
  ),
]);

const PRESET_MACRO_BY_NAME: ReadonlyMap<string, PresetMacroTableEntry> = new Map(
  PRESET_MACROS.map((entry) => [entry.name, entry]),
);

/** A `{{...}}` token as the preset wrote it, with the name this evaluator looks up. */
export type PresetMacroToken = {
  readonly raw: string;
  /** Lower-cased lookup name; the whole trimmed token body when it carries no identifier (`{{// note}}`). */
  readonly name: string;
};

const MACRO_NAME_PATTERN = /^\/?[A-Za-z_][A-Za-z0-9_]*/u;

/** The name a token's body is looked up by. Case is not significant (A4 §7.1). */
function macroName(body: string): string {
  const trimmed = body.trim();
  const match = MACRO_NAME_PATTERN.exec(trimmed);
  return (match?.[0] ?? trimmed).toLowerCase();
}

/** Where the `}}` closing the `{{` at `open` sits, counting the nested tokens in between (A4 §7.1). */
function closingBraces(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index + 1 < text.length; index++) {
    if (text.startsWith("{{", index)) {
      depth++;
      index++;
      continue;
    }
    if (!text.startsWith("}}", index)) continue;
    depth--;
    if (depth === 0) return index;
    index++;
  }
  return -1;
}

function collectTokens(text: string, found: PresetMacroToken[]): void {
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("{{", index);
    if (open < 0) return;
    const close = closingBraces(text, open);
    // An unterminated `{{` is literal text, not a macro: nothing follows it that could close it.
    if (close < 0) return;
    const raw = text.slice(open, close + 2);
    const name = macroName(text.slice(open + 2, close));
    found.push(Object.freeze({ raw, name: name.length > 0 ? name : raw }));
    collectTokens(text.slice(open + 2, close), found);
    index = close + 2;
  }
}

/**
 * Every `{{...}}` token in `text`, nested ones included, in the order the text spells them.
 *
 * This is the population the preset gate counts, so it reads source text only: the same scan decides both
 * which tokens a preset carries and which name each one is governed by.
 */
export function presetMacroTokens(text: string): readonly PresetMacroToken[] {
  const found: PresetMacroToken[] = [];
  collectTokens(text, found);
  return Object.freeze(found);
}

type EvaluationState = {
  readonly vars: Map<string, string>;
  readonly unresolved: string[];
  readonly unknown: string[];
  trim: boolean;
};

/** Literal nesting deeper than this is reported rather than evaluated; real presets nest one or two levels. */
const MAX_NESTING_DEPTH = 8;

function record(list: string[], name: string, raw: string): string {
  list.push(name.length > 0 ? name : raw);
  return raw;
}

/**
 * The content address of one draw (§2.7): 32-bit FNV-1a over the entry's stable identity and its candidate
 * list.
 *
 * The constant is a contract, not an implementation detail: changing it re-picks every `{{random}}` and
 * `{{pick}}` in every preset, which rotates the stable prefix of every conversation and costs the cache the
 * content addressing exists to keep. That is also why nothing per-turn - no index, no clock, no draw from
 * `Math.random` - may enter this source.
 */
function contentSeed(itemId: string, options: readonly string[]): number {
  const source = `${itemId}\u0000${options.join("::")}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

function applyMacro(
  name: string,
  args: readonly string[],
  ctx: MacroContext,
  state: EvaluationState,
  raw: string,
): string {
  switch (name) {
    case "char":
      return ctx.char;
    case "user":
      return ctx.user;
    case "description":
      return ctx.description;
    case "personality":
      return ctx.personality;
    case "scenario":
      return ctx.scenario;
    case "persona":
      return ctx.persona;
    case "newline":
      return "\n";
    case "trim":
      state.trim = true;
      return "";
    case "setvar": {
      const key = (args[0] ?? "").trim();
      if (key.length === 0) return record(state.unresolved, name, raw);
      state.vars.set(key, args.slice(1).join("::"));
      return "";
    }
    case "addvar": {
      const key = (args[0] ?? "").trim();
      if (key.length === 0) return record(state.unresolved, name, raw);
      state.vars.set(key, (state.vars.get(key) ?? "") + args.slice(1).join("::"));
      return "";
    }
    case "getvar": {
      const key = (args[0] ?? "").trim();
      if (key.length === 0) return record(state.unresolved, name, raw);
      return state.vars.get(key) ?? "";
    }
    case "random":
    case "pick": {
      if (args.length === 0) return record(state.unresolved, name, raw);
      return args[contentSeed(ctx.itemId, args) % args.length] ?? "";
    }
    default:
      return record(state.unresolved, name, raw);
  }
}

function renderToken(raw: string, body: string, ctx: MacroContext, state: EvaluationState, depth: number): string {
  const name = macroName(body);
  const entry = PRESET_MACRO_BY_NAME.get(name);
  if (entry === undefined) return record(state.unknown, name, raw);
  if (!entry.implemented || depth >= MAX_NESTING_DEPTH) return record(state.unresolved, name, raw);
  // Arguments are evaluated first, which is what makes `{{getvar::{{char}}_mood}}` legal (A4 §7.1): the inner
  // macro lands in the argument before the outer one reads it.
  const reportedBefore = state.unresolved.length;
  const args = evaluateText(body.trimStart().slice(name.length), ctx, state, depth + 1)
    .split("::")
    .slice(1);
  // An argument that still carries a macro AND that left a name unresolved was not readable: reading it would
  // substitute an empty value for a name this evaluator never resolved, which is the silent blanking the table
  // forbids. Braces that arrived from the context are data, and a value is never re-evaluated.
  const argumentUnresolved = state.unresolved.length > reportedBefore && args.some((arg) => arg.includes("{{"));
  if (argumentUnresolved) return record(state.unresolved, name, raw);
  return applyMacro(name, args, ctx, state, raw);
}

function evaluateText(text: string, ctx: MacroContext, state: EvaluationState, depth: number): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("{{", index);
    if (open < 0) return output + text.slice(index);
    output += text.slice(index, open);
    const close = closingBraces(text, open);
    if (close < 0) return output + text.slice(open);
    output += renderToken(text.slice(open, close + 2), text.slice(open + 2, close), ctx, state, depth);
    index = close + 2;
  }
  return output;
}

/** Evaluates `text` against one assembly's context. Every variable the text writes dies with this call. */
export function evaluatePresetText(text: string, ctx: MacroContext): MacroOutcome {
  const state: EvaluationState = { vars: new Map(), unresolved: [], unknown: [], trim: false };
  const rendered = evaluateText(text, ctx, state, 0);
  return Object.freeze({
    text: state.trim ? rendered.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "") : rendered,
    unresolved: Object.freeze([...new Set(state.unresolved)]),
    unknown: Object.freeze([...new Set(state.unknown)]),
  });
}
