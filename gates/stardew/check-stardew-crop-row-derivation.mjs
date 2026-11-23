// Gate: stardew_crop_row_derivation/v1
//
// The question this gate protects: when a snapshot row says "here is a crop tile", does it carry the facts a reader
// needs to DECIDE about that tile, or only the ones a filter happened to read?
//
// Measured 2026-11-09: across a day of runs the companion called `look_up({subject:"data", table:"Crops"})` zero times,
// while `ContentDataQuery.CropRow` already published `isRaised`, `daysToHarvest`, `regrowDays`, `seasons` and
// `harvestMethod`. A trellis crop is planted on a tile that stops being walkable, and nothing in the companion's
// working set said so. The fact was available (an askable table) and unused (never asked), so the fix is not "ask
// more" - it is that the row itself must carry it.
//
// POPULATION (read from source on every run, never listed here):
//   - WORKER: the field names `ContentDataQuery.CropRow` projects (`integrations/stardew/ContentDataQuery.cs`), the
//     engine's own `Data/Crops` answer.
//   - SNAPSHOT: the field names the Mod publishes on a crop row (`BridgeCropTarget` in
//     `integrations/stardew/src/Core/Models/BridgeProtocolModels.cs`), normalised to wire camelCase.
//   - DECLARATION: the TYPE that declares `DiscoverCropTargets`, found by reading that member's own declaration across
//     every `.cs` file under `integrations/stardew` - never by naming a file. Measured twice: the gate first read
//     `farmhandexecutioncontroller.cs`, then the `farmhandexecutioncontroller.*.cs` partials, and each time the
//     discovery functions were extracted into a type of their own the gate reported a CORRECT move as
//     `crop_row_discovery_not_declared`. A filename is not an owner.
//   `examined N worker fields, M snapshot fields, K shared` and `discovery declared in <type> (<n> functions examined)`
//   are printed, and a zero population is `blocked` - a gate whose population is empty agrees with itself.
//
// ASSERTIONS
//   1. reachable: every worker field is either published by a snapshot crop row, or carries a stated reason here
//      (`REACHABILITY_EXEMPTIONS`), in a closed class - `bounded_answer_size` (the row has a budget) or
//      `lookup_only` (the fact answers a question about the crop, not about this tile). The table is checked in both
//      directions: an exemption for a field that has since become reachable is red, and so is one for a field the
//      engine no longer publishes.
//   2. wire parity, both directions: the row key set the Mod publishes, the Host's row type (`host/src/protocol.ts`),
//      the Host's row validator (`isCropTargetFact` in `host/src/protocol-target-facts.ts`) and the language-neutral
//      schema (`protocol/bridge-v1.schema.json` `$defs.cropTarget`) are four copies of one contract. A Mod frame the
//      Host refuses is the failure shape four live runs died at hello with, so a field on one side and not another is
//      a finding here rather than a refused snapshot there.
//   3. the passability fact is the pathfinder's: `tileBlockedNow` must be answered by
//      `GameLocation.isCollidingPosition(...)` - the call `PathFindController.cs:222` itself makes - and NOT by
//      `GameLocation.isTilePassable` (GameLocation.cs:2898), which reads only the map's Back and Buildings layers and
//      reports a trellis crop as open ground. The two disagree on exactly the tile this field exists for, so the
//      source that builds the field is read rather than trusted - and it is read from the type that OWNS the helper
//      the row calls, resolved by declaration like assertion 4's type, not from a file this gate names.
//   4. derived: every key of the row record is set, by name, at the ONE `new BridgeCropTarget(...)` inside the type
//      that declares the discovery. A key the record declares and the discovery never derives is a key the row cannot
//      have measured; it is named rather than averaged away. The construction is looked for in the whole type, not in
//      one function, so extracting it into a helper does not read as a missing derivation.
//
// red-proof: inject  deleting `bool? IsRaised` from a copy of `BridgeProtocolModels.cs`, so the crop row stops
//   publishing a field `ContentDataQuery.CropRow` still projects -> `not_reachable:isRaised` and three
//   `wire_extra:isRaised`, `blocked`, exit 1 (gates/stardew/check-stardew-crop-row-derivation.test.mjs)
// red-proof: inject  deleting `IsRaised: data?.IsRaised,` from the construction inside `DiscoverCropTargets`, so the
//   row keeps a key nothing derives -> `field_not_derived:isRaised`, `blocked`, exit 1, and the same fixture with the
//   discovery moved into another type stays green (gates/stardew/check-stardew-crop-row-derivation.test.mjs)
// red-proof: inject  moving the whole `DiscoverCropTargets` body into another type's partial -> verdict stays `passed`,
//   and the population line names the new owner (`discovery declared in ExecutionManager (...)`) instead of
//   `crop_row_discovery_not_declared` (gates/stardew/check-stardew-crop-row-derivation.test.mjs)

