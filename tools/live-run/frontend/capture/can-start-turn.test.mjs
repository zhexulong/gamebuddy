// The turn gate's two readings, and the one it must never be: the send button's `disabled`.
//
// The failure this exists for, measured on `shots-final54`: the run seeded an active connection,
// the Settings surface showed `Operator gateway (developer only) · deepseek-v4.1-flash`, and three
// drivers still reported `SKIPPED:no connection on this mount; the surface says: (no sentence)`.
// They had asked `.composer-button.send-button` whether it was disabled, and `Composer.tsx` refuses
// it whenever the draft is empty - the state every driver is in when it asks, before typing. So the
// whole turn-dependent family was skipped behind a green `DONE-CAPTURE`.
//
// The last test reads the real product and requires the send button's refusal to be exactly the two
// Host-owned refusals `classifyComposer` reads, plus the draft being empty: the field's own lock, and
// the no-model banner. Both are projections of one `ChatSendGate` value (`chat-ui-state.ts`), so the
// test decomposes that union and proves the two projections cover every refusing member. A term the
// driver does not read fails here instead of letting the gate go quietly permissive.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { classifyComposer, REPO_ROOT } from "./common.cjs";

// Resolved from this file, not the cwd: the corpus runner and a direct `node --test` disagree about
// where they start, and the premise read must not depend on that difference. It walks up to `.git`
// (`common.cjs`) rather than counting `..`, because the count that was right before the kit moved out of
// `tools/shots` pointed at `tools/` afterwards - and this read then failed to find `Composer.tsx` at all.

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

const COMPONENTS = join(REPO_ROOT, "dialogue-web", "src", "components");

/** The `disabled={…}` that follows `anchor`, split on `||`: what that control refuses on. */
function disabledTerms(source, anchor) {
  const at = source.indexOf(anchor);
  assert.ok(at >= 0, `${anchor} is still in the product`);
  const expression = /disabled=\{([^}]+)\}/u.exec(source.slice(at));
  assert.ok(expression !== null, `${anchor} still disables on something`);
  return {
    raw: expression[1],
    terms: expression[1]
      .split("||")
      .map((term) => term.trim())
      .sort(),
  };
}

/** The `ChatSendGate` members the state module declares, from the union itself. */
function sendGateMembers(state) {
  const union = /export type ChatSendGate =([\s\S]*?);\n/u.exec(state);
  assert.ok(union !== null, "chat-ui-state.ts still declares the ChatSendGate union");
  const members = [...union[1].matchAll(/\{\s*gate:\s*"([a-z_]+)"\s*\}/gu)].map((match) => match[1]);
  assert.ok(members.length > 1, `ChatSendGate declares its members: ${members.join(", ")}`);
  return members;
}

/** Which `send.gate` members one predicate answers for, with `!==` expanded over the union. */
function predicateCoverage(state, name, members) {
  const body = new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}`, "u").exec(state);
  assert.ok(body !== null, `chat-ui-state.ts still exports ${name}`);
  const covered = new Set();
  for (const [, operator, gate] of body[0].matchAll(/send\.gate\s*(===|!==)\s*"([a-z_]+)"/gu)) {
    assert.ok(
      members.includes(gate),
      `${name} compares send.gate against "${gate}", which is not a ChatSendGate member`,
    );
    if (operator === "===") covered.add(gate);
    else for (const member of members) if (member !== gate) covered.add(member);
  }
  return covered;
}

test("the gate reads the composer's two Host-owned refusals, and the send button's terms are exactly those plus an empty field", () => {
  const composer = readFileSync(join(COMPONENTS, "Composer.tsx"), "utf8");
  const send = disabledTerms(composer, 'className="composer-button send-button"');
  assert.deepEqual(
    send.terms,
    ["!value.trim()", "sendRefused(uiState.send)"].sort(),
    `the send button refuses on ${send.raw}; the driver reads the field's lock and the no-model banner, so any other term is a refusal it cannot see`,
  );
  // The field's own lock is the first refusal, and the driver reads it as the textarea's `disabled`.
  const field = disabledTerms(composer, 'className="composer-textarea"');
  assert.deepEqual(field.terms, ["fieldLocked(uiState.send)"], `the field locks on ${field.raw}`);

  // The second refusal is the standing banner, found by the attribute the driver queries for.
  const surface = readFileSync(join(COMPONENTS, "ChatSurface.tsx"), "utf8");
  assert.ok(
    /\{replyHasNoModel\(uiState\.send\)\s*&&[\s\S]{0,600}?data-chat-no-model/u.test(surface),
    "the [data-chat-no-model] banner the driver reads is still the one replyHasNoModel(uiState.send) renders",
  );

  // Send is refused for either of them, and for nothing else: the union decomposed is the rule.
  const state = readFileSync(join(COMPONENTS, "chat-ui-state.ts"), "utf8");
  const members = sendGateMembers(state);
  const refused = predicateCoverage(state, "sendRefused", members);
  const readByDriver = [
    ...new Set([
      ...predicateCoverage(state, "fieldLocked", members),
      ...predicateCoverage(state, "replyHasNoModel", members),
    ]),
  ].sort();
  assert.deepEqual(
    readByDriver,
    [...refused].sort(),
    `sendRefused refuses ${[...refused].join(", ")} but the driver reads ${readByDriver.join(", ")}; a refusal only one of them knows is a mount that looks sendable and does not send`,
  );
});
