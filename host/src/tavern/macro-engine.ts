/**
 * Renders the small, inert macro subset accepted during companion provisioning.
 * Replacement is deliberately single-pass: a value containing another macro is
 * emitted verbatim and is not rendered again.
 */
export function renderMacros(text: string, vars: MacroTable): string {
  return text.replace(MACRO_PATTERN, (macro) => {
    const resolve = RESOLVED_MACROS.get(macroKey(macro) ?? "");
    // `undefined` from the table is the macro being left exactly as the card wrote it - either a standard macro this
    // engine deliberately cannot fill (`LEFT_LITERAL_STANDARD_MACROS`) or one it does not know at all. Both land on the
    // same value, which is what keeps `hasUnrenderedMacro` the single rule a caller has to read.
    return resolve?.(vars) ?? macro;
  });
}

/**
 * One macro name - the spelling recognition AND classification both agree on.
 *
 * It is one constant because it used to be two spellings in this one file, and they diverged: `macroKey` tolerated the
 * space inside the braces and read only the leading name of a parametric macro, while the replacement pattern demanded
 * the name flush against both braces. `{{ char }}` therefore classified as the `char` macro in every bucket test and was
 * never replaced by `renderMacros`; the survivor then read as junk to `hasUnrenderedMacro` and the whole text carrying it
 * was dropped. Both readers below derive from this grammar, so a spelling cannot be known to one and invisible to the
 * other.
 */
const MACRO_NAME = String.raw`[a-z_][a-z0-9_]*`;
/** A `{{...}}` token: optional space, the name, then whatever the macro carries besides braces (`{{random::a::b}}`). */
const BRACED_MACRO = String.raw`\{\{\s*(${MACRO_NAME})[^{}]*\}\}`;
/** The angle spelling of the same name: SillyTavern's `<BOT>` and `<USER>`. */
const ANGLE_MACRO = String.raw`<(${MACRO_NAME})>`;
/** Every macro token this engine recognises, in either spelling. */
const MACRO_PATTERN = new RegExp(`${BRACED_MACRO}|${ANGLE_MACRO}`, "giu");
/** The same grammar anchored to one whole token: how a name is read out of it. */
const WHOLE_MACRO = new RegExp(`^(?:${BRACED_MACRO}|${ANGLE_MACRO})$`, "iu");

/**
 * One macro name, normalised to the spelling the tables are keyed by: `{{Char}}`, `<BOT>` and `{{ char }}` all read
 * their own key. `undefined` means the token is not a macro at all (`{{...}}`, `{{// note}}`).
 */
function macroKey(token: string): string | undefined {
  // Only the leading NAME of a parametric macro: `{{random::a::b}}` is `random`, `{{getvar::x}}` is `getvar`. The
  // arguments are not part of what decides whether the macro can be rendered. Either alternative of `WHOLE_MACRO`
  // captures the name, and only one of them ever participates, so the name is whichever group is present.
  const match = WHOLE_MACRO.exec(token);
  return (match?.[1] ?? match?.[2])?.toLowerCase();
}

/**
 * Bucket 1 - the macros `renderMacros` resolves, and where each value comes from.
 *
 * A resolver returning `undefined` is "this table does not have that value in this run", and the macro then stays
 * literal - which is how `{{scenario}}` in a card that wrote no scenario is dropped by the caller's unrendered-macro
 * rule instead of being silently emptied.
 *
 * `{{newline}}` and `{{noop}}` are the two macros here that carry no run state at all: SillyTavern defines them as a
 * newline and as nothing, so resolving them is exact rather than a guess, and an entry that used one to lay its own
 * text out is not dropped for it.
 */
const RESOLVED_MACROS: ReadonlyMap<string, (vars: MacroTable) => string | undefined> = new Map([
  ["char", (vars: MacroTable) => vars.char ?? ""],
  ["bot", (vars: MacroTable) => vars.char ?? ""],
  ["user", (vars: MacroTable) => vars.user ?? ""],
  // The card's own prose, which SillyTavern exposes as macros and authors use inside world-book entries. They are
  // the companion's own text, so resolving them reads nothing the catalogue did not already carry - and without them
  // an entry that mentions `{{scenario}}` was dropped entirely by catalog-service's unrendered-macro rule.
  ["scenario", (vars: MacroTable) => vars.scenario],
  ["personality", (vars: MacroTable) => vars.personality],
  ["description", (vars: MacroTable) => vars.description],
  ["newline", () => "\n"],
  ["noop", () => ""],
]);

