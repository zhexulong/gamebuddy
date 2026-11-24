import { declaredProblemSentence } from "../composed-problem-view";
import type { Messages } from "../i18n";
import type { ManagementPipelineApi } from "../management-pipeline-api";
import type { BrowserDraftV1 } from "../reference-pipeline-api";
import type { ViewState } from "./composed-reference-game-view";

/** The two presses the composer's draft offers. */
export type DraftMutationKind = "save" | "discard";

/** What the composer's draft row tells the player after a press. */
export type DraftNotice = Readonly<{ kind: "success" | "failure"; text: string }>;

/**
 * The shell's own seams, handed over once instead of being re-read by the envelope.
 *
 * Every one of them is a fact this module must not own: the view and the composer's field are the
 * shell's synchronous state (`ref` because the mutation resolves after an await and can never act on
 * a stale render), the three routes are the management client's, and the seeded draft, the notice,
 * the commitment and the catalogue belong to the shell and to its bootstrap.
 */
export type DraftMutationInput = Readonly<{
  viewRef: { readonly current: ViewState };
  /** The composer's field: the single authoring buffer a save sends, trimmed. */
  inputTextRef: { readonly current: string };
  api: Pick<ManagementPipelineApi, "readDraft" | "saveDraft" | "discardDraft">;
  /** Takes the Host's kept draft as the field's new truth - and only the Host's kept draft. */
  seedDraft: (draft: BrowserDraftV1) => void;
  setDraftNotice: (notice: DraftNotice) => void;
  commit: (next: ViewState) => void;
  labels: () => Messages;
}>;

export type DraftMutation = (kind: DraftMutationKind) => Promise<void>;

/**
 * The one envelope both durable-draft controls of the composed shell are written through.
 *
 * Durable draft authoring, merged from the removed management surface: the PUT/DELETE carries this
 * mount's exact expected revision and the validated durable read-back replaces the draft - nothing
 * is ever guessed locally.
 *
 * The composed Chat projection pins the reference profile's operation list, which declares no
 * `draft.save`/`draft.discard`, so there is no capability flag to gate these two controls on and the
 * served route IS the capability - the same rule `management-surface-panels.tsx` documents for a
 * panel mounted here. A rejected mutation is therefore reported, never hidden.
 *
 * It is one module for the reason `message-mutation` and `turn-mutation` are: written inside the
 * shell's render body, the rules below sat among the message-level envelopes they do not share a
 * latch, a reread or a wire call with, and a reader could not tell which of them applied to a draft.
 * Here the two presses are the whole surface, so the rule that a failure may never reach the
 * composer is read once, beside the code that could break it.
 */
export function createDraftMutation(input: DraftMutationInput): DraftMutation {
  /**
   * Any rejection first re-reads the authoritative durable draft: a rejected write means the durable
   * draft may no longer match this mount's revision (a stale tab's 409 draft/selection conflict), so
   * the mounted draft takes the server read-back and the next save is the compare-and-swap the route
   * asks for. The read-back is AUTHORITY, never text: it must not reach the composer, which holds
   * whatever the player is writing. An earlier version seeded it there, so a 409 or a network blip
   * replaced the sentence in flight with the Host's older copy - player input discarded by a failure
   * the player did not cause. A read-back may only become the field's text on a success
   * (`seedDraft` below) or through the shell's seeding effect, which leaves a locally edited field
   * alone when the revision it was seeded at moves.
   */
  return async (kind) => {
    const current = input.viewRef.current;
    if (current.kind !== "ready" || current.session === null || current.draft === null) return;
    if (current.session.snapshot.selection === null) return;
    try {
      const selectionGeneration = current.session.snapshot.selection.generation;
      const expectedRevision = current.draft.revision;
      const csrfToken = current.session.snapshot.csrfToken;
      const result =
        kind === "save"
          ? await input.api.saveDraft(
              { apiVersion: 1, selectionGeneration, expectedRevision, text: input.inputTextRef.current.trim() },
              csrfToken,
            )
          : await input.api.discardDraft({ apiVersion: 1, selectionGeneration, expectedRevision }, csrfToken);
      input.seedDraft(result);
      input.setDraftNotice({ kind: "success", text: input.labels().success });
      input.commit({ ...current, draft: result });
    } catch (error) {
      // The refusal's own sentence, not a generic one: a stale draft and a forbidden draft read differently to the
      // player, and every other mutation on this surface already words itself through the catalogue.
      const sentence = declaredProblemSentence(error, input.labels()) ?? input.labels().failure;
      input.setDraftNotice({ kind: "failure", text: sentence });
      try {
        const draft = await input.api.readDraft();
        const fresh = input.viewRef.current;
        // `commit` only - never `seedDraft`: the revision is what the next save compares and swaps
        // against, and the words stay the player's. The shell's seeding effect leaves a locally edited
        // field alone when the revision it was seeded at moves, so this cannot reach the composer either.
        if (fresh.kind === "ready") input.commit({ ...fresh, draft });
      } catch {
        // The read-back failed too, so this mount keeps the revision it had; the notice above is what
        // the player reads, and the next save states the same conflict again rather than guessing.
      }
    }
  };
}
