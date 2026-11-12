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
  BARE_REFUSALS_WITH_NOTHING_TO_SAY,
  checkBareRefusals,
  checkRefusalInformativeness,
  classifyReasonCode,
  declaredTargetKind,
  extractModReceiptSites,
  GATE,
  namesSurfaceArgument,
  priceRefusalSites,
  REFUSAL_CLASSES,
  readActionSurface,
  renderReport,
  SOURCES,
  TARGET_KINDS,
  targetKindOf,
  toSnakeCase,
} from "./check-refusal-informativeness.mjs";
import { cleanOutputLines } from "./lib/subprocess-output.mjs";

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

// ---------------------------------------------------------------------------
// The price comparison: one side of a comparison is half a refusal.
// ---------------------------------------------------------------------------

const SHOP_ACTIONS = "integrations/stardew/farmhandexecutioncontroller.shopactions.cs";
const MOVEMENT_ACTIONS = "integrations/stardew/farmhandexecutioncontroller.movementactions.cs";

/** A reported `path:line` subject must point at a real line of the file it names. */
function assertSubjectPointsAt(source, subject, needle) {
  const at = subject.lastIndexOf(":");
  const line = Number(subject.slice(at + 1));
  assert.equal(Number.isInteger(line), true, `subject carries no line: ${subject}`);
  assert.match(source.split("\n")[line - 1] ?? "", new RegExp(needle, "u"), `${subject} does not point at ${needle}`);
}

test("every shipped refusal that names a price names the balance beside it", () => {
  const report = checkRefusalInformativeness();
  assert.equal(report.counts.priceRefusals >= 2, true, "the price-refusal population is too small to have measured");
  assert.deepEqual(findingsOf(report, "price_comparison_missing"), []);

  // The shop's own affordability refusal is IN the population by name. Its evidence is rendered by a
  // member, so this also proves the gate's one-hop follow: without it the population would hold the
  // minecart fare alone and the site the check was written for would be invisible.
  const { sites } = extractModReceiptSites({ [SHOP_ACTIONS]: read(SHOP_ACTIONS) });
  const priced = priceRefusalSites(sites);
  assert.equal(priced.length, 1, "shop_purchase's insufficient_money refusal must be a price refusal");
  assert.equal(priced[0].code, "insufficient_money");
  assert.match(priced[0].evidence.expanded, /;currency=\{ShopCurrencyName\(shopCurrency\)\}/u);
  assert.match(priced[0].evidence.expanded, /;held=\{currencyHeld\}/u);
});

test("FALSIFIER: a price refusal that drops the balance is named at its file:line and token", () => {
  const source = read(SHOP_ACTIONS);
  const line = lineOf(source, ";held={currencyHeld}");
  const mutated = mutateLine(SHOP_ACTIONS, line, (text) => text.replace(";held={currencyHeld}", ""));

  const report = run({ [SHOP_ACTIONS]: mutated });
  const finding = findingsOf(report, "price_comparison_missing").find((item) => item.detail.includes("held="));
  assert.notEqual(finding, undefined, "a price refusal without the balance must be flagged");
  assert.match(finding.detail, /insufficient_money/u, "the finding must name the reason code");
  assertSubjectPointsAt(source, finding.subject, "ExecutionState\\.Rejected");
});

test("FALSIFIER: a fare refusal that drops the currency names one side of its comparison", () => {
  const source = read(MOVEMENT_ACTIONS);
  const line = lineOf(source, ";price={destination.Price};currency=money;held=");
  const mutated = mutateLine(MOVEMENT_ACTIONS, line, (text) => text.replace(";currency=money", ""));

  const report = run({ [MOVEMENT_ACTIONS]: mutated });
  const finding = findingsOf(report, "price_comparison_missing").find(
    (item) => item.subject.startsWith(`${MOVEMENT_ACTIONS}:`) && item.detail.includes("currency="),
  );
  assert.notEqual(finding, undefined, "a price with no currency must be flagged");
  assert.match(finding.detail, /minecart_ticket_unaffordable/u);
  assertSubjectPointsAt(source, finding.subject, "ExecutionState\\.Rejected");
});

