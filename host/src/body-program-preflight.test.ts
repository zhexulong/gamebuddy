import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PLAN_FOR_EACH_BY_KIND_ACTION } from "./body-program-for-each.js";
import { type BodyProgramNodeCatalogue, bodyProgramPreflightRefusal } from "./body-program-preflight.js";
import {
  type CompiledPlan,
  compilePlanScript,
  FOR_EACH_PLAN_ACTION_ID,
  PLAN_FORM_ACTION_IDS,
  planActionsFromRegistrations,
} from "./body-program-script.js";
import type { ActionRegistration, Snapshot } from "./protocol.js";

/**
 * The first gate every plan passes, driven by the published surface.
 *
 * <p>
 * MEASURED 2026-11-09, verbatim from a finished run. The companion wrote the only loop of its 68 plans -
 * `builder.for_each({ source: { area: { x: 54, y: 16, w: 16, h: 2 } }, do: { action: "till_soil" } })` - and the whole
 * answer was `body_program_preflight_rejected:for_each:allowed=...(100+ ids)...:registrations=N:live=M:refused_present=none`.
 * A plan FORM is a node whose action id is declared by the plan-form catalogue and not by the action surface, so the
 * preflight refused it for not being an action, and the loop never ran. The loop is the only construct that can express
 * a 32-tile pass in one plan, so this one line is why a 3x20 patch was worked 16 tiles at a time.
 * </p>
 * <p>
 * The three properties below are what keep the fix honest: a declared form is admitted whatever the action catalogue
 * says, its ROWS still answer to the live policy, and an id that is not a declared form cannot borrow either answer.
 * </p>
 */

const hostRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SURFACE_PATH = resolve(
  hostRoot,
  "../integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
);
const MATERIALIZER_PATH = resolve(
  hostRoot,
  "src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts",
);

type SurfaceAction = Readonly<{
  actionId: string;
  lifecycle: string;
  kind: string;
  argumentSchema?: Readonly<Record<string, { type: string; enum?: readonly string[] }>>;
  outputFacts?: Readonly<Record<string, string>>;
}>;

const SURFACE = (JSON.parse(readFileSync(SURFACE_PATH, "utf8")) as { actions: readonly SurfaceAction[] }).actions;

const REGISTRATIONS: readonly ActionRegistration[] = SURFACE.map((action) =>
  Object.freeze({
    actionId: action.actionId,
    familyId: "fixture_family",
    identityVersion: 1,
    lifecycle: action.lifecycle as ActionRegistration["lifecycle"],
    kind: action.kind as ActionRegistration["kind"],
    ...(action.argumentSchema === undefined
      ? {}
      : { descriptor: { argumentSchema: action.argumentSchema, outputFacts: action.outputFacts ?? {} } }),
  }),
);

const ACTIONS = planActionsFromRegistrations(REGISTRATIONS);

/** What this connection offers: the plan vocabulary, which is the surface the companion's own tools are built from. */
const VISIBLE: readonly string[] = Object.freeze(ACTIONS.map((action) => action.actionId));

/** What the attached Mod publishes: the action surface PLUS the plan forms it appends to the same hello. */
const REGISTERED: readonly string[] = Object.freeze([...VISIBLE, ...PLAN_FORM_ACTION_IDS]);

const CATALOGUE: BodyProgramNodeCatalogue = Object.freeze({
  visibleActionIds: VISIBLE,
  registeredActionIds: REGISTERED,
});

const SNAPSHOT = {
  revision: 11,
  location: "Farm",
  tile: { x: 10, y: 10 },
  stamina: 100,
  health: 100,
  actionable: true,
  exhausted: false,
  capabilities: [],
  catalogRevision: 1,
  enabledActionIds: [],
  presentationLocale: "en-US",
  timeOfDay: 600,
  dayOfMonth: 1,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
} as Snapshot;

