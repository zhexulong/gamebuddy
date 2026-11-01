// The turn gate's three readings, and the one it must never be: the send button's `disabled`.
//
// The failure this exists for, measured on `shots-final54`: the run seeded an active connection,
// the Settings surface showed `Operator gateway (developer only) · deepseek-v4.1-flash`, and three
// drivers still reported `SKIPPED:no connection on this mount; the surface says: (no sentence)`.
// They had asked `.composer-button.send-button` whether it was disabled, and `Composer.tsx` disables
// it on `disabled || sendUnavailable || !value.trim()` - so an empty field (the state every driver
// asks in, before typing) answered "no model" and the whole turn-dependent family was skipped behind
// a green `DONE-CAPTURE`.
//
// The last test reads the real `Composer.tsx` and requires the send button's disabled expression to
// be exactly the three terms this gate decomposes. A fourth term is a fact this gate does not read,
// and the test fails naming it rather than letting the gate go quietly permissive.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyComposer } from "./common.cjs";

// Resolved from this file, not the cwd: the corpus runner and a direct `node --test` disagree about
// where they start, and the premise read must not depend on that difference.
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const field = (overrides = {}) => ({
  fieldPresent: true,
  submitRefused: false,
  noModel: false,
  sentence: null,
  ...overrides,
});

test("an empty field on a mount with a model is a mount that can send", () => {
  // The exact state driver F, N and P ask in: nothing typed yet.
  assert.deepEqual(classifyComposer(field()), { ok: true, reason: null, sentence: null });
});

test("a route with no model refuses the turn and carries the surface's sentence", () => {
  assert.deepEqual(classifyComposer(field({ noModel: true, sentence: "No model" })), {
    ok: false,
    reason: "no_model_route",
    sentence: "No model",
  });
});

test("a Host that would not accept a submission now refuses the turn", () => {
  assert.deepEqual(classifyComposer(field({ submitRefused: true, sentence: "Reply stopped." })), {
    ok: false,
    reason: "submit_refused",
    sentence: "Reply stopped.",
  });
});

test("a mount with no composer at all refuses the turn instead of claiming it can send", () => {
  const answer = classifyComposer({ fieldPresent: false, submitRefused: false, noModel: false, sentence: null });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, "no_composer_on_this_mount");
});

test("the gate reads the composer's two Host-owned refusals, and the send button's terms are exactly those plus an empty field", () => {
  const source = readFileSync(join(REPO, "dialogue-web", "src", "components", "Composer.tsx"), "utf8");
  const disabled = /className="composer-button send-button"[\s\S]*?disabled=\{([^}]+)\}/u.exec(source);
  assert.ok(disabled !== null, "the send button still declares a disabled expression");
  const terms = disabled[1]
    .split("||")
    .map((term) => term.trim())
    .sort();
  assert.deepEqual(
    terms,
    ["disabled", "sendUnavailable", "!value.trim()"].sort(),
    `the gate decomposes every term of ${disabled[1]}; a new one needs its own reading here`,
  );
});
