/**
 * Saving her character carries the Chats that pin her profile.
 *
 * The identity profile is ONE mutable file, and every Chat thread pins the exact triple
 * (`profileId` / `profileRevision` / `profileCanonicalHash`) it was created against; the runtime
 * construction refuses a thread whose pin does not match the profile it read
 * (`continuity-semantic-chat-runtime-construction.internal.ts`, `chat_runtime_exact_content_unavailable`).
 * `character.voice.update` is the only player write that bumps that revision, and it used to refresh
 * only the per-surface `identity-profile-binding.json` files - so one save left every existing Chat of
 * that companion unable to mount at all.
 *
 * `refreshCompanionProfileBinding` is the one writer that moves those pins. What it may touch is the
 * whole point, so every assertion here is about a row it must NOT have moved: another companion's
 * thread, a thread already on the new revision, and a thread pinned to a different profile entirely.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import {
  acceptMountedPlayerMessage,
  createChatThreadStore,
  createProfileAwareChatThreadCreationCapability,
} from "./chat-thread-store.js";

const FIRST_PROFILE = Object.freeze({ profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) });
const SECOND_PROFILE = Object.freeze({ profileId: "profile_01", revision: 2, canonicalHash: "b".repeat(64) });
const OTHER_PROFILE = Object.freeze({ profileId: "profile_02", revision: 1, canonicalHash: "c".repeat(64) });

const COMPANION = Object.freeze({ companionId: "companion_01", continuityId: "continuity_01" });
const OTHER_COMPANION = Object.freeze({ companionId: "companion_02", continuityId: "continuity_02" });

function readerFor(triple: Readonly<{ profileId: string; revision: number; canonicalHash: string }>) {
  return {
    async readExact() {
      return triple;
    },
  };
}

async function fixture() {
  const root = await canonicalTestRoot("gamebuddy-chat-profile-repin-");
  const key = createHash("sha256").update(["player_01", "companion_01", "continuity_01"].join("\u001f")).digest("hex");
  let time = 10;
  const store = createChatThreadStore(root, key, () => time++);
  return Object.freeze({ root, key, store });
}

async function createChat(
  store: ReturnType<typeof createChatThreadStore>,
  triple: Readonly<{ profileId: string; revision: number; canonicalHash: string }>,
  chat: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string; companionId: string; continuityId: string }>,
): Promise<void> {
  await createProfileAwareChatThreadCreationCapability(store, readerFor(triple)).createExplicit({
    ...chat,
    opening: "blank",
  });
}

const A = Object.freeze({
  chatThreadId: "thread_01",
  chatSurfaceSessionId: "surface_01",
  ...COMPANION,
});
const B = Object.freeze({
  chatThreadId: "thread_02",
  chatSurfaceSessionId: "surface_02",
  ...COMPANION,
});
const OTHER = Object.freeze({
  chatThreadId: "thread_other",
  chatSurfaceSessionId: "surface_other",
  ...OTHER_COMPANION,
});

/** One thread's `profile_revision` / `profile_canonical_hash` as stored, and nothing else. */
async function pinnedProfile(
  store: ReturnType<typeof createChatThreadStore>,
  chat: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }>,
): Promise<Readonly<{ profileId: string; revision: number; canonicalHash: string }>> {
  const state = await store.resumeThread(chat.chatThreadId, chat.chatSurfaceSessionId);
  return Object.freeze({
    profileId: state.thread.profileId,
    revision: state.thread.profileRevision,
    canonicalHash: state.thread.profileCanonicalHash,
  });
}