export const gateDeclaration = {
  id: "check-stardew-crop-row-derivation",
  domain: "stardew",
  tier: "l0",
  kind: "contract",
};

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { extractCSharpRecordFields } from "./check-stardew-execution-receipt-field-parity.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gate = "stardew_crop_row_derivation/v1";

const BRIDGE_MODELS_PATH = "integrations/stardew/src/Core/Models/BridgeProtocolModels.cs";
const ACTION_DEFINITIONS_PATH = "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs";
const CONTENT_DATA_PATH = "integrations/stardew/ContentDataQuery.cs";
const PROTOCOL_PATH = "host/src/protocol.ts";
const VALIDATOR_PATH = "host/src/protocol-target-facts.ts";
/**
 * The Host build a live run actually loads.
 *
 * A parity check that reads only the SOURCE answers a question nobody runs: measured 2026-11-09, this gate was green on
 * source while the deployed `dist-test` was 8 minutes older, and the next run died 58s in with
 * `invalid_snapshot:cropTargets`. The same shape as round38's `artifact_content_mismatch` - a gate measuring the wrong
 * copy of the contract.
 */
const DEPLOYED_VALIDATOR_PATH = "host/dist-test/protocol-target-facts.js";
const SCHEMA_PATH = "protocol/bridge-v1.schema.json";

/** The row record (`BridgeCropTarget`) and the data answer (`CropRow`) this gate joins. */
const ROW_RECORD = "BridgeCropTarget";
const ROW_DISCOVERY_FUNCTION = "DiscoverCropTargets";

/**
 * Where the Mod's own types live, and which directories under it are not the Mod's types.
 *
 * The population is the DIRECTORY: a type that moves to a new file must not need this gate edited to keep seeing it.
 */
const MOD_SOURCE_ROOT = "integrations/stardew";
const NOT_MOD_TYPE_DIRECTORIES = new Set(["tests", "obj", "bin", "node_modules"]);

/** A member DECLARATION: an access modifier opening the line, then the signature. A call site cannot imitate it. */
const memberDeclaration = (member) =>
  new RegExp(`^[ \\t]*(?:internal|public|private|protected)\\b[^\\n;={]*\\b${member}[ \\t]*\\(`, "mu");

