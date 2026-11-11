import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FACTS,
  hostFamilyRules,
  hostFunctionBodies,
  hostMemberReaders,
  hostNamedMembers,
  hostSnapshotKeys,
  hostValidators,
  lowerFirst,
  MODELS,
  modFamilies,
  modRecords,
  modSnapshotMembers,
  PROTOCOL,
  validatorFor,
} from "./wire-declaration.test-support.js";
import type { HostFamilyRule, HostValidator, SnapshotMember } from "./wire-declaration.test-support.js";

/**
 * EVERY MEMBER THE MOD PUBLISHES MUST BE A MEMBER THE HOST READS - AND VICE VERSA.
 *
 * <p>
 * `snapshot-loopback.test.ts` proves the Host accepts a real sample, but only for the families a headless world can
 * construct. This gate closes the rest by comparing the two DECLARATIONS, which exist for every member:
 * </p>
 *
 * <pre>
 *   Mod    public sealed record BridgeXxxTarget(string TargetId, string Location, int X, ...)
 *   Host   function isXxxTargetFact(value): hasExactKeys(value, ["targetId", "location", "x", ...])
 * </pre>
 *
 * <p>
 * A field on one side and not the other is a wire break in one direction or the other: the Mod publishes what the Host
 * rejects (`invalid_snapshot`, the bridge closes on the first real farm) or the Host demands what the Mod never sends
 * (every snapshot refused). Both are what this repository spent a week discovering one live run at a time.
 * </p>
 *
 * <p>
 * POPULATION COMES FROM THE RECORD, NOT FROM WHAT THE GATE HAPPENS TO BE ABLE TO MATCH. `modSnapshotMembers()` reads
 * every member of the Mod's `BridgeSnapshot` declaration, and every one of them must have a Host declaration:
 * </p>
 *
 * <ul>
 *   <li>a `family` needs an entry in `SNAPSHOT_FAMILY_RULES` whose accepts predicate names a key list, compared both
 *       ways against the record it publishes - or a predicate that is a ONE-HOP pass-through to one that does, which is
 *       compared the same way with the chain reported (`waterTargets: isWaterTargetFact -> isRefillWateringCanTargetFact`)
 *       rather than with the delegate's keys filed under the delegateING predicate's name;</li>
 *   <li>an `elementFamily` needs its rule or a named validator, because its entries are primitives;</li>
 *   <li>a `nestedRecord` needs a reader whose keys are the record's keys - a key list written on the member, or a
 *       function called with it that names the fields;</li>
 *   <li>a `scalar` needs its key admitted by `SNAPSHOT_KEYS` and named by a validator, because a key nothing names is
 *       a value of any type.</li>
 * </ul>
 *
 * <p>
 * The reader this replaces required a rule to be spelled `{ field: "x", maxItems: N, accepts: isX }`, so it silently
 * dropped the nine rules carrying a `narrate:` or an inline predicate - `cropTargets` and `seedSupplyTargets` among
 * them, the two families whose loss cost live runs - and then treated "no rule found" as "nothing to compare". A
 * family is therefore never DROPPED here: it is either compared or reported by name. And because a comparison over an
 * empty population agrees with everything, a scan that reads nothing is `blocked`, never green.
 * </p>
 */

/** The sources this gate reads. Every reader takes its source, so a reader that reads nothing can be proved blocked. */
interface DeclarationSources {
  readonly models: string;
  readonly protocol: string;
  readonly facts: string;
}

const DECLARATIONS: DeclarationSources = { models: MODELS, protocol: PROTOCOL, facts: FACTS };

/**
 * A validator may name an OPTIONAL key the record omits: `BridgeDoor` has no `accessible`, and `isWarp` (shared with
 * `warps`) accepts one because the Mod omits a null member on the wire. This list is deliberately one entry long - a
 * second entry needs its own reason here, because "the validator is looser than the record" is otherwise exactly the
 * drift this gate reports.
 */
const OPTIONAL_ON_THE_WIRE = new Map([["accessible", "a null measurement is omitted, so absence means not measured"]]);

/** One line per member the two declarations disagree about, split by what kind of declaration is missing. */
interface Findings {
  readonly frame: readonly string[];
  readonly rules: readonly string[];
  readonly fields: readonly string[];
}

const NOTHING_FOUND: Findings = { frame: [], rules: [], fields: [] };

