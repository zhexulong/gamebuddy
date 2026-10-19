import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { type AgentSession, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";

import {
  anchorPiSessionGreeting,
  greetingAnchorOccupiesFirstTranscriptEntry,
} from "./pi-session-greeting-anchor.internal.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";

const GREETING = "*The kettle is already warm on the porch step.* Come and sit, the rain is easing.";
const RECOMMITTED_GREETING = "*She sets a second cup down.* You made it - I kept the porch dry for you.";
const SCAFFOLDING_ONLY_GREETING = "<thinking>wonder whether the player came back for the book</thinking>";
const PROMPT_TEXT = "I waited at the bus stop until noon.";
const REPLY_TEXT = "First reply: I was still on the pier.";
const HOST_SYSTEM_PROMPT = "You are the companion in this scene; speak only for yourself.";

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
  return sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
}

/** The Host's own system prompt, appended the way a real mounted session carries it: one message entry
 * at the head of the branch, which no durable transcript row names. */
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

async function createSession(prefix: string): Promise<Fixture> {
  const root = await canonicalTestRoot(prefix);
  const cwd = join(root, "runtime");
  const sessionDir = join(root, "sessions");
  const sessionManager = SessionManager.create(cwd, sessionDir);
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

/**
 * The write itself, and the live context it has to reach: `agent.state.messages` is what the next
 * prompt sends, and a session write reaches it only through `refreshContext()`.
 */
test("an empty conversation opens on the greeting as its own first assistant message", async () => {
  const fixture = await createSession("gamebuddy-greeting-anchor-");
  try {
    const before = fixture.sessionManager.getEntryCount();
    const anchored = anchorPiSessionGreeting(fixture.session, GREETING);
    assert.equal(anchored.status, "anchored");
    if (anchored.status !== "anchored") throw new Error("unreachable");
    assert.equal(fixture.sessionManager.getEntryCount(), before + 1);
    assert.equal(fixture.sessionManager.getLeafId(), anchored.entryId);
    // The live model context, not just the file: one assistant line, and it is the greeting.
    assert.deepEqual(fixture.modelMessages(), [["assistant", [{ type: "text", text: GREETING }]]]);
    // Its own provenance is not the mounted model: no provider response produced these words.
    const entry = fixture.sessionManager.getEntry(anchored.entryId);
    assert.equal(entry?.type, "message");
    const message = (entry as { message: Record<string, unknown> }).message;
    assert.equal(message.role, "assistant");
    assert.equal(message.api, "gamebuddy-authored");
    assert.equal(message.provider, "gamebuddy");
    assert.deepEqual((message.usage as { totalTokens: number }).totalTokens, 0);
    assert.equal(greetingAnchorOccupiesFirstTranscriptEntry(fixture.sessionManager), true);
  } finally {
    await fixture.close();
  }
});

/**
 * The idempotency the brief demands, proved through the authority that decides it: the session's own
 * entries, read back by the mount a reload performs.
 */
test("a repeated mount finds the anchor in the session's own entries and writes nothing", async () => {
  const fixture = await createSession("gamebuddy-greeting-anchor-once-");
  let reopened: AgentSession | undefined;
  try {
    const anchored = anchorPiSessionGreeting(fixture.session, GREETING);
    assert.equal(anchored.status, "anchored");
    const entriesAfterFirstMount = fixture.sessionManager.getEntryCount();
    const leafAfterFirstMount = fixture.sessionManager.getLeafId();

    const second = anchorPiSessionGreeting(fixture.session, GREETING);
    assert.equal(second.status, "present");
    assert.equal(fixture.sessionManager.getEntryCount(), entriesAfterFirstMount);
    assert.equal(fixture.sessionManager.getLeafId(), leafAfterFirstMount);

    // A reload: the session is re-opened from its own file, and then mounted again.
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
      ["assistant", [{ type: "text", text: GREETING }]],
    ]);
    const remount = anchorPiSessionGreeting(reopened, GREETING);
    assert.equal(remount.status, "present");
    assert.equal(revivedManager.getEntryCount(), entriesAfterFirstMount);
    // Exactly one greeting entry in the whole file: the anchor is never written twice.
    assert.equal(
      revivedManager.getEntries().filter((entry) => entry.type === "message").length,
      1,
      JSON.stringify(revivedManager.getEntries().map((entry) => entry.type)),
    );
  } finally {
    reopened?.dispose();
    await fixture.close();
  }
});

/**
 * A session that started before the anchor existed. The anchor cannot be inserted at the head of an
 * append-only conversation without dropping the conversation off the model's path, so the mount keeps
 * the shape it found and says so.
 */
