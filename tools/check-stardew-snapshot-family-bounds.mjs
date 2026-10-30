// Gate: stardew_snapshot_family_bound_parity/v1
//
// The Mod publishes bounded target arrays; the Host decides whether to admit them. The two sides
// are written by hand, in two languages, and the Host's cap is what makes an over-long array
// FATAL rather than merely long: `local-stardew-bridge` answers an over-cap family with
// `invalid_snapshot` by CLOSING the transport. One entry past the ceiling ends the session.
//
// That is the shape of the `obeliskTargets` defect this gate was written for - an unbounded
// `foreach (Building building in location.buildings)` on the Mod side, `maxItems: 32` on the Host
// side. A farm with 33 finished obelisks publishes 33 entries and kills its own bridge.
//
// `protocol.ts` states the intended invariant in a comment beside its cap table: "Entry cap. Must
// equal the schema's `maxItems` for the same field." A comment enforces nothing. This gate is the
// enforcement, and it derives BOTH populations instead of listing fields:
//
//   Mod side    the array-typed parameters of `BridgeSnapshot`
//               (`integrations/stardew/src/Core/Models/BridgeProtocolModels.cs`), zipped
//               positionally against the single `new BridgeSnapshot(...)` construction site so
//               each family resolves to the expression that produces it. A family declared but
//               never constructed, or constructed but never declared, is a finding.
//   Host side   `SNAPSHOT_FAMILY_RULES` in `host/src/protocol.ts`.
//   wire schema `$defs.snapshot` in `protocol/bridge-v1.schema.json`.
//
// The producer's ceiling is read from a CLOSED set of syntactic forms (PRODUCER_BOUND_FORMS). A
// producer that states no ceiling in one of them is a FINDING, never a pass: a bound this gate
// cannot see is a bound no reviewer can check either. Every form is named in the message that
// reports its absence, so widening the set is a visible act rather than a silent drift.
//
// Per family, with the field named in every message:
//
//   missing_mod_family     the Host caps a family the Mod's wire record does not declare
//   missing_host_cap       the Mod publishes a family the Host does not cap
//   unreadable_bound       the producer states no ceiling this gate can read
//   producer_exceeds_cap   the producer can emit more entries than the Host admits (FATAL)
//   schema_below_host_cap  the Host admits more than the language-neutral schema declares
//
// The narrowing direction (producer ceiling < Host cap) is REPORTED with both numbers, not
// refused: a producer below the ceiling cannot close the transport, and lowering a cap to the
// producer's exact reach is a wire-contract change rather than a drift fix. Printing it keeps the
// ceiling from reading as a claim about what actually arrives.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const GATE = "stardew_snapshot_family_bound_parity/v1";

export const MODELS_PATH = "integrations/stardew/src/Core/Models/BridgeProtocolModels.cs";
export const CONSTRUCTION_PATH = "integrations/stardew/farmhandexecutioncontroller.cs";
export const PROTOCOL_PATH = "host/src/protocol.ts";
export const SCHEMA_PATH = "protocol/bridge-v1.schema.json";
const MOD_SOURCE_ROOT = "integrations/stardew";
/** Directories under the Mod that never publish a snapshot family. */
const MOD_DIRECTORIES_NEVER_PRODUCING = new Set(["tests", "bin", "obj"]);

/**
 * The closed set of forms a producer's ceiling may take. A ceiling written any other way is a
 * finding that names the field, because an unreadable ceiling and an absent one look identical to
 * every later reader.
 */
