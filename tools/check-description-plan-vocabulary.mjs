#!/usr/bin/env node
/**
 * A description may only teach plan-authoring syntax the compiler accepts.
 *
 * WHY. Two strings the Game surface hands the model still taught a form the product deleted, in the form's own
 * vocabulary, after the compiler had stopped accepting it:
 *
 *   protocol/bridge-v1.schema.json `tileAreaRow.occupantKind`
 *     "What stands on this tile in the words a `for_each` `where: [{ occupant: ... }]` filter and an action's `Clears`
 *      declaration use - ..."
 *   host/src/game-tools.ts `stardew_observe`
 *     "occupantKind (what stands there in the very words a for_each `where: [{ occupant: ... }]` filter takes, so a row
 *      can be filtered with the same word a loop is written in)"
 *
 * `for_each` is not a builder method (`host/src/body-program-script.ts` `PLAN_FORM_ACTION_IDS` is empty - "there is no
 * second vocabulary in this compiler at all"), the preflight refuses a node carrying the form's document by name
 * (`plan_form_not_declared`), and the words those two sentences named are refused as a script's vocabulary
 * (`plan_script_uses_forbidden`, `plan_script_argument_not_canonical`). A description that spells a form out in the
 * syntax the compiler rejects teaches a call that can only be dropped, which is the same defect `two_ways_to_write_a_loop`
 * catches inside the planner's own text (`host/src/body-program-script.test.ts`) - one population short: it reads
 * `planWorkDescription` and nothing else, so two shipped descriptions carried the removed form for as long as they did.
 *
 * THE POPULATION is every string the Host hands a model as a description or a schema description, walked rather than
 * listed:
 *
 *   host/src/**\/*.ts (not `*.test.ts`)   every `description:` key whose value is a string literal, and whose value is a
 *                                        call to a function THIS TREE declares (the planner's guidance, which is one
 *                                        expression built out of literals in `body-program-script.ts`). A tool that is
 *                                        renamed, added or moved is a new member of the walk, because the walk is the
 *                                        directory and the key, not a table.
 *   protocol/bridge-v1.schema.json       every `description` string, by JSON pointer.
 *
 * Both measured sites are ANCHORS (`MEASURED_SITES`): a run that no longer finds a description attributed to
 * `stardew_observe` or the pointer `#/$defs/tileAreaRow/properties/occupantKind` is `description_population_unanchored`,
 * blocked - a population that quietly stopped covering the sentences this gate exists for would otherwise print green.
 * A description is attributed to a TOOL by the `defineTool({ ... })` literal it sits in, so a reformat or a file move
 * keeps the anchor and only a removal loses it.
 *
 * THE PROPERTY: no description names a plan form, keyword or loop vocabulary the compiler refuses. The words are DERIVED
 * FROM THE COMPILER'S OWN REFUSALS on every run, never typed here:
 *
 *   plan_script_unknown_action:<id>     the form ids the Mod publishes as FORMS and the compiler has no builder method
 *                                       for: `FarmhandPlanFormCatalog`'s `<Name>ActionId` constants, minus
 *                                       `PLAN_FORM_ACTION_IDS` (the compiler's own declaration) and minus the action ids
 *                                       `action-surface.v1.json` publishes (`planActionsFromRegistrations` admits exactly
 *                                       those). This is the retired `FOR_EACH_PLAN_ACTION_ID`, read from where it is still
 *                                       written down.
 *   plan_form_not_declared              the form's document: its one argument (`LOOP_ARGUMENT`,
 *                                       `host/src/body-program-preflight.ts`) and the keys the Mod's one reader parses it
 *                                       with (`FarmhandForEachArguments.LoopKeys`, "the one source of the words it refuses
 *                                       with"). Written as an action's argument today, one of these words is answered
 *                                       `plan_script_argument_not_canonical:<action>:<path>`.
 *   plan_script_uses_forbidden:<name>   `FORBIDDEN_PLAN_REFERENCES` in the compiler: the names a script may not use at all.
 *
 * Each of those three refusal codes is an anchor too (`plan_script_uses_forbidden:` and
 * `plan_script_argument_not_canonical:` in the compiler, `plan_form_not_declared` in the preflight): a code that moved is
 * `refusal_code_unanchored`, because a vocabulary this gate judges against a refusal nothing produces any more is a list
 * again.
 *
 * WHERE A WORD COUNTS asks how the description marked it, not what it means. A word with no letters a sentence can share
 * (`for_each`, `Math.random`, `XMLHttpRequest` - an underscore, a dot, a camel hump) is matched ANYWHERE, because English
 * does not spell one; an ordinary word (`where`, `source`, `do`, `loop`, `this`, `arguments`, `await`) is matched where the
 * description marks it as CODE - inside a backticked span, or followed by `:` as a document key - because `the arguments
 * each declares` is prose and `` `arguments` `` is a call the model would copy. The rule is mechanical and it is what
 * keeps `row` and `occupant` (a tile-area answer's own fields, with live producers) out of the vocabulary while `for_each`
 * comes back in. The vocabulary each source contributed is printed, so a reading that shrank is visible:
 * `descriptions examined D · refused vocabulary F`.
 *
 * BOUNDARY, stated rather than hidden. A `description:` whose value is not text here - a type annotation, a name the
 * declaration carries (`description: entry.description`) - is passed through, counted and printed, not read: the second
 * kind is the MOD's prose (its descriptor text travels to the model through the plan shape answer), and the Mod's gates
 * own it, `tools/audit-stardew-clearing-vocabulary.mjs` among them. `integrations/**` is not this reading's reach.
 *
 * A zero population is `description_population_empty` and blocked; a source of the vocabulary that contributes no word is
 * `refused_vocabulary_empty:<source>` and blocked, because an empty vocabulary agrees with every description. Two premise
 * drifts BLOCK BY NAME instead of shrinking the reading: a form the Mod publishes that the action surface ALSO publishes
 * (`refused_form_is_published` - it is not refused any more) and a form the compiler now declares
 * (`form_declared_by_the_compiler` - it must be taught, not banned).
 *
 * Usage:
 *   node tools/check-description-plan-vocabulary.mjs            # the gate; exit 1 on any finding
 *
 * red-proof: inject  the shipped `occupantKind` sentence read back from this tree before the fix - "What stands on this
 *   tile in the words a `for_each` `where: [{ occupant: ... }]` filter and an action's `Clears` declaration use" - into
 *   `protocol/bridge-v1.schema.json` -> two findings under `descriptions examined 193 · refused vocabulary 27`,
 *   `a_description_teaches_a_form_the_compiler_does_not_accept:#/$defs/tileAreaRow/properties/occupantKind/description:for_each`
 *   and `...:occupantKind/description:where`, failed, exit 1; asserted by
 *   tools/check-description-plan-vocabulary.test.mjs "the schema sentence that shipped is refused, by site and by word"
 * red-proof: inject  the shipped `stardew_observe` clause - "the very words a for_each `where: [{ occupant: ... }]` filter
 *   takes" - into the tool's description -> the same two words refused at `host/src/game-tools.ts:<line>`, so the finding
 *   is the sentence's and not the schema's
 * red-proof: inject  `for_each` alone into the planner's guidance (`planWorkDescription`) -> refused there too, which is
 *   the same reading `two_ways_to_write_a_loop` holds over one text, now held over every description
 * red-proof: inject  `where: [{ occupant: 3 }]` into a description with no form id beside it -> `where` alone is named, so
 *   the vocabulary is a set of words and not a list of known sentences
 * red-proof: inject  `FarmhandPlanFormCatalog`'s `ForEachActionId` removed -> `refused_vocabulary_empty:plan_form_id`,
 *   blocked, rather than a gate that keeps passing over the words it can still find
 * red-proof: inject  `"for_each"` added to `action-surface.v1.json` -> `refused_form_is_published:for_each`, blocked: the
 *   word is no longer refused, so the sentence that names it is no longer this gate's subject
 * red-proof: inject  `"for_each"` into the compiler's `PLAN_FORM_ACTION_IDS` -> `form_declared_by_the_compiler:for_each`,
 *   blocked: a declared form must be taught in the description, which is the other direction of this gate
 * red-proof: inject  `plan_script_uses_forbidden` renamed in the compiler -> `refusal_code_unanchored`, blocked, so the
 *   vocabulary is judged against refusals that are still produced
 * red-proof: inject  the observation tool's `name: "stardew_observe"` removed from its `defineTool` literal ->
 *   `description_population_unanchored:stardew_observe`, blocked, so the population cannot silently stop covering the
 *   measured site
 */

