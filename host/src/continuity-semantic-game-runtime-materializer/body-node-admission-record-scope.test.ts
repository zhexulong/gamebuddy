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
  planProgramId,
} from "../body-program-script.js";
import type { GameConnection } from "../game-connection.js";
import {
  createIntegrationActionCatalog,
  DEFAULT_INTEGRATION_ACTION_POLICY,
  type GameIntegrationAdapter,
  type IntegrationStateView,
} from "../game-integration-adapter.js";
import type { ActionRegistration, BodyNodeAdmissionChallenge, FarmhandPolicyIdentity, Snapshot } from "../protocol.js";
import { StardewLogicalActionRecoveryJournal } from "../stardew-logical-action-recovery-journal.js";
import { createStardewBodyNodeAdmissionValidator } from "./continuity-semantic-game-runtime-materializer.js";

/**
 * GATE: `a_durable_admission_record_decides_only_the_attempt_that_wrote_it`.
 *
 * <p>
 * THE DEFECT THIS EXISTS FOR, measured 2026-11-24 (`round99`). `plan_0_01eb956d2f831b31` was a `move_to_tile` then an
 * `enter_exit`, compiled at `snapshotRevision: 0` - the revision every session starts at. A PREVIOUS session of the same
 * save and world had already written a `grant_issued` record for that exact `(program, node, attempt)` tuple under a
 * policy identity that no longer existed, so this session's first node was answered `rejected` in 372 µs with
 * `policy_identity_mismatch`, its second node 50 ms later with the same, the program was durably `failed`, and the only
 * way to run that work was to submit it again under a different id (`plan_1_01eb956d2f831b31`, granted in 2.5 ms).
 * </p>
 * <p>
 * WHY THE ID IS THE LAYER. `HostNodeAdmissionService` has to consult the record - the record is what makes one node
 * attempt get one decision, across a Host restart - and the record's key is the tuple the Mod names. So the fact that
 * was wrong is upstream of it: two sessions' submissions were given the SAME identity, because `planProgramId` derived
 * it from a per-session snapshot revision and the node content alone. A plan compiled in a new session is a new
 * program; an identical re-send inside one session is still the same program. This file measures both halves against the
 * real journal, the real validator and the real service - never against a hand-written id or a stand-in for admission.
 * </p>
 * <p>
 * The wiring is held by the compiler, not by a source reading: `planProgramId` takes the session token as a required
 * positional argument and the materializer's `createBodyProgramTools` takes it as a required parameter, so a Host that
 * forgot to pass one does not typecheck.
 * </p>
 */

const hostRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SURFACE_PATH = resolve(
  hostRoot,
  "../integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
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

const CATALOG_REVISION = 11;
const DEADLINE_MS = Date.now() + 60_000;

/** One authenticated session: the name a plan's identity is scoped by, and the policy identity it admits under. */
type Session = Readonly<{
  token: string;
  attachmentSessionId: string;
  policyIdentity: FarmhandPolicyIdentity;
}>;

const SESSION_A: Session = Object.freeze({
  token: "game_session_a",
  attachmentSessionId: "attachment_a",
  policyIdentity: Object.freeze({ value: "0123456789abcdef0123456789abcdef", capabilityRevision: 7 }),
});

const SESSION_B: Session = Object.freeze({
  token: "game_session_b",
  attachmentSessionId: "attachment_b",
  policyIdentity: Object.freeze({ value: "fedcba9876543210fedcba9876543210", capabilityRevision: 9 }),
});

function stateOf(session: Session): IntegrationStateView {
  return Object.freeze({
    connected: true,
    sessionId: session.attachmentSessionId,
    capabilities: Object.freeze([]),
    enabledActionIds: Object.freeze(ACTIONS.map((action) => action.actionId)),
    catalogRevision: CATALOG_REVISION,
    capabilityRevision: session.policyIdentity.capabilityRevision,
    policyIdentity: session.policyIdentity,
    registrations: REGISTRATIONS,
    snapshotRevision: SNAPSHOT.revision,
    activeExecution: null,
    latestReceipt: null,
    latestReasonCode: null,
  });
}

/** One connection over one session's state, with the Host's own action-catalog projection underneath. */
function connectionOf(session: Session): GameConnection {
  const state = stateOf(session);
  const enabled = ACTIONS.map((action) => ({ actionId: action.actionId }));
  const adapter: GameIntegrationAdapter = {
    descriptor: Object.freeze({ integrationId: "stardew", version: "fixture-v1", toolNamePrefix: "stardew_" }),
    actionCatalog: createIntegrationActionCatalog(enabled),
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

/** The compiler's own node, so nothing here re-spells a shape the plan's identity is computed from. */
type PlanNode = Extract<CompiledPlan, { status: "compiled" }>["program"]["nodes"][number];

/** The one node every case here submits, built by the production compiler rather than written by hand. */
function compiledPlan(script: string): Readonly<{ node: PlanNode; snapshotRevision: number }> {
  const compiled: CompiledPlan = compilePlanScript({ script }, { snapshot: SNAPSHOT, actions: ACTIONS });
  if (compiled.status === "refused") assert.fail(`expected a plan, received ${compiled.reasonCode}`);
  assert.equal(compiled.program.nodes.length, 1, "each case here is one node");
  return Object.freeze({ node: compiled.program.nodes[0]!, snapshotRevision: compiled.snapshotRevision });
}

function challengeOf(
  session: Session,
  programId: string,
  node: PlanNode,
  deadlineMs: number,
): BodyNodeAdmissionChallenge {
  return Object.freeze({
    programId,
    nodeId: node.nodeId,
    nodeAttempt: 1,
    admissionAttempt: 1,
    stopEpoch: 0,
    catalogRevision: CATALOG_REVISION,
    policyIdentity: session.policyIdentity,
    actionId: node.actionId,
    canonicalBoundArgs: node.arguments as BodyNodeAdmissionChallenge["canonicalBoundArgs"],
    derivedResourceClaims: Object.freeze({ embodied_actor: "player_01" }),
    deadlineMs,
  });
}

/** The production service over one session's connection - the same construction the materializer performs. */
function serviceOf(journal: StardewLogicalActionRecoveryJournal, session: Session): HostNodeAdmissionService {
  return new HostNodeAdmissionService(
    journal,
    createStardewBodyNodeAdmissionValidator(
      connectionOf(session),
      DEFAULT_INTEGRATION_ACTION_POLICY,
      session.policyIdentity,
    ),
  );
}

/**
 * THE GATE. The journal is the durable store both sessions read, exactly as `%LOCALAPPDATA%/GameBuddy/stardew-recovery/`
 * is: one instance, two sessions, the second starting at the same snapshot revision on the same save and world.
 */
test("a durable admission record written by another session does not decide this session's attempt", async () => {
  const journal = new StardewLogicalActionRecoveryJournal();
  const plan = compiledPlan("builder.move_to_tile({ x: 6, y: 8 });");
  const nodes = [plan.node];

  const firstId = planProgramId(SESSION_A.token, plan.snapshotRevision, nodes);
  const first = await serviceOf(journal, SESSION_A).admit(challengeOf(SESSION_A, firstId, plan.node, DEADLINE_MS));
  assert.equal(first.result, "granted", "the first session's attempt is admitted and its record becomes durable");

  // THE SAME PLAN, THE NEXT SESSION. Same save, same world, same content, the same snapshot revision the first session
  // saw - and it must be a NEW program, or the record above answers for work it never judged.
  const secondId = planProgramId(SESSION_B.token, plan.snapshotRevision, nodes);
  assert.notEqual(
    secondId,
    firstId,
    "a_durable_admission_record_decides_only_the_attempt_that_wrote_it: the session is part of a plan's identity, because the snapshot revision is per-session and restarts at 0",
  );
  const second = await serviceOf(journal, SESSION_B).admit(
    challengeOf(SESSION_B, secondId, plan.node, DEADLINE_MS + 1),
  );
  assert.equal(
    second.result,
    "granted",
    `the second session's attempt is admitted on its own merits, and its answer is its own: received ${JSON.stringify(second)}`,
  );
  assert.equal(
    second.result === "granted" ? second.grant.attachmentGeneration : null,
    SESSION_B.attachmentSessionId,
    "the grant is issued against the SECOND session's own attachment, so the record it writes belongs to that session and no other",
  );
});

/**
 * THE OTHER HALF OF THE SAME RULE. Scoping the identity by the session must not cost the idempotency the identity
 * exists for: a model that re-sends the same plan inside one session is answered the SAME grant, not a second one.
 */
test("the same plan re-sent inside one session keeps its identity and is answered the same grant", async () => {
  const journal = new StardewLogicalActionRecoveryJournal();
  const plan = compiledPlan("builder.move_to_tile({ x: 6, y: 8 });");
  const programId = planProgramId(SESSION_A.token, plan.snapshotRevision, [plan.node]);
  const service = serviceOf(journal, SESSION_A);

  const first = await service.admit(challengeOf(SESSION_A, programId, plan.node, DEADLINE_MS));
  const again = await service.admit(challengeOf(SESSION_A, programId, plan.node, DEADLINE_MS));

  assert.equal(first.result, "granted");
  assert.deepEqual(
    again,
    first,
    "the durable record replays the decision it already made instead of minting a second one",
  );
});

/**
 * THE LAST LINE OF DEFENCE, and it is a statement rather than a verdict. A model-authored `programId`
 * (`stardew_submit_action_program`) can still name an id another session used, so a record CAN disagree with a live
 * attempt. The answer must then name the fact that decided it - the fields that differ - and must not claim anything
 * about the live policy identity, which is what made the model read `round99`'s rejection as transient and re-submit.
 */
test("a durable record that disagrees names the differing fields instead of the live policy identity", async () => {
  const journal = new StardewLogicalActionRecoveryJournal();
  const plan = compiledPlan("builder.move_to_tile({ x: 6, y: 8 });");
  const programId = planProgramId(SESSION_A.token, plan.snapshotRevision, [plan.node]);

  const first = await serviceOf(journal, SESSION_A).admit(challengeOf(SESSION_A, programId, plan.node, DEADLINE_MS));
  assert.equal(first.result, "granted");

  const answered = await serviceOf(journal, SESSION_B).admit(
    challengeOf(SESSION_B, programId, plan.node, DEADLINE_MS + 5_000),
  );

  assert.equal(answered.result, "rejected", "a conflict with a durable record stays terminal: nothing was admitted");
  assert.equal(
    answered.result === "rejected" ? answered.code : null,
    "admission_record_conflict:deadline:policy_identity",
    "the code names the fields the deciding layer found; `policy_identity_mismatch` claimed a disagreement about the live identity that nothing here found",
  );
});
