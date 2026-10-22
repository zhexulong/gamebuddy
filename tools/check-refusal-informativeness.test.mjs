/**
 * Falsifiers for the refusal-informativeness gate.
 *
 * An unproven gate is decoration: a check nobody can make fail has not been shown to check anything.
 * Every test below fails the gate ON PURPOSE, on the REAL shipped source, by replacing one fact with
 * the shape that cost a live run to discover - a bare reason code, a dropped action id, a
 * precondition that names no values, a refusal that teaches nothing. Each test names the exact
 * file:line the gate has to point at.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkRefusalInformativeness,
  classifyReasonCode,
  extractModReceiptSites,
  GATE,
  namesSurfaceArgument,
  REFUSAL_CLASSES,
  readActionSurface,
  renderReport,
  SOURCES,
  toSnakeCase,
} from "./check-refusal-informativeness.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = fileURLToPath(new URL("check-refusal-informativeness.mjs", import.meta.url));

const read = (relativePath) => readFileSync(path.join(REPOSITORY_ROOT, relativePath), "utf8");
const run = (overrides) => checkRefusalInformativeness({ overrides });
const findingsOf = (report, id) => report.findings.filter((item) => item.id === id);

/** The first line of a file that contains `needle`, 1-based. */
function lineOf(source, needle) {
  const index = source.split("\n").findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`no line contains: ${needle}`);
  return index + 1;
}

/** Replace text on exactly one line, so the gate's file:line subjects stay comparable. */
function mutateLine(relativePath, line, transform) {
  const lines = read(relativePath).split("\n");
  const before = lines[line - 1];
  const after = transform(before);
  assert.notEqual(after, before, `mutation at ${relativePath}:${line} changed nothing`);
  assert.equal(after.includes("\n"), false, "a mutation must stay on one line");
  lines[line - 1] = after;
  return lines.join("\n");
}

test("the published surface is enumerated from the artifact, not hand-listed", () => {
  const actions = readActionSurface(read(SOURCES.surface));
  assert.equal(actions.length, 95);
  const toolActions = actions.filter((action) => action.toolCategory !== null);
  assert.deepEqual(toolActions.map((action) => `${action.actionId}:${action.toolCategory}`).sort(), [
    "break_rock_source:pickaxe",
    "cut_grass:scythe",
    "cut_weeds:scythe",
    "water_crop:watering_can",
  ]);
  // Every tool claim carries the upgrade word a tool refusal needs to say which tool satisfies it.
  assert.equal(
    toolActions.every(
      (action) => action.toolUpgradeRequirement === "AnyUpgrade" || action.toolUpgradeRequirement === "BasicOnly",
    ),
    true,
  );
  assert.equal(actions.filter((action) => action.targetBound).length, 70);
});

test("a reason code is a closed family, not a free-form string", () => {
  assert.equal(classifyReasonCode("basic_pickaxe_not_equipped_in_requested_slot"), "tool");
  assert.equal(classifyReasonCode("watering_can_not_equipped"), "tool");
  assert.equal(classifyReasonCode("weed_target_changed"), "target");
  assert.equal(classifyReasonCode("unknown_action:cut_weeds"), "program");
  assert.equal(classifyReasonCode("missing_expected_target_id"), "argument");
  assert.equal(classifyReasonCode("body_owned_by_navigation"), "body");
  assert.equal(classifyReasonCode("actor_held_by_modal"), "body");
  assert.equal(classifyReasonCode("world_not_ready"), "state");
  // The shapes a caller cannot act on at all: prose, CamelCase, an empty string.
  assert.equal(classifyReasonCode("The pickaxe was wrong"), null);
  assert.equal(classifyReasonCode("InvalidToolSelector"), null);
  assert.equal(classifyReasonCode(""), null);
});

test("an argument refusal that names the surface argument is informative without evidence", () => {
  const argumentNames = new Set(
    ["expectedTargetId", "expectedQualifiedItemId", "colorSelection", "slot", "x"].map(toSnakeCase),
  );
  assert.equal(namesSurfaceArgument("missing_expected_target_id", argumentNames), true);
  assert.equal(namesSurfaceArgument("invalid_color_selection", argumentNames), true);
  // The tool selector is not an argument any action names, so the refusal has to carry the fact.
  assert.equal(namesSurfaceArgument("invalid_tool_selector", argumentNames), false);
});

