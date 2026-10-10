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
  auditStardewDecisionClosure,
} from "./audit-stardew-decision-closure.mjs";

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
  assert.deepEqual(findings.filter((entry) => entry.code === "declared_fact_not_registered_on_surface"), []);
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
