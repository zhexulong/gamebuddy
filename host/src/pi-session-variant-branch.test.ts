import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { type AgentSession, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";

import {
  branchPiTranscriptTail,
  branchPiVariantAnchor,
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
 * The rewind half of the same leaf placement, in the same terms: the dropped rows are the durable
 * transcript's own tail, so the proof lives in the session branch's newest message entries, and the
 * next request must carry the shortened conversation instead of the one the player rewound away.
 */
test("a rewind drops the transcript's tail from the model's active path, and the next prompt appends there", async () => {
  const fixture = await createSession("gamebuddy-rewind-tail-", [FIRST_REPLY, SECOND_REPLY]);
  try {
    assert.equal(countRole(fixture.modelMessages(), "user"), 2);
    const dropped = Object.freeze([
      Object.freeze({ role: "player" as const, text: PROMPT_TEXT }),
      Object.freeze({ role: "companion" as const, text: SECOND_REPLY }),
    ]);
    const branched = branchPiTranscriptTail(fixture.session, dropped);
    assert.equal(branched.status, "branched");
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
    // The conversation continues from where the transcript now ends: the new pair is a child of the
    // kept reply, not a sibling of the exchange the player removed.
    appendPrompt(fixture.sessionManager, EARLIER_PROMPT_TEXT);
    appendReply(fixture.sessionManager, REGENERATED_REPLY);
    fixture.session.refreshContext();
    assert.deepEqual(fixture.modelMessages(), [
      ["user", [{ type: "text", text: PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: FIRST_REPLY }]],
      ["user", [{ type: "text", text: EARLIER_PROMPT_TEXT }]],
      ["assistant", [{ type: "text", text: REGENERATED_REPLY }]],
    ]);
  } finally {
    await fixture.close();
  }
});

/**
 * Every shape the rewind derivation cannot prove refuses, and a refusal is silent: no entry is
 * appended, so the leaf, the entry count and the projection are byte-identical after. The whole
 * branch is droppable too - a Chat whose transcript becomes empty puts the leaf back at the root,
 * and `revert()` restores exactly what was there.
 */
test("a transcript tail the session does not carry refuses and mutates nothing", async () => {
  const fixture = await createSession("gamebuddy-rewind-refusal-", [FIRST_REPLY]);
  try {
    const before = quoted(fixture.modelMessages());
    const leafBefore = fixture.sessionManager.getLeafId();
    const entriesBefore = fixture.sessionManager.getEntryCount();
    const playerLine = Object.freeze({ role: "player" as const, text: PROMPT_TEXT });
    const cases = [
      { dropped: [] as readonly ReturnType<typeof drop>[], reason: "rewind_nothing_dropped" },
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
      const result = branchPiTranscriptTail(fixture.session, item.dropped);
      assert.equal(result.status, "refused", item.reason);
      if (result.status === "refused") assert.equal(result.reason, item.reason);
      assert.equal(fixture.sessionManager.getEntryCount(), entriesBefore, item.reason);
      assert.equal(fixture.sessionManager.getLeafId(), leafBefore, item.reason);
      assert.equal(quoted(fixture.modelMessages()), before, item.reason);
    }

    // The whole branch is a legal drop - a transcript that becomes empty - and the leaf goes back
    // to the root, so nothing the player rewound away is still in front of the model.
    const emptied = branchPiTranscriptTail(fixture.session, [playerLine, drop("companion", FIRST_REPLY)]);
    assert.equal(emptied.status, "branched");
    assert.equal(fixture.sessionManager.getLeafId(), null);
    assert.deepEqual(fixture.modelMessages(), []);
    if (emptied.status === "branched") emptied.revert();
    assert.equal(fixture.sessionManager.getLeafId(), leafBefore);
    assert.equal(quoted(fixture.modelMessages()), before);
  } finally {
    await fixture.close();
  }
});
