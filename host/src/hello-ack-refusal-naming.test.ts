import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseBridgeMessage, newEnvelope, type Scope, validateBridgeMessage } from "./protocol.js";

/**
 * A REFUSED HANDSHAKE NAMES THE MEMBER THAT DRIFTED, NOT ONLY THE FRAME.
 *
 * <p>
 * `round32b` (2026-11-24, pin `c0d3ce83`) died INSIDE the authenticated handshake: the manifest was admitted, the
 * native AI Farmhand was bound (`formal_attachment=True`), the named-pipe bridge was started, and the only leaf the
 * run left was `bridge_disconnected:invalid_hello_ack` in `entry-stderr.log`. The `hello_ack` arm carried fourteen
 * unrelated predicates behind that one code, so the session id, the capability list, the catalog revision, the policy
 * identity, the locale, the runtime attestation, the key set and all 106 registrations were indistinguishable - and
 * the cabin hand-off was answered `409 stardew_cabin_publication_uncertain` with nothing naming what to fix.
 * </p>
 *
 * <p>
 * Two readings, because a fixture and an operator need different halves: the bounded code stays `invalid_hello_ack`
 * for EVERY refusal (the Mod and every wire fixture pin it), and the diagnosis beside it names the first member that
 * drifted, a registration by its action id. This file is the acceptance the bridge's close reason and the run's leaf
 * are both resolved from (`local-stardew-bridge.ts` takes the diagnosis for `invalid_hello_ack` as well as for
 * `invalid_snapshot`).
 * </p>
 *
 * <p>
 * The second test is the member the live run was actually refused for, at the size it was refused at: the pin's own
 * artifact published `use_mine_ladder.expectedTargetId` at 595 characters while `isValidActionDescriptor` admits at
 * most 512 for an argument's sentence, so ONE descriptor was refused and the whole registration list went with it.
 * </p>
 */

const scope: Scope = {
  integrationId: "integration_01",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};
const now = 1_795_557_248_122;

test("a refused hello acknowledgement names the member that drifted, not only the frame", () => {
  const valid = () => ({
    sessionId: "session_01",
    capabilities: ["move_to_tile"],
    catalogRevision: 1,
    policyIdentity: { value: "0123456789abcdef0123456789abcdef", capabilityRevision: 1 },
    enabledActionIds: ["move_to_tile"],
    runtimeRole: "farmhand_client",
    launchGeneration: "generation_01",
    presentationLocale: "en-US",
    registrations: [
      {
        actionId: "move_to_tile",
        familyId: "movement_navigation",
        identityVersion: 1,
        lifecycle: "published",
        kind: "execution",
      },
    ],
  });
  const admitted = newEnvelope("hello_ack", scope, valid(), "hello_valid", now);
  assert.equal(validateBridgeMessage(admitted, scope, now), null);
  assert.equal(diagnoseBridgeMessage(admitted, scope, now), null, "a frame that is admitted has nothing to diagnose");

  const drifted: readonly Readonly<{ member: string; payload: Record<string, unknown> }>[] = [
    { member: "sessionId", payload: { ...valid(), sessionId: "invalid session" } },
    { member: "capabilities", payload: { ...valid(), capabilities: [1] } },
    { member: "catalogRevision", payload: { ...valid(), catalogRevision: -1 } },
    {
      member: "policyIdentity",
      payload: { ...valid(), policyIdentity: { value: "not-a-guid", capabilityRevision: 1 } },
    },
    { member: "enabledActionIds", payload: { ...valid(), enabledActionIds: ["move_to_tile", "move_to_tile"] } },
    { member: "presentationLocale", payload: { ...valid(), presentationLocale: "en_US" } },
    { member: "runtimeAttestation", payload: { ...valid(), launchGeneration: null } },
    {
      member: "registrations.equip_tool",
      payload: {
        ...valid(),
        registrations: [
          {
            actionId: "equip_tool",
            familyId: "inventory_tools",
            identityVersion: 1,
            lifecycle: "retired",
            kind: "execution",
          },
        ],
      },
    },
    { member: "bodyProgramUnavailableReason", payload: { ...valid(), bodyProgramUnavailableReason: "" } },
    { member: "keySet", payload: { ...valid(), sessionToken: "extra_member" } },
  ];
  for (const { member, payload } of drifted) {
    const frame = newEnvelope("hello_ack", scope, payload, `hello_${member.replaceAll(/[^A-Za-z0-9]/gu, "_")}`, now);
    assert.equal(
      validateBridgeMessage(frame, scope, now),
      "invalid_hello_ack",
      `${member}: the wire contract's bounded code is unchanged, whatever the member`,
    );
    assert.equal(
      diagnoseBridgeMessage(frame, scope, now),
      `hello_ack_member:${member}`,
      `${member}: the refusal must name the member a fixer has to look at`,
    );
  }

  // The reversed half: a member that is ABSENT is named by the fact it states, not by the key set its absence changes.
  const withoutPolicyIdentity = valid() as Record<string, unknown>;
  delete withoutPolicyIdentity.policyIdentity;
  assert.equal(
    diagnoseBridgeMessage(newEnvelope("hello_ack", scope, withoutPolicyIdentity, "hello_absent", now), scope, now),
    "hello_ack_member:policyIdentity",
  );
});

test("an argument sentence over the Host's bound refuses the whole acknowledgement, by registration name", () => {
  // THE REFUSAL THE LIVE ATTACH DIED ON, at the size it died on. The lengths here are the three the boundary turns on:
  // the bound itself, one past it, and the pin's own. `use_mine_ladder` is the registration the run's frame carried.
  const withSentence = (length: number) => {
    const argumentsOf: Record<string, unknown>[] = [{ name: "x", type: "integer", minimum: 0, maximum: 1000 }];
    if (length > 0)
      argumentsOf.push({
        name: "expectedTargetId",
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "x".repeat(length),
      });
    return {
      sessionId: "session_01",
      capabilities: ["use_mine_ladder"],
      catalogRevision: 1,
      policyIdentity: { value: "0123456789abcdef0123456789abcdef", capabilityRevision: 1 },
      enabledActionIds: ["use_mine_ladder"],
      presentationLocale: "zh-CN",
      registrations: [
        {
          actionId: "use_mine_ladder",
          familyId: "mine_navigation",
          identityVersion: 1,
          lifecycle: "live_verified",
          kind: "execution",
          descriptor: {
            arguments: argumentsOf,
            outputFacts: {},
            resourceTemplate: { claims: [{ key: "embodied_actor", value: "ScopePlayer" }] },
            effect: "write",
            postcondition: { name: "mine_left" },
          },
        },
      ],
      runtimeRole: "farmhand_client",
      launchGeneration: "generation_01",
    };
  };
  const frame = (length: number) =>
    newEnvelope("hello_ack", scope, withSentence(length), `hello_sentence_${String(length)}`, now);

  assert.equal(validateBridgeMessage(frame(512), scope, now), null, "the Host's bound is `> 512`, so 512 is admitted");
  for (const length of [513, 595]) {
    assert.equal(validateBridgeMessage(frame(length), scope, now), "invalid_hello_ack");
    assert.equal(
      diagnoseBridgeMessage(frame(length), scope, now),
      "hello_ack_member:registrations.use_mine_ladder",
      `${String(length)}: the refusal must name the registration whose sentence has to be shortened`,
    );
  }
});
