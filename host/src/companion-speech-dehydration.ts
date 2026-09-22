/**
 * Companion speech dehydration: the presentation-layer boundary that turns a
 * model reply into what the in-game chat box should actually show.
 *
 * Character-style replies conventionally mix dialogue with stage direction:
 *
 *   <thinking>玩家在农场西侧</thinking>*转过身微笑* "早安!今天天气真好。"
 *   (轻声)种子我已经帮你种好啦,记得浇水哦。
 *
 * Showing the *...* action beats, (...)-style asides or <thinking> blocks in
 * the native chat box leaks the model's scaffolding into the game UI. This
 * module strips them and keeps the speakable dialogue:
 *
 *  - `<thinking>...</thinking>` / `<thought>...</thought>` blocks are removed
 *    (multi-line allowed).
 *  - `*...*` and `**...**` action beats are removed (multi-line allowed).
 *  - `(...)` parenthesised asides are removed.
 *  - Remaining dialogue is NFC-normalized and whitespace-collapsed.
 *
 * A reply that is pure stage direction dehydrates to the empty string, so the
 * caller rejects it instead of publishing empty text to the game.
 */
export function dehydrateCompanionSpeech(input: string): string {
  if (typeof input !== "string" || input.length === 0) return "";
  let text = input;
  // 1. Reasoning blocks — the model's private scaffolding, never dialogue.
  text = text.replace(/<(?:thinking|thought)>[\s\S]*?<\/(?:thinking|thought)>/gi, " ");
  // 2. Asterisk action beats (*...* and **...**), possibly spanning lines.
  text = text.replace(/\*{1,2}[^*]*\*{1,2}/gs, " ");
  // 3. Parenthesised asides ((轻声)(笑)(smiles)).
  text = text.replace(/\([^)]*\)/g, " ");
  // 4. Collapse whitespace and normalize.
  text = text.replace(/\s+/g, " ").trim().normalize("NFC");
  return text;
}

/** True when dehydration leaves nothing speakable (pure stage direction). */
export function isEmptyAfterDehydration(input: string): boolean {
  return dehydrateCompanionSpeech(input).length === 0;
}