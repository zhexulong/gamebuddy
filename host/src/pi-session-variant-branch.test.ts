import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { type AgentSession, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";

import {
  bindSettledPromptEntries,
  boundEntryOnActivePath,
  branchPiVariantAnchor,
  deletePiTranscriptEntry,
  editPiTranscriptEntry,
  rewindPiTranscriptTail,
  sessionEntryIds,
  type PiTranscriptMessage,
  type PiVariantPosition,
} from "./pi-session-variant-branch.internal.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import { chatTranscriptAssistantText } from "./native-companion-content.js";

const PROMPT_TEXT = "I waited at the bus stop until noon.";
const EARLIER_PROMPT_TEXT = "I walked down to the harbor at dawn.";
const EARLIER_REPLY = "Earlier reply: the gulls were still asleep.";
const FIRST_REPLY = "First reply: I was still on the pier.";
const SECOND_REPLY = "Second reply: I came as soon as the rain eased.";
const REGENERATED_REPLY = "Regenerated reply: the rain made me late.";
const SECOND_REGENERATED_REPLY = "Second regeneration: the rain stopped and I walked over.";
const EDITED_PROMPT_TEXT = "I waited at the bus stop until noon, then took the second bus.";
const THIRD_PROMPT_TEXT = "I asked the driver where this one goes.";
const EDITED_EARLIER_PROMPT_TEXT = "The early bus pulled out as I reached the stop.";
const HOST_SYSTEM_PROMPT = "You are the companion in this scene; speak only for yourself.";
const TOOL_COMMENTARY = "Checking the shelf by the door.";

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

/**
 * The Host's own system prompt, appended the way a real mounted session carries it: one message entry
 * at the head of the branch, which no durable transcript row names.
 */
function appendSystemPrompt(sessionManager: SessionManager, text: string): string {
  return sessionManager.appendMessage({ role: "system", content: text, timestamp: Date.now() });
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
 * appended, so the leaf, the entry count and the projection are byte-identical after. An EMPTY suffix is
 * not one of them - the cut's own last row asks for nothing to be removed, and that lands on the entry
 * the conversation already ends at. The whole branch is droppable too - a transcript that becomes empty
 * has no kept entry to pin the cut to, so every dropped entry is omitted - and `revert()` restores
 * exactly what was there.
 */
test("a transcript tail the session does not carry refuses and mutates nothing", async () => {
  const fixture = await createSession("gamebuddy-rewind-refusal-", [FIRST_REPLY]);
  try {
    const before = quoted(fixture.modelMessages());
    const leafBefore = fixture.sessionManager.getLeafId();
    const entriesBefore = fixture.sessionManager.getEntryCount();
    const playerLine = drop("player", PROMPT_TEXT);
    const cases = [
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

    // An empty suffix is not a refusal, and it is not silent either: the cut keeps the row the player
    // named, so the transcript's LAST row asks for nothing to be removed. The proof pins the cut to the
    // entry the conversation already ends at - the model's path is byte-identical - and the appended
    // no-op edit is what makes that durable for a session re-opened from the file, exactly as every
    // other cut's pinning edit is. `revert()` puts the leaf back where it was.
    const beforeEmpty = quoted(fixture.modelMessages());
    const leafBeforeEmpty = fixture.sessionManager.getLeafId();
    const nothingDropped = rewindPiTranscriptTail(fixture.session, []);
    assert.equal(nothingDropped.status, "rewound");
    assert.equal(quoted(fixture.modelMessages()), beforeEmpty);
    if (nothingDropped.status === "rewound") nothingDropped.revert();
    assert.equal(fixture.sessionManager.getLeafId(), leafBeforeEmpty);

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

    const edited = editPiTranscriptEntry(fixture.session, [drop("player", PROMPT_TEXT)], EDITED_PROMPT_TEXT);
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
    // A row the model carries nothing for refuses, whichever way it fails to pair: words no entry
    // holds, an entry's own words named in the other role, the same words named for an earlier row, and
    // a row past the end of what the session carries. The pairing proves a prefix, so each case refuses
    // on the first row it cannot carry - and the last row is the target.
    const cases = [
      { rows: [drop("player", "a line this session never carried")], reason: "edit_target_unavailable" },
      { rows: [drop("companion", PROMPT_TEXT)], reason: "edit_target_unavailable" },
      { rows: [drop("player", FIRST_REPLY)], reason: "edit_target_unavailable" },
      {
        rows: [drop("player", PROMPT_TEXT), drop("companion", FIRST_REPLY), drop("player", "a line after the end")],
        reason: "edit_target_unavailable",
      },
    ] as const;
    for (const item of cases) {
      const result = editPiTranscriptEntry(fixture.session, item.rows, EDITED_PROMPT_TEXT);
      assert.equal(result.status, "refused", item.reason);
      if (result.status === "refused") assert.equal(result.reason, item.reason);
      assert.equal(fixture.sessionManager.getEntryCount(), entriesBefore, item.reason);
      assert.equal(fixture.sessionManager.getLeafId(), leafBefore, item.reason);
      assert.equal(quoted(fixture.modelMessages()), before, item.reason);
    }

    const edited = editPiTranscriptEntry(fixture.session, [drop("player", PROMPT_TEXT)], EDITED_PROMPT_TEXT);
    assert.equal(edited.status, "edited");
    assert.deepEqual(fixture.modelMessages(), [
      ["user", [{ type: "text", text: EDITED_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: FIRST_REPLY }]],
    ]);
    if (edited.status === "edited") edited.revert();
    assert.equal(quoted(fixture.modelMessages()), before);

    // The restoration is a session entry rather than a leaf move, so a re-open reads the original
    // words too: there is nothing for the next mount to undo.
    const editedAgain = editPiTranscriptEntry(fixture.session, [drop("player", PROMPT_TEXT)], EDITED_PROMPT_TEXT);
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

/**
 * The session a real mount leaves carries message entries no transcript row names. Read off a recorded
 * product run's own file, its first message entry was the Host's system prompt and only then the
 * exchanges followed (`system, user(P), assistant(A1), …`); the mount now writes the greeting anchor
 * ahead of it (`pi-session-greeting-anchor.internal.ts`), so the system prompt sits after an entry a
 * row does name. Either way the system prompt is a message entry no transcript row names, and a
 * position counted over every message entry therefore named the entry one place early: in the product
 * every edit refused while the row's own entry sat one place later. A position is the transcript's, so
 * only an entry that carries one of its rows occupies one.
 */
test("an edit proves its entry in a session whose head is the Host's own system prompt", async () => {
  const fixture = await createSession("gamebuddy-transcript-edit-system-prompt-", []);
  try {
    appendSystemPrompt(fixture.sessionManager, HOST_SYSTEM_PROMPT);
    appendPrompt(fixture.sessionManager, PROMPT_TEXT);
    appendReply(fixture.sessionManager, FIRST_REPLY);
    appendPrompt(fixture.sessionManager, EARLIER_PROMPT_TEXT);
    appendReply(fixture.sessionManager, SECOND_REPLY);
    fixture.session.refreshContext();
    const projected = () =>
      fixture.sessionManager
        .buildSessionProjection()
        .messages.map((message) => [message.role, "content" in message ? message.content : null]);
    // The premise, read off the session itself: the branch's first message entry is the system prompt.
    assert.equal(
      fixture.sessionManager.getBranch().filter((entry) => entry.type === "message")[0]?.message?.role,
      "system",
    );

    // The transcript's own rows each pair with the entry that carries them - row 0 is the first player
    // line, row 2 the second - with the system prompt passed over at the head.
    const editedFirst = editPiTranscriptEntry(fixture.session, [drop("player", PROMPT_TEXT)], EDITED_PROMPT_TEXT);
    assert.equal(editedFirst.status, "edited", JSON.stringify(editedFirst));
    const editedSecond = editPiTranscriptEntry(
      fixture.session,
      [drop("player", EDITED_PROMPT_TEXT), drop("companion", FIRST_REPLY), drop("player", EARLIER_PROMPT_TEXT)],
      EDITED_EARLIER_PROMPT_TEXT,
    );
    assert.equal(editedSecond.status, "edited", JSON.stringify(editedSecond));
    assert.deepEqual(projected(), [
      ["system", HOST_SYSTEM_PROMPT],
      ["user", [{ type: "text", text: EDITED_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: FIRST_REPLY }]],
      ["user", [{ type: "text", text: EDITED_EARLIER_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: SECOND_REPLY }]],
    ]);

    // The proof keeps its force: a row the session cannot carry still refuses and mutates nothing.
    const entriesBefore = fixture.sessionManager.getEntryCount();
    const refused = editPiTranscriptEntry(fixture.session, [drop("player", PROMPT_TEXT)], EDITED_PROMPT_TEXT);
    assert.equal(refused.status, "refused");
    if (refused.status === "refused") assert.equal(refused.reason, "edit_target_unavailable");
    assert.equal(fixture.sessionManager.getEntryCount(), entriesBefore);

    // Durable: each replacement is an appended edit, so the file's own last entries carry the new
    // words and a mount re-opening it reads them.
    fixture.dispose();
    const revivedManager = SessionManager.continueRecent(fixture.cwd, fixture.sessionDir);
    assert.deepEqual(
      revivedManager
        .buildSessionProjection()
        .messages.map((message) => [message.role, "content" in message ? message.content : null]),
      [
        ["system", HOST_SYSTEM_PROMPT],
        ["user", [{ type: "text", text: EDITED_PROMPT_TEXT }]],
        ["assistant", [{ type: "text", text: FIRST_REPLY }]],
        ["user", [{ type: "text", text: EDITED_EARLIER_PROMPT_TEXT }]],
        ["assistant", [{ type: "text", text: SECOND_REPLY }]],
      ],
    );
  } finally {
    await fixture.close();
  }
});

/**
 * The intermediate tool-use commentary a real agent loop leaves on the session's path: an assistant
 * message that only reports a step, with no durable transcript row naming it.
 */
function appendCommentary(sessionManager: SessionManager, text: string): string {
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
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
}

/**
 * The shape a real agent loop leaves behind: an assistant message that only reports a step, between the
 * reply before it and the exchange after it, which no transcript row names. An ordinal among the entries
 * that carry text counted that commentary, so every row after it was proved one entry early - the entry
 * named carried the commentary's words, not the row's - and refused, while the rows before it landed.
 * The pairing passes over every entry no row names, so the row after it lands on its own entry and the
 * commentary is left exactly as it was.
 */
test("an edit passes over an intermediate tool-use commentary and reaches the row after it", async () => {
  const fixture = await createSession("gamebuddy-transcript-edit-commentary-", [FIRST_REPLY]);
  appendPrompt(fixture.sessionManager, EARLIER_PROMPT_TEXT);
  appendCommentary(fixture.sessionManager, TOOL_COMMENTARY);
  appendReply(fixture.sessionManager, SECOND_REPLY);
  fixture.session.refreshContext();
  try {
    // The premise, read off the session itself: the commentary sits between the second player line and
    // its reply, and the transcript's rows are the two exchanges around it.
    assert.deepEqual(fixture.modelMessages(), [
      ["user", [{ type: "text", text: PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: FIRST_REPLY }]],
      ["user", [{ type: "text", text: EARLIER_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: TOOL_COMMENTARY }]],
      ["assistant", [{ type: "text", text: SECOND_REPLY }]],
    ]);
    const entriesBefore = fixture.sessionManager.getEntryCount();

    const edited = editPiTranscriptEntry(
      fixture.session,
      [
        drop("player", PROMPT_TEXT),
        drop("companion", FIRST_REPLY),
        drop("player", EARLIER_PROMPT_TEXT),
        drop("companion", SECOND_REPLY),
      ],
      SECOND_REGENERATED_REPLY,
    );
    assert.equal(edited.status, "edited", JSON.stringify(edited));
    // Only the target's words changed: the commentary is still on the path with its own words, and the
    // append-only edit is the one entry this operation wrote.
    assert.deepEqual(fixture.modelMessages(), [
      ["user", [{ type: "text", text: PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: FIRST_REPLY }]],
      ["user", [{ type: "text", text: EARLIER_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: TOOL_COMMENTARY }]],
      ["assistant", [{ type: "text", text: SECOND_REGENERATED_REPLY }]],
    ]);
    assert.equal(fixture.sessionManager.getEntryCount(), entriesBefore + 1);
  } finally {
    await fixture.close();
  }
});

/**
 * What a settled prompt DID append is an identity fact (the session is append-only), and it is the
 * only fact Pi offers: the entry id `appendMessage` returns reaches no session listener, and
 * `AgentSession` keeps its own message -> entry map private. So the capture is a set difference across
 * the prompt, and which entry carries which durable row is answered by the same projection the row was
 * written from - never by a position among the entries of a role, which is exactly the stand-in the
 * durable binding exists to replace.
 */
test("a settled prompt's own entries bind to the rows they carry, and an ambiguous one binds nothing", async () => {
  const fixture = await createSession("gamebuddy-transcript-binding-", []);
  try {
    assert.deepEqual(fixture.modelMessages(), []);
    const before = sessionEntryIds(fixture.sessionManager);
    const playerEntry = appendPrompt(fixture.sessionManager, PROMPT_TEXT);
    const replyEntry = appendReply(fixture.sessionManager, FIRST_REPLY);
    fixture.session.refreshContext();
    assert.deepEqual(
      bindSettledPromptEntries(fixture.sessionManager, before, { playerText: PROMPT_TEXT, replyText: FIRST_REPLY }),
      [
        { role: "player", entryId: playerEntry },
        { role: "companion", entryId: replyEntry },
      ],
    );
    // A reply the prompt did not commit (a turn that failed before its presentation) binds no reply
    // row at all, and the player row it DID append still binds.
    assert.deepEqual(
      bindSettledPromptEntries(fixture.sessionManager, before, { playerText: PROMPT_TEXT, replyText: null }),
      [{ role: "player", entryId: playerEntry }],
    );
    // Two appended user entries carrying the same text are not a proof of which one is the row, so
    // the row binds nothing rather than "the newest" or "the first".
    const secondPlayerEntry = appendPrompt(fixture.sessionManager, PROMPT_TEXT);
    fixture.session.refreshContext();
    assert.deepEqual(
      bindSettledPromptEntries(fixture.sessionManager, before, { playerText: PROMPT_TEXT, replyText: FIRST_REPLY }),
      [{ role: "companion", entryId: replyEntry }],
    );
    // And a text this prompt never appended binds nothing: the capture is what it produced, not what
    // the transcript happens to contain.
    assert.deepEqual(
      bindSettledPromptEntries(fixture.sessionManager, before, {
        playerText: "A line this prompt never carried",
        replyText: "A reply this prompt never produced",
      }),
      [],
    );
    assert.equal(fixture.sessionManager.getEntry(secondPlayerEntry) !== undefined, true);
  } finally {
    await fixture.close();
  }
});

/**
 * The delete half: ONE entry stops contributing, the entries before it and after it stay on the path,
 * and a session re-opened from its own file reads the same hole - which is what separates a delete from
 * a rewind (which ends the path) and from an edit (which replaces the words but keeps the entry).
 */
test("a mid-transcript delete leaves a hole, and the session file the next mount reads has it", async () => {
  const fixture = await createSession("gamebuddy-transcript-delete-", [FIRST_REPLY]);
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
    // The binding the runner would have recorded for the first reply, read back through the active
    // path the way the delete does.
    const firstReplyEntry = fixture.sessionManager
      .getBranch()
      .find((entry) => entry.type === "message" && chatTranscriptAssistantText(entry.message) === FIRST_REPLY)!.id;
    assert.equal(
      boundEntryOnActivePath(fixture.session, [firstReplyEntry, "entry_from_another_session"]),
      firstReplyEntry,
    );
    const deleted = deletePiTranscriptEntry(fixture.session, firstReplyEntry);
    assert.equal(deleted.status, "deleted");
    // Exactly one entry left the path: the two before it and the two after it are still there, so this
    // is not a cut - it is a hole.
    assert.deepEqual(fixture.modelMessages(), [
      ["user", [{ type: "text", text: PROMPT_TEXT }]],
      ["user", [{ type: "text", text: EARLIER_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: SECOND_REPLY }]],
    ]);

    // The durable half: the appended omission is the file's LAST entry, so a fresh manager opening
    // that file lands on it and the hole is what the context carries.
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
      ["user", [{ type: "text", text: PROMPT_TEXT }]],
      ["user", [{ type: "text", text: EARLIER_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: SECOND_REPLY }]],
    ]);
  } finally {
    reopened?.dispose();
    await fixture.close();
  }
});

/**
 * Every shape the delete cannot prove refuses and mutates nothing, and `revert()` puts the entry's own
 * contribution back the same way - as another append-only edit - so it outlives the process rather
 * than depending on what this one remembers.
 */
test("an entry that is not on the model's path refuses, and a revert is itself durable", async () => {
  const fixture = await createSession("gamebuddy-transcript-delete-refusal-", [FIRST_REPLY]);
  try {
    const before = quoted(fixture.modelMessages());
    const leafBefore = fixture.sessionManager.getLeafId();
    const entriesBefore = fixture.sessionManager.getEntryCount();
    // Nothing the row could resolve to: no entry at all.
    assert.equal(boundEntryOnActivePath(fixture.session, []), null);
    assert.equal(boundEntryOnActivePath(fixture.session, ["entry_this_session_never_had"]), null);
    const refused = deletePiTranscriptEntry(fixture.session, "entry_this_session_never_had");
    assert.equal(refused.status, "refused");
    if (refused.status === "refused") assert.equal(refused.reason, "delete_target_unavailable");
    assert.equal(fixture.sessionManager.getEntryCount(), entriesBefore);
    assert.equal(fixture.sessionManager.getLeafId(), leafBefore);
    assert.equal(quoted(fixture.modelMessages()), before);

    // A reply a branch moved off the path has no contribution to remove, so it refuses as that rather
    // than appending an omission the vendor's own edit would reject anyway.
    const playerEntry = fixture.sessionManager.getBranch()[0]!.id;
    const replyEntry = fixture.sessionManager
      .getBranch()
      .find((entry) => entry.type === "message" && chatTranscriptAssistantText(entry.message) === FIRST_REPLY)!.id;
    fixture.sessionManager.branch(playerEntry);
    fixture.session.refreshContext();
    assert.equal(boundEntryOnActivePath(fixture.session, [replyEntry]), null);
    const offPath = deletePiTranscriptEntry(fixture.session, replyEntry);
    assert.equal(offPath.status, "refused");
    if (offPath.status === "refused") assert.equal(offPath.reason, "delete_target_off_path");

    // And a hole this session does make can be put back, durably.
    fixture.sessionManager.branch(replyEntry);
    fixture.session.refreshContext();
    const deleted = deletePiTranscriptEntry(fixture.session, playerEntry);
    assert.equal(deleted.status, "deleted");
    assert.deepEqual(fixture.modelMessages(), [["assistant", [{ type: "text", text: FIRST_REPLY }]]]);
    if (deleted.status === "deleted") deleted.revert();
    assert.deepEqual(fixture.modelMessages(), [
      ["user", [{ type: "text", text: PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: FIRST_REPLY }]],
    ]);
    const deletedAgain = deletePiTranscriptEntry(fixture.session, playerEntry);
    assert.equal(deletedAgain.status, "deleted");
    fixture.dispose();
    const revivedManager = SessionManager.continueRecent(fixture.cwd, fixture.sessionDir);
    assert.deepEqual(
      revivedManager
        .buildSessionProjection()
        .messages.map((message) => [message.role, "content" in message ? message.content : null]),
      [["assistant", [{ type: "text", text: FIRST_REPLY }]]],
    );
  } finally {
    await fixture.close();
  }
});
