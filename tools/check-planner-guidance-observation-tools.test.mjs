/**
 * The falsifier suite for `tools/check-planner-guidance-observation-tools.mjs`.
 *
 * Every case is an INJECTION into a copy of the real source, because the defect this gate exists for is a sentence
 * missing from a text, and a text that is present in this tree cannot be made absent by describing it. The population
 * cases inject a tool the tree does not have, which is the whole claim: the set is the declaration's, so a tool nobody
 * has written yet arrives red instead of arriving invisible.
 *
 * red-proof: inject  the rectangle sentence deleted from the planner's text -> `examined 8 named 1 reason 6`,
 *   `planner_guidance_omits_tool:stardew_observe` beside nothing else, failed, asserted by "the guidance before the
 *   rectangle sentence is red on stardew_observe" - that sentence is the only place a planning turn learns a shape is
 *   one rectangle the observation tool still answers
 * red-proof: inject  only `stardew_look_up`'s name removed -> that tool alone is named, so a finding points at the tool
 *   that went missing and not at the sentence it sat in
 * red-proof: inject  a ninth `defineTool` added to the producer -> `planner_guidance_omits_tool:stardew_inspect_crops`
 *   over `examined 9`, so the population is the declaration's and covers tools nobody has written yet
 * red-proof: inject  `blankCommentText` made the identity in the gate -> two cases fail: a comment inside
 *   `planWorkDescription` counting as a mention, and a `name:` key inside a producer comment becoming a tool
 * red-proof: inject  `observationToolNames` returning before it walks the producer -> 10 of 13 cases fail, so the derived
 *   population is load-bearing rather than decorative
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkPlannerGuidanceObservationTools,
  modelVisibleLiterals,
  numericConstants,
  observationToolNames,
  PLANNER_NEED_NOT_MENTION,
  planNodeLimitReading,
  plannerGuidanceText,
  quotedLimit,
  REASON_CLASSES,
  RULES,
  renderReport,
} from "./check-planner-guidance-observation-tools.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUIDANCE_PATH = "host/src/body-program-script.ts";
const PRODUCER_PATH = "host/src/game-tools.ts";
const ADAPTER_PATH = "host/src/stardew-game-integration-adapter.ts";

const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
const GUIDANCE = read(GUIDANCE_PATH);
const PRODUCER = read(PRODUCER_PATH);

const codes = (result) => result.findings.map((finding) => `${finding.code}:${finding.member}`).sort();
const check = (overrides, reasons) =>
  checkPlannerGuidanceObservationTools({
    overrides,
    ...(reasons === undefined ? {} : { reasons }),
  });
/** The report's JSON line, parsed, so a case reads the verdict the harness reads. */
const reportOf = (result) => JSON.parse(renderReport(result).lines.at(-1));
/** The rule ids the report calls out, in report order. */
const rulesOf = (report, status) => report.checks.filter((entry) => entry.status === status).map((entry) => entry.id);

/** The opening words of the rectangle sentence, so the red proofs read the tree instead of quoting it. */
const RECTANGLE_LINE_START = "A SHAPE - a 3-wide";
const NEXT_SENTENCE = "One call the compiler refuses";

/** The guidance exactly as it read before the rectangle sentence existed, derived from the text itself. */
function guidanceBeforeRectangleLine() {
  const start = GUIDANCE.indexOf(RECTANGLE_LINE_START);
  assert.notEqual(
    start,
    -1,
    `the planner's text no longer opens a sentence with "${RECTANGLE_LINE_START}", so this suite cannot reproduce the ` +
      "reading the sentence was added to fix",
  );
  const end = GUIDANCE.indexOf(NEXT_SENTENCE, start);
  assert.notEqual(end, -1, `the planner's text no longer contains "${NEXT_SENTENCE}" after the rectangle sentence`);
  return GUIDANCE.slice(0, start) + GUIDANCE.slice(end);
}