export const gateDeclaration = {
  id: "check-description-plan-vocabulary",
  domain: "product",
  tier: "l0",
  kind: "totality",
};

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gate = "description_plan_vocabulary/v1";

const COMPILER_PATH = "host/src/body-program-script.ts";
const PREFLIGHT_PATH = "host/src/body-program-preflight.ts";
const FORM_CATALOG_PATH = "integrations/stardew/src/Core/Policy/FarmhandPlanFormCatalog.cs";
const FORM_ARGUMENTS_PATH = "integrations/stardew/src/Core/Policy/FarmhandForEachArguments.cs";
const ACTION_SURFACE_PATH = "integrations/stardew/action-development/contracts/generated/action-surface.v1.json";
const SCHEMA_PATH = "protocol/bridge-v1.schema.json";
const HOST_SOURCE_DIRECTORY = "host/src";
const SKIPPED_DIRECTORIES = /^(?:node_modules|build|dist)$/u;

/** The three refusal codes this gate judges against a description, and the file that must still produce each. */
const REFUSAL_CODES = Object.freeze([
  Object.freeze({ code: "plan_script_uses_forbidden", path: COMPILER_PATH }),
  Object.freeze({ code: "plan_script_argument_not_canonical", path: COMPILER_PATH }),
  Object.freeze({ code: "plan_form_not_declared", path: PREFLIGHT_PATH }),
]);

