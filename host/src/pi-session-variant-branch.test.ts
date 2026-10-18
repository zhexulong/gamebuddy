import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { type AgentSession, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";

import {
  branchPiVariantAnchor,
  editPiTranscriptEntry,
  rewindPiTranscriptTail,
  type PiTranscriptMessage,
  type PiVariantPosition,
} from "./pi-session-variant-branch.internal.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";

const PROMPT_TEXT = "I waited at the bus stop until noon.";
const EARLIER_PROMPT_TEXT = "I walked down to the harbor at dawn.";
const EARLIER_REPLY = "Earlier reply: the gulls were still asleep.";
const FIRST_REPLY = "First reply: I was still on the pier.";
const SECOND_REPLY = "Second reply: I came as soon as the rain eased.";
const REGENERATED_REPLY = "Regenerated reply: the rain made me late.";
const SECOND_REGENERATED_REPLY = "Second regeneration: the rain stopped and I walked over.";
const EDITED_PROMPT_TEXT = "I waited at the bus stop until noon, then took the second bus.";
const THIRD_PROMPT_TEXT = "I asked the driver where this one goes.";

type Fixture = Readonly<{
  root: string;
  cwd: string;
  sessionDir: string;
  sessionManager: SessionManager;
  session: AgentSession;
  /** The model-visible messages exactly as Pi projects them into the session. */
  modelMessages(): readonly (readonly [string, unknown])[];
  /** Releases the mounted Pi session but keeps the session file for a re-open. */
  dispose(): void;
  close(): Promise<void>;
}>;

/** One projected message as `[role, content]`. */
function projectedMessage(message: AgentSession["agent"]["state"]["messages"][number]): readonly [string, unknown] {
  return [message.role, "content" in message ? message.content : null];
}

function appendPrompt(sessionManager: SessionManager, text: string): string {
  return sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });
}

