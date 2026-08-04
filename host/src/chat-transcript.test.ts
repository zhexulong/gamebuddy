import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendChatTranscript, MAX_CHAT_TRANSCRIPT_ENTRIES, readChatTranscript } from "./chat-transcript.js";

test("player-visible chat transcript is append-only, deduplicated, and rejects internal roles", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "gamebuddy-transcript-")), "chat.json");
  const player = { entryId: "message_01", role: "player" as const, text: "hello", occurredAtMs: 1, sourceEventId: "message_01" };
  await appendChatTranscript(path, "surface_01", player);
  await appendChatTranscript(path, "surface_01", player);
  const transcript = await readChatTranscript(path, "surface_01");
  assert.deepEqual(transcript.entries, [player]);
  await assert.rejects(() => appendChatTranscript(path, "surface_01", { ...player, entryId: "tool_01", role: "tool" as never }), /invalid_chat_transcript/);
});

test("player-visible chat transcript keeps a bounded recent browser window", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "gamebuddy-transcript-")), "chat.json");
  for (let index = 0; index <= MAX_CHAT_TRANSCRIPT_ENTRIES; index++) {
    await appendChatTranscript(path, "surface_01", { entryId: `message_${index}`, role: "player", text: `message ${index}`, occurredAtMs: index, sourceEventId: `message_${index}` });
  }
  const transcript = await readChatTranscript(path, "surface_01");
  assert.equal(transcript.entries.length, MAX_CHAT_TRANSCRIPT_ENTRIES);
  assert.equal(transcript.entries[0]?.entryId, "message_1");
  assert.equal(transcript.entries.at(-1)?.entryId, `message_${MAX_CHAT_TRANSCRIPT_ENTRIES}`);
});

test("player-visible chat transcript serializes concurrent appends without dropping either entry", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "gamebuddy-transcript-")), "chat.json");
  await Promise.all([
    appendChatTranscript(path, "surface_01", { entryId: "message_01", role: "player", text: "hello", occurredAtMs: 1, sourceEventId: "message_01" }),
    appendChatTranscript(path, "surface_01", { entryId: "message_02", role: "companion", text: "hi", occurredAtMs: 2, sourceEventId: "presentation_02" }),
  ]);
  assert.deepEqual((await readChatTranscript(path, "surface_01")).entries.map((entry) => entry.entryId), ["message_01", "message_02"]);
});
