import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { type AgentSession, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";

import { type PiTranscriptMessage, alignSessionToTranscriptRows } from "../pi-session-variant-branch.internal.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { forkIdentityFor } from "./chat-fork-service.js";
import {
  type ChatThreadMessage,
  type ChatThreadState,
  type GreetingSource,
  createChatThreadStore,
  createProfileAwareChatThreadCreationCapability,
} from "./chat-thread-store.js";

/**
 * The fork's end-to-end promise, read from the model's side: the branch a player lands on carries rows 0..N.
 *
 * The store's copy and the mount's alignment are two different mechanisms, and each has its own reading; what
 * neither of them alone can show is the thing the player actually gets - fork at a message, open the branch, and
 * the companion's assembled context is the conversation up to that message with the origin's later turns absent.
 * So this drives the real store, forks at a known row, mounts the branch through the SAME alignment a mount runs
 * (`alignSessionToTranscriptRows`), and reads `session.agent.state.messages` - the context the next request
 * carries - rather than any count of rows or session entries.
 *
 * The branch has NO session file of its own, which is exactly the state a fork produces: the store mints a fresh
 * `chatSurfaceSessionId` and mints no session, so the branch's first mount is the absent-session shape.
 */

const source: GreetingSource = {
  greetingSetId: "greetings_01",
  sourceRevision: 2,
  canonicalHash: "a".repeat(64),
  variantId: "alternate_01",
  profileRevision: 3,
  scenarioRevision: null,
};
const opening = { messageId: "opening_01", text: "Welcome to the tavern.", source } as const;

const profileReader = {
  async readExact() {
    return { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) };
  },
};

const storeKey = createHash("sha256")
  .update(["player_01", "companion_01", "continuity_01"].join("\u001f"))
  .digest("hex");

/** The opening the Chat was created with, and the five rows after it: a prefix and a tail cannot be confused. */
const OPENING_TEXT = "Welcome to the tavern.";
const ROWS = [
  ["player_01", "Evening."],
  ["response_01", "Evening to you."],
  ["player_02", "Busy night?"],
  ["response_02", "Steady enough."],
  ["player_03", "Then pour me one."],
] as const;
/** Every row the origin holds, opening first: what a branch cut at `response_01` must and must not carry. */
const ORIGIN_TEXTS = [OPENING_TEXT, ...ROWS.map(([, text]) => text)];

async function fixture() {
  const root = await canonicalTestRoot("gamebuddy-chat-fork-mount-");
  let time = 10;
  const store = createChatThreadStore(root, storeKey, () => time++);
  const creation = createProfileAwareChatThreadCreationCapability(store, profileReader);
  await creation.createExplicit({
    chatThreadId: "thread_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    chatSurfaceSessionId: "surface_01",
    stableArtifactBindings: [{ kind: "persona", sourceId: "persona_01", revision: 4, canonicalHash: "b".repeat(64) }],
    opening,
  });
  await store.appendPlayer("thread_01", { messageId: "player_01", text: "Evening.", occurredAtMs: 101 });
  await store.commitResponse("thread_01", { messageId: "response_01", text: "Evening to you.", occurredAtMs: 102 });
  await store.appendPlayer("thread_01", { messageId: "player_02", text: "Busy night?", occurredAtMs: 103 });
  await store.commitResponse("thread_01", { messageId: "response_02", text: "Steady enough.", occurredAtMs: 104 });
  await store.appendPlayer("thread_01", { messageId: "player_03", text: "Then pour me one.", occurredAtMs: 105 });
  return { root, store };
}

/** The store's rows as the mount's transcript input: role and text, in order, nothing else. */
function transcriptOf(state: ChatThreadState): readonly PiTranscriptMessage[] {
  return state.messages.map((message: ChatThreadMessage) => Object.freeze({ role: message.role, text: message.text }));
}

function conversationOfRows(rows: readonly PiTranscriptMessage[]): readonly string[] {
  return rows.map((one) => `${one.role === "player" ? "user" : "assistant"}: ${one.text}`);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const value = part as { type?: unknown; text?: unknown };
    if (value.type === "text" && typeof value.text === "string") parts.push(value.text);
  }
  return parts.join("");
}

/** What the model carries on its next request: roles and text, with the Host's own system prompt excluded. */
function conversationOf(session: AgentSession): readonly string[] {
  return session.agent.state.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role}: ${textOf("content" in message ? message.content : null)}`);
}

test("a branch opened after a fork carries rows 0..N of the conversation, and none of the origin's tail", async () => {
  const { root, store } = await fixture();
  let session: AgentSession | undefined;
  try {
    const origin = await store.resumeThread("thread_01", "surface_01");
    assert.deepEqual(
      transcriptOf(origin).map((one) => one.text),
      ORIGIN_TEXTS,
      "the origin holds the opening and all five rows before the fork",
    );
    // Fork at the second row of the first exchange: a prefix of two, with three rows behind it the branch must not
    // inherit and the origin must not lose.
    const identity = forkIdentityFor("Fk3qZ9vT2mR7xLb1Nc8Wd4");
    await store.forkThread!({
      originChatThreadId: "thread_01",
      originMessageId: "response_01",
      chatThreadId: identity.chatThreadId,
      chatSurfaceSessionId: identity.chatSurfaceSessionId,
    });

    const branch = await store.resumeThread(identity.chatThreadId, identity.chatSurfaceSessionId);
    const branchRows = transcriptOf(branch);
    assert.deepEqual(
      branchRows.map((one) => one.text),
      [OPENING_TEXT, "Evening.", "Evening to you."],
      "the branch carries the opening and the prefix ending at the named row",
    );
    assert.equal(
      branch.thread.continuityId,
      origin.thread.continuityId,
      "both branches are one conversation to Memory",
    );

    // The branch's first mount: the store minted a surface session and no session file, which is the shape a fork
    // hands a launch. The alignment a mount runs is the same one, over the branch's own rows.
    const sessionDir = join(root, identity.chatSurfaceSessionId);
    const { session: mounted } = await createAgentSession({
      cwd: root,
      agentDir: join(root, "agent"),
      sessionManager: SessionManager.continueRecent(root, sessionDir),
      noTools: "all",
      tools: [],
    });
    session = mounted;
    assert.deepEqual(conversationOf(mounted), [], "the branch starts with no session at all");

    const alignment = alignSessionToTranscriptRows(mounted, [...branchRows]);
    assert.deepEqual(alignment, { status: "aligned", dropped: 0, appended: 3 });

    // The reading, quoted: the model's own assembled context, which is what the next request carries.
    const carried = conversationOf(mounted);
    assert.deepEqual(
      carried,
      conversationOfRows(branchRows),
      `the branch's assembled context was ${JSON.stringify(carried)}`,
    );
    assert.deepEqual(carried, [`assistant: ${OPENING_TEXT}`, "user: Evening.", "assistant: Evening to you."]);

    // And the origin is untouched: the rows the branch does not carry are still the origin's.
    assert.deepEqual(
      transcriptOf(await store.resumeThread("thread_01", "surface_01")).map((one) => one.text),
      ORIGIN_TEXTS,
    );
  } finally {
    session?.dispose();
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
