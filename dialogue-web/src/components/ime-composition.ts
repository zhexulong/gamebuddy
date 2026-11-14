import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * The input method's Enter is not the surface's Enter.
 *
 * A candidate list is confirmed with the same key a text field uses to submit, so a guard on
 * `KeyboardEvent.isComposing` alone is not enough: WebKit (bug 165004) fires the confirming
 * keydown with `isComposing` already false, and the guard then reads a plain Enter and submits
 * the message the player was still composing. The fact that survives every engine is the virtual
 * key code of a key the input method is processing - `VK_PROCESSKEY`, 229 - which the confirming
 * keydown carries on Chromium, Firefox and WebKit alike.
 */
const IME_PROCESSING_KEY_CODE = 229;

/** The two facts every engine offers about a key the first responder is still composing. */
export type ImeKeyFacts = Readonly<{ isComposing?: boolean; keyCode?: number }>;

/** True while the key belongs to the input method rather than to the field it is pressed in. */
export function isImeProcessingKey(event: ImeKeyFacts): boolean {
  return event.isComposing === true || event.keyCode === IME_PROCESSING_KEY_CODE;
}

/**
 * A form's implicit submission is an Enter too - the browser's, not ours - so the guard has to be
 * on the keydown that carries it. `preventDefault` removes that one default action and nothing
 * else: the composition itself is committed by the input method before this keydown is delivered.
 */
export function preventImeFormSubmit(event: ReactKeyboardEvent<HTMLFormElement>): void {
  if (isImeProcessingKey(event.nativeEvent)) event.preventDefault();
}
