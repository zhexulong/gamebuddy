#!/usr/bin/env node
// Decision-closure gate for the Stardew Farmhand action surface (rev D, W5 §5.1).
//
// The question this gate answers is narrow and mechanical: can the Agent DECIDE
// what to do from what it can OBSERVE? The record that froze the shape
// (design/domains/stardew/world-interruption-arbitration.md §8.4) explicitly
// rejected a full-AST write/read closure -- it is drowned by engine internals and
// collapses into a hand-maintained whitelist ritual. It keeps exactly three
// assertions, evaluated at Fact Type identity granularity (name + declared kind),
// never by recursive key comparison:
//
//   (a) action-precondition-observable
//       Every declared action argument is of a kind the observation view
//       publishes, so no precondition input exists that the Agent cannot obtain
//       by observing. An argument of an unpublished kind is a hidden input.
//   (b) action-contract-produces-postcondition
//       Every declared write/execution action names a postcondition, so the
//       contract is not a no-op.
//   (c) runtime-fact-on-observation-surface
//       RuntimeFact(a) subset of ObservationKeys: every typed output fact the Mod
//       DECLARES must be registered on the surface the Agent can re-read.
//
// Observation surface (ObservationKeys), enumerated mechanically from
// host/src/protocol.ts:
//   - SNAPSHOT_KEYS            validateSnapshot's whitelist: the Agent's snapshot view
//   - ExecutionReceipt fields  the receipt projection
//   - ActiveExecution fields   the live occupant projection
// A declared fact is readable when the Agent can see it on that surface, OR when it is one of the
// explicitly enumerated ADR-006 BINDING facts a later action consumes. The published action surface is
// deliberately NOT treated as evidence of readability: it is an export of the same declaration, so
// accepting it made this assertion a tautology.
//
// RuntimeFact(a) is taken from the Mod source of truth:
// integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs. The published
// action-surface artifact is the registration the Host consumes. A fact declared in
// the source but absent from the artifact is exactly the decision blind spot this
// gate exists to catch -- the Mod promises a fact the Agent cannot read back -- and
// the reverse (a registered fact nobody declares) is the same drift seen from the
// other side.
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateDescriptorProjection } from "../packages/game-action-program/src/descriptors.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const GATE = "stardew_decision_closure/v1";
export const ASSERTION_PRECONDITION = "action-precondition-observable";
export const ASSERTION_POSTCONDITION = "action-contract-produces-postcondition";
export const ASSERTION_FACT_SURFACE = "runtime-fact-on-observation-surface";

export const PROTOCOL_PATH = "host/src/protocol.ts";
export const MOD_DEFINITIONS_PATH = "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs";
export const ACTION_SURFACE_PATH = "integrations/stardew/action-development/contracts/generated/action-surface.v1.json";

/**
 * The ADR-006 BINDING facts: facts an action declares as output and a LATER action consumes through the
 * action-program binding contract, without them ever appearing in the Agent's snapshot. They are the only
 * facts exempt from the readability check, and they are enumerated here - rather than derived from the
 * declaration - because deriving them is exactly what made the check circular before.
 *
 *  - `arrival`            the destination a completed navigation reached (consumed by the action program)
 *  - `machine_target_id`  the machine an inspection bound (consumed by a later machine operation)
 */
const ADR006_BINDING_FACTS = Object.freeze(new Set(["arrival", "machine_target_id"]));

/** The postcondition a read_only observation action declares; it names no world change. */
const OBSERVATION_POSTCONDITION = "observation_complete";

// ---------------------------------------------------------------------------
// Source slicing helpers (quote-aware, bracket-balanced)
// ---------------------------------------------------------------------------

/** Inner text between the first `open` and its matching `close`, starting at `from`. */
function bracketBody(source, open, close, from = 0) {
  const start = source.indexOf(open, from);
  if (start < 0) return null;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    // Comments outrank quotes. A doc comment's apostrophe ("the holder's PHASE")
    // otherwise opens a phantom string literal that swallows the closing brace,
    // so a balanced type reads as `decision_closure_type_unbalanced`. Skipping
    // comments first is safe: a quote inside one never reaches the quote branch.
    if (char === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index);
      index = newline < 0 ? source.length : newline;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const terminator = source.indexOf("*/", index + 2);
      index = terminator < 0 ? source.length : terminator + 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return source.slice(start + 1, index);
    }
  }
  return null;
}