test("the matrix covers every published action against every class", () => {
  const report = checkRefusalInformativeness();
  assert.equal(report.gate, GATE);
  assert.equal(report.matrix.length, report.counts.actions);
  const classIds = REFUSAL_CLASSES.map((entry) => entry.id).sort();
  for (const row of report.matrix) {
    assert.deepEqual(Object.keys(row.cells).sort(), classIds, `row ${row.actionId} is missing a class`);
    for (const cell of Object.values(row.cells))
      assert.equal(
        ["informative", "not_informative", "n/a"].includes(cell),
        true,
        `row ${row.actionId} has cell ${cell}`,
      );
  }
  // Tool and target classes only reach the actions the surface says they reach.
  for (const row of report.matrix) {
    if (row.cells.tool === "n/a") assert.equal(row.toolCategory, null);
    if (row.cells.target === "n/a") assert.equal(row.targetBound, false);
  }
  assert.equal(report.summary.cells, report.summary.informative + report.summary.notInformative);
});

test("every reason family the tree emits is classified, and the verdict follows the findings", () => {
  const report = checkRefusalInformativeness();
  assert.equal(
    report.vocabulary.every((entry) => entry.class !== null),
    true,
    "an unclassified family cannot be judged",
  );
  assert.equal(report.vocabulary.length > 200, true, "the vocabulary is read from source, not declared");
  assert.equal(report.verdict, report.findings.length === 0 && report.unattributed.length === 0 ? "passed" : "blocked");
});

test("every receipt finding points at a real site that really carries the code", () => {
  const report = checkRefusalInformativeness();
  const receiptFindings = findingsOf(report, "receipt_fact_missing");
  assert.equal(receiptFindings.length > 0, true);
  for (const item of receiptFindings) {
    const at = item.subject.lastIndexOf(":");
    const relativePath = item.subject.slice(0, at);
    const line = Number(item.subject.slice(at + 1));
    assert.equal(existsSync(path.join(REPOSITORY_ROOT, relativePath)), true, `${relativePath} does not exist`);
    const source = readFileSync(path.join(REPOSITORY_ROOT, relativePath), "utf8").split("\n");
    const nearby = source.slice(Math.max(0, line - 3), line + 2).join("\n");
    const code = /^(\w+) is a /u.exec(item.detail)?.[1];
    assert.equal(code !== undefined && nearby.includes(`"${code}"`), true, `${item.subject} does not carry ${code}`);
    assert.equal(nearby.includes("null"), true, `${item.subject} does carry evidence after all`);
  }
});

test("FALSIFIER: an informative tool refusal replaced by a bare `null` is named at its own line", () => {
  const relativePath = "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs";
  const source = read(relativePath);
  const line = lineOf(source, '"basic_pickaxe_not_equipped_in_requested_slot", $"slot={slot}");');
  const baseline = findingsOf(checkRefusalInformativeness(), "receipt_fact_missing").length;
  const mutated = mutateLine(relativePath, line, (text) => text.replace('$"slot={slot}"', "null"));

  const report = run({ [relativePath]: mutated });
  const finding = findingsOf(report, "receipt_fact_missing").find((item) => item.subject === `${relativePath}:${line}`);
  assert.notEqual(finding, undefined, `the gate did not name ${relativePath}:${line}`);
  assert.match(finding.detail, /basic_pickaxe_not_equipped_in_requested_slot is a tool refusal with no evidence/u);
  assert.equal(findingsOf(report, "receipt_fact_missing").length, baseline + 1);
  // Restoring the fact restores the baseline: the gate is about the refusal, not about the file.
  assert.equal(findingsOf(checkRefusalInformativeness(), "receipt_fact_missing").length, baseline);
});

test("FALSIFIER: a bare prose reason code in the Mod source is a free-form finding", () => {
  const relativePath = "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs";
  const source = read(relativePath);
  const line = lineOf(source, '"basic_pickaxe_not_equipped_in_requested_slot", $"slot={slot}");');
  const mutated = mutateLine(relativePath, line, (text) =>
    text.replace('"basic_pickaxe_not_equipped_in_requested_slot"', '"the pickaxe was wrong"'),
  );

  const report = run({ [relativePath]: mutated });
  const finding = findingsOf(report, "free_form_reason_code").find((item) => item.subject === "the pickaxe was wrong");
  assert.notEqual(finding, undefined, "a sentence in a reason-code position must be flagged");
  // The prose code is unclassifiable, so the matrix cannot claim any class is informative.
  assert.equal(
    report.matrix.every((row) => Object.values(row.cells).includes("not_informative")),
    true,
  );
});

