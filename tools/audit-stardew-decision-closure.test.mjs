// red-proof: inject  the same unreadable RuntimeFact -> `AssertionError ...` at
//   tools/audit-stardew-decision-closure.test.mjs:47 naming `red_proof_probe_fact` in the fact-surface
//   findings, from a case that passes on the clean tree
// Regression gate for the Stardew decision-closure audit (rev D, W5 §5.1).
//
// A checker that can only ever report "ok" is a vacuous gate, so every case below
// mutates one authority in memory and asserts the audit names the exact Fact Type
// that broke closure. Nothing is written to disk: the audit takes an `overrides`
// map so a mutation is a string, not an edited file (the same discipline the
// execution-receipt field-parity suite uses).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACTION_SURFACE_PATH,
  ASSERTION_FACT_SURFACE,
  ASSERTION_POSTCONDITION,
  ASSERTION_PRECONDITION,
  MOD_DEFINITIONS_PATH,
  PROTOCOL_PATH,
  arrayLiteralBody,
  auditStardewDecisionClosure,
  projectionFields,
} from "./audit-stardew-decision-closure.mjs";
import {
  DESCRIPTOR_PROJECTION_VOCABULARY,
  validateDescriptorProjection,
} from "../packages/game-action-program/src/descriptors.mjs";
import { parseActionSurface } from "../integrations/stardew/action-development/src/action-surface.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceOf = (relativePath) => readFileSync(path.join(ROOT, relativePath), "utf8");

const artifactWith = (mutate) => {
  const artifact = JSON.parse(sourceOf(ACTION_SURFACE_PATH));
  mutate(artifact);
  return { [ACTION_SURFACE_PATH]: JSON.stringify(artifact) };
};

const codesFor = (report, assertion) =>
  report.assertions.find((entry) => entry.name === assertion).findings.map((entry) => entry.code);

test("the current workspace satisfies all three decision-closure assertions", () => {
  const report = auditStardewDecisionClosure();

  assert.equal(report.gate, "stardew_decision_closure/v1");
  assert.deepEqual(report.findings, [], "the workspace must be closed");
  assert.equal(report.verdict, "passed");

  // The observation surface is the Host protocol's own projections, not a list.
  assert.ok(
    report.observationSurface.snapshotKeys.includes("machineTargets"),
    "snapshot target families are observation keys",
  );
  assert.ok(
    report.observationSurface.snapshotKeys.includes("activeExecution"),
    "the occupant projection is an observation key",
  );
  assert.deepEqual(report.observationSurface.publishedValueKinds, [
    "boolean",
    "destination_selector",
    "integer",
    "object",
    "string",
  ]);

  // Every declared fact is a typed identity read from the Mod registration source.
  assert.deepEqual(report.declaredRuntimeFacts, [
    { name: "arrival", kind: "destination_arrival" },
    { name: "machine_target_id", kind: "string" },
  ]);

  const byName = new Map(report.assertions.map((entry) => [entry.name, entry]));
  assert.ok(byName.get(ASSERTION_PRECONDITION).checked > 200, "every argument of every action is audited");
  assert.ok(byName.get(ASSERTION_POSTCONDITION).checked > 60, "every write/execution action is audited");
  assert.equal(byName.get(ASSERTION_FACT_SURFACE).checked, 2, "both declared RuntimeFacts are audited");
});

test("a RuntimeFact nothing can read is reported red", () => {
  // The failure this gate exists for: the Mod declares a fact, no snapshot/receipt/active-execution key
  // projects it, and it is not an ADR-006 binding fact either - so the Agent can never read back what the
  // action promised. An earlier version of this case mutated the published surface instead, which could not
  // fail: the surface is an export of this very declaration.
  const injected = `${sourceOf(MOD_DEFINITIONS_PATH).replace(
    '["machine_target_id"] = "string"',
    '["machine_target_id"] = "string", ["injected_runtime_fact"] = "string"',
  )}`;
  const report = auditStardewDecisionClosure({ overrides: { [MOD_DEFINITIONS_PATH]: injected } });

  assert.equal(report.verdict, "blocked");
  const findings = report.assertions.find((entry) => entry.name === ASSERTION_FACT_SURFACE).findings;
  const named = findings.filter((entry) => entry.code === "runtime_fact_not_readable");
  assert.deepEqual(
    named.map((entry) => entry.identity),
    ["injected_runtime_fact"],
    "the audit must name the unreadable fact",
  );
});

test("stripping a fact's registration is reported as the DRIFT it is, not as unreadability", () => {
  // Removing the registration does NOT make a binding fact unreadable - the action program still consumes it -
  // so it must be reported under its own code. Reporting it as unreadability is what the circular version did,
  // and that is why it could not distinguish a stale artifact from a promise nobody can read.
  const overrides = artifactWith((artifact) => {
    artifact.actions.find((action) => action.actionId === "machine_inspect").outputFacts = {};
  });
  const report = auditStardewDecisionClosure({ overrides });

  assert.equal(report.verdict, "blocked");
  const findings = report.assertions.find((entry) => entry.name === ASSERTION_FACT_SURFACE).findings;
  assert.deepEqual(
    findings.filter((entry) => entry.code === "declared_fact_not_registered_on_surface").map((entry) => entry.identity),
    ["machine_target_id"],
  );
  assert.deepEqual(
    findings.filter((entry) => entry.code === "runtime_fact_not_readable"),
    [],
    "a binding fact is still readable when its registration is stale; that is a drift finding, not a closure one",
  );
});

test("a RuntimeFact registered with a different kind is reported red", () => {
  const overrides = artifactWith((artifact) => {
    artifact.actions.find((action) => action.actionId === "machine_inspect").outputFacts = {
      machine_target_id: "integer",
    };
  });
  const report = auditStardewDecisionClosure({ overrides });

  assert.equal(report.verdict, "blocked");
  const named = report.assertions
    .find((entry) => entry.name === ASSERTION_FACT_SURFACE)
    .findings.filter((entry) => entry.code === "runtime_fact_kind_mismatch");
  assert.deepEqual(
    named.map((entry) => entry.identity),
    ["machine_target_id"],
  );
});

test("a registered RuntimeFact the Mod does not declare is reported red", () => {
  const overrides = artifactWith((artifact) => {
    artifact.actions.find((action) => action.actionId === "machine_inspect").outputFacts.ghost_fact = "string";
  });
  const report = auditStardewDecisionClosure({ overrides });

  assert.equal(report.verdict, "blocked");
  const named = report.assertions
    .find((entry) => entry.name === ASSERTION_FACT_SURFACE)
    .findings.filter((entry) => entry.code === "observation_surface_fact_not_declared");
  assert.deepEqual(
    named.map((entry) => entry.identity),
    ["ghost_fact"],
  );
});

test("an action argument of a kind the observation view does not publish is reported red", () => {
  const overrides = artifactWith((artifact) => {
    artifact.actions.find((action) => action.actionId === "move_to_tile").argumentSchema.x = { type: "json_pointer" };
  });
  const report = auditStardewDecisionClosure({ overrides });

  assert.equal(report.verdict, "blocked");
  const named = report.assertions
    .find((entry) => entry.name === ASSERTION_PRECONDITION)
    .findings.filter((entry) => entry.code === "precondition_hidden_input");
  assert.deepEqual(
    named.map((entry) => entry.identity),
    ["move_to_tile.x"],
  );
});

test("a write action whose postcondition was emptied is reported red", () => {
  const overrides = artifactWith((artifact) => {
    artifact.actions.find((action) => action.actionId === "till_soil").postcondition = { name: "" };
  });
  const report = auditStardewDecisionClosure({ overrides });

  assert.equal(report.verdict, "blocked");
  const named = report.assertions
    .find((entry) => entry.name === ASSERTION_POSTCONDITION)
    .findings.filter((entry) => entry.code === "contract_no_postcondition");
  assert.deepEqual(
    named.map((entry) => entry.identity),
    ["till_soil"],
  );
});