interface DeclarationReport {
  readonly status: "blocked" | "read";
  /** Why the population could not be read, when it could not. */
  readonly reason: string;
  readonly members: number;
  readonly families: number;
  readonly withRule: number;
  readonly withoutRule: number;
  /** The members whose KEY SET was compared, so "examined" is a reading rather than a claim. */
  readonly compared: readonly string[];
  /** The families whose validator is a pass-through, with the chain rendered - so the row's home is named, not flattened. */
  readonly passThroughs: readonly string[];
  readonly findings: Findings;
}

/**
 * The verdict for one pair of declarations.
 *
 * A reader that throws - a record declaration that is absent, a rule table that cannot be parsed - is NOT an empty
 * population: it is `blocked`, with the reader's own message. The three zeroes stay distinct: `blocked` means the
 * prerequisite could not be read, a non-empty `findings` means drift was measured, and only a read population with no
 * findings is green.
 */
function declarationReport(sources: DeclarationSources): DeclarationReport {
  try {
    return readDeclarations(sources);
  } catch (error) {
    return {
      status: "blocked",
      reason: error instanceof Error ? error.message : String(error),
      members: 0,
      families: 0,
      withRule: 0,
      withoutRule: 0,
      compared: [],
      passThroughs: [],
      findings: NOTHING_FOUND,
    };
  }
}

function readDeclarations(sources: DeclarationSources): DeclarationReport {
  const protocolSources = `${sources.facts}\n${sources.protocol}`;
  const members = modSnapshotMembers(sources.models);
  const records = modRecords(sources.models);
  const rules = hostFamilyRules(sources.protocol);
  const keys = hostSnapshotKeys(sources.protocol);
  const validators = hostValidators(protocolSources);
  const named = hostNamedMembers(protocolSources);

  const frame: string[] = [];
  const ruleFindings: string[] = [];
  const fields: string[] = [];
  const compared: string[] = [];
  const passThroughs: string[] = [];

  const published = new Set(members.map((member) => member.wireName));
  for (const member of members)
    if (!keys.has(member.wireName))
      frame.push(
        `${member.wireName} (${member.declaredType} ${member.name}): the Mod publishes it and SNAPSHOT_KEYS does not ` +
          "admit it - `hasOnlyKeys` refuses EVERY snapshot, so the bridge closes on the first real world",
      );
  for (const key of [...keys].sort())
    if (!published.has(key))
      frame.push(`${key}: SNAPSHOT_KEYS admits it and no member of the Mod's snapshot publishes it`);

  const families = members.filter((member) => member.kind === "family");
  for (const member of families) {
    const rule = rules.get(member.wireName);
    if (rule === undefined) {
      ruleFindings.push(
        `${member.wireName}: the Host declares NO RULE for the family the Mod publishes, so it is never validated. ` +
          `It publishes [${publishedFields(records, member.record)}]`,
      );
      continue;
    }
    if (rule.inline)
      ruleFindings.push(
        `${member.wireName}: the Host hands each entry to \`${rule.accepts}\`, an inline predicate, so the ` +
          `[${publishedFields(records, member.record)}] the Mod publishes are compared with nothing`,
      );
  }
  for (const field of [...rules.keys()].sort())
    if (!published.has(field))
      ruleFindings.push(`${field}: SNAPSHOT_FAMILY_RULES decides a field the Mod's snapshot does not publish`);

  for (const member of members) {
    if (member.kind === "family") {
      compareFamilyKeys(member, rules, validators, records, fields, compared);
      notePassThrough(member.wireName, rules, validators, passThroughs);
      continue;
    }
    if (member.kind === "nestedRecord") {
      compareNestedKeys(member, protocolSources, records, fields, compared);
      continue;
    }
    // A primitive list is decided by its rule (`professions` names an interval per entry) or by a named check
    // (`isStringArray(value.capabilities)`); a scalar is decided by whatever names it. Either way, a member nothing
    // names is a value of any type, which is the state this reports.
    if (rules.has(member.wireName) || named.has(member.wireName)) continue;
    fields.push(
      `${member.wireName} (${member.declaredType} ${member.name}): the Host admits the key and nothing reads it, so a ` +
        "value of any type is accepted",
    );
  }

  return {
    status: "read",
    reason: "",
    members: members.length,
    families: families.length,
    withRule: families.filter((member) => rules.has(member.wireName)).length,
    withoutRule: families.filter((member) => !rules.has(member.wireName)).length,
    compared,
    passThroughs,
    findings: { frame, rules: ruleFindings, fields },
  };
}

