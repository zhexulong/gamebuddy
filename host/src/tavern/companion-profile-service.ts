import { existsSync } from "node:fs";
import { readIdentityProfile } from "../identity-profile.js";
import { resolveRuntimePaths } from "../runtime-identity.js";
import type { TavernArtifactStore } from "./artifact-store.js";
import {
  COMPANION_PROFILE_NAME_MAX_LENGTH,
  COMPANION_PROFILE_TEXT_MAX_LENGTH,
  type CompanionProfileV1,
  TAVERN_BROWSER_API_VERSION,
} from "./browser-contract/index.js";
import { projectRenderedCompanionWorldBook } from "./companion-world-book-service.js";
import { createGreetingManagementService } from "./greeting-management/greeting-management.js";
import { type MacroTable, macroTable, renderMacros } from "./macro-engine.js";
import { createScenarioManagementService } from "./scenario-management/scenario-management.js";
import { resolveTavernPaths } from "./tavern-paths.js";

/**
 * The read-only character inspector's projection: one roster companion's own
 * authored facts, addressed by the opaque handle the roster handed out.
 *
 * Every other companion-addressed read resolves the MOUNTED companion only
 * (`companion.worldbook.read`, `character.voice.read`) or is the PLAYER's own
 * record (`persona.read`), so no route projected what an archived companion
 * carries - her name, her persona, her scenario, her openings and her own world
 * book were on disk and unreadable. This is that read, and it is read-only by
 * construction: there is no update member and no route serves a write, so the
 * inspector can never become a second, divergent place to edit a field another
 * panel owns.
 *
 * Which companion a handle names is NOT this module's decision: the handle is a
 * per-mount HMAC, so the caller owns the reverse map (`resolveCompanion`) and
 * this module only reads the roots the resolved record derives. The durable
 * artifacts are read from the companion's own `companionRoot` and `runtimeCwd`,
 * exactly as the mount derives them, so an archived companion's facts are read
 * where they were written.
 *
 * Every authored string is rendered through the run's macro table at this seam -
 * `{{user}}`/`{{char}}` resolved, never a raw placeholder - and the durable
 * record keeps the author's own text. A field that renders past its bound is
 * refused by name rather than shortened (`companion_profile_text_too_long`),
 * because a shortened field would read as the author's own words.
 */
export type CompanionProfileTarget = Readonly<{
  companionId: string;
  continuityId: string;
  /**
   * The companion's library name, used only when she has no readable identity
   * profile; null means the caller could not name her at all, which is a handle
   * the roster never projected (see `read`).
   */
  name: string | null;
}>;

export type CompanionProfileService = Readonly<{
  read(handle: string): Promise<CompanionProfileV1 | null>;
}>;

export function createCompanionProfileService(
  options: Readonly<{
    store: TavernArtifactStore;
    runtimeRoot: string;
    playerId: string;
    /** The player's own locale reference, resolved at the mount's own root. */
    locale(): Promise<string>;
    resolveCompanion(handle: string): Promise<CompanionProfileTarget | null>;
  }>,
): CompanionProfileService {
  return Object.freeze({
    async read(handle: string): Promise<CompanionProfileV1 | null> {
      const companion = await options.resolveCompanion(handle);
      if (companion === null) return null;
      const identity = Object.freeze({
        playerId: options.playerId,
        companionId: companion.companionId,
        continuityId: companion.continuityId,
      });
      const runtimePaths = resolveRuntimePaths(identity, options.runtimeRoot);
      const tavernPaths = resolveTavernPaths(runtimePaths, identity);
      // A missing identity profile is ordinary absence, not an error: both
      // provisioning paths write one, and a companion without one still has her
      // library name. A profile that is PRESENT but unreadable fails closed, so a
      // corrupt profile never reads as "she was made without a persona".
      const identityProfile = existsSync(runtimePaths.identityProfilePath)
        ? await readIdentityProfile(runtimePaths.identityProfilePath)
        : null;
      const name = identityProfile?.identity.name ?? companion.name;
      // The roster only projects a handle for a companion it can name, so a handle
      // that resolves to no name at all is not a roster handle.
      if (name === null) return null;
      const macros = await macroTable({ char: name, locale: await options.locale() });
      const scenario = await createScenarioManagementService(options.store, tavernPaths.companionRoot).read();
      const greetings = await createGreetingManagementService(options.store, tavernPaths.companionRoot).read();
      const persona = identityProfile?.persona;
      return Object.freeze({
        apiVersion: TAVERN_BROWSER_API_VERSION,
        name: renderProfileLabel(name, macros),
        persona: Object.freeze({
          present: persona !== undefined,
          core: renderProfileTextOrNull(persona?.core, macros),
          interactionStyle: renderProfileTextOrNull(persona?.interactionStyle, macros),
          expressionStyle: renderProfileTextOrNull(persona?.expressionStyle, macros),
        }),
        scenario: Object.freeze({
          present: scenario !== null,
          name: scenario === null ? null : renderProfileLabel(scenario.name, macros),
          description: scenario === null ? null : renderProfileText(scenario.description, macros),
        }),
        greetings: Object.freeze({
          present: greetings !== null,
          label: greetings?.label === undefined ? null : renderProfileLabel(greetings.label, macros),
          variants: Object.freeze(
            (greetings?.variants ?? []).map((variant) =>
              Object.freeze({
                label: variant.label === undefined ? null : renderProfileLabel(variant.label, macros),
                // The greeting store projects authored text verbatim - it is the
                // durable record the editor writes back - so the placeholder a
                // card's `first_mes` carries is rendered HERE, at the read seam,
                // exactly as the scenario and world-book projections do it.
                text: renderProfileText(variant.text, macros),
              }),
            ),
          ),
        }),
        worldBook: await projectRenderedCompanionWorldBook(runtimePaths.runtimeCwd, macros),
      });
    },
  });
}

/**
 * One authored profile field, rendered through the run's macro table and bounded.
 *
 * Rendering happens BEFORE the bound is applied, so a macro that straddles it is
 * resolved whole instead of being cut into a stray `{{`; a field that renders
 * past its bound is refused with one named code rather than silently shortened,
 * because a shortened field would read as the author's own text.
 */
function renderProfileText(text: string, macros: MacroTable): string {
  const rendered = renderMacros(text, macros);
  if (rendered.length > COMPANION_PROFILE_TEXT_MAX_LENGTH) throw new Error("companion_profile_text_too_long");
  return rendered;
}

/** One authored profile text field that may not be there at all. */
function renderProfileTextOrNull(text: string | undefined, macros: MacroTable): string | null {
  return text === undefined ? null : renderProfileText(text, macros);
}

/** One authored single-line profile label (a name, an opening's label), bounded. */
function renderProfileLabel(text: string, macros: MacroTable): string {
  const rendered = renderMacros(text, macros);
  if (rendered.length > COMPANION_PROFILE_NAME_MAX_LENGTH) throw new Error("companion_profile_text_too_long");
  return rendered;
}