/**
 * The two sentences this gate exists for, as the places that must be inside its population.
 *
 * The site is not a line: `host/src/game-tools.ts` is the file that declares the observation tools, and the pointer is the
 * schema member whose description taught the form. A fix that moves either member keeps this anchor true; removing the
 * member from the population is what it refuses.
 */
const MEASURED_SITES = Object.freeze([
  Object.freeze({ site: "stardew_observe", kind: "tool" }),
  Object.freeze({ site: "#/$defs/tileAreaRow/properties/occupantKind", kind: "schema" }),
]);

/** How many passed-through and unreadable places are named in the report, so a wide file cannot spend the answer. */
const MAX_NAMED_PLACES = 8;

/** A `description:` KEY - not a parameter of that name, a type annotation's member, or the tail of a longer identifier. */
const DESCRIPTION_KEY = /(?<![.(:\w$])description:\s*/gu;

/** A function this tree declares, which is how a `description:` that is a call is resolved to the text it publishes. */
const FUNCTION_DECLARATION = /(?:export[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)[ \t]*\(/gu;

/** A word no English sentence spells: an underscore, a dot, a dollar, or a lowercase-to-uppercase hump. */
const IDENTIFIER_SHAPED = /[_.$]|[a-z][A-Z]/u;

/** A backticked span, which is how a description marks a word as something to write rather than something to say. */
const CODE_SPAN = /`([^`\n]*)`/gu;

/** Blank every comment out, preserving offsets and newlines (the TypeScript sources and the Mod's C# both). */
export function blankCommentText(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "))
    .replace(/\/\/[^\n]*/gu, (comment) => " ".repeat(comment.length));
}

/** A reader that turns an offset into the 1-based line the text is written on. */
function lineCounter(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") starts.push(index + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/** The offset just past a quoted run starting at `at`, so a quote inside an interpolation is not read as its end. */
function quotedEnd(source, at) {
  const quote = source[at];
  let index = at + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

/**
 * One string or template literal as the model reads it, with each `${...}` masked as `«», or null when none starts here.
 *
 * The masking is the point: an interpolation is a computed value, not prose this gate can judge, and leaving its source
 * text in place would let `String(WORD)` read as a word the description taught.
 */
function literalAt(source, start) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let text = "";
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      text += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === quote) return { text, next: index + 1 };
    if (quote === "`" && character === "$" && source[index + 1] === "{") {
      let depth = 0;
      let cursor = index + 1;
      while (cursor < source.length) {
        const inner = source[cursor];
        if (inner === '"' || inner === "'" || inner === "`") {
          cursor = quotedEnd(source, cursor);
          continue;
        }
        if (inner === "{") depth += 1;
        else if (inner === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        cursor += 1;
      }
      text += "«»";
      index = cursor + 1;
      continue;
    }
    text += character;
    index += 1;
  }
  return { text, next: source.length };
}

