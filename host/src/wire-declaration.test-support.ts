/**
 * The shared reader for the two DECLARATIONS of the bridge: the Mod's C# records and the Host's predicates.
 *
 * <p>
 * `declaration-agreement.test.ts` compares field NAMES; `protocol-target-facts-domain.test.ts` compares field
 * DOMAINS. Both must read the same two sources the same way, or the two gates can disagree about what a record
 * declares and neither reading is authority. This module is that one reader.
 * </p>
 *
 * <p>
 * Every reader accepts its SOURCE as an argument defaulting to the real file, and every one of them THROWS when it
 * reads nothing. A reader that returned an empty population would agree perfectly with an empty comparison, so a
 * missing reading is an error at the reader - `blocked` at the gate - and never a clean tree.
 * </p>
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One capture that participated in the match.
 *
 * `noUncheckedIndexedAccess` types every group as `string | undefined`, and these readers may not paper over that: a
 * group that did not participate would arrive as `undefined`, and a non-null assertion would instead compile as the
 * literal string `"undefined"` - a name nothing publishes, so a comparison would go quietly green over a parser that
 * matched nothing. The impossible case FAILS BY NAME instead of being asserted away.
 */
export function captured(match: readonly (string | undefined)[], index: number, what: string): string {
  const value = match[index];
  if (value === undefined) throw new Error(`${what}: capture group ${index} did not participate in the match`);
  return value;
}

export function repositoryRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew", "action-development"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository root not found from ${start}`);
    directory = parent;
  }
}

export const ROOT = repositoryRoot(dirname(fileURLToPath(import.meta.url)));

/**
 * Every `.cs` under the Mod's Models directory, concatenated.
 *
 * Not one file: `BridgeWearableTarget` and `WorldObjectTarget` live in their own files, and reading only
 * `BridgeProtocolModels.cs` reported both as "does not exist" - a parser with a narrower boundary than the thing it
 * describes, which is the defect class these gates exist to find.
 */
function modModelsSource(): string {
  const directory = join(ROOT, "integrations/stardew/src/Core/Models");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".cs"))
    .map((name) => readFileSync(join(directory, name), "utf8"))
    .join("\n");
}

export const MODELS = modModelsSource();
export const FACTS = readFileSync(join(ROOT, "host/src/protocol-target-facts.ts"), "utf8");
export const PROTOCOL = readFileSync(join(ROOT, "host/src/protocol.ts"), "utf8");
const ALL_TS = `${FACTS}\n${PROTOCOL}`;

/** One C# record parameter: its declared type and its name. */
export interface ModField {
  readonly type: string;
  readonly name: string;
}

/**
 * The content between the bracket at `open` and its matching partner.
 *
 * Comments are SKIPPED rather than counted. A declaration's parameter list carries `(` and `//` inside its own
 * comments, so counting them closes a group the code does not close there and the slice ends in the middle of a
 * declaration - which is how `modFamilies()` came to read past the end of `BridgeSnapshot` and into the record
 * declared after it.
 */
function bracketed(source: string, open: number, what: string): string {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === "/" && source[index + 1] === "/") {
      const lineEnd = source.indexOf("\n", index);
      index = lineEnd < 0 ? source.length : lineEnd;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const commentEnd = source.indexOf("*/", index + 2);
      if (commentEnd < 0) throw new Error(`${what}: a block comment never closes`);
      index = commentEnd + 1;
      continue;
    }
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`${what}: the bracket opened at ${open} never closes`);
}