test("a read_only observation that declares a write effect is reported red", () => {
  const overrides = artifactWith((artifact) => {
    artifact.actions.find((action) => action.actionId === "observe_scene").effect = "write";
  });
  const report = auditStardewDecisionClosure({ overrides });

  assert.equal(report.verdict, "blocked");
  assert.deepEqual(codesFor(report, ASSERTION_POSTCONDITION), ["contract_readonly_declares_write"]);
});

test("a promise nobody can read stays red even when the surface is regenerated too", () => {
  // The case that proves the criterion is no longer circular. A COMPLETE change - the Mod declares a fact AND
  // the published artifact is regenerated to register it, which is what the real workflow does - satisfied the
  // OLD check by construction, because that artifact is an export of this very declaration. The check now asks
  // who can READ the fact, so it stays red however consistently the registration is updated.
  const declared = sourceOf(MOD_DEFINITIONS_PATH).replace(
    '["machine_target_id"] = "string"',
    '["machine_target_id"] = "string", ["nobody_reads_me"] = "string"',
  );
  assert.notEqual(declared, sourceOf(MOD_DEFINITIONS_PATH), "the mutation must actually apply");
  const registered = artifactWith((artifact) => {
    artifact.actions.find((action) => action.actionId === "machine_inspect").outputFacts = {
      machine_target_id: "string",
      nobody_reads_me: "string",
    };
  });
  const report = auditStardewDecisionClosure({ overrides: { [MOD_DEFINITIONS_PATH]: declared, ...registered } });

  assert.equal(report.verdict, "blocked");
  const findings = report.assertions.find((entry) => entry.name === ASSERTION_FACT_SURFACE).findings;
  assert.deepEqual(
    findings.filter((entry) => entry.code === "runtime_fact_not_readable").map((entry) => entry.identity),
    ["nobody_reads_me"],
    "registering a fact consistently does not make it readable",
  );
  // The drift legs stay quiet, so the redness comes from readability alone and not from a stale artifact.
  assert.deepEqual(
    findings.filter((entry) => entry.code === "declared_fact_not_registered_on_surface"),
    [],
  );
});
test("the surface-parseability precondition is reported under the fact-surface assertion", () => {
  const overrides = artifactWith((artifact) => {
    artifact.actions.find((action) => action.actionId === "till_soil").postcondition = { name: "" };
  });
  const report = auditStardewDecisionClosure({ overrides });

  assert.ok(
    codesFor(report, ASSERTION_FACT_SURFACE).includes("action_surface_not_parseable_by_host_protocol"),
    "a surface the Host descriptor whitelist cannot parse must be named",
  );
});

/** The detail of the one finding the parseability check produces. */
const parseabilityDetail = (report) =>
  report.assertions
    .find((entry) => entry.name === ASSERTION_FACT_SURFACE)
    .findings.find((entry) => entry.code === "action_surface_not_parseable_by_host_protocol")?.detail;

test("the surface-parseability finding names the refused member and the action carrying it", () => {
  // The gate said only "not parseable" when `sceneTarget` broke it on 2026-10-31, which forced the next reader to diff
  // two schemas by hand. The member is now named with the action carrying it, so which side is wrong is readable from
  // the finding alone.
  const report = auditStardewDecisionClosure({
    overrides: artifactWith((artifact) => {
      artifact.actions.find((action) => action.actionId === "till_soil").familyId = "farming";
    }),
  });

  assert.ok(parseabilityDetail(report).includes("familyId on till_soil"), parseabilityDetail(report));
});

test("the surface-parseability finding says so when every member is admitted", () => {
  // The other branch: the member vocabulary is fine and a VALUE rule refused the surface (here an empty postcondition
  // name). Saying nothing there would leave the reader looking for a member that is not the problem.
  const report = auditStardewDecisionClosure({
    overrides: artifactWith((artifact) => {
      artifact.actions.find((action) => action.actionId === "till_soil").postcondition = { name: "" };
    }),
  });

  assert.ok(parseabilityDetail(report).includes("every member is admitted"), parseabilityDetail(report));
});

/**
 * The two whitelists that describe one fact - which members a published action descriptor may carry - and the drift
 * between them that this gate found in the field.
 *
 * `approach` reached the Mod's generated surface on 2026-10-27 (`eea94e3f`), `description` on 2026-10-29
 * (`693c19a8`) and `sceneTarget` on 2026-10-31 (`450c8f90`). The Host's registration whitelist gained all three
 * (`protocol.ts` `KNOWN_ACTION_DESCRIPTOR_KEYS`, `isValidActionDescriptor`), while
 * `packages/game-action-program/src/descriptors.mjs` kept its own copy of the set and refused them - so the surface stopped
 * parsing into the descriptor map `verifier.mjs` builds its catalog from, even though the Host consumed it happily.
 * Nothing caught it because the two sets are spelled in two files nobody compares.
 *
 * Both sides are DERIVED: the projection side from the exported vocabulary the validator itself is built out of, the
 * Host side from `KNOWN_ACTION_DESCRIPTOR_KEYS` parsed out of `protocol.ts` with the same quote-aware array reader the
 * audit already uses for `SNAPSHOT_KEYS`. Nothing here hand-lists a member, so a member added to either side is judged
 * rather than missed, and the failure names the drifting member.
 */
function hostDescriptorKeys() {
  const body = arrayLiteralBody(sourceOf(PROTOCOL_PATH), "const KNOWN_ACTION_DESCRIPTOR_KEYS = [");
  return new Set([...body.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/gu)].map((match) => match[1]));
}

/**
 * The members the Host validates on the registration ENVELOPE rather than inside `descriptor`.
 *
 * The static surface artifact flattens the envelope into the action object (and omits `familyId`, which is live
 * policy rather than a surface fact), so its own `actionId`/`identityVersion`/`lifecycle`/`kind` are judged by
 * `isValidActionRegistrations`, not by `isValidActionDescriptor`. Derived from the `ActionRegistration` declaration so a
 * field moved between the two levels does not silently become an exemption.
 */
function hostEnvelopeKeys() {
  return new Set(projectionFields(sourceOf(PROTOCOL_PATH), "ActionRegistration"));
}

/** Every member name the published artifact actually uses, at descriptor level and inside each argument entry. */
function publishedSurfaceMembers() {
  const artifact = JSON.parse(sourceOf(ACTION_SURFACE_PATH));
  const descriptorMembers = new Set();
  const argumentMembers = new Set();
  for (const action of artifact.actions) {
    for (const key of Object.keys(action)) descriptorMembers.add(key);
    for (const entry of Object.values(action.argumentSchema ?? {})) {
      for (const key of Object.keys(entry)) argumentMembers.add(key);
    }
  }
  return { descriptorMembers, argumentMembers };
}

test("the projection admits every descriptor member the published surface actually uses", () => {
  // Red when `approach` (or any later member) is dropped from the projection's own set: the published artifact then
  // stops parsing into the descriptor map, which is the defect this file was extended for.
  const { descriptorMembers, argumentMembers } = publishedSurfaceMembers();
  const admitted = new Set([
    ...DESCRIPTOR_PROJECTION_VOCABULARY.descriptor.required,
    ...DESCRIPTOR_PROJECTION_VOCABULARY.descriptor.optional,
  ]);
  assert.deepEqual(
    [...descriptorMembers].filter((member) => !admitted.has(member)),
    [],
    "the published surface carries descriptor members the projection whitelist refuses",
  );

  const admittedArgument = new Set([
    ...DESCRIPTOR_PROJECTION_VOCABULARY.argumentSchemaEntry.required,
    ...DESCRIPTOR_PROJECTION_VOCABULARY.argumentSchemaEntry.optional,
  ]);
  assert.deepEqual(
    [...argumentMembers].filter((member) => !admittedArgument.has(member)),
    [],
    "the published surface carries argument members the projection whitelist refuses",
  );
});

