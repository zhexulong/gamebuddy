// red-proof: fixture  a request file that lives for ONE game tick (16 ms) is gone before a reader that opens the
// directory afterwards ever sees it, so the fixture writes the request, deletes it after 16 ms, and requires the
// capture to hold the body and the advertisement beside it. A capture that sampled once, or that only recorded a
// path, fails here rather than in a run that already cost a launch.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startAttachmentRequestCapture } from "./attachment-request-capture.mjs";

const advertisement = '{"saveId":"454941739","worldId":"-8562175747207173782","nonce":"b77e469c"}';
const request = '{"sessionNonce":"b77e469c","saveId":"454941739","worldId":"-8562175747207173782"}';

test("a request that lives for one game tick is still captured with the advertisement beside it", async () => {
  const root = join(process.cwd(), ".tmp", "attachment-request-capture");
  rmSync(root, { recursive: true, force: true });
  const session = join(root, "lane.stage", "root", "GameBuddy", "data", "stardew-private-bootstrap", "b-1", "session");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "stardew-session.json"), advertisement);
  const sink = join(root, "captured.jsonl");

  const capture = startAttachmentRequestCapture({ lanesRoot: root, sink });
  try {
    writeFileSync(join(session, "stardew-attachment-request.json"), request);
    await new Promise((resolve) => setTimeout(resolve, 16));
    unlinkSync(join(session, "stardew-attachment-request.json"));
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    capture.stop();
  }

  const lines = readFileSync(sink, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 1, `expected one captured request, got ${lines.length}`);
  assert.equal(lines[0].request, request);
  assert.equal(lines[0].advertisement, advertisement, "the advertisement of the moment is what names the fact");
  assert.ok(lines[0].directory.endsWith(join("b-1", "session")), `unexpected directory: ${lines[0].directory}`);
  assert.equal(typeof lines[0].atMs, "number");
});

test("a session directory that does not exist yet is picked up, and an empty lane is not a failure", async () => {
  const root = join(process.cwd(), ".tmp", "attachment-request-capture-empty");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "lane.stage"), { recursive: true });
  const sink = join(root, "captured.jsonl");

  const capture = startAttachmentRequestCapture({ lanesRoot: root, sink });
  try {
    assert.deepEqual(capture.directories(), [], "a lane with no bootstrap reads as nothing, not as a failure");
    const session = join(
      root,
      "lane.stage",
      "root",
      "GameBuddy",
      "data",
      "stardew-private-bootstrap",
      "b-2",
      "session",
    );
    mkdirSync(session, { recursive: true });
    writeFileSync(join(session, "stardew-attachment-request.json"), request);
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    assert.equal(capture.records.length, 1, "the directory is discovered after the capture has started");
  } finally {
    capture.stop();
  }
});