test("FALSIFIER: a tree with no price refusal blocks the check instead of passing it", () => {
  const synthetic = [
    "internal sealed class Probe",
    "{",
    "    public void Run(string requestId, string executionId)",
    "    {",
    '        this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned_by_teleport", $"owner=teleport");',
    "    }",
    "}",
  ].join("\n");
  const report = checkRefusalInformativeness({ modSources: { "integrations/stardew/probe.cs": synthetic } });
  assert.equal(report.counts.priceRefusals, 0);
  const finding = findingsOf(report, "price_refusal_population_empty")[0];
  assert.notEqual(finding, undefined, "zero population must be blocked and named, never a pass");
  assert.equal(report.verdict, "blocked");
});

test("the one-hop follow reads a helper's own literals and invents nothing for an unrelated one", () => {
  const synthetic = [
    "internal sealed class Probe",
    "{",
    "    internal static string Priced(string shop)",
    "    {",
    '        return $"shop={shop};price=80;currency=money;held=20";',
    "    }",
    "",
    "    internal static string Unpriced(string tile)",
    "    {",
    '        return $"tile={tile}";',
    "    }",
    "",
    "    public void Run(string requestId, string executionId, string shop, string tile)",
    "    {",
    '        this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_sold_here", Priced(shop));',
    '        this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned_by_teleport", Unpriced(tile));',
    "    }",
    "}",
  ].join("\n");
  const { sites } = extractModReceiptSites({ "integrations/stardew/probe.cs": synthetic });
  const priced = priceRefusalSites(sites);
  assert.equal(priced.length, 1, "only the refusal whose helper states a price is a price refusal");
  assert.equal(priced[0].code, "item_not_sold_here");
});