test("the projection admits no descriptor member the Host's registration whitelist would refuse", () => {
  // The other direction, and the one whose absence let the gap open: a member this gateway admits but the Host refuses
  // is a descriptor that parses here and is rejected at registration. Every admitted member must be one the Host
  // judges - either on the registration envelope or inside the descriptor. The projection stays a SUBSET: the Host's
  // descriptor whitelist also carries fields the static surface artifact never publishes (`watchdogMs`,
  // `evidenceSchema`, `canonicalCodec`), so equality would be the wrong assertion.
  const judgedByTheHost = new Set([...hostEnvelopeKeys(), ...hostDescriptorKeys()]);
  const projection = [
    ...DESCRIPTOR_PROJECTION_VOCABULARY.descriptor.required,
    ...DESCRIPTOR_PROJECTION_VOCABULARY.descriptor.optional,
  ];
  assert.deepEqual(
    projection.filter((member) => !judgedByTheHost.has(member)),
    [],
    "the projection whitelist admits a descriptor member the Host judges at neither level",
  );
});

// ---------------------------------------------------------------------------
// The other two spellings of the same member vocabulary
// ---------------------------------------------------------------------------
//
// The tests above compare the published ARTIFACT with the projection that consumes it. Both of them are files on
// disk, which leaves the seam that has already fired twice unwatched: the Mod's C# record ORIGINATES the vocabulary,
// and the producer validator that judges the generated artifact spells it a second time. `approach` drifted across
// that seam (`693c19a8` producer side, `eff7646f` consumer side - never together) and `sceneTarget` drifted the other
// way (`450c8f90` added it to the record and did not regenerate the artifact). A member added to the record alone is
// invisible to every artifact-reading assertion, which is why the record is parsed here instead.

/** The Mod's C# source that originates the published descriptor shape. */
const SURFACE_PUBLICATION_PATH = "integrations/stardew/src/Core/Policy/farmhandactionsurfacepublication.cs";
/** The producer validator for the generated artifact: the second spelling of the same vocabulary. */
const PRODUCER_VALIDATOR_PATH = "integrations/stardew/action-development/src/action-surface.mjs";

/** `ActionId` -> `actionId`: the .NET `JsonNamingPolicy.CamelCase` this serializer is configured with. */
function camelCaseMember(pascalName) {
  if (!/^[A-Z][a-z0-9]/u.test(pascalName)) {
    // A leading acronym (`URL`, `ID`) would need the real policy's run-lowercasing, and guessing it here would publish
    // a member name the serializer does not use. Refusing is the only reading that cannot be silently wrong.
    throw new Error(`decision_closure_member_not_camel_caseable:${pascalName}`);
  }
  return `${pascalName[0].toLowerCase()}${pascalName.slice(1)}`;
}

/** Which bucket one parameter's attributes put it in. */
function bucketOf(attributes, recordName, segment) {
  if (attributes.some((attribute) => /JsonIgnoreCondition\.Always/u.test(attribute))) return "ignored";
  if (attributes.some((attribute) => /JsonIgnoreCondition\.WhenWritingNull/u.test(attribute))) return "optional";
  if (attributes.length === 0) return "required";
  throw new Error(`decision_closure_parameter_attribute_unclassified:${recordName}:${segment.trim()}`);
}

/**
 * One C# record's parameters, as the member vocabulary it declares.
 *
 * The depth counter starts at 1, because the record's own `(` is already open where the scan begins. Starting at 0
 * reads the first ten parameters as un-opened text and then breaks on the first attribute that carries its own
 * `(Condition = ...)`, returning a truncated list whose last "member" is `Condition` - a parse failure that makes the
 * gate green forever. `recordMemberVocabulary` is pinned to an exact member list by its own test below, which is what
 * turns that failure into a red assertion instead.
 *
 * Comments are stripped before anything else: the doc comments in this file carry apostrophes and parentheses ("the
 * holder's PHASE", "(`cropTargets`)") that would otherwise open a phantom string or bracket and swallow the record.
 */
function recordMemberVocabulary(source, recordName) {
  const anchor = `record ${recordName}(`;
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`decision_closure_record_not_found:${recordName}`);
  const segments = [];
  let current = "";
  let depth = 1;
  let index = at + anchor.length;
  while (index < source.length) {
    const skipped = skipCommentOrString(source, index);
    if (skipped !== null) {
      current += skipped.text;
      index = skipped.next;
      continue;
    }
    const char = source[index];
    if ("([{<".includes(char)) {
      depth += 1;
    } else if (")]}>}".includes(char)) {
      depth -= 1;
      if (depth === 0) return memberVocabularyFrom([...segments, current], recordName);
    }
    if (char === "," && depth === 1) {
      segments.push(current);
      current = "";
    } else {
      current += char;
    }
    index += 1;
  }
  throw new Error(`decision_closure_record_unbalanced:${recordName}`);
}

/**
 * The comment or string literal starting at `index`, as `{ text, next }`, or null when `index` is code.
 *
 * A comment contributes a space and a string contributes its own bytes, so a `,` inside either cannot split a
 * parameter and an unbalanced bracket inside a doc comment cannot close the record.
 */
function skipCommentOrString(source, index) {
  const char = source[index];
  const pair = `${char}${source[index + 1] ?? ""}`;
  if (pair === "//" || pair === "/*") {
    const end = pair === "//" ? source.indexOf("\n", index) : source.indexOf("*/", index + 2);
    const next = end < 0 ? source.length : end + (pair === "//" ? 0 : 2);
    return { text: " ", next };
  }
  if (char !== '"') return null;
  let cursor = index + 1;
  while (cursor < source.length && source[cursor] !== '"') cursor += source[cursor] === "\\" ? 2 : 1;
  const next = Math.min(cursor + 1, source.length);
  return { text: source.slice(index, next), next };
}

/** The member list a parameter list describes, refusing any parameter it cannot classify by name and bucket. */
function memberVocabularyFrom(segments, recordName) {
  const members = segments.map((segment) => {
    const attributes = [...segment.matchAll(/\[([^\]]*)\]/gu)].map((match) => match[1]);
    const declaration = segment.replace(/\[[^\]]*\]/gu, " ").trim();
    if (declaration === "" || /[[\]]/u.test(declaration)) {
      throw new Error(`decision_closure_parameter_unparsed:${recordName}:${segment.trim()}`);
    }
    const equals = declaration.indexOf("=");
    const head = (equals < 0 ? declaration : declaration.slice(0, equals)).trim();
    const name = /([A-Za-z_][A-Za-z0-9_]*)$/u.exec(head);
    if (name === null) throw new Error(`decision_closure_parameter_unparsed:${recordName}:${head}`);
    return { name: camelCaseMember(name[1]), bucket: bucketOf(attributes, recordName, segment) };
  });
  for (const [position, member] of members.entries()) {
    if (members.findIndex((other) => other.name === member.name) !== position) {
      throw new Error(`decision_closure_duplicate_parameter:${recordName}:${member.name}`);
    }
  }
  const inBucket = (bucket) => new Set(members.filter((member) => member.bucket === bucket).map((m) => m.name));
  return { members, required: inBucket("required"), optional: inBucket("optional"), ignored: inBucket("ignored") };
}

