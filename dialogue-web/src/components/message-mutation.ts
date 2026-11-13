import { composedProblemView } from "../composed-problem-view";
import { messages } from "../i18n";
import type { ReadyView, ViewState } from "./composed-reference-game-view";

/**
 * Every message-level mutation this surface can have in flight, and show as busy on its own row.
 *
 * An array because the list is the one authority and has to be enumerable: the request type, the
 * busy projection and the gate that holds this envelope all read this declaration rather than
 * spelling seven literals again.
 */
export const CHAT_MUTATION_KINDS = [
  "swipe",
  "swipeRemove",
  "regenerate",
  "opening",
  "rewind",
  "edit",
  "delete",
] as const;

/** One of them, named. */
export type ChatMutationKind = (typeof CHAT_MUTATION_KINDS)[number];

/** The facts a press sends, taken from the view it was admitted against. */
type MessageMutationAdmission = Readonly<{ selectionGeneration: number; csrfToken: string }>;

/**
 * What one press did, in the three states a caller can tell apart.
 *
 * `refused` is this envelope's own answer - no ready view, no selection, another message mutation
 * already in flight, or the press's own admission declining it. Nothing ran and nothing was said:
 * the sentence on screen belongs to the press that is still going. `failed` carries the answer back
 * so a caller that opened a durable record can settle it. `landed` means the wire took the press
 * AND the authoritative read behind it came back, which is the only state the Host's transcript has
 * been seen to hold.
 */
export type MessageMutationOutcome =
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "landed" }>
  | Readonly<{ kind: "failed"; error: unknown }>;

/** One press: what it is, what it names, what it admits first and what it sends. */
type MessageMutationRequest = Readonly<{
  kind: ChatMutationKind;
  /** The message the press names, as the row rendered it. */
  handle: string;
  /**
   * The press's own admission, run after the guards below and before the latch is taken.
   *
   * Regeneration opens a durable turn here (`beginTurnMutation`); a rewind, a delete and a variant
   * discard spend the arm that asked for their confirmation. Returning `false` abandons the press
   * exactly as a guard does - the latch is not taken, so nothing has to release it.
   */
  before?: (current: ReadyView) => boolean | void;
  /** The press's one wire call, under the selection and token of the view it was admitted against. */
  send: (admission: MessageMutationAdmission) => Promise<unknown>;
}>;

export type MessageMutation = (request: MessageMutationRequest) => Promise<MessageMutationOutcome>;

/**
 * The shell's own seams, handed over once instead of being re-read by seven copies.
 *
 * Every one of them is a fact this module must not own: the view and the latch are the shell's
 * synchronous state (`ref` because an async mutation can never act on a stale render), the reread
 * is the shell's authoritative read, and `beginMessageMutation` is the seam that takes the latch,
 * spends the last refusal and publishes the busy row.
 */
export type MessageMutationInput = Readonly<{
  viewRef: { readonly current: ViewState };
  chatMutationRef: { current: boolean };
  beginMessageMutation: (kind: ChatMutationKind, handle: string) => void;
  rereadChat: () => Promise<void>;
  commit: (next: ViewState) => void;
  setMessageMutationNotice: (sentence: string | null) => void;
  setChatMutation: (mutation: null) => void;
}>;

/**
 * The one envelope every message-level mutation of the composed shell is written through.
 *
 * The swipe, the opening variant, the regenerate, the rewind, the delete, the variant discard and
 * the in-place edit are one sequence around one wire call: the guards, the press's own admission,
 * the latch, the wire call, then the authoritative reread that says what the conversation is. Its
 * rules are not decoration:
 *
 *   - **single flight.** The latch is synchronous and is taken before the await, so a second press
 *     in the same tick cannot issue a second admitted command; it is refused here, and only this
 *     press's own resolution - `finally`, whichever way it ended - clears the latch and spends the
 *     busy row.
 *   - **the refusal is SAID, and said first.** The reread restores the transcript the Host still
 *     holds, so a refusal with nothing said is a press that flickered and reverted while the player
 *     who caused it was told nothing; only a reread that ALSO failed used to reach them, and then it
 *     replaced the whole surface. The sentence goes up before the read runs.
 *   - **the reread is authority.** Nothing here guesses what the Host holds; a press that landed is
 *     reported as landed only after the read behind it returned.
 *
 * Written seven times by hand these were seven copies, and each copy was free to drop one of the
 * three. `handleSend` and `handleStop` are deliberately not callers: neither takes this latch (send
 * is gated by the pending record it publishes, stop belongs to a turn that is already running), and
 * folding them in would change behaviour rather than shape.
 */
export function createMessageMutation(input: MessageMutationInput): MessageMutation {
  return async (request) => {
    const current = input.viewRef.current;
    if (current.kind !== "ready") return { kind: "refused" };
    if (input.chatMutationRef.current) return { kind: "refused" };
    const selection = current.session.snapshot.selection;
    if (selection === null) return { kind: "refused" };
    if (request.before?.(current) === false) return { kind: "refused" };
    input.beginMessageMutation(request.kind, request.handle);
    try {
      await request.send({
        selectionGeneration: selection.generation,
        csrfToken: current.session.snapshot.csrfToken,
      });
      await input.rereadChat();
      return { kind: "landed" };
    } catch (error) {
      // Said before the read, never after it: see the envelope's own note above. The sentence is the
      // catalogue's for the code the Host named, and it is read from the view this press was admitted
      // against, which is the conversation the refusal is about.
      input.setMessageMutationNotice(composedProblemView(error, messages(current.locale)).detail);
      await input.rereadChat().catch(() => {
        // The read behind a refusal could not be taken either, so the projection on screen no longer
        // describes anything the Host confirmed: the problem view is the honest surface, and it names
        // the refusal this read was answering rather than the read's own failure.
        input.commit(composedProblemView(error, messages(current.locale)));
      });
      return { kind: "failed", error };
    } finally {
      input.chatMutationRef.current = false;
      input.setChatMutation(null);
    }
  };
}