export const PRODUCER_BOUND_FORMS = Object.freeze([
  "`.Take(N)` / `.TakeLast(N)`, N an integer literal, a `const int`, or `Math.Min`/`Math.Clamp` whose last argument is one",
  "`<counter>.Count >= N` (also `>`, `==`, `<=`) or `<counter> < N` guarding `break`/`return`, summed over distinct counters because each is an independent accumulator",
  "`for (int i = A; i < B; i++)` / `i <= B` with A and B literals or constants",
  "`for (int i = 0; i < items.Count; i++)` - at most one row per backpack slot, bounded by the Mod's own `MaximumInventorySlot`",
  "`foreach (x in Ident)` where Ident is a `static readonly` array with a literal initializer",
  "a literal initializer: `return new X[] { ... }`, `new List<X> { ... }`, `List<X> x = new() { ... }`",
]);

/** Families the Host validates outside `SNAPSHOT_FAMILY_RULES`, so they carry no entry cap. */
export const FAMILIES_WITHOUT_A_HOST_CAP = Object.freeze({
  capabilities: "the advertised capability ids; bounded by the frame limit, not by a family rule",
  enabledActionIds: "the enabled action ids; bounded by the frame limit, not by a family rule",
});

/**
 * Families whose producer is a straight projection of an ENGINE collection, so the Mod states no
 * ceiling of its own to compare.
 *
 * These are the one shape the gate cannot decide: the size lives in the game's data, not in the
 * Mod's source, so there is nothing to read. Each entry names why, and the check refuses an entry
 * that has since gained a readable ceiling - an allowance that outlives its reason is how a gate
 * stops meaning anything.
 */
export const ENGINE_PUBLISHED_FAMILIES = Object.freeze({
  warps: "`GameLocation.warps` is the map's own warp list, filtered and projected with no Mod-side truncation",
});

/** The Mod's declared backpack ceiling, read from the Mod rather than typed here. */
export const MAXIMUM_INVENTORY_SLOT_FACT = "MaximumInventorySlot";

/**
 * The collections whose `.Count` IS the actor's backpack size.
 *
 * A loop over one of these publishes at most one row per slot, so the Mod's own backpack ceiling
 * bounds it. The set is closed and named rather than inferred from a type: the alternative is a C#
 * type resolver, and a wrong guess there would silently bound an unbounded scan.
 */
export const BACKPACK_COLLECTIONS = Object.freeze(["items", "Items"]);

function read(relative) {
  return readFileSync(path.join(repositoryRoot, relative), "utf8");
}

/** Comments carry braces, parentheses and commas of their own, so they go before any parsing. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function camelCase(name) {
  return name[0].toLowerCase() + name.slice(1);
}

function modSources() {
  const files = [];
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(repositoryRoot, relative))) {
      const child = `${relative}/${entry}`;
      if (statSync(path.join(repositoryRoot, child)).isDirectory()) {
        if (!MOD_DIRECTORIES_NEVER_PRODUCING.has(entry)) walk(child);
      } else if (entry.endsWith(".cs")) {
        files.push({ file: child, text: withoutComments(read(child)) });
      }
    }
  };
  walk(MOD_SOURCE_ROOT);
  return files;
}

/** Splits on top-level commas, ignoring commas inside brackets. */
export function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

/** The text between the parenthesis at `startIndex` and its matching close. */
export function balancedParentheses(text, startIndex) {
  const open = text.indexOf("(", startIndex);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(open + 1, index), end: index };
    }
  }
  return null;
}

/** The contents of the brace block that starts at `startIndex`. */
function braceBlock(text, startIndex) {
  const open = text.indexOf("{", startIndex);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(open + 1, index), end: index };
    }
  }
  return null;
}

/**
 * Every parameter of the wire record, in declaration order.
 *
 * The record is the Mod's own statement of which families exist, so it - not a list written here
 * - is the producer-side population. Declaration order is load-bearing: the single construction
 * site passes one argument per parameter, so the zip against this list is what maps each family
 * to the expression that produces it.
 */
