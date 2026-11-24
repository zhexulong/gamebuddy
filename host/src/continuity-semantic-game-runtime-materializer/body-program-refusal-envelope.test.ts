import assert from "node:assert/strict";
import test from "node:test";

import { HostNodeAdmissionService } from "../action-execution-coordinator.internal.js";
import {
  type BodyProgramRefusal,
  bodyProgramRefusalText,
  UNKNOWN_REFUSAL_FIELD,
} from "../body-program-preflight.js";
import type { GameConnection } from "../game-connection.js";
import {
  createIntegrationActionCatalog,
  DEFAULT_INTEGRATION_ACTION_POLICY,
  type GameIntegrationAdapter,
  type IntegrationStateView,
} from "../game-integration-adapter.js";
import type { BodyNodeAdmissionChallenge, FarmhandPolicyIdentity } from "../protocol.js";
import { StardewLogicalActionRecoveryJournal } from "../stardew-logical-action-recovery-journal.js";
import {
  bodyProgramSubmissionRefusal,
  createStardewBodyNodeAdmissionValidator,
} from "./continuity-semantic-game-runtime-materializer.js";

/**
 * A REFUSAL IS READ BY SOMEONE WHO HAS TO FIX SOMETHING, so it states the clause, the node, the action and the two values
 * that disagreed - in one spelling, whichever layer answered.
 *
 * <p>
 * THE DEFECT THIS FILE PINS, measured: `continuity-semantic-game-runtime-materializer.ts` refused every submission of a
 * runtime whose attached Mod had republished its policy identity with a bare `Error("body_program_preflight_rejected")`.
 * The model learned that the batch was refused and nothing about why, so it degraded to single steps - 2026-10-22, seven
 * of those codes in one session file beside two hundred single steps. Nothing about the per-node check was wrong; the
 * words were.
 * </p>
 * <p>
 * It drives the PRODUCTION seam (`bodyProgramSubmissionRefusal`, the one `submitProgram` calls, and the production
 * admission service), never a re-implementation of the refusal, so the test cannot agree with itself while the materializer
 * answers something else.
 * </p>
 */

const POLICY_IDENTITY: FarmhandPolicyIdentity = Object.freeze({
  value: "0123456789abcdef0123456789abcdef",
  capabilityRevision: 7,
});

/** The identity the attached Mod publishes AFTER the runtime mounted: same shape, different policy. */
const REPUBLISHED_IDENTITY: FarmhandPolicyIdentity = Object.freeze({
  value: "fedcba9876543210fedcba9876543210",
  capabilityRevision: 8,
});

const REGISTRATIONS = Object.freeze([
  Object.freeze({
    actionId: "till_soil",
    familyId: "fixture_family",
    identityVersion: 1,
    lifecycle: "published" as const,
    kind: "execution" as const,
  }),
  Object.freeze({
    actionId: "equip_tool",
    familyId: "fixture_family",
    identityVersion: 1,
    lifecycle: "published" as const,
    kind: "execution" as const,
  }),
]);