/** The producer validator's own two lists: the artifact's required core and the fields it may omit. */
function producerActionVocabulary(source) {
  const read = (anchor) =>
    new Set([...arrayLiteralBody(source, anchor).matchAll(/"([^"]+)"/gu)].map((match) => match[1]));
  return {
    required: read("const ACTION_SURFACE_ACTION_KEYS = Object.freeze(["),
    optional: read("const ACTION_SURFACE_OPTIONAL_ACTION_KEYS = Object.freeze(["),
  };
}

/**
 * The drift between the Mod's record and the producer vocabulary, named member by member.
 *
 * Both sides are read from source: the record by parsing the declaration, the producer by reading its two arrays. A
 * member the record declares and the producer does not know is an artifact that can never be regenerated to carry it;
 * a member the producer knows and the record does not declare is a vocabulary entry with nothing behind it.
 */
function descriptorVocabularyDrift({ modSource, producerSource }) {
  const mod = recordMemberVocabulary(modSource, "FarmhandActionDescriptorProjection");
  const producer = producerActionVocabulary(producerSource);
  const findings = [];
  for (const bucket of ["required", "optional"]) {
    const producerList = bucket === "required" ? "ACTION_SURFACE_ACTION_KEYS" : "ACTION_SURFACE_OPTIONAL_ACTION_KEYS";
    for (const member of mod[bucket]) {
      if (producer[bucket].has(member)) continue;
      findings.push({
        identity: member,
        code: "mod_member_absent_from_producer_vocabulary",
        detail:
          `the Mod's FarmhandActionDescriptorProjection declares ${bucket} member '${member}' but the producer validator's ` +
          `${producerList} does not list it, so the generated artifact can never carry it`,
      });
    }
    for (const member of producer[bucket]) {
      if (mod[bucket].has(member)) continue;
      findings.push({
        identity: member,
        code: "producer_member_absent_from_mod_record",
        detail:
          `the producer validator's ${producerList} lists '${member}' but the Mod's FarmhandActionDescriptorProjection ` +
          `declares no such ${bucket} member`,
      });
    }
  }
  for (const member of mod.ignored) {
    if (!(producer.required.has(member) || producer.optional.has(member))) continue;
    findings.push({
      identity: member,
      code: "mod_ignored_member_in_producer_vocabulary",
      detail: `the Mod never serializes '${member}' (JsonIgnoreCondition.Always) but the producer validator admits it`,
    });
  }
  return findings.sort((left, right) => left.identity.localeCompare(right.identity));
}

/** The argument-entry pair, from the same two sources, against the projection's exported argument vocabulary. */
function argumentVocabularyDrift({ modSource, projection }) {
  const mod = recordMemberVocabulary(modSource, "FarmhandActionArgumentSchema");
  const findings = [];
  for (const bucket of ["required", "optional"]) {
    const published = new Set(projection.argumentSchemaEntry[bucket]);
    for (const member of mod[bucket]) {
      if (published.has(member)) continue;
      findings.push({
        identity: member,
        code: "mod_argument_member_absent_from_projection",
        detail:
          `the Mod's FarmhandActionArgumentSchema declares ${bucket} member '${member}' but the projection's ` +
          `argumentSchemaEntry.${bucket} vocabulary does not admit it`,
      });
    }
    for (const member of published) {
      if (mod[bucket].has(member)) continue;
      findings.push({
        identity: member,
        code: "projection_argument_member_absent_from_mod_record",
        detail:
          `the projection's argumentSchemaEntry.${bucket} vocabulary admits '${member}' but the Mod's ` +
          `FarmhandActionArgumentSchema declares no such member`,
      });
    }
  }
  return findings.sort((left, right) => left.identity.localeCompare(right.identity));
}

test("the Mod's descriptor record parses to exactly the member vocabulary it declares", () => {
  // The parser's own self-check, and the reason it is a pinned list rather than a count: a truncated parse is the one
  // failure that makes this gate green forever. The version that started its depth counter at 0 returned ten of these
  // thirteen members and reported `condition` as the last one, and every assertion built on it passed.
  const vocabulary = recordMemberVocabulary(sourceOf(SURFACE_PUBLICATION_PATH), "FarmhandActionDescriptorProjection");
  assert.deepEqual(vocabulary.members, [
    { name: "actionId", bucket: "required" },
    { name: "identityVersion", bucket: "required" },
    { name: "lifecycle", bucket: "required" },
    { name: "kind", bucket: "required" },
    { name: "argumentSchema", bucket: "required" },
    { name: "outputFacts", bucket: "required" },
    { name: "resourceTemplate", bucket: "required" },
    { name: "effect", bucket: "required" },
    { name: "postcondition", bucket: "required" },
    { name: "watchdogMs", bucket: "ignored" },
    { name: "approach", bucket: "optional" },
    { name: "sceneTarget", bucket: "optional" },
    { name: "targetFamily", bucket: "optional" },
    { name: "nativeBinding", bucket: "optional" },
  ]);
  // The other record is parsed by the same reader and must not bleed into this one: `Enum` and `Description` also carry
  // `WhenWritingNull` and belong to FarmhandActionArgumentSchema.
  assert.deepEqual(recordMemberVocabulary(sourceOf(SURFACE_PUBLICATION_PATH), "FarmhandActionArgumentSchema").members, [
    { name: "type", bucket: "required" },
    { name: "enum", bucket: "optional" },
    { name: "description", bucket: "optional" },
  ]);
});

/**
 * A second reading of the same record: one parameter per line, which is how this file is formatted.
 *
 * The bracket scanner above is the authority, and this is the check that it did not quietly stop early - a different
 * algorithm that shares none of its state. A doc comment is skipped, a blank line is skipped, and the scan ends at the
 * parameter that closes the list (on its own line in one record, at the end of the last parameter in the other). It
 * throws rather than returning a shorter list when a line does not fit the shape, so a reformatting of the record is a
 * loud failure instead of a silent narrowing.
 */
function recordParametersByLine(source, recordName) {
  const anchor = `record ${recordName}(`;
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`decision_closure_record_not_found:${recordName}`);
  const names = [];
  for (const line of source
    .slice(at + anchor.length)
    .split("\n")
    .slice(1)) {
    const text = line.trim();
    if (text === "" || text.startsWith("///")) continue;
    const closes = /[)];?$/u.test(text);
    const body = text.replace(/[)];?$/u, "").trim();
    if (body === "") return names;
    const declaration = body.replace(/^\[[^\]]*\]\s*/u, "");
    const name = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:=[^,]*)?,?$/u.exec(declaration);
    if (name === null) throw new Error(`decision_closure_parameter_line_unparsed:${recordName}:${text}`);
    names.push(camelCaseMember(name[1]));
    if (closes) return names;
  }
  throw new Error(`decision_closure_record_unterminated:${recordName}`);
}

test("the record parser agrees with a line-oriented reading of the same declaration", () => {
  // The cross-check that makes a truncated parse impossible to miss: the bracket scanner and this reader share no state,
  // and the pinned list above would happily accept a consistently wrong reading if both were wrong the same way.
  for (const recordName of ["FarmhandActionDescriptorProjection", "FarmhandActionArgumentSchema"]) {
    assert.deepEqual(
      recordMemberVocabulary(sourceOf(SURFACE_PUBLICATION_PATH), recordName).members.map((member) => member.name),
      recordParametersByLine(sourceOf(SURFACE_PUBLICATION_PATH), recordName),
      `${recordName}: the two readings of one declaration disagree`,
    );
  }
});

test("the Mod's descriptor record and the producer validator spell one member vocabulary", () => {
  assert.deepEqual(
    descriptorVocabularyDrift({
      modSource: sourceOf(SURFACE_PUBLICATION_PATH),
      producerSource: sourceOf(PRODUCER_VALIDATOR_PATH),
    }),
    [],
    "the record that originates the vocabulary and the validator that judges the artifact disagree",
  );
});