function compile(script: string): CompiledPlan {
  return compilePlanScript({ script }, { snapshot: SNAPSHOT, actions: ACTIONS });
}

type PlanNode = Record<string, unknown> & { arguments: Record<string, unknown> };

function nodesOf(result: CompiledPlan): readonly PlanNode[] {
  if (!result.ok) assert.fail(`expected a plan, received ${result.reasonCode}`);
  return [...result.program.nodes] as unknown as readonly PlanNode[];
}

/**
 * The measured plan, compiled by the real compiler.
 *
 * Built by `compilePlanScript` rather than hand-written so the node the preflight reads is the node the product really
 * produces: a test that spelled the node itself could agree with the preflight while the compiler wrote something else.
 */
function measuredLoopNodes(): readonly PlanNode[] {
  const nodes = nodesOf(
    compile(`builder.for_each({ source: { area: { x: 54, y: 16, w: 16, h: 2 } }, do: { action: "till_soil" } });`),
  );
  assert.equal(nodes.length, 1, "the measured plan is one node: the loop the whole pass lives in");
  return nodes;
}

function loopDocument(doEffect: Readonly<Record<string, unknown>> | null): Record<string, unknown> {
  return {
    type: "loop",
    source: { area: { x: 0, y: 0, w: 2, h: 1 } },
    do: doEffect,
  };
}

function node(actionId: string, nodeId = "n01", arguments_: Record<string, unknown> = {}): PlanNode {
  return { nodeId, actionId, arguments: arguments_, dependsOn: [], bindings: {} };
}

const NOTHING_OFFERED: BodyProgramNodeCatalogue = Object.freeze({
  visibleActionIds: Object.freeze([]),
  registeredActionIds: REGISTERED,
});

/**
 * THE MEASURED CASE. The node's action id is a plan form, which by definition is not in the action catalogue.
 *
 * The second assertion is the defect itself, written down: `visible` CANNOT contain the form - it is a node that expands
 * into many dispatches, not an action - so a preflight that tests every node against the action catalogue refuses the one
 * construct the companion needs. The form is admitted as a form, exactly as the Mod admits it (`FarmhandPlanFormCatalog`).
 */
test("the preflight admits the plan form the compiler wrote, so a pass over 32 tiles is not refused as an action", () => {
  const nodes = measuredLoopNodes();
  const formNode = nodes[0]!;
  assert.equal(formNode.actionId, FOR_EACH_PLAN_ACTION_ID);
  assert.equal(
    VISIBLE.includes(formNode.actionId),
    false,
    "a form is not an action, so the connection's action catalogue cannot offer it - which is why the catalogue test refused it",
  );
  assert.equal(bodyProgramPreflightRefusal(nodes, CATALOGUE), null);
});

/**
 * THE OTHER HALF OF THE SAME DECISION. The form is admitted; its ROWS are not. The Mod's verifier moved its live-policy
 * gate off the form and onto the row (`row_action_not_enabled:<actionId>`), and the Host preflight says the same word for
 * the same fact - a caller told one thing here and refused with another later has been taught nothing.
 */
test("a loop whose row names an action this connection does not offer is refused by name, and the form is not blamed", () => {
  const restricted: BodyProgramNodeCatalogue = Object.freeze({
    visibleActionIds: Object.freeze(VISIBLE.filter((actionId) => actionId !== "till_soil")),
    registeredActionIds: REGISTERED,
  });
  assert.equal(
    bodyProgramPreflightRefusal(measuredLoopNodes(), restricted),
    `body_program_preflight_rejected:n01:${FOR_EACH_PLAN_ACTION_ID}:row_action_not_enabled:till_soil`,
  );
});