/** A literal, or literals joined by `+`, as one text; null when this is not a text at all. */
function literalChainAt(source, start) {
  let text = "";
  let index = start;
  let first = true;
  while (index < source.length) {
    const literal = literalAt(source, index);
    if (literal === null) return first ? null : { text, next: index };
    first = false;
    text += literal.text;
    index = literal.next;
    while (index < source.length && /\s/u.test(source[index])) index += 1;
    if (source[index] !== "+") return { text, next: index };
    index += 1;
    while (index < source.length && /\s/u.test(source[index])) index += 1;
  }
  return first ? null : { text, next: index };
}

/** The body of the top-level function `name`, from its signature to the closing brace in column 0, or null. */
function functionBody(source, name) {
  const signature = source.indexOf(`function ${name}(`);
  if (signature < 0) return null;
  const closing = source.indexOf("\n}", signature);
  return closing < 0 ? null : source.slice(signature, closing + 2);
}

/** The offset just past the object literal whose `{` is at `open`, with strings stepped over rather than counted. */
function objectLiteralEnd(source, open) {
  let depth = 0;
  let index = open;
  while (index < source.length) {
    const character = source[index];
    if (character === '"' || character === "'" || character === "`") {
      index = quotedEnd(source, index);
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return source.length;
}

/**
 * Every `defineTool({ ... })` literal in `source`, as the range its own object occupies and the tool it declares.
 *
 * This is how a description is attributed to the TOOL it belongs to rather than to the nearest line: `stardew_observe`'s
 * description is a place identified by the tool's own name, which survives both a reformat and a rename of the file.
 */
function toolBlocks(source) {
  const blocks = [];
  for (const match of source.matchAll(/defineTool\(\{/gu)) {
    const open = match.index + match[0].length - 1;
    const end = objectLiteralEnd(source, open);
    const name = /\bname:\s*"([a-z][a-z0-9_]*)"/u.exec(source.slice(open, end))?.[1];
    blocks.push({ start: open, end, name: name ?? null });
  }
  return blocks;
}

/** Every non-test TypeScript file under `host/src`, as paths relative to the repository root. */
export function hostSourcePaths(root) {
  const paths = [];
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.test(entry.name)) walk(child);
        continue;
      }
      if (child.endsWith(".ts") && !child.endsWith(".test.ts")) paths.push(child);
    }
  };
  walk(HOST_SOURCE_DIRECTORY);
  return Object.freeze(paths.sort());
}

/**
 * Every `description:` place the Host declares, as `{ site, text }`, in two buckets.
 *
 * `places` is the population: the text a model reads. `notText` is the places whose value is not text here - a type
 * annotation or a name the declaration carries - counted rather than read, because the second kind is the Mod's prose
 * and `integrations/**` is not this reading's reach.
 */
