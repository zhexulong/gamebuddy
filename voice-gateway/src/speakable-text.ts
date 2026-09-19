/**
 * Speakable-text extraction: the voice-layer boundary that turns a character
 * card message into what the TTS should actually say aloud.
 *
 * Character cards (ST v2) conventionally mix dialogue with action beats:
 *
 *   *屏幕亮起微光…她眨了眨眼睛* "啊……你来啦。" *她的语气慢半拍* "需要帮忙吗?"
 *
 * The companion says only the quoted/unmarked dialogue; the *...* action
 * beats are stage direction, not speech. Reading them aloud would make the
 * voice "narrate" the scene. This module strips action beats and keeps the
 * speakable lines, so the voice layer — not the live run or the model — owns
 * the adaptation.
 *
 * Rules:
 *  - A `*...*` span is an action beat and is removed (single asterisks, also
 *    spanning newlines; `**bold**` survives because it is emphasis, not a
 *    beat, and is abbreviated).
 *  - Parenthesised MiMo emotion tags (（轻声）(whisper)) survive: those are
 *    native TTS direction, not narration.
 *  - Everything else (quoted or plain dialogue) is kept.
 *  - Whitespace is collapsed and the result trimmed; a pure-beat input yields
 *    the empty string (nothing to say aloud).
 */
export function extractSpeakableText(input: string): string {
  if (typeof input !== "string" || input.length === 0) return "";
  let text = input.replace(/\*\*[^*]+\*\*/g, (match) => match.slice(2, -2));
  text = text.replace(/\*[^*]+\*/gs, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}