/**
 * The families whose rule names a ONE-HOP pass-through, with the chain and where the key list really lives.
 *
 * This is printed rather than folded into `compared`: `compared` legitimately contains `waterTargets`, and a reader who
 * followed that alone would look for its key list in `isWaterTargetFact` - where it is not. An UNRESOLVED chain is
 * listed here too, because a message that says only "names no key list" about a delegate points at the wrong file.
 */
function notePassThrough(
  family: string,
  rules: ReadonlyMap<string, HostFamilyRule>,
  validators: ReadonlyMap<string, HostValidator | null>,
  passThroughs: string[],
): void {
  const accepts = rules.get(family)?.accepts;
  if (accepts === undefined) return;
  const predicate = validators.get(accepts);
  if (predicate === undefined || predicate === null || predicate.delegatesTo === null) return;
  passThroughs.push(
    `${family}: \`${accepts}\` -> \`${predicate.delegatesTo}\` - the key list is the LAST predicate's, read where ` +
      "that predicate declares it",
  );
}

/** The keys a record publishes, as the wire spells them, for a failure message. */
function publishedFields(
  records: ReadonlyMap<string, readonly { readonly name: string }[]>,
  record: string | null,
): string {
  const declared = record === null ? undefined : records.get(record);
  return declared === undefined ? "no declared record" : declared.map((field) => lowerFirst(field.name)).join(", ");
}

/**
 * A family: the record's fields and the predicate's key list must be the same set.
 *
 * Both directions are reported, because they fail in opposite ways - the Mod sends a key the predicate refuses (the
 * bridge closes on a real world) and the predicate demands a key the Mod never sends (every snapshot refused).
 */
function compareFamilyKeys(
  member: SnapshotMember,
  rules: ReadonlyMap<string, HostFamilyRule>,
  validators: ReadonlyMap<string, HostValidator | null>,
  records: ReadonlyMap<string, readonly { readonly name: string }[]>,
  fields: string[],
  compared: string[],
): void {
  const record = member.record;
  const declared = record === null ? undefined : records.get(record);
  if (record === null || declared === undefined) {
    fields.push(`${member.wireName}: publishes ${String(record)}, which no record in the Mod's Models declares`);
    return;
  }
  const matched = validatorFor(member.wireName, rules, validators);
  if ("missing" in matched) {
    fields.push(`${member.wireName}: ${matched.missing}`);
    return;
  }
  compared.push(member.wireName);
  const published = new Set(declared.map((field) => lowerFirst(field.name)));
  const validated = new Set(matched.validator.keys);
  for (const field of published)
    if (!validated.has(field))
      fields.push(`${member.wireName}.${field}: the Mod publishes it and \`${matched.name}\` does not name it`);
  for (const key of validated)
    if (!published.has(key) && !OPTIONAL_ON_THE_WIRE.has(key))
      fields.push(`${member.wireName}.${key}: \`${matched.name}\` demands it and the Mod does not publish it`);
}

/**
 * A nested record: one row of the snapshot, whose keys are exactly what a reader has to accept.
 *
 * Two readers exist in the Host and both are read. A key list written on the member (`hasExactKeys(value.tile, ...)`)
 * is compared both ways. A function called with the member either names a key list of its own, or names the record's
 * fields in its body (`value.executionId`, ...) - and a field it never names is a field it accepts unexamined.
 */
