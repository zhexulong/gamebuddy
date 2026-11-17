import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { type BodyProgramNodeCatalogue, bodyProgramPreflightRefusal } from "./body-program-preflight.js";
import { planActionsFromRegistrations } from "./body-program-script.js";
import type { ActionRegistration } from "./protocol.js";

/**
 * The first gate every plan passes, driven by the published surface.
 *
 * <p>
 * MEASURED 2026-11-09, verbatim from a finished run. The companion wrote the only loop of its 68 plans - one plan-form
 * node - and the whole answer was `body_program_preflight_rejected:for_each:allowed=...(100+ ids)...:registrations=N`.
 * A plan FORM was a node whose action id the plan-form catalogue declared and the action surface did not, so the
 * preflight refused it for not being an action, and the loop never ran.
 * </p>
 * <p>
 * THE FORM IS GONE and the lesson is not: this file now pins the class rather than the instance. A node carrying a plan
 * form's document is refused BY NAME (`plan_form_not_declared`) whatever the action catalogue says, so a program from
 * anything that still speaks that vocabulary is named instead of dispatched to an id that does not exist - and the
 * ordinary answers beside it (an id the Mod publishes nowhere, an id this connection does not offer, a malformed node)
 * stay apart, because each needs a different correction.
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

const CATALOGUE: BodyProgramNodeCatalogue = Object.freeze({
  visibleActionIds: VISIBLE,
  registeredActionIds: VISIBLE,
});

/** The one argument a plan form's node carried: the Host declares no form, so its presence is the whole evidence. */
function loopDocument(doEffect: Readonly<Record<string, unknown>> | null): Record<string, unknown> {
  return { type: "loop", source: { area: { x: 0, y: 0, w: 2, h: 1 } }, do: doEffect };
}

function node(actionId: string, nodeId = "n01", arguments_: Record<string, unknown> = {}): Record<string, unknown> {
  return { nodeId, actionId, arguments: arguments_, dependsOn: [], bindings: {} };
}

/**
 * A PUBLISHED action carrying a plan form's document is refused, even though its own id is offered: the Host compiles no
 * such node, so no catalogue entry can make it runnable.
 */
test("a plan-form document under a published action id cannot borrow that action's permission", () => {
  assert.ok(VISIBLE.includes("till_soil"), "the fixture needs an id this connection really offers");
  const disguised = [node("till_soil", "n01", { loop: loopDocument({ action: "till_soil", charge: 0 }) })];
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
    registeredActionIds: VISIBLE,
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
  const sent = submit.indexOf("port.submit(request)");
  assert.ok(askedBeforeSending > 0 && sent > 0, "the one submission path must run the preflight before it sends");
  assert.ok(askedBeforeSending < sent, "the answer must come BEFORE anything is sent to the Mod");
  assert.equal(
    source.includes(":allowed="),
    false,
    "the catalogue dump must not survive anywhere in the submission path",
  );
});
