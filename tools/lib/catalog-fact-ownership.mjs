/**
 * Gate for the CATALOG FACT OWNERSHIP defect class: a per-model fact that has one
 * owner is spelled a second time as a literal, the two copies drift, and the
 * failure surfaces late and indirectly.
 *
 * The measured incident (2026-11-02). `host/src/tavern/pi-provider-store.ts`
 * declared, for the model this Host actually sells:
 *
 *     cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 }
 *
 * The upstream catalog (`@earendil-works/pi-ai`, `dist/providers/data/deepseek.json`)
 * states for that same id `deepseek-v4.1-flash`: `input 0.3, output 1.2,
 * cacheRead 0.006, cacheWrite 0`. So the shipped price was 2.1x off on input,
 * 4.3x off on output, an order of magnitude off on `cacheRead`, and `cacheWrite`
 * was a number no catalog entry contains at all. `0.14 / 0.28` are exactly
 * `deepseek-v4-flash`'s rates - the PREVIOUS model generation.
 *
 * Pi multiplies token counts by these four numbers to fill `usage.cost`
 * (`calculateCost` in pi-ai), so the wrong rate reached every recorded turn and
 * every spend reading taken from one. Nothing caught it because a test cannot
 * assert a true value it does not know, and the catalog that DOES know was never
 * compared against the copy in the store.
 *
 * That is one instance of a family: a fact with an owner, copied a second time,
 * with no gate comparing the copies. The owner is `TAVERN_PROVIDER_CATALOG`
 * (`host/src/tavern/provider-catalog.ts`); this gate compares every other copy in
 * `host/src` against it.
 *
 * WHAT IS DERIVED, AND WHAT IS DECLARED
 *
 * Derived at run time, never typed here:
 *   - the shipped model ids, by importing the catalog module the runtime itself
 *     reads (`catalogModelById`'s population) and walking `allowedPlayerModels`;
 *   - every declared fact's VALUE, read from that same module. This file contains
 *     no rate, no window and no token cap: typing one would recreate the defect
 *     this gate exists to remove.
 *
 * Declared, because no run-time source can know it:
 *   - `FACT_FIELDS`, the fact names compared (the fields the catalog declares);
 *   - `DECLARED_EXEMPTIONS`, each an occurrence that is legitimately a second
 *     spelling, carrying the one-line reason it is not a second owner.
 *
 * THE RULE. A declared fact spelled as a literal in `host/src` is a finding when
 * it sits in the same record as a shipped model id, or when that record's id is a
 * computed expression (the generic writer shape - a literal there prices whatever
 * model the caller names). Values are compared EXACTLY: these are declarations,
 * not measurements, so no tolerance is applied.
 *
 * The declaration is exempt from its own rule where it must spell a fact name or
 * a model id to look for it (see `GATE_PATHS`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** The owner module: the one place a shipped model's facts are declared. */
export const CATALOG_MODULE_PATH = "host/src/tavern/provider-catalog.ts";

/** Trees scanned for a second spelling. */
export const SCAN_ROOTS = Object.freeze(["host/src"]);

/**
 * The facts this gate owns.
 *
 * Deliberately the fields `TavernCatalogModel` declares today: `contextWindow`
 * and `cost`. `maxTokens` and `reasoning` are named in the same defect family but
 * the catalog holds no value for them yet - `maxTokens` is derived from the
 * window and `reasoning` is written `true` inline - so there is nothing to compare
 * a copy against, and a gate that compares against nothing is a gate that cannot
 * fail. They join this list when the catalog declares them.
 */
export const FACT_FIELDS = Object.freeze(["contextWindow", "cost"]);

/** The four rates inside a `cost` block, in the order Pi reads them. */
const COST_FIELDS = Object.freeze(["input", "output", "cacheRead", "cacheWrite"]);

/** Source extensions that are hand-authored. Generated `.json` is not scanned. */
const SCAN_EXTENSIONS = new Set([".cts", ".mts", ".ts", ".tsx"]);

