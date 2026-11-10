/**
 * The falsifier suite for `tools/check-planner-guidance-observation-tools.mjs`.
 *
 * Every case is an INJECTION into a copy of the real source, because the defect this gate exists for is a sentence
 * missing from a text, and a text that is present in this tree cannot be made absent by describing it. The population
 * cases inject a tool the tree does not have, which is the whole claim: the set is the declaration's, so a tool nobody
 * has written yet arrives red instead of arriving invisible.
 *
 * red-proof: inject  the rectangle sentence deleted from the planner's text -> `examined 9 named 0 reason 6`,
 *   `planner_guidance_omits_tool:stardew_inspect_tiles` beside `stardew_look_up` and `stardew_observe`, blocked, asserted
 *   by "the guidance before the rectangle sentence is red on stardew_inspect_tiles"
 * red-proof: inject  only `stardew_look_up`'s name removed -> that tool alone is named, so a finding points at the tool
 *   that went missing and not at the sentence it sat in
 * red-proof: inject  a tenth `defineTool` added to the producer -> `planner_guidance_omits_tool:stardew_inspect_crops`
 *   over `examined 10`, so the population is the declaration's and covers tools nobody has written yet
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
  observationToolNames,
  plannerGuidanceText,
  PLANNER_NEED_NOT_MENTION,
  REASON_CLASSES,
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

/** The opening and closing words of the rectangle sentence, so the red proofs read the tree instead of quoting it. */
const RECTANGLE_LINE_START = "A piece of work with a SHAPE";
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
  assert.equal(result.verdict, "passed");
  assert.ok(
    result.examined.observationTools >= 9,
    `only ${result.examined.observationTools} observation tools were derived; a collapse this large means the producer ` +
      "stopped being read, not that the surface got smaller",
  );
  assert.equal(
    result.examined.named + result.examined.withReason,
    result.examined.observationTools,
    "every examined tool is either named or carries a reason - the two counts are the population, not a sample of it",
  );
  assert.ok(
    result.named.includes("stardew_inspect_tiles"),
    "the rectangle query is the tool this gate was written for: a task with a shape is a rectangle, not another observe",
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

test("the guidance before the rectangle sentence is red on stardew_inspect_tiles", () => {
  const result = check({ [GUIDANCE_PATH]: guidanceBeforeRectangleLine() });
  assert.equal(result.verdict, "blocked");
  assert.ok(
    codes(result).includes("planner_guidance_omits_tool:stardew_inspect_tiles"),
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
  assert.equal(result.examined.observationTools, 10);
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
    `${declaration}\n  // stardew_inspect_tiles answers a rectangle, but this line is a comment, not text the model reads.`,
  );
  assert.equal(plannerGuidanceText(commented)?.includes("stardew_inspect_tiles"), false);
  assert.ok(codes(check({ [GUIDANCE_PATH]: commented })).includes("planner_guidance_omits_tool:stardew_inspect_tiles"));
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
  assert.equal(result.verdict, "blocked");
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
