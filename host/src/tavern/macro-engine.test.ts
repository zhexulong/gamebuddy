import assert from "node:assert/strict";
import test from "node:test";
import { hasUnrenderedMacro, macroTable, renderMacros, renderWorldBookText } from "./macro-engine.js";

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

test("renderWorldBookText resolves the player reference and leaves an unknown character name unrendered", () => {
  assert.equal(
    renderWorldBookText("{{user}} and {{char}} farm.", { char: "Kohaku" }),
    "the player and Kohaku farm.",
  );
  // No known character name: `{{char}}` stays so the caller drops the entry
  // instead of blanking it.
  assert.equal(
    renderWorldBookText("{{user}} and {{char}} farm.", { char: null }),
    "the player and {{char}} farm.",
  );
});

test("hasUnrenderedMacro detects only a surviving macro", () => {
  assert.equal(hasUnrenderedMacro("the player and Kohaku farm."), false);
  assert.equal(hasUnrenderedMacro("a {{char}} placeholder"), true);
  assert.equal(hasUnrenderedMacro("single { braces } are fine"), false);
});

// The failure this catches: the macro table carried the English literal "the player"
// as the player reference at every call site, so a Chinese companion's own 设定 was
// frozen as 与the player一同从都市迁居. Nothing threw; the prose was simply wrong.
test("the macro table renders the player in the run's locale, not in an English constant", () => {
  assert.equal(macroTable({ char: "琥珀", locale: "zh-CN" }).user, "玩家");
  assert.equal(macroTable({ char: "琥珀", locale: "zh-Hant-TW" }).user, "玩家");
  assert.equal(macroTable({ char: "Kohaku", locale: "en-US" }).user, "the player");
  // A name a caller actually has wins over any word.
  assert.equal(macroTable({ char: "琥珀", user: "Alex", locale: "zh-CN" }).user, "Alex");
  assert.equal(macroTable({ char: "琥珀", user: "   ", locale: "zh-CN" }).user, "玩家");
});

test("renderWorldBookText renders the player word from the locale it is given", () => {
  assert.equal(
    renderWorldBookText("{{user}} and {{char}}耕田", { char: "琥珀", locale: "zh-CN" }),
    "玩家 and 琥珀耕田",
  );
  assert.equal(
    renderWorldBookText("{{user}} and {{char}} farm.", { char: "Kohaku", locale: "en-US" }),
    "the player and Kohaku farm.",
  );
});
