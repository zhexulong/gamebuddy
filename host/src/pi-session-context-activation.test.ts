import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { type AgentSession, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";

import { activatePiSessionContextEntry } from "./pi-session-context-activation.internal.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";

const PROMPT_TEXT = "I waited at the bus stop until noon.";
const FIRST_REPLY = "First reply: I was still on the pier.";
const SECOND_REPLY = "Second reply: I came as soon as the rain eased.";
const REGENERATED_REPLY = "Regenerated reply: the rain made me late.";
const REPLACEMENT_TEXT = "Active variant: I ran the whole way.";
const SECOND_REPLACEMENT_TEXT = "Last variant: the rain made me late, so I ran.";

type PiChatSession = Readonly<{
  root: string;
  cwd: string;
  sessionDir: string;
  sessionManager: SessionManager;
  session: AgentSession;
  firstReplyId: string;
  secondPromptId: string;
  secondReplyId: string;
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

function appendPrompt(sessionManager: SessionManager): string {
  return sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: PROMPT_TEXT }],
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
 * The refuted shape, reproduced exactly: `user(P) assistant(A1) user(P) assistant(A2)`.
 * Pi appends both replies, so the second prompt's request carries A1 and A2 while
 * the player was shown only A2.
 */
async function createPiChatSession(prefix: string): Promise<PiChatSession> {
  const root = await canonicalTestRoot(prefix);
  const cwd = join(root, "runtime");
  const sessionDir = join(root, "sessions");
  const sessionManager = SessionManager.create(cwd, sessionDir);
  appendPrompt(sessionManager);
  const firstReplyId = appendReply(sessionManager, FIRST_REPLY);
  const secondPromptId = appendPrompt(sessionManager);
  const secondReplyId = appendReply(sessionManager, SECOND_REPLY);
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
    firstReplyId,
    secondPromptId,
    secondReplyId,
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

function activated(
  fixture: PiChatSession,
  targetId: string,
  replacement: string | null,
): Readonly<{ contextEditEntryId: string }> {
  const result = activatePiSessionContextEntry(fixture.session, { targetId, replacement });
  if (result.status !== "activated") throw new Error(`activation_refused_${result.reason}`);
  return result;
}

const PROJECTION_WITH_BOTH_REPLIES: readonly (readonly [string, unknown])[] = [
  ["user", [{ type: "text", text: PROMPT_TEXT }]],
  ["assistant", [{ type: "text", text: FIRST_REPLY }]],
  ["user", [{ type: "text", text: PROMPT_TEXT }]],
  ["assistant", [{ type: "text", text: SECOND_REPLY }]],
];

test("activation replaces the superseded reply in the model's context and leaves the other reply intact", async () => {
  const fixture = await createPiChatSession("gamebuddy-pi-activation-replace-");
  try {
    assert.equal(quoted(fixture.modelMessages()), quoted(PROJECTION_WITH_BOTH_REPLIES));

    const activation = activated(fixture, fixture.firstReplyId, REPLACEMENT_TEXT);
    assert.equal(fixture.sessionManager.getLeafId(), activation.contextEditEntryId);

    const after = quoted(fixture.modelMessages());
    assert.equal(
      after,
      quoted([
        ["user", [{ type: "text", text: PROMPT_TEXT }]],
        ["assistant", [{ type: "text", text: REPLACEMENT_TEXT }]],
        ["user", [{ type: "text", text: PROMPT_TEXT }]],
        ["assistant", [{ type: "text", text: SECOND_REPLY }]],
      ]),
    );
    assert.match(after, /Active variant: I ran the whole way\./);
    assert.doesNotMatch(after, /First reply: I was still on the pier\./);
    assert.match(after, /Second reply: I came as soon as the rain eased\./);
  } finally {
    await fixture.close();
  }
});

test("the activation is durable: re-opening the session from its file keeps the replacement", async () => {
  const fixture = await createPiChatSession("gamebuddy-pi-activation-durable-");
  let reopened: AgentSession | undefined;
  try {
    const activation = activated(fixture, fixture.secondReplyId, REPLACEMENT_TEXT);
    assert.equal(
      quoted(fixture.modelMessages()),
      quoted([
        ["user", [{ type: "text", text: PROMPT_TEXT }]],
        ["assistant", [{ type: "text", text: FIRST_REPLY }]],
        ["user", [{ type: "text", text: PROMPT_TEXT }]],
        ["assistant", [{ type: "text", text: REPLACEMENT_TEXT }]],
      ]),
    );

    fixture.dispose();
    const revivedManager = SessionManager.continueRecent(fixture.cwd, fixture.sessionDir);
    assert.equal(revivedManager.getSessionId(), fixture.sessionManager.getSessionId());
    assert.equal(revivedManager.getLeafId(), activation.contextEditEntryId);
    const revived = await createAgentSession({
      cwd: fixture.cwd,
      agentDir: join(fixture.root, "agent"),
      sessionManager: revivedManager,
      noTools: "all",
      tools: [],
    });
    reopened = revived.session;
    assert.equal(
      quoted(reopened.agent.state.messages.map(projectedMessage)),
      quoted([
        ["user", [{ type: "text", text: PROMPT_TEXT }]],
        ["assistant", [{ type: "text", text: FIRST_REPLY }]],
        ["user", [{ type: "text", text: PROMPT_TEXT }]],
        ["assistant", [{ type: "text", text: REPLACEMENT_TEXT }]],
      ]),
    );
  } finally {
    reopened?.dispose();
    await fixture.close();
  }
});

test("activating twice leaves the last replacement, and activating with null omits the entry", async () => {
  const fixture = await createPiChatSession("gamebuddy-pi-activation-repeat-");
  try {
    const first = activated(fixture, fixture.firstReplyId, REPLACEMENT_TEXT);
    const second = activated(fixture, fixture.firstReplyId, SECOND_REPLACEMENT_TEXT);
    assert.notEqual(first.contextEditEntryId, second.contextEditEntryId);
    const twice = quoted(fixture.modelMessages());
    assert.equal(
      twice,
      quoted([
        ["user", [{ type: "text", text: PROMPT_TEXT }]],
        ["assistant", [{ type: "text", text: SECOND_REPLACEMENT_TEXT }]],
        ["user", [{ type: "text", text: PROMPT_TEXT }]],
        ["assistant", [{ type: "text", text: SECOND_REPLY }]],
      ]),
    );
    assert.doesNotMatch(twice, /Active variant: I ran the whole way\./);

    activated(fixture, fixture.firstReplyId, null);
    assert.equal(
      quoted(fixture.modelMessages()),
      quoted([
        ["user", [{ type: "text", text: PROMPT_TEXT }]],
        ["user", [{ type: "text", text: PROMPT_TEXT }]],
        ["assistant", [{ type: "text", text: SECOND_REPLY }]],
      ]),
    );
  } finally {
    await fixture.close();
  }
});

test("an unknown target id is refused with a bounded reason and changes nothing", async () => {
  const fixture = await createPiChatSession("gamebuddy-pi-activation-unknown-");
  try {
    const before = quoted(fixture.modelMessages());
    const entriesBefore = fixture.sessionManager.getEntryCount();
    assert.deepEqual(
      activatePiSessionContextEntry(fixture.session, {
        targetId: "not-a-session-entry",
        replacement: REPLACEMENT_TEXT,
      }),
      { status: "refused", reason: "unknown_target" },
    );
    assert.equal(quoted(fixture.modelMessages()), before);
    assert.equal(fixture.sessionManager.getEntryCount(), entriesBefore);
  } finally {
    await fixture.close();
  }
});

test("a target that exists off the model's active branch is refused with a bounded reason", async () => {
  const fixture = await createPiChatSession("gamebuddy-pi-activation-branch-");
  try {
    // The player regenerates: the leaf moves back to the second prompt, so the
    // reply the player replaced becomes a sibling of the new one and leaves the
    // model's branch. Pi keeps it in the append-only file either way.
    fixture.sessionManager.branch(fixture.secondPromptId);
    const regeneratedId = appendReply(fixture.sessionManager, REGENERATED_REPLY);
    fixture.session.refreshContext();
    assert.equal(
      quoted(fixture.modelMessages()),
      quoted([
        ["user", [{ type: "text", text: PROMPT_TEXT }]],
        ["assistant", [{ type: "text", text: FIRST_REPLY }]],
        ["user", [{ type: "text", text: PROMPT_TEXT }]],
        ["assistant", [{ type: "text", text: REGENERATED_REPLY }]],
      ]),
    );
    assert.equal(fixture.sessionManager.getEntry(fixture.secondReplyId) !== undefined, true);
    assert.equal(
      fixture.sessionManager.getBranch().some((entry) => entry.id === fixture.secondReplyId),
      false,
    );
    assert.equal(
      fixture.sessionManager.getBranch().some((entry) => entry.id === regeneratedId),
      true,
    );
    const before = quoted(fixture.modelMessages());
    const entriesBefore = fixture.sessionManager.getEntryCount();
    assert.deepEqual(
      activatePiSessionContextEntry(fixture.session, {
        targetId: fixture.secondReplyId,
        replacement: REPLACEMENT_TEXT,
      }),
      { status: "refused", reason: "target_off_active_branch" },
    );
    assert.equal(quoted(fixture.modelMessages()), before);
    assert.equal(fixture.sessionManager.getEntryCount(), entriesBefore);
  } finally {
    await fixture.close();
  }
});
