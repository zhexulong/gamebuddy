/**
 * The two concurrency stories, over the containers that already exist.
 *
 * A randomly-written test can hold a function's happy path and it cannot hold these two: "the
 * container was closed while my request was inside it" and "two writers claimed the same revision
 * at the same time". Both need a request parked at an exact point and something done to the
 * container from the outside, and both are written once per container by hand today - which is why
 * none of the four containers below was ever driven that way.
 *
 * So the checks are shared (`./in-flight-teardown.ts`, `./concurrent-cas.ts`) and this file is the
 * REGISTRATION: which container's close path, or which CAS, is covered by which story. The
 * population is printed, every close-path member a container this file can construct publishes is
 * compared against the entry that claims it, and a container that grows a second close path without
 * being named here fails by name. The Memory service is the one entry this file cannot construct
 * (it needs a real mounted lease); it is named here and driven in its own suite.
 *
 * Not covered here, and not duplicated either: the Chat lane's in-flight read measured through the
 * real switch (`switchChatLane` -> `drainChatLane`) is `desktop-presentation-admission-owner.private.test.ts`
 * scenario `switch-during-read` (LANEFENCE, commit `495a873f`). That case owns the composition: the
 * HTTP read, the broker's status, the reverse-order close. This file owns the fence and the store
 * directly, which is the pair the switch is built from.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { createChatLaneFence } from "../composition/chat-lane-fence.js";
import { identityKey } from "../runtime.js";
import {
  type ChatThreadState,
  acceptMountedPlayerMessage,
  createChatThreadStore,
  createProfileAwareChatThreadCreationCapability,
} from "../tavern/chat-thread-store.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { ConcurrentCasViolation, withConcurrentCasCheck } from "./concurrent-cas.js";
import { type InFlightHandle, InFlightTeardownViolation, withInFlightTeardownCheck } from "./in-flight-teardown.js";

const principal = Object.freeze({ playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" });
const chatSurfaceSessionId = "surface_01";
const profileReader = Object.freeze({
  async readExact() {
    return { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) };
  },
});

type OpenStore = Readonly<{ root: string; store: ReturnType<typeof createChatThreadStore> }>;

async function openStore(threadIds: readonly string[]): Promise<OpenStore> {
  const root = await canonicalTestRoot("gamebuddy-in-flight-gauntlet-");
  const store = createChatThreadStore(root, identityKey(principal));
  const creation = createProfileAwareChatThreadCreationCapability(store, profileReader);
  for (const chatThreadId of threadIds) {
    await creation.createExplicit({
      chatThreadId,
      companionId: principal.companionId,
      continuityId: principal.continuityId,
      chatSurfaceSessionId,
      opening: "blank",
    });
  }
  return Object.freeze({ root, store });
}

function closeStore(open: OpenStore): void {
  open.store.close?.();
  rmSync(open.root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

/**
 * The composed read a management panel performs: two store reads in one request. One `listThreads`
 * cannot be parked inside the store - it has already done its SQL when it returns - so the park sits
 * between the two reads, which is exactly where a lane switch or a store close lands in production.
 */
function composedRead(
  store: ReturnType<typeof createChatThreadStore>,
): (inFlight: InFlightHandle) => Promise<readonly unknown[]> {
  return async (inFlight) => {
    const threads = await store.listThreads!();
    inFlight.enter();
    await inFlight.released;
    return [threads, await store.listThreadLastMessages!()];
  };
}

/** The read a CAS pair is judged on: the whole durable row, as the next request would read it. */
async function readState(
  store: ReturnType<typeof createChatThreadStore>,
  chatThreadId: string,
): Promise<ChatThreadState> {
  return await store.resumeThread(chatThreadId, chatSurfaceSessionId);
}

type Registration = Readonly<{
  container: string;
  /** The close path or CAS this entry covers, as the declaration that owns it names it. */
  seam: string;
  /** Every own member of the container whose name says it closes something. */
  closeMembers: readonly string[];
  story: "in-flight teardown" | "one revision, two writers";
  /** The test that runs it, when it is not this file. */
  runs: string;
}>;