test("the real tree: every observation tool the Game surface mounts is named in the planner's text or reasoned", () => {
  const result = check({});
  assert.deepEqual(codes(result), [], "the planner's text and the reason table together must account for every tool");
  assert.equal(result.status, "passed");
  assert.ok(
    result.examined.observationTools >= 8,
    `only ${result.examined.observationTools} observation tools were derived; a collapse this large means the producer ` +
      "stopped being read, not that the surface got smaller",
  );
  assert.equal(
    result.examined.named + result.examined.withReason,
    result.examined.observationTools,
    "every examined tool is either named or carries a reason - the two counts are the population, not a sample of it",
  );
  // THE RECTANGLE QUERY IS WHAT THIS GATE WAS WRITTEN FOR, and it is now a SELECTION on the observation tool: the
  // sentence that used to name a separate tool names the one tool and its own `select` instead.
  assert.ok(
    result.named.includes("stardew_observe"),
    "a task with a shape is a rectangle queried through stardew_observe, so the planner's text must name it",
  );
  assert.equal(
    result.tools.includes("stardew_inspect_tiles"),
    false,
    "the rectangle's own tool is deleted; a name no longer mounted may not stay in this population",
  );
});

test("the verdict line and the report carry the same status, and every rule is enumerated", () => {
  const report = reportOf(check({}));
  assert.equal(report.status, "passed");
  assert.deepEqual(
    report.checks.map((entry) => entry.id),
    RULES.map((rule) => rule.id),
    "a rule that passed is enumerated beside one that failed; the list is the gate's capability, not its findings",
  );
  assert.deepEqual(
    rulesOf(report, "passed"),
    report.checks.map((entry) => entry.id),
  );
  assert.equal(
    renderReport(check({})).lines.at(-2),
    "planner_guidance_observation_tools: passed",
    "the human line and the JSON status are one spelling of the same verdict",
  );
});

test("a failing rule is the one the report names, and the others still report their own outcome", () => {
  const withoutLookUp = GUIDANCE.replaceAll("stardew_look_up", "the held snapshot");
  const report = reportOf(check({ [GUIDANCE_PATH]: withoutLookUp }));
  assert.equal(report.status, "failed");
  assert.deepEqual(rulesOf(report, "failed"), ["every_observation_tool_named_or_reasoned"]);
  assert.deepEqual(
    report.checks.find((entry) => entry.id === "every_observation_tool_named_or_reasoned").findings,
    ["planner_guidance_omits_tool:stardew_look_up"],
    "the rule's entry names the tool, so the finding and the report are one reading",
  );
  assert.equal(rulesOf(report, "not_measured").length, 0);
});

test("a prerequisite that cannot be read is not_measured, and the whole gate is blocked", () => {
  const noTools = PRODUCER.replaceAll("defineTool({", "defineToolLiteral({");
  const report = reportOf(check({ [PRODUCER_PATH]: noTools }));
  assert.equal(report.status, "blocked", "an empty population measured nothing, so the gate has not passed");
  assert.deepEqual(rulesOf(report, "not_measured"), ["observation_population_derived"]);
  assert.equal(
    report.checks.find((entry) => entry.id === "observation_population_derived").reason,
    "the declaration mounts no observation tool, so nothing was measured",
  );
});

test("the verdict line prints the population, the named count and the reason count", () => {
  const result = check({});
  const { lines, exitCode } = renderReport(result);
  assert.equal(
    lines[0],
    `observation tools examined ${result.examined.observationTools} · named ${result.examined.named} · with a reason ` +
      String(result.examined.withReason),
  );
  assert.match(lines[0], /^observation tools examined \d+ · named \d+ · with a reason \d+$/u);
  assert.equal(exitCode, 0);
  // The population is printed, one line per member: "0 violations" means nothing without "examined N".
  const printed = lines.filter((line) => line.startsWith("planner_guidance_observation_tool:"));
  assert.deepEqual(
    printed.map((line) => line.split(":")[1]).sort(),
    [...result.tools],
    "every examined tool is printed by name, so a reader can check the set this verdict rests on",
  );
});

