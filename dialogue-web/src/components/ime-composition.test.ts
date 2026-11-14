import assert from "node:assert/strict";
import test from "node:test";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { isImeProcessingKey, preventImeFormSubmit } from "./ime-composition";

/**
 * The pair of facts a keydown carries when the input method, not the player, is the one pressing.
 *
 * A candidate list is confirmed with the key a text field uses to submit, so the guard has to
 * answer for two orderings. Chromium and Firefox deliver the confirming keydown while the
 * composition is still open (`isComposing` true). WebKit (bug 165004) delivers the same keydown
 * with `isComposing` already false, and only the virtual key code `VK_PROCESSKEY` (229) still says
 * the input method handled the key - which is the case a guard on `isComposing` alone gets wrong.
 *
 * Every assertion names one of the two orderings or a shape that must stay a plain Enter, because
 * the defect being prevented is a message sent mid-composition: the field is not a general key
 * filter, and a guard that refuses ordinary Enters would break sending for everyone else.
 */

test("a key the input method is still composing is never the field's Enter", () => {
  assert.equal(isImeProcessingKey({ isComposing: true, keyCode: 229 }), true, "the Chromium ordering");
  assert.equal(isImeProcessingKey({ isComposing: true, keyCode: 13 }), true, "composition, reported key");
  assert.equal(
    isImeProcessingKey({ isComposing: false, keyCode: 229 }),
    true,
    "the WebKit ordering that isComposing alone misses",
  );
});

test("a plain Enter stays a plain Enter", () => {
  assert.equal(isImeProcessingKey({ isComposing: false, keyCode: 13 }), false, "a real Enter");
  assert.equal(isImeProcessingKey({ isComposing: false, keyCode: 0 }), false, "an engine that reports no code");
  assert.equal(isImeProcessingKey({}), false, "a key event with neither fact");
});

test("a form's implicit submission is suppressed only while the input method owns the key", () => {
  const submitted = (facts: Readonly<{ isComposing?: boolean; keyCode?: number }>): boolean => {
    let prevented = false;
    const event = {
      nativeEvent: facts,
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as ReactKeyboardEvent<HTMLFormElement>;
    preventImeFormSubmit(event);
    return !prevented;
  };
  assert.equal(submitted({ isComposing: false, keyCode: 229 }), false, "the Safari ordering must not submit");
  assert.equal(submitted({ isComposing: true, keyCode: 13 }), false, "composition must not submit");
  assert.equal(submitted({ isComposing: false, keyCode: 13 }), true, "a real Enter still submits");
});
