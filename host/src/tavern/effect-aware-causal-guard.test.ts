import assert from "node:assert/strict";
import test from "node:test";
import { guardTavernCausalMutation, type TavernCausalState } from "./effect-aware-causal-guard.js";

const state: TavernCausalState = Object.freeze({
  artifactRevisions: Object.freeze({ persona: 2 }),
  responses: Object.freeze({
    reply: Object.freeze({ threadId: "thread", threadRevision: 4, messageRevision: 3, eligible: true }),
    usedReply: Object.freeze({ threadId: "thread", threadRevision: 4, messageRevision: 3, eligible: false }),
  }),
});

test("allows only exact-next-revision inert Tavern artifact writes", () => {
  assert.deepEqual(
    guardTavernCausalMutation(
      { kind: "inert_artifact_write", artifactId: "persona", expectedRevision: 2, nextRevision: 3 },
      state,
    ),
    { allowed: true, effect: "inert_artifact_write" },
  );
  assert.deepEqual(
    guardTavernCausalMutation(
      { kind: "inert_artifact_write", artifactId: "persona", expectedRevision: 1, nextRevision: 2 },
      state,
    ),
    { allowed: false, reason: "stale_revision" },
  );
  assert.deepEqual(
    guardTavernCausalMutation(
      { kind: "inert_artifact_write", artifactId: "persona", expectedRevision: 2, nextRevision: 4 },
      state,
    ),
    { allowed: false, reason: "conflicting_revision" },
  );
  assert.deepEqual(
    guardTavernCausalMutation(
      { kind: "inert_artifact_write", artifactId: "missing", expectedRevision: 1, nextRevision: 2 },
      state,
    ),
    { allowed: false, reason: "unknown_target" },
  );
});

test("allows only the current eligible effect-free Tavern response mutation", () => {
  const mutation = {
    kind: "response_mutation" as const,
    threadId: "thread",
    messageId: "reply",
    expectedThreadRevision: 4,
    expectedMessageRevision: 3,
  };
  assert.deepEqual(guardTavernCausalMutation({ ...mutation, effect: "none" }, state), {
    allowed: true,
    effect: "none",
  });
  assert.deepEqual(guardTavernCausalMutation({ ...mutation, effect: "external" }, state), {
    allowed: false,
    reason: "external_effect",
  });
  assert.deepEqual(guardTavernCausalMutation({ ...mutation, effect: "game" }, state), {
    allowed: false,
    reason: "game_effect",
  });
  assert.deepEqual(guardTavernCausalMutation({ ...mutation, expectedMessageRevision: 2, effect: "none" }, state), {
    allowed: false,
    reason: "stale_revision",
  });
  assert.deepEqual(guardTavernCausalMutation({ ...mutation, expectedThreadRevision: 5, effect: "none" }, state), {
    allowed: false,
    reason: "conflicting_revision",
  });
  assert.deepEqual(guardTavernCausalMutation({ ...mutation, messageId: "usedReply", effect: "none" }, state), {
    allowed: false,
    reason: "response_ineligible",
  });
});

test("fails closed for malformed state or mutation", () => {
  assert.deepEqual(
    guardTavernCausalMutation(
      {
        kind: "response_mutation",
        threadId: "thread",
        messageId: "reply",
        expectedThreadRevision: 4,
        expectedMessageRevision: 3,
        effect: "unknown",
      },
      state,
    ),
    { allowed: false, reason: "invalid_mutation" },
  );
  assert.deepEqual(guardTavernCausalMutation(null, state), { allowed: false, reason: "invalid_mutation" });
  assert.deepEqual(
    guardTavernCausalMutation(
      { kind: "inert_artifact_write", artifactId: "persona", expectedRevision: 2, nextRevision: 3 },
      {
        artifactRevisions: { persona: 2 },
        responses: { reply: { threadId: "thread", threadRevision: 4, messageRevision: 3 } },
      },
    ),
    { allowed: false, reason: "invalid_mutation" },
  );
});