test("the guidance before the rectangle sentence is red on stardew_observe", () => {
  const result = check({ [GUIDANCE_PATH]: guidanceBeforeRectangleLine() });
  assert.equal(result.status, "failed");
  assert.ok(
    codes(result).includes("planner_guidance_omits_tool:stardew_observe"),
    `the reading that made this gate necessary must still be red; got ${codes(result).join(", ") || "(nothing)"}`,
  );
});

test("removing a second tool's name from the text is red, and names only that tool", () => {
  const withoutLookUp = GUIDANCE.replaceAll("stardew_look_up", "the held snapshot");
  assert.notEqual(
    withoutLookUp,
    GUIDANCE,
    "the planner's text no longer names stardew_look_up; the injection is stale",
  );
  assert.deepEqual(codes(check({ [GUIDANCE_PATH]: withoutLookUp })), ["planner_guidance_omits_tool:stardew_look_up"]);
});

test("a tool nobody has written yet is red by being added to the declaration", () => {
  const withNewTool = PRODUCER.replace(
    "  const tools: Array<ReturnType<typeof defineTool>> = [",
    '  const inspectCrops = defineTool({\n    name: "stardew_inspect_crops",\n    label: "Inspect Stardew Crops",\n  });\n' +
      "  const tools: Array<ReturnType<typeof defineTool>> = [",
  );
  assert.notEqual(withNewTool, PRODUCER, "the producer's tool array is no longer where this case injects a member");
  const result = check({ [PRODUCER_PATH]: withNewTool });
  assert.equal(result.examined.observationTools, 9);
  assert.deepEqual(codes(result), ["planner_guidance_omits_tool:stardew_inspect_crops"]);
});

test("a mention that lives only in a comment inside the function is not a mention", () => {
  // A comment beside the sentence is the shape this hazard really takes: the name IS inside the function that builds the
  // text, one line above the string, and a reader that did not blank comments would count it as a mention the model
  // reads. The comment goes INSIDE the body on purpose - a comment above the declaration is outside the body either way,
  // so it would prove nothing about the reader. The anchor is the whole declaration: `): string {` alone matched
  // `planNodeId` first and planted the comment in an unrelated function, which made this case pass for no reason.
  const declaration = "export function planWorkDescription(actions: readonly PublishedPlanAction[]): string {";
  const withComment = guidanceBeforeRectangleLine();
  assert.ok(withComment.includes(declaration), "planWorkDescription's declaration is gone");
  const commented = withComment.replace(
    declaration,
    `${declaration}\n  // stardew_observe answers a rectangle, but this line is a comment, not text the model reads.`,
  );
  assert.equal(plannerGuidanceText(commented)?.includes("stardew_observe"), false);
  assert.ok(codes(check({ [GUIDANCE_PATH]: commented })).includes("planner_guidance_omits_tool:stardew_observe"));
});

test("the producer's own comments do not become tools", () => {
  // `stardew_read_scene` carries a comment naming `stardew_observe_scene`, the tool it replaced: a reader that counted
  // comments would report a tool the surface has not mounted since that rename. And a comment that spells a `name:` key
  // is the same defect one step further - the injection below is that comment, planted where a real one would sit.
  assert.ok(observationToolNames(PRODUCER)?.includes("stardew_observe_scene") === false);
  const commented = PRODUCER.replace(
    "  const tools: Array<ReturnType<typeof defineTool>> = [",
    '  // defineTool({ name: "stardew_commented_tool" }) is described here and mounted nowhere.\n' +
      "  const tools: Array<ReturnType<typeof defineTool>> = [",
  );
  assert.notEqual(commented, PRODUCER, "the producer's tool array is no longer where this case injects a comment");
  assert.equal(observationToolNames(commented)?.includes("stardew_commented_tool"), false);
});

test("a reason for a tool the planner's text now names is red: the reason has been overtaken", () => {
  const result = check(
    {},
    {
      ...PLANNER_NEED_NOT_MENTION,
      stardew_observe: {
        kind: "failure_diagnosis",
        reason: "the text does not name the fresh observation tool at all",
      },
    },
  );
  assert.deepEqual(codes(result), ["planner_guidance_reason_stale:stardew_observe"]);
});