/** One connection over one published identity, with the Host's own action-catalog projection underneath. */
function connectionPublishing(
  policyIdentity: FarmhandPolicyIdentity,
  enabledActionIds: readonly string[] = ["till_soil", "equip_tool"],
): GameConnection {
  const state: IntegrationStateView = Object.freeze({
    connected: true,
    sessionId: "session_01",
    capabilities: Object.freeze([]),
    enabledActionIds: Object.freeze(enabledActionIds),
    catalogRevision: 11,
    capabilityRevision: policyIdentity.capabilityRevision,
    policyIdentity,
    registrations: REGISTRATIONS,
    snapshotRevision: null,
    activeExecution: null,
    latestReceipt: null,
    latestReasonCode: null,
  });
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

/** One `key=value;…` refusal as the fields it states, so a case asserts facts rather than substrings. */
function refusalFields(sentence: string): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  for (const pair of sentence.split(";")) {
    const separator = pair.indexOf("=");
    assert.ok(separator > 0, `every part of a refusal is one key=value pair, received \`${pair}\` in \`${sentence}\``);
    fields[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return Object.freeze(fields);
}

function submissionRefusal(nodes: unknown, connection: GameConnection): Readonly<Record<string, string>> {
  const refusal = bodyProgramSubmissionRefusal(
    connection,
    DEFAULT_INTEGRATION_ACTION_POLICY,
    POLICY_IDENTITY,
    nodes,
  );
  assert.ok(refusal !== null, "the fixture must be refused, or this case asserts nothing");
  return refusalFields(refusal);
}

/** A node as the wire carries it: the plan compiler's shape, with nothing the fixture invented. */
function node(actionId: string, arguments_: Record<string, unknown> = {}, nodeId = "n01"): Record<string, unknown> {
  return { nodeId, actionId, arguments: arguments_, dependsOn: [], bindings: {} };
}

/**
 * THE LINE THAT SWALLOWED THE REASON. The runtime mounted one policy identity; the Mod published another. Every refusal
 * must state which two values disagreed, and that no node is to blame - so the companion edits its plan or its runtime,
 * not the wrong one of the two.
 */
test("a moved policy identity answers which identity moved, not that the batch was refused", () => {
  const fields = submissionRefusal([node("till_soil")], connectionPublishing(REPUBLISHED_IDENTITY));
  assert.equal(fields.rejectionCode, "policy_identity_mismatch");
  assert.equal(fields.field, "policy_identity", "the delta names the comparison the clause made");
  assert.equal(
    fields.expected,
    `${POLICY_IDENTITY.value}@${String(POLICY_IDENTITY.capabilityRevision)}`,
    "the expected side is the identity this RUNTIME mounted - the refusing layer's own value, never the Mod's",
  );
  assert.equal(
    fields.actual,
    `${REPUBLISHED_IDENTITY.value}@${String(REPUBLISHED_IDENTITY.capabilityRevision)}`,
    "the actual side is the identity the connection published now, both halves of it",
  );
  assert.equal(fields.node, "none", "no node is named, because this clause judged the connection and not a node");
  assert.equal(fields.action, "none");
  assert.match(fields.remedy ?? "", /re-attached/u, "the remedy names the only thing that clears this clause");
});

/**
 * THE PER-NODE ARM, which stayed and still judges every node: the refusal names the node, the action and the field the
 * clause read - the form document the node carries, which no catalogue can make runnable.
 */
test("a refused node answers its own node, action and the field the clause judged", () => {
  const fields = submissionRefusal(
    [node("till_soil", { loop: { type: "loop", source: { area: { x: 0, y: 0, w: 2, h: 1 } }, do: null } })],
    connectionPublishing(POLICY_IDENTITY),
  );
  assert.equal(fields.rejectionCode, "plan_form_not_declared");
  assert.equal(fields.node, "n01");
  assert.equal(fields.action, "till_soil");
  assert.equal(fields.field, "arguments.loop", "the clause read the node's own form document, and says so");
  assert.equal(fields.actual, "present");
  assert.ok((fields.remedy ?? "").length > 0, "a refusal the caller can act on carries a remedy");
});

/** The same arm for an id this connection does not offer: the node's own action id is the reading that fired. */
test("an action this connection does not offer answers the action id it read", () => {
  const fields = submissionRefusal([node("equip_tool")], connectionPublishing(POLICY_IDENTITY, ["till_soil"]));
  assert.equal(fields.rejectionCode, "action_not_enabled");
  assert.equal(fields.field, "actionId");
  assert.equal(fields.expected, "enabled");
  assert.equal(fields.actual, "equip_tool", "the value is the node's own action id, not a guess at the catalogue's");
  assert.equal(fields.node, "n01");
});

/**
 * NEVER INVENT A VALUE. A layer that refused without comparing a field it can name says `field=unknown` and lets
 * `rejectionCode` carry the clause; the renderer states the absent sides as `none` so an absent value cannot be read as a
 * real one. This is the shape the Mod answers a Host-`policy_denied` rejection with.
 */
test("a clause that compared no field names itself instead of inventing a value", () => {
  const refusal: BodyProgramRefusal = Object.freeze({
    rejectionCode: "policy_denied",
    failedNodeId: "n02",
    failedAction: "for_each",
    delta: Object.freeze({ field: UNKNOWN_REFUSAL_FIELD, expected: null, actual: null, remedy: "resubmit the node" }),
  });
  const fields = refusalFields(bodyProgramRefusalText(refusal));
  assert.equal(fields.field, "unknown");
  assert.equal(fields.expected, "none", "an absent reading is stated as absent, never as a number");
  assert.equal(fields.actual, "none");
  assert.equal(fields.rejectionCode, "policy_denied", "the clause is still named, even when it compared nothing");
  assert.equal(fields.node, "n02");
  assert.equal(fields.action, "for_each");
});

/** The admission answer names a moved identity too: it used to answer the bare `admission_unavailable` a throw became. */
test("a moved identity is answered unavailable BY NAME rather than as a bare unavailable", async () => {
  const service = new HostNodeAdmissionService(
    new StardewLogicalActionRecoveryJournal(),
    createStardewBodyNodeAdmissionValidator(
      connectionPublishing(REPUBLISHED_IDENTITY),
      DEFAULT_INTEGRATION_ACTION_POLICY,
      POLICY_IDENTITY,
    ),
  );
  assert.deepEqual(await service.admit(challenge()), {
    result: "unavailable",
    code: "admission_unavailable:policy_identity_mismatch",
  });
});

/** THE POSITIVE HALF: an admitted node's answer is the grant it always was, with no refusal field beside it. */
test("an admitted node's answer is unchanged", async () => {
  const journal = new StardewLogicalActionRecoveryJournal();
  const answer = await new HostNodeAdmissionService(
    journal,
    createStardewBodyNodeAdmissionValidator(
      connectionPublishing(POLICY_IDENTITY),
      DEFAULT_INTEGRATION_ACTION_POLICY,
      POLICY_IDENTITY,
    ),
  ).admit(challenge());
  assert.equal(answer.result, "granted");
  if (answer.result !== "granted") return;
  assert.equal(answer.grant.programId, "program_01");
  assert.equal(answer.grant.nodeId, "n01");
  assert.equal(answer.grant.actionId, "till_soil");
  assert.equal(answer.grant.attachmentGeneration, "session_01");
  assert.deepEqual(Object.keys(answer.grant).sort(), [
    "actionId",
    "admissionAttempt",
    "attachmentGeneration",
    "canonicalBoundArgs",
    "catalogRevision",
    "deadlineMs",
    "derivedResourceClaims",
    "executionBinding",
    "grantId",
    "nodeAttempt",
    "nodeId",
    "policyIdentity",
    "policyRevision",
    "programId",
    "stopEpoch",
  ]);
});

function challenge(): BodyNodeAdmissionChallenge {
  return Object.freeze({
    programId: "program_01",
    nodeId: "n01",
    nodeAttempt: 1,
    admissionAttempt: 1,
    stopEpoch: 0,
    catalogRevision: 11,
    policyIdentity: POLICY_IDENTITY,
    actionId: "till_soil",
    canonicalBoundArgs: Object.freeze({}),
    derivedResourceClaims: Object.freeze({ embodied_actor: "player_01" }),
    deadlineMs: Date.now() + 60_000,
  });
}