const REGISTRATIONS: readonly Registration[] = Object.freeze([
  Object.freeze({
    container: "ChatLane",
    seam: "createChatLaneFence(...).close() - composition/chat-lane-fence.ts",
    closeMembers: Object.freeze(["close"]),
    story: "in-flight teardown" as const,
    runs: "in-flight-gauntlet.test.ts: a lane switch waits for the read inside it",
  }),
  Object.freeze({
    container: "ChatThreadStore",
    seam: "ChatThreadStore.close() - tavern/chat-thread-store.ts",
    closeMembers: Object.freeze(["close"]),
    story: "in-flight teardown" as const,
    runs: "in-flight-gauntlet.test.ts: the store's own close has no barrier, measured, not asserted as correct",
  }),
  Object.freeze({
    container: "memory management service",
    seam: "MemoryManagementService.close() - tavern/memory-management/memory-management.ts",
    closeMembers: Object.freeze(["close"]),
    story: "in-flight teardown" as const,
    runs: "tavern/memory-management/memory-management.test.ts: a read parked while the service is closed and rebuilt",
  }),
  Object.freeze({
    container: "chat management revision",
    seam: "renameThreadTitle / transitionLifecycle on expectedManagementRevision - tavern/chat-thread-store.ts",
    closeMembers: Object.freeze([]),
    story: "one revision, two writers" as const,
    runs: "in-flight-gauntlet.test.ts: a rename and an archive on one management revision",
  }),
  Object.freeze({
    container: "chat draft revision",
    seam: "saveDraft / acceptMounted on expectedDraftRevision - tavern/chat-thread-store.ts",
    closeMembers: Object.freeze([]),
    story: "one revision, two writers" as const,
    runs: "in-flight-gauntlet.test.ts: a draft save and a send on one draft revision",
  }),
]);

/** The members a container publishes whose name says it closes something. */
function publishedCloseMembers(container: object): readonly string[] {
  return Object.freeze(
    Object.keys(container)
      .filter((member) => member === "close" || member.startsWith("close") || member.endsWith("Close"))
      .sort(),
  );
}

test("the gauntlet's registration population is printed, and every publishable close path is named", async (t) => {
  t.diagnostic(
    `in-flight gauntlet registrations: ${REGISTRATIONS.length} - ${REGISTRATIONS.map((entry) => `${entry.container} (${entry.story})`).join("; ")}`,
  );
  assert.ok(REGISTRATIONS.length !== 0, "a gauntlet with no registrations agrees with itself");
  assert.equal(new Set(REGISTRATIONS.map((entry) => entry.container)).size, REGISTRATIONS.length);

  // Derived from the objects themselves rather than from this table: a container that gains a second
  // close path tomorrow publishes it on its own instance, and the entry that no longer names every one
  // of them fails here with the container's name. The Memory service is the one container this file
  // cannot construct - it needs a real mounted lease - so its entry is declared in the table and
  // exercised in that service's own suite.
  const fence = createChatLaneFence(async () => undefined);
  assert.deepEqual(publishedCloseMembers(fence), REGISTRATIONS[0]?.closeMembers ?? [], "ChatLane");
  await fence.close();
  const open = await openStore([]);
  try {
    assert.deepEqual(publishedCloseMembers(open.store), REGISTRATIONS[1]?.closeMembers ?? [], "ChatThreadStore");
  } finally {
    closeStore(open);
  }
});

test("ChatLane: a lane switch closes the lane only after the read inside it has returned", async (t) => {
  const open = await openStore(["thread_01"]);
  let closes = 0;
  const lane = createChatLaneFence(async () => {
    closes += 1;
    open.store.close?.();
  });
  try {
    const reading = await withInFlightTeardownCheck<readonly unknown[]>({
      name: "ChatLane: a management read admitted on the lane is still inside it when the switch closes the lane",
      start: (inFlight) => lane.use("management.managementService.listChats", () => composedRead(open.store)(inFlight)),
      teardown: () => lane.close(),
      refusals: ["chat_lane_closed"],
    });
    assert.equal(reading.outcome, "completed");
    t.diagnostic(`ChatLane reading: ${reading.outcome}, closes=${closes}`);
    assert.equal((reading.value ?? []).length, 2);
    assert.equal(closes, 1);
  } finally {
    closeStore(open);
  }
});

test("ChatThreadStore: its own close() is not a barrier, so the read inside it dies - the lane fence is what closes that gap", async () => {
  const open = await openStore(["thread_01"]);
  try {
    await assert.rejects(
      () =>
        withInFlightTeardownCheck({
          name: "ChatThreadStore.close() while a composed read is inside it",
          start: composedRead(open.store),
          teardown: async () => {
            open.store.close?.();
          },
          refusals: [],
        }),
      (error: unknown) => {
        assert.ok(error instanceof InFlightTeardownViolation, `expected a violation, saw ${String(error)}`);
        // The measured reading, not a wish: `closeConnection` closes the DatabaseSync under the
        // reader, and the second read of the same request is refused by name. What makes this
        // safe in production is the lane fence above, not this store.
        assert.match(error.finding, /^store_closed_error:chat_thread_store_closed:/u);
        return true;
      },
    );
  } finally {
    closeStore(open);
  }
});