/** Every `{ ... }` group at the top level of a source slice, in source order. */
function topLevelObjects(source: string): readonly string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(source.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

/** Every quoted literal in a source slice, in order. */
function quotedLiterals(source: string): readonly string[] {
  return [...source.matchAll(/"([^"]+)"/gu)].map((entry) => captured(entry, 1, "a quoted literal"));
}

/**
 * Split a parameter list on commas that are not inside `<>`, `[]`, or parentheses.
 *
 * ATTRIBUTES ARE STRIPPED FIRST. A record parameter may carry `[property: JsonIgnore(Condition = ...)]`, and the first
 * version of this parser read `Condition` out of that attribute and reported it as a field - which made a gate name two
 * real families with two invented disagreements. Reading C# with a regex is what produced that; stripping the bracket
 * group before splitting is the cheapest way to keep the regex honest about what it can see.
 */
export function splitTopLevel(body: string): readonly string[] {
  const withoutAttributes = body.replace(/\[[^\]]*\]/g, " ");
  const parts = [];
  let depth = 0;
  let current = "";
  for (const character of withoutAttributes) {
    if ("<[(".includes(character)) depth += 1;
    else if (">])".includes(character)) depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

/**
 * Strip C# comments from a declaration body before it is split.
 *
 * A parameter list carries `//` and `///` comments between its parameters - `BridgeSnapshot` explains a field in the
 * middle of its own declaration - and a splitter that reads them as parameters reports the prose as a field. The
 * name-only reading this replaces lost those tokens to its `null`/`string`/`int` filter by accident; naming the strip
 * is what makes the same body readable when the TYPE has to survive.
 */
function withoutComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** One record parameter, read as `<type> <name>`.
 *
 * The type is kept, not discarded: a numeric DOMAIN is a property of the declared type, and the name-only reading this
 * replaces could not tell `int Health` from `string Health`.
 */
function readParameter(parameter: string, record: string): ModField | null {
  const trimmed = parameter.trim();
  if (trimmed.length === 0) return null;
  const match = /^(.+?)\s+(\w+)\s*(?:=\s*[^,]*)?$/u.exec(trimmed);
  if (match === null)
    throw new Error(`\`${record}\`: a parameter this reader cannot split into type and name: "${trimmed}"`);
  return {
    type: captured(match, 1, `a \`${record}\` parameter type`).trim(),
    name: captured(match, 2, `a \`${record}\` parameter name`),
  };
}

/** `record` name -> its declared fields, from one-line and multi-line record declarations alike. */
export function modRecords(source: string = MODELS): Map<string, readonly ModField[]> {
  const records = new Map<string, readonly ModField[]>();
  // The parameter list ends at a `)` followed by the record's own `;` OR by a body `{`. Anchoring on `);` alone read
  // `BridgeScope` - whose declaration is followed by an `IsValid` body - as one enormous parameter, because the first
  // `);` after it is inside that body. It is not a snapshot family, so the name-only gate never noticed; a DOMAIN gate
  // would have attributed its fields to the wrong record.
  for (const record of source.matchAll(/public sealed record (Bridge\w+)\(([\s\S]*?)\)\s*(?:;|\{)/g)) {
    const name = captured(record, 1, "a Bridge record name");
    const body = withoutComments(captured(record, 2, `the \`${name}\` record body`));
    const fields = splitTopLevel(body)
      .map((parameter) => readParameter(parameter, name))
      .filter((field): field is ModField => field !== null);
    if (fields.length === 0) throw new Error(`\`${name}\`: no field was read from a record that declares one`);
    records.set(name, fields);
  }
  return records;
}

/**
 * What one member of `BridgeSnapshot` IS, which decides what the Host has to declare about it.
 *
 * `family` publishes rows of a record; `elementFamily` publishes a list of primitives; `nestedRecord` publishes ONE
 * record; `scalar` publishes a primitive. The last two are the members a family-shaped comparison never reached - and
 * a member outside the family table is exactly where `sceneTarget` lived: the Host admitted the key and no validator
 * named it, so a value of any shape was accepted.
 */
export type SnapshotMemberKind = "family" | "elementFamily" | "nestedRecord" | "scalar";

export interface SnapshotMember {
  /** The C# parameter name. */
  readonly name: string;
  /** The key the snapshot carries: the parameter name with a lowercased first letter. */
  readonly wireName: string;
  /** The declared C# type, attributes stripped. */
  readonly declaredType: string;
  readonly kind: SnapshotMemberKind;
  /** The record this member publishes, for a `family` or a `nestedRecord`. */
  readonly record: string | null;
}

const SNAPSHOT_DECLARATION = "public sealed record BridgeSnapshot(";

/**
 * EVERY member of the Mod's snapshot record, in declaration order.
 *
 * This is the population the declaration gate compares, and it is derived from the declaration itself rather than
 * from a list: a member added to the record is covered without editing a gate. The parameter list's own end comes
 * from bracket matching rather than from the next `\n)` in the file, because that reader read past the end of
 * `BridgeSnapshot` and into the record declared after it.
 */
export function modSnapshotMembers(source: string = MODELS): readonly SnapshotMember[] {
  const declaration = source.indexOf(SNAPSHOT_DECLARATION);
  if (declaration < 0)
    throw new Error(`BridgeSnapshot is not declared as \`${SNAPSHOT_DECLARATION}\`: the C# scan found nothing`);
  const body = withoutComments(
    bracketed(source, declaration + SNAPSHOT_DECLARATION.length - 1, "BridgeSnapshot's declaration"),
  );
  const members: SnapshotMember[] = [];
  for (const parameter of splitTopLevel(body)) {
    const field = readParameter(parameter, "BridgeSnapshot");
    if (field !== null) members.push(describeMember(field));
  }
  if (members.length === 0)
    throw new Error("BridgeSnapshot's declaration yielded no member: the C# scan is broken, not the tree");
  return members;
}

function describeMember(field: ModField): SnapshotMember {
  const wireName = lowerFirst(field.name);
  const recordList = /^IReadOnlyList<(Bridge\w+)>\??$/u.exec(field.type);
  if (recordList !== null)
    return {
      name: field.name,
      wireName,
      declaredType: field.type,
      kind: "family",
      record: captured(recordList, 1, `the \`${field.name}\` family record`),
    };
  if (/^IReadOnlyList<\w+>\??$/u.test(field.type))
    return { name: field.name, wireName, declaredType: field.type, kind: "elementFamily", record: null };
  const nested = /^(Bridge\w+)\??$/u.exec(field.type);
  if (nested !== null)
    return {
      name: field.name,
      wireName,
      declaredType: field.type,
      kind: "nestedRecord",
      record: captured(nested, 1, `the \`${field.name}\` nested record`),
    };
  return { name: field.name, wireName, declaredType: field.type, kind: "scalar", record: null };
}

/** family field name -> the record type it publishes. From `BridgeSnapshot`'s own declaration. */
export function modFamilies(source: string = MODELS): Map<string, string> {
  const families = new Map<string, string>();
  for (const member of modSnapshotMembers(source))
    if (member.kind === "family" && member.record !== null) families.set(member.name, member.record);
  return families;
}

/**
 * One Host validator: the keys it names, and the body those keys are checked in.
 *
 * <p>
 * `delegatesTo` is the CHAIN of predicates this one hands its value to, when its own body names no key list
 * (`isWaterTargetFact -> isRefillWateringCanTargetFact`) - not the keys copied over as if they were declared here. A
 * census that reported a delegate's key list under the delegateING predicate's name would send the next reader to the
 * wrong file, which is the same class as reporting nothing: the gate has to say where the row was decided.
 * </p>
 */
export interface HostValidator {
  readonly keys: readonly string[];
  readonly body: string;
  /** The chain its value is handed to, `->`-joined; null when the predicate names its own key list. */
  readonly delegatesTo: string | null;
}

/** One predicate as the source declares it, before any hand-over is followed. */
interface PredicateReading {
  readonly body: string;
  /** The keys ITS OWN body lists; empty when it lists none. */
  readonly ownKeys: readonly string[];
  /** The predicate its whole body hands `value` to, when the body is nothing but that call. */
  readonly handsTo: string | null;
}

/**
 * A body that is EXACTLY one call: `return other(value);`, and not one character of anything else.
 *
 * A conditional hand-over, a second statement, or a hand-over of something other than `value` is not a pass-through -
 * it is a predicate whose keys this reader cannot see, and it stays reported as such. That strictness is the point: a
 * loose pattern here would let a two-branch predicate claim the key list of one of its branches.
 */
const PASS_THROUGH_BODY = /^\s*return\s+([A-Za-z_]\w*)\(\s*value\s*\)\s*;?\s*$/u;

/**
 * function name -> its body, for every function declared in the Host's two protocol sources.
 *
 * Not only the `is*` predicates: the snapshot's nested records are decided by functions named `validate*` and
 * `is*SummaryFact`, and a reader that only knew the `is*: boolean` shape left every one of those unchecked.
 */
export function hostFunctionBodies(source: string = ALL_TS): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const match of source.matchAll(/function (\w+)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/gu)) {
    const name = captured(match, 1, "a Host function name");
    if (!bodies.has(name)) bodies.set(name, captured(match, 2, `the \`${name}\` body`));
  }
  return bodies;
}

/**
 * predicate function name -> its key list, or null when it names none and is no pass-through.
 *
 * A pass-through whose chain does not end in a key list one hop away is an entry with EMPTY `keys` and a named chain,
 * not `null`: the two states are different defects and the message has to tell them apart.
 */
export function hostValidators(source: string = ALL_TS): Map<string, HostValidator | null> {
  const readings = readPredicates(source);
  const validators = new Map<string, HostValidator | null>();
  for (const [name, reading] of readings) {
    if (reading.ownKeys.length > 0) {
      validators.set(name, { body: reading.body, keys: reading.ownKeys, delegatesTo: null });
      continue;
    }
    if (reading.handsTo === null) {
      validators.set(name, null);
      continue;
    }
    // The keys are the delegate's, and the NAME says so: a resolved pass-through carries the chain, and one whose chain
    // this reader does not follow carries it too - with no keys - so the failure message can name where it looked.
    const inherited = inheritsKeys(reading.handsTo, readings) ? readings.get(reading.handsTo) : undefined;
    validators.set(name, {
      body: inherited === undefined ? reading.body : inherited.body,
      keys: inherited === undefined ? [] : inherited.ownKeys,
      delegatesTo: passThroughChain(reading.handsTo, readings),
    });
  }
  return validators;
}

/** Every `is*` predicate in the source, as its own body declares it. */
function readPredicates(source: string): Map<string, PredicateReading> {
  const readings = new Map<string, PredicateReading>();
  for (const match of source.matchAll(/function (is\w+)\([^)]*\): boolean \{([\s\S]*?)\n\}/g)) {
    const name = captured(match, 1, "a Host snapshot validator name");
    const body = captured(match, 2, `the \`${name}\` validator body`);
    // Three helpers, and all three are honest field lists: `hasExactKeys` demands exact equality, `hasOnlyKeys` allows a
    // key to be absent (an optional field) but never an unlisted one, and `hasExactKeysOrOptional` takes the required set
    // and then names the keys it tolerates. The SECOND bracket is part of that naming: a key a row may omit is still a key
    // the validator names, and reading only the required list reported every optional member as a wire break the other way
    // (`harvestWhereabouts.nearestX: the Mod publishes it and the validator does not name it`).
    const keys = /has(?:Exact|Only)Keys(?:OrOptional)?\(\s*\w+\s*,\s*\[([\s\S]*?)\](?:\s*,\s*\[([\s\S]*?)\])?/u.exec(
      body,
    );
    const named = keys === null ? "" : `${captured(keys, 1, `the \`${name}\` key list`)} ${keys[2] ?? ""}`;
    readings.set(name, {
      body,
      ownKeys: [...named.matchAll(/"([^"]+)"/g)].map((entry) => captured(entry, 1, `a \`${name}\` key`)),
      handsTo: PASS_THROUGH_BODY.exec(body)?.[1] ?? null,
    });
  }
  return readings;
}