/** `by_kind` names no action of its own: the row's action is decided on the game thread, so there is nothing to check. */
test("a row that names the Mod's own classifier is not judged against this connection, and a named row still is", () => {
  const classifierRow = [
    node(FOR_EACH_PLAN_ACTION_ID, "n01", { loop: loopDocument({ action: PLAN_FOR_EACH_BY_KIND_ACTION }) }),
  ];
  assert.equal(
    bodyProgramPreflightRefusal(classifierRow, NOTHING_OFFERED),
    null,
    "a connection that offers no action at all still admits the form whose row is the Mod's classifier",
  );
  const namedRow = [node(FOR_EACH_PLAN_ACTION_ID, "n01", { loop: loopDocument({ action: "till_soil" }) })];
  assert.equal(
    bodyProgramPreflightRefusal(namedRow, NOTHING_OFFERED),
    `body_program_preflight_rejected:n01:${FOR_EACH_PLAN_ACTION_ID}:row_action_not_enabled:till_soil`,
  );
});

/**
 * An id this Host does not declare as a form cannot be admitted by carrying a form's document.
 *
 * The distinction is the DOCUMENT, not the id: `for_each_patch` is registered nowhere, so an action test would answer
 * `unknown_action` and leave the caller believing a published name exists under another spelling. It is a form-shaped
 * node under an id the plan-form catalogue does not declare, and it says so.
 */
test("a form-shaped node under an undeclared id is refused as an undeclared form", () => {
  const undeclaredFormId = `${FOR_EACH_PLAN_ACTION_ID}_patch`;
  assert.equal(PLAN_FORM_ACTION_IDS.includes(undeclaredFormId), false, "the fixture id must not be a declared form");
  const disguised = [node(undeclaredFormId, "n01", { loop: loopDocument({ action: "till_soil" }) })];
  assert.equal(
    bodyProgramPreflightRefusal(disguised, CATALOGUE),
    `body_program_preflight_rejected:n01:${undeclaredFormId}:plan_form_not_declared`,
  );
});

/**
 * The inverse, and the one that proves the exemption cannot leak: a PUBLISHED action carrying a plan-form document is
 * refused, even though its own id is offered. A form is admitted by being declared a form, never by looking like one.
 */
test("a plan-form document under a published action id cannot borrow that action's permission", () => {
  assert.ok(VISIBLE.includes("till_soil"), "the fixture needs an id this connection really offers");
  const disguised = [node("till_soil", "n01", { loop: loopDocument({ action: "till_soil" }) })];
  assert.equal(
    bodyProgramPreflightRefusal(disguised, CATALOGUE),
    "body_program_preflight_rejected:n01:till_soil:plan_form_not_declared",
  );
});

/**
 * A REFUSAL NAMES THE NODE, AND NOT THE CATALOGUE.
 *
 * The message this replaced appended every allowed id (100+ of them, 1.5 KB) to a refusal that named no node, no action
 * and no reason: noise the caller paid tokens for, hiding the one word that mattered. An unknown action now answers
 * `node`, `action` and the class, and nothing else.
 */
test("an unknown action is refused by node and action, with no catalogue in the message", () => {
  const message = bodyProgramPreflightRefusal([node("brew_potion", "n03")], CATALOGUE);
  assert.equal(message, "body_program_preflight_rejected:n03:brew_potion:unknown_action");
  assert.equal(
    message?.includes("allowed="),
    false,
    "the refusal must not carry the catalogue it was judged against: it is read as a vocabulary and it is mostly irrelevant",
  );
});

/** The list is a bounded diagnostic and the count is not: a truncated answer says how many it left out. */
test("a plan with more refusals than the answer carries says how many it left out", () => {
  const nodes = Array.from({ length: 12 }, (_unused, index) =>
    node("brew_potion", `n${String(index + 1).padStart(2, "0")}`),
  );
  const message = bodyProgramPreflightRefusal(nodes, CATALOGUE);
  assert.ok(message !== null);
  assert.equal(message.split(",").length, 9, "eight refusals are listed beside the one count of the rest");
  assert.ok(message.endsWith(",+4_more"), `the answer must say how many it left out, received ${message}`);
});