/**
 * Bucket 2 - standard SillyTavern macros this engine deliberately leaves literal, each with the reason it cannot be
 * filled at the point this text becomes durable authored content.
 *
 * These are NOT unknown placeholder junk. A card author who writes `{{time}}` inside a world-book entry is doing the
 * normal thing, and the entry is still dropped - but the drop is now reported by name (see `unrenderedMacros` and
 * `isStandardSillyTavernMacro`), so the player can go and edit the card instead of finding an entry missing with no
 * explanation.
 *
 * Two different reasons live in this one bucket, and neither is fixable by "just substitute something":
 *
 *  - the CLOCK and the DICE have no single value here. Authored text is the cached stable prefix, so a value read per
 *    assembly would re-fold that prefix every turn and cost the cache it exists for; and a random draw cannot even be
 *    probed for renderability, because two probes of the same entry disagree.
 *  - the CONVERSATION does not exist yet. A card is decoded before any turn is generated, so there is no last message,
 *    no idle duration, no model name and no message to be `original` to. Substituting an empty string or a neutral word
 *    would not be honest: `她{{original}}说过` rendered with `""` reads as a different sentence, and the player would
 *    have no way to know the card said something else.
 *
 * A macro outside this table and outside `RESOLVED_MACROS` is bucket 3: this importer does not recognise it, which is
 * reported as such rather than assumed unknown to SillyTavern.
 */
export const LEFT_LITERAL_STANDARD_MACROS: Readonly<Record<string, string>> = Object.freeze({
  time: "SillyTavern fills this from the host's real clock. Authored text is the cached stable prefix, so a per-assembly value would re-fold it every turn; there is no other clock at this seam.",
  date: "The same clock as `{{time}}`, at day granularity: it still changes while the cached prefix is meant to stay byte-identical.",
  random:
    "SillyTavern draws one of the given options on every evaluation, so the same entry reads differently on two assemblies and cannot be probed for renderability at all.",
  lastmessage:
    "The previous message of a conversation that does not exist yet: a card is decoded before any turn is generated.",
  idle_duration: "How long the player has been away, which is conversation state this import has never seen.",
  original:
    "The message being generated, which does not exist at import time. Emptying it would silently reword the card's own sentence.",
  model:
    "The provider's model name. No connection or model is chosen when a card is decoded, and the name changes per connection.",
});

/**
 * Every `{{...}}` macro that survived rendering in `text`, de-duplicated, in the order the text uses them.
 *
 * This is the reporting side of the unrendered-macro rule: a caller that drops something because of these can name
 * them, which is the difference between "3 entries lost" and "entry 大肥鱼家族 lost: contains {{original}}".
 */
export function unrenderedMacros(text: string): readonly string[] {
  const seen = new Set<string>();
  // A fresh pattern per call: `String.prototype.matchAll` clones the RegExp it is given, but a shared lastIndex is the
  // kind of state that makes a pure helper stop being pure.
  for (const match of text.matchAll(/\{\{[^{}]*\}\}/gu)) seen.add(match[0]);
  return Object.freeze([...seen]);
}

/** How many macros one report line names. A field may carry more; the line stays bounded and says how many it did not. */
const MAX_NAMED_MACROS = 8; /**
 * The most characters of one macro token a report line carries.
 *
 * `unrenderedMacros` returns whatever the text wrote between its braces, so a card can author a token far longer than any
 * real macro. One pathological field must not turn a diagnostic into a page.
 */
const MAX_NAMED_MACRO_CHARS = 64;

/**
 * The macros one report line names, bounded in count and in token length so a diagnostic stays one readable line.
 *
 * Naming them is what makes a drop actionable: "3 entries lost" leaves the player with nothing to edit, while the token
 * itself tells them what their card wrote.
 */
export function namedMacros(tokens: readonly string[]): string {
  const named = tokens
    .slice(0, MAX_NAMED_MACROS)
    .map((token) => (token.length <= MAX_NAMED_MACRO_CHARS ? token : `${token.slice(0, MAX_NAMED_MACRO_CHARS)}…`));
  const rest = tokens.length - named.length;
  return rest > 0 ? `${named.join(", ")} (+${rest} more)` : named.join(", ");
}

/**
 * The unrendered macros in `text`, split by whether SillyTavern itself defines them, or `undefined` when none survived.
 *
 * The split is the whole policy of every caller that consumes it, and it is the same policy in each: a token SillyTavern
 * defines but this engine deliberately leaves literal (`{{time}}`) means the field is dropped and NAMED, while a token
 * neither table knows is a defect the caller refuses on. Two callers - a reviewed card's field and a third-party
 * preset's - differ in what they DO about it, never in how they read it, so the reading lives here once.
 */
export function survivingMacros(
  rendered: string,
): Readonly<{ standard: readonly string[]; unrecognised: readonly string[] }> | undefined {
  const tokens = unrenderedMacros(rendered);
  if (tokens.length === 0) return undefined;
  return Object.freeze({
    standard: Object.freeze(tokens.filter((token) => isStandardSillyTavernMacro(token))),
    unrecognised: Object.freeze(tokens.filter((token) => !isStandardSillyTavernMacro(token))),
  });
}

/**
 * Whether `token` is a macro SillyTavern itself defines - rendered here, or deliberately left literal.
 *
 * `false` is a statement about this importer's own knowledge, not about SillyTavern: it means the token matched neither
 * table, so the player should look at it as a possible typo or a non-standard extension rather than as a macro this
 * product refuses to fill.
 */