export function hostDescriptionPlaces(sources) {
  const places = [];
  const notText = [];
  const declarations = new Map();
  const blanked = new Map();
  for (const [file, source] of sources) {
    const text = blankCommentText(source);
    blanked.set(file, text);
    for (const match of text.matchAll(FUNCTION_DECLARATION)) declarations.set(match[1], file);
  }
  for (const [file, text] of blanked) {
    const lineOf = lineCounter(text);
    const blocks = toolBlocks(text);
    const toolAt = (offset) => blocks.find((block) => offset >= block.start && offset < block.end)?.name ?? null;
    for (const match of text.matchAll(DESCRIPTION_KEY)) {
      const at = match.index + match[0].length;
      const site = `${file}:${lineOf(match.index)}`;
      const tool = toolAt(match.index);
      const chain = literalChainAt(text, at);
      if (chain !== null) {
        places.push(Object.freeze({ site, tool, text: chain.text }));
        continue;
      }
      const call = /^([A-Za-z_$][\w$]*)\s*\(/u.exec(text.slice(at, at + 96));
      const declaredIn = call === null ? undefined : declarations.get(call[1]);
      if (call !== null && declaredIn !== undefined) {
        const body = functionBody(blanked.get(declaredIn), call[1]);
        if (body === null) {
          notText.push(Object.freeze({ site, kind: "call", why: `function ${call[1]} has no body to read` }));
          continue;
        }
        const parts = [];
        let index = 0;
        while (index < body.length) {
          const literal = literalAt(body, index);
          if (literal === null) {
            index += 1;
            continue;
          }
          parts.push(literal.text);
          index = literal.next;
        }
        places.push(Object.freeze({ site, tool, text: parts.join(" ") }));
        continue;
      }
      notText.push(
        call !== null
          ? Object.freeze({ site, kind: "call", why: `\`${call[1]}()\` is not a function this tree declares` })
          : Object.freeze({ site, kind: "declaration", why: "the value is a name the declaration carries, not text" }),
      );
    }
  }
  return { places: Object.freeze(places), notText: Object.freeze(notText) };
}

/** Every `description` string in the wire schema, by JSON pointer. */
export function schemaDescriptionPlaces(schema) {
  const places = [];
  const walk = (node, pointer) => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${pointer}/${String(index)}`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "description" && typeof value === "string") {
        places.push(Object.freeze({ site: `${pointer}/description`, tool: null, text: value }));
        continue;
      }
      walk(value, `${pointer}/${key}`);
    }
  };
  walk(schema, "#");
  return Object.freeze(places);
}

/** A `const NAME = ["..."]` / `Object.freeze(["..."])` declaration read as its words, or null when it is not there. */
function stringArrayLiteral(source, name) {
  const pattern = new RegExp(`const ${name}[^=]*=\\s*(?:Object\\.freeze\\()?\\[([\\s\\S]*?)\\]`, "u");
  const match = pattern.exec(source);
  if (match === null) return null;
  return Object.freeze([...match[1].matchAll(/"([^"]*)"/gu)].map((quoted) => quoted[1]));
}

/** The words of a C# `= { "a", "b" }` initializer, from the declaration that names it. */
function csharpStringList(source, name) {
  const pattern = new RegExp(`${name}\\s*=\\s*\\{([^}]*)\\}`, "u");
  const match = pattern.exec(source);
  if (match === null) return null;
  return Object.freeze([...match[1].matchAll(/"([^"]*)"/gu)].map((quoted) => quoted[1]));
}

/** One C# `public const string `<name>` = "value"`, or null. */
function csharpStringConstant(source, name) {
  const match = new RegExp(`const string ${name}\\s*=\\s*"([^"]*)"`, "u").exec(source);
  return match === null ? null : match[1];
}

/** How a description has to mark a word before it counts as taught: see the docblock's WHERE A WORD COUNTS. */
export function wordPosition(word) {
  return IDENTIFIER_SHAPED.test(word) ? "anywhere" : "code";
}

/**
 * Does `text` name this word in the position it is refused in?
 *
 * HOW each source writes its words is the source's own fact, not a word list: a form's document is written as KEYS
 * (`where: [...]`), so its words count where a description writes them followed by `:`; a sandbox name is written as CODE,
 * so it counts inside a backticked span; a form id has no English spelling and counts anywhere. That is what keeps
 * `` `source.family` `` (an answer's own field path) out of a form document's vocabulary.
 */