/** Inner text of `const SNAPSHOT_KEYS = [ ... ] as const;`. */
export function arrayLiteralBody(source, anchor) {
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`decision_closure_anchor_not_found:${anchor}`);
  const body = bracketBody(source, "[", "]", at + anchor.length - 1);
  if (body === null) throw new Error(`decision_closure_array_unbalanced:${anchor}`);
  return body;
}

/**
 * Top-level property names of a `type <name> = Readonly<{ ... }>` declaration.
 *
 * Only the first `{` level is read: a nested `Readonly<{ ... }>` (a target entry,
 * a tile) is one field's typed value, not another field of the projection.
 */
export function projectionFields(source, typeName) {
  const anchor = `type ${typeName} = Readonly<{`;
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`decision_closure_type_not_found:${typeName}`);
  const body = bracketBody(source, "{", "}", at + anchor.length - 1);
  if (body === null) throw new Error(`decision_closure_type_unbalanced:${typeName}`);
  const fields = [];
  let depth = 0;
  let line = "";
  for (const char of `${body}\n`) {
    if (char === "\n" || char === ";") {
      if (depth === 0) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/.exec(line);
        if (match) fields.push(match[1]);
      }
      line = "";
      continue;
    }
    if (char === "{" || char === "(" || char === "[" || char === "<") depth += 1;
    else if (char === "}" || char === ")" || char === "]" || char === ">") depth = Math.max(0, depth - 1);
    line += char;
  }
  return fields;
}

/**
 * The value kinds the Host snapshot view publishes, read off the `Snapshot`
 * declarations themselves: integers (`number`), strings, booleans and nested
 * objects (`Readonly<{...}>` target entries).
 */