export function isStandardSillyTavernMacro(token: string): boolean {
  const key = macroKey(token);
  return key !== undefined && (RESOLVED_MACROS.has(key) || isLeftLiteralStandardMacro(token));
}

/**
 * Whether `token` is a standard SillyTavern macro this engine DELIBERATELY leaves literal - bucket 2 only.
 *
 * Narrower than `isStandardSillyTavernMacro` on purpose, and the difference is the whole reason this exists: that one is
 * also true for `{{char}}` and `{{user}}`, which ARE filled at render. Telling the player "your card lost {{user}}" would
 * be false about their own card, so "will this text survive every render this product performs" is its own question with
 * its own answer.
 *
 * That makes it usable where no macro table exists yet. The import seam decodes a card before any run decides its player
 * reference or its companion name, and this predicate still answers exactly, because a bucket-2 token survives rendering
 * under EVERY table - which is what its table's own reasons amount to. No second copy of the tables is written for it.
 */
export function isLeftLiteralStandardMacro(token: string): boolean {
  const key = macroKey(token);
  return key !== undefined && Object.hasOwn(LEFT_LITERAL_STANDARD_MACROS, key);
}

/** The macro table one rendered companion text is produced with. */
export type MacroTable = Readonly<{
  char: string;
  user: string;
  /** The card's own prose, so `{{scenario}}` and its siblings resolve rather than dropping the entry that used them. */
  scenario?: string;
  personality?: string;
  description?: string;
}>;

/**
 * The one macro table for a rendered companion text, and the one place the
 * player reference is chosen.
 *
 * `{{char}}`/`<BOT>` is the companion's own name; `{{user}}`/`<USER>` is the
 * player. The player side used to be the English literal "the player" at every
 * call site, so a Chinese card's own prose was frozen into the companion's
 * profile as 与the player一同从都市迁居 — English inside a Chinese 设定, with
 * nothing anywhere reporting that the rendering had gone wrong. The rule is the
 * run's own: the name a caller actually has, else the locale's own word for the
 * player.
 */
export function macroTable(
  input: Readonly<{
    char: string;
    user?: string | null | undefined;
    locale?: string | undefined;
    scenario?: string | undefined;
    personality?: string | undefined;
    description?: string | undefined;
  }>,
): MacroTable {
  const named = typeof input.user === "string" ? input.user.trim() : "";
  return Object.freeze({
    char: input.char,
    user: named.length > 0 ? named : playerReferenceWord(input.locale),
    ...(input.scenario === undefined ? {} : { scenario: input.scenario }),
    ...(input.personality === undefined ? {} : { personality: input.personality }),
    ...(input.description === undefined ? {} : { description: input.description }),
  });
}

/**
 * The word `{{user}}` stands for when nothing names the player.
 *
 * SillyTavern substitutes the macro for the player's persona name and never adapts it to grammar, so a card that writes
 * `{{user}} is late` reads `Mira is late`. A pronoun cannot do that job in English: `you is late` is what a card written in
 * the third person turns into, because the sentence's own verb was chosen for a noun. So the unnamed fallback is a noun in
 * English (`the player`) and 你 in Chinese, where no inflection disagrees with it.
 *
 * The noun does read as a third party, which the shipped card forbids her to use for the *player she addresses*. That is
 * why a name always wins over this word - see `macroTable` - and why the preset companion supplies one.
 */
function playerReferenceWord(locale: string | undefined): string {
  // SillyTavern substitutes the player's persona *name*, and a persona always has one - an unnamed player falls back to
  // the name "User" there. A name is a noun, so a card written in the third person still agrees with its own verb
  // ("User is late"), which neither a pronoun ("you is late") nor a description ("the player is late", and the shipped
  // card forbids speaking of the player that way) can do. Chinese keeps 你: it has no inflection to disagree with, and
  // addressing the player directly is what the card asks for.
  return typeof locale === "string" && locale.toLowerCase().startsWith("zh") ? "你" : "User";
}

/**
 * Renders the macro subset a reviewed world book may carry at the moment the
 * book becomes authored content: `{{user}}`/`<USER>` resolve to the player
 * reference, and `{{char}}` resolves only when the caller knows the companion's
 * name (`char: null` leaves it, and every other macro, untouched).
 *
 * Leaving an unknown macro in place is deliberate: the caller detects it with
 * `hasUnrenderedMacro` and omits that entry rather than shipping a `{{...}}`
 * placeholder into the companion's context or a tool result.
 */
export function renderWorldBookText(
  text: string,
  vars: Readonly<{
    char: string | null;
    user?: string | null | undefined;
    locale?: string | undefined;
    scenario?: string | undefined;
  }>,
): string {
  return renderMacros(
    text,
    macroTable({ char: vars.char ?? "{{char}}", user: vars.user, locale: vars.locale, scenario: vars.scenario }),
  );
}

/** Matches a `{{...}}` macro that survived rendering. */
const UNRENDERED_MACRO_PATTERN = /\{\{[^{}]*\}\}/u;
export function hasUnrenderedMacro(text: string): boolean {
  return UNRENDERED_MACRO_PATTERN.test(text);
}