export function namesWord(text, entry) {
  const boundary = new RegExp(`(?<![\\w$])${entry.word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w$])`, "u");
  if (wordPosition(entry.word) === "anywhere") return boundary.test(text);
  if (entry.source === "plan_form_document") return new RegExp(`${boundary.source}\\s*:`, "u").test(text);
  for (const span of text.matchAll(CODE_SPAN)) if (boundary.test(span[1])) return true;
  return false;
}

/**
 * The vocabulary the compiler refuses, derived from the declarations that refuse it on every run.
 *
 * Four readings, each named with the refusal it produces, and each of which can be empty - which is
 * `refused_vocabulary_empty:<source>` rather than a green run over fewer words.
 */
export function refusedVocabulary({ compilerSource, preflightSource, formCatalogSource, formArgumentsSource, actionIds }) {
  const compiler = blankCommentText(compilerSource);
  const preflight = blankCommentText(preflightSource);
  const catalog = blankCommentText(formCatalogSource);
  const arguments_ = blankCommentText(formArgumentsSource);

  const sandbox = stringArrayLiteral(compiler, "FORBIDDEN_PLAN_REFERENCES");
  const declaredForms = stringArrayLiteral(compiler, "PLAN_FORM_ACTION_IDS");
  const publishedForms = Object.freeze(
    [...catalog.matchAll(/const string (\w*ActionId)\s*=\s*"([^"]*)"/gu)].map((match) => match[2]),
  );
  const loopArgument = csharpStringConstant(arguments_, "LoopArgument");
  const loopKeys = csharpStringList(arguments_, "LoopKeys");
  const preflightFormArgument = /const LOOP_ARGUMENT\s*=\s*"([^"]*)"/u.exec(preflight)?.[1];

  const words = [];
  const problems = [];
  const empty = [];
  for (const id of publishedForms) {
    if (declaredForms !== null && declaredForms.includes(id)) {
      problems.push(
        Object.freeze({
          code: "form_declared_by_the_compiler",
          member: id,
          detail:
            `\`${id}\` is a form the Mod publishes and \`PLAN_FORM_ACTION_IDS\` declares, so the compiler accepts it and ` +
            "the descriptions must teach it; this gate only refuses the forms it does not",
        }),
      );
      continue;
    }
    if (actionIds.has(id)) {
      problems.push(
        Object.freeze({
          code: "refused_form_is_published",
          member: id,
          detail:
            `\`${id}\` is a form the Mod publishes AND an action \`action-surface.v1.json\` publishes, so the compiler's ` +
            "builder accepts it and the vocabulary below no longer refuses it",
        }),
      );
      continue;
    }
    words.push(Object.freeze({ word: id, code: "plan_script_unknown_action", source: "plan_form_id" }));
  }
  if (publishedForms.length === 0) empty.push("plan_form_id");

  const documentKeys = Object.freeze([...new Set([loopArgument, preflightFormArgument, ...(loopKeys ?? [])].filter((k) => k !== null))]);
  for (const key of documentKeys)
    words.push(Object.freeze({ word: key, code: "plan_form_not_declared", source: "plan_form_document" }));
  if (documentKeys.length === 0) empty.push("plan_form_document");

  for (const name of sandbox ?? [])
    words.push(Object.freeze({ word: name, code: "plan_script_uses_forbidden", source: "sandbox" }));
  if (sandbox === null || sandbox.length === 0) empty.push("sandbox");

  const unique = [];
  const seen = new Set();
  for (const entry of words) {
    if (seen.has(entry.word)) continue;
    seen.add(entry.word);
    unique.push(entry);
  }
  return Object.freeze({
    words: Object.freeze(unique),
    problems: Object.freeze(problems),
    empty: Object.freeze(empty),
    sources: Object.freeze({
      forms: publishedForms,
      declaredForms: declaredForms ?? Object.freeze([]),
      documentKeys,
      sandbox: sandbox ?? Object.freeze([]),
    }),
  });
}

