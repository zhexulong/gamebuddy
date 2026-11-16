import assert from "node:assert/strict";

/**
 * A fact block reports; it does not instruct. One detector for that property, because two suites read it: the vocabulary's
 * way-forward labels and rectangle answers, and `fact-brief`'s own world-state note.
 *
 * <p>
 * The closed classes are what separates a report from an order: `重试可行` states a feasibility and `retry now` sets a
 * moment she is told to act on — the same claim, one of them as a command. A block that says `没读到的格子...没有人回答`
 * reports the third zero; the sentence that shipped beside it (`别当成空地`) was that fact said a second way, as an order.
 * The heads are a closed class because `别处` and `别提` are not commands.
 * </p>
 */
export const COMMAND_HEAD = new RegExp(
  [
    String.raw`(?:^|[。！？：；，、\n])\s*(?:先|请|务必|记得|别(?!处|人|的|提|再)|不要|不必|只能|应当|应该|一定要|记住)`,
    String.raw`(?:^|[.;:!?]\s+|\n)\s*(?:do not|don't|never|always|make sure|remember|please|only)\b`,
    String.raw`\b(?:now|immediately|right away|at once)\b`,
  ].join("|"),
  "iu",
);

/**
 * The property: a fact block states what it read and stops there. Throwing here is what makes the guard its own
 * falsifier — the sentences this repo shipped are fed to it by the suites that use it.
 */
export function assertReportsWithoutInstructing(text: string, what: string): void {
  assert.equal(COMMAND_HEAD.test(text), false, `${what} reports; this one instructs: ${text}`);
  assert.ok(text.trim().length > 0, `an empty ${what} states nothing at all`);
}
