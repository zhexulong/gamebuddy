/**
 * Renders the small, inert macro subset accepted during companion provisioning.
 * Replacement is deliberately single-pass: a value containing another macro is
 * emitted verbatim and is not rendered again.
 */
export function renderMacros(text: string, vars: MacroTable): string {
  const char = vars.char ?? "";
  const user = vars.user ?? "";
  return text.replace(/\{\{char\}\}|<BOT>|\{\{user\}\}|<USER>/giu, (macro) => {
    return macro.toLowerCase() === "{{char}}" || macro.toLowerCase() === "<bot>" ? char : user;
  });
}

/** The macro table one rendered companion text is produced with. */
export type MacroTable = Readonly<{ char: string; user: string }>;

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
  input: Readonly<{ char: string; user?: string | null | undefined; locale?: string | undefined }>,
): MacroTable {
  const named = typeof input.user === "string" ? input.user.trim() : "";
  return Object.freeze({
    char: input.char,
    user: named.length > 0 ? named : playerReferenceWord(input.locale),
  });
}

/**
 * The locale's own word for the player, used when nothing names them: a zh run
 * says 你, every other locale says you.
 *
 * This default is a SECOND PERSON pronoun, never a noun, because the macro
 * stands for the player *being addressed* - the person the companion is
 * speaking to in this scene - and a card's own prose says `{{user}}` wherever it
 * would say "you" to that person. A noun (玩家, "the player") reads as a third
 * party the companion is talking about, which is exactly what the shipped
 * card's `post_history_instructions` forbids her to do (「严禁使用“她”等第三…」):
 * 与玩家一同从都市迁居 told a companion to speak about the player while the
 * card told her to speak to them. A nickname, when the player has one, still
 * wins over any word - see `macroTable`.
 */
function playerReferenceWord(locale: string | undefined): string {
  return typeof locale === "string" && locale.toLowerCase().startsWith("zh") ? "你" : "you";
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