/** The rules this gate asserts, one entry per finding code it can report red with. */
export const RULES = Object.freeze([
  {
    id: "description_population_readable",
    codes: ["description_population_empty", "description_place_unreadable"],
    prerequisite: "the Host publishes no description this gate could read, so nothing was examined",
  },
  {
    id: "measured_sites_inside_the_population",
    codes: ["description_population_unanchored"],
    prerequisite: "the population no longer covers the sentences this gate exists for",
  },
  {
    id: "refusal_codes_still_produced",
    codes: ["refusal_code_unanchored"],
    prerequisite: "a refusal code moved, so the vocabulary below is judged against nothing",
  },
  {
    id: "vocabulary_derived_from_the_refusals",
    codes: ["refused_vocabulary_empty", "refused_form_is_published", "form_declared_by_the_compiler"],
    prerequisite: "a source of the vocabulary contributed no word, so an empty vocabulary agreed with the descriptions",
  },
  {
    id: "no_description_teaches_a_refused_form",
    codes: ["a_description_teaches_a_form_the_compiler_does_not_accept"],
  },
]);

/** The per-rule outcomes, each rule's findings named, in `RULES` order. */
function ruleChecks(findings) {
  const checks = RULES.map((rule) => {
    const hits = findings.filter((finding) => rule.codes.includes(finding.code));
    if (hits.length === 0) return { id: rule.id, status: "passed" };
    const named = hits.map((finding) => `${finding.code}:${finding.member}`);
    return rule.prerequisite === undefined
      ? { id: rule.id, status: "failed", findings: named }
      : { id: rule.id, status: "not_measured", findings: named, reason: rule.prerequisite };
  });
  const covered = RULES.flatMap((rule) => rule.codes);
  for (const finding of findings) {
    if (covered.includes(finding.code)) continue;
    checks.push({ id: `unclassified:${finding.code}`, status: "failed", findings: [`${finding.code}:${finding.member}`] });
  }
  return checks;
}

/**
 * @param {{ root?: string, overrides?: Record<string, string> }} options
 */