function compareNestedKeys(
  member: SnapshotMember,
  protocolSources: string,
  records: ReadonlyMap<string, readonly { readonly name: string }[]>,
  fields: string[],
  compared: string[],
): void {
  const record = member.record;
  const declared = record === null ? undefined : records.get(record);
  if (record === null || declared === undefined) {
    fields.push(`${member.wireName}: publishes ${String(record)}, which no record in the Mod's Models declares`);
    return;
  }
  const readers = hostMemberReaders(member.wireName, protocolSources);
  if (readers.length === 0) {
    fields.push(
      `${member.wireName} (${member.declaredType}): the Host admits the key and binds NO reader to it, so ` +
        `[${publishedFields(records, record)}] are accepted unexamined`,
    );
    return;
  }
  compared.push(member.wireName);
  const published = new Set(declared.map((field) => lowerFirst(field.name)));
  const keyed = readers.find((reader) => reader.keys !== null);
  if (keyed === undefined || keyed.keys === null) {
    for (const field of published)
      if (!readers.some((reader) => namesField(reader.body, field)))
        fields.push(
          `${member.wireName}.${field}: none of [${readers.map((reader) => reader.name).join(", ")}] names it, so the ` +
            "field is accepted unexamined",
        );
    return;
  }
  const validated = new Set(keyed.keys);
  for (const field of published)
    if (!validated.has(field))
      fields.push(`${member.wireName}.${field}: the Mod publishes it and \`${keyed.name}\` does not name it`);
  for (const key of validated)
    if (!published.has(key) && !OPTIONAL_ON_THE_WIRE.has(key))
      fields.push(`${member.wireName}.${key}: \`${keyed.name}\` demands it and the Mod does not publish it`);
}

/** Whether a reader body names one key: as a member access (`value.executionId`) or a quoted literal. */
function namesField(body: string, field: string): boolean {
  return new RegExp(`\\bvalue\\.${field}\\b|"${field}"`, "u").test(body);
}

function readReport(sources: DeclarationSources = DECLARATIONS): DeclarationReport {
  const report = declarationReport(sources);
  if (report.status !== "read") assert.fail(`the declaration scan did not read the tree: ${report.reason}`);
  return report;
}

test("every member the Mod publishes is a key the Host admits", () => {
  const report = readReport();
  // Printed before the assertion so the numbers are a reading even when the gate is green.
  console.log(
    `snapshot declaration: members examined ${report.members} · families examined ${report.families} · ` +
      `with a rule ${report.withRule} · without a rule ${report.withoutRule} · key sets compared ${report.compared.length}`,
  );
  // Printed, not summarised: a pass-through's keys live in ANOTHER file, so the reader has to be told which one.
  for (const passThrough of report.passThroughs) console.log(`  pass-through ${passThrough}`);
  assert.ok(report.members > 100, `the Mod's snapshot members must have been read (found ${report.members})`);
  assert.ok(report.families > 70, `BridgeSnapshot must declare its families (found ${report.families})`);
  assert.deepEqual(
    report.findings.frame,
    [],
    "a key on one side only is a wire break in one direction: the Mod sends what the Host refuses, or the Host admits\n" +
      `what the Mod never sends.\n${report.findings.frame.join("\n")}`,
  );
});

test("every family the Mod declares is decided by a Host rule, and every rule decides a member", () => {
  const report = readReport();
  assert.equal(
    report.withoutRule,
    0,
    `${report.withoutRule} of ${report.families} families have no Host rule: a family with no rule is accepted\n` +
      `unexamined, which is not the same as accepted correctly.\n${report.findings.rules.join("\n")}`,
  );
  assert.deepEqual(
    report.findings.rules,
    [],
    "the two rule tables must name the same families, and a family whose entries are handed to an inline predicate\n" +
      `leaves its fields compared with nothing:\n${report.findings.rules.join("\n")}`,
  );
});

test("every field the Mod publishes is a field the Host's reader names", () => {
  const report = readReport();
  assert.deepEqual(
    report.findings.fields,
    [],
    "a field on one side only is a wire break in one direction: the Mod sends what the Host rejects, or the Host\n" +
      `demands what the Mod never sends.\n${report.findings.fields.join("\n")}`,
  );
});

/**
 * The Host functions that ADMIT a frame, as opposed to the one that explains a refusal.
 *
 * `validateBridgeMessage` hands the snapshot payload to `validateSnapshot`, and these four are the whole of what
 * that call decides for a member that is not a family row: the key set, the family verdicts, the one scalar that
 * lives beside them, and every other scalar. `diagnoseSnapshot` is deliberately NOT in this list - it runs AFTER
 * a refusal, to name the field, so a check that exists only there refuses nothing; the frame was already admitted.
 *
 * That is not a hypothesis. `farmBuildingTargetsOmitted` was named by the diagnostic and missing from
 * `snapshotDecisionScalarsAccepted`, so the gate's old rule ("some Host function names it") was green while
 * `validateBridgeMessage` accepted `"eight"`, `-1`, `1.5` and `{}` for it. The same shape hid `currentToolSlot`,
 * `currentToolSlotItem`, `actorDispositionDetail` and `actorDispositionActionOwned`.
 */
