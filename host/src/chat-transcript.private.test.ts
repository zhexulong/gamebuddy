import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";
import { appendChatTranscript, MAX_CHAT_TRANSCRIPT_ENTRIES, readChatTranscript } from "./chat-transcript.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

async function transcriptPath(): Promise<string> {
  const canonicalTemporaryRoot = await realpath(tmpdir());
  return join(await mkdtemp(join(canonicalTemporaryRoot, "gamebuddy-transcript-")), "chat.json");
}

test("player-visible chat transcript is append-only, deduplicated, and rejects internal roles", async () => {
  const path = await transcriptPath();
  const player = {
    entryId: "message_01",
    role: "player" as const,
    text: "hello",
    occurredAtMs: 1,
    sourceEventId: "message_01",
  };
  await appendChatTranscript(path, "surface_01", player);
  await appendChatTranscript(path, "surface_01", player);
  const transcript = await readChatTranscript(path, "surface_01");
  assert.deepEqual(transcript.entries, [player]);
  await assert.rejects(
    () => appendChatTranscript(path, "surface_01", { ...player, entryId: "tool_01", role: "tool" as never }),
    /invalid_chat_transcript/,
  );
});

test("player-visible chat transcript keeps a bounded recent browser window", async () => {
  const path = await transcriptPath();
  // Establish the bounded persisted state directly, then exercise the real
  // append/atomic-rewrite boundary once. Rewriting an increasingly large JSON
  // file 2,001 times adds no behavioural coverage and consumes most of the
  // package suite's global deadline on Windows path locks.
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      surfaceSessionId: "surface_01",
      entries: Array.from({ length: MAX_CHAT_TRANSCRIPT_ENTRIES }, (_, index) => ({
        entryId: `message_${index}`,
        role: "player",
        text: `message ${index}`,
        occurredAtMs: index,
        sourceEventId: `message_${index}`,
      })),
    }),
    "utf8",
  );
  await appendChatTranscript(path, "surface_01", {
    entryId: `message_${MAX_CHAT_TRANSCRIPT_ENTRIES}`,
    role: "player",
    text: `message ${MAX_CHAT_TRANSCRIPT_ENTRIES}`,
    occurredAtMs: MAX_CHAT_TRANSCRIPT_ENTRIES,
    sourceEventId: `message_${MAX_CHAT_TRANSCRIPT_ENTRIES}`,
  });
  const transcript = await readChatTranscript(path, "surface_01");
  assert.equal(transcript.entries.length, MAX_CHAT_TRANSCRIPT_ENTRIES);
  assert.equal(transcript.entries[0]?.entryId, "message_1");
  assert.equal(transcript.entries.at(-1)?.entryId, `message_${MAX_CHAT_TRANSCRIPT_ENTRIES}`);
});

test("player-visible chat transcript serializes concurrent appends without dropping either entry", async () => {
  const path = await transcriptPath();
  await Promise.all([
    appendChatTranscript(path, "surface_01", {
      entryId: "message_01",
      role: "player",
      text: "hello",
      occurredAtMs: 1,
      sourceEventId: "message_01",
    }),
    appendChatTranscript(path, "surface_01", {
      entryId: "message_02",
      role: "companion",
      text: "hi",
      occurredAtMs: 2,
      sourceEventId: "presentation_02",
    }),
  ]);
  assert.deepEqual(
    (await readChatTranscript(path, "surface_01")).entries.map((entry) => entry.entryId),
    ["message_01", "message_02"],
  );
});
