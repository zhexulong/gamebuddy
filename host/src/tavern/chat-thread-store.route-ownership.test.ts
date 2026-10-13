import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import {
  claimMountedAttempt,
  countMountedRouteRegistrations,
  createChatThreadStore,
  createProfileAwareChatThreadCreationCapability,
  transitionMountedProviderStart as rawTransitionMountedProviderStart,
  transitionMountedPresentation as rawTransitionMountedPresentation,
} from "./chat-thread-store.js";
import { createMountedTurnTransitionAuthority } from "./chat-thread-store.mounted-turn-transition.internal.js";

/**
 * Route ownership across store lifetimes.
 *
 * A store's five module-level mounted-route registrations are keyed by
 * (root, continuity key), not by store identity: two stores on the same route
 * share one dispatch slot. A mount's live turn reaches its cancel path through
 * that slot, so the slot must not be torn down by a store that does not own the
 * mounted turn. This suite mounts a turn on one store, closes a second store on
 * the same route, and proves the mounted turn's own cancel path still works.
 */

const testTransitionAuthority = createMountedTurnTransitionAuthority();

async function transitionMountedProviderStart(
  binding: Omit<Parameters<typeof rawTransitionMountedProviderStart>[0], "authority" | "operationAuthority">,
  command: Parameters<typeof rawTransitionMountedProviderStart>[1],
) {
  const operation = testTransitionAuthority.mintOperation();
  try {
    return await rawTransitionMountedProviderStart(
      { authority: testTransitionAuthority.authority, operationAuthority: operation.authority, ...binding },
      command,
    );
  } finally {
    operation.revoke();
  }
}

async function transitionMountedPresentation(
  binding: Omit<Parameters<typeof rawTransitionMountedPresentation>[0], "authority" | "operationAuthority">,
  command: Parameters<typeof rawTransitionMountedPresentation>[1],
) {
  const operation = testTransitionAuthority.mintOperation();
  try {
    return await rawTransitionMountedPresentation(
      { authority: testTransitionAuthority.authority, operationAuthority: operation.authority, ...binding },
      command,
    );
  } finally {
    operation.revoke();
  }
}

const continuityKey = createHash("sha256")
  .update(["player_01", "companion_01", "continuity_01"].join("\u001f"))
  .digest("hex");

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

const profileReader = {
  async readExact() {
    return { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) };
  },
};

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

/**
 * Drives the exact thread the binding names to a durably `running` turn through
 * this store's own mounted-route registrations. The store must be the only live
 * registrant for its route while this runs.
 */
async function prepareRunningTurn(
  root: string,
  store: ReturnType<typeof createChatThreadStore>,
): Promise<string> {
  const creation = createProfileAwareChatThreadCreationCapability(store, profileReader);
  await creation.createExplicit({
    chatThreadId: "thread_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    chatSurfaceSessionId: "surface_01",
    opening: "blank",
  });
  const { acceptMountedPlayerMessage } = await import("./chat-thread-store.js");
  await acceptMountedPlayerMessage(bindingFor(root), {
    text: "Hello",
    locale: "en-US",
    idempotencyKey: "abcdefghijklmnopqrstuv",
    expectedDraftRevision: 0,
    authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
  });
  const claimed = await claimMountedAttempt(bindingFor(root));
  const attemptId = claimed.attempt.attemptId;
  const prefix = (await store.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
  await transitionMountedProviderStart(
    { ...bindingFor(root), attemptId },
    { operation: "arm", observedAtMs: prefix + 1 },
  );
  await transitionMountedProviderStart(
    { ...bindingFor(root), attemptId },
    { operation: "running", statusClass: "success", observedAtMs: prefix + 2 },
  );
  return attemptId;
}

test("closing a store that does not own the mounted turn leaves its cancel path working", async () => {
  const root = await canonicalTestRoot("gamebuddy-route-ownership-second-close-");
  const owner = createChatThreadStore(root, continuityKey);
  let closer: ReturnType<typeof createChatThreadStore> | undefined;
  try {
    const attemptId = await prepareRunningTurn(root, owner);
    assert.equal(countMountedRouteRegistrations(root, continuityKey), 5, "the mounted owner registered the route");

    // A second store on the same route takes over the shared dispatch slot; it
    // does not own the mounted turn. Closing it must not detach the owner's.
    closer = createChatThreadStore(root, continuityKey);
    assert.equal(countMountedRouteRegistrations(root, continuityKey), 5);
    closer.close?.();

    assert.equal(
      countMountedRouteRegistrations(root, continuityKey),
      5,
      "closing a store that does not own the mounted turn must leave the route registered",
    );

    const base = (await owner.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
    const claimed = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "claim_cancel", claimedAtMs: base + 1 },
    );
    assert.equal(claimed.status, "cancel_claimed");
    const cancelled = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId },
      { operation: "cancel", cancelledAtMs: base + 2 },
    );
    assert.equal(cancelled.status, "cancelled");
  } finally {
    closer?.close?.();
    owner.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a transient close followed by another turn still cancels", async () => {
  const root = await canonicalTestRoot("gamebuddy-route-ownership-second-turn-");
  const owner = createChatThreadStore(root, continuityKey);
  let transient: ReturnType<typeof createChatThreadStore> | undefined;
  try {
    const firstAttempt = await prepareRunningTurn(root, owner);

    // The switch's own settlement opens and closes a store on this route; the
    // mounted owner is untouched by it.
    transient = createChatThreadStore(root, continuityKey);
    transient.close?.();

    const base = (await owner.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
    await transitionMountedPresentation(
      { ...bindingFor(root), attemptId: firstAttempt },
      { operation: "claim_cancel", claimedAtMs: base + 1 },
    );
    const firstCancelled = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId: firstAttempt },
      { operation: "cancel", cancelledAtMs: base + 2 },
    );
    assert.equal(firstCancelled.status, "cancelled");

    // The turn that follows the switch is admitted, claimed and driven to
    // `running` over the same route, and its own cancel path must still work.
    const { acceptMountedPlayerMessage } = await import("./chat-thread-store.js");
    const beforeSecond = await owner.resumeThread("thread_01", "surface_01");
    await acceptMountedPlayerMessage(bindingFor(root), {
      text: "Second",
      locale: "en-US",
      idempotencyKey: "bcdefghijklmnopqrstuvw",
      expectedDraftRevision: beforeSecond.draft.revision,
      authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0 },
    });
    const claimed = await claimMountedAttempt(bindingFor(root));
    const secondAttempt = claimed.attempt.attemptId;
    const secondBase = (await owner.resumeThread("thread_01", "surface_01")).thread.updatedAtMs;
    await transitionMountedProviderStart(
      { ...bindingFor(root), attemptId: secondAttempt },
      { operation: "arm", observedAtMs: secondBase + 1 },
    );
    await transitionMountedProviderStart(
      { ...bindingFor(root), attemptId: secondAttempt },
      { operation: "running", statusClass: "success", observedAtMs: secondBase + 2 },
    );
    const running = (await owner.resumeThread("thread_01", "surface_01")).turnLedger;
    assert.equal(running?.status, "running");
    const secondClaim = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId: secondAttempt },
      { operation: "claim_cancel", claimedAtMs: secondBase + 3 },
    );
    assert.equal(secondClaim.status, "cancel_claimed");
    const secondCancelled = await transitionMountedPresentation(
      { ...bindingFor(root), attemptId: secondAttempt },
      { operation: "cancel", cancelledAtMs: secondBase + 4 },
    );
    assert.equal(secondCancelled.status, "cancelled");
  } finally {
    transient?.close?.();
    owner.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
