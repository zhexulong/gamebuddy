import type { ComposedReferenceGameBrowserRootV1 } from "./composed-reference-game-browser-api";
import { ReferencePipelineSessionError, type WorldInfoStateV1 } from "./reference-pipeline-session";

/**
 * What one mount may bind, and the selection generation its bind CAS carries.
 *
 * The two facts have to name the same selection, because every World Info command is a compare-and-set on
 * both: the generation decides which Chat the change lands on, and `worldInfo.revision` decides what it may
 * overwrite. They used to be answered from two places - a fresh composed root answered the revision while
 * `viewRef.current` answered the generation - so a Chat switched elsewhere produced a command whose revision
 * belonged to the new selection and whose generation named the old one. The Host refused it as a stale
 * generation, which is the truth about the generation and a false statement about the revision; the refusal
 * then re-read the panel onto the new Chat, and the player's next press applied the same edit there without
 * anything saying the target had moved.
 *
 * `selection_generation_conflict` is that second press, made visible: the pair is refused instead of being
 * completed with whichever side is newer. Nothing is sent, the panel says the selected Chat moved, and the
 * player reads again once the shell has adopted it - the selection belongs to the shell (ADR 0009), so a
 * panel may only act on the Chat the shell is showing.
 */
export type WorldInfoBindingSource =
  | Readonly<{
      kind: "mounted";
      /** The mounted Chat's World Info revision, or null when this mount declares no `world-info.read`. */
      worldInfo: WorldInfoStateV1 | null;
      /** The generation of the selection both facts were read from. */
      selectionGeneration: number;
    }>
  | Readonly<{
      kind: "selection_generation_conflict";
      /** The generation of the selection the shell is showing. */
      mountedSelectionGeneration: number;
      /** The generation the root this source was read from names. */
      liveSelectionGeneration: number;
    }>;

/**
 * The source one read of the composed root supports.
 *
 * `mountedSelectionGeneration` is the shell's own - `session.snapshot.selection.generation`, the selection the
 * player is looking at and the one `applySnapshot` holds the session to (`identityFingerprint` includes it).
 * `null` means the shell has no session to bind against, which is a reconciliation failure rather than a
 * generation to guess at; zero is never guessed either, because a live generation is a positive integer.
 */
export function worldInfoBindingSource(
  root: ComposedReferenceGameBrowserRootV1,
  mountedSelectionGeneration: number | null,
): WorldInfoBindingSource {
  if (mountedSelectionGeneration === null) throw new ReferencePipelineSessionError("state_reconciliation_required");
  const liveSelectionGeneration = root.chat.selection?.generation ?? 0;
  if (liveSelectionGeneration !== mountedSelectionGeneration) {
    return {
      kind: "selection_generation_conflict",
      mountedSelectionGeneration,
      liveSelectionGeneration,
    };
  }
  return {
    kind: "mounted",
    worldInfo: root.chat.chat?.worldInfo ?? null,
    selectionGeneration: liveSelectionGeneration,
  };
}