test("a conversation that already carries its own line keeps its shape", async () => {
  const fixture = await createSession("gamebuddy-greeting-anchor-started-");
  try {
    appendPrompt(fixture.sessionManager, PROMPT_TEXT);
    appendReply(fixture.sessionManager, REPLY_TEXT);
    fixture.session.refreshContext();
    const before = quoted(fixture.modelMessages());
    const entriesBefore = fixture.sessionManager.getEntryCount();

    const outcome = anchorPiSessionGreeting(fixture.session, GREETING);

    assert.deepEqual(outcome, { status: "withheld", reason: "conversation_started" });
    assert.equal(fixture.sessionManager.getEntryCount(), entriesBefore);
    assert.equal(quoted(fixture.modelMessages()), before);
    assert.equal(greetingAnchorOccupiesFirstTranscriptEntry(fixture.sessionManager), false);
  } finally {
    await fixture.close();
  }
});

/**
 * The one shape where the two authorities already disagree: the opening was re-chosen after the mount
 * wrote it (the new-chat window `commitOpening` is legal in). The mount writes nothing - it is not an
 * author of history - and reports the disagreement, while the anchor the model reads keeps the first
 * position among the entries the transcript can carry.
 */
test("a greeting the opening no longer holds is reported, not rewritten", async () => {
  const fixture = await createSession("gamebuddy-greeting-anchor-superseded-");
  try {
    assert.equal(anchorPiSessionGreeting(fixture.session, GREETING).status, "anchored");
    const entriesBefore = fixture.sessionManager.getEntryCount();
    const before = quoted(fixture.modelMessages());

    const outcome = anchorPiSessionGreeting(fixture.session, RECOMMITTED_GREETING);

    assert.deepEqual(outcome, { status: "withheld", reason: "greeting_superseded" });
    assert.equal(fixture.sessionManager.getEntryCount(), entriesBefore);
    assert.equal(quoted(fixture.modelMessages()), before);
    assert.equal(before.includes(RECOMMITTED_GREETING), false);
    assert.equal(greetingAnchorOccupiesFirstTranscriptEntry(fixture.sessionManager), true);
  } finally {
    await fixture.close();
  }
});

/**
 * A greeting the transcript row projection drops (all scaffolding, or longer than a row may hold)
 * carries no countable line - so it holds no position among the entries an edit proves against, while
 * it is still the mount's own write and is never written a second time.
 */
test("a greeting the row projection drops still counts as the mount's own write", async () => {
  const fixture = await createSession("gamebuddy-greeting-anchor-uncountable-");
  try {
    assert.equal(anchorPiSessionGreeting(fixture.session, SCAFFOLDING_ONLY_GREETING).status, "anchored");
    const entriesAfterFirstMount = fixture.sessionManager.getEntryCount();
    assert.equal(greetingAnchorOccupiesFirstTranscriptEntry(fixture.sessionManager), false);

    assert.equal(anchorPiSessionGreeting(fixture.session, SCAFFOLDING_ONLY_GREETING).status, "present");
    assert.equal(fixture.sessionManager.getEntryCount(), entriesAfterFirstMount);
  } finally {
    await fixture.close();
  }
});

/**
 * The Host's own system prompt is a message entry no transcript row names, and it can sit anywhere
 * around the anchor: it must neither become the anchor's position nor hide it.
 */
test("a system entry around the anchor shifts neither its position nor its identity", async () => {
  const fixture = await createSession("gamebuddy-greeting-anchor-system-");
  try {
    appendSystemPrompt(fixture.sessionManager, HOST_SYSTEM_PROMPT);
    assert.equal(anchorPiSessionGreeting(fixture.session, GREETING).status, "anchored");
    appendPrompt(fixture.sessionManager, PROMPT_TEXT);
    appendReply(fixture.sessionManager, REPLY_TEXT);
    fixture.session.refreshContext();

    assert.equal(greetingAnchorOccupiesFirstTranscriptEntry(fixture.sessionManager), true);
    assert.equal(anchorPiSessionGreeting(fixture.session, GREETING).status, "present");
    // The entries the transcript can carry are the anchor and then the player's line and the reply, in
    // that order: this is the order the mounted edit's positional arithmetic counts on.
    const carried = fixture.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "message")
      .map((entry) => (entry.type === "message" ? (entry.message as { role: string }).role : ""))
      .filter((role) => role === "user" || role === "assistant");
    assert.deepEqual(carried, ["assistant", "user", "assistant"]);
  } finally {
    await fixture.close();
  }
});