test("the Mod's descriptor record and the generated artifact carry one member vocabulary", () => {
  // The leg that closes the hole the other two cannot see. The producer validator is PERMISSIVE about optional members:
  // adding one to `ACTION_SURFACE_OPTIONAL_ACTION_KEYS` makes it ACCEPT an artifact that does not carry it. So a member
  // added to the record AND to the producer, with the artifact left unregenerated, passes every artifact-reading
  // assertion in this file and every producer check - and the model is never told the field exists. Measured at
  // `dac67971`: the record gained `targetFamily`, the artifact did not carry it, and nothing compared the two.
  //
  // The comparison is a UNION, not bucket by bucket: a record-optional member that every action happens to declare is
  // required in the artifact, and both spellings describe the same member. `watchdogMs` is excluded by construction
  // because it is `JsonIgnoreCondition.Always` - and if it ever reached the artifact, this assertion names it.
  const record = recordMemberVocabulary(sourceOf(SURFACE_PUBLICATION_PATH), "FarmhandActionDescriptorProjection");
  const declared = new Set([...record.required, ...record.optional]);
  const published = publishedSurfaceMembers().descriptorMembers;
  const findings = [
    ...[...declared]
      .filter((member) => !published.has(member))
      .map((member) => ({
        identity: member,
        code: "record_member_absent_from_generated_artifact",
        detail:
          `the Mod's FarmhandActionDescriptorProjection declares '${member}' but no action in the generated artifact ` +
          `carries it - the artifact was not regenerated after the record changed`,
      })),
    ...[...published]
      .filter((member) => !declared.has(member))
      .map((member) => ({
        identity: member,
        code: "artifact_member_absent_from_record",
        detail:
          `the generated artifact carries '${member}' but the Mod's FarmhandActionDescriptorProjection declares no such ` +
          `member - the artifact is newer than the record that is supposed to originate it`,
      })),
  ];
  assert.deepEqual(
    findings.sort((left, right) => left.identity.localeCompare(right.identity)),
    [],
    "the record and the artifact it generates disagree about the member vocabulary",
  );
});

test("a member the record declares and the artifact omits is named, even when the producer admits it", () => {
  // The hole stated as a case. The producer is widened to accept the member - which is what an author does when adding
  // one - and the artifact is left alone. Every other assertion in this file reads the artifact, so this is the only
  // one that can see the gap, and the delta against the current tree keeps the proof independent of any existing drift.
  const record = recordMemberVocabulary(sourceOf(SURFACE_PUBLICATION_PATH), "FarmhandActionDescriptorProjection");
  const published = publishedSurfaceMembers().descriptorMembers;
  const baseline = new Set([...record.required, ...record.optional].filter((member) => !published.has(member)));
  const injected = [...record.required, ...record.optional, "injectedFamily"].filter(
    (member) => !(published.has(member) || baseline.has(member)),
  );
  assert.deepEqual(injected, ["injectedFamily"], "a member the record declares and the artifact omits must be visible");
});

test("a member added to the Mod's record alone is named as producer drift", () => {
  // The `450c8f90` shape: the record gains a member and the artifact is not regenerated. Every assertion that reads the
  // artifact off disk passes, so the drift has to be found by comparing the record with the producer vocabulary.
  //
  // The assertion is the DELTA the injection adds, not the whole finding set: this tree may already carry a real drift
  // (it does - `targetFamily`), and a proof that also fails on the pre-existing finding proves nothing about the
  // injection. `baseline` is the same tree unmutated, so anything the delta does not name is not this case's business.
  const current = sourceOf(SURFACE_PUBLICATION_PATH);
  const producerSource = sourceOf(PRODUCER_VALIDATOR_PATH);
  const baseline = new Set(
    descriptorVocabularyDrift({ modSource: current, producerSource }).map((entry) => entry.identity),
  );
  const injectedDrift = (mutated) =>
    descriptorVocabularyDrift({ modSource: mutated, producerSource })
      .filter((entry) => !baseline.has(entry.identity))
      .map((entry) => [entry.identity, entry.code]);

  const withOptional = current.replace(
    "[property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? TargetFamily = null",
    "[property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? TargetFamily = null,\n    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? InjectedFamily = null",
  );
  assert.notEqual(withOptional, current, "the mutation must actually apply");
  assert.deepEqual(injectedDrift(withOptional), [["injectedFamily", "mod_member_absent_from_producer_vocabulary"]]);

  // A REQUIRED member is the same defect with a worse consequence: the artifact's own required-key check then refuses
  // every action, not just the ones that would have carried the field.
  const withRequired = current.replace("    string Effect,", "    string Effect,\n    string InjectedRequired,");
  assert.notEqual(withRequired, current, "the mutation must actually apply");
  assert.deepEqual(injectedDrift(withRequired), [["injectedRequired", "mod_member_absent_from_producer_vocabulary"]]);
});

test("the Mod's argument record and the projection spell one argument vocabulary", () => {
  assert.deepEqual(
    argumentVocabularyDrift({
      modSource: sourceOf(SURFACE_PUBLICATION_PATH),
      projection: DESCRIPTOR_PROJECTION_VOCABULARY,
    }),
    [],
    "the argument-entry vocabulary the Mod serializes and the one the gateway admits disagree",
  );
});

/**
 * The members the Host knows that are never published to the agent, each with the reason it is here.
 *
 * The equality below cannot be stated without this list, and the list is what makes a fifth runtime-only member a
 * reviewed addition instead of a silent one. Every entry is a member `KNOWN_ACTION_DESCRIPTOR_KEYS` admits that the
 * published projection does not:
 *
 *  - `arguments`     the REGISTRATION wire's form of the argument map (`BridgeProtocolModels.cs`
 *                    `FarmhandActionDescriptorWire.Arguments`, a list of `{name, type, enum, description}`). The static
 *                    artifact publishes the same facts as `argumentSchema`, keyed by name, so the list form is never
 *                    published; the Host reads both (`action-registry.ts:813`).
 *  - `watchdogMs`    the Mod's own execution budget. `JsonIgnoreCondition.Always` on the record, because it sizes a
 *                    dispatch deadline rather than describing anything the agent decides with.
 *  - `evidenceSchema` Host-tolerated only: no C# source emits it (measured: zero occurrences under
 *                    `integrations/stardew`), so it is a whitelist entry with no producer.
 *  - `canonicalCodec` the same, for the codec name.
 *
 * `nativeBinding` left this list when it became a member of the projection record: the Host's mount arms require it, and
 * a member required only on the wire is one the artifact's consumers cannot read, which is how the two body-language
 * actions the Game prompt names were unmountable without a running game.
 */
const RUNTIME_ONLY_KEYS = Object.freeze(["arguments", "canonicalCodec", "evidenceSchema", "watchdogMs"]);

/**
 * The drift between the projection and the Host's registration whitelist, once the runtime-only members are separated.
 *
 * The subset assertion above says nothing the projection admits is unknown to the Host. This is the other half: the
 * Host knows nothing the projection does not publish or the runtime-only list does not explain. `hostEnvelopeKeys` is
 * subtracted from the projection side because those members are judged on the registration envelope, not inside the
 * descriptor (`actionId`, `identityVersion`, `lifecycle`, `kind`).
 */
function hostWhitelistDrift({ hostDescriptorKeys, hostEnvelopeKeys, projection, runtimeOnly = RUNTIME_ONLY_KEYS }) {
  const findings = [];
  const published = new Set(
    [...projection.descriptor.required, ...projection.descriptor.optional].filter(
      (member) => !hostEnvelopeKeys.has(member),
    ),
  );
  for (const member of runtimeOnly) {
    if (!published.has(member)) continue;
    findings.push({
      identity: member,
      code: "runtime_only_member_also_published",
      detail: `'${member}' is listed as runtime-only but the projection publishes it to the agent`,
    });
  }
  const expected = new Set([...published, ...runtimeOnly]);
  for (const member of expected) {
    if (hostDescriptorKeys.has(member)) continue;
    findings.push({
      identity: member,
      code: "host_whitelist_missing_member",
      detail:
        `the Host's KNOWN_ACTION_DESCRIPTOR_KEYS does not admit '${member}', so a registration carrying it is refused ` +
        `with hasOnlyKeys before any value rule runs`,
    });
  }
  for (const member of hostDescriptorKeys) {
    if (expected.has(member)) continue;
    findings.push({
      identity: member,
      code: "host_whitelist_member_not_accounted",
      detail:
        `the Host's KNOWN_ACTION_DESCRIPTOR_KEYS admits '${member}' but nothing publishes it and ` +
        `RUNTIME_ONLY_KEYS does not name it`,
    });
  }
  return findings.sort((left, right) => left.identity.localeCompare(right.identity));
}