function observationValueKinds(protocolSource) {
  const anchor = "export type Snapshot = Readonly<{";
  const at = protocolSource.indexOf(anchor);
  if (at < 0) throw new Error("decision_closure_type_not_found:Snapshot");
  const body = bracketBody(protocolSource, "{", "}", at + anchor.length - 1);
  if (body === null) throw new Error("decision_closure_type_unbalanced:Snapshot");
  const kinds = new Set();
  if (/\bnumber\b/.test(body)) kinds.add("integer");
  if (/\bstring\b/.test(body)) kinds.add("string");
  if (/\bboolean\b/.test(body)) kinds.add("boolean");
  if (/Readonly<\{|\[\]/.test(body)) kinds.add("object");
  // The one observation value that is not a snapshot scalar: a navigation read
  // result publishes `destination` as a label/ref selector the Agent echoes back.
  kinds.add("destination_selector");
  return kinds;
}

/**
 * Typed output facts declared by the Mod registration source.
 *
 * The source writes every non-empty fact map as `["name"] = "kind"`, either in a
 * `new Dictionary<string, string> { ... }` literal or through the `A(facts, ...)`
 * descriptor helper. A flat scan is enough because the fact names are unique across
 * the catalog; a per-action attribution is not needed for a subset check.
 */
function moduleDeclaredFacts(moduleSource) {
  const facts = new Map();
  for (const match of moduleSource.matchAll(/\[\s*"([a-z][a-z0-9_]*)"\s*\]\s*=\s*"([a-z_]+)"/g)) {
    facts.set(match[1], match[2]);
  }
  return facts;
}

/** Typed fact identities the published action surface registers, with their owner. */
function registeredFacts(actions) {
  const facts = new Map();
  const conflicts = [];
  for (const action of actions) {
    for (const [name, kind] of Object.entries(action.outputFacts ?? {})) {
      const previous = facts.get(name);
      if (previous !== undefined && previous.kind !== kind) {
        conflicts.push({ name, kind, declaredBy: previous.actionId, redeclaredBy: action.actionId });
        continue;
      }
      if (previous === undefined) facts.set(name, { kind, actionId: action.actionId });
    }
  }
  return { facts, conflicts };
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

function readSource(relativePath, root, overrides) {
  return overrides[relativePath] ?? readFileSync(path.join(root, relativePath), "utf8");
}

function finding(assertion, identity, code, detail) {
  return { assertion, identity, code, detail };
}

const byIdentity = (left, right) => left.identity.localeCompare(right.identity);

/** ObservationKeys: every key the Host protocol projects into the Agent's view. */
function observationKeySet(protocolSource) {
  return new Set([
    ...arrayLiteralBody(protocolSource, "const SNAPSHOT_KEYS = [")
      .matchAll(/"([^"]+)"/g)
      .map((match) => match[1]),
    ...projectionFields(protocolSource, "ExecutionReceipt"),
    ...projectionFields(protocolSource, "ActiveExecution"),
  ]);
}

/** (a) Every declared argument is of a kind the observation view publishes. */
function assertPreconditions(actions, publishedValueKinds) {
  const findings = [];
  let checked = 0;
  for (const action of actions) {
    for (const [argument, schema] of Object.entries(action.argumentSchema ?? {})) {
      checked += 1;
      const kind = schema?.type;
      if (!publishedValueKinds.has(kind)) {
        findings.push(
          finding(
            ASSERTION_PRECONDITION,
            `${action.actionId}.${argument}`,
            "precondition_hidden_input",
            `argument kind '${kind}' is not a value kind the observation view publishes (${[...publishedValueKinds].sort().join(", ")})`,
          ),
        );
      }
    }
  }
  return { name: ASSERTION_PRECONDITION, checked, findings: findings.sort(byIdentity) };
}

/** (b) Every declared write/execution action names a non-sentinel postcondition. */
function assertPostconditions(actions) {
  const findings = [];
  let checked = 0;
  for (const action of actions) {
    if (action.kind === "read_only") {
      checked += 1;
      if (action.effect !== "read") {
        findings.push(
          finding(
            ASSERTION_POSTCONDITION,
            action.actionId,
            "contract_readonly_declares_write",
            "a read_only observation declares effect 'write'",
          ),
        );
      }
      continue;
    }
    if (action.effect !== "write") continue;
    checked += 1;
    const name = action.postcondition?.name;
    if (typeof name !== "string" || name.length === 0 || name === OBSERVATION_POSTCONDITION) {
      findings.push(
        finding(
          ASSERTION_POSTCONDITION,
          action.actionId,
          "contract_no_postcondition",
          `write action postcondition '${String(name)}' is empty or the read-only observation sentinel`,
        ),
      );
    }
  }
  return { name: ASSERTION_POSTCONDITION, checked, findings: findings.sort(byIdentity) };
}

/** (c) RuntimeFact(a) subset of ObservationKeys, at name+kind Fact Type identity. */
function assertFactSurface({ artifact, surfaceFacts, conflicts, declaredFacts, observationKeys }) {
  const findings = [];
  const push = (identity, code, detail) => findings.push(finding(ASSERTION_FACT_SURFACE, identity, code, detail));

  if (!validateDescriptorProjection(artifact)) {
    push(
      ACTION_SURFACE_PATH,
      "action_surface_not_parseable_by_host_protocol",
      "the published action surface is not parseable by the Host descriptor whitelist",
    );
  }
  for (const conflict of conflicts) {
    push(
      conflict.name,
      "registered_fact_kind_conflict",
      `'${conflict.name}' is registered as '${conflict.kind}' by ${conflict.declaredBy} and redeclared by ${conflict.redeclaredBy}`,
    );
  }
  for (const [name, kind] of sortedEntries(declaredFacts)) {
    // A declared fact is readable when the Agent can SEE it, or when a later action consumes it as an ADR-006
    // binding fact. The published surface is deliberately NOT accepted as evidence of readability: it is an
    // export of this very declaration, so accepting it would make this loop a tautology (which is what an
    // independent review found and reproduced, and why the earlier version could not go red for a fact nobody
    // could read).
    if (observationKeys.has(name) || ADR006_BINDING_FACTS.has(name)) continue;
    push(
      name,
      "runtime_fact_not_readable",
      `the Mod declares RuntimeFact '${name}:${kind}' and nothing can read it: no snapshot/receipt/active-execution key projects it, and it is not an ADR-006 binding fact`,
    );
  }
  // Drift between the declaration and its published registration is a DIFFERENT failure (a stale artifact), and
  // it is reported as such rather than being allowed to satisfy the check above.
  for (const [name, kind] of sortedEntries(declaredFacts)) {
    const registered = surfaceFacts.get(name);
    if (registered !== undefined && registered.kind !== kind) {
      push(
        name,
        "runtime_fact_kind_mismatch",
        `the Mod declares '${name}:${kind}' but ${registered.actionId} registers it as '${registered.kind}'`,
      );
    } else if (registered === undefined) {
      push(
        name,
        "declared_fact_not_registered_on_surface",
        `the Mod declares RuntimeFact '${name}:${kind}' but the published action surface does not register it (stale artifact?)`,
      );
    }
  }
  for (const [name, registered] of sortedEntries(surfaceFacts)) {
    if (observationKeys.has(name) || declaredFacts.has(name)) continue;
    push(
      name,
      "observation_surface_fact_not_declared",
      `${registered.actionId} registers RuntimeFact '${name}:${registered.kind}' but the Mod declares no such fact`,
    );
  }
  return { name: ASSERTION_FACT_SURFACE, checked: declaredFacts.size, findings: findings.sort(byIdentity) };
}

function sortedEntries(map) {
  return [...map].sort(([left], [right]) => left.localeCompare(right));
}

/**
 * @param {{ root?: string, overrides?: Record<string, string> }} options
 */
export function auditStardewDecisionClosure({ root = REPOSITORY_ROOT, overrides = {} } = {}) {
  const protocolSource = readSource(PROTOCOL_PATH, root, overrides);
  const moduleSource = readSource(MOD_DEFINITIONS_PATH, root, overrides);
  const artifactSource = readSource(ACTION_SURFACE_PATH, root, overrides);
  const artifact = JSON.parse(artifactSource);
  const actions = Array.isArray(artifact.actions) ? artifact.actions : [];

  const observationKeys = observationKeySet(protocolSource);
  const publishedValueKinds = observationValueKinds(protocolSource);
  const { facts: surfaceFacts, conflicts } = registeredFacts(actions);
  const declaredFacts = moduleDeclaredFacts(moduleSource);

  const assertions = [
    assertPreconditions(actions, publishedValueKinds),
    assertPostconditions(actions),
    assertFactSurface({ artifact, surfaceFacts, conflicts, declaredFacts, observationKeys }),
  ];
  const findings = assertions.flatMap((assertion) => assertion.findings);

  return Object.freeze({
    gate: GATE,
    verdict: findings.length === 0 ? "passed" : "blocked",
    observationSurface: Object.freeze({
      snapshotKeys: Object.freeze([...observationKeys].sort()),
      publishedValueKinds: Object.freeze([...publishedValueKinds].sort()),
      registeredFacts: Object.freeze(
        sortedEntries(surfaceFacts).map(([name, registered]) =>
          Object.freeze({ name, kind: registered.kind, actionId: registered.actionId }),
        ),
      ),
    }),
    declaredRuntimeFacts: Object.freeze(
      sortedEntries(declaredFacts).map(([name, kind]) => Object.freeze({ name, kind })),
    ),
    assertions: Object.freeze(assertions.map(Object.freeze)),
    findings: Object.freeze(findings),
  });
}

function main() {
  let report;
  try {
    report = auditStardewDecisionClosure();
  } catch (error) {
    process.stderr.write(`decision closure audit failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.verdict === "passed" ? 0 : 1;
  }

  console.log(`gate: ${report.gate}`);
  console.log(`observation keys: ${report.observationSurface.snapshotKeys.length}`);
  console.log(
    `declared RuntimeFacts: ${report.declaredRuntimeFacts.map((fact) => `${fact.name}:${fact.kind}`).join(", ") || "(none)"}`,
  );
  for (const assertion of report.assertions) {
    console.log(`  [${assertion.name}] checked=${assertion.checked} findings=${assertion.findings.length}`);
  }
  if (report.verdict === "passed") {
    console.log("decision closure: ok");
    return 0;
  }
  console.log(`decision closure: ${report.findings.length} finding(s)`);
  for (const entry of report.findings) {
    console.log(`  [${entry.assertion}] ${entry.identity}: ${entry.code} - ${entry.detail}`);
  }
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
