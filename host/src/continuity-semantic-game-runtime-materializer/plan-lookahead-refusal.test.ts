import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compilePlanScript, lookaheadIneligibility, planActionsFromRegistrations } from "../body-program-script.js";
import type { ActionRegistration, Snapshot } from "../protocol.js";
import { validateBodyProgramSubmitResult } from "../protocol.js";
import { programStatusProgress, readInFlightProgrammes } from "../program-status-wait.js";
import { readSourceShape } from "../test-support/source-shape.test-support.js";
import {
  planLookaheadRefusalForSubmission,
  planRefusalAnswer,
} from "./continuity-semantic-game-runtime-materializer.js";

/**
 * A PLAN IS NOT COMPOSED AHEAD OF A PROGRAMME THAT STILL HAS NODES, and the refusal names the action and the group.
 *
 * <p>
 * THE GAP WAS OPEN. The pump opens a turn when the plan in flight is down to `PLAN_LOW_WATER_NODES` (`8e8e625f`), so the
 * next plan is written from a snapshot read while the previous programme was still working - and the Mod QUEUES it
 * (`FarmhandBodyProgramController.ProgramWithNodeInFlight`), so its nodes run at least one node later than the picture
 * they were written from. `lookaheadIneligibility` already stated which actions cannot survive that gap, and NOTHING
 * ASKED IT: a `sleep` composed ahead would end a day the body had not finished.
 * </p>
 * <p>
 * WHAT IS DRIVEN HERE IS THE PRODUCTION ASK, in all three of its inputs. The nodes come from `compilePlanScript` (never
 * hand-written), the declarations are the connection state's own `catalogRegistrations`, and the in-flight reading is the
 * ledger's (`programStatusProgress.observe` -> `readInFlightProgrammes`, the reading the pump composes its batch from).
 * The answer is projected through the SAME reader the plan tool returns (`planRefusalAnswer`), because a refusal the
 * answer path cannot see is a refusal that arrives as an error.
 * </p>
 * <p>
 * THE THIRD DIRECTION IS A STATED GAP, NOT AN OVERSIGHT: a `movement` leg declares no scene binding, so a cross-map leg
 * stays composable here and is caught by the queued-tile subtraction instead. That residual is PRINTED beside the
 * verdict rather than left to be inferred, because the failure directions are asymmetric - an action wrongly excluded is
 * planned one turn later, an action wrongly included is planned THROUGH a day.
 * </p>
 */

const hostRoot = fileURLToPath(new URL("../..", import.meta.url));

const SURFACE = JSON.parse(
  readFileSync(
    join(hostRoot, "../integrations/stardew/action-development/contracts/generated/action-surface.v1.json"),
    "utf8",
  ),
) as {
  actions: readonly Readonly<{
    actionId: string;
    lifecycle: string;
    kind: string;
    argumentSchema?: Readonly<Record<string, { type: string; enum?: readonly string[] }>>;
    outputFacts?: Readonly<Record<string, string>>;
  }>[];
};

const HANDLER_GROUPS = (
  JSON.parse(
    readFileSync(
      join(hostRoot, "../integrations/stardew/action-development/contracts/generated/action-handler-groups.v1.json"),
      "utf8",
    ),
  ) as { actions: readonly { actionId: string; handlerGroup: string }[] }
).actions;

/** The Mod's own publication of its registrations, with the descriptors the wire carries for each one. */
const REGISTRATIONS: readonly ActionRegistration[] = Object.freeze(
  SURFACE.actions.map((action) =>
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
  ),
);

/** The connection state a submission is judged against: the same two fields `hello_ack` fills. */
const CONNECTION_STATE = Object.freeze({ catalogRegistrations: REGISTRATIONS, catalogRevision: 11 });

const ACTIONS = planActionsFromRegistrations(REGISTRATIONS);

const SNAPSHOT = {
  revision: 11,
  location: "Farm",
  tile: { x: 10, y: 10 },
  stamina: 100,
  health: 100,
  actionable: true,
  exhausted: false,
  capabilities: [],
  catalogRevision: 11,
  enabledActionIds: [],
  presentationLocale: "en-US",
  timeOfDay: 600,
  dayOfMonth: 1,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
} as Snapshot;

const PROGRAMME_IN_FLIGHT = "plan_200_aaaaaaaaaaaaaaaa";

/** The nodes a script compiles to, so no case here writes a node the compiler would not. */
function planNodes(script: string): readonly Readonly<{ nodeId: string; actionId: string }>[] {
  const compiled = compilePlanScript({ script }, { snapshot: SNAPSHOT, actions: ACTIONS });
  if (compiled.status === "refused") assert.fail(`expected a plan, received ${compiled.reasonCode}`);
  return compiled.program.nodes;
}

/**
 * One programme the journal still calls `active`, with `settled` nodes done and `remaining` still to run.
 *
 * WRITTEN INTO THE LEDGER THE PUMP READS, through the one method every receiver of a status payload calls, so the
 * reading this test is judged on is the production reading rather than a stand-in for it.
 */