test("the re-pin moves only the saved companion's threads, and only rows still on the replaced triple", async () => {
  const fixtureValue = await fixture();
  try {
    const { store } = fixtureValue;
    await createChat(store, FIRST_PROFILE, A);
    await createChat(store, FIRST_PROFILE, B);
    // A row of another companion, on the same profile id and revision. The scope is the SAVED
    // companion, so this row must be untouched: it belongs to a conversation that was never
    // created against her, and moving it would be exactly the sweep the pin exists to prevent.
    await createChat(store, FIRST_PROFILE, OTHER);
    // A row already on the new revision (another path got there first) must be left as it is.
    await createChat(store, SECOND_PROFILE, {
      chatThreadId: "thread_already_moved",
      chatSurfaceSessionId: "surface_already_moved",
      ...COMPANION,
    });

    const refresh = store.refreshCompanionProfileBinding;
    assert.ok(refresh !== undefined, "the store that owns the pins must be able to move them");
    const moved = await refresh({
      companionId: COMPANION.companionId,
      continuityId: COMPANION.continuityId,
      previous: FIRST_PROFILE,
      binding: SECOND_PROFILE,
    });
    assert.equal(moved, 2, "exactly the two threads that were pinned to the replaced triple moved");

    assert.deepEqual(await pinnedProfile(store, A), SECOND_PROFILE);
    assert.deepEqual(await pinnedProfile(store, B), SECOND_PROFILE);
    assert.deepEqual(
      await pinnedProfile(store, OTHER),
      FIRST_PROFILE,
      "another companion's Chat keeps the revision it was created with",
    );
    assert.deepEqual(
      await pinnedProfile(store, {
        chatThreadId: "thread_already_moved",
        chatSurfaceSessionId: "surface_already_moved",
      }),
      SECOND_PROFILE,
      "a Chat already on the new revision is left exactly as it was",
    );
  } finally {
    fixtureValue.store.close?.();
    await rm(fixtureValue.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a stale save re-pins nothing: a thread already carried past the revision it names is not moved twice", async () => {
  const fixtureValue = await fixture();
  try {
    const { store } = fixtureValue;
    await createChat(store, FIRST_PROFILE, A);
    const refresh = store.refreshCompanionProfileBinding;
    assert.ok(refresh !== undefined);

    // The first save moves it to revision 2.
    const first = await refresh({
      companionId: COMPANION.companionId,
      continuityId: COMPANION.continuityId,
      previous: FIRST_PROFILE,
      binding: SECOND_PROFILE,
    });
    assert.equal(first, 1);

    // A second save that still believes the thread is on revision 1 - what a stale caller would
    // send - matches nothing at all, so it cannot move the row onto a revision the profile no
    // longer has. The count is the honest answer and the row is untouched.
    const stale = await refresh({
      companionId: COMPANION.companionId,
      continuityId: COMPANION.continuityId,
      previous: FIRST_PROFILE,
      binding: { profileId: FIRST_PROFILE.profileId, revision: 3, canonicalHash: "d".repeat(64) },
    });
    assert.equal(stale, 0, "a stale previous triple matches no row");
    assert.deepEqual(await pinnedProfile(store, A), SECOND_PROFILE);

    // And a re-pin that names a different profile id is refused outright: the pin's purpose is that
    // a Chat mounts against the profile it was created with, never another one.
    await assert.rejects(
      refresh({
        companionId: COMPANION.companionId,
        continuityId: COMPANION.continuityId,
        previous: { ...SECOND_PROFILE, profileId: "profile_other" },
        binding: OTHER_PROFILE,
      }),
      /invalid_chat_thread_profile/,
    );
    assert.deepEqual(await pinnedProfile(store, A), SECOND_PROFILE);
  } finally {
    fixtureValue.store.close?.();
    await rm(fixtureValue.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a Chat that is answering holds the pin: the save is refused and every row keeps its revision", async () => {
  const fixtureValue = await fixture();
  try {
    const { store } = fixtureValue;
    await createChat(store, FIRST_PROFILE, A);
    await createChat(store, FIRST_PROFILE, B);
    // A live turn on ONE of the two threads is enough. Its accepted plan pins the same profile
    // triple and is write-once, so moving the thread under it would leave the plan describing a
    // state its turn was never in.
    await acceptMountedPlayerMessage(
      {
        runtimeRoot: fixtureValue.root,
        playerId: "player_01",
        companionId: COMPANION.companionId,
        continuityId: COMPANION.continuityId,
        chatThreadId: B.chatThreadId,
        chatSurfaceSessionId: B.chatSurfaceSessionId,
        selectionGeneration: 1,
      },
      {
        text: "She is answering this one right now.",
        locale: "en-US",
        idempotencyKey: "abcdefghijklmnopqrstuv",
        expectedDraftRevision: 0,
        authoredContextPreparation: { sourceRefs: [], stableTokenCount: 0, volatileTokenCount: 0 },
      },
    );
    const refresh = store.refreshCompanionProfileBinding;
    assert.ok(refresh !== undefined);
    await assert.rejects(
      refresh({
        companionId: COMPANION.companionId,
        continuityId: COMPANION.continuityId,
        previous: FIRST_PROFILE,
        binding: SECOND_PROFILE,
      }),
      /chat_profile_binding_turn_active/,
      "the refusal names the reason the player can act on",
    );
    // Nothing was half-moved: the whole pass is one transaction, and the live turn's own thread was
    // not the only one it would have touched.
    assert.deepEqual(await pinnedProfile(store, A), FIRST_PROFILE, "her other Chat was not moved either");
    assert.deepEqual(await pinnedProfile(store, B), FIRST_PROFILE, "the answering Chat keeps its revision");
  } finally {
    fixtureValue.store.close?.();
    await rm(fixtureValue.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