const currentHostWhitelistDrift = () =>
  hostWhitelistDrift({
    hostDescriptorKeys: hostDescriptorKeys(),
    hostEnvelopeKeys: hostEnvelopeKeys(),
    projection: DESCRIPTOR_PROJECTION_VOCABULARY,
  });

test("the Host's descriptor whitelist is the published projection plus the runtime-only members", () => {
  assert.deepEqual(currentHostWhitelistDrift(), [], "the Host and the projection disagree about the member vocabulary");
});

test("dropping a member from the runtime-only set is named, not absorbed", () => {
  // The red proof for the equality above: `canonicalCodec` is a Host-side member nothing publishes, so removing it
  // from the explanation leaves a whitelist entry the projection cannot account for.
  const findings = hostWhitelistDrift({
    hostDescriptorKeys: hostDescriptorKeys(),
    hostEnvelopeKeys: hostEnvelopeKeys(),
    projection: DESCRIPTOR_PROJECTION_VOCABULARY,
    runtimeOnly: RUNTIME_ONLY_KEYS.filter((member) => member !== "canonicalCodec"),
  });
  assert.deepEqual(
    findings.map((entry) => [entry.identity, entry.code]),
    [["canonicalCodec", "host_whitelist_member_not_accounted"]],
  );
});

test("a projection member the Host does not admit is named as the refusal it becomes", () => {
  // The live risk, and the `450c8f90` replay: the gateway starts admitting a member while the Host's whitelist still
  // refuses it. The descriptor then parses here and is rejected at registration.
  //
  // The injected member is no longer `targetFamily`. That WAS the live case when this proof was written - the gateway
  // admitted the member and `KNOWN_ACTION_DESCRIPTOR_KEYS` did not - and the case is now closed at both sites, so
  // appending it again widens nothing and the assertion would pass by having nothing to report. The member is named
  // here instead, and the precondition below keeps this honest: if the Host ever admits it, this proof fails on the
  // precondition rather than going quietly green.
  const injected = "injectedFamily";
  assert.equal(
    hostDescriptorKeys().has(injected),
    false,
    `'${injected}' is now a member the Host admits, so this proof has nothing to widen - pick a member it refuses`,
  );
  const widened = {
    ...DESCRIPTOR_PROJECTION_VOCABULARY,
    descriptor: {
      required: DESCRIPTOR_PROJECTION_VOCABULARY.descriptor.required,
      optional: [...DESCRIPTOR_PROJECTION_VOCABULARY.descriptor.optional, injected],
    },
  };
  assert.deepEqual(
    hostWhitelistDrift({
      hostDescriptorKeys: hostDescriptorKeys(),
      hostEnvelopeKeys: hostEnvelopeKeys(),
      projection: widened,
    }).map((entry) => [entry.identity, entry.code]),
    [[injected, "host_whitelist_missing_member"]],
  );
});

/** A descriptor the projection accepts as the only member variation, for the shape cases below. */
function descriptorWith(overrides) {
  return {
    schema: "gamebuddy-action-descriptors/v1",
    catalogRevision: 1,
    actions: [
      {
        actionId: "ride_minecart",
        identityVersion: 1,
        lifecycle: "live_verified",
        kind: "execution",
        argumentSchema: { x: { type: "integer" } },
        outputFacts: {},
        resourceTemplate: { claims: [] },
        effect: "write",
        postcondition: { name: "native_action_postcondition" },
        ...overrides,
      },
    ],
  };
}

test("an approach declaration is admitted at exactly the shape the Host enforces", () => {
  // The forward direction of the same fact: admitting the MEMBER is not enough, the VALUE must be admissible too, or
  // the gateway would pass a descriptor the Host refuses - the drift this whole file exists to stop, seen from the
  // other side. Both readings below are `protocol.ts` `isValidActionDescriptor`.
  for (const approach of [
    { relation: "adjacent" },
    { relation: "adjacent", withinTiles: 1 },
    { relation: "self_walked" },
    { relation: "x".repeat(64), withinTiles: 2 },
  ]) {
    assert.equal(validateDescriptorProjection(descriptorWith({ approach })), true, JSON.stringify(approach));
  }

  for (const [approach, why] of [
    [{}, "a relation is required: `withinTiles` alone names no relationship"],
    [{ relation: "" }, "an empty relation is a label that says nothing"],
    [{ relation: "x".repeat(65) }, "the Host bounds the relation at 64 characters"],
    [{ relation: 7 }, "a relation is a word, not a number"],
    [{ relation: "adjacent", withinTiles: 0 }, "absent means no distance stated; zero is a different claim"],
    [{ relation: "adjacent", withinTiles: -1 }, "a negative distance is not a distance"],
    [{ relation: "adjacent", withinTiles: 1.5 }, "a fractional distance cannot be walked to"],
    [{ relation: "adjacent", withinTiles: "1" }, "the distance is a number"],
    [{ relation: "adjacent", withinTiles: null }, "the serializer omits nulls, it never sends one"],
    [{ relation: "adjacent", note: "x" }, "a third field would be a precondition nobody enforces"],
  ]) {
    assert.equal(validateDescriptorProjection(descriptorWith({ approach })), false, why);
  }
});

test("a scene target is admitted at exactly the shape the Host enforces", () => {
  // The member `450c8f90` added to the surface and the Host already validated: admitting the MEMBER is not enough, the
  // VALUE must be admissible too or the gateway would pass a descriptor the Host refuses. Both readings are `protocol.ts`
  // `isValidActionDescriptor`.
  const binding = {
    type: "ObservationBinding",
    version: 1,
    required: true,
    requiredProperties: ["observationId", "ref"],
  };
  assert.equal(validateDescriptorProjection(descriptorWith({ sceneTarget: binding })), true);
  // An EMPTY property list is admitted, because the Host admits it: its only cardinality bound is `length > 16`. Refusing
  // it here would make the gateway stricter than the Host, which is the same drift pointing the other way.
  assert.equal(
    validateDescriptorProjection(descriptorWith({ sceneTarget: { ...binding, requiredProperties: [] } })),
    true,
  );

  for (const [sceneTarget, why] of [
    [{ ...binding, type: "" }, "a type that says nothing names no binding"],
    [{ ...binding, type: "x".repeat(65) }, "the Host bounds the type at 64 characters"],
    [{ ...binding, version: 0 }, "the Host requires a version of at least 1"],
    [{ ...binding, version: 1.5 }, "a version is an integer"],
    [{ ...binding, required: "yes" }, "`required` is a boolean, not a truthy string"],
    [
      { ...binding, requiredProperties: Array.from({ length: 17 }, (_, index) => `property${index}`) },
      "the Host bounds the property list at 16",
    ],
    [{ ...binding, requiredProperties: ["ObservationId"] }, "a property name is the published lower-camel shape"],
    [{ ...binding, requiredProperties: [7] }, "a property name is a name"],
    [{ ...binding, extra: true }, "a fifth field would be a requirement nobody enforces"],
    [{ type: "ObservationBinding", version: 1, required: true }, "`requiredProperties` is part of the declaration"],
  ]) {
    assert.equal(validateDescriptorProjection(descriptorWith({ sceneTarget })), false, why);
  }
});

test("an argument description is admitted at exactly the shape the Host enforces", () => {
  const described = (description) => descriptorWith({ argumentSchema: { slot: { type: "integer", description } } });

  assert.equal(validateDescriptorProjection(described("a backpack index")), true);
  assert.equal(validateDescriptorProjection(described("x".repeat(512))), true);
  // Absent is how the surface says the name is the whole story; present-but-empty is a label that says nothing.
  assert.equal(validateDescriptorProjection(described("")), false);
  assert.equal(validateDescriptorProjection(described("x".repeat(513))), false);
  assert.equal(validateDescriptorProjection(described(7)), false);
});

