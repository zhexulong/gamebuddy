import { type IdentityProfile } from "../identity-profile.js";
import { keepAuthoredText } from "./companion-authored-text.js";
import { type MacroTable, renderMacros } from "./macro-engine.js";
import { type CompanionProfileBindingRefresh, writeMountedIdentityProfile } from "./mounted-identity-profile-write.js";

/** The effective directive the durable profile holds, or null when it holds none. */
export type CompanionVoiceProjection = Readonly<{ text: string; source: "card" | "player" }>;

/**
 * The directive the durable profile holds, or null when it holds none.
 *
 * The text is the AUTHOR's (`{{char}}`/`{{user}}`), because the card export writes this
 * record back. The surface that paints it renders through the run's macro table at its own
 * seam - `renderCompanionVoiceText` - exactly as it renders her persona and her openings.
 */
export function projectCompanionVoice(profile: IdentityProfile): CompanionVoiceProjection | null {
  const voice = profile.characterVoice;
  return voice === undefined ? null : Object.freeze({ text: voice.text, source: voice.source });
}

/** One stored directive as the surface that reads it must show it: macros resolved. */
export function renderCompanionVoiceText(
  voice: CompanionVoiceProjection,
  macros: MacroTable,
): CompanionVoiceProjection {
  return Object.freeze({ text: renderMacros(voice.text, macros), source: voice.source });
}

/**
 * One revision-CASed edit or clear of the mounted companion's performance directive (the
 * reviewed card's `system_prompt`). `voice === null` clears the field - the member is
 * removed, never stored as empty text, so a cleared directive reads as absent everywhere it
 * is consumed. A non-null voice re-authors the text as the player's (`source: "player"`).
 *
 * The durable record, its revision compare-and-set, the rollback and the two pin refreshes
 * are `writeMountedIdentityProfile`'s; what belongs to the directive is which member of the
 * record it is. A revision other than the one the browser read is refused
 * (`character_voice_conflict`) - the browser never silently overwrites an edit it did not
 * see.
 */
export async function updateMountedCompanionVoice(
  input: Readonly<{
    identityProfilePath: string;
    runtimeCwd: string;
    containmentRoot: string;
    identityKey: string;
    expectedProfileRevision: number;
    /** The table the surface RENDERED the text through; the save turns it back into the author's. */
    macros: MacroTable;
    voice: Readonly<{ text: string }> | null;
    refreshThreadBindings: CompanionProfileBindingRefresh;
  }>,
): Promise<Readonly<{ profileRevision: number; characterVoice: CompanionVoiceProjection | null }>> {
  const next = await writeMountedIdentityProfile({
    identityProfilePath: input.identityProfilePath,
    runtimeCwd: input.runtimeCwd,
    containmentRoot: input.containmentRoot,
    identityKey: input.identityKey,
    expectedProfileRevision: input.expectedProfileRevision,
    conflict: "character_voice_conflict",
    bindingUnavailable: "character_voice_binding_unavailable",
    refreshThreadBindings: input.refreshThreadBindings,
    next(current) {
      // Clearing must REMOVE the member rather than store empty text, so the existing value is
      // stripped before the next profile is validated.
      const withoutVoice: Record<string, unknown> = { ...current };
      delete withoutVoice.characterVoice;
      // The browser sends back what it READ, and what it read was the rendering. A value
      // that still renders to exactly the directive on disk IS that directive, and storing
      // the rendering instead would bake this run's macros into the durable record.
      const authoredText =
        input.voice === null || current.characterVoice === undefined
          ? input.voice?.text
          : keepAuthoredText(input.voice.text, current.characterVoice.text, input.macros);
      return {
        ...withoutVoice,
        revision: current.revision + 1,
        ...(authoredText === undefined ? {} : { characterVoice: { text: authoredText, source: "player" } }),
      };
    },
  });
  return Object.freeze({
    profileRevision: next.revision,
    characterVoice: projectCompanionVoice(next),
  });
}
