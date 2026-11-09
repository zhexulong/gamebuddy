import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePresetText, type MacroContext, PRESET_MACROS, presetMacroTokens } from "./preset-macros.js";

/**
 * red-proof: `EvaluationState`'s `vars` was made a module-level `Map` (the assembly scope lost) -> `two calls
 * with the same context do not share variables` failed with `actual: 'grim', expected: ''`, and `addvar
 * accumulates inside one call and nowhere else` failed with `actual: 'dry and warm', expected: ''`. Restored,
 * green.
 */

/**
 * Every macro name A4 §7.2 lists, as this table keys them: lower-cased, because §7.1 makes case insignificant.
 *
 * The list is hand-kept on purpose - A4 §7.2 is a prose table, which is the reason `PRESET_MACROS` exists
 * (design/architecture/tavern-preset-compatibility.md §4) - so the assertion below is what keeps its claim
 * falsifiable: a name A4 gains and the table does not is named by the failure.
 */
const A4_MACRO_NAMES: readonly string[] = [
  "char",
  "user",
  "description",
  "personality",
  "scenario",
  "persona",
  "system",
  "mesexamples",
  "mesexamplesraw",
  "lastmessage",
  "lastusermessage",
  "lastcharmessage",
  "original",
  "time",
  "date",
  "weekday",
  "datetimeformat",
  "random",
  "pick",
  "getvar",
  "setvar",
  "trim",
  "outlet",
  "name",
  "if",
  "else",
  "/if",
  "summary",
];

/**
 * The three A4 §7.2 spellings this table cannot key: `{{.varName}}`, `{{.varName = value}}` and `{{$varName}}`
 * carry the variable's own name inside the token, so there is no fixed word to look up - the whole body becomes the
 * name. Declaring them needs the shorthand parsed into a family name, a change to the token grammar rather than an
 * entry in this table; the test below keeps that gap named, so the exclusion here cannot outlive it.
 */
const A4_SHORTHAND_SPELLINGS: readonly string[] = ["{{.varName}}", "{{.varName = value}}", "{{$varName}}"];

/**
 * red-proof: `weekday` removed from `PRESET_MACROS` -> `nothing A4 §7.2 defines is reported unknown` failed with
 * `A4 §7.2 names absent from PRESET_MACROS: weekday`; restored, green. A `.varname` entry added to the table ->
 * `the variable shorthands A4 §7.2 lists are not table-keyed names` failed with `actual: [ '.varname' ], expected:
 * []`; removed, green. `renderToken`'s `unknown` branch made to return "" -> the same test failed with `{{.varName}}
 * must not be silently emptied`; restored, green.
 */

const context: MacroContext = {
  char: "Rin",
  user: "Alex",
  description: "a fisher at the north dock",
  personality: "patient",
  scenario: "a rain-soaked harbour",
  persona: "a traveller with a torn map",
  itemId: "preset-entry:main",
};

test("every table name is recognised, and the token survives exactly when it was reported", () => {
  for (const entry of PRESET_MACROS) {
    const raw = `{{${entry.name}}}`;
    const outcome = evaluatePresetText(raw, context);
    assert.equal(outcome.unknown.includes(entry.name), false, `${entry.name} is in the table but reported unknown`);
    // The one invariant behind "never silently emptied": a token that is still in the text has a name in
    // `unresolved`, so the caller can show or drop it. A macro that renders may not be reported.
    assert.equal(
      outcome.text.includes(raw),
      outcome.unresolved.includes(entry.name),
      `${entry.name}: literal-survives and reported-unresolved must agree (text ${JSON.stringify(outcome.text)})`,
    );
  }
});

test("an unimplemented entry stays literal and is named", () => {
  for (const entry of PRESET_MACROS.filter((candidate) => !candidate.implemented)) {
    const outcome = evaluatePresetText(`a {{${entry.name}}} b`, context);
    assert.equal(outcome.text, `a {{${entry.name}}} b`);
    assert.deepEqual(outcome.unresolved, [entry.name]);
    assert.deepEqual(outcome.unknown, []);
  }
});

test("the table declares each name once", () => {
  const names = PRESET_MACROS.map((entry) => entry.name);
  assert.deepEqual(names, [...new Set(names)]);
});

test("nothing A4 §7.2 defines is reported unknown: the table carries every name it lists", () => {
  const text = A4_MACRO_NAMES.map((name) => `{{${name}}}`).join("\n");
  const missing = A4_MACRO_NAMES.filter((name) => !PRESET_MACROS.some((entry) => entry.name === name));
  assert.deepEqual(missing, [], `A4 §7.2 names absent from PRESET_MACROS: ${missing.join(", ")}`);
  const outcome = evaluatePresetText(text, context);
  assert.deepEqual(outcome.unknown, [], `unknown A4 §7.2 names: ${outcome.unknown.join(", ")}`);
});

test("the variable shorthands A4 §7.2 lists are not table-keyed names, and each is still reported", () => {
  const names = A4_SHORTHAND_SPELLINGS.map((spelling) => presetMacroTokens(spelling)[0]?.name);
  assert.deepEqual(names, [".varname", ".varname = value", "$varname"]);
  // A shorthand's token name IS the variable it reads, so no fixed entry can carry it. The day an entry claims one,
  // the exclusion above has to be revisited rather than quietly kept.
  assert.deepEqual(
    PRESET_MACROS.filter((entry) => entry.name.startsWith(".") || entry.name.startsWith("$")).map(
      (entry) => entry.name,
    ),
    [],
  );
  for (const spelling of A4_SHORTHAND_SPELLINGS) {
    const tokenName = presetMacroTokens(spelling)[0]?.name;
    const outcome = evaluatePresetText(spelling, context);
    assert.equal(outcome.text.includes(spelling), true, `${spelling} must not be silently emptied`);
    assert.deepEqual([...outcome.unknown, ...outcome.unresolved], [tokenName], `${spelling} must be reported by name`);
  }
});

