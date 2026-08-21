import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import {
  claimP4MountedAttempt,
  createChatThreadStore,
  transitionP4MountedProviderStart as rawTransitionP4MountedProviderStart,
  transitionP5MountedPresentation as rawTransitionP5MountedPresentation,
} from "./chat-thread-store.js";
import { createP4P5MountedTransitionAuthority } from "./chat-thread-store.p4-p5-transition-authority.internal.js";

/**
 * P6 durable cancel authority prerequisite — characterization only.
 *
 * This suite pins the exact fail-closed behavior of the existing durable
 * state machine for queued (`accepted_queued`/`attempt_starting`) cancel
 * attempts and proves the two structural facts that block the P6 route:
 *
 * 1. The frozen ledger types/validators (`CancelClaimedTurn`/`CancelledTurn`
 *    derive from `RunningTurn`, which requires an attempt plus a durable
 *    `running` observation written solely by the source-owned
 *    `after_provider_response` observer) leave NO legal durable artifact
 *    shape for a queued-source cancel. Every queued claim_cancel attempt
 *    fails closed with zero durable mutation, and the rejection never
 *    poisons the later P4c start/presentation path.
 * 2. The existing acceptance `idempotency` record family cannot host a
 *    cancel result; a cancel-specific record would be a new artifact family
 *    on the frozen v1 schema (an owner decision, not a seam).
 *
 * No production file is modified by this suite.
 */

const testTransitionAuthority = createP4P5MountedTransitionAuthority();
const transitionP4MountedProviderStart = async (
  binding: Omit<Parameters<typeof rawTransitionP4MountedProviderStart>[0], "authority" | "operationAuthority">,
  command: Parameters<typeof rawTransitionP4MountedProviderStart>[1],
) => {
  const operation = testTransitionAuthority.mintOperation();
  try {
    return await rawTransitionP4MountedProviderStart(
      { authority: testTransitionAuthority.authority, operationAuthority: operation.authority, ...binding },
      command,
    );
  } finally {
    operation.revoke();
  }
};
const transitionP5MountedPresentation = async (
  binding: Omit<Parameters<typeof rawTransitionP5MountedPresentation>[0], "authority" | "operationAuthority">,
  command: Parameters<typeof rawTransitionP5MountedPresentation>[1],
) => {
  const operation = testTransitionAuthority.mintOperation();
  try {
    return await rawTransitionP5MountedPresentation(
      { authority: testTransitionAuthority.authority, operationAuthority: operation.authority, ...binding },
      command,
    );
  } finally {
    operation.revoke();
  }
};

const bindingFor = (root: string) =>
  ({
    runtimeRoot: root,
    playerId: "player_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    selectionGeneration: 3,
    runtimeBindingDigest: "d".repeat(64),
    runtimeOwner: {
      ownerToken: "owner_01",
      runtimeInstanceId: "runtime_01",
      ownerPid: 1,
      ownerProcessStartIdentity: "start_01",
    },
  }) as const;
const continuityKey = createHash("sha256")
  .update(["player_01", "companion_01", "continuity_01"].join("\u001f"))
  .digest("hex");
const threadDirectory = (root: string) =>
  join(root, "tavern", "v1", "continuities", continuityKey, "threads", "thread_01");

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

/**
 * Builds an exact thread with one accepted player turn and drives it to the
 * requested pre-running durable ledger state. Returns the store and the exact
 * claimed attemptId (empty for `accepted_queued`).
 */
