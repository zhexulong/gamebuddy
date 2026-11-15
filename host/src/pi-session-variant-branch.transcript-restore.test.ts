import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { type AgentSession, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";

import { type PiTranscriptMessage, alignSessionToTranscriptRows } from "./pi-session-variant-branch.internal.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";

/**
 * The mount's own alignment, read from the model's side.
 *
 * Every reading here is taken from the context the session ASSEMBLES - `session.agent.state.messages`, which is
 * what the next request carries - and never from a count of session entries. A count is exactly what the
 * `aligned` status used to be made of while the model was carrying nothing, so a count cannot be the proof.
 */

const HOST_SYSTEM_PROMPT = "You are the companion in this scene; speak only for yourself.";

/** One durable transcript row, as the store holds it. */
function row(role: "player" | "companion", text: string): PiTranscriptMessage {
  return Object.freeze({ role, text });
}

/**
 * A five-row conversation: a greeting, then two exchanges. It is deliberately longer than one turn, so a mount
 * that restores only its tail cannot pass.
 */
const TRANSCRIPT: readonly PiTranscriptMessage[] = Object.freeze([
  row("companion", "*She looks up from the ledger.* You are early."),
  row("player", "The ferry was cancelled."),
  row("companion", "Then we walk. *She closes the book.*"),
  row("player", "In this rain?"),
  row("companion", "Especially in this rain."),
]);

type Mounted = Readonly<{
  session: AgentSession;
  /** The conversation the model actually carries, role and text, in order. */
  conversation(): readonly string[];
  close(): Promise<void>;
}>;

function appendRow(sessionManager: SessionManager, one: PiTranscriptMessage): void {
  if (one.role === "player") {
    sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: one.text }], timestamp: Date.now() });
    return;
  }
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: one.text }],
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

/** The text one projected message contributes, whatever shape its content has. */
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

/** The conversation as the model carries it: the Host's own system prompt holds no line of it. */
function conversationOf(session: AgentSession): readonly string[] {
  return session.agent.state.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role}: ${textOf("content" in message ? message.content : null)}`);
}

/** The conversation the transcript says the model should carry. */
function conversationOfRows(rows: readonly PiTranscriptMessage[]): readonly string[] {
  return rows.map((one) => `${one.role === "player" ? "user" : "assistant"}: ${one.text}`);
}

/**
 * Opens the mount under test: whatever `seed` wrote is the session FILE on disk, and the mount is the next
 * re-open of that directory - the same `SessionManager.continueRecent` a real mount runs.
 */
async function mountWithSessionFile(prefix: string, seed: (sessionManager: SessionManager) => void): Promise<Mounted> {
  const root = await canonicalTestRoot(prefix);
  const cwd = join(root, "runtime");
  const sessionDir = join(root, "sessions");
  const seedManager = SessionManager.create(cwd, sessionDir);
  seed(seedManager);
  // The mount that wrote those rows is over; the file it left is what the next mount reads.
  const seeded = await createAgentSession({
    cwd,
    agentDir: join(root, "agent"),
    sessionManager: seedManager,
    noTools: "all",
    tools: [],
  });
  seeded.session.dispose();
  return await openMount(cwd, sessionDir, root);
}

/** The mount under test over a session directory that holds no session file at all. */
async function mountWithoutSessionFile(prefix: string): Promise<Mounted> {
  const root = await canonicalTestRoot(prefix);
  return await openMount(join(root, "runtime"), join(root, "sessions"), root);
}

async function openMount(cwd: string, sessionDir: string, root: string): Promise<Mounted> {
  const { session } = await createAgentSession({
    cwd,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.continueRecent(cwd, sessionDir),
    noTools: "all",
    tools: [],
  });
  return {
    session,
    conversation: () => conversationOf(session),
    close: async () => {
      session.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a mount whose session file is absent is given every row the transcript holds", async () => {
  const mount = await mountWithoutSessionFile("gamebuddy-transcript-restore-absent-");
  try {
    // The shape a fork has: a fresh surface session, so nothing on the model's side at all.
    assert.deepEqual(mount.conversation(), []);
    const alignment = alignSessionToTranscriptRows(mount.session, TRANSCRIPT);
    assert.deepEqual(alignment, { status: "aligned", dropped: 0, appended: 5 });
    // The model's own assembled context, quoted: it is the reading, not the row count, that has to be right.
    const carried = mount.conversation();
    assert.deepEqual(
      carried,
      conversationOfRows(TRANSCRIPT),
      `the model's assembled context was ${JSON.stringify(carried)}`,
    );
  } finally {
    await mount.close();
  }
});