export function snapshotRecordParameters(modelsSource) {
  const source = withoutComments(modelsSource);
  const declaration = source.indexOf("public sealed record BridgeSnapshot(");
  if (declaration < 0) throw new Error("the Mod no longer declares `public sealed record BridgeSnapshot(`");
  const parameters = balancedParentheses(source, declaration);
  if (parameters === null) throw new Error("the `BridgeSnapshot` parameter list does not close");
  return splitTopLevel(parameters.inner).map((parameter) => {
    const declared = parameter.match(/^(.+?)\s+(\w+)(?:\s*=\s*[\s\S]*)?$/);
    if (declared === null) throw new Error(`unparseable BridgeSnapshot parameter: ${parameter}`);
    return { type: declared[1].trim(), name: declared[2] };
  });
}

/** The record parameters that carry a published list: the families this gate bounds. */
export function snapshotFamilyParameters(parameters) {
  return parameters.filter((parameter) => parameter.type.includes("IReadOnlyList<"));
}

/**
 * Each wire family mapped to the construction-site expression that fills it.
 *
 * The capability guard around a projection names actions, not the producer, so it is stripped
 * first; what remains is either a call or an inline projection such as `location.warps.Select(…)`.
 */
export function snapshotProducers(parameters, constructionSource) {
  const source = withoutComments(constructionSource);
  const construction = source.indexOf("new BridgeSnapshot(");
  if (construction < 0) throw new Error("no `new BridgeSnapshot(` construction site in the execution controller");
  const argumentList = balancedParentheses(source, construction);
  if (argumentList === null) throw new Error("the `BridgeSnapshot` construction argument list does not close");
  const argumentsList = splitTopLevel(argumentList.inner);
  // The construction is the record's own parameter list in the same order. A length mismatch means
  // a family was added or removed on ONE side - the shape that produced drifts C and D - so it is
  // reported as a finding naming the counts rather than thrown as an unreadable stack trace.
  if (argumentsList.length !== parameters.length)
    return { mismatch: { arguments: argumentsList.length, parameters: parameters.length }, producers: new Map() };
  const producers = new Map();
  argumentsList.forEach((argument, index) => {
    const named = argument.match(/^(\w+)\s*:\s*([\s\S]+)$/);
    const field = camelCase(named === null ? parameters[index].name : named[1]);
    const expression = (named === null ? argument : named[2])
      .replace(/advertisedCapabilities\.\w+\([^)]*\)/g, " ")
      .replace(/\b(?:true|false|null)\s*\?/g, " ")
      .trim();
    producers.set(field, expression);
  });
  return { mismatch: null, producers };
}

/** Every `const int` the Mod declares, resolved through the same expression reader, plus the
 * defaulted `int` parameters of the Mod's policy records (the backpack ceiling lives on one). */
export function modConstants(sources) {
  const constants = new Map();
  const pending = [];
  for (const { text } of sources) {
    for (const match of text.matchAll(/\bconst int (\w+)\s*=\s*([^;]+);/g)) pending.push([match[1], match[2]]);
    // A defaulted `int` parameter of one of the Mod's policy records carries a declared fact
    // (`MaximumInventorySlot = 36` on `FarmhandExecutionAcceptanceFacts`).
    for (const match of text.matchAll(/\bint (\w+)\s*=\s*(-?\d+)\s*[,)]/g))
      if (!constants.has(match[1])) constants.set(match[1], Number(match[2]));
  }
  // Two passes: a constant may be written in terms of one declared after it in file order.
  for (let pass = 0; pass < 3; pass += 1)
    for (const [name, expression] of pending) {
      const value = evaluateIntegerBound(expression, constants);
      if (value !== null) constants.set(name, value);
    }
  return constants;
}