async function prepare(
  root: string,
  target: "accepted_queued" | "attempt_starting" | "armed" | "not_started" | "running",
): Promise<Readonly<{ store: ReturnType<typeof createChatThreadStore>; attemptId: string }>> {
  const store = createChatThreadStore(
    root,
    continuityKey,
    (() => {
      let current = 100;
      return () => current++;
    })(),
  );
  await store.createThread({
    chatThreadId: "thread_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    chatSurfaceSessionId: "surface_01",
    opening: "blank",
  });
  const { acceptP4MountedPlayerMessage } = await import("./chat-thread-store.js");
  const binding = bindingFor(root);
  await acceptP4MountedPlayerMessage(binding, {
    text: "Hello",
    locale: "en-US",
    idempotencyKey: "abcdefghijklmnopqrstuv",
    expectedDraftRevision: 0,
  });
  if (target === "accepted_queued") return { store, attemptId: "" };
  const claimed = await claimP4MountedAttempt(binding);
  const attemptId = claimed.attempt.attemptId;
  if (target === "attempt_starting") return { store, attemptId };
  const prefix = (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
  await transitionP4MountedProviderStart(
    { ...bindingFor(root), attemptId },
    { operation: "arm", observedAtMs: prefix + 1 },
  );
  if (target === "armed") return { store, attemptId };
  if (target === "not_started") {
    await transitionP4MountedProviderStart(
      { ...bindingFor(root), attemptId },
      { operation: "not_started", reasonCode: "admission_revoked", observedAtMs: prefix + 2 },
    );
    return { store, attemptId };
  }
  await transitionP4MountedProviderStart(
    { ...bindingFor(root), attemptId },
    { operation: "running", statusClass: "success", observedAtMs: prefix + 2 },
  );
  return { store, attemptId };
}

test("cancel authority prerequisite: claim_cancel rejects an accepted_queued turn with zero mutation and no later-activation poisoning", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-cancel-auth-accepted-"));
  try {
    const { store } = await prepare(root, "accepted_queued");
    const before = await store.resumeThread("thread_01", "surface_01");
    // A queued turn has no attempt claim, so the exact-attempt P5 port refuses
    // it before any cancel CAS can be evaluated.
    await assert.rejects(
      () =>
        transitionP5MountedPresentation(
          { ...bindingFor(root), attemptId: "attempt_pending_01" },
          { operation: "claim_cancel", claimedAtMs: 200 },
        ),
      /p5_presentation_claim_missing/,
    );
    const after = await store.resumeThread("thread_01", "surface_01");
    assert.deepEqual(after, before);
    assert.equal(after.turnLedger?.status, "accepted_queued");
    assert.equal(after.messages.length, 1);
    assert.equal(after.idempotency.length, 1);
    // The rejection is side-effect free: the later P4b/P4c path (claim → arm →
    // running → presentation activation/commit → completion) stays fully
    // usable, i.e. the rejected cancel did not poison the later activation.
    const claimed = await claimP4MountedAttempt(bindingFor(root));
    const attemptId = claimed.attempt.attemptId;
    const prefix = (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
    await transitionP4MountedProviderStart(
      { ...bindingFor(root), attemptId },
      { operation: "arm", observedAtMs: prefix + 1 },
    );
    await transitionP4MountedProviderStart(
      { ...bindingFor(root), attemptId },
      { operation: "running", statusClass: "success", observedAtMs: prefix + 2 },
    );
    const committedAt = prefix + 3;
    const committed = await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      {
        operation: "commit_presentation",
        cancelEpoch: 0,
        message: {
          messageId: "response_after_rejected_cancel_01",
          text: "Visible after rejected cancel.",
          occurredAtMs: committedAt,
        },
        committedAtMs: committedAt,
      },
    );
    assert.equal(committed.status, "presentation_committed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel authority prerequisite: claim_cancel rejects attempt_starting sources until durable running, with zero mutation at each rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-cancel-auth-starting-"));
  try {
    const { store, attemptId } = await prepare(root, "attempt_starting");
    const unarmed = await store.resumeThread("thread_01", "surface_01");
    assert.equal(unarmed.turnLedger?.status, "attempt_starting");
    assert.equal(unarmed.turnLedger?.observation, undefined);
    await assert.rejects(
      () =>
        transitionP5MountedPresentation(
          { ...bindingFor(root), attemptId },
          { operation: "claim_cancel", claimedAtMs: unarmed.thread.updatedAtMs + 1 },
        ),
      /p5_presentation_cancel_source_required/,
    );
    assert.deepEqual(await store.resumeThread("thread_01", "surface_01"), unarmed);

    // The rejection never closes/poisons the start path: arm is still legal.
    const prefix = unarmed.thread.updatedAtMs;
    await transitionP4MountedProviderStart(
      { ...bindingFor(root), attemptId },
      { operation: "arm", observedAtMs: prefix + 1 },
    );
    const armed = await store.resumeThread("thread_01", "surface_01");
    assert.equal(armed.turnLedger?.status, "attempt_starting");
    assert.equal(armed.turnLedger?.observation?.phase, "armed");
    // A durable `armed` attempt (provider prompt may already be in flight) is
    // still not a legal cancel source.
    await assert.rejects(
      () =>
        transitionP5MountedPresentation(
          { ...bindingFor(root), attemptId },
          { operation: "claim_cancel", claimedAtMs: prefix + 2 },
        ),
      /p5_presentation_cancel_source_required/,
    );
    assert.deepEqual(await store.resumeThread("thread_01", "surface_01"), armed);

    // Cancel becomes reachable only after the source-owned durable `running`
    // observation exists.
    await transitionP4MountedProviderStart(
      { ...bindingFor(root), attemptId },
      { operation: "running", statusClass: "success", observedAtMs: prefix + 2 },
    );
    const runningBase = (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
    const claimedCancel = await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "claim_cancel", claimedAtMs: runningBase + 1 },
    );
    assert.equal(claimedCancel.status, "cancel_claimed");
    const cancelled = await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "cancel", cancelledAtMs: runningBase + 2 },
    );
    assert.equal(cancelled.status, "cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel authority prerequisite: claim_cancel rejects a not_started attempt with zero mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-cancel-auth-not-started-"));
  try {
    const { store, attemptId } = await prepare(root, "not_started");
    const before = await store.resumeThread("thread_01", "surface_01");
    assert.equal(before.turnLedger?.status, "attempt_starting");
    assert.equal(before.turnLedger?.observation?.phase, "not_started");
    await assert.rejects(
      () =>
        transitionP5MountedPresentation(
          { ...bindingFor(root), attemptId },
          { operation: "claim_cancel", claimedAtMs: before.thread.updatedAtMs + 1 },
        ),
      /p5_presentation_cancel_source_required/,
    );
    assert.deepEqual(await store.resumeThread("thread_01", "surface_01"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel authority prerequisite: queued cancel_claimed/cancelled artifacts have no legal durable shape", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-cancel-auth-artifact-"));
  try {
    const { store } = await prepare(root, "armed");
    const state = await store.resumeThread("thread_01", "surface_01");
    const ledger = state.turnLedger;
    assert.equal(ledger?.status, "attempt_starting");
    assert.equal(ledger?.observation?.phase, "armed");
    if (ledger === null || ledger.status !== "attempt_starting") throw new Error("fixture_invariant");
    const common = {
      turnId: ledger.turnId,
      idempotencyKey: ledger.idempotencyKey,
      messageId: ledger.messageId,
      acceptedAtMs: ledger.acceptedAtMs,
      attempt: ledger.attempt,
    };
    const ledgerPath = join(threadDirectory(root), "turn-ledger.json");
    const envelope = (turnLedger: unknown) => JSON.stringify({ schemaVersion: 1, turnLedger }, null, 2);

    // (a) The design/40 §5.1 `accepted_queued → cancel_claimed` shape: no
    // attempt claim and no observation at all. The frozen validator rejects it.
    await writeFile(
      ledgerPath,
      envelope({
        turnId: common.turnId,
        status: "cancel_claimed",
        idempotencyKey: common.idempotencyKey,
        messageId: common.messageId,
        acceptedAtMs: common.acceptedAtMs,
        presentation: null,
        cancelClaimedAtMs: 300,
      }),
    );
    await assert.rejects(
      () => store.resumeThread("thread_01", "surface_01"),
      /invalid_chat_thread_observation|invalid_chat_thread_turn_ledger/,
    );

    // (b) `attempt_starting (armed) → cancel_claimed` with the attempt kept:
    // the observation is `armed`, never the required `running`, so the record
    // is still unreadable.
    await writeFile(
      ledgerPath,
      envelope({
        ...common,
        status: "cancel_claimed",
        observation: { phase: "armed", observedAtMs: 200 },
        presentation: null,
        cancelClaimedAtMs: 300,
      }),
    );
    await assert.rejects(
      () => store.resumeThread("thread_01", "surface_01"),
      /invalid_chat_thread_observation|invalid_chat_thread_turn_ledger/,
    );

    // (c) `attempt_starting → cancelled` with the observation omitted entirely.
    await writeFile(
      ledgerPath,
      envelope({
        ...common,
        status: "cancelled",
        cancelClaimedAtMs: 300,
        cancelledAtMs: 301,
      }),
    );
    await assert.rejects(
      () => store.resumeThread("thread_01", "surface_01"),
      /invalid_chat_thread_observation|invalid_chat_thread_turn_ledger/,
    );

    // Sanity: restoring the exact pre-fabrication `armed` record reopens.
    const observation = ledger.observation;
    await writeFile(
      ledgerPath,
      envelope({
        ...common,
        status: "attempt_starting",
        ...(observation === undefined ? {} : { observation }),
      }),
    );
    const restored = await store.resumeThread("thread_01", "surface_01");
    assert.equal(restored.turnLedger?.status, "attempt_starting");
    assert.equal(restored.turnLedger?.observation?.phase, "armed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel authority prerequisite: active P5 cancel and completion-first arbitration are unchanged; no cancel idempotency record family exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-cancel-auth-active-"));
  try {
    const { store, attemptId } = await prepare(root, "running");
    const base = (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;

    // Active cancel: claim → repeat claim (stable) → late presentation
    // rejected → terminal cancelled; repeat terminal cancel is stable.
    const claimedCancel = await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "claim_cancel", claimedAtMs: base + 1 },
    );
    assert.equal(claimedCancel.status, "cancel_claimed");
    const repeatedClaim = await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "claim_cancel", claimedAtMs: base + 2 },
    );
    assert.deepEqual(repeatedClaim, claimedCancel);
    await assert.rejects(
      () =>
        transitionP5MountedPresentation(
          { ...bindingFor(root), attemptId },
          {
            operation: "commit_presentation",
            cancelEpoch: 0,
            message: { messageId: "response_late_01", text: "Late.", occurredAtMs: base + 3 },
            committedAtMs: base + 3,
          },
        ),
      /p5_presentation_source_running_required/,
    );
    const cancelled = await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "cancel", cancelledAtMs: base + 4 },
    );
    assert.equal(cancelled.status, "cancelled");
    const repeatedCancel = await transitionP5MountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "cancel", cancelledAtMs: base + 5 },
    );
    assert.equal(repeatedCancel.status, "cancelled");
    const terminal = await store.resumeThread("thread_01", "surface_01");
    assert.equal(terminal.messages.filter((message) => message.kind === "response").length, 0);

    // Completion-first: cancel loses the arbitration at the store CAS and the
    // terminal completion stays stable.
    const secondRoot = await mkdtemp(join(tmpdir(), "gamebuddy-cancel-auth-complete-"));
    try {
      const second = await prepare(secondRoot, "running");
      const secondBase = (await second.store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
      await transitionP5MountedPresentation(
        { ...bindingFor(secondRoot), attemptId: second.attemptId },
        {
          operation: "commit_presentation",
          cancelEpoch: 0,
          message: { messageId: "response_complete_01", text: "Done.", occurredAtMs: secondBase + 1 },
          committedAtMs: secondBase + 1,
        },
      );
      const completionClaimed = await transitionP5MountedPresentation(
        { ...bindingFor(secondRoot), attemptId: second.attemptId },
        { operation: "claim_completion", claimedAtMs: secondBase + 2 },
      );
      assert.equal(completionClaimed.status, "completion_claimed");
      await assert.rejects(
        () =>
          transitionP5MountedPresentation(
            { ...bindingFor(secondRoot), attemptId: second.attemptId },
            { operation: "claim_cancel", claimedAtMs: secondBase + 3 },
          ),
        /p5_presentation_cancel_source_required/,
      );
      const completed = await transitionP5MountedPresentation(
        { ...bindingFor(secondRoot), attemptId: second.attemptId },
        { operation: "complete", completedAtMs: secondBase + 4 },
      );
      assert.equal(completed.status, "completed");
      await assert.rejects(
        () =>
          transitionP5MountedPresentation(
            { ...bindingFor(secondRoot), attemptId: second.attemptId },
            { operation: "claim_cancel", claimedAtMs: secondBase + 5 },
          ),
        /p5_presentation_cancel_source_required/,
      );

      // The acceptance idempotency family is the only durable idempotency
      // record and its `result` must be an AcceptedQueuedTurn: a cancel-shaped
      // result cannot be persisted, so no cancel idempotency record exists.
      const durable = await second.store.resumeThread("thread_01", "surface_01");
      const record = durable.idempotency[0];
      assert.ok(record);
      await writeFile(
        join(threadDirectory(secondRoot), "idempotency.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            idempotency: [
              {
                key: record.key,
                fingerprint: record.fingerprint,
                result: {
                  ...record.result,
                  status: "cancel_claimed",
                  presentation: null,
                  cancelClaimedAtMs: secondBase + 6,
                },
              },
            ],
          },
          null,
          2,
        ),
      );
      await assert.rejects(
        () => second.store.resumeThread("thread_01", "surface_01"),
        /invalid_chat_thread_turn_ledger|invalid_chat_thread_idempotency/,
      );
    } finally {
      await rm(secondRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