test("a reason for a tool the declaration no longer mounts is red: the table is a reading, not a list", () => {
  const result = check(
    {},
    {
      ...PLANNER_NEED_NOT_MENTION,
      stardew_watch_weather: {
        kind: "failure_diagnosis",
        reason: "a tool this surface used to mount, kept in a table that no longer reads the declaration",
      },
    },
  );
  assert.deepEqual(codes(result), ["planner_guidance_reason_unknown_tool:stardew_watch_weather"]);
});

test("an unreasoned entry is red: the class is closed and the reason must name something", () => {
  const unknownClass = check(
    {},
    { ...PLANNER_NEED_NOT_MENTION, stardew_find_destination: { kind: "not_a_class", reason: "x".repeat(60) } },
  );
  assert.deepEqual(codes(unknownClass), ["planner_guidance_reason_unreasoned:stardew_find_destination"]);
  const tooShort = check(
    {},
    { ...PLANNER_NEED_NOT_MENTION, stardew_find_destination: { kind: "navigation_route", reason: "not needed" } },
  );
  assert.deepEqual(codes(tooShort), ["planner_guidance_reason_unreasoned:stardew_find_destination"]);
});

test("a producer with no observation tools is blocked, never a green reading over an empty population", () => {
  const noTools = PRODUCER.replaceAll("defineTool({", "defineToolLiteral({");
  const result = check({ [PRODUCER_PATH]: noTools });
  assert.equal(result.examined.observationTools, 0);
  assert.equal(result.status, "blocked");
  assert.ok(
    codes(result).includes("observation_population_empty:createStardewObservationTools"),
    `an empty population must say so; got ${codes(result).join(", ")}`,
  );
});

test("the population is not the observation class unless the surface still mounts it", () => {
  const rewired = read(ADAPTER_PATH).replace(
    "observation: createStardewObservationTools(",
    "observation: createObservationTools(",
  );
  assert.notEqual(rewired, read(ADAPTER_PATH), "the adapter no longer wires the producer this case renames");
  assert.deepEqual(codes(check({ [ADAPTER_PATH]: rewired })), [`observation_chain_unanchored:${ADAPTER_PATH}`]);
});

test("every reason in the table uses a declared class and says the concrete thing", () => {
  for (const [toolName, entry] of Object.entries(PLANNER_NEED_NOT_MENTION)) {
    assert.ok(
      Object.hasOwn(REASON_CLASSES, entry.kind),
      `${toolName} carries the unknown class "${entry.kind}"; classes are ${Object.keys(REASON_CLASSES).join("|")}`,
    );
    assert.ok(entry.reason.length > 60, `${toolName}'s reason is too short to name anything`);
  }
});

/* --------------------------------------------------------------------------------------------------------------------
 * THE PLAN'S NODE LIMIT, which is a number one text published and a guard enforced.
 *
 * `round55`, turn 152, in her own thinking: "equip + 15 = 16 nodes, at limit… 16 nodes max". The `isFull()` guard has
 * never refused a 17th node; `MAX_PLAN_NODES` is 256. The number she read was the `stardew_plan_work` script parameter
 * description - "16 nodes is the whole plan" - and 32 plans later, 26 accepted at a mean of 3.69 nodes, every program
 * boundary cost a measured 55.4 s of model turn. So the cases below are the two directions of one fact: the published
 * number must equal the guard's, and it must be QUOTED from the constant rather than typed in, because a typed number is
 * how the two came apart when the constant moved.
 * ------------------------------------------------------------------------------------------------------------------ */

const PLAN_TOOLS_PATH =
  "host/src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts";
const PLAN_TOOLS = read(PLAN_TOOLS_PATH);

/** The sentence as the tree writes it, matched rather than quoted, so an edit above it fails here instead of drifting. */
const DERIVED_LIMIT_SENTENCE = /a plan holds at most \$\{String\(([A-Za-z_$][\w$]*)\)\} nodes/u;

