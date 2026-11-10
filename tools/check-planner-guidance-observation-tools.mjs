#!/usr/bin/env node
/**
 * A tool can exist, carry a perfect description, and still never be asked for.
 *
 * WHY. `affordances` is the precedent: `stardew_look_up` advertised the subject with a full description and the run it
 * was built for used it zero times, because nothing in the text the companion reads at PLANNING time pointed at it. A
 * query nobody consults is indistinguishable from a missing one - the player loses the capability either way - so the
 * observation tools that answer questions a plan's steps depend on have to be named in `stardew_plan_work`'s own
 * description, which is the text a planning turn holds.
 *
 * WHAT IS NOT COVERED. `stardew_plan_shape` carries guidance of its own, and it lives in
 * `host/src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts`. This gate
 * reads one guidance text: `planWorkDescription`. A second reader for the other tool would be a second spelling of
 * "the planner's guidance"; the place to add it is that file's own description, and the place to gate it is here, once
 * someone decides the two texts are one subject.
 *
 * POPULATION - derived from the declaration on every run, never listed here:
 *   the tools `createStardewObservationTools` returns (`host/src/game-tools.ts`). That function is the observation
 *   class itself: `host/src/stardew-game-integration-adapter.ts` hands its result to the tool set as `observation`, and
 *   `host/src/runtime-core.internal.ts` mounts `integrationToolSet.observation` in the Game surface's `game_action`
 *   group. Both links are asserted as ANCHORS below, so a rename or a rewiring is `observation_chain_unanchored`
 *   rather than a population that quietly shrank to nothing and a gate that agreed with itself.
 *
 *   Inside the producer, each `defineTool({` literal's own `name` is a member. Comments are blanked first: the
 *   read_scene tool carries a comment naming the tool it replaced (`stardew_observe_scene`), and a reader that counted
 *   it would report a tool that does not exist.
 *
 * ASSERTIONS, both directions:
 *   1. every observation tool is either NAMED in `planWorkDescription`'s text, or carries a stated reason here
 *      (`PLANNER_NEED_NOT_MENTION`), in one of the closed classes below. A member with neither is
 *      `planner_guidance_omits_tool:<name>`, and the finding names the tool, because the tool is the thing to fix.
 *   2. the reason table cannot rot: a reason for a tool the guidance now names is `planner_guidance_reason_stale`
 *      (delete it), and one for a name the declaration no longer mounts is `planner_guidance_reason_unknown_tool`.
 *   3. the guidance is read from source with comments blanked, so a name written in a comment beside the text is not a
 *      mention. A name that reaches the model only through a helper function `planWorkDescription` concatenates is NOT
 *      counted either: that reading errs toward red, never toward a false green.
 *
 * A zero population is `observation_population_empty` and blocked - a check whose population is empty agrees with
 * itself. `examined N · named M · with a reason K` is the verdict line, and `node
 * tools/check-planner-guidance-observation-tools.mjs` exits 1 on any finding.
 *
 * red-proof: inject  the guidance as it read before the rectangle sentence (the name deleted from the text) -> `examined 9
 *   named 0 reason 6`, `planner_guidance_omits_tool:stardew_inspect_tiles`, `...:stardew_look_up`, `...:stardew_observe`,
 *   blocked, exit 1 - measured on the text as it read before the sentence was added, and reproduced by
 *   tools/check-planner-guidance-observation-tools.test.mjs deleting it
 * red-proof: inject  only `stardew_look_up`'s name removed -> that tool alone is named, so the finding points at the tool
 *   that went missing and not at the sentence it was in
 * red-proof: inject  a tenth `defineTool` added to the producer -> `planner_guidance_omits_tool:stardew_inspect_crops`,
 *   `examined 10`: a tool nobody has written yet arrives red instead of arriving invisible
 * red-proof: inject  `blankCommentText` made the identity -> two cases fail: a comment inside `planWorkDescription`
 *   counting as a mention, and a `name:` key inside a producer comment becoming a tool
 * red-proof: inject  `observationToolNames` returning before it walks the producer -> 10 of 13 cases fail, so the derived
 *   population is load-bearing rather than decorative
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gate = "planner_guidance_observation_tools/v1";

/** The three links of the chain that makes these tools the Game surface's observation class. */
const ADAPTER_PATH = "host/src/stardew-game-integration-adapter.ts";
const RUNTIME_CORE_PATH = "host/src/runtime-core.internal.ts";
const ADAPTER_ANCHOR = /observation:\s*createStardewObservationTools\(/u;
const RUNTIME_ANCHOR = /\.\.\.integrationToolSet\.observation/u;

/** The declaration itself, and the planner guidance the companion reads. */
const PRODUCER_PATH = "host/src/game-tools.ts";
const GUIDANCE_PATH = "host/src/body-program-script.ts";
const PRODUCER_FUNCTION = "createStardewObservationTools";
const GUIDANCE_FUNCTION = "planWorkDescription";

/**
 * Why the planner's text need not name a tool, as closed classes so the count is a measurement.
 *
 * Each class is a claim about the TOOL, not a place to park an awkward name: `covered_by_this_description` says the
 * answer is already inside the very text that would point at the tool, and the two others say the reading is not an
 * input to writing a step.
 */
export const REASON_CLASSES = Object.freeze({
  covered_by_this_description:
    "the question this tool answers is already answered inside the planner's own text, so pointing at it would send " +
    "the companion to read a list it is holding",
  failure_diagnosis:
    "it diagnoses a step the world already refused; a plan is written from the snapshot and the vocabulary, and this " +
    "reading is spent afterwards, on a step that did not land",
  navigation_route:
    "it answers a route or destination question, and a plan step names its own tile instead of resolving one; the map " +
    "is consulted when a walk is in doubt, not while the script is written",
});

/**
 * The observation tools the planner's text deliberately does not name, each with the reason and its class.
 *
 * One entry per tool is the point: the gate reports the tool that has neither, so this table is the whole of the debt
 * and it can only shrink by making a tool worth naming.
 */
export const PLANNER_NEED_NOT_MENTION = Object.freeze({
  stardew_execution_status: {
    kind: "failure_diagnosis",
    reason:
      "a debugging view of the last execution receipt, which its own description says is not completion proof; a node's " +
      "`state` is where the plan learns its step landed, so naming this would advertise a reader the plan does not use",
  },
  stardew_read_scene: {
    kind: "failure_diagnosis",
    reason:
      "reachability of the affordances in front of you, read after a step was refused; a step names a target the " +
      "surface published, and this answers whether that target can be walked to once the world has said no",
  },
  stardew_interaction_catalog: {
    kind: "covered_by_this_description",
    reason:
      "the catalog lists exactly the published action vocabulary, which the planner's text already prints in full, one " +
      "line per family; pointing at it would send the companion to read what it holds",
  },
  stardew_search_interactions: {
    kind: "covered_by_this_description",
    reason:
      "the same vocabulary as the catalog, searched by a word; every name a plan may call is already printed under its " +
      "family in the planner's text, so a search over that list adds no name the text has not taught",
  },
  stardew_inspect_world_map: {
    kind: "navigation_route",
    reason:
      "the authoritative navigation graph for a warp, which a plan writes as the destination tile itself; the map is " +
      "the answer to a route in doubt, not an input to which step to write",
  },
  stardew_find_destination: {
    kind: "navigation_route",
    reason:
      "a destination query resolved against that same graph, so it shares the map's class: a plan's step carries " +
      "coordinates, and a route search is spent when the walk itself is the question",
  },
});

/** Blank TypeScript comments out, preserving every offset and newline. */
function blankCommentText(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "))
    .replace(/\/\/[^\n]*/gu, (comment) => " ".repeat(comment.length));
}

/** The body of the top-level function named `name`, from its signature to the closing brace in column 0, or null. */
export function functionBody(source, name) {
  const signature = source.indexOf(`function ${name}(`);
  if (signature < 0) return null;
  const closing = source.indexOf("\n}", signature);
  return closing < 0 ? null : source.slice(signature, closing + 2);
}

/**
 * The observation class, from the function whose returned array IS `integrationToolSet.observation`.
 *
 * `null` when the producer or its `defineTool` literals are gone: a population that could not be read is blocked, never
 * an empty population that passes.
 */
export function observationToolNames(source) {
  const producer = functionBody(blankCommentText(source), PRODUCER_FUNCTION);
  if (producer === null) return null;
  const names = new Set();
  for (const part of producer.split("defineTool({").slice(1)) {
    const match = /\bname:\s*"([a-z][a-z0-9_]*)"/u.exec(part);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return Object.freeze([...names].sort());
}

/**
 * The text a planning turn holds, from source with comments blanked.
 *
 * The whole function body is one string being built, so every literal in it is text the model reads; a doc comment
 * beside it is not.
 */
export function plannerGuidanceText(source) {
  const body = functionBody(blankCommentText(source), GUIDANCE_FUNCTION);
  return body === null ? null : body;
}

/** Does the guidance name this tool, and not merely as a prefix of a longer id? */
function names(text, toolName) {
  return new RegExp(`\\b${toolName}\\b`, "u").test(text);
}

function defaultRead(root, relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

/**
 * @param {{ root?: string, overrides?: Record<string, string>, reasons?: object }} options
 */
export function checkPlannerGuidanceObservationTools({
  root = repositoryRoot,
  overrides = {},
  reasons = PLANNER_NEED_NOT_MENTION,
} = {}) {
  const read = (relativePath) => overrides[relativePath] ?? defaultRead(root, relativePath);
  const findings = [];
  const push = (code, member, detail) => findings.push({ code, member, detail });

  for (const [file, anchor, what] of [
    [ADAPTER_PATH, ADAPTER_ANCHOR, "the adapter no longer hands it to the tool set as `observation`"],
    [RUNTIME_CORE_PATH, RUNTIME_ANCHOR, "the Game surface no longer mounts `integrationToolSet.observation`"],
  ]) {
    if (!anchor.test(blankCommentText(read(file))))
      push("observation_chain_unanchored", file, `${what}; the population below is not the mounted observation class`);
  }

  const tools = observationToolNames(read(PRODUCER_PATH));
  const guidance = plannerGuidanceText(read(GUIDANCE_PATH));
  if (tools === null || tools.length === 0)
    push(
      "observation_population_empty",
      PRODUCER_FUNCTION,
      `${PRODUCER_PATH} declares no observation tool, so nothing was measured`,
    );
  if (guidance === null)
    push(
      "guidance_unanchored",
      GUIDANCE_FUNCTION,
      `${GUIDANCE_PATH} declares no planner guidance, so nothing was read`,
    );

  const named = [];
  const reasoned = [];
  for (const toolName of tools ?? []) {
    const reason = reasons[toolName];
    if (guidance !== null && names(guidance, toolName)) {
      named.push(toolName);
      if (reason !== undefined)
        push(
          "planner_guidance_reason_stale",
          toolName,
          "the planner's text names this tool now, so the reason for not naming it has been overtaken; delete the entry",
        );
      continue;
    }
    if (reason === undefined) {
      push(
        "planner_guidance_omits_tool",
        toolName,
        "mounted on the Game surface as an observation tool, named nowhere in the planner's text, and no stated reason " +
          "here says why the planner need not mention it - name it there, or record the class and reason here",
      );
      continue;
    }
    reasoned.push(toolName);
    if (!Object.hasOwn(REASON_CLASSES, reason.kind))
      push("planner_guidance_reason_unreasoned", toolName, `unknown reason class "${reason.kind}"`);
    else if (typeof reason.reason !== "string" || reason.reason.length < 40)
      push("planner_guidance_reason_unreasoned", toolName, "the reason is too short to name anything");
  }
  const mounted = new Set(tools ?? []);
  for (const toolName of Object.keys(reasons)) {
    if (!mounted.has(toolName))
      push(
        "planner_guidance_reason_unknown_tool",
        toolName,
        "the observation class mounts no such tool; delete the entry so the table stays a reading of the declaration",
      );
  }

  findings.sort((left, right) => `${left.code}:${left.member}`.localeCompare(`${right.code}:${right.member}`));
  return Object.freeze({
    gate,
    verdict: findings.length === 0 ? "passed" : "blocked",
    examined: Object.freeze({
      observationTools: (tools ?? []).length,
      named: named.length,
      withReason: reasoned.length,
    }),
    tools: tools ?? Object.freeze([]),
    named: Object.freeze(named),
    reasoned: Object.freeze(reasoned),
    findings: Object.freeze(findings),
  });
}

export function renderReport(result) {
  const lines = [
    `observation tools examined ${result.examined.observationTools} · named ${result.examined.named} · with a reason ` +
      String(result.examined.withReason),
  ];
  for (const toolName of result.tools) {
    const reason = PLANNER_NEED_NOT_MENTION[toolName];
    lines.push(
      `planner_guidance_observation_tool:${toolName}: ` +
        (result.named.includes(toolName) ? "named" : `${reason?.kind ?? "omitted"}`),
    );
  }
  for (const finding of result.findings)
    lines.push(`planner_guidance_${finding.code}: ${finding.member} - ${finding.detail}`);
  lines.push(
    `planner_guidance_observation_tools: ${result.verdict}` +
      `${result.findings.length === 0 ? "" : ` (${result.findings.length} finding(s))`}`,
  );
  return { lines, exitCode: result.findings.length === 0 ? 0 : 1 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { lines, exitCode } = renderReport(checkPlannerGuidanceObservationTools());
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exitCode = exitCode;
}