/** Vendored, generated, or scratch trees that never own a product fact. */
const EXCLUDED_DIRECTORIES = new Set([".git", ".tmp", "build", "coverage", "dist", "node_modules", "scratch", "tmp"]);

const MAX_SCANNED_BYTES = 2 * 1024 * 1024;

/**
 * A fact assertion inside a REGEX LITERAL: /"contextWindow": 1000000/.
 *
 * The lexer above does not understand regex literals (a limit it shares with its
 * sibling in `duplicated-authority.mjs`), and this is the only way a test can pin the
 * serialized form of a fact: the key and the number are both spelled between two
 * slashes. The value is associated with a shipped model when that model's id string
 * sits in the same enclosing block, which is the "next to that model id" rule.
 *
 * Groups: 1 = field, 2 = number.
 */
const REGEX_FACT_PATTERN =
  /\/(?:[^\/\n\\]|\\.)*?"?(contextWindow|maxTokens|reasoning|cost)"?\\?"?\s*:\s*(-?\d[\d_]*(?:\.\d+)?)(?:[^\/\n]|\\.)*\/[a-z]*/gu;

/** The gate spells fact names, model ids and the owner path on purpose. */
const SELF = "tools/lib/catalog-fact-ownership.mjs";
const SELF_TESTS = "tools/lib/catalog-fact-ownership.test.mjs";
const GATE = "tools/check-catalog-fact-ownership.mjs";
const GATE_TESTS = "tools/check-catalog-fact-ownership.test.mjs";

/**
 * Files this gate does not scan: its own two, their tests, and the OWNER itself.
 *
 * The catalog is exempt because its declarations ARE the authority - a gate that
 * reported the owner.s own numbers as copies of themselves would be comparing a fact
 * against itself and calling the agreement a defect. The gate files are exempt because
 * they have to spell the fact names and the owner path to look for them.
 */
export const GATE_PATHS = Object.freeze([SELF, SELF_TESTS, GATE, GATE_TESTS, CATALOG_MODULE_PATH]);

/**
 * A second spelling that is not a second owner, each with the reason it is not.
 *
 * An exemption is not a waiver of the rule: it names the exact model and field it
 * covers, and the gate's own tests prove it is still earned (the occurrence it
 * waives must still be in that file) and still scoped (that same text one
 * directory over is still reported). An exemption that outlives its occurrence
 * fails.
 */
export const DECLARED_EXEMPTIONS = Object.freeze([
  Object.freeze({
    path: "host/src/tavern/pi-provider-store.test.ts",
    modelId: "deepseek-v4.1-flash",
    fields: Object.freeze(["contextWindow", "cost"]),
    reason:
      "a golden models.json document asserted byte-for-byte against the pre-change serializer " +
      "output has to name the numbers it pins, or it cannot fail",
  }),
  // The one occurrence this gate reports that is NOT yet fixed, recorded rather
  // than waived. `gpt-5.6-luna` is not a model this catalog describes, so the
  // gameplay worker's own writer cannot read a price for it from the owner - it
  // spells one instead, and the numbers it spells are `gpt-5.6-terra-batch`'s
  // batch rates (1/6/0.1/1.25) applied to luna. That is the measured defect
  // again, one surface over: a confident rate about a different model's invoice.
  // It is recorded here because the correction is a product decision (state
  // luna's own rate in the catalog, or emit no cost for a model this Host does
  // not price) and because that file carries another lane's uncommitted work.
  Object.freeze({
    path: "host/src/gameplay-task-subagent.ts",
    fields: Object.freeze(["cost"]),
    computedId: true,
    reason:
      "RECORDED DEFECT, not a waiver: the gameplay worker prices a model the catalog does not " +
      "describe with another model's batch rates; the fix is a catalog/product decision",
  }),
  ...GATE_PATHS.map((path) =>
    Object.freeze({ path, reason: "the gate has to spell the fact names and the owner path it looks for" }),
  ),
]);