function appendReply(sessionManager: SessionManager, text: string): string {
  return sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

/**
 * One session shape, append-only: `replies` is the committed variant history of
 * the tail position, so `[A1]` is the clean shape `user(P) A1` and
 * `[A1, A2]` is the shape a same-leaf regeneration used to leave behind,
 * `user(P) A1 user(P) A2`.
 */
async function createSession(prefix: string, replies: readonly string[]): Promise<Fixture> {
  const root = await canonicalTestRoot(prefix);
  const cwd = join(root, "runtime");
  const sessionDir = join(root, "sessions");
  const sessionManager = SessionManager.create(cwd, sessionDir);
  for (const reply of replies) {
    appendPrompt(sessionManager, PROMPT_TEXT);
    appendReply(sessionManager, reply);
  }
  const { session } = await createAgentSession({
    cwd,
    agentDir: join(root, "agent"),
    sessionManager,
    noTools: "all",
    tools: [],
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    session.dispose();
  };
  return {
    root,
    cwd,
    sessionDir,
    sessionManager,
    session,
    modelMessages: () => session.agent.state.messages.map(projectedMessage),
    dispose,
    close: async () => {
      dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function quoted(messages: readonly (readonly [string, unknown])[]): string {
  return JSON.stringify(messages);
}

function countRole(messages: readonly (readonly [string, unknown])[], role: string): number {
  return messages.filter(([actual]) => actual === role).length;
}

function position(variantTexts: readonly string[]): PiVariantPosition {
  return Object.freeze({ variantTexts: Object.freeze([...variantTexts]) });
}

/** One dropped transcript message, as the durable transcript itself holds it. */
function drop(role: "player" | "companion", text: string): PiTranscriptMessage {
  return Object.freeze({ role, text });
}

/** The runner's own order for a regeneration: the branch first, then the prompt. */
function regenerate(fixture: Fixture, reply: string): void {
  appendPrompt(fixture.sessionManager, PROMPT_TEXT);
  appendReply(fixture.sessionManager, reply);
  fixture.session.refreshContext();
}

test("a regeneration projects the player's line exactly once and exactly one reply", async () => {
  const fixture = await createSession("gamebuddy-variant-branch-clean-", [FIRST_REPLY]);
  try {
    // The polluted shape the old context-edit activation left: both the player's
    // line and the reply appear twice in the model's context.
    assert.equal(countRole(fixture.modelMessages(), "user"), 1);
    assert.equal(countRole(fixture.modelMessages(), "assistant"), 1);

    const branched = branchPiVariantAnchor(fixture.session, position([FIRST_REPLY]), PROMPT_TEXT);
    assert.equal(branched.status, "branched");
    // The leaf is before the player's line, so the un-answered line is gone too.
    assert.deepEqual(fixture.modelMessages(), []);

    regenerate(fixture, REGENERATED_REPLY);

    const after = fixture.modelMessages();
    assert.equal(countRole(after, "user"), 1);
    assert.equal(countRole(after, "assistant"), 1);
    assert.deepEqual(after, [
      ["user", [{ type: "text", text: PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: REGENERATED_REPLY }]],
    ]);
    assert.equal(quoted(after).includes(FIRST_REPLY), false);
  } finally {
    await fixture.close();
  }
});

/**
 * The exact shape tonight's real session file carried after one regeneration on
 * the same leaf: `user(P) A1 user(P) A2`. The branch walk consumes both pairs,
 * so the model's context returns to exactly one player line and one reply.
 */
test("a polluted same-leaf session is cut back to before its first player line", async () => {
  const fixture = await createSession("gamebuddy-variant-branch-polluted-", [FIRST_REPLY, SECOND_REPLY]);
  try {
    assert.equal(countRole(fixture.modelMessages(), "user"), 2);
    assert.equal(countRole(fixture.modelMessages(), "assistant"), 2);

    const branched = branchPiVariantAnchor(fixture.session, position([FIRST_REPLY, SECOND_REPLY]), PROMPT_TEXT);
    assert.equal(branched.status, "branched");
    assert.deepEqual(fixture.modelMessages(), []);

    regenerate(fixture, REGENERATED_REPLY);

    const after = fixture.modelMessages();
    assert.equal(countRole(after, "user"), 1);
    assert.equal(countRole(after, "assistant"), 1);
    assert.deepEqual(after, [
      ["user", [{ type: "text", text: PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: REGENERATED_REPLY }]],
    ]);
    assert.equal(quoted(after).includes(FIRST_REPLY), false);
    assert.equal(quoted(after).includes(SECOND_REPLY), false);
  } finally {
    await fixture.close();
  }
});

test("a second regeneration still projects one player line and one reply", async () => {
  const fixture = await createSession("gamebuddy-variant-branch-twice-", [FIRST_REPLY]);
  try {
    assert.equal(branchPiVariantAnchor(fixture.session, position([FIRST_REPLY]), PROMPT_TEXT).status, "branched");
    regenerate(fixture, REGENERATED_REPLY);
    assert.equal(
      branchPiVariantAnchor(fixture.session, position([FIRST_REPLY, REGENERATED_REPLY]), PROMPT_TEXT).status,
      "branched",
    );
    regenerate(fixture, SECOND_REGENERATED_REPLY);

    const after = fixture.modelMessages();
    assert.equal(countRole(after, "user"), 1);
    assert.equal(countRole(after, "assistant"), 1);
    assert.deepEqual(after, [
      ["user", [{ type: "text", text: PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: SECOND_REGENERATED_REPLY }]],
    ]);
  } finally {
    await fixture.close();
  }
});

test("a regeneration keeps the turns that came before the anchor", async () => {
  const fixture = await createSession("gamebuddy-variant-branch-earlier-", []);
  try {
    appendPrompt(fixture.sessionManager, EARLIER_PROMPT_TEXT);
    appendReply(fixture.sessionManager, EARLIER_REPLY);
    appendPrompt(fixture.sessionManager, PROMPT_TEXT);
    appendReply(fixture.sessionManager, FIRST_REPLY);
    fixture.session.refreshContext();

    const branched = branchPiVariantAnchor(fixture.session, position([FIRST_REPLY]), PROMPT_TEXT);
    assert.equal(branched.status, "branched");
    assert.deepEqual(fixture.modelMessages(), [
      ["user", [{ type: "text", text: EARLIER_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: EARLIER_REPLY }]],
    ]);

    regenerate(fixture, REGENERATED_REPLY);

    const after = fixture.modelMessages();
    assert.equal(countRole(after, "user"), 2);
    assert.equal(countRole(after, "assistant"), 2);
    assert.deepEqual(after, [
      ["user", [{ type: "text", text: EARLIER_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: EARLIER_REPLY }]],
      ["user", [{ type: "text", text: PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: REGENERATED_REPLY }]],
    ]);
  } finally {
    await fixture.close();
  }
});

test("a branch reverts to the exact context it replaced", async () => {
  const fixture = await createSession("gamebuddy-variant-branch-revert-", [FIRST_REPLY]);
  try {
    const before = quoted(fixture.modelMessages());
    const branched = branchPiVariantAnchor(fixture.session, position([FIRST_REPLY]), PROMPT_TEXT);
    assert.equal(branched.status, "branched");
    assert.notEqual(quoted(fixture.modelMessages()), before);
    if (branched.status !== "branched") throw new Error("unreachable");
    branched.revert();
    assert.equal(quoted(fixture.modelMessages()), before);
  } finally {
    await fixture.close();
  }
});

test("the branch is durable: re-opening the session from its file lands on the new reply", async () => {
  const fixture = await createSession("gamebuddy-variant-branch-durable-", [FIRST_REPLY]);
  let reopened: AgentSession | undefined;
  try {
    const branched = branchPiVariantAnchor(fixture.session, position([FIRST_REPLY]), PROMPT_TEXT);
    assert.equal(branched.status, "branched");
    regenerate(fixture, REGENERATED_REPLY);
    const regeneratedReplyId = fixture.sessionManager.getLeafId();
    assert.notEqual(regeneratedReplyId, null);
    assert.equal(quoted(fixture.modelMessages()).includes(REGENERATED_REPLY), true);

    fixture.dispose();
    const revivedManager = SessionManager.continueRecent(fixture.cwd, fixture.sessionDir);
    assert.equal(revivedManager.getSessionId(), fixture.sessionManager.getSessionId());
    // `_buildIndex` resets the leaf to the file's last entry, which is the reply
    // the branch appended, so no leaf pointer needs persisting.
    assert.equal(revivedManager.getLeafId(), regeneratedReplyId);
    const revived = await createAgentSession({
      cwd: fixture.cwd,
      agentDir: join(fixture.root, "agent"),
      sessionManager: revivedManager,
      noTools: "all",
      tools: [],
    });
    reopened = revived.session;
    const after = reopened.agent.state.messages.map(projectedMessage);
    assert.equal(countRole(after, "user"), 1);
    assert.equal(countRole(after, "assistant"), 1);
    assert.deepEqual(after, [
      ["user", [{ type: "text", text: PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: REGENERATED_REPLY }]],
    ]);
  } finally {
    reopened?.dispose();
    await fixture.close();
  }
});

/**
 * Every shape the derivation cannot prove refuses, and a refusal is silent: no
 * entry is appended, so the leaf and the projection are byte-identical after.
 */
test("a position whose session shape cannot be proven refuses and mutates nothing", async () => {
  const fixture = await createSession("gamebuddy-variant-branch-refusal-", [FIRST_REPLY]);
  try {
    const before = quoted(fixture.modelMessages());
    const leafBefore = fixture.sessionManager.getLeafId();
    const entriesBefore = fixture.sessionManager.getEntryCount();
    const cases = [
      { variantTexts: [] as readonly string[], anchorText: PROMPT_TEXT, reason: "variant_position_has_no_variant" },
      {
        variantTexts: ["a variant this session never carried"],
        anchorText: PROMPT_TEXT,
        reason: "variant_reply_tail_text_mismatch",
      },
      {
        variantTexts: [FIRST_REPLY],
        anchorText: "a player line this session never carried",
        reason: "variant_anchor_unavailable",
      },
    ] as const;
    for (const item of cases) {
      const result = branchPiVariantAnchor(fixture.session, position(item.variantTexts), item.anchorText);
      assert.equal(result.status, "refused", item.reason);
      if (result.status === "refused") assert.equal(result.reason, item.reason);
      assert.equal(fixture.sessionManager.getEntryCount(), entriesBefore, item.reason);
      assert.equal(fixture.sessionManager.getLeafId(), leafBefore, item.reason);
      assert.equal(quoted(fixture.modelMessages()), before, item.reason);
    }

    const userTail = await createSession("gamebuddy-variant-branch-user-tail-", []);
    try {
      appendPrompt(userTail.sessionManager, PROMPT_TEXT);
      userTail.session.refreshContext();
      assert.deepEqual(branchPiVariantAnchor(userTail.session, position([FIRST_REPLY]), PROMPT_TEXT), {
        status: "refused",
        reason: "variant_reply_tail_unavailable",
      });
    } finally {
      await userTail.close();
    }
  } finally {
    await fixture.close();
  }
});

/**
 * The rewind half, and the property that separates it from the variant half: a rewind appends no
 * prompt afterwards, so the leaf alone would be undone by the next mount - `_buildIndex` resets the
 * leaf to the file's LAST entry whenever a session is re-opened. So the proof is not "the leaf moved"
 * but "a session re-opened from its own file still does not carry the dropped turns".
 */
test("a rewind leaves the dropped exchange out of the model's path, and the session file agrees", async () => {
  const fixture = await createSession("gamebuddy-rewind-tail-", [FIRST_REPLY, SECOND_REPLY]);
  let reopened: AgentSession | undefined;
  try {
    assert.equal(countRole(fixture.modelMessages(), "user"), 2);
    const dropped = Object.freeze([drop("player", PROMPT_TEXT), drop("companion", SECOND_REPLY)]);
    const rewound = rewindPiTranscriptTail(fixture.session, dropped);
    assert.equal(rewound.status, "rewound");
    // The dropped exchange has left the active path: one player line and one reply, and the dropped
    // reply appears nowhere in the projection the next request carries.
    const after = fixture.modelMessages();
    assert.equal(countRole(after, "user"), 1);
    assert.equal(countRole(after, "assistant"), 1);
    assert.deepEqual(after, [
      ["user", [{ type: "text", text: PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: FIRST_REPLY }]],
    ]);
    assert.equal(quoted(after).includes(SECOND_REPLY), false);

    // The durable half: nothing was removed from the file (sessions are append-only), but a fresh
    // manager opening that file lands its leaf on the kept side of the cut, so the dropped turns are
    // still not part of the model's context. This is the assertion a bare leaf move fails.
    fixture.dispose();
    const revivedManager = SessionManager.continueRecent(fixture.cwd, fixture.sessionDir);
    assert.equal(revivedManager.getSessionId(), fixture.sessionManager.getSessionId());
    const revived = await createAgentSession({
      cwd: fixture.cwd,
      agentDir: join(fixture.root, "agent"),
      sessionManager: revivedManager,
      noTools: "all",
      tools: [],
    });
    reopened = revived.session;
    const durable = reopened.agent.state.messages.map(projectedMessage);
    assert.equal(countRole(durable, "user"), 1);
    assert.equal(countRole(durable, "assistant"), 1);
    assert.deepEqual(durable, [
      ["user", [{ type: "text", text: PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: FIRST_REPLY }]],
    ]);

    // And the conversation continues from where the transcript now ends.
    appendPrompt(revivedManager, EARLIER_PROMPT_TEXT);
    appendReply(revivedManager, REGENERATED_REPLY);
    reopened.refreshContext();
    assert.deepEqual(reopened.agent.state.messages.map(projectedMessage), [
      ["user", [{ type: "text", text: PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: FIRST_REPLY }]],
      ["user", [{ type: "text", text: EARLIER_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: REGENERATED_REPLY }]],
    ]);
  } finally {
    reopened?.dispose();
    await fixture.close();
  }
});

/**
 * Every shape the rewind derivation cannot prove refuses, and a refusal is silent: no entry is
 * appended, so the leaf, the entry count and the projection are byte-identical after. The whole
 * branch is droppable too - a transcript that becomes empty has no kept entry to pin the cut to, so
 * every dropped entry is omitted - and `revert()` restores exactly what was there.
 */
test("a transcript tail the session does not carry refuses and mutates nothing", async () => {
  const fixture = await createSession("gamebuddy-rewind-refusal-", [FIRST_REPLY]);
  try {
    const before = quoted(fixture.modelMessages());
    const leafBefore = fixture.sessionManager.getLeafId();
    const entriesBefore = fixture.sessionManager.getEntryCount();
    const playerLine = drop("player", PROMPT_TEXT);
    const cases = [
      { dropped: [] as readonly PiTranscriptMessage[], reason: "rewind_nothing_dropped" },
      {
        dropped: [playerLine, drop("companion", "a reply this session never carried")],
        reason: "rewind_tail_text_mismatch",
      },
      {
        dropped: [playerLine, drop("companion", FIRST_REPLY), playerLine],
        reason: "rewind_tail_unavailable",
      },
      {
        dropped: [drop("player", "a player line this session never carried"), drop("companion", FIRST_REPLY)],
        reason: "rewind_tail_text_mismatch",
      },
    ] as const;
    for (const item of cases) {
      const result = rewindPiTranscriptTail(fixture.session, item.dropped);
      assert.equal(result.status, "refused", item.reason);
      if (result.status === "refused") assert.equal(result.reason, item.reason);
      assert.equal(fixture.sessionManager.getEntryCount(), entriesBefore, item.reason);
      assert.equal(fixture.sessionManager.getLeafId(), leafBefore, item.reason);
      assert.equal(quoted(fixture.modelMessages()), before, item.reason);
    }

    // The whole branch is a legal drop - a transcript that becomes empty - and the omissions are what
    // makes it survive a re-open, because the last edit is the file's last entry.
    const emptied = rewindPiTranscriptTail(fixture.session, [playerLine, drop("companion", FIRST_REPLY)]);
    assert.equal(emptied.status, "rewound");
    assert.deepEqual(fixture.modelMessages(), []);
    if (emptied.status === "rewound") emptied.revert();
    assert.equal(fixture.sessionManager.getLeafId(), leafBefore);
    assert.equal(quoted(fixture.modelMessages()), before);

    // Re-applied, and then read from the file alone: the omission is a session entry, so it is what a
    // re-open lands on rather than something this process remembers.
    const emptiedAgain = rewindPiTranscriptTail(fixture.session, [playerLine, drop("companion", FIRST_REPLY)]);
    assert.equal(emptiedAgain.status, "rewound");
    fixture.dispose();
    const revivedManager = SessionManager.continueRecent(fixture.cwd, fixture.sessionDir);
    assert.deepEqual(revivedManager.buildSessionProjection().messages, []);
  } finally {
    await fixture.close();
  }
});

/**
 * The edit half, and the property that separates it from the other two: nothing is shortened. The
 * edited entry keeps its place on the path and every entry after it stays there, so the projection is
 * the same conversation with one entry's words replaced - and the appended edit is the file's LAST
 * entry, which is what makes the replacement survive a re-open the way a rewind's cut does.
 */
test("an edit replaces one entry's words, and a session re-opened from its file carries them", async () => {
  const fixture = await createSession("gamebuddy-transcript-edit-", [FIRST_REPLY]);
  appendPrompt(fixture.sessionManager, EARLIER_PROMPT_TEXT);
  appendReply(fixture.sessionManager, SECOND_REPLY);
  fixture.session.refreshContext();
  let reopened: AgentSession | undefined;
  try {
    assert.deepEqual(fixture.modelMessages(), [
      ["user", [{ type: "text", text: PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: FIRST_REPLY }]],
      ["user", [{ type: "text", text: EARLIER_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: SECOND_REPLY }]],
    ]);

    const edited = editPiTranscriptEntry(fixture.session, 0, drop("player", PROMPT_TEXT), EDITED_PROMPT_TEXT);
    assert.equal(edited.status, "edited");
    // Only the one entry's words changed: the entry's own content shape is kept, and nothing after it
    // left the path - an edit is not a cut.
    assert.deepEqual(fixture.modelMessages(), [
      ["user", [{ type: "text", text: EDITED_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: FIRST_REPLY }]],
      ["user", [{ type: "text", text: EARLIER_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: SECOND_REPLY }]],
    ]);
    assert.equal(countRole(fixture.modelMessages(), "assistant"), 2);

    // The durable half: the appended edit is the file's last entry, so a fresh manager opening that
    // file lands its leaf on the edit and the replacement is what the context carries.
    fixture.dispose();
    const revivedManager = SessionManager.continueRecent(fixture.cwd, fixture.sessionDir);
    assert.equal(revivedManager.getSessionId(), fixture.sessionManager.getSessionId());
    const revived = await createAgentSession({
      cwd: fixture.cwd,
      agentDir: join(fixture.root, "agent"),
      sessionManager: revivedManager,
      noTools: "all",
      tools: [],
    });
    reopened = revived.session;
    assert.deepEqual(reopened.agent.state.messages.map(projectedMessage), [
      ["user", [{ type: "text", text: EDITED_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: FIRST_REPLY }]],
      ["user", [{ type: "text", text: EARLIER_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: SECOND_REPLY }]],
    ]);

    // And the conversation continues from there, with the edited words still the ones the model reads.
    appendPrompt(revivedManager, THIRD_PROMPT_TEXT);
    appendReply(revivedManager, REGENERATED_REPLY);
    reopened.refreshContext();
    assert.deepEqual(reopened.agent.state.messages.map(projectedMessage), [
      ["user", [{ type: "text", text: EDITED_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: FIRST_REPLY }]],
      ["user", [{ type: "text", text: EARLIER_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: SECOND_REPLY }]],
      ["user", [{ type: "text", text: THIRD_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: REGENERATED_REPLY }]],
    ]);
  } finally {
    reopened?.dispose();
    await fixture.close();
  }
});

/**
 * Every shape the edit's derivation cannot prove refuses, and the refusal is silent: no entry is
 * appended, so the leaf, the entry count and the projection are byte-identical after. `revert()`
 * restores the entry's own words the same way - as another append-only edit - so it outlives the
 * process rather than depending on what this one remembers.
 */
test("an entry the session does not carry refuses, and a revert is itself durable", async () => {
  const fixture = await createSession("gamebuddy-transcript-edit-refusal-", [FIRST_REPLY]);
  try {
    const before = quoted(fixture.modelMessages());
    const leafBefore = fixture.sessionManager.getLeafId();
    const entriesBefore = fixture.sessionManager.getEntryCount();
    const cases = [
      { index: 4, target: drop("player", PROMPT_TEXT), reason: "edit_target_unavailable" },
      { index: 0, target: drop("player", "a line this session never carried"), reason: "edit_target_text_mismatch" },
      { index: 0, target: drop("companion", PROMPT_TEXT), reason: "edit_target_text_mismatch" },
      { index: 1, target: drop("player", FIRST_REPLY), reason: "edit_target_text_mismatch" },
    ] as const;
    for (const item of cases) {
      const result = editPiTranscriptEntry(fixture.session, item.index, item.target, EDITED_PROMPT_TEXT);
      assert.equal(result.status, "refused", item.reason);
      if (result.status === "refused") assert.equal(result.reason, item.reason);
      assert.equal(fixture.sessionManager.getEntryCount(), entriesBefore, item.reason);
      assert.equal(fixture.sessionManager.getLeafId(), leafBefore, item.reason);
      assert.equal(quoted(fixture.modelMessages()), before, item.reason);
    }

    const edited = editPiTranscriptEntry(fixture.session, 0, drop("player", PROMPT_TEXT), EDITED_PROMPT_TEXT);
    assert.equal(edited.status, "edited");
    assert.deepEqual(fixture.modelMessages(), [
      ["user", [{ type: "text", text: EDITED_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: FIRST_REPLY }]],
    ]);
    if (edited.status === "edited") edited.revert();
    assert.equal(quoted(fixture.modelMessages()), before);

    // The restoration is a session entry rather than a leaf move, so a re-open reads the original
    // words too: there is nothing for the next mount to undo.
    const editedAgain = editPiTranscriptEntry(fixture.session, 0, drop("player", PROMPT_TEXT), EDITED_PROMPT_TEXT);
    assert.equal(editedAgain.status, "edited");
    fixture.dispose();
    const revivedManager = SessionManager.continueRecent(fixture.cwd, fixture.sessionDir);
    assert.deepEqual(
      revivedManager
        .buildSessionProjection()
        .messages.map((message) => [message.role, "content" in message ? message.content : null]),
      [
        ["user", [{ type: "text", text: EDITED_PROMPT_TEXT }]],
        ["assistant", [{ type: "text", text: FIRST_REPLY }]],
      ],
    );
  } finally {
    await fixture.close();
  }
});