function readLedgerAfter(settled: number, remaining: number): void {
  const row = (nodeId: string, state: string): Readonly<Record<string, unknown>> =>
    Object.freeze({ nodeId, state, nodeAttempt: 1, admissionAttempt: 1, actionId: "till_soil" });
  programStatusProgress.observe({
    code: "found",
    snapshot: Object.freeze({
      programId: PROGRAMME_IN_FLIGHT,
      state: "active",
      catalogRevision: 11,
      stopEpoch: 0,
      eventHighWater: settled + remaining,
      nodes: Object.freeze([
        ...Array.from({ length: settled }, (_, index) => row(`n_done_${String(index)}`, "succeeded")),
        ...Array.from({ length: remaining }, (_, index) => row(`n_wait_${String(index)}`, "pending")),
      ]),
    }),
    programs: null,
    programCount: 1,
  });
}

/** The programme stops being news: the ledger keeps a programme only while the journal calls it `active`. */
function forgetProgramme(): void {
  programStatusProgress.observe({
    code: "found",
    snapshot: Object.freeze({
      programId: PROGRAMME_IN_FLIGHT,
      state: "succeeded",
      catalogRevision: 11,
      stopEpoch: 0,
      eventHighWater: 1,
      nodes: Object.freeze([]),
    }),
    programs: null,
    programCount: 1,
  });
}

/** What the plan answer says about a refusal: the projection `stardew_plan_work` hands the companion. */
function refusalAnswer(refusal: NonNullable<ReturnType<typeof planLookaheadRefusalForSubmission>>) {
  assert.equal(
    validateBodyProgramSubmitResult(refusal),
    null,
    "a refusal that does not satisfy the wire's own submit frame is one no reader on the other side accepts",
  );
  const answer = planRefusalAnswer(refusal.verification, refusal.code) as {
    readonly verification: {
      readonly catalogRevision: number | null;
      readonly rejectedNodeIds: readonly string[];
      readonly diagnostics: readonly Readonly<{
        readonly code: string;
        readonly nodeId: string | null;
        readonly message: string;
      }>[];
      readonly diagnosticsCount: number;
    };
  };
  return { result: refusal, verification: answer.verification };
}

test("a_plan_is_not_composed_ahead_of_a_programme_in_flight: a sleep is refused by name and by group", () => {
  const nodes = planNodes("builder.sleep({});");
  try {
    readLedgerAfter(1, 2);
    assert.deepEqual(
      readInFlightProgrammes().programmes.map((programme) => programme.remaining),
      [2],
      "the ledger's own reading, taken before the rule is asked: one programme, two nodes left",
    );
    const refusal = planLookaheadRefusalForSubmission(CONNECTION_STATE, nodes);
    assert.notEqual(refusal, null, "a day-moving action is refused while another programme still has nodes to run");
    const { result, verification } = refusalAnswer(refusal!);
    assert.equal(result.code, "rejected", "the submission is refused, not failed");
    assert.equal(result.snapshot, null, "a refusal has no program, so it has no state to report");
    assert.equal(verification.catalogRevision, 11, "the refusal says which catalogue it was judged against");
    assert.deepEqual(verification.rejectedNodeIds, ["n01"], "the node to edit is named, not the whole program");
    assert.deepEqual(
      verification.diagnostics.map((diagnostic) => [diagnostic.nodeId, diagnostic.code]),
      [["n01", "plan_action_not_composable_ahead:sleep:world_lifecycle"]],
      "the exact refusal text: what refused it, which action, and which group - not a bare 'not composable'",
    );
    assert.match(
      verification.diagnostics[0]?.message ?? "",
      /still has nodes to run/u,
      "and the message says WHY, so the correction is one edit rather than a guess",
    );
  } finally {
    forgetProgramme();
  }
});

test("a_plan_is_not_composed_ahead_of_a_programme_in_flight: the same sleep composes when nothing is in flight", () => {
  const nodes = planNodes("builder.sleep({});");
  forgetProgramme();
  assert.deepEqual(readInFlightProgrammes().programmes, [], "the world this case states: no programme in flight");
  assert.equal(
    planLookaheadRefusalForSubmission(CONNECTION_STATE, nodes),
    null,
    "the first plan of a day has no lookahead context, and its last action may be the sleep that ends it",
  );
  // The boundary between "a programme is in the ledger" and "a programme still has work": a plan whose nodes have all
  // happened is a settlement the watch still owes, not work a next plan would queue behind.
  try {
    readLedgerAfter(2, 0);
    assert.deepEqual(
      readInFlightProgrammes().programmes.map((programme) => programme.remaining),
      [0],
      "the ledger still lists the programme, with nothing left",
    );
    assert.equal(
      planLookaheadRefusalForSubmission(CONNECTION_STATE, nodes),
      null,
      "and with no node left to run there is nothing to be one node behind",
    );
  } finally {
    forgetProgramme();
  }
});

