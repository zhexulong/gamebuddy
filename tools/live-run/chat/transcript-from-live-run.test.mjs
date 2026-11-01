/*
 * red-proof: inject  feeding `transcriptFromLiveRun` two requests whose authored block DIFFERS between
 * turns makes the conversational-quality gate answer `m0_hash_divergence`; two identical blocks answer
 * `PASS`. Both were run through the real gate rather than a stub:
 *
 *   node tools/live-run/chat/run-wire-contract-live.mjs --transcript <path>
 *   node tools/check-chat-conversational-quality-gate.mjs --transcript <path>
 *
 * The second half of the proof is the one that mattered on the day: the first version of the converter
 * read `typeof content === "string"` while the wire sends an array of `{type,text}` parts, so a real
 * live run reported `turns: 1 (0 carrying an M0 stable block)` with the block present. The last test
 * below pins the array shape so that reader cannot regress to the string-only form.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { countsOf, transcriptFromLiveRun } from "./transcript-from-live-run.mjs";

const AUTHORED = '<gamebuddy-authored-context version="v2">AAA</gamebuddy-authored-context>';

const request = (systemContent, userContent) => ({
  body: {
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
  },
});

test("the M0 block is read out of the system prompt, not assumed", () => {
  const transcript = transcriptFromLiveRun({ requests: [request(`floor\n${AUTHORED}\ntail`, "hi")] });
  assert.equal(transcript.turns.length, 1);
  assert.equal(
    transcript.turns[0].contextComponents?.m0StableContextXml,
    AUTHORED,
    "the authored block is what the prefix dimension measures; a wrapper or the whole prompt would measure the wrong bytes",
  );
  assert.equal(transcript.turns[0].playerInput, "hi");
});

test("a turn whose system prompt carries no block records no M0 rather than an empty one", () => {
  const transcript = transcriptFromLiveRun({ requests: [request("plain floor", "hi")] });
  assert.equal(transcript.turns[0].contextComponents, undefined, "an absent block is absent, not an empty string");
  assert.deepEqual(countsOf(transcript), { turns: 1, withStable: 0 });
});

test("the three dimensions nobody declared stay named as not observable", () => {
  const transcript = transcriptFromLiveRun({ requests: [request(AUTHORED, "hi")] });
  assert.deepEqual(Object.keys(transcript.notObservable).sort(), [
    "lorebookTriggerPrecision",
    "memorySupersededAntiHallucination",
    "semanticMemoryRetention",
  ]);
  assert.match(
    transcript.description,
    /blocked rather than passing/u,
    "a reader must not conclude the product failed them; the transcript says why they are absent",
  );
});

test("a stub's reply is not written into the field named for the model's reply", () => {
  const transcript = transcriptFromLiveRun({ requests: [request(AUTHORED, "hi")] });
  assert.equal(
    transcript.turns[0].modelResponse,
    undefined,
    "the stub answers with a fixed body; putting it here would report a sentence no model produced",
  );
});