test("the in-flight check fails on a scenario with nothing in flight, on an unbounded refusal, and on a silent hang", async () => {
  await assert.rejects(
    () =>
      withInFlightTeardownCheck({
        name: "nothing was in flight",
        start: async (inFlight) => {
          inFlight.enter();
          return "already finished";
        },
        teardown: async () => undefined,
        refusals: [],
      }),
    (error: unknown) => {
      assert.ok(error instanceof InFlightTeardownViolation);
      assert.match(error.finding, /^start_ended_before_the_park_was_released:completed:/u);
      return true;
    },
  );

  await assert.rejects(
    () =>
      withInFlightTeardownCheck({
        name: "refused with a code nobody declared",
        start: async (inFlight) => {
          inFlight.enter();
          await inFlight.released;
          throw new Error("something_went_wrong");
        },
        teardown: async () => undefined,
        refusals: ["declared_refusal"],
      }),
    (error: unknown) => {
      assert.ok(error instanceof InFlightTeardownViolation);
      assert.match(error.finding, /^unbounded_refusal:something_went_wrong:/u);
      return true;
    },
  );

  await assert.rejects(
    () =>
      withInFlightTeardownCheck({
        name: "never settles after the release",
        start: async (inFlight) => {
          inFlight.enter();
          await inFlight.released;
          await new Promise<void>(() => undefined);
          return "unreachable";
        },
        teardown: async () => undefined,
        refusals: [],
        settleTimeoutMs: 10,
      }),
    (error: unknown) => {
      assert.ok(error instanceof InFlightTeardownViolation);
      assert.match(error.finding, /^silent_hang:start_after_release_did_not_settle_within_10ms$/u);
      return true;
    },
  );
});

test("chat management revision: a rename and an archive on one revision leave exactly one of them done", async (t) => {
  const open = await openStore(["thread_01", "thread_02"]);
  const expectedRevision = (await readState(open.store, "thread_01")).thread.managementRevision ?? 1;
  try {
    const reading = await withConcurrentCasCheck({
      name: "chat management revision: rename vs archive on thread_01",
      expectedRevision,
      first: () =>
        open.store.renameThreadTitle!({
          chatThreadId: "thread_01",
          chatSurfaceSessionId,
          expectedManagementRevision: expectedRevision,
          title: "Renamed by the gauntlet",
        }),
      second: () =>
        open.store.transitionLifecycle!({
          chatThreadId: "thread_01",
          chatSurfaceSessionId,
          companionId: principal.companionId,
          continuityId: principal.continuityId,
          expectedManagementRevision: expectedRevision,
          operation: "archive",
        }),
      conflicts: ["chat_thread_management_revision_conflict"],
      readDurable: () => readState(open.store, "thread_01"),
      assertCoherent: (durable) => {
        assert.equal(durable.thread.managementRevision, expectedRevision + 1, "the row advanced exactly once");
        const renamed = durable.thread.title === "Renamed by the gauntlet";
        const archived = durable.thread.lifecycleStatus === "archived";
        assert.notEqual(
          renamed,
          archived,
          `both writes are readable in one row: renamed=${renamed} archived=${archived}`,
        );
        assert.equal(durable.thread.lifecycleStatus !== "trashed", true, "the row was not left half-trashed");
      },
    });
    assert.equal(reading.conflict, "chat_thread_management_revision_conflict");
    t.diagnostic(
      `management revision ${expectedRevision}: winner=${reading.winner}, conflict=${reading.conflict}, title=${String(reading.durable.thread.title)}, lifecycle=${String(reading.durable.thread.lifecycleStatus)}, revision=${String(reading.durable.thread.managementRevision)}`,
    );

    // The survivor stays live, so the archive that lost did not take the list with it.
    assert.equal((await readState(open.store, "thread_02")).thread.lifecycleStatus, "active");

    // The same two writers a revision apart both land, which is exactly what the check must refuse to
    // certify: the green reading above is only worth something if this one is red.
    const otherRevision = (await readState(open.store, "thread_02")).thread.managementRevision ?? 1;
    await assert.rejects(
      () =>
        withConcurrentCasCheck({
          name: "chat management revision: a rename and an archive one revision apart (injected)",
          expectedRevision: otherRevision,
          first: () =>
            open.store.renameThreadTitle!({
              chatThreadId: "thread_02",
              chatSurfaceSessionId,
              expectedManagementRevision: otherRevision,
              title: "Renamed second",
            }),
          second: () =>
            open.store.transitionLifecycle!({
              chatThreadId: "thread_02",
              chatSurfaceSessionId,
              companionId: principal.companionId,
              continuityId: principal.continuityId,
              expectedManagementRevision: otherRevision + 1,
              operation: "archive",
            }),
          conflicts: ["chat_thread_management_revision_conflict"],
          readDurable: () => readState(open.store, "thread_02"),
          assertCoherent: () => undefined,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ConcurrentCasViolation, `expected a violation, saw ${String(error)}`);
        assert.match(
          error.finding,
          new RegExp(`^expected_exactly_one_winner_at_revision_${otherRevision}:first=completed,second=completed`, "u"),
        );
        return true;
      },
    );
  } finally {
    closeStore(open);
  }
});