/** Any member declaration, with the name captured - the type's own vocabulary, counted rather than assumed. */
const DECLARED_MEMBER = /^[ \t]*(?:internal|public|private|protected)\b[^\n;={]*?\b([A-Za-z_]\w*)[ \t]*\(/gmu;

/**
 * Worker fields the crop row deliberately does not repeat, each with the reason and the class.
 *
 * The classes are closed so the count is a measurement: a reason that is neither "the row has a budget" nor "this is a
 * question about the crop, not about this tile" is a finding, not an exemption.
 */
export const REACHABILITY_EXEMPTIONS = Object.freeze({
  daysInPhase: {
    kind: "bounded_answer_size",
    reason:
      "a per-phase day list (up to five numbers) on every crop row multiplies a 64-row family by five; the row " +
      "carries what a planting decision reads from it - `daysToHarvest`, the same sum `CropRow` publishes - and the " +
      "phase shape stays a `look_up` answer",
  },
  harvestItemId: {
    kind: "lookup_only",
    reason:
      "what a crop yields is a question about the crop, and `harvestTargets` already publishes " +
      "`qualifiedHarvestItemId` for this same tile once it is ready to pick; repeating an item id on every watering " +
      "row buys nothing a reader of the row decides from",
  },
  harvestMinStack: {
    kind: "bounded_answer_size",
    reason:
      "how much one pick yields is four more numbers per row (`harvestMinStack`, `harvestMaxStack`, " +
      "`harvestMinQuality`, `harvestMaxQuality`) and none of them changes where to plant or whether to water; it is a " +
      "`look_up` answer for a crop, not a fact about this tile",
  },
  harvestMaxStack: { kind: "bounded_answer_size", reason: "the same family as `harvestMinStack`; see there" },
  harvestMinQuality: { kind: "bounded_answer_size", reason: "the same family as `harvestMinStack`; see there" },
  harvestMaxQuality: { kind: "bounded_answer_size", reason: "the same family as `harvestMinStack`; see there" },
  needsWatering: {
    kind: "lookup_only",
    reason:
      "constant on this family: `DiscoverCropTargets` admits a row only when the crop needs water and its tile is not " +
      "already watered, so the field would read `true` on every row it appears on. The filter that admits the row is " +
      "the register `discoveryExclusions` already names",
  },
  isPaddyCrop: {
    kind: "lookup_only",
    reason:
      "whether a crop must be flooded is a property of where it may be PLANTED, and the engine answers it when a seed " +
      "is aimed (`HoeDirt.canPlantThisSeedHere`); these rows are tiles that already carry the crop, so the fact " +
      "cannot change what the row is for. It stays askable as a `data` answer",
  },
});

/**
 * The actions whose data-table-dependent correctness has NO snapshot fact, named rather than left as silence.
 *
 * A gap is only honest with its reason and its exit: what a live run would have to show for the gap to close.
 */
export const NOT_COVERED = Object.freeze({
  plant_seed: {
    family: "seedTargets",
    reason:
      "`seedTargets` publishes the held seed and the engine's planting admission (`canPlantThisSeedHere`), and nothing " +
      "about the crop that seed becomes - so whether a planting step turns its column impassable is not in any snapshot. " +
      "It closes the day `seedTargets` rows carry the same `isRaised`/`daysToHarvest` facts `cropTargets` rows now do; a " +
      "live run would have to plant a trellis seed and show the plan's answer naming the fact WITHOUT a `look_up` call",
  },
  fertilize_tile: {
    family: "fertilizerTargets",
    reason:
      "`fertilizerTargets` publishes the held fertilizer and `HoeDirt.CanApplyFertilizer`. It decides placement of an " +
      "ITEM, not the passability of the tile, so the layout facts are not its subject; a live run would have to show a " +
      "fertilized trellis column still refusing a walk",
  },
});

/** Where the assembly-path proof lives: the test that drives the REAL producer and the REAL projection, by file. */
export const ASSEMBLY_PATH_PROOFS = Object.freeze([
  {
    file: "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/CropRowFactsTests.cs",
    fact: "IsRaised",
    what: "the Mod's own `DiscoverCropTargets` over a fixture world, including the trellis tile the map-only test calls open",
  },
  {
    file: "host/src/crop-row-facts.test.ts",
    fact: "tileBlockedNow",
    what: "a Mod-shaped frame through the Host's diagnostic and `boundObservedSnapshot` - the payload `stardew_observe` hands the model",
  },
]);

// ---------------------------------------------------------------------------
// Source reading: the two populations
// ---------------------------------------------------------------------------

/** Blank TypeScript comments out, preserving every offset and newline. */
function blankCommentText(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "))
    .replace(/\/\/[^\n]*/gu, (comment) => " ".repeat(comment.length));
}

/** The `{...}` body that opens at the first `openAfter` following `anchor`, by offset, or null. */
function bracedBody(source, anchor, openAfter) {
  const at = source.indexOf(anchor);
  if (at < 0) return null;
  const open = source.indexOf(openAfter, at + anchor.length);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return { body: source.slice(open, index + 1), start: open };
    }
  }
  return null;
}

/**
 * The field names `ContentDataQuery.CropRow` projects: the `("name", value)` pairs inside its `Fields(...)` call.
 * Read from the file, so the day someone adds a column to the engine's crop answer, this population names it.
 */
export function extractWorkerCropRowFields(source) {
  const functionAt = source.indexOf("BridgeDataQueryRow CropRow(");
  if (functionAt < 0) throw new Error("worker_crop_row_missing: BridgeDataQueryRow CropRow(...) not found");
  const fieldsAt = source.indexOf("Fields(", functionAt);
  if (fieldsAt < 0) throw new Error("worker_crop_row_fields_missing: CropRow has no Fields(...) call");
  const open = source.indexOf("(", fieldsAt);
  let depth = 0;
  let end = -1;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) throw new Error("worker_crop_row_fields_unbalanced: CropRow Fields(...) is unterminated");
  const body = source.slice(open + 1, end);
  const names = [];
  for (const match of body.matchAll(/\(\s*"([A-Za-z0-9_]+)"\s*,/gu)) names.push(match[1]);
  return Object.freeze(names);
}

// ---------------------------------------------------------------------------
// Source reading: which type declares what
// ---------------------------------------------------------------------------

/** The index of the delimiter closing the one at `open`, or -1. */
function matchingDelimiter(source, open, openCharacter, closeCharacter) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === openCharacter) depth += 1;
    else if (source[index] === closeCharacter) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Every `.cs` file under the Mod tree, as repository-relative paths with `/` separators. */
function modSourcePaths(root) {
  const found = [];
  const walk = (relativeDirectory) => {
    let entries;
    try {
      entries = readdirSync(path.join(root, relativeDirectory), { withFileTypes: true });
    } catch {
      throw new Error(`crop_row_source_tree_unreadable: ${relativeDirectory} could not be listed`);
    }
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!NOT_MOD_TYPE_DIRECTORIES.has(entry.name)) walk(relativePath);
      } else if (entry.name.endsWith(".cs")) {
        found.push(relativePath);
      }
    }
  };
  walk(MOD_SOURCE_ROOT);
  return found.sort();
}

