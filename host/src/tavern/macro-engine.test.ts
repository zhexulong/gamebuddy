import assert from "node:assert/strict";
import test from "node:test";
import {
  hasUnrenderedMacro,
  isLeftLiteralStandardMacro,
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

/**
 * The defect this pins: `macroKey` read the name past the space inside the braces while the replacement pattern demanded
 * it flush against them, so `{{ char }}` was classified as the `char` macro by every bucket test and never replaced by
 * `renderMacros`. The survivor then read as junk to `hasUnrenderedMacro` and the whole text carrying it was dropped -
 * a macro this engine knows perfectly well, lost as if it were a typo.
 */
test("a macro spelled with space inside its braces renders instead of surviving as junk", () => {
  assert.equal(renderMacros("{{ char }} says hi", { char: "琥珀", user: "Alex" }), "琥珀 says hi");
  assert.equal(renderMacros("{{char}} says hi", { char: "琥珀", user: "Alex" }), "琥珀 says hi");
  assert.equal(
    renderMacros("{{ user }} and {{  scenario  }}", { char: "琥珀", user: "Alex", scenario: "a farm" }),
    "Alex and a farm",
  );
  assert.equal(hasUnrenderedMacro(renderMacros("{{ char }}", { char: "琥珀", user: "Alex" })), false);
});

/**
 * The other half of the same grammar: `macroKey` already took the leading name of a parametric macro, so the render has
 * to find the whole token too. Recognition widened; what a resolved macro renders to did not - a parametric draw still
 * belongs to the bucket its name belongs to, and a name neither table knows still survives to be reported.
 */
test("a parametric macro is found by the render and still resolves to its name's bucket", () => {
  const vars = { char: "琥珀", user: "Alex" };
  for (const token of ["{{random::a::b}}", "{{ random :: a :: b }}", "{{lastMessage}}", "{{ lastmessage }}"])
    assert.equal(renderMacros(`x ${token} y`, vars), `x ${token} y`, `${token} is left literal, arguments and all`);
  assert.equal(renderMacros("{{newline::ignored}}", vars), "\n");
  // A name neither table knows keeps its own arguments and is reported whole, rather than being eaten by the render.
  assert.equal(renderMacros("{{getvar::score}}", vars), "{{getvar::score}}");
  assert.deepEqual(unrenderedMacros(renderMacros("a {{getvar::score}} b", vars)), ["{{getvar::score}}"]);
});

/** The boundary the widened recognition must not cross: a token neither table knows still survives to be reported. */
test("a token neither table knows survives the widened recognition and is still named", () => {
  const vars = { char: "琥珀", user: "Alex" };
  for (const token of ["{{not_a_macro}}", "{{ not_a_macro }}"])
    assert.equal(renderMacros(token, vars), token, `${token} must not be rendered`);
  assert.deepEqual(unrenderedMacros(renderMacros("a {{ not_a_macro }} b", vars)), ["{{ not_a_macro }}"]);
  assert.equal(isStandardSillyTavernMacro("{{ not_a_macro }}"), false);
});

/**
 * The gate the two defects above belong to: recognition and classification are one grammar, so every spelling this file
 * calls standard must also be a spelling the render actually finds.
 *
 * The bucket-2 population comes from `LEFT_LITERAL_STANDARD_MACROS` itself, so a macro added there is covered without
 * touching this test. Bucket 1 has no exported table to derive from, so its names are listed here; the guarantee that
 * they cannot drift out of recognition is structural - `macroKey` and `MACRO_PATTERN` are built from one `MACRO_NAME`
 * and one token grammar (see `macro-engine.ts`).
 */
test("classification and replacement read one grammar, in every spelling a card writes", () => {
  const vars = { char: "琥珀", user: "Alex", scenario: "a farm", personality: "quiet", description: "tall" };
  const bucket1 = ["char", "bot", "user", "scenario", "personality", "description", "newline", "noop"];
  const spellings = (name: string): readonly string[] => [
    `{{${name}}}`,
    `{{ ${name} }}`,
    `{{${name.toUpperCase()}}}`,
    `{{ ${name.toUpperCase()} }}`,
    `{{${name}::argument}}`,
  ];
  for (const name of Object.keys(LEFT_LITERAL_STANDARD_MACROS))
    for (const token of spellings(name)) {
      assert.equal(isLeftLiteralStandardMacro(token), true, `${token} must classify as deliberately left literal`);
      assert.equal(renderMacros(token, vars), token, `${token} must survive rendering exactly as written`);
    }
  for (const name of bucket1)
    for (const token of spellings(name)) {
      assert.equal(isLeftLiteralStandardMacro(token), false, `${token} is filled at render, so it is not a loss`);
      assert.equal(
        hasUnrenderedMacro(renderMacros(token, vars)),
        false,
        `${token} must be replaced, not left unrendered`,
      );
    }
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
 * The narrower question the import ledger asks, and the boundary that makes it necessary: bucket 1's `{{char}}` and
 * `{{user}}` are standard SillyTavern macros too, and they ARE filled at render. Calling one of them a loss would be a
 * false statement about the player's own card, so "deliberately left literal" is its own question with its own answer -
 * derived from the same table, never from a second handwritten list.
 */
test("only bucket 2 is deliberately left literal: a macro the render fills is never a loss", () => {
  for (const key of Object.keys(LEFT_LITERAL_STANDARD_MACROS)) {
    const token = `{{${key}}}`;
    assert.equal(isLeftLiteralStandardMacro(token), true, `${token} is left literal by its own table`);
    assert.equal(isStandardSillyTavernMacro(token), true, `${token} is also standard, which is the narrower case`);
  }
  // Bucket 1 renders under every table this product builds, so it can never be the reason a field is dropped.
  for (const key of ["char", "bot", "user", "scenario", "personality", "description", "newline", "noop"])
    assert.equal(isLeftLiteralStandardMacro(`{{${key}}}`), false, `{{${key}}} is filled at render`);
  // Bucket 3 is unrecognised, which is not the same claim: it is not a macro this product knows at all.
  for (const token of ["{{unknown_macro}}", "{{...}}", "{{// note}}", "<USER>"])
    assert.equal(isLeftLiteralStandardMacro(token), false, `${token} is not a left-literal macro`);
  // The spellings a card actually writes still read their own bucket-2 key.
  for (const token of ["{{random::a::b}}", "{{lastMessage}}", "{{TIME}}", "{{idle_duration}}"])
    assert.equal(isLeftLiteralStandardMacro(token), true, `${token} must classify as left literal`);
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