// ---------------------------------------------------------------------------
// The VALUE rule for `targetFamily`, at the three sites that spell it
// ---------------------------------------------------------------------------
//
// The tests above compare MEMBER vocabularies. `targetFamily` needed the other half as well: three files each decide
// which strings are a legal snapshot family, and they disagreed for a whole session without anything naming it.
//
//  - the producer `action-surface.mjs` holds `TARGET_FAMILY` and judged the generated artifact with it
//  - the consumer `descriptors.mjs` holds `TARGET_FAMILY_NAME` and is the gateway the Host-side catalog is built from
//  - the Host `protocol.ts` writes the same rule inline inside `isValidActionDescriptor`, where it cannot be imported
//
// The measured disagreement was not one of degree: the producer was still applying `IDENTIFIER`, the ACTION-ID rule, so
// it admitted 2 of the 68 families the Mod declares (`warps`, `chests`) and refused the other 66.
//
// WHY THE FIXTURES ARE DERIVED. A hand-written list of 68 family names is a list of what its author remembered, and it
// fails open the moment the Mod adds one. The population comes from two authorities instead: the Host's own
// `SNAPSHOT_KEYS` - the set of fields a family may name - and the published artifact, which is what the Mod actually
// declares. A rule that refuses a real family is red against the artifact, and a rule that admits a name no snapshot
// field uses is red against `SNAPSHOT_KEYS`.
//
// WHY MUTUAL AGREEMENT ALONE WOULD BE WORTHLESS. Three rules that all admit `tool_slots` agree perfectly and are all
// wrong. So agreement is asserted BESIDE two absolute properties - every real family passes, every malformed value is
// refused - and the malformed set is the one place a name is written by hand, because a bad value is a shape nobody
// derives from a correct one.

/** The first regex literal in `text`, as a `RegExp`; throws rather than returning a permissive default. */
function regexLiteralIn(text, what) {
  const literal = /\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/u.exec(text)?.[0];
  if (literal === undefined) throw new Error(`decision_closure_target_family_rule_unreadable:${what}`);
  const lastSlash = literal.lastIndexOf("/");
  return new RegExp(literal.slice(1, lastSlash), literal.slice(lastSlash + 1));
}

/**
 * The three predicates, each re-derived from its own site's source.
 *
 * The producer's rule is read in two steps, and that is the point: first WHICH constant the `validateAction` guard
 * applies to `targetFamily`, then that constant's own definition. Reading a constant's definition directly would have
 * missed the defect this gate exists for - the guard said `IDENTIFIER`, and a definition-first reader would have found
 * `IDENTIFIER`'s declaration and reported it as the family rule without noticing that an ACTION-ID rule was judging a
 * snapshot field.
 *
 * The Host's is the awkward one: its rule is inline and unexported, so the regex and the two length bounds are read out
 * of the `targetFamily` guard block and recombined exactly as that block combines them. Reading the block rather than
 * restating `64` here is what makes a Host-side change to the bound visible instead of silently ignored.
 *
 * Every source is overridable so a case can mutate the REAL text of one site and re-derive through the same reader - a
 * red proof built on a hand-written lookalike predicate proves only that the assertion runs.
 */
function targetFamilyRules({ producerSource, consumerSource, protocolSource } = {}) {
  const producerText = producerSource ?? sourceOf(PRODUCER_VALIDATOR_PATH);
  const producerConstant = /!([A-Z][A-Z0-9_]*)\.test\(value\.targetFamily\)/u.exec(producerText)?.[1];
  if (producerConstant === undefined) {
    throw new Error("decision_closure_target_family_rule_unreadable:producer guard");
  }
  const producerDefinition = new RegExp(
    `const ${producerConstant} = (\\/(?:\\\\.|[^/\\\\\\n])+\\/[gimsuy]*);`,
    "u",
  ).exec(producerText)?.[1];
  const producer = regexLiteralIn(producerDefinition ?? "", `producer ${producerConstant}`);
  const consumer = regexLiteralIn(
    /export const TARGET_FAMILY_NAME = (\/.*\/);/u.exec(
      consumerSource ?? readFileSync(path.join(ROOT, "packages/game-action-program/src/descriptors.mjs"), "utf8"),
    )?.[1] ?? "",
    "consumer TARGET_FAMILY_NAME",
  );

  const protocolText = protocolSource ?? sourceOf(PROTOCOL_PATH);
  const guardStart = protocolText.indexOf('if ("targetFamily" in value && value.targetFamily !== undefined) {');
  if (guardStart < 0) throw new Error("decision_closure_target_family_rule_unreadable:host guard");
  const guard = protocolText.slice(guardStart, protocolText.indexOf("return true;", guardStart));
  const hostRegex = regexLiteralIn(guard, "host inline rule");
  const emptyRefused = /value\.targetFamily\.length === 0/u.test(guard);
  const ceiling = /value\.targetFamily\.length > (\d+)/u.exec(guard)?.[1];
  if (!emptyRefused || ceiling === undefined) {
    throw new Error("decision_closure_target_family_rule_unreadable:host length bounds");
  }
  const hostMax = Number(ceiling);

  return Object.freeze({
    producer: (value) => typeof value === "string" && producer.test(value),
    consumer: (value) => typeof value === "string" && consumer.test(value),
    host: (value) => typeof value === "string" && value.length > 0 && value.length <= hostMax && hostRegex.test(value),
  });
}

/** Every family the published artifact declares, and every snapshot key a family may name: both derived. */
function targetFamilyFixtures() {
  const artifact = JSON.parse(sourceOf(ACTION_SURFACE_PATH));
  const declared = [
    ...new Set(
      (Array.isArray(artifact.actions) ? artifact.actions : [])
        .map((action) => action.targetFamily)
        .filter((family) => family !== undefined),
    ),
  ].sort();
  const snapshotKeys = [...hostSnapshotKeys()].sort();
  return { declared, snapshotKeys };
}

function hostSnapshotKeys() {
  return new Set(
    [...arrayLiteralBody(sourceOf(PROTOCOL_PATH), "const SNAPSHOT_KEYS = [").matchAll(/"([^"]+)"/gu)].map(
      (match) => match[1],
    ),
  );
}

/**
 * The value a legal `targetFamily` may NOT be, each with the reason it is illegal.
 *
 * Written by hand because these are the shapes a rule exists to refuse - there is no correct population to derive them
 * from. Each one is a real near-miss rather than a fuzzed string: `ToolSlots` is the C# property name the serializer
 * never emits, `tool_slots`/`tool-slots` are the two spellings a reader who has not seen the wire would guess, and the
 * over-long name is the bound every other published lower-camel name carries.
 */
const MALFORMED_TARGET_FAMILIES = Object.freeze([
  ["ToolSlots", "the C# property name; the serializer publishes `toolSlots`"],
  ["", "present-but-empty says nothing; absent is the surface's statement of no family"],
  ["tool-slots", "a spelling no snapshot response carries"],
  ["tool_slots", "the snake_case shape, which is the ACTION-ID rule borrowed into a field name"],
  ["toolSlots ", "a trailing space is a different name"],
  ["9lives", "a field name starts with a letter"],
  ["x".repeat(65), "longer than the 64 every other published lower-camel name is bounded at"],
  ["x".repeat(200), "far past the bound, so the refusal cannot be a coincidence of the regex"],
]);

/**
 * Where the three sites disagree, per fixture, naming the site that is the ODD ONE OUT rather than the pair.
 *
 * `sites` is a map of name -> predicate so a case can mutate one and show the finding names THAT one. Naming every
 * disagreeing site would be technically true and practically useless: when one site drifts the other two still agree
 * with each other, and a report that named all three would leave the reader to work out which is which. With three
 * sites a strict minority always exists; if a future fourth site makes the split even, every site is named and the
 * detail says the split is even, so the case fails loudly instead of guessing.
 */
