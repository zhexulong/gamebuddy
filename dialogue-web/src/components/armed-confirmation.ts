import { type KeyboardEvent as ReactKeyboardEvent, type RefObject, useEffect, useRef } from "react";

/**
 * The keyboard path through one armed destructive pair.
 *
 * Arming REPLACES the control that was pressed with the confirmation (MessageBubble's rewind and
 * delete, the world book's row removals), so the element that held focus is unmounted by the very
 * press that armed it. Without this the page drops focus onto `<body>`: a keyboard or screen-reader
 * player loses their place exactly at the moment the product asks them to decide something
 * destructive, and the same loss happens again when the confirmation closes under them.
 *
 * The pair therefore moves focus deliberately, twice:
 *
 *  - ON OPEN, into the confirmation's own cancel answer. It is inside the confirmation, which is
 *    what keeps a Tab from starting over at the top of the page, and it is the SAFE answer: a
 *    stray Enter on a freshly opened confirmation cancels rather than deletes.
 *  - ON CANCEL (`cancel`, or Escape through `onConfirmKeyDown`), back to the control that opened
 *    it, which is remounted by the same render that clears the arm.
 *
 * A pair the player CONFIRMED is deliberately not handled here: what gets focus after the mutation
 * is the mutation's own outcome (the row it removed, the row it kept), not a control this hook has
 * no authority over.
 *
 * Escape is owned at the confirmation rather than on the document: the confirmation holds focus
 * (that is the first half of this hook), so the key reaches it before it reaches the drawer or the
 * shell behind it, and stopping it there is what keeps a dismissal from also closing the surface
 * the confirmation was opened on.
 */
export type ArmedConfirmation = Readonly<{
  /** The control that arms the pair: focus returns here when a cancel closes it. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** The confirmation's cancel answer: focus moves here when the confirmation opens. */
  cancelRef: RefObject<HTMLButtonElement | null>;
  /** Closes the pair and returns focus to the trigger. */
  cancel: () => void;
  /** The confirmation's own Escape handling, put on the element that holds the two answers. */
  onConfirmKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}>;

export function useArmedConfirmation(armed: boolean, onCancel: () => void): ArmedConfirmation {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const wasArmed = useRef(false);
  const returning = useRef(false);
  useEffect(() => {
    if (armed === wasArmed.current) return;
    wasArmed.current = armed;
    if (armed) {
      cancelRef.current?.focus();
      return;
    }
    if (!returning.current) return;
    returning.current = false;
    triggerRef.current?.focus();
  }, [armed]);
  const cancel = (): void => {
    returning.current = true;
    onCancel();
  };
  const onConfirmKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    cancel();
  };
  return { triggerRef, cancelRef, cancel, onConfirmKeyDown };
}