test("the CLI is the gate: non-zero while a finding exists, and it prints the matrix", () => {
  const result = spawnSync(process.execPath, [CLI_PATH], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  const report = checkRefusalInformativeness();
  assert.equal(result.status, report.verdict === "passed" ? 0 : 1);
  const printed = cleanOutputLines(result.stdout);
  assert.equal(printed[0], renderReport(report).split("\n")[0]);
  assert.match(result.stdout, /action x class/u);
  assert.match(result.stdout, /cells informative=\d+ not_informative=\d+/u);
  assert.equal(
    printed.some((line) => line.startsWith("findings=")),
    report.findings.length > 0,
  );
});

test("the bare-refusal population is the whole Mod, and every bare site is accounted for", () => {
  // The population is derived by the same walk the rest of the gate uses, so there is no second list to keep in step.
  const report = checkRefusalInformativeness();
  assert.equal(report.counts.bareRefusals > 0, true, "zero bare refusals means the derivation stopped matching");
  assert.equal(
    report.counts.bareRefusals,
    report.counts.bareAllowed + report.counts.bareUnaccounted,
    "every bare site is either published or exempted",
  );
  assert.equal(report.counts.bareUnaccounted, 0, JSON.stringify(report.bareUnaccounted));
  // An exemption without a reason is a blanket permission, which is what this list exists to prevent.
  for (const entry of report.bareAllowed) {
    assert.equal(typeof entry.why, "string");
    assert.equal(entry.why.length > 40, true, `${entry.code} needs a reason a reader can act on`);
    assert.equal(entry.sites > 0, true, `${entry.code} is listed with no site`);
  }
});

test("FALSIFIER: a refusal that read the location and refused with null is named at its own line", () => {
  // The shipped shape this class is named for: `ship_item` tested the actor's location and then answered
  // `farm_required` with no evidence, while the NEXT line names that same location.
  const relativePath = "integrations/stardew/farmhandexecutioncontroller.shippingactions.cs";
  const source = read(relativePath);
  const published = '"farm_required",\n                $"location=';
  assert.equal(source.includes(published), true, "the shipped site must publish the location it tested");
  const mutated = source.replace(published, '"farm_required", null); // $"location=');
  assert.notEqual(mutated, source);

  const report = run({ [relativePath]: mutated });
  const findings = findingsOf(report, "refusal_drops_a_fact_it_read");
  assert.equal(findings.length, 1, "the one de-published site is the one finding");
  assert.match(findings[0].subject, new RegExp(`^${relativePath}:\\d+:farm_required$`, "u"));
  assert.equal(report.counts.bareUnaccounted, 1);
  // And the same site, restored, is the baseline again: the gate is about the fact, not about the file.
  assert.equal(findingsOf(checkRefusalInformativeness(), "refusal_drops_a_fact_it_read").length, 0);
});

test("the located-refusal rule examines a real population and nothing in the shipped tree is a bare echo", () => {
  // Population, printed: the tile-kind verdict sites the gate can read whole. Zero would mean the derivation stopped
  // matching, so it is asserted rather than assumed.
  const report = checkRefusalInformativeness();
  assert.equal(
    report.located.examined > 0,
    true,
    `no tile-kind verdict refusal was read, so the position rule examined nothing: ${JSON.stringify(report.located)}`,
  );
  assert.equal(
    report.located.observationShaped > 0,
    true,
    "and the observation-shaped class is a real exemption, not a guess",
  );
  assert.deepEqual(findingsOf(report, "refusal_names_nothing_actionable"), []);
  assert.deepEqual(findingsOf(report, "refusal_target_kind_undeclared"), []);
  // The kinds are the declaration's own vocabulary: a target-class family answers one of the four, never a fifth word.
  const declared = new Set(TARGET_KINDS.map((entry) => entry.id));
  for (const kind of Object.keys(report.located.kinds))
    assert.equal(declared.has(kind), true, `undeclared kind ${kind}`);
});

test("FALSIFIER: the measured soil verdict - evidence that repeats only the tile - is named at its own site", () => {
  // The defect this rule exists for, replayed on the REAL line: `soil_not_diggable` used to answer `target=13,10`, the
  // tile the companion had just named, and 27 live refusals followed from that one missing half (run A6).
  const relativePath = "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs";
  const source = read(relativePath);
  const published = "{DescribeSoilGuidance(distantLocation, targetX, targetY)}";
  assert.equal(source.includes(published), true, "the shipped site must publish where farmable ground is");
  const mutated = source.replace(published, "");
  assert.notEqual(mutated, source);

  const findings = findingsOf(run({ [relativePath]: mutated }), "refusal_names_nothing_actionable");
  assert.equal(findings.length, 1, "the one de-published site is the one finding");
  assert.match(findings[0].subject, new RegExp(`^soil_not_diggable:${relativePath}:\\d+$`, "u"));
  assert.match(findings[0].detail, /repeats only the tile the caller named/u);
  // And the same site, restored, is the baseline again: the rule is about the fact, not about the file.
  assert.deepEqual(findingsOf(checkRefusalInformativeness(), "refusal_names_nothing_actionable"), []);
});

test("FALSIFIER: a range verdict that loses where the actor stands is named at its own line", () => {
  const relativePath = "integrations/stardew/farmhandexecutioncontroller.gatheringactions.cs";
  const source = read(relativePath);
  const published = ";actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};reach=1";
  assert.equal(source.includes(published), true, "the shipped site must say where the actor is");
  const mutated = source.replace(published, "");
  assert.notEqual(mutated, source);

  const findings = findingsOf(run({ [relativePath]: mutated }), "refusal_names_nothing_actionable");
  assert.equal(findings.length, 1, "the one de-published site is the one finding");
  assert.match(findings[0].subject, new RegExp(`^forage_target_out_of_range:${relativePath}:\\d+$`, "u"));
});

test("a family whose target kind is undeclared is a finding, not a default", () => {
  // The taxonomy has to stay total: a target-class family whose words name no declared kind gets an answer demanded,
  // rather than falling silently into the kind that happens to have no rule attached.
  assert.equal(targetKindOf("soil_not_diggable"), "tile");
  assert.equal(targetKindOf("pet_target_gone"), "entity");
  assert.equal(targetKindOf("mine_elevator_out_of_service"), "destination");
  assert.equal(targetKindOf("world_not_ready"), "none");
  // A target-class code whose words the matchers cannot place is the case this finding exists for: `location_changed` is a
  // target by the class matcher and names no kind at all.
  assert.equal(classifyReasonCode("location_changed"), "target");
  assert.equal(declaredTargetKind("location_changed"), null);
  const relativePath = "integrations/stardew/farmhandexecutioncontroller.facilityactions.cs";
  const source = read(relativePath);
  const line = lineOf(source, '"cask_target_changed", $"target={targetX},{targetY}"');
  const mutated = mutateLine(relativePath, line, (text) => text.replace('"cask_target_changed"', '"location_changed"'));
  const report = run({ [relativePath]: mutated });
  const findings = findingsOf(report, "refusal_target_kind_undeclared");
  assert.equal(findings.length, 1, JSON.stringify(report.findings.map((item) => item.id)));
  assert.equal(findings[0].subject, "location_changed");
});

test("FALSIFIER: an exemption with no bare site left expires instead of granting blanket permission", () => {
  // A tree with no bare sites at all: every entry is stale, so every entry must be named. This is the direction a
  // ratchet usually gets wrong - the list keeps passing because the thing it excused is gone.
  const empty = checkBareRefusals({ sites: [], unattributed: [] });
  assert.equal(empty.findings.length, BARE_REFUSALS_WITH_NOTHING_TO_SAY.length);
  assert.equal(
    empty.findings.every((item) => item.id === "refusal_allow_list_entry_expired"),
    true,
  );
  assert.deepEqual(
    empty.findings.map((item) => item.subject).sort(),
    BARE_REFUSALS_WITH_NOTHING_TO_SAY.map((entry) => entry.code).sort(),
  );

  // And one code that IS the fact stays quiet while the rest expire, so the list is a classification, not a veto.
  const site = (path, line, code) => ({ path, line, code, codeExpression: code, evidence: { kind: "absent" } });
  const oneHonest = checkBareRefusals({ sites: [site("a.cs", 1, "world_not_ready")], unattributed: [] });
  assert.equal(
    oneHonest.findings.some((item) => item.subject === "world_not_ready"),
    false,
    "a code whose words ARE the fact is not a finding",
  );
  assert.equal(oneHonest.counts.allowed, 1);

  // A code that reads a value is a finding wherever it sits, and the failure names file:line:code.
  const dropped = checkBareRefusals({ sites: [site("b.cs", 7, "farm_required")], unattributed: [] });
  assert.deepEqual(
    dropped.findings.filter((item) => item.id === "refusal_drops_a_fact_it_read").map((item) => item.subject),
    ["b.cs:7:farm_required"],
  );
  assert.deepEqual(dropped.unaccounted, [{ path: "b.cs", line: 7, code: "farm_required" }]);
});

test("an unattributed receipt site is judged on its evidence like any other", () => {
  // The resolver stops at codes it cannot follow, and those sites used to be judged by nothing at all: a bare
  // `null` behind an unresolvable carrier was invisible. An unattributed `null` must still be a finding.
  const report = checkBareRefusals({
    sites: [],
    unattributed: [
      { path: "c.cs", line: 3, expression: "mysteryCode", codeExpression: "mysteryCode", evidence: { kind: "absent" } },
    ],
  });
  assert.deepEqual(
    report.findings.filter((item) => item.id === "refusal_drops_a_fact_it_read").map((item) => item.subject),
    ["c.cs:3:mysteryCode"],
  );
});