test("a_plan_is_not_composed_ahead_of_a_programme_in_flight: a movement leg with no scene binding composes, and the residual is printed", () => {
  const nodes = planNodes("builder.move_to_tile({ x: 12, y: 9 });");
  try {
    readLedgerAfter(1, 2);
    assert.equal(
      planLookaheadRefusalForSubmission(CONNECTION_STATE, nodes),
      null,
      "a walk inside the map is composable from a slightly older picture - the Mod re-validates the tile on the game thread",
    );
    // THE RESIDUAL, printed where the verdict is: the movement legs this rule cannot name, because a `movement` action
    // declares no `sceneTarget`. A cross-map leg is the case the queued-tile subtraction catches instead.
    const residual = HANDLER_GROUPS.filter((row) => row.handlerGroup === "movement")
      .map((row) => row.actionId)
      .filter((actionId) => lookaheadIneligibility({ actionId }) === undefined)
      .sort();
    assert.ok(
      residual.includes("move_to_tile") && residual.includes("travel"),
      `a movement leg must be in the residual this rule names: got ${residual.join(", ")}`,
    );
    console.log(
      `a_plan_is_not_composed_ahead_of_a_programme_in_flight: examined ${String(nodes.length)} node(s) against ` +
        `${String(readInFlightProgrammes().programmes.length)} programme(s) in flight · residual: movement legs ` +
        `composable ahead (${residual.join(", ")})`,
    );
  } finally {
    forgetProgramme();
  }
});

test("a_plan_is_not_composed_ahead_of_a_programme_in_flight: a declared scene binding is read from the descriptor", () => {
  // `action-handler-groups.v1.json` names the day and modal groups, and NO artifact publishes a scene binding - the live
  // `hello_ack` does (`descriptor-wire-keys.test.ts`). So the third arm can only be driven from the wire's own
  // descriptor shape, which is what a real `hello_ack` hands the same reader.
  const sceneBound = Object.freeze({
    actionId: "pickup_forage",
    familyId: "fixture_family",
    identityVersion: 1,
    lifecycle: "published" as const,
    kind: "execution" as const,
    descriptor: {
      sceneTarget: { type: "identity", version: 1, required: true, requiredProperties: ["targetId"] },
    },
  });
  const nodes = planNodes(
    'builder.pickup_forage({ x: 12, y: 9, expectedQualifiedItemId: "(O)22", expectedTargetId: "forage_x" });',
  );
  assert.equal(nodes[0]?.actionId, "pickup_forage");
  try {
    readLedgerAfter(1, 2);
    const refusal = planLookaheadRefusalForSubmission(
      { catalogRegistrations: [sceneBound], catalogRevision: 11 },
      nodes,
    );
    assert.equal(
      refusal?.verification.diagnostics[0]?.code,
      "plan_action_not_composable_ahead:pickup_forage:scene_target",
      "an action bound to a scene somebody read is not composed from a scene that has since moved",
    );
    assert.equal(
      planLookaheadRefusalForSubmission(CONNECTION_STATE, nodes),
      null,
      "and the same action without the declaration is eligible: the rule reads the descriptor, not an id list",
    );
    forgetProgramme();
    assert.equal(
      planLookaheadRefusalForSubmission({ catalogRegistrations: [sceneBound], catalogRevision: 11 }, nodes),
      null,
      "and with nothing in flight the declaration does not refuse it either",
    );
  } finally {
    forgetProgramme();
  }
});

test("a_plan_is_not_composed_ahead_of_a_programme_in_flight: the submission path asks the rule before it reaches the port", () => {
  // THE RULE HAD NO CALLER, which is the whole defect: `lookaheadIneligibility` was written, gated against the Mod's own
  // artifact, and asked by nothing - so the pump's low-water wake-up changed when a plan is WRITTEN without changing what
  // it may contain. This is the assertion that the production path asks it, and asks it as a REFUSAL.
  const materializer = join(
    hostRoot,
    "src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts",
  );
  const { shape } = readSourceShape(materializer);
  const submission = shape.slice(shape.indexOf("const submitProgram = async"), shape.indexOf("const submitTool = "));
  assert.ok(submission.length > 0, "the one submission path `submitProgram` was not found by name");
  const asked = submission.indexOf("planLookaheadRefusalForSubmission(connection.state, request.nodes)");
  const port = submission.indexOf("port.submit(");
  assert.ok(asked > 0, "submitProgram asks the lookahead rule of the nodes it is about to submit");
  assert.ok(port > asked, "and asks it BEFORE the port, or the program is already in the Mod's journal");
  assert.match(
    submission,
    /if \(ahead !== null\) return toolResult\(ahead, null\);/u,
    "a refusal RETURNS the Mod's own refused frame - thrown, it reads as a broken call and the answer loses the node",
  );
  assert.doesNotMatch(
    submission,
    /throw new Error\("plan_action_not_composable_ahead/u,
    'the refusal is not thrown: "not composable" is an answer about the plan, not a failure of the Host',
  );
});