/** The shipped `script` description with its node-limit sentence replaced, so each case injects one defect at a time. */
function withLimitSentence(replacement) {
  const match = DERIVED_LIMIT_SENTENCE.exec(PLAN_TOOLS);
  assert.notEqual(
    match,
    null,
    "the plan tool's script description no longer derives the node limit from a constant, so this suite can no longer " +
      "inject the reading it exists for",
  );
  const injected = PLAN_TOOLS.replace(match[0], replacement);
  assert.notEqual(injected, PLAN_TOOLS, "the node-limit sentence is no longer where this case injects");
  return injected;
}

const realReading = planNodeLimitReading({ guidanceSource: GUIDANCE, toolsSource: PLAN_TOOLS });

test("the published plan node limit is the number the isFull() guard enforces", () => {
  assert.equal(
    typeof realReading.realLimit,
    "number",
    "the guard must compare the node count against a declared constant",
  );
  assert.equal(realReading.limitConstant === undefined, false, "the guard's constant must be named, not a literal");
  assert.equal(
    numericConstants(GUIDANCE).get(realReading.limitConstant),
    realReading.realLimit,
    "the constant the guard names and the constant this reading found are one declaration",
  );
  assert.ok(realReading.places.length > 0, "blocked: the plan surface published no text to examine");
  assert.ok(
    realReading.claims.length > 0,
    "the plan tool states nowhere how many nodes a plan holds, so a companion can only learn the ceiling by hitting it",
  );
  assert.deepEqual(
    realReading.claims.map((claim) => claim.quoted.derived),
    realReading.claims.map(() => true),
    "every stated limit is quoted from a constant; a typed number is the defect this rule exists for",
  );
  assert.deepEqual(codes(check({})), [], "the real tree publishes the guard's own number");
});

test("the shipped sentence is red on both counts: it disagrees with the guard and it is typed in", () => {
  // The reading this gate was written from, replayed on the text HEAD ships: "16 nodes is the whole plan", 79 minutes
  // before `round55` stopped at 16 on every program.
  const result = check({ [PLAN_TOOLS_PATH]: withLimitSentence("16 nodes is the whole plan") });
  assert.deepEqual(codes(result), [
    `plan_node_limit_disagrees:16:${realReading.realLimit}`,
    "plan_node_limit_hand_written:16",
  ]);
  assert.equal(result.status, "failed");
});

test("a number that is wrong is red whatever it is, not only the one that shipped", () => {
  const wrong = realReading.realLimit - 1;
  assert.deepEqual(codes(check({ [PLAN_TOOLS_PATH]: withLimitSentence(`a plan holds at most ${wrong} nodes`) })), [
    `plan_node_limit_disagrees:${wrong}:${realReading.realLimit}`,
    `plan_node_limit_hand_written:${wrong}`,
  ]);
});

test("a number that is RIGHT today and typed in is still red: the class, not the instance", () => {
  assert.deepEqual(
    codes(check({ [PLAN_TOOLS_PATH]: withLimitSentence(`a plan holds at most ${realReading.realLimit} nodes`) })),
    [`plan_node_limit_hand_written:${realReading.realLimit}`],
  );
});

test("moving the constant moves both sides: the guard and the text are one reading, not two copies", () => {
  const moved = GUIDANCE.replace(
    new RegExp(`(export const ${realReading.limitConstant} = )${realReading.realLimit}`, "u"),
    `$1${realReading.realLimit + 7}`,
  );
  assert.notEqual(
    moved,
    GUIDANCE,
    `the declaration of ${realReading.limitConstant} is no longer where this case injects`,
  );
  const reading = planNodeLimitReading({ guidanceSource: moved, toolsSource: PLAN_TOOLS });
  assert.equal(reading.realLimit, realReading.realLimit + 7, "the real limit is the guard's declaration");
  assert.deepEqual(
    reading.claims.map((claim) => claim.quoted.value),
    [reading.realLimit],
    "the text follows the constant, so a moved limit is green without an edit to the sentence",
  );
  assert.deepEqual(
    codes(check({ [GUIDANCE_PATH]: moved })).filter((code) => code.includes("plan_node_limit")),
    [],
    "a limit that moved in one place is not a disagreement",
  );
});