/** The type declarations in `source`, as matches whose first group is the type's name. */
function typeDeclarations(source) {
  return source.matchAll(
    /^[ \t]*(?:(?:internal|public|private|protected|static|sealed|abstract|partial|readonly|unsafe|file|new)[ \t]+)*(?:class|interface|struct|record(?:[ \t]+(?:class|struct))?)[ \t]+([A-Za-z_]\w*)/gmu,
  );
}

/** Whether `source` declares the type `type`. */
function declaresType(source, type) {
  for (const declaration of typeDeclarations(source)) if (declaration[1] === type) return true;
  return false;
}

/** The INNERMOST type whose body contains `at`, or null. An outer class is not the owner of a nested one's members. */
function enclosingTypeName(source, at) {
  let name = null;
  for (const declaration of typeDeclarations(source)) {
    if (declaration.index > at) break;
    const open = source.indexOf("{", declaration.index);
    if (open < 0 || open > at) continue;
    const close = matchingDelimiter(source, open, "{", "}");
    // The type must still be OPEN at the member: a declaration whose body ended earlier is a sibling, not the owner.
    if (close < at) continue;
    name = declaration[1];
  }
  return name;
}

/**
 * The TYPE that declares `member`, the file its declaration is in, and every file declaring that type.
 *
 * A filename is not an owner, and this gate has twice reported a correct extraction as a missing declaration: it read
 * `farmhandexecutioncontroller.cs`, then the `farmhandexecutioncontroller.*.cs` partials, and the discovery functions
 * moved out of both. So the file is asked for by the member's own DECLARATION - an access modifier opening a line, then
 * the signature, which a call site cannot imitate - and the type is read from that declaration. A member declared
 * nowhere, or in two files, blocks by name rather than by silence.
 */
export function resolveMemberType(root, member, read) {
  const sources = modSourcePaths(root).map((file) => ({ file, source: read(file) }));
  const declarations = [];
  for (const { file, source } of sources) {
    const declaration = memberDeclaration(member).exec(source);
    if (declaration === null) continue;
    const type = enclosingTypeName(source, declaration.index);
    if (type === null)
      throw new Error(`crop_row_member_type_unknown: ${member} in ${file} is declared outside any type`);
    declarations.push({ file, type, at: declaration.index });
  }
  if (declarations.length === 0)
    throw new Error(`crop_row_member_not_declared: no type in ${MOD_SOURCE_ROOT} declares ${member}`);
  if (declarations.length > 1)
    throw new Error(
      `crop_row_member_ambiguous: ${member} is declared in ${declarations
        .map((entry) => entry.file)
        .sort()
        .join(", ")}`,
    );
  const [{ file, type, at }] = declarations;
  const typeFiles = sources.filter(({ source }) => declaresType(source, type));
  return Object.freeze({
    type,
    file,
    at,
    files: Object.freeze(typeFiles.map(({ file: typeFile }) => typeFile)),
    sources: Object.freeze(typeFiles),
  });
}

/** The `Discover*` member names a type's files declare, so its vocabulary is printed rather than assumed. */
function declaredDiscoveries(typeFiles) {
  const names = new Set();
  for (const { source } of typeFiles)
    for (const declaration of source.matchAll(DECLARED_MEMBER))
      if (/^Discover[A-Z]/u.test(declaration[1])) names.add(declaration[1]);
  return Object.freeze([...names].sort());
}

/** The body of the `DiscoverCropTargets` declaration found at `at`, by brace matching. */
export function extractRowDiscoveryBody(source, at) {
  const open = source.indexOf("{", at);
  if (open < 0) throw new Error(`row_discovery_unterminated: ${ROW_DISCOVERY_FUNCTION} has no body`);
  const close = matchingDelimiter(source, open, "{", "}");
  if (close < 0) throw new Error(`row_discovery_unterminated: ${ROW_DISCOVERY_FUNCTION} body is unterminated`);
  return source.slice(open, close + 1);
}

