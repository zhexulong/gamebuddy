#!/usr/bin/env node
/**
 * The complexity gate: cognitive complexity per FUNCTION, and per CLASS with its partials merged.
 *
 * WHY THE UNIT IS THE CLASS AND THE FUNCTION, NOT THE FILE. Measured at 2026-11-13:
 * `integrations/stardew` holds 564 `.cs` files and 157,181 lines, and the execution controller is spread over 46
 * `farmhandexecutioncontroller*.cs` files - whose class is declared 47 times and is named `ExecutionManager`, not
 * after any of its files. A per-file metric cannot see that: splitting a class into 46 files *reduces* every
 * file's number while making the class harder to hold in one head. So a class is measured once, as the union of
 * its parts, and the failure names the drift:
 *
 *   class_complexity_over_bound:<class>:<parts>:<n>
 *
 * RED ON THE TREE THIS WAS WRITTEN AGAINST (the baseline records these; the gate does not fix them):
 *   cs function  `ModEntry.TryInitializeNativeLocalPlayerFixtureScenario(NativeLocalPlayerFixtureConfig)`
 *                @ integrations/stardew/ModEntry.Fixtures.cs:307 = 971, bound 30
 *   ts function  `isModDescriptorComplete` @ host/src/action-registry.ts:934 = >=255 (biome saturates at 255),
 *                bound 30 - Biome's own number, at its ceiling; see the paragraph below
 *   class        `ExecutionManager`: 47 partial declarations over 46 files = 4,771 complexity, 28,097 lines,
 *                789 members - the same class a file-based measure would have called 46 healthy files.
 *   Today's readings: 7,405 cs functions (58 over 30), 90 ts functions reported over 30 of 292 files read
 *   (4 of them at Biome's ceiling), 1,113 types merged from 1,214 partial declarations (8 over 200 complexity,
 *   19 over the size ceilings).
 *
 * THE TWO PRODUCERS, AND WHY THEY ARE NEVER COMPARED. Each language's number has one owner, printed beside
 * every number it produced:
 *
 *   ts: `complexity/noExcessiveCognitiveComplexity` from Biome, at the bound the project's own `biome.json`
 *       declares (read at run time, so the number has one owner and this gate cannot disagree with the
 *       linter). Biome 2.2.4 implements SonarSource cognitive complexity; the measurement lives there.
 *   cs: SonarSource S3776 implemented HERE, over the pinned `tree-sitter-c-sharp` wasm grammar from
 *       `@vscode/tree-sitter-wasm`, through the `web-tree-sitter` runtime the repository already uses for C#
 *       (`tools/lib/stardew-csharp-syntax-structural-canary.mjs`). This is a second implementation of a
 *       published metric, and the reasons it exists are measured, not assumed:
 *         - The `IncludeAssets="…analyzers…"` package in the Stardew csprojs is `xunit.runner.visualstudio`
 *           (a test runner, `PrivateAssets=all`); `Pathoschild.Stardew.ModBuildConfig` is the only other
 *           reference. Neither measures complexity.
 *         - `~/.nuget/packages` holds exactly one analyzer package, `xunit.analyzers`, so SonarAnalyzer/S3776
 *           is not available offline.
 *         - The SDK's NetAnalyzers 9.0.14 contain the strings CA1502/CA1505 but emit neither: a probe project
 *           (net8.0, `AnalysisMode=All`, `.editorconfig dotnet_diagnostic.CA1502.severity=warning`) over a
 *           deliberately complex method produced CA1050 and CA1031 only.
 *         - Even a live CA1502 could not see the target: `dotnet build integrations/stardew/GameBuddy.Stardew.csproj
 *           -p:AnalysisMode=All` compiled with **0 warnings** against the local licensed game, and
 *           `tools/check-csharp-compile.mjs` records that the Mod project cannot build in CI at all (no game
 *           folder), so a Roslyn-based C# half would read `not_measured` on every run that matters.
 *       A ts number and a cs number are never summed, averaged or compared: they measure different operator
 *       sets (S3776 counts loops and `switch`, Biome's JS implementation does not), so each bound is its own
 *       constant with its own reason.
 *
 * BIOME'S CEILING: 255 IS A FLOOR, NOT A MEASUREMENT. Biome carries the score in a byte, so every function at or
 * above it reports exactly 255 - measured, not assumed: three synthetic functions of 254, 256 and 300 sequential
 * `if`s read "254", "255" and "255" from biome 2.2.4, and four unrelated functions in this tree (four `dispatch`/
 * validator handlers) all read 255 on the same run. A 255 printed with the confidence of `83` breaks the only use
 * of the list - priority, since every function at the floor ties for "the worst". So a reading AT the ceiling is
 * printed as `>=255 (biome saturates at 255)` in the reading line, in the failure line, in the baseline and in the
 * JSON, and the report states how many ts functions sit there (`saturating K of N`, the population). The true value
 * is NOT recovered by summarising Biome's algorithm: a second implementation of the metric is the thing the ts
 * half of this gate exists to avoid.
 *
 * WHAT THE C# IMPLEMENTATION COUNTS (SonarSource's published rules, and where this reading was chosen):
 *   +1 (plus the current nesting depth) for `if`, loops (`for`/`foreach`/`while`/`do`), `switch`, `switch`
 *   expressions, `catch`, and `?:`. Each `else if` and each `else` is +1 with NO nesting increment, and each
 *   `case`/`default` section of a `switch` (and each arm of a `switch` expression) is +1 without a nesting
 *   increment - the reading Sonar's C# walker takes for `switch`, whose sections belong to one structure.
 *   `goto` is +1. A sequence of binary logical operators (`&&`, `||`, `??`) is counted once per RUN of the same
 *   operator, so `a && b && c` is 1 and `a && b || c` is 2 (whitepaper §"increments for sequences of logical
 *   operators"). A nested function - `lambda_expression`, `anonymous_method_expression`,
 *   `local_function_statement` - restarts nesting at 0 (whitepaper: "the nesting level of a nested function
 *   restarts at zero") while its increments stay with the member that owns it, because a local function is not
 *   separately addressable.
 *   NOT COUNTED, stated rather than hidden: recursion (the whitepaper's optional B4; deciding it needs name
 *   resolution, and a name-match heuristic would be a second authority over what the compiler resolved), and
 *   field initializers (only members with a body are measured). Both omissions make a cs number a LOWER bound
 *   on Sonar's own count - a direction that cannot turn a real offender green.
 *   A member kind this gate cannot name but which carries a body is `complexity_unmeasured_member` rather than
 *   silently skipped: the grammar's population is read, not remembered.
 *
 * THE TYPESCRIPT HALF. Biome reports a value only for a function OVER its bound, so this gate reads exactly
 * those and the population is every shipped `host/src` module (`tools/lib/host-production-sources.mjs`, which
 * mirrors `host/tsconfig.json`). There is no TypeScript class aggregation and the gate prints why: a class sum
 * built from only-over-bound members is an incomplete number that would read as a verdict it cannot support.
 * TypeScript has no partial classes, so per-function is the whole question there.
 *
 * THE RATCHET. `tools/cognitive-complexity-baseline.json` records every member and class over its bound at the
 * commit that recorded it. The gate fails when:
 *   - a measured member/class is over its bound and not recorded          `function_over_bound` / `class_complexity_over_bound`
 *   - a recorded member/class GREW past its recorded value                 `function_grew` / `class_grew`
 *   - a recorded member/class is no longer measured                        `stale_complexity_baseline`
 *   - a recorded CLASS SIZE predates a structural change                   `class_size_record_stale` (see below)
 * Member identity is the qualified signature (`cs:<Namespace.Type>.<Member>(<param types>)`,
 * `ts:<file>#<Class>.<name>`), NOT `file:line`: moving a method between the 46 partials of its class is the
 * expected edit in this tree and must not read as a new offender. The parameter types are part of it because
 * overloads share a name (`BridgeSession` declares four `ToWire(x)`), and an explicit interface implementation
 * carries its specifier. `file` and `line` travel in the baseline for the reader and are refreshed by
 * `--update`, which is its own commit.
 *
 * THE FUNCTION HALF HAS NO SUCH AMBIGUITY, said out loud rather than assumed: a member's record is ONE scalar taken
 * from one measurement of one body, so `measured > recorded` for the same identity can only mean that member gained
 * branches - there is no second field the record and the tree could have got from different commits. Its other fact
 * already has its own name and is a different fact: `stale_complexity_baseline` means the recorded member is not in
 * the tree at all (renamed, deleted, or moved under a new identity). The two never compete for one name. The SIZE
 * record is the exception, because `lines` moves with every edit while `parts`/`methods` move only when the class's
 * structure does, so one size entry can describe two different trees at once - which is what
 * `class_size_record_stale` names.
 *
 * WHAT THE RATCHET CAN AND CANNOT DISTINGUISH AT THE CEILING. A ts member whose value is at Biome's ceiling is
 * stored with `saturated: true` beside its value, so a reader of the baseline sees a floor where the gate sees one
 * and cannot mistake it for a precise count. ENTERING the ceiling is visible: it is growth from a recorded precise
 * value (`52 -> >=255`), and an unrecorded saturated function is `function_over_bound`, so saturation can never be
 * acquired silently. LEAVING it is visible: a measured value below 255. What is NOT visible is movement INSIDE the
 * ceiling - a recorded 255 and a measured 255 compare equal whether the function held its branches or gained a
 * hundred, because both readings are the same clamp. So a saturated entry passes while it stays saturated, and the
 * honest content of that pass is the print, not the verdict: the number is `>=255` everywhere and the report counts
 * the functions standing at the floor. Nothing in this gate can prove such a function did not grow; the only way to
 * restore a precise reading is to bring it below 255.
 *
 * CLASS SIZE, over the same stitched type index: total lines (the line span of every declaration merged) and member
 * declarations, against `class_lines_over_ceiling:<type>:<lines>:<ceiling>:<parts>` and
 * `class_methods_over_ceiling:<type>:<methods>:<ceiling>`. Same ratchet shape - an unrecorded type fails when it is
 * over a ceiling, a recorded type the tree no longer has is `stale_class_ceiling:<type>` - with one reading split in
 * two because it had one name for two facts:
 *   `class_size_grew`          the record's `parts` and `methods` still match the tree and the line count went up.
 *   `class_size_record_stale`  those fields disagree with the tree, so the record predates a structural change and
 *                              its line count describes a class that no longer exists in that shape. Still a finding
 *                              (a number nobody can trust is still being compared), but the message asks for
 *                              `--update` with the arithmetic instead of a smaller class.
 * Measured 2026-11-12, before the split: a commit that SHRANK `ModEntry` by 76 lines was reported as growth, because
 * the record's 15,356 lines/335 methods/56 partials predated the commit that inlined 68 initialisers (its parent
 * measured 15,502 lines/267 methods/55 partials). `parts` is the field that catches it: the record's methods had been
 * corrected by then, its partials had not. What the split cannot see is a stale record whose `parts` and `methods`
 * happen to still match - then only `lines` witnesses it, and the recorded `revision` in the finding is the reader's
 * only cheap check. This is how the gate says "`ExecutionManager` is 28,097 lines over 47 parts" out loud instead of
 * being red on day one and switched off. Ceilings: 1,000 lines / 40 member declarations, with the distribution that
 * chose them in the constant's own comment.
 *
 * USAGE:
 *   node tools/check-cognitive-complexity.mjs              # the verdict; exit 1 on any finding
 *   node tools/check-cognitive-complexity.mjs --update     # re-record the baseline (its own commit)
 *   node tools/check-cognitive-complexity.mjs --root <dir>  # the gate's own fixture tree
 *
 * red-proof: inject  a fourth `if` inside a `for` inside a method -> `function_over_bound:cs:Fixture.Type.Run(int)`,
 *   with the nesting-increment cases pinned in tools/check-cognitive-complexity.test.mjs
 * red-proof: inject  a second partial declaring the same class -> the class is measured once with `parts: 2`,
 *   so the same method split across two files cannot hide (tools/check-cognitive-complexity.test.mjs)
 * red-proof: inject  a function of 300 sequential `if`s -> biome reads 255, and the gate prints
 *   `= >=255 (biome saturates at 255)` with `saturating 1 of N` in the reading line, the failure and the JSON,
 *   never `= 255` as a measurement; growing a recorded 40 into the ceiling is `function_grew: <id> 40 -> >=255`
 *   (tools/check-cognitive-complexity.test.mjs)
 * red-proof: inject  a baseline entry for a member the tree no longer has -> `stale_complexity_baseline:<member>`
 *   (tools/check-cognitive-complexity.test.mjs)
 * red-proof: inject  a class-size record whose `parts`/`methods` predate the tree (recorded 56 partials against its
 *   58, or 267 methods against its 335) -> `class_size_record_stale` naming the disagreeing fields, never
 *   `class_size_grew`; equal structure and 30 more lines is `class_size_grew`
 *   (tools/check-cognitive-complexity.test.mjs)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Language, Parser } from "web-tree-sitter";

import { isProductionSource, listSources, sourcePath } from "./lib/host-production-sources.mjs";
import { parseJavaScript } from "./lib/javascript-ast.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const BIOME_EXECUTABLE = require.resolve("@biomejs/biome/bin/biome");
const BIOME_VERSION = require("@biomejs/biome/package.json").version;
const CSHARP_GRAMMAR = require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm");
const TS_GRAMMAR_VERSION = require("@vscode/tree-sitter-wasm/package.json").version;
const BASELINE_PATH = "tools/cognitive-complexity-baseline.json";

/**
 * The C# function bound, in the unit printed above: S3776 over tree-sitter-c-sharp.
 *
 * 30, because it is the bound this project already chose for the same question in the language it could measure
 * first (`biome.json`'s `maxAllowedComplexity: 30`, recorded in
 * `design/tasks/active/quality-tooling-and-readability-scan-2026-09.md`, where 15 was measured at 399 functions
 * and rejected as a broad baseline nobody could act on). It is NOT inherited as a comparison: S3776 counts loops
 * and `switch`, so a cs 30 and a ts 30 are not the same amount of understandability. Each is its own constant.
 */