test("chat draft revision: a draft save and a send on one revision leave exactly one of them done", async (t) => {
  const open = await openStore(["thread_01"]);
  const state = await readState(open.store, "thread_01");
  const expectedRevision = state.draft.revision;
  try {
    const reading = await withConcurrentCasCheck({
      name: "chat draft revision: saveDraft vs acceptMountedPlayerMessage on thread_01",
      expectedRevision,
      first: () =>
        open.store.saveDraft!({
          chatThreadId: "thread_01",
          chatSurfaceSessionId,
          expectedDraftRevision: expectedRevision,
          text: "Typed twice",
        }),
      second: () =>
        acceptMountedPlayerMessage(
          {
            runtimeRoot: open.root,
            chatThreadId: "thread_01",
            chatSurfaceSessionId,
            ...principal,
            selectionGeneration: 1,
          },
          {
            text: "Sent while the draft was being saved",
            locale: "en-US",
            idempotencyKey: "abcdefghijklmnopqrstuv",
            expectedDraftRevision: expectedRevision,
            authoredContextPreparation: { sourceRefs: Object.freeze([]), stableTokenCount: 0 },
          },
        ),
      conflicts: ["chat_draft_revision_conflict"],
      readDurable: () => readState(open.store, "thread_01"),
      assertCoherent: (durable) => {
        assert.equal(durable.draft.revision, expectedRevision + 1, "the draft advanced exactly once");
        const draftLanded = durable.draft.text !== null;
        const turnLanded = durable.turnLedger !== null;
        assert.notEqual(draftLanded, turnLanded, `draft and send both landed: draft=${draftLanded} turn=${turnLanded}`);
        const playerRows = durable.messages.filter((message) => message.kind === "player");
        assert.equal(playerRows.length, turnLanded ? 1 : 0, "the player row follows the turn, never the draft");
        if (turnLanded) assert.equal(durable.turnLedger?.status, "accepted_queued");
      },
    });
    assert.equal(reading.conflict, "chat_draft_revision_conflict");
    t.diagnostic(
      `draft revision ${expectedRevision}: winner=${reading.winner}, conflict=${reading.conflict}, draft=${String(reading.durable.draft.text)}, turn=${String(reading.durable.turnLedger?.status)}, revision=${String(reading.durable.draft.revision)}`,
    );
  } finally {
    closeStore(open);
  }
});

test("the CAS check fails when both writers win, when the loser's refusal is undeclared, and when the row it re-reads is incoherent", async () => {
  const base = { expectedRevision: 1, conflicts: ["declared_conflict"], name: "injected" } as const;

  await assert.rejects(
    () =>
      withConcurrentCasCheck({
        ...base,
        conflicts: [...base.conflicts],
        first: async () => "first",
        second: async () => "second",
        readDurable: async () => "row",
        assertCoherent: () => undefined,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ConcurrentCasViolation);
      assert.match(error.finding, /^expected_exactly_one_winner_at_revision_1:first=completed,second=completed/u);
      return true;
    },
  );

  await assert.rejects(
    () =>
      withConcurrentCasCheck({
        ...base,
        conflicts: [...base.conflicts],
        first: async () => "first",
        second: async () => {
          throw new Error("unexpected_refusal");
        },
        readDurable: async () => "row",
        assertCoherent: () => undefined,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ConcurrentCasViolation);
      assert.match(error.finding, /^unbounded_conflict:second_refused_with_unexpected_refusal:/u);
      return true;
    },
  );

  await assert.rejects(
    () =>
      withConcurrentCasCheck({
        ...base,
        conflicts: [...base.conflicts],
        first: async () => "first",
        second: async () => {
          throw new Error("declared_conflict");
        },
        readDurable: async () => "half-written",
        assertCoherent: () => {
          throw new Error("both writes are readable in one row");
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ConcurrentCasViolation);
      assert.match(
        error.finding,
        /^incoherent_durable_state_after_first_won_at_revision_1:both writes are readable in one row$/u,
      );
      return true;
    },
  );
});
