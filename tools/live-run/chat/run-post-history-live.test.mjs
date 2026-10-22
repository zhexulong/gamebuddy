// The runner's pure helper's falsifiers: each case takes a capture that is right in every way but
// one, so the reading that exists to catch exactly that can be shown to go red.
import assert from "node:assert/strict";
import test from "node:test";

import { blockProblem, summarizeTurn, textOf, verifyReadings } from "./run-post-history-live.mjs";

const OPEN = "<character-closing-direction>";
const CLOSE = "</character-closing-direction>";
const DECLARED = "Close every reply by raking the coals once, never twice.";
const REVISED = "Close every reply by hanging the kettle back on its hook.";
const M0 = {
  role: "user",
  content: [
    {
      type: "text",
      text: '<gamebuddy-authored-context version="v2" thread-id="t">\nscenario\n</gamebuddy-authored-context>',
    },
  ],
};
const SYSTEM = { role: "system", content: "You are a companion." };

const block = (field) => ({
  role: "user",
  content: [{ type: "text", text: `${OPEN}\nframe\n${field}\nfloor\n${CLOSE}` }],
});

/** One captured request: the same prefix in every cell, the tail supplied by the case. */
function turn(label, tail, { publicationHash = "a".repeat(64), m0 = M0 } = {}) {
  return { label, publicationHash, messages: [SYSTEM, m0, { role: "user", content: "Good morning." }, tail] };
}

const run = (turns, declaredField = DECLARED, revisedField = REVISED) => ({ turns, declaredField, revisedField });
const failing = (verdict) => verdict.checks.filter((check) => !check.ok).map((check) => check.id);
const green = () =>
  run([
    turn("nothing", { role: "user", content: "Good morning." }),
    turn("declared", block(DECLARED)),
    turn("revised", block(REVISED)),
  ]);

test("textOf reads a string, a content array, and nothing at all", () => {
  assert.equal(textOf({ content: "plain" }), "plain");
  assert.equal(textOf({ content: [{ text: "a" }, { text: "b" }] }), "ab");
  assert.equal(textOf({ content: [{ type: "image" }] }), "");
  assert.equal(textOf(undefined), "");
});

test("summarizeTurn reports the last message, the block count and the prefix's bytes", () => {
  const summary = summarizeTurn(turn("declared", block(DECLARED)));
  assert.equal(summary.messages, 4);
  assert.equal(summary.m0Index, 1);
  assert.equal(summary.blocks, 1);
  assert.equal(summary.lastRole, "user");
  assert.equal(summary.lastText, textOf(block(DECLARED)));
  assert.match(summary.m0Sha256, /^[a-f0-9]{64}$/);
  assert.equal(summary.publicationHash, "a".repeat(64));
});

test("blockProblem accepts the framed block and names each way it can be wrong", () => {
  assert.equal(blockProblem(summarizeTurn(turn("declared", block(DECLARED))), DECLARED), null);
  assert.match(
    blockProblem(summarizeTurn(turn("nothing", { role: "user", content: "hi" })), DECLARED),
    /does not open/,
  );
  assert.match(
    blockProblem(
      summarizeTurn(turn("hoisted", { role: "system", content: block(DECLARED).content[0].text })),
      DECLARED,
    ),
    /role is system/,
  );
  assert.match(blockProblem(summarizeTurn(turn("truncated", block("raking the coals"))), DECLARED), /appears 0 times/);
  const doubled = turn("doubled", block(DECLARED));
  doubled.messages.splice(2, 0, block(DECLARED));
  assert.match(blockProblem(summarizeTurn(doubled), DECLARED), /2 closing-direction/);
});

test("the good capture holds every reading", () => {
  const verdict = verifyReadings(green());
  assert.deepEqual(failing(verdict), []);
});

test("a second turn that still carries the old sentence is the cached-block failure", () => {
  const verdict = verifyReadings(
    run([
      turn("nothing", { role: "user", content: "hi" }),
      turn("declared", block(DECLARED)),
      turn("revised", block(DECLARED)),
    ]),
  );
  assert.deepEqual(failing(verdict), ["secondTurn"]);
});

test("a card that declares nothing is red, not vacuously green", () => {
  const verdict = verifyReadings(
    run(
      [
        turn("nothing", { role: "user", content: "hi" }),
        turn("declared", { role: "user", content: "hi" }),
        turn("revised", { role: "user", content: "hi" }),
      ],
      "",
      "",
    ),
  );
  assert.deepEqual(failing(verdict), ["tailBlock", "secondTurn"]);
});

test("an m[0] that moved is reported against the no-field turn", () => {
  const shifted = M0.content[0].text.replace("scenario", "a different scenario");
  const verdict = verifyReadings(
    run([
      turn("nothing", { role: "user", content: "hi" }),
      turn("declared", block(DECLARED), { m0: { role: "user", content: [{ type: "text", text: shifted }] } }),
      turn("revised", block(REVISED)),
    ]),
  );
  assert.deepEqual(failing(verdict), ["prefix"]);
});

test("a publication hash that moved is reported even when the bytes did not", () => {
  const verdict = verifyReadings(
    run([
      turn("nothing", { role: "user", content: "hi" }),
      turn("declared", block(DECLARED), { publicationHash: "b".repeat(64) }),
      turn("revised", block(REVISED)),
    ]),
  );
  assert.deepEqual(failing(verdict), ["prefix"]);
});

test("a run short of three turns says so instead of judging two cells", () => {
  const verdict = verifyReadings(run([turn("nothing", { role: "user", content: "hi" })]));
  assert.equal(verdict.ok, false);
  assert.deepEqual(
    verdict.checks.map((check) => check.id),
    ["turns"],
  );
});
