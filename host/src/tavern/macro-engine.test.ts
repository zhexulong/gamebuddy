import assert from "node:assert/strict";
import test from "node:test";
import {
  hasUnrenderedMacro,
  isStandardSillyTavernMacro,
  LEFT_LITERAL_STANDARD_MACROS,
  macroTable,
  renderMacros,
  renderWorldBookText,
  unrenderedMacros,
} from "./macro-engine.js";

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
  assert.equal(renderMacros("A {{char}} B <USER> C", { char: undefined as never, user: null as never }), "A  B  C");
});

test("renderWorldBookText resolves the player reference and leaves an unknown character name unrendered", () => {
  assert.equal(renderWorldBookText("{{user}} and {{char}} farm.", { char: "Kohaku" }), "User and Kohaku farm.");
  // No known character name: `{{char}}` stays so the caller drops the entry
  // instead of blanking it.
  assert.equal(renderWorldBookText("{{user}} and {{char}} farm.", { char: null }), "User and {{char}} farm.");
});

test("hasUnrenderedMacro detects only a surviving macro", () => {
  assert.equal(hasUnrenderedMacro("User and Kohaku farm."), false);
  assert.equal(hasUnrenderedMacro("a {{char}} placeholder"), true);
  assert.equal(hasUnrenderedMacro("single { braces } are fine"), false);
});

// The failure this catches: the macro table carried the English literal "the player"
// as the player reference at every call site, so a Chinese companion's own 设定 was
// frozen as 与the player一同从都市迁居. Nothing threw; the prose was simply wrong.
// The word itself was wrong twice: 玩家 is a NOUN for a third party, and the shipped
// card's own `post_history_instructions` forbids her to speak of the player in the
// third person - she speaks TO them. So both locales use a second person pronoun and
// `{{user}}` reads as the person being addressed.
test("the macro table renders the player in the run's locale, not in an English constant", () => {
  assert.equal(macroTable({ char: "琥珀", locale: "zh-CN" }).user, "你");
  assert.equal(macroTable({ char: "琥珀", locale: "zh-Hant-TW" }).user, "你");
  assert.equal(macroTable({ char: "Kohaku", locale: "en-US" }).user, "User");
  assert.equal(macroTable({ char: "Kohaku" }).user, "User");
  // A name a caller actually has wins over any word.
  assert.equal(macroTable({ char: "琥珀", user: "Alex", locale: "zh-CN" }).user, "Alex");
  assert.equal(macroTable({ char: "琥珀", user: "   ", locale: "zh-CN" }).user, "你");
});

// The defect this pins: the zh default used to be 玩家, the noun a card says only
// when it is talking ABOUT the player - and the shipped card's own
// `post_history_instructions` forbids exactly that third-person reference while
// asking her to address the player as a familiar equal. Every authored field that
// carries `{{user}}` (scenario, world book, greeting) therefore received a word the
// card forbids. Neither default may be a noun.
test("{{user}} resolves to the player being addressed, never to a third-person noun", () => {
  for (const locale of ["zh-CN", "zh-Hant-TW", undefined]) {
    const word = macroTable({ char: "琥珀", locale }).user;
    assert.equal(/玩家|the player/u.test(word), false, `locale ${String(locale)} must not use a third-person noun`);
  }
  assert.equal(macroTable({ char: "琥珀", locale: "zh-CN" }).user, "你");
  assert.equal(macroTable({ char: "Kohaku", locale: "en-US" }).user, "User");
});

test("renderWorldBookText renders the player word from the locale it is given", () => {
  assert.equal(renderWorldBookText("{{user}} and {{char}}耕田", { char: "琥珀", locale: "zh-CN" }), "你 and 琥珀耕田");
  assert.equal(
    renderWorldBookText("{{user}} and {{char}} farm.", { char: "Kohaku", locale: "en-US" }),
    "User and Kohaku farm.",
  );
});

/**
 * Bucket 1, the boundary that makes the classification worth having: a standard macro whose value is fixed by the format
 * itself renders exactly, so an entry that used it is kept rather than dropped.
 *
 * `{{newline}}` and `{{noop}}` are SillyTavern's own layout macros - a newline, and nothing - so rendering them is not a
 * guess about a value this product does not have.
 */
test("bucket 1: a standard macro with a fixed value renders, so its entry is not dropped for it", () => {
  const vars = { char: "Rin", user: "Alex" };
  assert.equal(renderMacros("a{{newline}}b", vars), "a\nb");
  assert.equal(renderMacros("a{{noop}}b", vars), "ab");
  assert.equal(hasUnrenderedMacro(renderMacros("line{{newline}}", vars)), false);
  assert.equal(isStandardSillyTavernMacro("{{newline}}"), true);
  assert.equal(isStandardSillyTavernMacro("{{noop}}"), true);
});

/**
 * Bucket 2, the boundary the player actually hits: a STANDARD SillyTavern macro this engine cannot fill still leaves the
 * entry out, but it is now recognisable as standard rather than filed with placeholder junk.
 */
test("bucket 2: a standard macro this engine cannot fill survives rendering and is recognised as standard", () => {
  const vars = { char: "Rin", user: "Alex" };
  for (const key of Object.keys(LEFT_LITERAL_STANDARD_MACROS)) {
    const token = `{{${key}}}`;
    assert.equal(renderMacros(token, vars), token, `${token} must stay literal`);
    assert.equal(hasUnrenderedMacro(renderMacros(token, vars)), true);
    assert.equal(isStandardSillyTavernMacro(token), true, `${token} must classify as a standard macro`);
    assert.ok(
      (LEFT_LITERAL_STANDARD_MACROS[key] ?? "").length > 20,
      `${key} must carry a real reason, not a placeholder`,
    );
  }
  // The four faces of the same macro set: a parametric draw, and the camel-case spelling a card may write.
  for (const token of ["{{random::a::b}}", "{{lastMessage}}", "{{TIME}}", "{{idle_duration}}"])
    assert.equal(isStandardSillyTavernMacro(token), true, `${token} must classify as standard`);
});

/**
 * Bucket 3, the boundary that keeps bucket 2 honest: a token neither table knows is reported as unrecognised, which is a
 * claim about THIS importer rather than about SillyTavern.
 */
test("bucket 3: a token neither table knows is unrecognised, not called a SillyTavern macro", () => {
  for (const token of ["{{unknown_macro}}", "{{nope}}", "{{...}}", "{{// note}}", "{{ !cancelled() }}"])
    assert.equal(isStandardSillyTavernMacro(token), false, `${token} must not classify as standard`);
});

/**
 * The reporting half of the rule: naming what survived is what turns a count into something the player can act on, and
 * two occurrences of one macro must read as one entry-side fact rather than two.
 */
test("unrenderedMacros names each surviving macro once, in the order the text uses them", () => {
  assert.deepEqual(unrenderedMacros("a {{time}} b {{original}} c {{time}} d"), ["{{time}}", "{{original}}"]);
  assert.deepEqual(unrenderedMacros("clean prose"), []);
  assert.deepEqual(unrenderedMacros(renderWorldBookText("{{char}} and {{user}}", { char: "Rin", user: "Alex" })), []);
});
