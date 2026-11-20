/**
 * A removal that lands says where the removed words still live.
 *
 * `chat.rewind` and `chat.delete` reach two authorities - `tavern_messages` and the model's own Pi
 * session - and neither of them is the fold. Magic Context summarises the conversation into
 * `compartments` and replays the cached m[0]/m[1] prefix every turn, and nothing in the Host may
 * write that store, so a rewind or a delete over words the fold already summarised leaves the model
 * still reading a summary of them. That is a limit of the operation, not a bug to hide, and the one
 * thing the product must never do is state the opposite
 * (`design/tasks/active/finding-tavern-cut-leaves-folded-history.md`).
 *
 * So this gate holds the player-visible half of that promise:
 *
 *   - the family is DECLARED (`FOLD_REACHING_REMOVAL_KINDS`) and is a real subset of the mutation
 *     kinds, so a kind that joins it is judged by the same rule the moment it is declared rather
 *     than when someone remembers to add a key;
 *   - every locale carries the sentence a landed removal owes, and the sentence names both halves of
 *     the fact - the fold, and the memory the removed words survive in;
 *   - no sentence in that family claims the model has stopped reading the removed words. The
 *     detector is proved against the copy that shipped, so it cannot pass by measuring nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { messages } from "../src/i18n.ts";
import { CHAT_MUTATION_KINDS, FOLD_REACHING_REMOVAL_KINDS } from "../src/components/message-mutation.ts";

const LOCALES = ["en", "zh-CN"];

/** The one sentence a landed removal owes the player, in both catalogues. */
const SENTENCE_KEY = "removedWordsMayStillBeInMemory";

/**
 * The two halves of the fact the sentence must carry: the memory the removed words survive in, and
 * the fact that they may still reach her from it. A locale must name both, or the sentence has been
 * reworded into something that no longer says the thing this gate exists for.
 *
 * It named THE FOLD here until 2026-11-20, and that was the copy defect the owner ruled on: the fold
 * is the module that writes the summary, and a player cannot act on it or find it. The force is the
 * same - the sentence still has to name the memory that survives the removal and to say it still
 * reaches her - and `MUST_NAME` still fails a sentence that drops either half.
 */
const MUST_NAME = {
  en: [/\bmemor/i, /\bmay still\b/i],
  "zh-CN": [/记忆/u, /仍/u],
};

/**
 * Claims that the removed words are gone from the model's own reading. That is the false promise the
 * catalogues made before this gate existed, so the detector is pinned to the exact sentences that
 * shipped rather than to invented ones.
 */
const ABSOLUTE_CLAIMS = [
  /\bstops? (reading|answering|carrying|being)\b/u,
  /\bno longer\b/u,
  /\bforgotten\b/u,
  /\bcompletely\b/u,
  /\bentirely\b/u,
  /不再/u,
  /永远/u,
  /完全/u,
];

function absoluteClaims(text) {
  return ABSOLUTE_CLAIMS.filter((pattern) => pattern.test(text)).map((pattern) => String(pattern));
}

test("removal-memory.1: the declared family is a real, non-empty subset of the mutation kinds", (t) => {
  const declared = new Set(CHAT_MUTATION_KINDS);
  const members = [...FOLD_REACHING_REMOVAL_KINDS];
  assert.equal(new Set(members).size, members.length, "a kind declared twice would be measured twice");
  assert.notEqual(members.length, 0, "BLOCKED: an empty family would make every case below agree with itself");
  for (const kind of members) assert.ok(declared.has(kind), `${kind} is not one of ${CHAT_MUTATION_KINDS.join(", ")}`);
  t.diagnostic(`removal-memory.1: ${members.length} declared removal kind(s) of ${declared.size} mutation kinds`);
});

test("removal-memory.2: both catalogues say where the removed words still live", (t) => {
  const failures = [];
  let checked = 0;
  for (const locale of LOCALES) {
    checked += 1;
    const catalogue = messages(locale);
    const sentence = catalogue[SENTENCE_KEY];
    if (typeof sentence !== "string" || sentence.length === 0) {
      failures.push(`${locale}.${SENTENCE_KEY} is missing; a landed removal would tell the player nothing`);
      continue;
    }
    for (const pattern of MUST_NAME[locale]) {
      if (!pattern.test(sentence))
        failures.push(`${locale}.${SENTENCE_KEY} does not name what ${String(pattern)} requires: ${JSON.stringify(sentence)}`);
    }
    const claims = absoluteClaims(sentence);
    if (claims.length > 0)
      failures.push(`${locale}.${SENTENCE_KEY} claims the removed words are gone from the model: ${claims.join(", ")}`);
  }
  t.diagnostic(`removal-memory.2: ${checked} catalogue(s), ${failures.length} violating sentence(s)`);
  assert.deepEqual(failures, [], "the removal family may only promise what the operation really reaches");
});

test("removal-memory.3 (mutation): the detector reports the copy that shipped", (t) => {
  // The exact strings the product stated before this change: the delete control's name and the
  // contract sentence a rewind's player-facing copy was written from. A detector that did not fire on
  // them would be measuring nothing.
  const shipped = {
    deleteNameEn: "Delete this message: the model stops reading it from the next turn on",
    deleteNameZh: "删除这条消息：从下一轮起模型就不再读它",
    contractEn:
      "the named message is KEPT and every message after it stops being part of the conversation - in the transcript the player reads AND in the model's own session",
    contractZh: "这段对话里，它之后的消息不再属于这段对话，模型自己的会话里也一样",
  };
  for (const [label, text] of Object.entries(shipped)) {
    const claims = absoluteClaims(text);
    assert.ok(claims.length > 0, `${label} must be reported as an absolute claim`);
    t.diagnostic(`removal-memory.3: ${label} reported via ${claims.join(", ")}`);
  }
});
