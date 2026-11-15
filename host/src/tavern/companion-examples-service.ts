import type { IdentityProfile } from "../identity-profile.js";
import { keepAuthoredText, renderAuthoredText } from "./companion-authored-text.js";
import type { MacroTable } from "./macro-engine.js";
import { type CompanionProfileBindingRefresh, writeMountedIdentityProfile } from "./mounted-identity-profile-write.js";

/** One example dialogue: a player turn and her reply. */
export type CompanionExamplePair = Readonly<{ user: string; companion: string }>;

/** Her example dialogues as the surface that paints them must show them. */
export type CompanionExamplesProjection = readonly CompanionExamplePair[];

/**
 * Her example dialogues, rendered for the player.
 *
 * These are the card's own `mes_example` rows - the few-shot turns that decide her register,
 * which the Host's prompt renders under `[Dialogue Examples]` (`renderIdentityProfile`).
 * The durable record keeps the AUTHOR's text (`{{user}}`/`{{char}}`), because the card export
 * writes this record back; a reader renders each half through the run's macro table, exactly as
 * it renders her directive and her openings.
 */
export function renderCompanionExamples(profile: IdentityProfile, macros: MacroTable): CompanionExamplesProjection {
  return Object.freeze(
    (profile.examples ?? []).map((example) =>
      Object.freeze({
        user: renderAuthoredText(example.user, macros),
        companion: renderAuthoredText(example.companion, macros),
      }),
    ),
  );
}

/**
 * One revision-CASed save of the whole set of example dialogues, in the order the player sees
 * them.
 *
 * An empty set CLEARS the member rather than storing an empty list: the profile renders nothing
 * from it, the card export writes no `mes_example` for it, and "she has none" has to read the
 * same however it came about.
 *
 * Every row the player did not rewrite keeps the AUTHOR's text, so a save never bakes one run's
 * rendering into the durable record - the same rule `updateMountedCompanionVoice` applies to the
 * directive, and `authoredEntries` to her world book. The durable record, its compare-and-set,
 * its rollback and its two pin refreshes are `writeMountedIdentityProfile`'s.
 */
export async function updateMountedCompanionExamples(
  input: Readonly<{
    identityProfilePath: string;
    runtimeCwd: string;
    containmentRoot: string;
    identityKey: string;
    expectedProfileRevision: number;
    /** The table the surface RENDERED the rows through; the save turns them back into the author's. */
    macros: MacroTable;
    examples: CompanionExamplesProjection;
    refreshThreadBindings: CompanionProfileBindingRefresh;
  }>,
): Promise<Readonly<{ profileRevision: number; examples: CompanionExamplesProjection }>> {
  const next = await writeMountedIdentityProfile({
    identityProfilePath: input.identityProfilePath,
    runtimeCwd: input.runtimeCwd,
    containmentRoot: input.containmentRoot,
    identityKey: input.identityKey,
    expectedProfileRevision: input.expectedProfileRevision,
    conflict: "character_examples_conflict",
    bindingUnavailable: "character_examples_binding_unavailable",
    refreshThreadBindings: input.refreshThreadBindings,
    next(current) {
      const examples = authoredExamples(current.examples ?? [], input.examples, input.macros);
      const withoutExamples: Record<string, unknown> = { ...current };
      delete withoutExamples.examples;
      return {
        ...withoutExamples,
        revision: current.revision + 1,
        ...(examples.length === 0 ? {} : { examples }),
      };
    },
  });
  return Object.freeze({
    profileRevision: next.revision,
    examples: renderCompanionExamples(next, input.macros),
  });
}

/**
 * The durable example list one save produces.
 *
 * A row the player did not touch keeps the entry it came from by that entry's own CONTENT - a
 * rendered row that still equals what a stored row renders to IS that stored row - so the
 * author's macros survive an edit to her neighbour. Identity is claimed in two passes over one
 * claimed set, strongest evidence first: both halves still equal, then a single half, which is
 * how a row the player rewrote on one side stays attached to the stored row it came from and
 * keeps the author's text on the other. A row nobody claimed is one the player wrote: her words,
 * stored verbatim.
 *
 * Claiming by content rather than by position is what keeps a removed or reordered row from
 * handing its authored text to its neighbour: two rows can share a reply, and only one of them
 * is the row the player kept.
 */
function authoredExamples(
  stored: readonly CompanionExamplePair[],
  incoming: CompanionExamplesProjection,
  macros: MacroTable,
): readonly CompanionExamplePair[] {
  const rendered = stored.map((example) =>
    Object.freeze({
      user: renderAuthoredText(example.user, macros),
      companion: renderAuthoredText(example.companion, macros),
    }),
  );
  const claimedBy: (number | null)[] = incoming.map(() => null);
  const taken: boolean[] = stored.map(() => false);
  const claim = (matches: (row: number, candidate: number) => boolean): void => {
    for (let row = 0; row < incoming.length; row += 1) {
      if (claimedBy[row] !== null) continue;
      const index = stored.findIndex((_, candidate) => !taken[candidate] && matches(row, candidate));
      if (index < 0) continue;
      taken[index] = true;
      claimedBy[row] = index;
    }
  };
  // Both halves still render to the same text: the row is untouched.
  claim(
    (row, candidate) =>
      rendered[candidate]!.user === incoming[row]!.user && rendered[candidate]!.companion === incoming[row]!.companion,
  );
  // One half still renders to the same text: the player rewrote the other, and this row is the
  // stored row it came from.
  claim(
    (row, candidate) =>
      rendered[candidate]!.user === incoming[row]!.user || rendered[candidate]!.companion === incoming[row]!.companion,
  );
  return Object.freeze(
    incoming.map((row, position) => {
      const index = claimedBy[position];
      if (index === null || index === undefined) return Object.freeze({ user: row.user, companion: row.companion });
      const authored = stored[index]!;
      return Object.freeze({
        user: keepAuthoredText(row.user, authored.user, macros),
        companion: keepAuthoredText(row.companion, authored.companion, macros),
      });
    }),
  );
}