test("a mount whose session file stops short is given the rows it is missing, past its own system prompt", async () => {
  const mount = await mountWithSessionFile("gamebuddy-transcript-restore-truncated-", (sessionManager) => {
    // A real mounted session opens on the Host's own system prompt, which no transcript row names.
    sessionManager.appendMessage({ role: "system", content: HOST_SYSTEM_PROMPT, timestamp: Date.now() });
    for (const one of TRANSCRIPT.slice(0, 2)) appendRow(sessionManager, one);
  });
  try {
    assert.deepEqual(
      mount.conversation(),
      conversationOfRows(TRANSCRIPT.slice(0, 2)),
      "the seeded session carries exactly the two rows it was written with",
    );
    const alignment = alignSessionToTranscriptRows(mount.session, TRANSCRIPT);
    assert.deepEqual(alignment, { status: "aligned", dropped: 0, appended: 3 });
    const carried = mount.conversation();
    assert.deepEqual(
      carried,
      conversationOfRows(TRANSCRIPT),
      `the model's assembled context was ${JSON.stringify(carried)}`,
    );
  } finally {
    await mount.close();
  }
});

test("a mount whose session file carries more than the transcript still has its tail taken back", async () => {
  const mount = await mountWithSessionFile("gamebuddy-transcript-restore-longer-", (sessionManager) => {
    sessionManager.appendMessage({ role: "system", content: HOST_SYSTEM_PROMPT, timestamp: Date.now() });
    for (const one of TRANSCRIPT) appendRow(sessionManager, one);
    // The rows a delete or a rewind removed while nothing was mounted: the store no longer holds them.
    appendRow(sessionManager, row("player", "One more line the player removed."));
    appendRow(sessionManager, row("companion", "And a reply that went with it."));
  });
  try {
    const alignment = alignSessionToTranscriptRows(mount.session, TRANSCRIPT);
    assert.deepEqual(alignment, { status: "aligned", dropped: 2, appended: 0 });
    const carried = mount.conversation();
    assert.deepEqual(
      carried,
      conversationOfRows(TRANSCRIPT),
      `the model's assembled context was ${JSON.stringify(carried)}`,
    );
  } finally {
    await mount.close();
  }
});

test("a mount whose session file disagrees with the transcript is left exactly as it is, by name", async () => {
  const diverging = row("player", "Words the model was actually given, not the row the store kept.");
  const seededRows = [TRANSCRIPT[0]!, diverging, TRANSCRIPT[2]!];
  const mount = await mountWithSessionFile("gamebuddy-transcript-restore-diverges-", (sessionManager) => {
    sessionManager.appendMessage({ role: "system", content: HOST_SYSTEM_PROMPT, timestamp: Date.now() });
    for (const one of seededRows) appendRow(sessionManager, one);
  });
  try {
    const before = mount.conversation();
    const alignment = alignSessionToTranscriptRows(mount.session, TRANSCRIPT);
    assert.deepEqual(alignment, { status: "refused", reason: "session_diverges_from_transcript:1" });
    const after = mount.conversation();
    assert.deepEqual(after, before, `the session was rewritten: ${JSON.stringify(after)}`);
    assert.deepEqual(after, conversationOfRows(seededRows));
  } finally {
    await mount.close();
  }
});
