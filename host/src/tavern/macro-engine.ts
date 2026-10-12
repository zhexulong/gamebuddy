/**
 * Renders the small, inert macro subset accepted during companion provisioning.
 * Replacement is deliberately single-pass: a value containing another macro is
 * emitted verbatim and is not rendered again.
 */
export function renderMacros(text: string, vars: Readonly<{ char: string; user: string }>): string {
  const char = vars.char ?? "";
  const user = vars.user ?? "";
  return text.replace(/\{\{char\}\}|<BOT>|\{\{user\}\}|<USER>/giu, (macro) => {
    return macro.toLowerCase() === "{{char}}" || macro.toLowerCase() === "<bot>" ? char : user;
  });
}

/**
 * Renders the macro subset a reviewed world book may carry at the moment the
 * book becomes authored content: `{{user}}`/`<USER>` resolve to the player
 * reference, and `{{char}}` resolves only when the caller knows the companion's
 * name (`char: null` leaves it, and every other macro, untouched).
 *
 * Leaving an unknown macro in place is deliberate: the caller detects it with
 * `hasUnrenderedMacro` and drops that entry rather than shipping a `{{...}}`
 * placeholder into the companion's context or a tool result.
 */
export function renderWorldBookText(text: string, vars: Readonly<{ char: string | null }>): string {
  return renderMacros(text, { char: vars.char ?? "{{char}}", user: "the player" });
}

/** Matches a `{{...}}` macro that survived rendering. */
const UNRENDERED_MACRO_PATTERN = /\{\{[^{}]*\}\}/u;
export function hasUnrenderedMacro(text: string): boolean {
  return UNRENDERED_MACRO_PATTERN.test(text);
}