test("FALSIFIER: a refusal that loses its action id is flagged at the projection seam", () => {
  const source = read(SOURCES.bridgeSession);
  const mutated = source.replace("actionId ?? receipt.ActionId ?? binding?.ActionId", "actionId");
  assert.notEqual(mutated, source, "the action id fallback was not found");

  const report = run({ [SOURCES.bridgeSession]: mutated });
  const finding = findingsOf(report, "action_id_projection")[0];
  assert.notEqual(finding, undefined, "a receipt that cannot name its action must be flagged");
  assert.equal(finding.subject, SOURCES.bridgeSession);
});

test("FALSIFIER: a program diagnostic that loses its expected/actual pair is flagged at its site", () => {
  const source = read(SOURCES.programAuthority);
  const line = lineOf(source, 'Error("invalid_node", node?.NodeId, path,');
  const mutated = mutateLine(SOURCES.programAuthority, line, (text) =>
    text.replace(
      /Error\("invalid_node", node\?\.NodeId, path,[^;]*?\);$/u,
      'Error("invalid_node", node?.NodeId, path);',
    ),
  );

  const report = run({ [SOURCES.programAuthority]: mutated });
  const finding = findingsOf(report, "program_value_pair_missing").find(
    (item) => item.subject === `${SOURCES.programAuthority}:${line}`,
  );
  assert.notEqual(finding, undefined, `the gate did not name ${SOURCES.programAuthority}:${line}`);
  assert.match(finding.detail, /invalid_node/u);
});

test("FALSIFIER: a plan argument refusal that loses its requirement teaches nothing", () => {
  const source = read(SOURCES.planScript);
  const line = lineOf(source, "plan_script_missing_argument:");
  const mutated = mutateLine(SOURCES.planScript, line, (text) => text.replace(", state, requirement);", ", state);"));
  assert.match(mutated, /plan_script_missing_argument/u);

  const report = run({ [SOURCES.planScript]: mutated });
  const finding = findingsOf(report, "plan_remediation_missing").find(
    (item) => item.subject === `${SOURCES.planScript}:${line}`,
  );
  assert.notEqual(finding, undefined, `the gate did not name ${SOURCES.planScript}:${line}`);
  assert.match(finding.detail, /plan_script_missing_argument/u);
});

test("FALSIFIER: a hold with no remedy case and no prefix fallback is flagged", () => {
  const holdSite = [
    "internal sealed class Probe",
    "{",
    "    public void Run(string requestId, string executionId)",
    "    {",
    '        this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned_by_teleport", $"owner=teleport");',
    "    }",
    "}",
  ].join("\n");
  const modSources = { "integrations/stardew/probe.cs": holdSite };

  // The named `body_owned_` prefix is the fallback that already answers an unlisted hold, so a new
  // hold name is covered the day the Mod starts naming it.
  const covered = checkRefusalInformativeness({ modSources });
  assert.equal(findingsOf(covered, "body_remediation_missing").length, 0);

  const remedySource = read(SOURCES.remedy);
  assert.match(remedySource, /startsWith\("body_owned_"\)/u);
  const mutated = remedySource.replace('startsWith("body_owned_")', 'startsWith("body_owns_")');
  const report = checkRefusalInformativeness({ modSources, overrides: { [SOURCES.remedy]: mutated } });
  const finding = findingsOf(report, "body_remediation_missing").find(
    (item) => item.subject === "body_owned_by_teleport",
  );
  assert.notEqual(finding, undefined, "a hold the remedy table no longer answers must be flagged");
});

test("the resolver reports what it cannot follow instead of guessing", () => {
  const synthetic = [
    "internal sealed class Probe",
    "{",
    "    public void Run(object resolution, string requestId, string executionId)",
    "    {",
    "        this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, null);",
    "    }",
    "}",
  ].join("\n");
  const { sites, unattributed } = extractModReceiptSites({ "probe.cs": synthetic });
  assert.equal(sites.length, 0);
  assert.equal(unattributed.length, 1);
  assert.equal(unattributed[0].expression, "resolution . ReasonCode");
});

test("the CLI is the gate: non-zero while a finding exists, and it prints the matrix", () => {
  const result = spawnSync(process.execPath, [CLI_PATH], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  const report = checkRefusalInformativeness();
  assert.equal(result.status, report.verdict === "passed" ? 0 : 1);
  const printed = result.stdout.split("\n");
  assert.equal(printed[0], renderReport(report).split("\n")[0]);
  assert.match(result.stdout, /action x class/u);
  assert.match(result.stdout, /cells informative=\d+ not_informative=\d+/u);
  assert.equal(
    printed.some((line) => line.startsWith("findings=")),
    report.findings.length > 0,
  );
});