function targetFamilyRuleDrift({ sites, declared, malformed }) {
  const findings = [];
  const names = Object.keys(sites);
  const check = (value, code, detail) => {
    const verdicts = names.map((name) => [name, sites[name](value)]);
    const admitted = verdicts.filter(([, admittedThis]) => admittedThis).map(([name]) => name);
    const refused = verdicts.filter(([, admittedThis]) => !admittedThis).map(([name]) => name);
    if (admitted.length === names.length || admitted.length === 0) return;
    const minority = admitted.length < refused.length ? admitted : refused.length < admitted.length ? refused : names;
    const split =
      admitted.length === refused.length
        ? `the split is even (${admitted.length}/${names.length}), so no site can be called the odd one out`
        : `${minority.join(", ")} disagrees with ${names.filter((name) => !minority.includes(name)).join(", ")}`;
    for (const name of minority) {
      findings.push({
        identity: `${name}:${JSON.stringify(value).slice(0, 32)}`,
        code,
        detail: `${detail}; ${split}`,
      });
    }
  };

  for (const value of declared) check(value, "target_family_real_value_refused", `the surface declares '${value}'`);
  for (const [value, why] of malformed) {
    check(value, "target_family_malformed_value_admitted", `${why}`);
  }
  return findings.sort((left, right) => left.identity.localeCompare(right.identity));
}

const currentTargetFamilyDrift = () =>
  targetFamilyRuleDrift({
    sites: targetFamilyRules(),
    ...targetFamilyFixtures(),
    malformed: MALFORMED_TARGET_FAMILIES,
  });

test("the three sites that decide what a targetFamily may be apply one rule", () => {
  assert.deepEqual(
    currentTargetFamilyDrift(),
    [],
    "the producer, the consumer and the Host disagree about targetFamily",
  );
});

test("every family the Mod declares, and every snapshot key, passes all three sites", () => {
  // The absolute half, so three identically-wrong rules cannot pass. `snapshotKeys` is the wider set: it includes
  // fields no action consumes yet, and a family is by definition one of them.
  const { declared, snapshotKeys } = targetFamilyFixtures();
  assert.ok(declared.length > 60, `the artifact must declare its families (read ${declared.length})`);
  const sites = targetFamilyRules();
  for (const value of [...declared, ...snapshotKeys]) {
    for (const [name, rule] of Object.entries(sites)) {
      assert.equal(rule(value), true, `${name} refuses '${value}', which the snapshot publishes as a field`);
    }
  }
});

test("every malformed targetFamily is refused by all three sites", () => {
  const sites = targetFamilyRules();
  for (const [value, why] of MALFORMED_TARGET_FAMILIES) {
    for (const [name, rule] of Object.entries(sites)) {
      assert.equal(rule(value), false, `${name} admits ${JSON.stringify(value)}: ${why}`);
    }
  }
});

test("a site that drifts is named, and the real families show it", () => {
  // The red proof, and it mutates the REAL source text rather than substituting a lookalike predicate: the producer's
  // guard is changed back to `IDENTIFIER` - the exact defect this unit repaired - and the reader re-derives the rule
  // from that text through the same two steps it uses on the real file.
  const asFound = sourceOf(PRODUCER_VALIDATOR_PATH).replace(
    "!TARGET_FAMILY.test(value.targetFamily)",
    "!IDENTIFIER.test(value.targetFamily)",
  );
  assert.notEqual(asFound, sourceOf(PRODUCER_VALIDATOR_PATH), "the mutation must actually apply");
  const findings = targetFamilyRuleDrift({
    sites: targetFamilyRules({ producerSource: asFound }),
    ...targetFamilyFixtures(),
    malformed: MALFORMED_TARGET_FAMILIES,
  });

  assert.ok(findings.length > 0, "the drifted producer must be visible");
  assert.deepEqual(
    [...new Set(findings.map((entry) => entry.identity.split(":")[0]))],
    ["producer"],
    "only the drifted site may be named",
  );

  const refusedReal = findings.filter((entry) => entry.code === "target_family_real_value_refused");
  // `IDENTIFIER` is the ACTION-ID rule (snake_case), so the only real families it can still admit are the ones
  // spelled that way. Naming those two is the contract; the count of refused families is then DERIVED from the
  // artifact, because the artifact is where the population comes from. The hardcoded 66 it replaces was measured
  // once and failed on a change that was correct: `pet_farm_animal` added `farmAnimalPetTargets` (camelCase), so the
  // drifted producer refuses 67 of 69 - and a new SNAKE_CASE family still fails here, naming itself.
  const identiferAdmits = new Set(["chests", "warps"]);
  const declaredFamilies = targetFamilyFixtures().declared;
  assert.deepEqual(
    declaredFamilies.filter(
      (value) => !refusedReal.some((entry) => entry.identity.startsWith(`producer:${JSON.stringify(value)}`)),
    ),
    [...identiferAdmits].sort(),
    "only the snake_case families may survive the drifted producer's rule, and each must be named",
  );
  assert.equal(
    refusedReal.length,
    declaredFamilies.length - identiferAdmits.size,
    "every other declared family must be named as refused",
  );
  assert.ok(refusedReal.every((entry) => entry.identity.startsWith("producer:")));

  // And the reuse is wrong on a second axis the real families cannot show: `IDENTIFIER` is a SNAKE_CASE rule, so it
  // ADMITS two of the malformed values. Both must be named, which is why the malformed set is not decoration.
  const admittedMalformed = findings
    .filter((entry) => entry.code === "target_family_malformed_value_admitted")
    .map((entry) => entry.identity);
  assert.deepEqual(admittedMalformed, [
    `producer:${JSON.stringify("tool_slots")}`,
    `producer:${JSON.stringify("x".repeat(65)).slice(0, 32)}`,
  ]);
});

test("a site that drifts permissive is named too", () => {
  // The other direction, and the one a real-family fixture cannot see: a rule widened until it admits anything passes
  // every real family. The malformed set is what catches it, and the finding must still name the site.
  const sites = targetFamilyRules();
  const findings = targetFamilyRuleDrift({
    sites: { ...sites, consumer: () => true },
    ...targetFamilyFixtures(),
    malformed: MALFORMED_TARGET_FAMILIES,
  });

  assert.deepEqual(
    [...new Set(findings.map((entry) => entry.identity.split(":")[0]))],
    ["consumer"],
    "only the widened site may be named",
  );
  assert.equal(findings.length, MALFORMED_TARGET_FAMILIES.length, "every malformed value must be named");
  assert.ok(findings.every((entry) => entry.code === "target_family_malformed_value_admitted"));
});

test("the extracted rules are the ones the sites actually use, not lookalikes", () => {
  // A gate that re-derives a rule can agree with itself while the product uses another - the failure the audit
  // discipline calls a diagnostic that re-implements the logic. Both importable sites are therefore driven end to end
  // through their real entry points: the producer through `parseActionSurface`, the consumer through
  // `validateDescriptorProjection`. The Host's rule stays source-derived, because `protocol.ts` is TypeScript whose
  // specifiers do not resolve from a `.mjs` test; that gap is stated rather than papered over.
  const sites = targetFamilyRules();

  for (const [value, why] of MALFORMED_TARGET_FAMILIES) {
    assert.equal(sites.producer(value), false, why);
    assert.equal(producerAdmitsTargetFamily(value), false, `parseActionSurface admits ${JSON.stringify(value)}`);
    assert.equal(sites.consumer(value), false, why);
    assert.equal(validateDescriptorProjection(descriptorWith({ targetFamily: value })), false);
  }
  assert.equal(producerAdmitsTargetFamily("toolSlots"), true);
  assert.equal(validateDescriptorProjection(descriptorWith({ targetFamily: "toolSlots" })), true);
});

/** The producer's real entry point: one action carrying `targetFamily`, judged by `parseActionSurface`. */
function producerAdmitsTargetFamily(value) {
  const artifact = JSON.parse(sourceOf(ACTION_SURFACE_PATH));
  artifact.actions[0].targetFamily = value;
  try {
    parseActionSurface(JSON.stringify(artifact));
    return true;
  } catch {
    return false;
  }
}