/**
 * Whether ONE hop from `target` reaches a predicate that names its own key list.
 *
 * ONE is the whole grant, and this is where it is enforced. A pass-through is a rename, and a rename can be checked by
 * looking at what it renames; a CHAIN of renames would make this reader an interpreter of aliases, and a predicate with
 * two branches would have to declare which branch's keys it means - neither of which the wire declares anywhere. So a
 * chain longer than one hop stays unresolved and is reported with the chain it walks.
 */
function inheritsKeys(target: string, readings: Map<string, PredicateReading>): boolean {
  const reached = readings.get(target);
  return reached !== undefined && reached.handsTo === null && reached.ownKeys.length > 0;
}

/** `a -> b -> c` for the hand-over chain starting at `start`, stopping at the first predicate that hands nothing on. */
function passThroughChain(start: string, readings: Map<string, PredicateReading>): string {
  const chain: string[] = [];
  let current: string | null = start;
  while (current !== null && !chain.includes(current)) {
    chain.push(current);
    current = readings.get(current)?.handsTo ?? null;
  }
  return chain.join(" -> ");
}

/**
 * Every member name the Host's functions actually NAME, as `value.<name>`.
 *
 * This is the guarantee available for a scalar: the bridge admits the key (`SNAPSHOT_KEYS`) and something in the
 * validators reads it. A member the Host admits and never names is accepted with any value of any type - which is
 * the `sceneTarget` shape one level up, and the reason this set exists rather than a second key list.
 */