/** The labelled arguments (`Property: value`) of the call opening at `open`, as property names. */
function labelledArguments(source, open) {
  const close = matchingDelimiter(source, open, "(", ")");
  if (close < 0) return [];
  const body = source.slice(open, close + 1);
  return [...body.matchAll(/(?:^|[\s({,])([A-Za-z_]\w*):(?!:)/gu)].map((match) => match[1]);
}

/** The body of the method named `name` in one source: expression-bodied (`=> ...;`) or block-bodied. */
export function methodBody(source, name) {
  const needle = `${name}(`;
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
    const open = at + needle.length - 1;
    let depth = 0;
    let close = -1;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === "(") depth += 1;
      else if (source[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    if (close < 0) return null;
    let cursor = close + 1;
    while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1;
    if (source.startsWith("=>", cursor)) {
      let bodyDepth = 0;
      for (let index = cursor + 2; index < source.length; index += 1) {
        const char = source[index];
        if ("([{".includes(char)) bodyDepth += 1;
        else if (")]}".includes(char)) bodyDepth -= 1;
        else if (char === ";" && bodyDepth === 0) return source.slice(cursor, index + 1);
      }
      return null;
    }
    if (source[cursor] === "{") {
      let bodyDepth = 0;
      for (let index = cursor; index < source.length; index += 1) {
        if (source[index] === "{") bodyDepth += 1;
        else if (source[index] === "}") {
          bodyDepth -= 1;
          if (bodyDepth === 0) return source.slice(cursor, index + 1);
        }
      }
      return null;
    }
  }
  return null;
}

/**
 * The source that ANSWERS the row's `TileBlockedNow`, and the name it was answered by.
 *
 * The row publishes a named helper rather than an inline expression, for the same reason every other row does, and it
 * calls it through its owner (`ExecutionManager.IsTileBlockedForFarmer`), so reading only the discovery body would
 * report the call site as the answer and check an expression that is not the answer. `resolve` is asked for the owning
 * type's file, by declaration; a name that resolves nowhere is reported as unresolved rather than passing as inline.
 */
export function passabilityAnswer(discoveryBody, resolve) {
  const argument = /TileBlockedNow:[ \t]*(?:[A-Za-z_]\w*[ \t]*\.[ \t]*)*([A-Za-z_]\w*)[ \t]*\(/u.exec(discoveryBody);
  if (argument === null) return { snippet: discoveryBody, via: "<inline>", owner: null, unresolved: null };
  const name = argument[1];
  const owner = resolve(name);
  if (owner === null) return { snippet: discoveryBody, via: name, owner: null, unresolved: name };
  const body = methodBody(owner.source, name);
  return {
    snippet: body === null ? discoveryBody : body,
    via: `${owner.type}.${name}`,
    owner,
    unresolved: null,
  };
}

// ---------------------------------------------------------------------------
// Source reading: the three Host sides
// ---------------------------------------------------------------------------

/** The declared keys of the `cropTargets` row type in `host/src/protocol.ts`. */
export function extractProtocolRowFields(source) {
  // Comments are blanked first: the row's doc comments quote key names and token values (`cropFactsUnknown:
  // "crop_data_missing"`), and a reader that matched inside them reported two invented fields.
  const block = bracedBody(blankCommentText(source), "cropTargets?:", "{");
  if (block === null) throw new Error("protocol_row_missing: `cropTargets?: readonly Readonly<{` not found");
  return Object.freeze(
    [...block.body.matchAll(/(?:^|[{;,\s])([A-Za-z_$][\w$]*)\s*\??\s*:/gu)].map((match) => match[1]),
  );
}

/** The key list `isCropTargetFact` admits (`hasOnlyKeys(value, [...])`). */
export function extractValidatorRowFields(source) {
  const at = source.indexOf("export function isCropTargetFact(");
  if (at < 0) throw new Error("validator_row_missing: isCropTargetFact not found");
  const keysAt = source.indexOf("hasOnlyKeys(value, [", at);
  if (keysAt < 0) throw new Error("validator_row_keys_missing: isCropTargetFact has no hasOnlyKeys(value, [...])");
  const open = source.indexOf("[", keysAt);
  const close = source.indexOf("]", open);
  if (open < 0 || close < 0)
    throw new Error("validator_row_keys_unbalanced: isCropTargetFact key list is unterminated");
  return Object.freeze([...source.slice(open, close).matchAll(/"([A-Za-z0-9_]+)"/gu)].map((match) => match[1]));
}

/** The declared property names of the language-neutral schema's `$defs.cropTarget`. */
export function extractSchemaRowFields(source) {
  const document = JSON.parse(source);
  const definition = document?.$defs?.cropTarget;
  if (definition === undefined || typeof definition !== "object")
    throw new Error("schema_row_missing: $defs.cropTarget");
  return Object.freeze(Object.keys(definition.properties ?? {}));
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

/**
 * Every nullable member of a `Bridge*` wire record must carry `WhenWritingNull`.
 *
 * A nullable C# member serialises as `"key": null` by default, and the Host validators treat a null as a wrong type -
 * so the frame is refused, the bridge closes, and the run dies on a shape the compiler could not see. Population: the
 * `Bridge*` records in the one models file, which is where every wire record lives.
 */
export function nullableWireKeysWithoutOmission(source) {
  const findings = [];
  const text = blankCommentText(source);
  const recordPattern = /public sealed record (Bridge\w+)\(([\s\S]*?)\);/gu;
  for (const match of text.matchAll(recordPattern)) {
    const [, record, body] = match;
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.includes("WhenWritingNull")) continue;
      // `int? X`, `string? Y = null`, `IReadOnlyList<T>? Z (with a = default)`
      if (!/\b\w+(?:<[^>]*>)?\?\s+\w+/u.test(trimmed)) continue;
      const name = /\b\w+(?:<[^>]*>)?\?\s+(\w+)/u.exec(trimmed)?.[1];
      if (name === undefined) continue;
      findings.push({
        code: "nullable_wire_key_without_omission",
        member: `${record}.${name}`,
        detail:
          "a nullable member serialises as `key: null`, and the Host reads a null as the wrong type and refuses the whole frame; add [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] or make the member non-nullable",
      });
    }
  }
  return findings;
}

function defaultRead(root, relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

/**
 * The declaration of `member` in the Mod's own types, and the type that owns it.
 *
 * A declaration that cannot be found is a finding, not an exception: the gate's whole subject is that the row's facts
 * are DERIVED somewhere, so "the function this gate read the derivation out of is gone" has to fail the run by name.
 */
function resolveOrPush(root, member, read, push) {
  try {
    return resolveMemberType(root, member, read);
  } catch (error) {
    push(
      "declaration_unresolved",
      member,
      `${error?.message ?? "unknown"}; this gate reads the ownership of ${member} from its declaration, so a move it cannot see is a reading it cannot make`,
    );
    return null;
  }
}

const sorted = (values) => [...values].sort();

/**
 * @param {{ root?: string, overrides?: Record<string, string>, exemptions?: object }} options
 */
export function checkStardewCropRowDerivation({
  root = repositoryRoot,
  overrides = {},
  exemptions = REACHABILITY_EXEMPTIONS,
} = {}) {
  const read = (relativePath) => overrides[relativePath] ?? defaultRead(root, relativePath);
  const findings = [];
  const push = (code, member, detail) => findings.push({ code, member, detail });

  const workerFields = extractWorkerCropRowFields(read(CONTENT_DATA_PATH));
  const snapshotFields = [...extractCSharpRecordFields(read(BRIDGE_MODELS_PATH), ROW_RECORD).wire];
  const protocolFields = extractProtocolRowFields(read(PROTOCOL_PATH));
  const validatorFields = extractValidatorRowFields(read(VALIDATOR_PATH));
  const schemaFields = extractSchemaRowFields(read(SCHEMA_PATH));

  const discovery = resolveOrPush(root, ROW_DISCOVERY_FUNCTION, read, push);
  const discoveryBody = discovery === null ? null : extractRowDiscoveryBody(read(discovery.file), discovery.at);
  const discoveryFunctions = discovery === null ? Object.freeze([]) : declaredDiscoveries(discovery.sources);

  // 0. A NULLABLE wire key must be OMITTED when null, never sent as `null`.
  //
  // Measured 2026-11-09: the crop row gained `int? DaysToHarvest` and friends with no `WhenWritingNull`, so a real farm
  // sent `"daysToHarvest": null` and the Host's validator refused the whole frame after 162 seconds
  // (`invalid_snapshot:cropTargets`). The parity check below compares key NAMES and cannot see a value shape, which is
  // why this is a separate assertion over the same file.
  //
  // Population: the fact rows this gate already owns (the ones the Host validates key by key). The other `Bridge*`
  // records are ADVISORY: their Host readers tolerate null today, and a blanket rule over them would turn this into a
  // 30-entry exception list, which is the shape this project refuses. They are outside this rule's population and the
  // gate does not measure them.
  const nullableFindings = nullableWireKeysWithoutOmission(read(BRIDGE_MODELS_PATH));
  for (const finding of nullableFindings) if (finding.member.startsWith(`${ROW_RECORD}.`)) findings.push(finding);

  if (workerFields.length === 0)
    push(
      "worker_population_empty",
      "<CropRow>",
      "ContentDataQuery.CropRow projects no named field; nothing was measured",
    );
  if (snapshotFields.length === 0)
    push("snapshot_population_empty", ROW_RECORD, "the Mod's crop row publishes no named field; nothing was measured");
  if (protocolFields.length === 0 || schemaFields.length === 0 || validatorFields.length === 0)
    push("host_population_empty", "cropTarget", "the Host side of the crop row names no key; nothing was measured");

  // 1. Reachability: every worker field is on the row, or carries a stated reason.
  const snapshotSet = new Set(snapshotFields);
  const workerSet = new Set(workerFields);
  const shared = workerFields.filter((field) => snapshotSet.has(field));
  for (const field of workerFields) {
    if (snapshotSet.has(field)) continue;
    const exemption = exemptions[field];
    if (exemption === undefined) {
      push(
        "not_reachable",
        field,
        "published by ContentDataQuery.CropRow, absent from the Mod's crop row, and no stated reason here says why",
      );
      continue;
    }
    if (!["bounded_answer_size", "lookup_only"].includes(exemption.kind))
      push("exemption_unreasoned", field, `unknown exemption class "${exemption.kind}"`);
    else if (typeof exemption.reason !== "string" || exemption.reason.length < 40)
      push("exemption_unreasoned", field, "the reason is too short to name anything");
  }
  for (const field of Object.keys(exemptions)) {
    if (!workerSet.has(field))
      push("exemption_stale", field, `${CONTENT_DATA_PATH} no longer publishes this field; delete the exemption`);
    else if (snapshotSet.has(field))
      push("exemption_stale", field, "the crop row now publishes this field; delete the exemption");
  }

  // 2b. The DEPLOYED validator, not only its source. A live run loads `dist-test`; a green source check beside a stale
  // build is the exact shape that killed a run at 58 seconds (`invalid_snapshot:cropTargets`).
  let deployedFields = null;
  try {
    deployedFields = extractValidatorRowFields(read(DEPLOYED_VALIDATOR_PATH));
  } catch (error) {
    push(
      "deployed_host_absent",
      DEPLOYED_VALIDATOR_PATH,
      `the Host build a live run loads could not be read (${error?.message ?? "unknown"}); the wire check above measured source only`,
    );
  }
  if (deployedFields !== null) {
    const deployed = new Set(deployedFields);
    for (const field of new Set([...validatorFields, ...deployedFields])) {
      if (deployed.has(field) && !validatorFields.includes(field))
        push(
          "deployed_host_stale",
          field,
          "the deployed build names a key the source validator does not; rebuild Host",
        );
      if (!deployed.has(field) && validatorFields.includes(field))
        push(
          "deployed_host_stale",
          field,
          "the deployed build is missing a key the source validator names; rebuild Host",
        );
    }
  }

  // 2. Wire parity, both directions: four copies of one contract.
  const checkSameSet = (layerFields, layerName) => {
    const layer = new Set(layerFields);
    for (const field of snapshotFields)
      if (!layer.has(field)) push("wire_missing", field, `${layerName} does not name a field the Mod publishes`);
    for (const field of layer)
      if (!snapshotSet.has(field))
        push("wire_extra", field, `${layerName} names a field the Mod's row does not publish`);
  };
  checkSameSet(protocolFields, `${PROTOCOL_PATH} cropTargets row type`);
  checkSameSet(validatorFields, `${VALIDATOR_PATH} isCropTargetFact`);
  checkSameSet(schemaFields, `${SCHEMA_PATH} $defs.cropTarget`);
  if (!snapshotSet.has("cropId"))
    push("crop_id_missing", "cropId", "the row cannot be joined to a data answer without the crop's own id");

  // 3. The passability fact is the pathfinder's own test, read from the type that OWNS the helper the row calls.
  let passability = null;
  if (snapshotSet.has("tileBlockedNow") && discoveryBody !== null) {
    const answer = passabilityAnswer(discoveryBody, (name) => {
      try {
        const owner = resolveMemberType(root, name, read);
        return { type: owner.type, file: owner.file, source: read(owner.file) };
      } catch {
        return null;
      }
    });
    if (answer.unresolved !== null) {
      push(
        "passability_answer_unresolved",
        "tileBlockedNow",
        `the row answers this key with \`${answer.unresolved}(...)\`, and no type in ${MOD_SOURCE_ROOT} declares it; the test that decides the answer was not read`,
      );
    } else {
      passability = answer.owner === null ? null : { via: answer.via, file: answer.owner.file };
      if (!answer.snippet.includes("isCollidingPosition"))
        push(
          "passability_not_pathfinder",
          "tileBlockedNow",
          `${answer.via} never calls GameLocation.isCollidingPosition, the call PathFindController.cs:222 makes; a cheaper ` +
            "test here answers a different question",
        );
      if (answer.snippet.includes("isTilePassable"))
        push(
          "passability_map_only",
          "tileBlockedNow",
          `${answer.via} calls isTilePassable, which reads only the map's Back and Buildings layers (GameLocation.cs:2898) ` +
            "and reports a trellis crop as open ground",
        );
    }
  }

  // 4. The row's keys are DERIVED: every key of the record is set by name, at one construction site, inside the type
  // that declares the discovery. A key the record declares and the discovery never derives is a key the row cannot have
  // measured - which is the whole subject of this gate and was, until this assertion existed, only asserted from the
  // worker side. The site is looked for across the whole TYPE, so a construction extracted into a helper does not read
  // as a missing derivation; two sites block, because then this gate cannot say which derivation it measured.
  const constructionSites = [];
  if (discovery !== null) {
    const pattern = new RegExp(`new[ \\t]+${ROW_RECORD}[ \\t]*\\(`, "gu");
    for (const file of discovery.files) {
      const source = read(file);
      for (const match of source.matchAll(pattern))
        constructionSites.push({ file, source, open: source.indexOf("(", match.index) });
    }
  }
  if (discovery !== null && constructionSites.length === 0) {
    push(
      "crop_row_construction_missing",
      discovery.type,
      `no \`new ${ROW_RECORD}(...)\` inside \`${discovery.type}\`, the type that declares ${ROW_DISCOVERY_FUNCTION}; a row built somewhere this gate cannot read is a derivation it cannot measure`,
    );
  } else if (constructionSites.length > 1) {
    push(
      "crop_row_construction_ambiguous",
      discovery.type,
      `${ROW_RECORD} is built in ${constructionSites.map((site) => site.file).join(", ")}; one row has one construction site, or this gate cannot say which derivation it measured`,
    );
  } else {
    for (const site of constructionSites) {
      const labels = new Set(labelledArguments(site.source, site.open));
      for (const field of snapshotFields) {
        const property = `${field.charAt(0).toUpperCase()}${field.slice(1)}`;
        if (labels.has(property)) continue;
        push(
          "field_not_derived",
          field,
          `the row publishes this key and \`new ${ROW_RECORD}(...)\` in ${site.file} sets no \`${property}:\` argument; the discovery reads nothing that becomes this key`,
        );
      }
    }
  }

  const exempted = workerFields.filter((field) => !snapshotSet.has(field));

  // 5. The gaps this row does not close, and the proof that the real path carries what it does.
  const actionDefinitions = read(ACTION_DEFINITIONS_PATH);
  for (const actionId of Object.keys(NOT_COVERED)) {
    if (!actionDefinitions.includes(`E("${actionId}",`))
      push(
        "not_covered_stale",
        actionId,
        `the Mod no longer declares this action in ${ACTION_DEFINITIONS_PATH}; the gap entry describes nothing`,
      );
  }
  for (const proof of ASSEMBLY_PATH_PROOFS) {
    let source = null;
    try {
      source = read(proof.file);
    } catch {
      source = null;
    }
    if (source === null || !source.includes(proof.fact))
      push(
        "assembly_proof_missing",
        proof.file,
        `the assembly-path proof no longer names \`${proof.fact}\`; a field that reaches no driven path is the weaker ` +
          "claim this gate exists to reject",
      );
  }
  findings.sort((left, right) => `${left.code}:${left.member}`.localeCompare(`${right.code}:${right.member}`));
  return Object.freeze({
    gate,
    verdict: findings.length === 0 ? "passed" : "blocked",
    examined: Object.freeze({
      workerFields: workerFields.length,
      snapshotFields: snapshotFields.length,
      shared: shared.length,
      exempted: exempted.length,
    }),
    declaration: Object.freeze({
      discovery: Object.freeze({
        type: discovery?.type ?? null,
        file: discovery?.file ?? null,
        functionsExamined: discoveryFunctions.length,
      }),
      passability: passability === null ? null : Object.freeze(passability),
    }),
    exempted: Object.freeze(exempted),
    workerFields: Object.freeze(workerFields),
    snapshotFields: Object.freeze(snapshotFields),
    findings: Object.freeze(findings),
  });
}

function report(result) {
  const { discovery, passability } = result.declaration;
  const lines = [
    `stardew_crop_row_derivation: examined ${result.examined.workerFields} worker fields, ` +
      `${result.examined.snapshotFields} snapshot fields, ${result.examined.shared} shared` +
      (result.exempted.length === 0
        ? ""
        : `; exempted ${result.exempted.length} (${sorted(result.exempted).join(",")})`),
    // The population line the next mover needs: whether a function moved, this names the type it expects to declare the
    // discovery family and how many of its functions were read, instead of a filename to update.
    discovery.type === null
      ? "stardew_crop_row_derivation: discovery declared nowhere this gate could read"
      : `stardew_crop_row_derivation: discovery declared in ${discovery.type} (${discovery.functionsExamined} functions examined): ${discovery.file}`,
  ];
  if (passability !== null)
    lines.push(`stardew_crop_row_derivation: tileBlockedNow answered by ${passability.via}: ${passability.file}`);
  for (const finding of result.findings)
    lines.push(`stardew_crop_row_derivation_${finding.code}: ${finding.member} - ${finding.detail}`);
  for (const [actionId, gap] of Object.entries(NOT_COVERED))
    lines.push(`not_covered:${actionId}:${gap.family} - ${gap.reason}`);
  for (const proof of ASSEMBLY_PATH_PROOFS) lines.push(`assembly_path_proof:${proof.file} - ${proof.what}`);
  lines.push(
    `stardew_crop_row_derivation: ${result.verdict}${result.findings.length === 0 ? "" : ` (${result.findings.length} finding(s))`}`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
  return result.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = report(checkStardewCropRowDerivation());
}
