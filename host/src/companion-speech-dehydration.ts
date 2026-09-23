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
 *    (multi-line allowed), plus explicit bare reasoning frames
 *    (`(thinking)`/`[thought]`/`（思考）`/`【内心】`).
 *  - `*...*` action beats are removed (multi-line allowed); `**...**` markdown
 *    emphasis keeps its content.
 *  - **Inline bracket audio tags are preserved.** Round/full-width/square
 *    brackets carry MiMo V2.5 tone/emotion tags (`（轻声）`, `[pause]`) which the
 *    synthesizer performs instead of speaking, so stripping them would delete
 *    the emotion channel. The Voice lane consumes this text unmodified.
 *  - Markdown `---` separators are removed.
 *  - Isolated punctuation orphaned by a removed beat (`：，`、`，、`、trailing
 *    `，`/`。` before another sentence) is collapsed so no bare separator
 *    survives the strip.
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
  // 1b. Bare reasoning variants: (thinking) / [thinking] / （思考） / 【内心】
  // frames and their bracketed payload; these never belong in the chat box.
  text = text.replace(/\((?:thinking|thought)[\s\S]*?\)/gi, " ");
  text = text.replace(/\[(?:thinking|thought)[\s\S]*?\]/gi, " ");
  text = text.replace(/（(?:思考|内心|脑内)[\s\S]*?）/g, " ");
  text = text.replace(/【(?:思考|内心|脑内)[\s\S]*?】/g, " ");
  // 2. Asterisk action beats (*...* and **...**), possibly spanning lines.
  //    Bold `**x**` is markdown emphasis, not a stage beat — keep its content.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  text = text.replace(/\*[^*]*\*/gs, " ");
  // 3. Inline bracket tags are PRESERVED in the utterance: MiMo V2.5 performs a
  //    sound-related tag (（轻声）/（笑）/[pause]) instead of speaking it, but an
  //    utterance that consists of tags only produces a short meaningless sound —
  //    so `isEmptyAfterDehydration` below treats tag-only text as nothing to
  //    say. Body-action tags (（转身微笑）) are ignored by the synthesizer (and
  //    skew prosody), so the prompt steers the Agent to express those through
  //    the in-game express_emote / face_direction actions instead.
  // 4. Markdown horizontal-rule separators.
  text = text.replace(/^[ \t]*---[ \t]*$/gm, " ");
  // 5. Collapse whitespace and normalize.
  text = text.replace(/\s+/g, " ").trim().normalize("NFC");
  // 6. Isolated punctuation orphaned by a removed beat: a bare leading
  //    conjunction/colon or a doubled separator (`， ，`、`： ，`、`。 ，`)
  //    after stripping must not survive. Keep real sentence punctuation, but
  //    merge any separator sequence followed by a comma/colon pause into one.
  text = text
    // A beat stripped off the very front leaves only a stray comma-class
    // pause before the real dialogue (`，你好。` from `，*笑*，你好。`); eat
    // the whole leading pause run (punctuation + spacing) so the dialogue
    // starts at its first real character.
    .replace(/^[,，、:：;；]+(?:\s*[,，、;；]+)*/, "")
    .replace(/[,，、:：;；]{2,}/g, (match) => (match.includes("。") || match.includes(".") ? "。" : match.includes("?") ? "？" : ","))
    // A colon that introduces stripped content must keep its introduction but
    // drop the stray comma-class pause directly after it (`： ，现在` → `： 现在`).
    .replace(/[：:]\s*[,，、;；]+/g, "： ")
    // Drop stray comma-class punctuation directly before a sentence/stop
    // separator (e.g. `， 。` after a beat was stripped).
    .replace(/[,，、;；]+(?=\s*(?:[。！？!?]|$))/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

/** Bracket tag forms MiMo interprets as audio directions (never spoken). */
const INLINE_TAG_RE = /（[^）]*）|\([^)]*\)|\[[^\]]*\]/g;

/**
 * True when dehydration leaves nothing speakable: either the text collapses to
 * empty, or it consists entirely of bracket tags. A tag-only reply would make
 * the synthesizer emit a short meaningless sound, so it is treated as "nothing
 * to say" — the caller rejects it instead of publishing empty speech.
 */
export function isEmptyAfterDehydration(input: string): boolean {
  const stripped = dehydrateCompanionSpeech(input).replace(INLINE_TAG_RE, " ").replace(/\s+/g, " ").trim();
  return stripped.length === 0;
}