export function hostNamedMembers(source: string = ALL_TS): Set<string> {
  const named = new Set<string>();
  for (const body of hostFunctionBodies(source).values())
    for (const match of body.matchAll(/\bvalue\.(\w+)/gu)) named.add(captured(match, 1, "a named snapshot member"));
  return named;
}

/** Every key the Host's snapshot validator admits at all, from `SNAPSHOT_KEYS`. */
export function hostSnapshotKeys(source: string = PROTOCOL): Set<string> {
  const declaration = source.indexOf("const SNAPSHOT_KEYS");
  if (declaration < 0) throw new Error("SNAPSHOT_KEYS is not declared in protocol.ts: this gate reads it by name");
  const open = source.indexOf("[", declaration);
  if (open < 0) throw new Error("SNAPSHOT_KEYS has no array: the declaration is not the shape this reads");
  const keys = new Set<string>(quotedLiterals(bracketed(source, open, "SNAPSHOT_KEYS")));
  if (keys.size === 0) throw new Error("SNAPSHOT_KEYS declares no key: the admission boundary is unreadable");
  return keys;
}

/**
 * One entry of the Host's `SNAPSHOT_FAMILY_RULES`: the field it decides, and the predicate it hands each entry to.
 *
 * `accepts` is kept as WRITTEN rather than as a name, because a rule's predicate may be an inline arrow. The previous
 * reader matched only `{ field: "x", maxItems: N, accepts: isX }` exactly, so it silently dropped every entry carrying
 * a `narrate:` or an inline predicate - nine of the eighty-seven - and the declaration gate turned that drop into a
 * pass. Reading the entry structurally is what makes the omission impossible rather than merely noted.
 */