export const CS_FUNCTION_BOUND = 30;

/**
 * The class bound: the sum of every member's own complexity over all partials, in the language's units.
 *
 * 200. A class whose parts sum past 200 has stopped being one thing under one name - which is the whole point of
 * measuring the union - while a legitimate large handler (`EventPump`, the bridge session) sums in the low
 * hundreds without any single method being unreadable. The number is a policy, not a measurement, so the
 * baseline records which classes it flags today.
 */
export const CLASS_BOUND = 200;

/**
 * The class-size ceilings, summed over every partial of one type: 1,000 lines and 40 member declarations.
 *
 * Measured on this tree at 2026-11-13 (1,113 C# types, 1,361 partial declarations): 1,000 lines puts 19 types
 * over and 800 would put 27 over, while the largest cohesive classes (`BridgeSession` at 1,739 lines, 85 members)
 * stay over either way. So the ceiling is not a number only the two giants can meet - it names a population a
 * reader can work through - and it is not so low that every ordinary handler arrives red. 40 members is the same
 * question in declarations: `ExecutionManager` declares 789 across its 47 partials, `ModEntry` 267, and the next
 * type down declares 141.
 */
export const CLASS_LINE_CEILING = 1000;
export const CLASS_METHOD_CEILING = 40;

/** `&&`, `||` and `??`: one increment per run of the same operator inside a sequence (S3776). */
const LOGICAL_OPERATORS = new Set(["&&", "||", "??"]);