test("a guard that compares a literal is unanchored, and the gate is blocked rather than green", () => {
  const literalGuard = GUIDANCE.replace(
    `state.nodes.length >= ${realReading.limitConstant}`,
    "state.nodes.length >= 16",
  );
  assert.notEqual(literalGuard, GUIDANCE, "the isFull() guard is no longer where this case injects");
  const report = reportOf(check({ [GUIDANCE_PATH]: literalGuard }));
  assert.equal(report.status, "blocked", "with no constant there is no real limit, so nothing was measured");
  assert.deepEqual(rulesOf(report, "not_measured"), ["plan_node_limit_read_from_the_guard"]);
});

test("a claim this gate cannot resolve is red: an unknown interpolation is not skipped", () => {
  const unresolved = withLimitSentence("a plan holds at most ${String(PUBLISHED_PLAN_NODES)} nodes");
  const findings = codes(check({ [PLAN_TOOLS_PATH]: unresolved }));
  assert.equal(findings.length, 1, `one unresolved claim, one finding; got ${findings.join(", ")}`);
  assert.match(
    findings[0],
    new RegExp(`^plan_node_limit_unresolved:${PLAN_TOOLS_PATH.replace(".", "\\.")}:\\d+$`, "u"),
    "the finding names the file and line the number is written on",
  );
});

test("a description whose text is not a literal is a place the gate could not read, and says so", () => {
  const computed = PLAN_TOOLS.replace(
    "      script: Type.String({",
    "      computed: Type.String({ description: String(PLAN_NODE_LIMIT_TEXT) }),\n      script: Type.String({",
  );
  assert.notEqual(
    computed,
    PLAN_TOOLS,
    "the script parameter is no longer where this case injects a computed description",
  );
  const report = reportOf(check({ [PLAN_TOOLS_PATH]: computed }));
  assert.equal(report.status, "blocked");
  assert.deepEqual(rulesOf(report, "not_measured"), ["plan_text_population_readable"]);
});

test("a plan surface that publishes no text at all is blocked, never a pass over nothing", () => {
  const report = reportOf(
    check({ [PLAN_TOOLS_PATH]: "export const nothing = 1;\n", [GUIDANCE_PATH]: "export const nothing = 1;\n" }),
  );
  assert.equal(report.status, "blocked");
  assert.ok(rulesOf(report, "not_measured").includes("plan_text_population_readable"));
  assert.equal(report.examined.planTextPlaces, 0);
});

test("the plan node limit is printed as a population: places examined, states a limit, disagrees", () => {
  const { lines } = renderReport(check({}));
  const line = lines.find((candidate) => candidate.startsWith("plan node limit · places examined "));
  assert.notEqual(line, undefined, "the verdict has to print the population this rule rests on");
  assert.equal(
    line,
    `plan node limit · places examined ${realReading.places.length} · state a limit ` +
      `${realReading.claims.length} · disagree 0`,
  );
  const provenance = lines.find((candidate) => candidate.startsWith("plan node limit · real "));
  assert.equal(
    provenance,
    `plan node limit · real ${realReading.realLimit} from ${realReading.limitConstant} · typed into the text 0`,
  );
});

test("a claim in step words is the same claim about the plan's size", () => {
  assert.deepEqual(codes(check({ [PLAN_TOOLS_PATH]: withLimitSentence("16 steps is the whole plan") })), [
    `plan_node_limit_disagrees:16:${realReading.realLimit}`,
    "plan_node_limit_hand_written:16",
  ]);
});

test("every string literal is read as text, and an interpolation is not text", () => {
  const [literal] = modelVisibleLiterals("x = `a ${String(CONST)} nodes and 16 nodes`;");
  assert.equal(literal.masked, "a «String(CONST)» nodes and 16 nodes");
  assert.deepEqual(quotedLimit("16", numericConstants("export const CONST = 256;")), { value: 16, derived: false });
  assert.deepEqual(quotedLimit("«String(CONST)»", numericConstants("export const CONST = 256;")), {
    value: 256,
    derived: true,
    name: "CONST",
  });
  assert.equal(quotedLimit("«MISSING»", new Map()).value, null);
});