export interface HostFamilyRule {
  readonly field: string;
  readonly accepts: string;
  /** True when `accepts` is an inline function, so no named key list exists to compare against. */
  readonly inline: boolean;
}

function readRuleEntry(object: string): HostFamilyRule {
  const field = /\bfield:\s*"(\w+)"/u.exec(object);
  if (field === null) throw new Error(`a SNAPSHOT_FAMILY_RULES entry names no field: "${object.slice(0, 120)}"`);
  const name = captured(field, 1, "a snapshot family field");
  const accepts = /\baccepts:\s*/u.exec(object);
  if (accepts === null) throw new Error(`the SNAPSHOT_FAMILY_RULES entry for \`${name}\` names no accepts predicate`);
  const expression = readRuleExpression(object, accepts.index + accepts[0].length);
  return { field: name, accepts: expression, inline: !/^\w+$/u.test(expression) };
}

/** The expression starting at `start`, ending at the entry's own top-level `,` or its closing `}`. */
function readRuleExpression(object: string, start: number): string {
  let depth = 0;
  let expression = "";
  for (let index = start; index < object.length; index += 1) {
    const character = object[index] ?? "";
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) {
      if (depth === 0) break;
      depth -= 1;
    } else if (character === "," && depth === 0) break;
    expression += character;
  }
  const trimmed = expression.trim();
  if (trimmed.length === 0)
    throw new Error(`a SNAPSHOT_FAMILY_RULES entry has an empty accepts expression: "${object.slice(0, 120)}"`);
  return trimmed;
}

/** EVERY entry of the Host's family table, in declaration order. */
export function hostFamilyRuleEntries(source: string = PROTOCOL): readonly HostFamilyRule[] {
  const declaration = source.indexOf("export const SNAPSHOT_FAMILY_RULES");
  if (declaration < 0)
    throw new Error("SNAPSHOT_FAMILY_RULES is not declared in protocol.ts: this gate reads it by name");
  const frozen = source.indexOf("Object.freeze(", declaration);
  if (frozen < 0)
    throw new Error(
      "SNAPSHOT_FAMILY_RULES is not an Object.freeze([...]) literal: the declaration is not the shape this reads",
    );
  const list = withoutComments(bracketed(source, source.indexOf("[", frozen), "SNAPSHOT_FAMILY_RULES"));
  const entries = topLevelObjects(list).map(readRuleEntry);
  if (entries.length === 0)
    throw new Error("SNAPSHOT_FAMILY_RULES declares no entry: the Host's rule table is unreadable");
  return entries;
}

/** `field` -> its rule, from the Host's own family table. */
export function hostFamilyRules(source: string = PROTOCOL): Map<string, HostFamilyRule> {
  const rules = new Map<string, HostFamilyRule>();
  for (const entry of hostFamilyRuleEntries(source)) {
    if (rules.has(entry.field))
      throw new Error(`\`${entry.field}\` is declared twice in SNAPSHOT_FAMILY_RULES: a field is decided once`);
    rules.set(entry.field, entry);
  }
  return rules;
}

export const lowerFirst = (value: string): string => `${value.charAt(0).toLowerCase()}${value.slice(1)}`;