const PRODUCT_PATH = [
  "validateSnapshot",
  "snapshotDecisionScalarsAccepted",
  "firstSnapshotFamilyVerdict",
  "acceptedDailyQuestVerdict",
] as const;

/** One scalar member, and which of the two paths names it. */
interface ProductPathRow {
  readonly key: string;
  readonly product: boolean;
  readonly diagnostic: boolean;
}

interface ProductPathReport {
  readonly scalars: readonly ProductPathRow[];
  /** The members whose name ends in `Omitted`: the cap counts, which are one class and are read as one. */
  readonly omitted: readonly ProductPathRow[];
  readonly findings: readonly string[];
}

/**
 * Which path names which scalar, read from the declarations rather than from a list written here.
 *
 * The population is the Mod's own record: a `scalar` member has no family rule and no row reader, so the path that
 * admits the frame is the only thing that can validate it. Families are decided by `SNAPSHOT_FAMILY_RULES` (walked
 * by `firstSnapshotFamilyVerdict`) and nested records by the reader bound to their member; both have their own
 * comparison above, and neither is counted here.
 */
function productPathReport(source: string = PROTOCOL): ProductPathReport {
  const bodies = hostFunctionBodies(source);
  const product = PRODUCT_PATH.map((name) => {
    const body = bodies.get(name);
    if (body === undefined)
      throw new Error(`\`${name}\` is not declared in protocol.ts: the product path is unreadable`);
    return body;
  });
  const diagnostic = bodies.get("diagnoseSnapshot");
  if (diagnostic === undefined) throw new Error("`diagnoseSnapshot` is not declared: the two paths cannot be compared");
  const names = (key: string): ProductPathRow => ({
    key,
    product: product.some((body) => new RegExp(`value\\.${key}\\b`, "u").test(body)),
    diagnostic: new RegExp(`value\\.${key}\\b`, "u").test(diagnostic),
  });

  const members = modSnapshotMembers(MODELS);
  const scalars = members.filter((member) => member.kind === "scalar").map((member) => names(member.wireName));
  if (scalars.length === 0) throw new Error("the Mod declares no scalar member: the population is unreadable");
  const omitted = members
    .filter((member) => member.wireName.endsWith("Omitted"))
    .map((member) => names(member.wireName));
  if (omitted.length === 0) throw new Error("the Mod declares no `...Omitted` member: the cap counts are unreadable");

  const findings = scalars
    .filter((row) => !row.product)
    .map((row) =>
      row.diagnostic
        ? `${row.key}: \`diagnoseSnapshot\` names it and the decision path does not, so \`validateSnapshot\` admits a ` +
          "value of any type for it - the diagnostic only explains a refusal that already happened"
        : `${row.key}: neither path names it, so \`validateSnapshot\` admits a value of any type for it`,
    );
  return { scalars, omitted, findings };
}

test("every scalar the Mod publishes is named by the path that admits the frame", () => {
  const report = productPathReport();
  // Printed before the assertion, so the numbers are a reading even when the gate is green.
  console.log(
    `product path: scalars examined ${report.scalars.length} · named by validateSnapshot's path ` +
      `${report.scalars.filter((row) => row.product).length} · named only by the diagnostic ` +
      `${report.scalars.filter((row) => !row.product && row.diagnostic).length}`,
  );
  assert.ok(report.scalars.length > 20, `the Mod's scalars must have been read (found ${report.scalars.length})`);
  assert.deepEqual(
    report.findings,
    [],
    "a scalar the decision path does not name is a scalar `validateSnapshot` accepts with any value. The diagnostic\n" +
      `cannot cover it: it runs after the frame was admitted.\n${report.findings.join("\n")}`,
  );
});

test("every cap count the Mod publishes is named by both Host paths", () => {
  const report = productPathReport();
  const validated = report.omitted.filter((row) => row.product && row.diagnostic);
  console.log(`omitted keys examined ${report.omitted.length} · validated ${validated.length}`);
  // Every one of these is an `int?` count beside a family its cap truncated, so one shape decides all of them: a
  // non-negative integer, or absent, or null. A count that only one path names is a count the other path lets
  // through - `"eight"` beside eight rows reads as a complete supply.
  const unvalidated = report.omitted.filter((row) => !(row.product && row.diagnostic));
  assert.deepEqual(
    unvalidated.map(
      (row) =>
        `${row.key}: named by ${row.product ? "the decision path only" : row.diagnostic ? "the diagnostic only" : "neither path"}`,
    ),
    [],
    "a cap count one path does not name is a count the other path accepts unchecked",
  );
});