test("the context macros render, case-insensitively and with spaces inside the braces", () => {
  const text = "{{char}} / {{ CHAR }} / {{user}} / {{description}} / {{personality}} / {{scenario}} / {{ persona }}";
  assert.equal(
    evaluatePresetText(text, context).text,
    "Rin / Rin / Alex / a fisher at the north dock / patient / a rain-soaked harbour / a traveller with a torn map",
  );
});

test("evaluation is inside-out: a macro nested in another macro's argument resolves first", () => {
  const text = "{{setvar::{{char}}_mood::calm}}{{getvar::{{char}}_mood}}";
  const outcome = evaluatePresetText(text, context);
  assert.equal(outcome.text, "calm");
  assert.deepEqual(outcome.unresolved, []);
  assert.deepEqual(outcome.unknown, []);
});

test("two calls with the same context do not share variables", () => {
  const first = evaluatePresetText("{{setvar::mood::grim}}", context);
  assert.equal(first.text, "");
  const second = evaluatePresetText("{{getvar::mood}}", context);
  assert.equal(second.text, "");
  assert.deepEqual(second.unresolved, []);
});

test("addvar accumulates inside one call and nowhere else", () => {
  const insideOneCall = evaluatePresetText(
    "{{addvar::style::dry}}{{addvar::style:: and warm}}{{getvar::style}}",
    context,
  );
  assert.equal(insideOneCall.text, "dry and warm");
  const nextCall = evaluatePresetText("{{getvar::style}}", context);
  assert.equal(nextCall.text, "");
});

test("setvar stores the value verbatim, including a value that carries the argument separator", () => {
  const outcome = evaluatePresetText("{{setvar::k::a::b}}{{getvar::k}}", context);
  assert.equal(outcome.text, "a::b");
});

test("getvar reads an unset name as empty rather than reporting it", () => {
  const outcome = evaluatePresetText("{{getvar::never_set}}", context);
  assert.equal(outcome.text, "");
  assert.deepEqual(outcome.unresolved, []);
});

test("random and pick are content-addressed: the same context picks the same option every call", () => {
  const text = "{{random::dry::warm::sharp}}|{{pick::terse::luxurious}}";
  const first = evaluatePresetText(text, context);
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(evaluatePresetText(text, context).text, first.text);
  }
  assert.deepEqual(first.unresolved, []);
  assert.equal(first.text.split("|").length, 2);
});

test("the draw depends on the entry identity, not on the number of calls", () => {
  const picks = new Set<string>();
  for (let index = 0; index < 10; index++) {
    const outcome = evaluatePresetText("{{random::a::b::c}}", { ...context, itemId: `entry-${index}` });
    picks.add(outcome.text);
  }
  assert.ok(picks.size >= 2, `10 entries produced ${picks.size} distinct picks: ${[...picks].join(", ")}`);
});

test("the chosen option is one of the candidates", () => {
  const outcome = evaluatePresetText("{{random::only}}", context);
  assert.equal(outcome.text, "only");
});

test("a draw with no candidates is reported instead of empty", () => {
  const outcome = evaluatePresetText("a {{random}} b", context);
  assert.equal(outcome.text, "a {{random}} b");
  assert.deepEqual(outcome.unresolved, ["random"]);
});

test("an unimplemented macro inside an argument keeps the outer macro literal too", () => {
  const outcome = evaluatePresetText("{{getvar::{{time}}_mood}}", context);
  assert.equal(outcome.text, "{{getvar::{{time}}_mood}}");
  assert.deepEqual(outcome.unresolved, ["time", "getvar"]);
});

test("a macro the table does not carry is reported as unknown, not unresolved", () => {
  const outcome = evaluatePresetText("a {{mood_ring}} b", context);
  assert.equal(outcome.text, "a {{mood_ring}} b");
  assert.deepEqual(outcome.unresolved, []);
  assert.deepEqual(outcome.unknown, ["mood_ring"]);
});

test("a token with no identifier is reported by its own spelling", () => {
  assert.deepEqual(evaluatePresetText("{{// a note}}", context).unknown, ["// a note"]);
});

test("an unterminated brace pair is literal text and is not a macro", () => {
  const outcome = evaluatePresetText("{{char is here", context);
  assert.equal(outcome.text, "{{char is here");
  assert.deepEqual(outcome.unresolved, []);
  assert.deepEqual(outcome.unknown, []);
});

test("trim removes the whitespace around the entry it appears in; newline renders one newline", () => {
  assert.equal(evaluatePresetText("{{trim}}\n\nbody\n\n", context).text, "body");
  assert.equal(evaluatePresetText("a{{newline}}b", context).text, "a\nb");
  assert.equal(evaluatePresetText("  body  ", context).text, "  body  ");
});

test("a macro value is substituted as text, never re-evaluated", () => {
  const outcome = evaluatePresetText("{{setvar::x::{{user}}}}{{getvar::x}}", { ...context, user: "{{char}}" });
  assert.equal(outcome.text, "{{char}}");
});

test("presetMacroTokens reads every token, nested ones included, in source order", () => {
  const tokens = presetMacroTokens("{{getvar::{{char}}_mood}} and {{RANDOM::a::b}}");
  assert.deepEqual(
    tokens.map((token) => token.name),
    ["getvar", "char", "random"],
  );
  assert.deepEqual(
    tokens.map((token) => token.raw),
    ["{{getvar::{{char}}_mood}}", "{{char}}", "{{RANDOM::a::b}}"],
  );
  assert.deepEqual(presetMacroTokens("no macros here"), []);
});