/**
 * The validator the Host actually applies to a family, read from `SNAPSHOT_FAMILY_RULES`.
 *
 * Not derived from the family name, and not guessed by field overlap. Both attempts before this one were wrong:
 * `WorldObjectTargets` publishes a record whose name does not follow the family, `BridgeSoilTile` has two fields that both
 * appear inside `isForageTargetFact` so overlap matched a tile to a forage validator, and `warps`/`doorTargets` share one
 * `isWarp` predicate that is not named `is*Fact` at all. The Host already declares the answer next to each field -
 * `accepts: isWarp` - so read that.
 */
export function validatorFor(
  family: string,
  rules: ReadonlyMap<string, HostFamilyRule>,
  predicates: ReadonlyMap<string, HostValidator | null>,
): Readonly<{ missing: string }> | Readonly<{ name: string; validator: HostValidator }> {
  const rule = rules.get(family);
  if (rule === undefined) return { missing: `the Host declares no rule for ${family}, so it is never validated` };
  if (rule.inline)
    return {
      missing: `the Host's rule for ${family} hands each entry to \`${rule.accepts}\`, which names no key list, so its field set is not checkable`,
    };
  const predicate = predicates.get(rule.accepts);
  if (predicate === undefined)
    return {
      missing: `the Host's rule for ${family} accepts \`${rule.accepts}\`, which is not defined in protocol-target-facts.ts`,
    };
  // No key list of its own, and no pass-through either: the predicate reads no field set at all (`isRecord` and a
  // length, say), which is a different statement from a pass-through this reader refuses to follow.
  if (predicate === null)
    return { missing: `\`${rule.accepts}\` (${family}) names no key list, so its field set is not checkable` };
  if (predicate.keys.length === 0)
    return {
      missing:
        `\`${rule.accepts} -> ${predicate.delegatesTo ?? ""}\` (${family}) is a pass-through, and this census follows ` +
        "ONE hop to a predicate that must name its own keys - this chain does not, so its field set is not checkable",
    };
  return {
    name: predicate.delegatesTo === null ? rule.accepts : `${rule.accepts} -> ${predicate.delegatesTo}`,
    validator: predicate,
  };
}

/**
 * The readers the Host binds to one NON-family snapshot member.
 *
 * Two shapes exist and both are read: a key list written on the member itself (`hasExactKeys(value.tile, ["x", "y"])`),
 * and every function called with it (`validateActiveExecution(value.activeExecution)`). ALL of the call sites are
 * returned, not the first one: `diagnoseSnapshot` guards `activeExecution` with the generic `isRecord` before it hands
 * the same value to `validateActiveExecution`, and a reader that stopped at the first match reported every field of
 * that record as unexamined. A member with no reader at all is admitted by `SNAPSHOT_KEYS` and read by nothing, which
 * is the state this returns an empty list for.
 */
export interface MemberReader {
  /** The function name, or the inline check, that reads the member. */
  readonly name: string;
  /** The keys it names, or null when it names none (a `hasOnlyKeys(value, [...CONST])`, or a body-only reader). */
  readonly keys: readonly string[] | null;
  /** The reader's body, so a member whose key list is a constant can still be checked field by field. */
  readonly body: string;
}

export function hostMemberReaders(wireName: string, source: string = ALL_TS): readonly MemberReader[] {
  const inline = new RegExp(
    `has(?:Exact|Only)Keys(?:OrOptional)?\\(\\s*value\\.${wireName}\\s*,\\s*\\[([\\s\\S]*?)\\]`,
    "u",
  ).exec(source);
  if (inline !== null)
    return [
      {
        name: `hasExactKeys(value.${wireName})`,
        keys: quotedLiterals(captured(inline, 1, `the \`${wireName}\` inline key list`)),
        body: "",
      },
    ];
  const bodies = hostFunctionBodies(source);
  const readers: MemberReader[] = [];
  const seen = new Set<string>();
  for (const call of source.matchAll(new RegExp(`(\\w+)\\(\\s*value\\.${wireName}\\s*\\)`, "gu"))) {
    const name = captured(call, 1, `a reader bound to \`${wireName}\``);
    if (seen.has(name)) continue;
    seen.add(name);
    const body = bodies.get(name) ?? "";
    const listed = /has(?:Exact|Only)Keys(?:OrOptional)?\(\s*value\s*,\s*\[([\s\S]*?)\]/u.exec(body);
    const keys = listed === null ? [] : quotedLiterals(captured(listed, 1, `the \`${name}\` key list`));
    readers.push({ name, keys: keys.length === 0 ? null : keys, body });
  }
  return readers;
}
