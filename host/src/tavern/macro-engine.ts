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
