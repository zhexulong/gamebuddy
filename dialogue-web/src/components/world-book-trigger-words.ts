/**
 * An entry's trigger words, split from the one field a player types them into.
 *
 * The three comma shapes are accepted because they are the three a player types: `,`, the
 * fullwidth `，` a Chinese keyboard produces, and the ideographic `、` that a Chinese world
 * book's own files carry between keys. A segment is trimmed and an empty one is dropped, so
 * a trailing separator adds no empty trigger.
 */
export function parseTriggerWords(value: string): string[] {
  return value
    .split(/[,，、]/u)
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}
