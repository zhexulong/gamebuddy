import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HostNodeAdmissionService } from "../action-execution-coordinator.internal.js";
import {
  FOR_EACH_PLAN_ACTION_ID,
  PLAN_FORM_ACTION_IDS,
  type CompiledPlan,
  compilePlanScript,
  planActionsFromRegistrations,
} from "../body-program-script.js";
import { MAX_FOR_EACH_LOOP_DOCUMENT_CHARS, readForEachLoop } from "../body-program-for-each.js";
import {
  DEFAULT_INTEGRATION_ACTION_POLICY,
  type GameIntegrationAdapter,
  type IntegrationActionRegistration,
  type IntegrationStateView,
  createIntegrationActionCatalog,
} from "../game-integration-adapter.js";
import type { GameConnection } from "../game-connection.js";
import type { ActionRegistration, BodyNodeAdmissionChallenge, FarmhandPolicyIdentity, Snapshot } from "../protocol.js";
import { StardewLogicalActionRecoveryJournal } from "../stardew-logical-action-recovery-journal.js";
import { createStardewBodyNodeAdmissionValidator } from "./continuity-semantic-game-runtime-materializer.js";

/**
 * NODE ADMISSION ADMITS A LOOP THE WAY THE PREFLIGHT DOES, because it asks the same decision.
 *
 * <p>
 * MEASURED 2026-11-10, verbatim from a finished run. The companion wrote the only `for_each` of the run - the second time
 * it has ever written one -
 * `builder.for_each({ source: { area: { x: 60, y: 9, w: 1, h: 2 } }, do: { action: "water_crop" } })` - and the whole
 * answer was `rejected: policy_denied`. The preflight had already been taught that a plan FORM is not an action
 * (`d66d86d4`), and so had the Mod's verifier (`97ca30aa`); admission had not, so it tested the node's action id against
 * the action catalogue and refused the one construct that can address a patch in one plan.
 * </p>
 * <p>
 * So this drives the REAL admission path - `HostNodeAdmissionService` with the production validator over a compiled plan -
 * and asserts the three facts the fix has to keep true: a form is admitted as a form, its rows still answer to the live
 * policy BY NAME, and an ordinary action the connection does not offer is still `policy_denied`. The node is built by
 * `compilePlanScript`, never hand-written, so the test cannot agree with admission while the compiler writes something
 * else.
 * </p>
 */

/** The repository's `host/` root: both the source and the compiled file sit two directories inside it. */
const hostRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
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

/** The attached Mod's hello: every published action, plus the plan form it appends to the same catalog pair. */
const REGISTRATIONS: readonly IntegrationActionRegistration[] = Object.freeze([
  ...SURFACE.map((action) =>
    Object.freeze({
      actionId: action.actionId,
      familyId: "fixture_family",
      identityVersion: 1,
      lifecycle: action.lifecycle as ActionRegistration["lifecycle"],
      kind: action.kind as ActionRegistration["kind"],
    }),
  ),
  Object.freeze({
    actionId: FOR_EACH_PLAN_ACTION_ID,
    familyId: "plan_forms",
    identityVersion: 1,
    lifecycle: "published" as const,
    kind: "execution" as const,
  }),
]);