/** The literal length of every `static readonly T[] Name = { ... }` the Mod declares. */
export function staticArrayLengths(sources) {
  const arrays = new Map();
  for (const { text } of sources) {
    for (const match of text.matchAll(/static readonly [\w.]+\[\] (\w+)\s*=\s*(?:new\s*[\w.]*\s*\[\]\s*)?\{/g)) {
      const block = braceBlock(text, match.index);
      if (block !== null) arrays.set(match[1], splitTopLevel(block.inner).length);
    }
  }
  return arrays;
}

/**
 * The largest value an integer expression may take, or null when it is not bounded statically.
 *
 * Deliberately tiny: a literal, a declared constant, `Math.Min`/`Math.Clamp` (whose smallest
 * known argument is a ceiling), `Math.Max` (which needs all of them), and `+ - * /` over those.
 * That is enough to read `Math.Min(lowestLevelReached, HighestSelectableMineFloor)` as at most the
 * floor ceiling, and nothing more.
 */
export function evaluateIntegerBound(expression, constants) {
  const source = expression
    .trim()
    .replace(/^\((.*)\)$/s, "$1")
    .trim();
  if (/^-?\d+$/.test(source)) return Number(source);
  const named = constants.get(source.replace(/^[\w.]+\./, ""));
  if (named !== undefined) return named;
  const call = source.match(/^Math\.(Min|Max|Clamp)\(([\s\S]*)\)$/);
  if (call !== null) {
    const values = splitTopLevel(call[2]).map((argument) => evaluateIntegerBound(argument, constants));
    const known = values.filter((value) => value !== null);
    if (call[1] === "Max") return known.length === values.length ? Math.max(...known) : null;
    return known.length === 0 ? null : Math.min(...known);
  }
  const arithmetic = source.match(/^(.+?)\s*([+\-*/])\s*(\d+)$/s);
  if (arithmetic !== null) {
    const left = evaluateIntegerBound(arithmetic[1], constants);
    if (left === null) return null;
    const right = Number(arithmetic[3]);
    if (arithmetic[2] === "+") return left + right;
    if (arithmetic[2] === "-") return Math.max(0, left - right);
    if (arithmetic[2] === "*") return left * right;
    return Math.floor(left / right);
  }
  return null;
}

/**
 * The full body of one Mod method that RETURNS A LIST, block-bodied or expression-bodied.
 *
 * The `IReadOnlyList<` requirement in the signature is what keeps a record's constructor from being
 * mistaken for a producer: `new BridgeWarp(…)` inside a `.Select` is how a row is built, not where
 * the family's ceiling lives, and reading the record's own declaration as a body would attribute an
 * unrelated `Take` to it.
 */
export function methodBody(sources, name) {
  for (const { text } of sources) {
    for (const match of text.matchAll(/[^\n]*IReadOnlyList<[^\n]*?\b(\w+)\s*\(/g)) {
      if (match[1] !== name) continue;
      const arrow = text.indexOf("=>", match.index);
      const open = text.indexOf("{", match.index);
      const semicolon = text.indexOf(";", match.index);
      if (arrow >= 0 && arrow < open && arrow < semicolon) {
        let depth = 0;
        for (let index = arrow; index < text.length; index += 1) {
          if (text[index] === "(" || text[index] === "[") depth += 1;
          else if (text[index] === ")" || text[index] === "]") depth -= 1;
          else if (text[index] === ";" && depth === 0) return text.slice(match.index, index + 1);
        }
        continue;
      }
      if (open < 0) continue;
      let depth = 0;
      for (let index = open; index < text.length; index += 1) {
        if (text[index] === "{") depth += 1;
        else if (text[index] === "}") {
          depth -= 1;
          if (depth === 0) return text.slice(match.index, index + 1);
        }
      }
    }
  }
  return null;
}

/**
 * The largest number of entries one producer can publish, or null when it states no ceiling.
 *
 * The rule is the MINIMUM of every construct that truncates the list the method RETURNS:
 *
 *   a `.Take` anywhere in the body caps the whole list, whatever preceded it;
 *   a `Count` guard on the returned list caps that list, whether it is written as a `break` or in
 *   the loop header (`for (… && result.Count < 64; …)`);
 *   a loop over the backpack publishes at most one row per slot;
 *   a `foreach` over a `static readonly` array visits exactly its length;
 *   a literal initializer publishes exactly its elements.
 *
 * Named `int` counters (`placementCount`, `objectCount`, `builtCount`) are the one addition: each is
 * an independent budget for a different KIND of row in the same array, so the world-object lane
 * really can publish sixteen placement candidates plus sixteen placed objects.
 *
 * Minimum, not sum, for everything else, because two loops that both truncate the same returned
 * list do not add up - and a gate that adds them would refuse correct code and be turned off.
 * Constructs whose ceiling cannot be read are recorded in `declined`; a body with no ceiling at all
 * returns null, which is the `obeliskTargets` defect and must never read as "bounded by its loops".
 */
export function producerBound(text, constants, arrays, sources = []) {
  const backpackCeiling = constants.get(MAXIMUM_INVENTORY_SLOT_FACT) ?? null;
  const locals = localConstants(text, constants);
  const returned = returnedListName(text);
  const declined = [];
  const ceilings = [];
  let budgets = 0;

  for (const match of text.matchAll(/\.(?:Take|TakeLast)\(/g)) {
    const call = balancedParentheses(text, match.index);
    if (call === null) continue;
    const ceiling = resolveBound(call.inner, constants, text, sources);
    if (ceiling === null) declined.push(`.Take(${call.inner.trim()})`);
    else ceilings.push(ceiling);
  }

  for (const match of text.matchAll(
    /for \(\s*int (\w+) = ([^;]+);\s*\w+\s*(<=|<)\s*([^;]+);\s*\w+\s*(?:\+=\s*([\w.]+)|\+\+)?\s*\)/g,
  )) {
    const to = match[4].trim();
    if (isBackpackCount(to)) {
      if (backpackCeiling === null) declined.push(`for (… ${to})`);
      else ceilings.push(backpackCeiling);
      continue;
    }
    const from = evaluateIntegerBound(match[2], locals);
    const ceiling = evaluateIntegerBound(to.split("&&")[0], locals);
    const step = match[5] === undefined ? 1 : evaluateIntegerBound(match[5], locals);
    if (from === null || ceiling === null || step === null || step <= 0) {
      declined.push(`for (… ${match[3]} ${to})`);
      continue;
    }
    const span = match[3] === "<=" ? ceiling - from + 1 : ceiling - from;
    ceilings.push(Math.ceil(span / step));
  }

  // A guard on the RETURNED list caps it. A guard on a differently named `int` is that kind's own
  // budget, and those are independent, so they are the one thing that adds.
  for (const match of text.matchAll(/(\w+)(?:\.Count)?\s*(>=|>|==)\s*([\w.]+)\s*\)?\s*(?:break|return|\{)/g)) {
    const ceiling = evaluateIntegerBound(match[3], constants);
    if (ceiling === null) {
      declined.push(`${match[1]} ${match[2]} ${match[3]}`);
      continue;
    }
    const value = match[2] === ">" ? ceiling + 1 : ceiling;
    if (match[1] === returned) ceilings.push(value);
    else if (declaresIntBudget(text, match[1])) budgets = Math.max(budgets, 0) + value;
  }
  for (const match of text.matchAll(/(\w+)(?:\.Count)?\s*(?:<=|<)\s*([\w.]+)\s*(?=[;&|)])/g)) {
    const ceiling = evaluateIntegerBound(match[2], constants);
    if (ceiling === null) continue;
    if (match[1] === returned) ceilings.push(ceiling);
    else if (declaresIntBudget(text, match[1])) budgets += ceiling;
  }

  for (const match of text.matchAll(/foreach \([^)]*\bin (\w+)[^)]*\)/g)) {
    const source = match[1];
    const length = arrays.get(source);
    if (length !== undefined) {
      ceilings.push(length);
      continue;
    }
    const delegated = helperListCeiling(text, source, constants, arrays, sources);
    if (delegated === null) declined.push(`foreach (… in ${source})`);
    else ceilings.push(delegated);
  }

  for (const match of text.matchAll(/return new[\w.]*(?:\[\])?\s*\{/g)) {
    const block = braceBlock(text, match.index + match[0].length - 1);
    if (block !== null) ceilings.push(splitTopLevel(block.inner).length);
  }

  // A `Take` truncates the whole list, so it caps whatever the budgets produced; without one, the
  // budgets are the only ceiling there is.
  const ceiling = ceilings.length === 0 ? null : Math.min(...ceilings);
  if (ceiling === null && budgets === 0) return { bound: null, declined };
  if (ceiling === null) return { bound: budgets, declined };
  if (budgets === 0) return { bound: ceiling, declined };
  return { bound: Math.min(ceiling, budgets), declined };
}

/**
 * The list the method builds and hands back - the one whose ceiling matters.
 *
 * Named from its declaration (`List<T> result = new()`), not from the `return`, because a body with
 * a callback has `return true;` / `return false;` inside it and the last of those is not a list.
 */
function returnedListName(text) {
  const declared = [...text.matchAll(/List<[\w.?]+>\s+(\w+)\s*=\s*new/g)].map((match) => match[1]);
  return declared.length === 0 ? null : declared.at(-1);
}

/** Whether a name is a `int x = 0;` budget rather than the returned list or a lookup variable. */
function declaresIntBudget(text, name) {
  return new RegExp(`\\bint ${name}\\s*=\\s*0\\s*;`).test(text);
}

/** Whether an expression is a backpack's own size, so the Mod's slot ceiling bounds it. */
function isBackpackCount(expression) {
  const source = expression.trim();
  return BACKPACK_COLLECTIONS.some((name) => source === `${name}.Count` || source.endsWith(`.${name}.Count`));
}

/**
 * Every local `int` a body declares, resolved through the same expression reader.
 *
 * A producer usually states its ceiling through a local (`int highest = …; for (… <= highest; …)`),
 * so the locals are read as constants of their own scope. A local initialised by a method call
 * stays unresolved, which is reported as unreadable rather than guessed at.
 */
function localConstants(text, constants) {
  const locals = new Map(constants);
  for (let pass = 0; pass < 3; pass += 1)
    for (const match of text.matchAll(/\bint (\w+)\s*=\s*([^;]+);/g)) {
      const value = evaluateIntegerBound(match[2], locals);
      if (value !== null) locals.set(match[1], value);
    }
  return locals;
}

/**
 * A `.Take` argument that names a local instead of a constant.
 *
 * Two shapes resolve:
 *
 *   a local `int rowLimit = …;` in the same body, read through the same expression reader;
 *   a call into a type that DECLARES its family row budget (`PlantableTargetRows.FamilyRowLimit`),
 *     because such a helper's whole contract is to divide that one budget across the rows it hands
 *     back. Reading the declared constant is what keeps this a fact rather than a guess.
 */
function resolveBound(expression, constants, text, sources) {
  const source = expression.trim();
  const local = evaluateIntegerBound(source, localConstants(text, constants));
  if (local !== null) return local;
  // A local whose initializer is a call: read the initializer through this same reader, so a
  // `int rowLimit = …` naming a declared budget still resolves.
  const initializer = text.match(new RegExp(`\\bint ${source}\\s*=\\s*([^;]+);`));
  if (initializer !== null) {
    const nested = resolveBound(initializer[1], constants, text, sources);
    if (nested !== null) return nested;
  }
  const budget = source.match(/^([A-Z]\w+)\.\w+\s*\(/);
  if (budget === null) return null;
  const declared = sources
    .filter((entry) => entry.file.endsWith(`${budget[1]}.cs`))
    .flatMap((entry) => [...entry.text.matchAll(/const int \w*RowLimit\s*=\s*(\d+)/g)])
    .map((match) => Number(match[1]));
  return declared.length === 0 ? null : Math.min(...declared);
}

/**
 * The ceiling of a `foreach (x in Source)` whose source is another Mod method's list.
 *
 * Followed one level, and only when the source names a call: a helper's own body is where a
 * computed collection states its size (`SelectableMineFloors` is bounded by the mine's floor
 * ceiling). A source that is a field or property of the game is NOT followed - its size lives in
 * the game, not in the Mod - so it reports as unreadable rather than being guessed at.
 */
function helperListCeiling(text, source, constants, arrays, sources) {
  const call = text.match(new RegExp(`\\b${source}\\s*\\(`));
  if (call === null) return null;
  const body = methodBody(sources, source);
  if (body === null) return null;
  return producerBound(body, constants, arrays, sources).bound;
}

/** The Host's per-family cap table. */
export function hostFamilyCaps(protocolSource) {
  const source = withoutComments(protocolSource);
  const start = source.indexOf("export const SNAPSHOT_FAMILY_RULES");
  if (start < 0) throw new Error("`SNAPSHOT_FAMILY_RULES` is gone from host/src/protocol.ts");
  const end = source.indexOf("]);", start);
  if (end < 0) throw new Error("`SNAPSHOT_FAMILY_RULES` does not close with `]);`");
  const caps = new Map();
  for (const match of source.slice(start, end).matchAll(/\{\s*field:\s*"(\w+)",\s*maxItems:\s*(\d+)/g))
    caps.set(match[1], Number(match[2]));
  if (caps.size === 0) throw new Error("`SNAPSHOT_FAMILY_RULES` declares no entry");
  return caps;
}

/** The language-neutral wire contract's own per-family ceiling. */
export function schemaFamilyCaps(schema) {
  const properties = schema?.$defs?.snapshot?.properties;
  if (properties === undefined)
    throw new Error("`protocol/bridge-v1.schema.json` declares no `$defs.snapshot.properties`");
  const caps = new Map();
  for (const [field, property] of Object.entries(properties))
    if (property?.type === "array" && typeof property.maxItems === "number") caps.set(field, property.maxItems);
  return caps;
}

/**
 * The full report. Every row is derived from the four sources; the only hand-written entries are
 * the two documented no-cap families, and a cap table member the record does not declare - or a
 * record family the cap table does not admit - is itself a finding.
 */
export function checkSnapshotFamilyBounds({
  models = read(MODELS_PATH),
  construction = read(CONSTRUCTION_PATH),
  protocol = read(PROTOCOL_PATH),
  schema = JSON.parse(read(SCHEMA_PATH)),
  sources = modSources(),
} = {}) {
  const parameters = snapshotRecordParameters(models);
  const { mismatch, producers } = snapshotProducers(parameters, construction);
  const caps = hostFamilyCaps(protocol);
  const schemaCaps = schemaFamilyCaps(schema);
  const constants = modConstants(sources);
  const arrays = staticArrayLengths(sources);

  const findings = [];
  const rows = [];
  const families = snapshotFamilyParameters(parameters).map((parameter) => camelCase(parameter.name));

  if (mismatch !== null) {
    findings.push({
      field: "BridgeSnapshot",
      kind: "construction_arity_mismatch",
      detail:
        `the construction site passes ${mismatch.arguments} arguments but the wire record declares ${mismatch.parameters} ` +
        `parameters, so at least one family exists on one side only and no field can be matched to its producer`,
    });
    return Object.freeze({
      schema: GATE,
      familyCount: 0,
      findings: Object.freeze(findings),
      rows: Object.freeze(rows),
      narrowed: Object.freeze([]),
      ok: false,
    });
  }

  for (const field of families) {
    const cap = caps.get(field);
    if (cap === undefined) {
      if (Object.hasOwn(FAMILIES_WITHOUT_A_HOST_CAP, field)) continue;
      findings.push({
        field,
        kind: "missing_host_cap",
        detail: "the Mod publishes this family but the Host admits no cap for it, so nothing checks its length",
      });
      continue;
    }
    const expression = producers.get(field);
    if (expression === undefined) {
      findings.push({
        field,
        kind: "missing_mod_family",
        detail: `the wire record declares this family but the construction site passes no argument for it`,
      });
      continue;
    }
    const call = expression.match(/\b([A-Z]\w+)\s*\(/);
    const body = call === null ? null : methodBody(sources, call[1]);
    // The producer's own body is what is read. The construction-site expression only states which
    // method runs (behind a capability guard), so folding it in would count the same `Take` twice.
    const scanned = body === null ? expression : body;
    const { bound, declined } = producerBound(scanned, constants, arrays, sources);
    const schemaCap = schemaCaps.get(field);
    rows.push({ field, expression: expression.replace(/\s+/g, " "), bound, cap, schemaCap });
    const engine = ENGINE_PUBLISHED_FAMILIES[field];

    if (bound === null) {
      if (engine !== undefined) {
        rows.at(-1).enginePublished = engine;
        continue;
      }
      findings.push({
        field,
        kind: "unreadable_bound",
        detail:
          `producer \`${rows.at(-1).expression}\` states no ceiling this gate can read, and the Host admits ${cap}. ` +
          `Readable forms: ${PRODUCER_BOUND_FORMS.join("; ")}` +
          (declined.length === 0 ? "" : ` (declined here: ${[...new Set(declined)].slice(0, 4).join(", ")})`),
      });
    } else if (bound > cap) {
      findings.push({
        field,
        kind: "producer_exceeds_cap",
        detail:
          `producer \`${rows.at(-1).expression}\` can publish ${bound} entries but the Host admits ${cap}, ` +
          `so entry ${cap + 1} closes the bridge with invalid_snapshot:${field}:count=${cap + 1}`,
      });
    } else if (engine !== undefined) {
      findings.push({
        field,
        kind: "stale_engine_exemption",
        detail: `${field} now states a ceiling this gate can read (${bound}), so drop it from ENGINE_PUBLISHED_FAMILIES`,
      });
    }
    if (schemaCap !== undefined && schemaCap < cap) {
      findings.push({
        field,
        kind: "schema_below_host_cap",
        detail: `the Host admits ${cap} ${field} entries but the wire schema declares maxItems ${schemaCap}`,
      });
    }
  }

  for (const [field, cap] of caps) {
    if (families.includes(field)) continue;
    findings.push({
      field,
      kind: "missing_mod_family",
      detail: `the Host admits ${cap} ${field} entries but the Mod's wire record declares no such family`,
    });
  }

  return Object.freeze({
    schema: GATE,
    familyCount: rows.length,
    findings: Object.freeze(findings),
    rows: Object.freeze(rows),
    narrowed: Object.freeze(
      rows
        .filter((row) => row.bound !== null && row.bound < row.cap)
        .map((row) => ({ field: row.field, bound: row.bound, cap: row.cap })),
    ),
    ok: findings.length === 0,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkSnapshotFamilyBounds();
  if (process.argv.includes("--rows"))
    for (const row of report.rows)
      process.stdout.write(
        `  ${row.field} bound=${row.bound} host=${row.cap} schema=${row.schemaCap} from ${row.expression}\n`,
      );
  process.stdout.write(
    `snapshot family bounds: ${report.familyCount} families derived from the Mod wire record and the Host cap table\n`,
  );
  for (const narrowing of report.narrowed)
    process.stdout.write(
      `  narrower than the ceiling: ${narrowing.field} publishes at most ${narrowing.bound}, the Host admits ${narrowing.cap}\n`,
    );
  for (const finding of report.findings)
    process.stdout.write(`  [${finding.kind}] ${finding.field}: ${finding.detail}\n`);
  process.stdout.write(
    report.ok
      ? "  every family's producer ceiling is readable and within the Host's cap\n"
      : `  ${report.findings.length} finding(s)\n`,
  );
  process.exitCode = report.ok ? 0 : 1;
}