/** A nested function restarts nesting at 0; its increments stay with the member that owns it. */
const NESTED_FUNCTION_KINDS = new Set(["lambda_expression", "anonymous_method_expression", "local_function_statement"]);

/** Type declarations, whose bodies hold the members this gate measures and merges across partials. */
const TYPE_KINDS = new Set(["class_declaration", "struct_declaration", "record_declaration", "interface_declaration"]);

/** Every member kind carrying a body, so an unrecognised one can be named instead of skipped. */
const CS_MEMBER_KINDS = new Set([
  "method_declaration",
  "constructor_declaration",
  "destructor_declaration",
  "operator_declaration",
  "conversion_operator_declaration",
  "property_declaration",
  "indexer_declaration",
]);

const ACCESSOR_KEYWORDS = new Set(["get", "set", "init", "add", "remove"]);

/** Function nodes in tree-sitter-typescript, for naming a diagnostic Biome located only by offset. */
const TS_FUNCTION_KINDS = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "generator_function",
  "arrow_function",
  "method_definition",
]);

const TS_CLASS_KINDS = new Set(["class_declaration", "class", "abstract_class_declaration"]);
const TS_RULE = "complexity/noExcessiveCognitiveComplexity";

/**
 * Biome's complexity ceiling: its score is carried in a byte, so 255 is the largest number it can print.
 *
 * Measured, not assumed: three synthetic functions of 254, 256 and 300 sequential `if`s read 254, 255 and 255 from
 * biome 2.2.4, and four unrelated functions in this tree read 255 on one run. A reading at this value is `>=255`
 * and is never printed as a count, because every function at the floor ties for "the worst" and priority is the
 * only use of that list.
 */
export const BIOME_COMPLEXITY_SATURATION = 255;

/** How one reading at that ceiling is printed, everywhere: `>=255 (biome saturates at 255)`. */
export const BIOME_SATURATION_READING = `>=${BIOME_COMPLEXITY_SATURATION} (biome saturates at ${BIOME_COMPLEXITY_SATURATION})`;

/** One reading as it may be printed: an exact number, or the floor with the reason it is a floor. */
export function formatComplexity(reading) {
  return reading.saturated === true ? BIOME_SATURATION_READING : `${reading.value}`;
}

// ---------------------------------------------------------------------------------------------------------
// C#: S3776 over the pinned tree-sitter-c-sharp grammar
// ---------------------------------------------------------------------------------------------------------

let csharpParserPromise;

function csharpParser() {
  csharpParserPromise ??= (async () => {
    await Parser.init();
    const parser = new Parser();
    parser.setLanguage(await Language.load(CSHARP_GRAMMAR));
    return parser;
  })();
  return csharpParserPromise;
}

const child = (node, field) => (node === null ? null : node.childForFieldName(field));
const childrenOf = (node) => (node === null ? [] : node.children);
const textOf = (node, source) => (node === null ? "" : source.slice(node.startIndex, node.endIndex));

const operatorOf = (node) => {
  for (const entry of childrenOf(node)) if (!entry.isNamed) return entry.type;
  return null;
};

const isLogical = (node) =>
  node !== null && node.type === "binary_expression" && LOGICAL_OPERATORS.has(operatorOf(node));

/** The operators of one logical sequence, left to right; nested runs are counted where they are written. */
function logicalOperators(node, collected) {
  const left = child(node, "left");
  const right = child(node, "right");
  if (isLogical(left)) logicalOperators(left, collected);
  collected.push(operatorOf(node));
  if (isLogical(right)) logicalOperators(right, collected);
  return collected;
}

/** One increment per RUN of the same operator: `a && b && c` = 1, `a && b || c` = 2. */
function logicalRuns(node) {
  const operators = logicalOperators(node, []);
  let runs = 1;
  for (let index = 1; index < operators.length; index += 1) if (operators[index] !== operators[index - 1]) runs += 1;
  return runs;
}

/**
 * The cognitive complexity of one body, in S3776 units. `nesting` is the number of enclosing structures that
 * themselves increment - the whitepaper's B2 - and a nested function restarts it at zero.
 */
export function csComplexity(body) {
  return body === null ? 0 : walkComplexity(body, 0);
}

