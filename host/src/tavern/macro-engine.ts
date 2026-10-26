/**
 * Renders the small, inert macro subset accepted during companion provisioning.
 * Replacement is deliberately single-pass: a value containing another macro is
 * emitted verbatim and is not rendered again.
 */
export function renderMacros(text: string, vars: MacroTable): string {
  return text.replace(MACRO_PATTERN, (macro) => {
    const key = macro
      .toLowerCase()
      .replace(/^<|>$/gu, "")
      .replace(/^\{\{|\}\}$/gu, "");
    switch (key) {
      case "char":
      case "bot":
        return vars.char ?? "";
      case "user":
        return vars.user ?? "";
      // The card's own prose, which SillyTavern exposes as macros and authors use inside world-book entries. They are
      // the companion's own text, so resolving them reads nothing the catalogue did not already carry - and without them
      // an entry that mentions `{{scenario}}` was dropped entirely by catalog-service's unrendered-macro rule.
      case "scenario":
        return vars.scenario ?? macro;
      case "personality":
        return vars.personality ?? macro;
      case "description":
        return vars.description ?? macro;
      // Time and date are deliberately NOT rendered here. They change every turn, and this text is part of the cached
      // stable prefix: substituting them would re-fold the prefix on each turn and break the byte stability the cache
      // depends on. An entry that needs the clock asks for it in the volatile layer, where the same macros are rendered
      // against the turn's own facts.
      default:
        return macro;
    }
  });
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

/** Every macro spelling this engine recognises, in either brace or angle form. */
const MACRO_PATTERN = /\{\{[a-z_]+\}\}|<BOT>|<USER>/giu;

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
  vars: Readonly<{ char: string | null; user?: string | null | undefined; locale?: string | undefined }>,
): string {
  return renderMacros(text, macroTable({ char: vars.char ?? "{{char}}", user: vars.user, locale: vars.locale }));
}

/** Matches a `{{...}}` macro that survived rendering. */
const UNRENDERED_MACRO_PATTERN = /\{\{[^{}]*\}\}/u;
export function hasUnrenderedMacro(text: string): boolean {
  return UNRENDERED_MACRO_PATTERN.test(text);
}