/** The same id, published by the Mod and not offered here, is a different correction and is named apart. */
test("an action the Mod publishes but this connection does not offer is named apart from a typo", () => {
  const restricted: BodyProgramNodeCatalogue = Object.freeze({
    visibleActionIds: Object.freeze(VISIBLE.filter((actionId) => actionId !== "till_soil")),
    registeredActionIds: REGISTERED,
  });
  assert.equal(
    bodyProgramPreflightRefusal([node("till_soil", "n02")], restricted),
    "body_program_preflight_rejected:n02:till_soil:action_not_enabled",
  );
});

/** A malformed node is answered, not crashed: this runs before the request validator owns the shape. */
test("a node with no action id is refused by name instead of throwing", () => {
  assert.equal(
    bodyProgramPreflightRefusal([{ nodeId: "n01" }], CATALOGUE),
    "body_program_preflight_rejected:n01:no_action_id:no_action_id",
    "the node it named is still the caller's own, so only the missing action is a placeholder",
  );
  assert.equal(
    bodyProgramPreflightRefusal(["not a node"], CATALOGUE),
    "body_program_preflight_rejected:no_node_id:no_action_id:no_action_id",
  );
});

/**
 * THE GATE, with its population taken from the two authorities rather than a list here.
 *
 * Every id the plan-form catalogue declares must be admitted by a connection that offers NO action - which is what makes
 * the exemption a property of the form catalogue and not of the ids that happen to be visible - and every action of the
 * published surface must be refused by that same connection. A future form therefore reaches this test automatically,
 * and so does an action someone adds to the form catalogue by mistake: it would stop answering `action_not_enabled`.
 */
test("every declared form is admitted with nothing offered, and every published action is refused", () => {
  assert.ok(PLAN_FORM_ACTION_IDS.length > 0, "a population of zero would agree with itself");
  assert.ok(ACTIONS.length > 0, "a population of zero would agree with itself");
  for (const formId of PLAN_FORM_ACTION_IDS) {
    const nodes = [node(formId, "n01", { loop: loopDocument(null) })];
    assert.equal(
      bodyProgramPreflightRefusal(nodes, NOTHING_OFFERED),
      null,
      `${formId} is declared a plan form, so the connection's action catalogue does not judge it`,
    );
  }
  for (const action of ACTIONS) {
    assert.equal(
      bodyProgramPreflightRefusal([node(action.actionId)], NOTHING_OFFERED),
      `body_program_preflight_rejected:n01:${action.actionId}:action_not_enabled`,
      `${action.actionId} is a published action, so a connection that offers none must refuse it by that name`,
    );
  }
});

/**
 * The decision must be the one the submission path asks, or the fix above is a library nobody calls.
 */
test("the submission path asks this decision instead of testing a node against the catalogue inline", () => {
  const source = readFileSync(MATERIALIZER_PATH, "utf8");
  const asked = source.indexOf("bodyProgramPreflightRefusal(request.nodes");
  const preflight = source.indexOf("if (refusal !== null) throw new Error(refusal);");
  assert.ok(asked > 0, "the preflight must ask the declared decision");
  assert.ok(preflight > 0, "the preflight must refuse on that answer");
  const submit = source.slice(source.indexOf("const submitProgram = async"));
  const askedBeforeSending = submit.indexOf("assertFreshBodyProgramPreflight(");
  // The frame the preflight was asked about is the one that is sent: `submitProgram` projects the candidate to the wire
  // subset once (`bodyProgramCandidateWire`) and asks about THAT, so a stamp the Host holds cannot be preflighted as if
  // the Mod had a field for it.
  const sent = submit.indexOf("port.submit(wire)");
  assert.ok(askedBeforeSending > 0 && sent > 0, "the one submission path must run the preflight before it sends");
  assert.ok(askedBeforeSending < sent, "the answer must come BEFORE anything is sent to the Mod");
  assert.equal(
    source.includes(":allowed="),
    false,
    "the catalogue dump must not survive anywhere in the submission path",
  );
});