test("a scan that reads nothing is blocked, not agreed", () => {
  // A comparison over an empty population agrees with everything, so the absence of a reading has to be its own
  // verdict. Both halves are proved: no C# models at all, and a `BridgeSnapshot` whose parameter list is empty.
  const noRecords = declarationReport({ ...DECLARATIONS, models: "// the Mod's models were not found\n" });
  assert.equal(noRecords.status, "blocked");
  assert.match(noRecords.reason, /BridgeSnapshot/u, `the block must name what it could not read: ${noRecords.reason}`);

  const noMembers = declarationReport({ ...DECLARATIONS, models: "public sealed record BridgeSnapshot();" });
  assert.equal(noMembers.status, "blocked");
  assert.match(noMembers.reason, /no member/u, `the block must name what it could not read: ${noMembers.reason}`);

  const noRules = declarationReport({ ...DECLARATIONS, protocol: "" });
  assert.equal(noRules.status, "blocked");
  assert.match(
    noRules.reason,
    /SNAPSHOT_KEYS|SNAPSHOT_FAMILY_RULES/u,
    `the block must name the declaration it missed: ${noRules.reason}`,
  );

  // And the real tree is NOT blocked: a blocked verdict has to be a reading about the tree, not the gate's own state.
  assert.equal(readReport().status, "read");
});

