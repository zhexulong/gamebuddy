import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLiveRunTextSideFile,
  createLiveRunTextCollector,
  LIVE_RUN_TEXT_MAX_CHARS,
  liveRunTextSideFilePath,
  redactLiveRunText,
} from "./capture-text.mjs";

test("bounding is per entry and the truncation is visible", () => {
  // Prose, not a token: an unbroken lower-case run would otherwise trip the secret rule and this test
  // would be measuring redaction while claiming to measure truncation.
  const long = "有点长的句子，".repeat(LIVE_RUN_TEXT_MAX_CHARS);
  assert.equal(redactLiveRunText(long).length, LIVE_RUN_TEXT_MAX_CHARS);
  assert.equal(redactLiveRunText(long, { maxChars: 10 }), long.slice(0, 10));
});

test("a token-shaped run is redacted and prose is not", () => {
  const token = "a1b2c3d4" + "e5f6".repeat(8);
  assert.equal(redactLiveRunText(token), "<REDACTED>");
  const prose = "abcdefghij".repeat(6); // 60 lower-case letters, no digit, no upper case
  assert.equal(redactLiveRunText(prose), prose);
});

test("redaction marks what it removed instead of dropping it", () => {
  assert.equal(redactLiveRunText("你好 {{char}}，今天好吗"), "你好 <MACRO>，今天好吗");
  const withSecret = redactLiveRunText("key " + "sk-" + "a".repeat(20) + " end");
  assert.ok(withSecret.includes("<REDACTED>"), withSecret);
  assert.ok(!withSecret.includes("sk-"), withSecret);
  // A non-string must never be stringified into the evidence.
  assert.equal(redactLiveRunText({ secret: "x" }), "");
  assert.equal(redactLiveRunText(undefined), "");
});

test("the collector is bounded in memory, not only on disk", () => {
  const collector = createLiveRunTextCollector({ maxEntries: 3 });
  for (let index = 0; index < 10; index += 1) collector.push("companion", `turn ${index}`);
  assert.equal(collector.size, 3);
  assert.deepEqual(collector.entries().map((entry) => entry.text), ["turn 7", "turn 8", "turn 9"]);
  // Empty text is not an entry: a silent turn is not a word.
  collector.push("companion", "");
  assert.equal(collector.size, 3);
  assert.throws(() => collector.push("", "text"), /live_run_text_role_invalid/);
});

test("the side file reports what it kept and enforces the entry cap", () => {
  const side = buildLiveRunTextSideFile({
    schema: "example_transcript/v1",
    runId: "run_1",
    entries: Array.from({ length: 5 }, (unused, index) => ({ role: "companion", text: `line ${index}` })),
    maxEntries: 2,
  });
  assert.equal(side.schema, "example_transcript/v1");
  assert.equal(side.entryCount, 2);
  assert.equal(side.maxCharsPerEntry, LIVE_RUN_TEXT_MAX_CHARS);
  assert.deepEqual(side.entries.map((entry) => entry.text), ["line 3", "line 4"]);
  assert.deepEqual(side.entries.map((entry) => entry.chars), [6, 6]);
  assert.throws(() => buildLiveRunTextSideFile({ schema: "", runId: "r", entries: [] }), /live_run_text_schema_invalid/);
});

test("the side file sits beside the report, whatever the report is called", () => {
  assert.equal(liveRunTextSideFilePath("C:/tmp/run.json"), "C:/tmp/run-transcript.json");
  assert.equal(liveRunTextSideFilePath("C:/tmp/run"), "C:/tmp/run-transcript.json");
  assert.equal(liveRunTextSideFilePath(undefined), undefined);
  assert.equal(liveRunTextSideFilePath("C:/tmp/run.json", "-words"), "C:/tmp/run-words.json");
});