const ACTIONS = planActionsFromRegistrations(
  SURFACE.map((action) =>
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

const POLICY_IDENTITY: FarmhandPolicyIdentity = Object.freeze({
  value: "0123456789abcdef0123456789abcdef",
  capabilityRevision: 7,
});

/** What this connection offers: only these ids are live, and the form is deliberately not one of them. */
function stateOffering(enabledActionIds: readonly string[]): IntegrationStateView {
  return Object.freeze({
    connected: true,
    sessionId: "session_01",
    capabilities: Object.freeze([]),
    enabledActionIds: Object.freeze(enabledActionIds),
    catalogRevision: 11,
    capabilityRevision: POLICY_IDENTITY.capabilityRevision,
    policyIdentity: POLICY_IDENTITY,
    registrations: REGISTRATIONS,
    snapshotRevision: null,
    activeExecution: null,
    latestReceipt: null,
    latestReasonCode: null,
  });
}

/**
 * One connection over one state, with the Host's own action-catalog projection underneath.
 *
 * `visibleActions` is the production projection (`createIntegrationActionCatalog`), not a hand-written answer, so what
 * "this connection offers" means here is what it means in the materializer.
 */
function connectionOffering(enabledActionIds: readonly string[]): GameConnection {
  const state = stateOffering(enabledActionIds);
  const adapter: GameIntegrationAdapter = {
    descriptor: Object.freeze({ integrationId: "stardew", version: "fixture-v1", toolNamePrefix: "stardew_" }),
    actionCatalog: createIntegrationActionCatalog(enabledActionIds.map((actionId) => ({ actionId }))),
    defaultPolicy: DEFAULT_INTEGRATION_ACTION_POLICY,
    parsePolicy: (value: unknown) => value as never,
    actorId: () => "player_01",
    assertIdentityBinding: () => undefined,
    worldScope: () => null,
    createToolSet: () => ({ observation: [], actions: [], knowledge: [] }),
    knowledgeMetadata: () => ({ mounted: false, gameVersion: null, bundleVersion: null }),
    status: () => ({
      connected: true,
      capabilities: [],
      capabilityRevision: null,
      snapshotRevision: null,
      latestReceiptState: null,
      latestReasonCode: null,
    }),
    readState: () => state,
    cancelExecution: () => "cancelled",
    parseReceipt: () => null,
    actionIdForToolName: () => null,
    isCancellationTool: () => false,
  };
  return { scope: { integrationId: "stardew" }, executionGate: { executable: true }, module: adapter, state };
}

type PlanNode = Record<string, unknown> & { arguments: Record<string, unknown> };

function compiledNode(script: string): PlanNode {
  const compiled: CompiledPlan = compilePlanScript({ script }, { snapshot: SNAPSHOT, actions: ACTIONS });
  if (!compiled.ok) assert.fail(`expected a plan, received ${compiled.reasonCode}`);
  assert.equal(compiled.program.nodes.length, 1, "each case here is one node");
  return compiled.program.nodes[0] as unknown as PlanNode;
}

/**
 * The arguments the Mod sends back with one node's admission challenge.
 *
 * The compiled form node carries the loop as the runtime value `{ type: "loop", ... }`; the Mod drops that tag at the one
 * boundary that knows it (`FarmhandForEachArguments.TryCanonicalize`) and the document travels as the `string` argument
 * the form declares. Derived from the COMPILED node, and checked against the wire's own bound on that string, so the
 * challenge this test admits is the challenge production admits.
 */
function canonicalArgumentsOf(node: PlanNode): Readonly<Record<string, unknown>> {
  const value = node.arguments.loop;
  if (value === undefined) return node.arguments;
  const { type, ...document } = value as Record<string, unknown>;
  assert.equal(type, "loop", "the compiler tags the form's one argument as a runtime value");
  const reading = readForEachLoop(document, null);
  if (!reading.ok) assert.fail(`the compiled loop must be a loop this Host can read: ${reading.code}`);
  const canonicalValue = JSON.stringify(reading.loop);
  assert.ok(
    canonicalValue.length <= MAX_FOR_EACH_LOOP_DOCUMENT_CHARS,
    "the document must fit the canonical string the wire carries it back in",
  );
  return Object.freeze({ loop: Object.freeze({ type: "string", canonicalValue }) });
}

function challengeOf(node: PlanNode): BodyNodeAdmissionChallenge {
  return Object.freeze({
    programId: "program_01",
    nodeId: String(node.nodeId),
    nodeAttempt: 1,
    admissionAttempt: 1,
    stopEpoch: 0,
    catalogRevision: 11,
    policyIdentity: POLICY_IDENTITY,
    actionId: String(node.actionId),
    canonicalBoundArgs: canonicalArgumentsOf(node) as BodyNodeAdmissionChallenge["canonicalBoundArgs"],
    derivedResourceClaims: Object.freeze({ embodied_actor: "player_01" }),
    deadlineMs: Date.now() + 60_000,
  });
}

/** One node, admitted through the real service and the production validator, into the world this case states. */
async function admit(
  node: PlanNode,
  enabledActionIds: readonly string[],
): Promise<Awaited<ReturnType<HostNodeAdmissionService["admit"]>>> {
  const service = new HostNodeAdmissionService(
    new StardewLogicalActionRecoveryJournal(),
    createStardewBodyNodeAdmissionValidator(
      connectionOffering(enabledActionIds),
      DEFAULT_INTEGRATION_ACTION_POLICY,
      POLICY_IDENTITY,
    ),
  );
  return await service.admit(challengeOf(node));
}

/**
 * THE MEASURED CASE. The compiled loop's action id is a form, which the action catalogue can never offer, and admission
 * must admit it as a form - the same answer the preflight gives (`body-program-preflight.test.ts`).
 */
test("a loop is admitted at node admission the same way it is admitted at preflight", async () => {
  const node = compiledNode(
    'builder.for_each({ source: { area: { x: 60, y: 9, w: 1, h: 2 } }, do: { action: "water_crop" } });',
  );
  assert.equal(node.actionId, FOR_EACH_PLAN_ACTION_ID);
  assert.ok(PLAN_FORM_ACTION_IDS.includes(FOR_EACH_PLAN_ACTION_ID));
  // Both of the loop's own ids are live. The form is not one of them: it is not an action, which is why the catalogue
  // test refused the run's only loop.
  const enabled = Object.freeze(["water_crop", "till_soil"]);
  assert.equal(enabled.includes(FOR_EACH_PLAN_ACTION_ID), false);
  const admitted = await admit(node, enabled);
  assert.equal(admitted.result, "granted", `admission refused a preflighted loop: ${JSON.stringify(admitted)}`);
  if (admitted.result === "granted") assert.equal(admitted.grant.actionId, FOR_EACH_PLAN_ACTION_ID);
});

/** The rows are what the live policy governs, and the refusal names the row rather than the form or the policy at large. */
test("a loop whose row names an action this connection does not offer is refused by name", async () => {
  const node = compiledNode(
    'builder.for_each({ source: { area: { x: 60, y: 9, w: 1, h: 2 } }, do: { action: "till_soil" } });',
  );
  assert.deepEqual(await admit(node, ["water_crop"]), {
    result: "rejected",
    code: "row_action_not_enabled:till_soil",
  });
});

/** The ordinary node keeps the word it had: this fix changed what a FORM is, not what an action is. */
test("an action this connection does not offer is still refused policy_denied", async () => {
  const node = compiledNode('builder.water_crop({ x: 60, y: 9, expectedTargetId: "crop_deadbeef" });');
  assert.equal(node.actionId, "water_crop");
  assert.deepEqual(await admit(node, ["till_soil"]), { result: "rejected", code: "policy_denied" });
});

/**
 * The decision must be the one the admission path asks, or the fix is a library nobody calls - and the second
 * implementation it replaced must not survive anywhere.
 */
test("the admission path asks the preflight's decision instead of testing a node against the catalogue inline", () => {
  const source = readFileSync(MATERIALIZER_PATH, "utf8");
  assert.ok(source.includes("bodyProgramNodeAdmissionRefusal("), "node admission must ask the declared decision");
  assert.ok(
    source.includes("createStardewBodyNodeAdmissionValidator("),
    "the service must be built from the validator this test drives",
  );
  assert.equal(
    source.includes("visible.find("),
    false,
    "the action-catalogue lookup admission did for itself is the defect: it cannot survive beside the one decision",
  );
});