test("a Host rule that disappears is named, not skipped", () => {
  // The rule this gate's reader used to drop: `cropTargets` carries a `narrate:` after its accepts, and the reader that
  // required the entry to end at ` }` never saw it. Deleting it now must fail the gate BY NAME, with the fields the
  // Mod publishes - which is the message a developer should have got instead of an `invalid_snapshot` 131 seconds into
  // a live run.
  const withoutCropTargets = PROTOCOL.replace(/\n\s*\{ field: "cropTargets"[^\n]*\n/u, "\n");
  assert.notEqual(withoutCropTargets, PROTOCOL, "the injection must remove the rule it names");
  const report = readReport({ ...DECLARATIONS, protocol: withoutCropTargets });
  const named = report.findings.rules.filter((finding) => finding.startsWith("cropTargets"));
  assert.equal(named.length, 1, `the missing rule must be named exactly once:\n${report.findings.rules.join("\n")}`);
  assert.ok(named[0]?.includes("regrowDays") === true, `the message must name the fields it publishes: ${named[0]}`);
});

test("the comparison is not vacuous: the families that have cost a run are examined", () => {
  // A parser that matched nothing would report perfect agreement with everything. `treeChopSourceTargets` is the family
  // whose `health` field this repository got wrong in both directions; `cropTargets` and `seedSupplyTargets` are the two
  // whose keys the reader above this one dropped, and each of them closed the bridge on a real farm.
  const report = readReport();
  for (const wireName of ["treeChopSourceTargets", "cropTargets", "seedSupplyTargets"])
    assert.ok(
      report.compared.includes(wireName),
      `\`${wireName}\` must have its key set compared; compared [${report.compared.join(", ")}]`,
    );

  const families = modFamilies();
  assert.equal(families.get("TreeChopSourceTargets"), "BridgeTreeChopSourceTarget");
  const fields = modRecords().get("BridgeTreeChopSourceTarget");
  assert.ok(fields !== undefined, "BridgeTreeChopSourceTarget must be parsed");
  assert.ok(
    fields.some((field) => field.name === "Health"),
    `its fields must be read; parsed [${fields.map((field) => `${field.type} ${field.name}`).join(", ")}]`,
  );
  const validator = hostValidators().get("isTreeChopSourceTargetFact");
  assert.ok(validator !== undefined && validator !== null, "isTreeChopSourceTargetFact must be parsed");
  assert.ok(validator.keys.includes("health"), `its keys must be read; parsed [${validator.keys.join(", ")}]`);
});

/**
 * `waterTargets` is the family this gate could not see: `isWaterTargetFact`'s whole body is
 * `return isRefillWateringCanTargetFact(value);`, so the key list lives one file section away and a reader that stops at
 * the outer predicate's body reports "names no key list" - which is the same verdict it gives a predicate that reads
 * nothing. This test is both halves: on the real tree the family IS compared, and the chain is PRINTED, so the next
 * reader is sent to the predicate that declares the keys instead of to the one that renames it.
 */
test("a family whose validator is a pass-through is compared against the predicate it delegates to, and the chain is named", () => {
  const report = readReport();
  assert.ok(
    report.compared.includes("waterTargets"),
    `\`waterTargets\` must have its key set compared; compared [${report.compared.join(", ")}]`,
  );
  const listed = report.passThroughs.filter((row) => row.startsWith("waterTargets"));
  assert.equal(
    listed.length,
    1,
    `\`waterTargets\` must be reported as a pass-through exactly once; reported [${report.passThroughs.join(", ")}]`,
  );
  assert.match(
    listed[0] ?? "",
    /`isWaterTargetFact` -> `isRefillWateringCanTargetFact`/u,
    `the report must name BOTH predicates, or the key list looks declared where it is not: ${listed[0]}`,
  );
  assert.ok(
    !report.findings.fields.some((finding) => finding.startsWith("waterTargets.")),
    `the compared key set must agree with BridgeWaterTarget: ${report.findings.fields.join("\n")}`,
  );
});

/**
 * The red half, in the two shapes a "follow one hop" reader must refuse.
 *
 * (a) The delegate names no key list at all. The gate must still fail, and the failure must name the CHAIN - a message
 *     that says `isWaterTargetFact` names no key list sends the next reader to the renamer, where there was never
 *     anything to find.
 * (b) The chain needs TWO hops. One hop is the whole grant (`inheritsKeys` above): a chain of renames would make this
 *     reader an interpreter of aliases, and nothing on the wire declares which branch of a multi-branch predicate a
 *     family's keys belong to.
 *
 * Both are injected into `facts`, the source `hostValidators` reads first, so the synthetic predicates are the ones the
 * family's rule resolves - and the real family's rule is untouched, which is what makes the finding the gate's own.
 */
test("a pass-through whose chain names no key list still fails by name, with the chain - one hop is the whole grant", () => {
  const rows = (...bodies: readonly string[]): string => bodies.join("\n");

  const noKeys = rows(
    "function isRefillWateringCanTargetFact(value: unknown): boolean {",
    "  return isRecord(value);",
    "}",
    "function isWaterTargetFact(value: unknown): boolean {",
    "  return isRefillWateringCanTargetFact(value);",
    "}",
    "",
  );
  const unresolved = declarationReport({ ...DECLARATIONS, facts: noKeys });
  assert.equal(unresolved.status, "read", `the injected source must still be read: ${unresolved.reason}`);
  const named = unresolved.findings.fields.filter((finding) => finding.startsWith("waterTargets"));
  assert.equal(
    named.length,
    1,
    `the delegate that names nothing must be reported exactly once:\n${unresolved.findings.fields.join("\n")}`,
  );
  assert.match(
    named[0] ?? "",
    /isWaterTargetFact -> isRefillWateringCanTargetFact/u,
    `the failure must name the chain it walked, not the outer predicate alone: ${named[0]}`,
  );
  assert.match(named[0] ?? "", /ONE hop/u, `the failure must say which rule it failed: ${named[0]}`);

  // (b) two hops, where the LAST predicate does name its keys: the grant is still one hop, so this stays unresolved.
  const twoHops = rows(
    "function isRowShapeFact(value: unknown): boolean {",
    '  return isRecord(value) && hasExactKeys(value, ["targetId", "x", "y"]);',
    "}",
    "function isMiddleFact(value: unknown): boolean {",
    "  return isRowShapeFact(value);",
    "}",
    "function isWaterTargetFact(value: unknown): boolean {",
    "  return isMiddleFact(value);",
    "}",
    "",
  );
  const chained = declarationReport({ ...DECLARATIONS, facts: twoHops });
  const chainedFinding = chained.findings.fields.filter((finding) => finding.startsWith("waterTargets"));
  assert.equal(
    chainedFinding.length,
    1,
    `a two-hop chain must be reported, not followed:\n${chained.findings.fields.join("\n")}`,
  );
  assert.match(
    chainedFinding[0] ?? "",
    /isWaterTargetFact -> isMiddleFact -> isRowShapeFact/u,
    `the failure must name every hop it refused to follow: ${chainedFinding[0]}`,
  );
});