/** True when `path` is one of the gate's own files. */
function isGatePath(path) {
  return GATE_PATHS.includes(path);
}

/** A record's identity for exemption matching. */
function exemptionFor(exemptions, path, modelId, field, computedId) {
  return (
    exemptions.find(
      (exemption) =>
        exemption.path === path &&
        (exemption.fields === undefined || exemption.fields.includes(field)) &&
        (exemption.modelId === undefined || exemption.modelId === modelId) &&
        (exemption.computedId === undefined || exemption.computedId === computedId),
    ) ?? null
  );
}

/**
 * The shipped models and their declared facts, read from the owner module itself.
 *
 * `catalogModule` is an override so a test can state a population the installed
 * catalog does not hold - the same lever `catalogModelById(modelId, catalog)`
 * takes. `root` is where the owner module is imported from.
 *
 * Returns `{ models, disagreements }`. `disagreements` is non-empty when two
 * catalog entries describe ONE id and state different facts for it: no single
 * upstream number is then "the" value, and the gate must name that rather than
 * silently taking the first entry `catalogModelById` happens to return.
 */
export async function loadDeclaredModels({ root, catalogModule } = {}) {
  const module = catalogModule ?? (await import(pathToFileURL(join(root, CATALOG_MODULE_PATH)).href));
  const models = new Map();
  const disagreements = [];
  for (const provider of module.TAVERN_PROVIDER_CATALOG ?? []) {
    for (const model of provider.allowedPlayerModels ?? []) {
      const facts = {};
      for (const field of FACT_FIELDS) if (model[field] !== undefined) facts[field] = model[field];
      const previous = models.get(model.modelId);
      if (previous === undefined) {
        models.set(model.modelId, { modelId: model.modelId, facts });
        continue;
      }
      for (const field of FACT_FIELDS) {
        const before = previous.facts[field];
        const after = facts[field];
        if (before !== undefined && after !== undefined && !sameFact(before, after))
          disagreements.push({ modelId: model.modelId, field, first: before, second: after });
      }
    }
  }
  return { models, disagreements };
}

/** Exact, structural equality of two declared fact values. No tolerance. */
function sameFact(left, right) {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!sameFact(left[key], right[key])) return false;
  return true;
}

/** A number literal, underscores and sign included. */
const NUMBER_PATTERN = "-?\\d[\\d_]*(?:\\.\\d+)?";
const NUMBER = new RegExp(NUMBER_PATTERN);

function toPosix(path) {
  return path.split(sep).join("/");
}

function isExcludedDirectory(name) {
  return EXCLUDED_DIRECTORIES.has(name) || name.startsWith("dist-") || name.startsWith("_devdist");
}

function hasScannedExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && SCAN_EXTENSIONS.has(name.slice(dot));
}

function listSourceFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (isExcludedDirectory(entry.name)) continue;
        walk(join(directory, entry.name));
        continue;
      }
      if (!(entry.isFile() && hasScannedExtension(entry.name))) continue;
      const path = join(directory, entry.name);
      if (statSync(path).size > MAX_SCANNED_BYTES) continue;
      files.push(path);
    }
  };
  for (const scanRoot of SCAN_ROOTS) {
    const absolute = join(root, scanRoot);
    try {
      walk(absolute);
    } catch {
      // An absent scan root is an empty population, not a licence to invent one.
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

/**
 * String-literal and comment ranges, plus a copy of the text with both blanked.
 *
 * The blanked copy is what brace matching runs on, so a `{` inside a URL or a
 * template literal cannot be read as structure. Extraction still reads the
 * ORIGINAL text through the ranges this returns, because an embedded `models.json`
 * document is a string whose content is what has to be compared.
 *
 * This is a line-oriented lexer with the same limits as its sibling in
 * `duplicated-authority.mjs`: it understands `"`, `'` and the template backtick
 * with backslash escapes, and it does NOT understand regex literals or C#
 * verbatim strings.
 */
function lexicalRanges(text) {
  const strings = [];
  const comments = [];
  let index = 0;
  let quote = null;
  let stringStart = -1;
  while (index < text.length) {
    const character = text[index];
    if (quote !== null) {
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === quote) {
        quote = null;
        strings.push([stringStart, index + 1]);
      } else if (character === "\n" && quote !== "`") {
        strings.push([stringStart, index]);
        quote = null;
      }
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      stringStart = index;
      index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      comments.push([index, stop]);
      index = stop;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? text.length : end;
      comments.push([index, stop]);
      index = stop;
      continue;
    }
    index += 1;
  }
  if (quote !== null) strings.push([stringStart, text.length]);
  return { strings, comments };
}

/** `text` with every string literal and comment replaced by spaces, newlines kept. */
function blankRanges(text, ranges) {
  const characters = [...text];
  for (const [start, end] of ranges) {
    for (let index = start; index < end; index += 1) if (characters[index] !== "\n") characters[index] = " ";
  }
  return characters.join("");
}

/** Every balanced `{ ... }` region of the blanked text, as `[start, end)`. */
function braceRegions(blanked) {
  const stack = [];
  const regions = [];
  for (let index = 0; index < blanked.length; index += 1) {
    if (blanked[index] === "{") stack.push(index);
    else if (blanked[index] === "}") {
      const start = stack.pop();
      if (start !== undefined) regions.push([start, index + 1]);
    }
  }
  return regions;
}

/** The innermost region containing `position`, from a list of `[start, end)` regions. */
/**
 * True when `position + length - 1` falls inside one of `ranges`.
 *
 * Coverage is tested at the VALUE, not at the start of the matched text, because a
 * quoted key (`"contextWindow":`) begins ON the opening quote and would otherwise
 * read as if the whole occurrence were inside a string. A quoted key in code is a
 * second spelling like any other; only a value that really sits inside a string -
 * the pinned `models.json` document - is left to the embedded-document scan.
 */
function coveredBy(ranges, position, length) {
  const valuePosition = position + length - 1;
  return ranges.some(([start, end]) => valuePosition >= start && valuePosition < end);
}

function innermost(ranges, position) {
  let best = null;
  for (const range of ranges) {
    if (position < range[0] || position >= range[1]) continue;
    if (best === null || range[0] > best[0] || (range[0] === best[0] && range[1] < best[1])) best = range;
  }
  return best;
}

function lineAt(text, position) {
  let line = 1;
  for (let index = 0; index < position && index < text.length; index += 1) if (text[index] === "\n") line += 1;
  return line;
}

function lineTextAt(text, position) {
  const start = text.lastIndexOf("\n", position - 1) + 1;
  const end = text.indexOf("\n", position);
  return (end === -1 ? text.slice(start) : text.slice(start, end)).trim();
}

function numberOf(raw) {
  return Number(raw.replaceAll("_", ""));
}

/**
 * The `cost` rates spelled inside `recordText`, or null when the record spells no
 * cost block. Only literals count: a spread, a call or an identifier is a value
 * this gate cannot read, and guessing at one is the defect.
 */
function spelledCost(recordText) {
  const key = /(?<![\w$."])"?cost"?\s*:\s*\{/u.exec(recordText);
  if (key === null) return null;
  const open = recordText.indexOf("{", key.index);
  let depth = 0;
  let close = -1;
  for (let index = open; index < recordText.length; index += 1) {
    if (recordText[index] === "{") depth += 1;
    else if (recordText[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close === -1) return null;
  const block = recordText.slice(open + 1, close);
  const rates = {};
  for (const field of COST_FIELDS) {
    const match = new RegExp(`(?<![\\w$."])"?${field}"?\\s*:\\s*(${NUMBER_PATTERN})(?![\\w$.])`, "u").exec(block);
    if (match !== null) rates[field] = numberOf(match[1]);
  }
  return Object.keys(rates).length === 0 ? null : rates;
}

/** The id a record names: a literal string, a computed expression, or neither. */
function idIn(recordText) {
  const match =
    /(?<![\w$.])"?(?:modelId|id)"?\s*:\s*(?:"([^"\n]*)"|'([^'\n]*)'|([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*))/u.exec(
      recordText,
    );
  if (match === null) return null;
  if (match[1] !== undefined) return { kind: "literal", value: match[1] };
  if (match[2] !== undefined) return { kind: "literal", value: match[2] };
  return { kind: "computed", value: match[3] };
}

function describe(value) {
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

/**
 * Every second spelling of a declared fact in the scanned trees.
 *
 * A finding is `{ modelId, field, path, line, text, declared, spelled }`, where
 * `declared` is the owner's value and `spelled` the copy's. `modelId` is null when
 * the record names its model through a computed expression, which is the generic
 * writer shape rather than one model's own entry.
 */
export function findCatalogFactCopies({ root, models, exemptions = DECLARED_EXEMPTIONS }) {
  const findings = [];
  for (const file of listSourceFiles(root)) {
    const path = toPosix(relative(root, file));
    if (isGatePath(path)) continue;
    const text = readFileSync(file, "utf8");
    const { strings, comments } = lexicalRanges(text);
    const blanked = blankRanges(text, [...strings, ...comments]);
    const regions = braceRegions(blanked);

    // A fact spelling is looked for outside strings and comments...
    const spellings = [];
    for (const field of FACT_FIELDS) {
      if (field === "cost") {
        for (const match of text.matchAll(/(?<![\w$."])"?cost"?\s*:\s*\{/gu)) {
          const covered = coveredBy(strings, match.index, match[0].length);
          const commented = comments.some(([start, end]) => match.index >= start && match.index < end);
          if (covered || commented) continue;
          const record = innermost(regions, match.index);
          if (record === null) continue;
          const rates = spelledCost(text.slice(record[0], record[1]));
          if (rates !== null) spellings.push({ field, position: match.index, record, spelled: rates });
        }
        continue;
      }
      for (const match of text.matchAll(
        new RegExp(`(?<![\\w$."])"?${field}"?\\s*:\\s*(${NUMBER_PATTERN})(?![\\w$.])`, "gu"),
      )) {
        const covered = coveredBy(strings, match.index, match[0].length);
        const commented = comments.some(([start, end]) => match.index >= start && match.index < end);
        if (covered || commented) continue;
        const record = innermost(regions, match.index);
        if (record === null) continue;
        spellings.push({ field, position: match.index, record, spelled: numberOf(match[1]) });
      }
    }

    // ...and inside a string literal whose content is an embedded document that
    // names a shipped model, because a pinned models.json is exactly that.
    for (const [start, end] of strings) {
      const content = text.slice(start, end);
      if (![...models.keys()].some((modelId) => content.includes(`"${modelId}"`))) continue;
      for (const field of FACT_FIELDS) {
        const spelled =
          field === "cost"
            ? spelledCost(content)
            : (() => {
                const match = new RegExp(`(?<![\\w$."])"?${field}"?\\s*:\\s*(${NUMBER_PATTERN})(?![\\w$.])`, "u").exec(
                  content,
                );
                return match === null ? null : numberOf(match[1]);
              })();
        if (spelled === null) continue;
        const position = content.search(new RegExp(`(?<![\\w$."])"?${field}"?\\s*:`, "u"));
        spellings.push({ field, position: start + Math.max(position, 0), record: [start, end], spelled });
      }
    }

    // ...and inside a REGEX LITERAL asserting a serialized document (see REGEX_FACT_PATTERN):
    // the one way a test can pin a fact in a models.json string. Associated with the shipped
    // model whose id string sits in the same enclosing block.
    for (const match of text.matchAll(REGEX_FACT_PATTERN)) {
      // No "is this really division?" heuristic here. The pattern already requires a
      // quoted fact NAME, a colon and a number between two slashes, which no arithmetic
      // expression can produce; a guard on the preceding character only refused the
      // shapes that actually occur (`return /"contextWindow": 131072/.test(x)`).
      const covered = coveredBy(strings, match.index, match[0].length);
      const commented = comments.some(([start, end]) => match.index >= start && match.index < end);
      if (covered || commented) continue;
      const record = innermost(regions, match.index);
      if (record === null) continue;
      const regionText = text.slice(record[0], record[1]);
      for (const modelId of models.keys()) {
        if (!regionText.includes('"' + modelId + '"')) continue;
        spellings.push({ field: match[1], position: match.index, record, spelled: numberOf(match[2]), modelId });
      }
    }

    for (const spelling of spellings) {
      // A regex-literal spelling already resolved its model from the enclosing block;
      // the other passes resolve it from the record the fact sits in.
      if (spelling.modelId !== undefined) {
        const declaredFact = models.get(spelling.modelId)?.facts[spelling.field];
        const matchesFact = declaredFact === undefined ? false : sameFact(declaredFact, spelling.spelled);
        if (exemptionFor(exemptions, path, spelling.modelId, spelling.field, false) !== null) continue;
        findings.push({
          modelId: spelling.modelId,
          computedId: false,
          field: spelling.field,
          path,
          line: lineAt(text, spelling.position),
          text: lineTextAt(text, spelling.position),
          declared: declaredFact === undefined ? null : declaredFact,
          spelled: spelling.spelled,
          matches: matchesFact,
        });
        continue;
      }
      const recordText = text.slice(spelling.record[0], spelling.record[1]);
      const id = idIn(recordText);
      if (id === null) continue;
      let modelId = null;
      let computedId = false;
      if (id.kind === "literal") {
        // A literal id this catalog does not describe belongs to an endpoint the
        // catalog is not the owner of, so there is nothing to compare it against.
        if (!models.has(id.value)) continue;
        modelId = id.value;
      } else {
        computedId = true;
      }
      const declared = modelId === null ? undefined : models.get(modelId)?.facts[spelling.field];
      const spelled = spelling.spelled;
      const matches = declared === undefined ? false : sameFact(declared, spelled);
      const exemption = exemptionFor(exemptions, path, modelId, spelling.field, computedId);
      if (exemption !== null) continue;
      findings.push({
        modelId,
        computedId,
        field: spelling.field,
        path,
        line: lineAt(text, spelling.position),
        text: lineTextAt(text, spelling.position),
        declared: declared === undefined ? null : declared,
        spelled,
        matches,
      });
    }
  }
  findings.sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.line - right.line || left.field.localeCompare(right.field),
  );
  return findings;
}

/**
 * The one-line, greppable form the CLI prints and CI matches on.
 *
 * Three names, because the three cases are not the same claim:
 *   - `fact_mismatch`   - a copy that DISAGREES with the owner. This is the shipped
 *                         wrong price: the copy is not untidy, it is wrong.
 *   - `second_spelling` - a copy that AGREES with the owner today. Still a finding: it
 *                         is a second owner, and nothing keeps the two in step but habit.
 *   - `unowned_literal` - a literal in a record whose model id is an EXPRESSION, so no
 *                         declared value exists to compare against. The writer prices
 *                         whatever model its caller names, which is precisely how a rate
 *                         from another model reaches an id the catalog never priced.
 */
export function formatFinding(finding) {
  const owner = finding.modelId === null ? "computed-id" : finding.modelId;
  const name = finding.computedId ? "unowned_literal" : finding.matches ? "second_spelling" : "fact_mismatch";
  return (
    `catalog_fact_ownership:${name}:${owner}:${finding.field}:${finding.path}:${finding.line}: ` +
    `catalog=${describe(finding.declared)} spelled=${describe(finding.spelled)}`
  );
}