function walkComplexity(node, nesting) {
  if (node === null) return 0;
  if (NESTED_FUNCTION_KINDS.has(node.type)) return walkComplexity(child(node, "body"), 0);
  switch (node.type) {
    case "if_statement":
      return ifChain(node, nesting);
    case "for_statement":
    case "foreach_statement":
    case "while_statement":
    case "do_statement":
      return 1 + nesting + walkComplexity(child(node, "body"), nesting + 1);
    case "switch_statement":
      return switchStatement(node, nesting);
    case "switch_expression":
      return switchExpression(node, nesting);
    case "catch_clause":
      // increment 1, nesting increment false (whitepaper B3): the body is scored at the depth it already has
      return 1 + walkComplexity(child(node, "body"), nesting);
    case "conditional_expression":
      return (
        1 +
        nesting +
        walkComplexity(child(node, "condition"), nesting) +
        walkComplexity(child(node, "consequence"), nesting + 1) +
        walkComplexity(child(node, "alternative"), nesting + 1)
      );
    case "goto_statement":
      return 1;
    case "binary_expression": {
      if (!isLogical(node)) return sum(childrenOf(node).map((entry) => walkComplexity(entry, nesting)));
      if (isLogical(node.parent)) return 0;
      let score = logicalRuns(node);
      for (const entry of childrenOf(node)) {
        if (isLogical(entry)) continue;
        score += walkComplexity(entry, nesting);
      }
      return score;
    }
    default:
      return sum(childrenOf(node).map((entry) => walkComplexity(entry, nesting)));
  }
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

/** `if` / `else if` / `else`: +1 each, nesting increment on the first `if` only. */
function ifChain(node, nesting) {
  const consequence = walkComplexity(child(node, "consequence"), nesting + 1);
  const alternative = child(node, "alternative");
  if (alternative === null) return 1 + nesting + consequence;
  if (alternative.type === "if_statement") return 1 + nesting + consequence + 1 + elseIfChain(alternative, nesting);
  return 1 + nesting + consequence + 1 + walkComplexity(alternative, nesting + 1);
}

/** The rest of an `else if` chain; the `if` itself has already been counted by its caller. */
function elseIfChain(node, nesting) {
  const consequence = walkComplexity(child(node, "consequence"), nesting + 1);
  const alternative = child(node, "alternative");
  if (alternative === null) return consequence;
  if (alternative.type === "if_statement") return consequence + 1 + elseIfChain(alternative, nesting);
  return consequence + 1 + walkComplexity(alternative, nesting + 1);
}

/** `switch`: +1 for the structure, +1 per section, contents one level deeper. */
function switchStatement(node, nesting) {
  let score = 1 + nesting;
  for (const section of childrenOf(child(node, "body"))) {
    if (section.type !== "switch_section") continue;
    score += 1;
    for (const entry of childrenOf(section)) score += walkComplexity(entry, nesting + 1);
  }
  return score;
}

/** A `switch` expression follows the `switch` statement's reading: +1 for the structure, +1 per arm. */
function switchExpression(node, nesting) {
  let score = 1 + nesting;
  for (const entry of childrenOf(node)) {
    if (entry.type === "switch_expression_arm") {
      score += 1;
      for (const part of childrenOf(entry)) score += walkComplexity(part, nesting + 1);
    } else {
      score += walkComplexity(entry, nesting);
    }
  }
  return score;
}

/**
 * One measured function: its name, its parameter types, and the body to score.
 *
 * The parameter TYPES are part of the identity because C# overloads share a name and an arity: `BridgeSession`
 * declares four `ToWire(x)` methods and `BridgeProtocol` four `ToWireValue(x)`, each taking a different type. Keyed
 * by name and arity alone they were one member, and one of the four shadowed the rest.
 */
function memberUnits(member, source) {
  const body = child(member, "body");
  const signature = childrenOf(child(member, "parameters"))
    .filter((entry) => entry.type === "parameter")
    .map((entry) => textOf(child(entry, "type"), source))
    .join(",");
  // An explicit interface implementation declares the same name as the private method beside it
  // (`IDispatchExecutionLedger.TryBindDispatch` next to `TryBindDispatch`), so the specifier is part of the name.
  const specifier = childrenOf(member).find((entry) => entry.type === "explicit_interface_specifier");
  const prefix = specifier === undefined ? "" : `${textOf(specifier, source)}.`;
  switch (member.type) {
    case "method_declaration":
    case "constructor_declaration":
    case "destructor_declaration":
      return [{ name: `${prefix}${textOf(child(member, "name"), source)}`, signature, body }];
    case "operator_declaration":
    case "conversion_operator_declaration": {
      const keyword = childrenOf(member).find((entry) => ["implicit", "explicit"].includes(entry.type));
      return [{ name: `operator${keyword === undefined ? "" : ` ${keyword.type}`}`, signature, body }];
    }
    case "property_declaration":
    case "indexer_declaration": {
      const owner =
        member.type === "property_declaration" ? `${prefix}${textOf(child(member, "name"), source)}` : "this";
      return childrenOf(child(member, "accessors"))
        .filter((entry) => entry.type === "accessor_declaration")
        .map((accessor) => {
          const keyword = childrenOf(accessor).find((entry) => ACCESSOR_KEYWORDS.has(entry.type));
          return {
            name: `${owner}.${keyword === undefined ? "accessor" : keyword.type}`,
            signature: "",
            body: child(accessor, "body"),
          };
        });
    }
    default:
      return [];
  }
}

/**
 * Every measured member and type in one C# source.
 *
 * Types merge by fully qualified name, so a class split across 46 partials is one entry with `parts: 47` - the
 * reason this gate exists (`ExecutionManager` is declared 47 times across the 46 `farmhandexecutioncontroller*.cs`
 * files). A type also carries its own size: the line span of every declaration merged, and the number of member
 * declarations carrying a body. `drift` collects member kinds with a body this gate cannot name, which the caller
 * reports as a finding rather than passing over.
 */
export async function measureCSharp(relativePath, source) {
  const parser = await csharpParser();
  const tree = parser.parse(source);
  if (tree === null) throw new Error(`csharp_parse_failed:${relativePath}`);
  const members = [];
  const types = new Map();
  const drift = [];
  try {
    visit(tree.rootNode, "", []);
  } finally {
    tree.delete();
  }
  return { members, types: [...types.values()], drift };

  function visit(node, namespacePath, typePath) {
    for (const entry of childrenOf(node)) {
      if (entry.type === "namespace_declaration" || entry.type === "file_scoped_namespace_declaration") {
        const name = textOf(child(entry, "name"), source);
        visit(entry, namespacePath === "" ? name : `${namespacePath}.${name}`, typePath);
        continue;
      }
      if (TYPE_KINDS.has(entry.type)) {
        visitType(entry, namespacePath, typePath);
        continue;
      }
      visit(entry, namespacePath, typePath);
    }
  }

  function visitType(node, namespacePath, outerNames) {
    const name = textOf(child(node, "name"), source);
    if (name === "") return;
    const qualified = [namespacePath, ...outerNames, name].filter((part) => part !== "").join(".");
    const identity = `cs:${qualified}`;
    let type = types.get(identity);
    if (type === undefined) {
      type = {
        id: identity,
        name: qualified,
        parts: 0,
        files: new Set(),
        file: relativePath,
        line: node.startPosition.row + 1,
        value: 0,
        lines: 0,
        methods: 0,
      };
      types.set(identity, type);
    }
    type.parts += 1;
    type.files.add(relativePath);
    type.lines += node.endPosition.row - node.startPosition.row + 1;
    for (const member of childrenOf(child(node, "body"))) {
      if (TYPE_KINDS.has(member.type)) {
        visitType(member, namespacePath, [...outerNames, name]);
        continue;
      }
      if (CS_MEMBER_KINDS.has(member.type)) type.methods += 1;
      const units = memberUnits(member, source);
      if (units.length === 0) {
        const body = child(member, "body");
        if (body !== null && (body.type === "block" || body.type === "arrow_expression_clause")) {
          drift.push({ kind: member.type, file: relativePath, line: member.startPosition.row + 1 });
        }
        continue;
      }
      for (const unit of units) {
        const value = csComplexity(unit.body);
        type.value += value;
        members.push({
          id: `${identity}.${unit.name}(${unit.signature})`,
          language: "cs",
          name: `${qualified}.${unit.name}(${unit.signature})`,
          file: relativePath,
          line: (unit.body ?? member).startPosition.row + 1,
          value,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// TypeScript: Biome's own rule, its own bound, its own report
// ---------------------------------------------------------------------------------------------------------

/** The bound and level `biome.json` declares, or the reason this gate cannot read the owner's number. */
export function readTypeScriptBound(root) {
  const configPath = join(root, "biome.json");
  if (!existsSync(configPath)) return { error: "ts_biome_config_missing:biome.json" };
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const rule = config?.linter?.rules?.complexity?.noExcessiveCognitiveComplexity;
  const level = typeof rule === "string" ? rule : rule?.level;
  const bound = typeof rule === "object" && rule !== null ? rule.options?.maxAllowedComplexity : undefined;
  if (level === undefined || level === "off") return { error: `ts_rule_not_enabled:${TS_RULE}` };
  if (!Number.isInteger(bound) || bound < 1) return { error: "ts_bound_unreadable:maxAllowedComplexity" };
  return { bound, level };
}

const normalizePath = (value) => value.split(sep).join("/").replace(/^\.\//u, "");

/** Every shipped `host/src` module: the compiler's own population, not a list kept here. */
function typeScriptPopulation(root) {
  const sourceRoot = join(root, "host", "src");
  if (!existsSync(sourceRoot)) return [];
  return listSources(sourceRoot)
    .map((file) => sourcePath(join(root, "host"), file))
    .filter((file) => isProductionSource(file))
    .map((file) => `host/${file}`);
}

/** One Biome invocation's diagnostics. The verdict comes from what it printed, never from its exit code. */
function biomeDiagnostics(root, files) {
  const diagnostics = [];
  let filesRead = 0;
  for (let offset = 0; offset < files.length; offset += 40) {
    const chunk = files.slice(offset, offset + 40);
    const result = spawnSync(
      process.execPath,
      [BIOME_EXECUTABLE, "lint", `--only=${TS_RULE}`, "--reporter=json", ...chunk],
      { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    const printed = String(result.stdout ?? "");
    const start = printed.indexOf("{");
    if (start < 0) {
      return {
        error: `ts_producer_printed_no_report:${
          String(result.stderr ?? "")
            .trim()
            .split("\n")[0] ?? ""
        }`,
      };
    }
    let report;
    try {
      report = JSON.parse(printed.slice(start));
    } catch (error) {
      return { error: `ts_producer_report_unreadable:${error.message}` };
    }
    filesRead += Number(report.summary?.changed ?? 0) + Number(report.summary?.unchanged ?? 0);
    for (const diagnostic of report.diagnostics ?? []) {
      if (diagnostic.category === `lint/${TS_RULE}`) diagnostics.push(diagnostic);
    }
  }
  return { diagnostics, filesRead };
}

/** The innermost function-like node containing one offset, and the innermost class around it. */
function enclosing(node, index, kinds) {
  let found = null;
  const visit = (entry) => {
    if (entry.startIndex > index || entry.endIndex <= index) return;
    if (kinds.has(entry.type)) found = entry;
    for (const part of childrenOf(entry)) visit(part);
  };
  visit(node);
  return found;
}

/** A function's name: its own, else the variable or property it is assigned to. */
function functionName(node, source) {
  const named = child(node, "name");
  if (named !== null) return textOf(named, source);
  const parent = node.parent;
  if (parent === null) return null;
  if (parent.type === "variable_declarator") return textOf(child(parent, "name"), source);
  if (parent.type === "pair") return textOf(child(parent, "key"), source);
  if (parent.type === "assignment_expression") return textOf(child(parent, "left"), source);
  return null;
}

/** The nearest node at or above `start` this gate can name; `null` when the syntax names nothing above it. */
function namedOwner(start, source) {
  for (let current = start; current !== null; current = current.parent) {
    const name = functionName(current, source);
    if (name !== null && name !== "") return { node: current, name };
  }
  return null;
}

/**
 * One anonymous function's place among the anonymous functions inside `owner`, in source order (1-based).
 *
 * Counted inside the NAMED owner, so a comment, a statement or a named function inserted above it does not move
 * the number. Only inserting or deleting an anonymous function above it does - and that ambiguity is why the
 * ordinal is part of the identity rather than dropped: two lambdas in one owner must never merge into one row,
 * because a merged row hides the second offender.
 */
function anonymousOrdinal(owner, target, source) {
  let ordinal = 0;
  let found = false;
  const visit = (entry) => {
    if (found) return;
    if (entry === target) {
      ordinal += 1;
      found = true;
      return;
    }
    // A named function opens its own scope: its lambdas are counted under its own identity, not this owner's.
    if (TS_FUNCTION_KINDS.has(entry.type) && functionName(entry, source) !== null) return;
    if (TS_FUNCTION_KINDS.has(entry.type)) ordinal += 1;
    for (const part of childrenOf(entry)) visit(part);
  };
  for (const part of childrenOf(owner)) visit(part);
  return ordinal;
}

/**
 * The identity of one measured function: its name, or - for a lambda passed straight to a call, which nothing
 * names - its nearest named ancestor plus its ordinal: `CompanionLoop.#deliverAndObserve#lambda2`.
 *
 * WHY NOT THE LINE NUMBER. This baseline is a ratchet, so an identity that moves when code is inserted above turns
 * one unchanged function into a new offender plus a stale entry: a recorded `CompanionLoop.<anonymous@407> = 83`
 * was reported as an unrecorded `<anonymous@432> = 83` after 25 lines were inserted above it - same function, same
 * complexity, different position. The ordinal survives that insertion because it counts anonymous members, not
 * lines; the line still travels beside the identity as the reader's hint.
 */
function functionIdentity(node, source, rootNode) {
  const own = functionName(node, source);
  if (own !== null && own !== "") return own;
  const owner = namedOwner(node.parent, source) ?? { node: rootNode, name: "" };
  return `${owner.name}#lambda${anonymousOrdinal(owner.node, node, source)}`;
}

/** `Class.member`, unless the identity already carries the class - a lambda whose owner is the class itself. */
const qualify = (className, name) =>
  className === "" || name === className || name.startsWith(`${className}.`) ? name : `${className}.${name}`;

const countNewlines = (bytes, upTo) => {
  let count = 0;
  for (let index = 0; index < upTo; index += 1) if (bytes[index] === 0x0a) count += 1;
  return count;
};

/**
 * The measured TypeScript functions: every diagnostic Biome reported, named from its own source.
 *
 * Biome locates a function by BYTE span only, so the name comes from the surrounding syntax. Two functions may
 * legitimately share a name in one file (`game-tools.ts` has an `execute` per tool factory), so a repeated name
 * takes its source-order occurrence as a suffix: `#execute`, `#execute#2`. The suffix depends on order, not on the
 * line, so inserting code above does not turn a recorded member into a new offender. An anonymous one is named by
 * its nearest named ancestor plus its ordinal (`run#lambda1`), never by its line, for the same reason.
 *
 * A reading at Biome's ceiling carries `saturated: true`, because 255 is that producer's floor and not a count.
 */
async function typeScriptMembers(root, diagnostics) {
  const byFile = new Map();
  for (const diagnostic of diagnostics) {
    const file = normalizePath(diagnostic.location.path.file);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(diagnostic);
  }
  const members = [];
  for (const [file, entries] of byFile) {
    const source = readFileSync(join(root, file), "utf8");
    const bytes = Buffer.from(source, "utf8");
    const tree = await parseJavaScript(source, file);
    const located = [];
    try {
      for (const diagnostic of entries) {
        const value = Number(/Excessive complexity of (\d+) detected/u.exec(diagnostic.description)?.[1] ?? Number.NaN);
        if (!Number.isInteger(value)) return { error: `ts_complexity_unreadable:${file}` };
        const from = diagnostic.location.span[0];
        const line = countNewlines(bytes, from) + 1;
        const index = bytes.subarray(0, from).toString("utf8").length;
        const owner = enclosing(tree.rootNode, index, TS_FUNCTION_KINDS);
        const identity = functionIdentity(owner ?? tree.rootNode, source, tree.rootNode);
        const container = enclosing(tree.rootNode, index, TS_CLASS_KINDS);
        const className = container === null ? "" : textOf(child(container, "name"), source);
        located.push({
          qualified: qualify(className, identity),
          line,
          value,
          saturated: value >= BIOME_COMPLEXITY_SATURATION,
          position: from,
        });
      }
    } finally {
      tree.delete();
    }
    located.sort((left, right) => left.position - right.position);
    const seen = new Map();
    for (const entry of located) {
      const occurrence = (seen.get(entry.qualified) ?? 0) + 1;
      seen.set(entry.qualified, occurrence);
      const qualified = occurrence === 1 ? entry.qualified : `${entry.qualified}#${occurrence}`;
      members.push({
        id: `ts:${file}#${qualified}`,
        language: "ts",
        name: `${file}#${qualified}`,
        file,
        line: entry.line,
        value: entry.value,
        saturated: entry.saturated,
      });
    }
  }
  return { members };
}

// ---------------------------------------------------------------------------------------------------------
// The ratchet
// ---------------------------------------------------------------------------------------------------------

const BASELINE_NOTE =
  "Cognitive complexity and class size recorded from the commit named in `revision`: per member, per class and " +
  "per type size. Members are keyed by qualified signature (not file:line, so moving a method between the partials " +
  "of its class is not a new offender, and a lambda by its nearest named owner plus its ordinal, so inserting lines " +
  "above it is not one either); `file` and `line` are recorded for the reader. A ts member that reads at Biome's " +
  "ceiling carries `saturated: true`, because 255 is that producer's floor and not a count - it cannot be grown past " +
  "and it cannot be verified to have held still. An entry may carry a `reason` naming the commit that bought its " +
  "growth, and `--update` keeps it. Re-record with `node tools/check-cognitive-complexity.mjs --update` in its own " +
  "commit. The ts numbers come from Biome's complexity/noExcessiveCognitiveComplexity and the cs numbers from this " +
  "gate's own S3776 implementation over tree-sitter-c-sharp; the two are never compared or summed, so each carries " +
  "its own `producer`.";

const sortedById = (entries) => [...entries].sort((left, right) => left.id.localeCompare(right.id));

/**
 * The verdict, as data: findings plus the counters a reader needs to tell a measured tree from an empty one.
 *
 * `bounds` carries one bound per producer plus the class bound, because the two languages are not comparable; a
 * member is judged against the bound OF ITS LANGUAGE and nothing else.
 */
export function evaluate({ members, types, baseline, bounds }) {
  const findings = [];
  const measuredMembers = judgeMembers({
    members,
    recorded: new Map((baseline.members ?? []).map((entry) => [entry.id, entry])),
    bounds,
    findings,
  });
  const recordedTypes = new Map((baseline.classes ?? []).map((entry) => [entry.id, entry.value]));
  const measuredTypes = judgeTypes({
    types,
    recordedTypes,
    recordedSizes: new Map((baseline.sizes ?? []).map((entry) => [entry.id, entry])),
    revision: baseline.revision,
    findings,
  });
  for (const id of recordedTypes.keys()) {
    if (!measuredTypes.has(id)) findings.push({ code: "stale_complexity_baseline", detail: id });
  }
  for (const id of baseline.sizes ?? []) {
    if (!measuredTypes.has(id.id)) findings.push({ code: "stale_class_ceiling", detail: id.id });
  }
  for (const id of new Map((baseline.members ?? []).map((entry) => [entry.id, entry])).keys()) {
    if (!measuredMembers.has(id)) findings.push({ code: "stale_complexity_baseline", detail: id });
  }
  return { findings, counts: describe(members, types, bounds) };
}

/**
 * The member half: one bound per language, the ratchet on recorded values, and the identity collision.
 *
 * A recorded value is compared with a measured one through `formatComplexity`, so a ts function standing at
 * Biome's ceiling is named as a floor in both directions. What this comparison CAN see: entering the ceiling (a
 * recorded precise value grows to `>=255`), leaving it (a measured value below 255), and any unrecorded function
 * at the ceiling (`function_over_bound`). What it CANNOT see: movement inside the ceiling - a recorded 255 and a
 * measured 255 compare equal whether the function held or gained branches, so such an entry stays green. The
 * baseline stores `saturated: true` beside that value to say so out loud.
 */
function judgeMembers({ members, recorded, bounds, findings }) {
  const measured = new Set();
  for (const member of members) {
    if (measured.has(member.id)) {
      findings.push({ code: "complexity_identity_collision", detail: `${member.id} @ ${member.file}:${member.line}` });
      continue;
    }
    measured.add(member.id);
    const record = recorded.get(member.id);
    if (record === undefined && member.value > bounds[member.language]) {
      findings.push({
        code: "function_over_bound",
        language: member.language,
        detail:
          `${member.id} @ ${member.file}:${member.line} = ${formatComplexity(member)}` +
          ` (bound ${bounds[member.language]} ${member.language}${member.saturated === true ? ", saturated" : ""})`,
      });
    } else if (record !== undefined && member.value > record.value) {
      findings.push({
        code: "function_grew",
        language: member.language,
        detail: `${member.id} ${formatComplexity(record)} -> ${formatComplexity(member)}`,
      });
    }
  }
  return measured;
}

/** The type half: the summed complexity against its bound, and the summed size against both ceilings. */
function judgeTypes({ types, recordedTypes, recordedSizes, revision, findings }) {
  const measured = new Set();
  for (const type of types) {
    measured.add(type.id);
    judgeTypeComplexity(type, recordedTypes.get(type.id), findings);
    judgeTypeSize(type, recordedSizes.get(type.id), revision, findings);
  }
  return measured;
}

function judgeTypeComplexity(type, recorded, findings) {
  if (recorded === undefined && type.value > CLASS_BOUND) {
    findings.push({ code: "class_complexity_over_bound", detail: `${type.name}:${type.parts}:${type.value}` });
  } else if (recorded !== undefined && type.value > recorded) {
    findings.push({ code: "class_grew", detail: `${type.id} ${recorded} -> ${type.value}` });
  }
}

/**
 * One recorded size against the tree: is the RECORD stale, or did the CLASS grow? Two facts, two names.
 *
 * WHY THE SPLIT. Measured 2026-11-12: a commit that shrank `ModEntry` by 76 lines was reported as
 * `class_size_grew: cs:ModEntry 15356 lines/335 methods -> 15426 lines/335 methods`, while the commit's parent
 * measured 15,502 lines / 267 methods / 55 partials. The recorded 15,356 lines came from before 68 initialisers were
 * inlined and its 335 methods did not match that parent either: the record was taken at a tree that no longer existed,
 * and the gate called it growth. One name for two facts, so a correct commit was accused of the thing it had fixed.
 *
 * THE DISCRIMINATOR IS ALREADY IN THE RECORD, and costs no second measurement (re-parsing the tree at `HEAD~1` is
 * minutes on 564 C# files, per type, per run). A size record holds three coupled fields from ONE tree: `parts` (the
 * partial declarations merged), `methods` (the member declarations) and `lines` (the merged line span). `lines` moves
 * with any edit, so on its own it cannot say which tree the record describes; `parts` and `methods` only move when the
 * class's STRUCTURE moves - a partial added or removed, a member added or removed. So:
 *   - `parts` or `methods` disagree with the tree's own count  -> the record predates a structural change: stale.
 *     This holds in both directions. Recorded 335 methods against a tree of 267 is the incident above; recorded 267
 *     against a tree of 335 is the same untrustworthy record seen from the other side, and today it passes in
 *     silence whenever the recorded line count happens to be the larger one.
 *   - both agree and `lines` went up                            -> the class grew: `class_size_grew`, no excuse.
 * `parts` is the field that catches the incident: its methods (335) had already been corrected by the time its lines
 * were read, while its 56 partials had not (the tree has 58).
 *
 * WHAT THIS CANNOT SEE, stated rather than hidden: a stale record whose `parts` and `methods` happen to still match the
 * tree. `lines` is the only witness then, and a record 146 lines low with the same shape reads exactly like 146 lines
 * of growth. The recorded `revision` is printed in the finding so the reader can `git diff` from the commit the record
 * was taken at - which is the only cheap check left - and the arithmetic belongs in the re-recorded entry's `reason`.
 *
 * A STALE RECORD IS STILL A FINDING, not a pass: it says the number nobody can trust is being compared against, so the
 * run fails and the message asks for `--update` with the arithmetic rather than for a smaller class. Only the label
 * and the instruction change; the exit code does not.
 */
function judgeTypeSize(type, recorded, revision, findings) {
  if (recorded === undefined) {
    if (type.lines > CLASS_LINE_CEILING) {
      findings.push({
        code: "class_lines_over_ceiling",
        detail: `${type.name}:${type.lines}:${CLASS_LINE_CEILING}:${type.parts}`,
      });
    }
    if (type.methods > CLASS_METHOD_CEILING) {
      findings.push({
        code: "class_methods_over_ceiling",
        detail: `${type.name}:${type.methods}:${CLASS_METHOD_CEILING}`,
      });
    }
    return;
  }
  const drifted = [
    recorded.parts === type.parts ? null : `parts ${recorded.parts} -> ${type.parts}`,
    recorded.methods === type.methods ? null : `methods ${recorded.methods} -> ${type.methods}`,
  ].filter((field) => field !== null);
  if (drifted.length > 0) {
    findings.push({
      code: "class_size_record_stale",
      detail:
        `${type.id} ${drifted.join(", ")} (record taken at ${revisionOf(revision)}): the record's partials and ` +
        "methods no longer match this type, so it predates a structural change and is stale, not grown - re-record it " +
        "with --update and state the arithmetic in its reason; shrinking the class would not make this number true",
    });
  } else if (type.lines > recorded.lines) {
    findings.push({
      code: "class_size_grew",
      detail: `${type.id} ${recorded.lines} lines/${recorded.methods} methods -> ${type.lines} lines/${type.methods} methods`,
    });
  }
}

/** The revision a record was taken at, as the finding prints it; `--root` fixtures record none. */
const revisionOf = (revision) => (typeof revision === "string" && revision !== "" ? revision : "an unstated revision");

/** The population lines: what was examined, how many are over the bound, and the worst of each. */
function describe(members, types, bounds) {
  const counters = {};
  for (const language of ["ts", "cs"]) {
    const own = members.filter((member) => member.language === language);
    const over = own.filter((member) => member.value > bounds[language]);
    const worst = own.reduce((best, member) => (best === null || member.value > best.value ? member : best), null);
    // How many readings sit on the producer's floor: the population that makes `worst` a tie rather than a rank.
    const saturating = own.filter((member) => member.saturated === true).length;
    counters[language] = { examined: own.length, over: over.length, saturating, worst };
  }
  const overTypes = types.filter((type) => type.value > CLASS_BOUND);
  counters.classes = {
    examined: types.length,
    parts: types.reduce((total, type) => total + type.parts, 0),
    over: overTypes.length,
    worst: types.reduce((best, type) => (best === null || type.value > best.value ? type : best), null),
  };
  counters.sizes = {
    examined: types.length,
    parts: counters.classes.parts,
    over: types.filter((type) => type.lines > CLASS_LINE_CEILING || type.methods > CLASS_METHOD_CEILING).length,
    largest: types.reduce((best, type) => (best === null || type.lines > best.lines ? type : best), null),
  };
  return counters;
}

const describeWorst = (worst) =>
  worst === null ? "none" : `${worst.name} @ ${worst.file}:${worst.line} = ${formatComplexity(worst)}`;

/** The number field of a report row: a floor with its reason, or the exact value. */
const complexityFieldOf = (row) =>
  row.saturated === true ? { complexity: formatComplexity(row), saturated: true } : { value: row.value };

/**
 * A measured row without its file set, for the report line.
 *
 * A saturated row carries `complexity: ">=255 (biome saturates at 255)"` and `saturated: true` INSTEAD of a bare
 * `value`, so no json consumer can read the floor as a count. Every other row keeps its number.
 */
const summaryOf = (row) =>
  row === null || row === undefined
    ? null
    : {
        name: row.name,
        file: row.file,
        line: row.line,
        ...(row.value === undefined ? {} : complexityFieldOf(row)),
        ...(row.lines === undefined
          ? {}
          : { lines: row.lines, methods: row.methods, parts: row.parts, files: row.files.size }),
      };

function printReading(counts, bounds, tsFilesRead) {
  console.log(
    `ts: producer=biome complexity/noExcessiveCognitiveComplexity (maxAllowedComplexity ${bounds.ts} from biome.json, ${bounds.tsLevel}) biome ${BIOME_VERSION}`,
  );
  console.log(
    `    functions examined ${counts.ts.examined} · over the bound ${bounds.ts}: ${counts.ts.over}` +
      ` · saturating ${counts.ts.saturating} of ${counts.ts.examined} (${BIOME_SATURATION_READING})` +
      ` · worst ${describeWorst(counts.ts.worst)}` +
      ` · biome read ${tsFilesRead} file(s), and reports only the functions already over the bound`,
  );
  console.log(
    `cs: producer=S3776 over tree-sitter-c-sharp (this gate's implementation, not a Roslyn analyzer) @vscode/tree-sitter-wasm ${TS_GRAMMAR_VERSION}`,
  );
  console.log(
    `    functions examined ${counts.cs.examined} · over the bound ${bounds.cs}: ${counts.cs.over} · worst ${describeWorst(counts.cs.worst)}`,
  );
  const worstType = counts.classes.worst;
  console.log(
    `classes examined ${counts.classes.examined} · merged from partials ${counts.classes.parts} · over the class bound ${CLASS_BOUND}: ${counts.classes.over}` +
      (worstType === null
        ? ""
        : ` · worst ${worstType.name} @ ${worstType.file}:${worstType.line} parts ${worstType.parts} = ${worstType.value}`),
  );
  const largest = counts.sizes.largest;
  console.log(
    `types examined ${counts.sizes.examined} · partials stitched ${counts.sizes.parts} · over ceiling ${counts.sizes.over}` +
      (largest === null
        ? ""
        : ` · largest ${largest.name} @ ${largest.lines} lines / ${largest.methods} methods / ${largest.parts} parts`),
  );
  console.log("a ts number and a cs number measure different operator sets and are never summed or compared");
}

// ---------------------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------------------

const valueOf = (argv, name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};

/** Every `.cs` file under `integrations/stardew`, minus generated output. */
function listCSharpSources(root) {
  const sourceRoot = join(root, "integrations", "stardew");
  const files = [];
  if (!existsSync(sourceRoot)) return files;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "bin" || entry.name === "obj" || entry.name.startsWith(".")) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".cs")) {
        files.push(normalizePath(relative(root, full)));
      }
    }
  };
  walk(sourceRoot);
  return files.sort();
}

async function measure(root) {
  const typesBound = readTypeScriptBound(root);
  if (typesBound.error !== undefined) return { error: typesBound.error };
  const files = typeScriptPopulation(root);
  const biome = files.length === 0 ? { error: "ts_population_empty:host/src" } : biomeDiagnostics(root, files);
  if (biome.error !== undefined) return { error: biome.error };
  if (biome.filesRead === 0) return { error: "ts_producer_examined_no_file:host/src" };
  const tsMembers = await typeScriptMembers(root, biome.diagnostics);
  if (tsMembers.error !== undefined) return { error: tsMembers.error };

  const csharpFiles = listCSharpSources(root);
  if (csharpFiles.length === 0) return { error: "cs_population_empty:integrations/stardew" };
  const members = [...tsMembers.members];
  const types = new Map();
  const drift = [];
  for (const file of csharpFiles) {
    const measured = await measureCSharp(file, readFileSync(join(root, file), "utf8"));
    members.push(...measured.members);
    drift.push(...measured.drift);
    for (const type of measured.types) {
      const known = types.get(type.id);
      if (known === undefined) {
        types.set(type.id, type);
        continue;
      }
      known.value += type.value;
      known.parts += type.parts;
      known.lines += type.lines;
      known.methods += type.methods;
      for (const file of type.files) known.files.add(file);
    }
  }
  return {
    members,
    types: [...types.values()],
    drift,
    tsFilesRead: biome.filesRead,
    bounds: { ts: typesBound.bound, tsLevel: typesBound.level, cs: CS_FUNCTION_BOUND },
  };
}

function recordBaseline(root, measured) {
  const reasons = recordedReasons(root);
  const withReason = (kind) => (entry) =>
    reasons.has(`${kind}:${entry.id}`) ? { ...entry, reason: reasons.get(`${kind}:${entry.id}`) } : entry;
  const baseline = {
    note: BASELINE_NOTE,
    revision: readRevision(root),
    producers: {
      ts: `biome ${BIOME_VERSION} complexity/noExcessiveCognitiveComplexity (maxAllowedComplexity ${measured.bounds.ts} from biome.json)`,
      cs: `SonarSource S3776 over @vscode/tree-sitter-wasm ${TS_GRAMMAR_VERSION} tree-sitter-c-sharp.wasm, implemented by tools/check-cognitive-complexity.mjs`,
    },
    members: sortedById(
      measured.members
        .filter((member) => member.value > measured.bounds[member.language])
        .map(({ id, language, name, file, line, value, saturated }) => ({
          id,
          language,
          name,
          file,
          line,
          value,
          ...(saturated === true ? { saturated: true } : {}),
        }))
        .map(withReason("members")),
    ),
    classes: sortedById(
      measured.types
        .filter((type) => type.value > CLASS_BOUND)
        .map(({ id, name, parts, file, line, value }) => ({ id, name, parts, file, line, value }))
        .map(withReason("classes")),
    ),
    sizes: sortedById(
      measured.types
        .filter((type) => type.lines > CLASS_LINE_CEILING || type.methods > CLASS_METHOD_CEILING)
        .map(({ id, name, parts, files, file, line, lines, methods }) => ({
          id,
          name,
          parts,
          files: files.size,
          file,
          line,
          lines,
          methods,
        }))
        .map(withReason("sizes")),
    ),
  };
  mkdirSync(dirname(join(root, BASELINE_PATH)), { recursive: true });
  writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

/**
 * The `reason` each recorded entry already carries, keyed `<kind>:<id>` so a reason stays on the row it explains:
 * `cs:ExecutionManager` is both a class-complexity entry and a size entry, and growth in its LINES must not put a
 * line-shaped reason on the complexity row. A reason describes a commit that added statements to the entry, and the
 * entry's number is repeated in the text, so a later growth makes the stale reason visible to the reader instead of
 * silently travelling with it.
 */
function recordedReasons(root) {
  const path = join(root, BASELINE_PATH);
  if (!existsSync(path)) return new Map();
  const previous = JSON.parse(readFileSync(path, "utf8"));
  return new Map(
    ["members", "classes", "sizes"].flatMap((kind) =>
      (previous[kind] ?? [])
        .filter((entry) => typeof entry.reason === "string")
        .map((entry) => [`${kind}:${entry.id}`, entry.reason]),
    ),
  );
}

function readRevision(root) {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
  return String(result.stdout ?? "").trim() || "unknown";
}

function report(status, examined, checks, extra) {
  const line = {
    gate: "cognitive-complexity",
    status,
    examined,
    checks,
    ...extra,
  };
  console.log(JSON.stringify(line));
}

async function main(argv) {
  const root = resolve(valueOf(argv, "--root") ?? REPOSITORY_ROOT);
  const measured = await measure(root);
  if (measured.error !== undefined) {
    console.error(`complexity blocked: ${measured.error}`);
    report("blocked", 0, [{ id: "population", status: "blocked", detail: measured.error }], {});
    return 2;
  }
  printReading(describe(measured.members, measured.types, measured.bounds), measured.bounds, measured.tsFilesRead);
  if (measured.drift.length > 0) {
    for (const entry of measured.drift) {
      console.error(`complexity_unmeasured_member:${entry.kind} @ ${entry.file}:${entry.line}`);
    }
  }
  if (argv.includes("--update")) {
    const baseline = recordBaseline(root, measured);
    console.log(
      `complexity baseline recorded: members=${baseline.members.length} classes=${baseline.classes.length} sizes=${baseline.sizes.length} revision=${baseline.revision}`,
    );
    return measured.drift.length === 0 ? 0 : 1;
  }
  const baselinePath = join(root, BASELINE_PATH);
  const baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, "utf8"))
    : { members: [], classes: [], sizes: [] };
  const verdict = evaluate({
    members: measured.members,
    types: measured.types,
    baseline,
    bounds: { ts: measured.bounds.ts, cs: measured.bounds.cs },
  });
  const examined = measured.members.length + measured.types.length;
  const unrecorded = (code) => verdict.findings.filter((finding) => finding.code === code).length;
  const functionFindings = (language) =>
    verdict.findings.filter(
      (finding) =>
        (finding.code === "function_over_bound" || finding.code === "function_grew") && finding.language === language,
    ).length;
  const sizeFindings = verdict.findings.filter((finding) =>
    [
      "class_lines_over_ceiling",
      "class_methods_over_ceiling",
      "class_size_grew",
      "class_size_record_stale",
      "stale_class_ceiling",
    ].includes(finding.code),
  );
  const classFindings = verdict.findings.filter((finding) =>
    ["class_complexity_over_bound", "class_grew"].includes(finding.code),
  ).length;
  const checks = [
    {
      id: "ts_function_bound",
      status: functionFindings("ts") === 0 ? "passed" : "failed",
      detail: `${verdict.counts.ts.examined} reported by biome, ${verdict.counts.ts.over} over ${measured.bounds.ts}, saturating ${verdict.counts.ts.saturating} of ${verdict.counts.ts.examined} at ${BIOME_SATURATION_READING}, ${functionFindings("ts")} unrecorded or grown`,
    },
    {
      id: "cs_function_bound",
      status: functionFindings("cs") === 0 ? "passed" : "failed",
      detail: `${verdict.counts.cs.examined} examined, ${verdict.counts.cs.over} over ${CS_FUNCTION_BOUND}, ${functionFindings("cs")} unrecorded or grown`,
    },
    {
      id: "class_bound",
      status: classFindings === 0 ? "passed" : "failed",
      detail: `${verdict.counts.classes.examined} types, ${verdict.counts.classes.over} over ${CLASS_BOUND}, ${classFindings} unrecorded or grown`,
    },
    {
      id: "class_size_ceiling",
      status: sizeFindings.length === 0 ? "passed" : "failed",
      detail: `${verdict.counts.sizes.examined} types, ${verdict.counts.sizes.over} over ${CLASS_LINE_CEILING} lines / ${CLASS_METHOD_CEILING} methods, ${sizeFindings.length} unrecorded, grown or stale`,
    },
    {
      id: "baseline_ratchet",
      status: verdict.findings.length === 0 ? "passed" : "failed",
      detail: `${verdict.findings.length} finding(s), ${
        unrecorded("stale_complexity_baseline") +
        unrecorded("stale_class_ceiling") +
        unrecorded("class_size_record_stale")
      } stale`,
    },
  ];
  for (const finding of verdict.findings) console.error(`${finding.code}: ${finding.detail}`);
  for (const entry of measured.drift)
    console.error(`complexity_unmeasured_member:${entry.kind} @ ${entry.file}:${entry.line}`);
  const failed = verdict.findings.length > 0 || measured.drift.length > 0;
  if (failed) {
    console.error(
      "\ncomplexity failed: over-bound members and oversized classes must be recorded (or fixed), a recorded value " +
        "may only shrink, a gone member leaves the baseline, and a class-size record whose parts/methods disagree with " +
        "the tree is stale - re-record it with the arithmetic rather than shrinking the class",
    );
  } else {
    const debt = `recorded: members=${(baseline.members ?? []).length} classes=${(baseline.classes ?? []).length} sizes=${(baseline.sizes ?? []).length}`;
    console.log(`\ncomplexity passed: ${debt}`);
  }
  report(failed ? "failed" : "passed", examined, checks, {
    producers: {
      ts: `biome ${BIOME_VERSION} complexity/noExcessiveCognitiveComplexity (maxAllowedComplexity ${measured.bounds.ts})`,
      cs: `S3776 over @vscode/tree-sitter-wasm ${TS_GRAMMAR_VERSION} tree-sitter-c-sharp.wasm (this gate's implementation)`,
    },
    worst: {
      ts: summaryOf(verdict.counts.ts.worst),
      cs: summaryOf(verdict.counts.cs.worst),
      class: summaryOf(verdict.counts.classes.worst),
      largest: summaryOf(verdict.counts.sizes.largest),
    },
    findings: verdict.findings,
  });
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