export function checkDescriptionPlanVocabulary({ root = repositoryRoot, overrides = {} } = {}) {
  const read = (relativePath) => overrides[relativePath] ?? readFileSync(path.join(root, relativePath), "utf8");
  const findings = [];
  const push = (code, member, detail) => findings.push({ code, member, detail });

  // THE POPULATION.
  const sources = hostSourcePaths(root).map((file) => [file, read(file)]);
  const host = hostDescriptionPlaces(sources);
  const schemaPlaces = schemaDescriptionPlaces(JSON.parse(read(SCHEMA_PATH)));
  const places = [...host.places, ...schemaPlaces];
  if (places.length === 0)
    push("description_population_empty", HOST_SOURCE_DIRECTORY, "no description was found at all, so nothing was examined");
  for (const place of host.notText)
    if (place.kind === "call")
      push(
        "description_place_unreadable",
        place.site,
        `${place.why}, so the text this description publishes to the model was not read; write it as a literal, or as a ` +
          "call to a function this tree declares",
      );
  for (const measured of MEASURED_SITES) {
    const found =
      measured.kind === "tool"
        ? places.some((place) => place.tool === measured.site)
        : schemaPlaces.some((place) => place.site === `${measured.site}/description`);
    if (!found)
      push(
        "description_population_unanchored",
        measured.site,
        "this place is not in the population any more, so the sentences this gate exists for are no longer examined",
      );
  }

  // THE VOCABULARY, from the declarations that refuse it.
  for (const refusal of REFUSAL_CODES) {
    if (!blankCommentText(read(refusal.path)).includes(refusal.code))
      push(
        "refusal_code_unanchored",
        refusal.code,
        `${refusal.path} no longer produces \`${refusal.code}\`, so the words judged against it have nothing refusing them`,
      );
  }
  const surface = JSON.parse(read(ACTION_SURFACE_PATH));
  const vocabulary = refusedVocabulary({
    compilerSource: read(COMPILER_PATH),
    preflightSource: read(PREFLIGHT_PATH),
    formCatalogSource: read(FORM_CATALOG_PATH),
    formArgumentsSource: read(FORM_ARGUMENTS_PATH),
    actionIds: new Set((surface.actions ?? []).map((action) => action.actionId)),
  });
  for (const source of vocabulary.empty)
    push(
      "refused_vocabulary_empty",
      source,
      "this source declares no refused word, so every description agrees with an empty vocabulary - delete the source " +
        "from this gate, or say here why it stays",
    );
  for (const problem of vocabulary.problems) push(problem.code, problem.member, problem.detail);

  // THE PROPERTY, per description.
  const refused = [];
  for (const place of places) {
    for (const entry of vocabulary.words) {
      if (!namesWord(place.text, entry)) continue;
      refused.push(`${place.site}:${entry.word}`);
      push(
        "a_description_teaches_a_form_the_compiler_does_not_accept",
        `${place.site}:${entry.word}`,
        `${place.tool === null ? "this description" : `\`${place.tool}\`'s description`} names \`${entry.word}\`, which ` +
          `the compiler refuses (\`${entry.code}\`); describe what she writes instead, in the vocabulary an accepted ` +
          "call or the catalogue's own declaration uses",
      );
    }
  }

  findings.sort((left, right) => `${left.code}:${left.member}`.localeCompare(`${right.code}:${right.member}`));
  const checks = ruleChecks(findings);
  const status = checks.some((check) => check.status === "not_measured")
    ? "blocked"
    : checks.some((check) => check.status === "failed")
      ? "failed"
      : "passed";
  return Object.freeze({
    gate,
    status,
    examined: Object.freeze({
      descriptions: places.length,
      hostDescriptions: host.places.length,
      schemaDescriptions: schemaPlaces.length,
      descriptionsNotTextHere: host.notText.length,
      refusedVocabulary: vocabulary.words.length,
    }),
    vocabulary: Object.freeze({
      forms: vocabulary.sources.forms,
      declaredForms: vocabulary.sources.declaredForms,
      documentKeys: vocabulary.sources.documentKeys,
      sandbox: vocabulary.sources.sandbox.length,
    }),
    placesNotTextHere: Object.freeze(host.notText.slice(0, MAX_NAMED_PLACES)),    refused: Object.freeze(refused.sort()),
    findings: Object.freeze(findings),
    checks: Object.freeze(checks),
  });
}

export function renderReport(result) {
  const lines = [
    `descriptions examined ${String(result.examined.descriptions)} · refused vocabulary ` +
      String(result.examined.refusedVocabulary),
    `description sources · ${String(result.examined.hostDescriptions)} from ${HOST_SOURCE_DIRECTORY} · ` +
      `${String(result.examined.schemaDescriptions)} from ${SCHEMA_PATH} · ` +
      `${String(result.examined.descriptionsNotTextHere)} passed through from the declaration`,
    `vocabulary · forms ${result.vocabulary.forms.join(",") || "none"} · document keys ` +
      `${result.vocabulary.documentKeys.join(",") || "none"} · sandbox names ${String(result.vocabulary.sandbox)} · ` +
      `declared forms ${result.vocabulary.declaredForms.join(",") || "none"}`,
  ];
  for (const place of result.placesNotTextHere) lines.push(`not text here: ${place.site} - ${place.why}`);  for (const finding of result.findings) lines.push(`${finding.code}: ${finding.member} · ${finding.detail}`);
  lines.push(`description_plan_vocabulary: ${result.status} (${String(result.findings.length)} finding(s))`);
  lines.push(
    JSON.stringify({ gate: result.gate, examined: result.examined, checks: result.checks, status: result.status }),
  );
  return { lines, exitCode: result.findings.length === 0 ? 0 : 1 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { lines, exitCode } = renderReport(checkDescriptionPlanVocabulary());
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exitCode = exitCode;
}
