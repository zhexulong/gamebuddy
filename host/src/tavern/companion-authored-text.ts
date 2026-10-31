import { join } from "node:path";
import { readIdentityProfile } from "../identity-profile.js";
import { resolveCompanionLocale } from "../settings/player-preference-store.js";
import { type MacroTable, macroTable, renderMacros } from "./macro-engine.js";

/**
 * The macro table a stored authored text renders through, for a reader that holds only the
 * companion's own paths.
 *
 * One derivation for the whole Tavern surface: `{{char}}` is the name the runtime
 * provisioned - read from the identity profile beside the runtime cwd, i.e. the profile the
 * surface mounted against, not a second copy of her name - and `{{user}}` is the run's own
 * word for the player. Those are the same two values `renderIdentityProfile` builds its
 * table from for the prompt, so a macro cannot expand one way in her persona and another in
 * her opening.
 *
 * `{{time}}`/`{{date}}` stay literal, because `renderMacros` does not resolve them: a value
 * that changes every turn would re-fold the cached prefix. A card that wants the clock asks
 * in the volatile layer.
 */
export async function companionMacroTable(
  paths: Readonly<{ runtimeCwd: string; runtimeRoot: string }>,
): Promise<MacroTable> {
  const name = await readIdentityProfile(join(paths.runtimeCwd, "identity-profile.json")).then(
    (profile) => profile.identity.name,
    // A companion whose profile is absent or unreadable still has her scenario, her openings
    // and her book; those render without a companion name rather than turning the whole read
    // into a corruption report.
    () => "",
  );
  return macroTable({ char: name, locale: await resolveCompanionLocale(paths.runtimeRoot) });
}

/**
 * The AUTHORED record behind the text an editor handed back.
 *
 * An editor reads the RENDERED text - that is what a player can read - and writes back what
 * the player edited. Storing that would bake one run's rendering into the durable record: the
 * same defect the import path was cured of, moved to the edit, and invisible until the card
 * is exported. So a value that still renders to exactly what the authored text renders to IS
 * that authored text and is kept as it was; anything else is the player's own words and is
 * stored verbatim.
 *
 * This is `companion-world-book-service.ts`'s rule (`authoredEntries`), stated once for the
 * fields whose only identity is their own rendered text.
 */
export function keepAuthoredText(incoming: string, authored: string, macros: MacroTable): string {
  return renderMacros(authored, macros) === incoming ? authored : incoming;
}

/** One authored text rendered for a reader. Single pass: the output is never rendered again. */
export function renderAuthoredText(text: string, macros: MacroTable): string {
  return renderMacros(text, macros);
}
