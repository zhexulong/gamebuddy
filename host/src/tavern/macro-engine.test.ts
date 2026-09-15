import assert from "node:assert/strict";
import test from "node:test";
import { renderMacros } from "./macro-engine.js";

test("renderMacros replaces every supported macro, including mixed forms", () => {
  assert.equal(
    renderMacros("{{char}} / <BOT> / {{user}} / <USER>", { char: "Rin", user: "Alex" }),
    "Rin / Rin / Alex / Alex",
  );
});

test("renderMacros is case-insensitive and renders each occurrence once", () => {
  assert.equal(
    renderMacros("{{CHAR}} {{User}} <bot> <uSeR>", { char: "{{user}}", user: "<BOT>" }),
    "{{user}} <BOT> {{user}} <BOT>",
  );
});

test("renderMacros preserves text without supported macros", () => {
  const text = "No replacement: {{unknown}} and <SYSTEM>";
  assert.equal(renderMacros(text, { char: "Rin", user: "Alex" }), text);
});

test("renderMacros uses empty strings for empty variables", () => {
  assert.equal(renderMacros("A {{char}} B <USER> C", { char: "", user: "" }), "A  B  C");
  assert.equal(
    renderMacros("A {{char}} B <USER> C", { char: undefined as never, user: null as never }),
    "A  B  C",
  );
});
