import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HostNodeAdmissionService } from "../action-execution-coordinator.internal.js";
import {
  type CompiledPlan,
  compilePlanScript,
  planActionsFromRegistrations,
} from "../body-program-script.js";
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
 * NODE ADMISSION ASKS THE PREFLIGHT'S DECISION, and this drives the REAL admission path - `HostNodeAdmissionService`
 * with the production validator over a compiled plan.
 *
 * <p>
 * MEASURED 2026-11-10, verbatim from a finished run: admission answered `rejected: policy_denied` for the run's only plan
 * form node. The preflight had already been taught that a plan FORM is not an action (`d66d86d4`); admission had not, so
 * it tested the node's action id against the action catalogue - a second implementation of one decision.
 * </p>
 * <p>
 * THE FORM IS GONE and the decision is not: a node carrying a form's document is still refused by name, and an ordinary
 * action this connection does not offer is still `policy_denied`. The node is built by `compilePlanScript`, never
 * hand-written, so the test cannot agree with admission while the compiler writes something else.
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

/** The attached Mod's hello: every published action. There is no plan form to append, because the Host compiles none. */
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

/** What this connection offers: only these ids are live. */
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
 * Every argument on a compiled node is a scalar or a destination selector, so the challenge carries the node's own
 * arguments unchanged - which is the whole reason the wire has one runtime-value shape rather than a declarative kind
 * beside it.
 */
function canonicalArgumentsOf(node: PlanNode): Readonly<Record<string, unknown>> {
  return node.arguments;
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

/** An action this connection does not offer is refused by the one decision the preflight also asks. */
test("an action this connection does not offer is still refused policy_denied", async () => {
  const node = compiledNode('builder.water_crop({ x: 60, y: 9, expectedTargetId: "crop_deadbeef", charge: 0 });');
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
