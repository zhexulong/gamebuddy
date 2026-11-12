import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { selectAuthoredContextVolatileSourceRefs } from "./chat-thread-store.js";

/**
 * The trigger boundary, by tier: the rule is decided by what the KEY is, never by the script of the text.
 *
 * The defect this file exists for: the boundary predicate accepted only `[0-9A-Za-z_]` as a word character, so
 * every han character read as "not a word character" and a Chinese key had no boundary test at all. Measured on
 * the shipped matcher, key `茶` fired inside `今天我买了绿茶回家。`.
 *
 * Two candidate rules were measured and rejected before this one:
 *   - a script-class rule ("a han character is a word character") silences the shipped book - 96 of its 98 keys
 *     contain han and 95 are two characters or longer, so `下雨` would fire only beside punctuation or a text
 *     edge, which in continuous Chinese is the rare case;
 *   - pure segment alignment is too strict in the same way one tier up: it dropped `下雨` from
 *     `下雨天坐在门廊上`, because Chinese compounds are compositional (下雨天 = 下雨 + 天) and the segmenter
 *     reads the compound as one word. It also made this product stricter than SillyTavern for Chinese, which is
 *     the one direction a compatibility layer cannot go. `host/src/st-card-import.test.ts:1979` is the witness
 *     that caught it, and it stays unedited.
 *
 * The tiers, and what each is allowed to do:
 *   1. `single_han_character` - `茶`, `锅`: must be a word of its own. Answered by the text's own segmentation.
 *      ACCEPTED COST: which single characters stand alone is the ICU dictionary's answer, not this file's, so no
 *      test here may pin a segment list; a dictionary release that joins `喝茶` would stop `茶` firing there.
 *   2. `han_word` - `下雨`, `绿茶`, `鹈鹕镇`: a literal substring, with no han-side boundary. ACCEPTED COST: a
 *      two-character key can fire inside an unrelated longer word, and it does so by design.
 *   3. `ascii_boundary` - `cat`, `SVE茶`, a phrase: ASCII word characters bound it, exactly as before the tiers.
 */

const CONTENT = "trigger boundary probe body";
const HASH = createHash("sha256").update(CONTENT).digest("hex");

/**
 * The Host directory this test is compiled BELOW, found rather than assumed: the gate reads production source and
 * the shipped book, and a hard-coded relative hop would silently read nothing wherever the test runs from.
 */
function findHostRoot(startDirectory: string): string {
  for (let directory = startDirectory; ; ) {
    if (existsSync(join(directory, "tsconfig.json")) && existsSync(resolve(directory, "..", "integrations")))
      return directory;
    const parent = resolve(directory, "..");
    if (parent === directory)
      throw new Error(`host_root_not_found: walking up from ${startDirectory} for a directory beside "integrations/"`);
    directory = parent;
  }
}

const HOST_ROOT = findHostRoot(import.meta.dirname);
const SOURCE = join(HOST_ROOT, "src", "tavern", "chat-thread-store.ts");
const SHIPPED_BOOK = join(HOST_ROOT, "..", "assets", "tavern", "presets", "default-companion", "worldbook.json");

function candidate(selectionKeys: readonly string[], secondaryKeys?: readonly string[]) {
  return {
    sourceId: "world-info_entry_1",
    kind: "lorebook_entry" as const,
    revision: "1",
    canonicalHash: HASH,
    totalOrderKey: "0001",
    provenance: "world-info/revision/1",
    content: CONTENT,
    budgetTokens: 1,
    selectionKeys,
    ...(secondaryKeys === undefined ? {} : { secondaryKeys, selectiveLogic: 0 as const }),
  };
}

/** The decision the selector makes for one key, with the text as the accepted player text. */
function fires(corpus: string, key: string): boolean {
  return selectAuthoredContextVolatileSourceRefs(corpus, "", [candidate([key])]).refs.length === 1;
}

const SECONDARY_PROBE = "\nprobe";

/**
 * The same decision with the key supplied as a SECONDARY key: both matchers must ask one rule.
 *
 * The probe line is appended so a primary key always fires: with the primary unsatisfied the entry is skipped before
 * the secondary rule is ever read, and a comparison of two `false`s would prove nothing.
 */
function firesAsSecondary(corpus: string, key: string): boolean {
  return (
    selectAuthoredContextVolatileSourceRefs(`${corpus}${SECONDARY_PROBE}`, "", [candidate(["probe"], [key])]).refs
      .length === 1
  );
}

const HAN_WORD = /^\p{Script=Han}{2,}$/u;
const SINGLE_HAN_CHARACTER = /^\p{Script=Han}$/u;

function shippedKeys(): readonly string[] {
  const book = JSON.parse(readFileSync(SHIPPED_BOOK, "utf8")) as {
    entries?: ReadonlyArray<Readonly<{ keys?: readonly string[]; keywords?: readonly string[] }>>;
  };
  const keys = new Set<string>();
  for (const entry of book.entries ?? []) for (const key of entry.keys ?? entry.keywords ?? []) keys.add(key);
  return Object.freeze([...keys]);
}

test("tier 1 - a single han character is a word of its own, never part of a longer one", () => {
  for (const [key, corpus] of [
    ["茶", "今天我买了绿茶回家。"],
    ["茶", "他泡了一壶红茶。"],
    ["锅", "她洗了火锅。"],
  ] as const) {
    assert.equal(
      fires(corpus, key),
      false,
      `key "${key}" must not fire inside "${corpus}": it is part of another word`,
    );
  }
  // Delimited occurrences do fire. Both carriers delimit the character with punctuation or whitespace, so
  // neither assertion depends on which single characters a dictionary release happens to treat as words.
  for (const [key, corpus] of [
    ["茶", "老板，茶，再来一壶。"],
    ["茶", "来杯 茶 吧"],
    ["茶", "茶"],
    ["锅", "锅，先别动。"],
  ] as const) {
    assert.equal(fires(corpus, key), true, `key "${key}" must fire inside "${corpus}": it stands as its own word`);
  }
});

test("tier 2 - a multi-character han key is a substring, inside a longer word included", () => {
  for (const [key, corpus] of [
    ["下雨", "下雨天坐在门廊上"],
    ["下雨", "今天下雨了"],
    ["下雨", "天色阴了，看来要下雨"],
    ["绿茶", "今天喝绿茶"],
    ["农场", "我们的农场今年收成不错"],
    ["鹈鹕镇", "他刚搬到鹈鹕镇"],
    // ACCEPTED COST, pinned so nobody "fixes" it back into a boundary rule: 农场主 is a longer, different
    // word whose first two characters are the key. The entry belongs in this turn - the player is talking
    // about the farm and its owner.
    ["农场", "农场主来了"],
  ] as const) {
    assert.equal(fires(corpus, key), true, `key "${key}" must fire inside "${corpus}": a han key is a substring`);
  }
  assert.equal(fires("今天喝红茶", "绿茶"), false, "a key that does not occur at all still does not fire");
});

test("tier 3 - an ASCII word boundary answers every key that is not pure han", () => {
  assert.equal(fires("concatenate the two strings", "cat"), false);
  assert.equal(fires("bobcat on the ridge", "cat"), false);
  assert.equal(fires("cats and dogs", "cat"), false);
  assert.equal(fires("the cat sat on the step", "cat"), true);
  assert.equal(fires("the cat's bowl", "cat"), true);
  assert.equal(fires("cat-themed umbrella", "cat"), true);

  assert.equal(fires("the moon festival starts tonight", "moon festival"), true);
  assert.equal(fires("the moon festivals merged", "moon festival"), false);
  assert.equal(fires("a honeymoon festival", "moon festival"), false);

  // A mixed key is tier 3, so it is bounded by ASCII word characters ONLY. That is exactly what it did before
  // these tiers existed, and it is stated here rather than left to inference:
  //   - han neighbours are not ASCII word characters, so they do not block it;
  //   - an ASCII letter beside it does.
  assert.equal(fires("我装了SVE茶包。", "SVE茶"), true, "a han neighbour is not an ASCII word character");
  assert.equal(fires("我装了 SVE茶 整合包。", "SVE茶"), true);
  assert.equal(fires("我装了xSVE茶包。", "SVE茶"), false, "an ASCII letter beside the key does block it");
  assert.equal(fires("我在玩茶Farm这个整合包。", "茶Farm"), true);
  assert.equal(fires("我在玩茶Farms整合包。", "茶Farm"), false, "a trailing ASCII letter is not a boundary");
});

test("all of ASCII keeps the boundary it had before the han tiers existed", () => {
  const ASCII_WORD = /^[0-9A-Za-z_]$/u;
  for (let code = 0; code <= 0x7f; code++) {
    const character = String.fromCharCode(code);
    const expected = !ASCII_WORD.test(character);
    assert.equal(
      fires(`${character}cat${character}`, "cat"),
      expected,
      `"${JSON.stringify(character)}" (U+${code.toString(16).padStart(2, "0").toUpperCase()}) ` +
        `must be ${expected ? "a boundary" : "a word character"} for an English trigger, as it always was`,
    );
  }
});

test("a key's decision does not depend on which side of the entry it was supplied", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["茶", "今天我买了绿茶回家。"],
    ["茶", "老板，茶，再来一壶。"],
    ["下雨", "下雨天坐在门廊上"],
    ["农场", "农场主来了"],
    ["茶Farm", "我在玩茶Farm这个整合包。"],
    ["SVE茶", "我装了SVE茶包。"],
    ["cat", "concatenate the two strings"],
    ["cat", "the cat sat"],
  ];
  for (const [key, corpus] of cases) {
    assert.equal(
      fires(`${corpus}${SECONDARY_PROBE}`, "probe"),
      true,
      `fixture: the primary key "probe" must fire in "${corpus}${SECONDARY_PROBE}" for the secondary decision to exist`,
    );
    assert.equal(
      firesAsSecondary(corpus, key),
      fires(corpus, key),
      `key "${key}" in "${corpus}": the secondary matcher and the primary matcher must ask the same boundary rule`,
    );
  }
});

/**
 * A carrier in which a shipped single-character key appears only as PART of a longer word. The population is the
 * book's own keys, so a book that starts shipping another single character fails loudly here instead of silently
 * dropping the witness - and the failure says which key needs one.
 */
const WORD_THAT_CONTAINS_KEY: Readonly<Record<string, string>> = Object.freeze({ 锅: "她洗了火锅。" });

/**
 * The assertion the rejected rules failed.
 *
 * Reading the shipped book rather than a list written here is the point: the population is the product's own
 * content, so a rule that silences a key fails by naming it. Measured on the shipped book: 97 keys, every one of them a
 * multi-character han word, and all of them firing in the carrier. The book carried exactly one single han character
 * (`锅`) until `f731fbb9` dropped that key, so that tier's shipped witness is gone; the tier's own rule is pinned by the
 * tier cases above, and any single character the book ships again is checked by the loop below.
 */
test("every han key the shipped book carries behaves as its own tier requires", () => {
  const keys = shippedKeys();
  assert.ok(keys.length > 0, `examined 0 keys in ${SHIPPED_BOOK}: an empty population is a blocked reading`);

  const hanWords = keys.filter((key) => HAN_WORD.test(key));
  const singleCharacters = keys.filter((key) => SINGLE_HAN_CHARACTER.test(key));
  assert.ok(hanWords.length > 0, "examined 0 multi-character han keys: the population did not load");
  // How many keys land in the single-character tier is the book's own content, so it is measured and printed rather
  // than required: the tier's shipped witness (`锅`) left the book on 2026-11-12, and requiring one back would be this
  // file pinning content it does not own. The rule itself is pinned by the tier cases above, and the loop below refuses
  // a single-character key the book ships without a carrier - which is where a returning one fails loudly.
  console.log(
    `shipped book keys: ${String(keys.length)} examined, ${String(hanWords.length)} multi-character han, ` +
      `${String(singleCharacters.length)} single han character`,
  );

  const silenced = hanWords.filter((key) => !fires(`我们聊聊${key}吧`, key));
  assert.deepEqual(
    silenced,
    [],
    `${silenced.length}/${hanWords.length} shipped keys stopped firing inside their own carrier sentence: ` +
      `${silenced.join("、")} - a boundary rule that is not a word rule for this language does that`,
  );

  for (const key of singleCharacters) {
    const carrier = WORD_THAT_CONTAINS_KEY[key];
    assert.ok(
      carrier !== undefined,
      `shipped single-character key "${key}" has no carrier in which it is part of another word: add one to ` +
        "WORD_THAT_CONTAINS_KEY, because this tier's whole contract is that it must not fire there",
    );
    assert.equal(
      fires(carrier, key),
      false,
      `key "${key}" must not fire inside "${carrier}": it is part of another word`,
    );
    assert.equal(
      fires(`老板，${key}，先放着。`, key),
      true,
      `shipped single-character key "${key}" must fire when it stands as its own word`,
    );
  }
});

/**
 * The gate. Its population is the source file, so a second boundary rule added later is red the moment it exists and
 * the failure names the line that introduced it. It also asserts that the tiers are named cases of ONE predicate: the
 * union declaration is the authority, and every member it declares must be a `case` of that predicate.
 */
test("three tiers, one predicate, one segmenter, no character-code shortcut", () => {
  const source = readFileSync(SOURCE, "utf8");
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  const where = (index: number) => `chat-thread-store.ts:${lineOf(index)}`;

  const union = /type TriggerKeyTier = ([^;]+);/u.exec(source);
  assert.ok(union, "the tier union is the population this gate reads, and it is gone");
  const tiers = [...union[1]!.matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]!);
  assert.deepEqual(
    [...tiers].sort(),
    ["ascii_boundary", "han_word", "single_han_character"],
    "the tier names changed; every name below is asserted to be a case of the one predicate",
  );

  const predicates = [...source.matchAll(/function\s+triggerKeyMatches\s*\(/gu)];
  assert.equal(predicates.length, 1, `expected exactly one trigger predicate, found ${predicates.length}`);
  const predicateStart = predicates[0]!.index!;
  const predicateEnd = source.indexOf("\n}\n", predicateStart);
  assert.ok(predicateEnd > predicateStart, "could not delimit the body of triggerKeyMatches");

  const classifiers = [...source.matchAll(/function\s+triggerKeyTier\s*\(/gu)];
  assert.equal(classifiers.length, 1, "exactly one classifier decides a key's tier");
  const classifierCalls = [...source.matchAll(/triggerKeyTier\(/gu)];
  assert.equal(
    classifierCalls.length,
    2,
    `the tier classifier must be defined once and called once, found ${classifierCalls.map((m) => where(m.index!)).join(", ")}`,
  );

  for (const tier of tiers) {
    const cases = [...source.matchAll(new RegExp(`case "${tier}":`, "gu"))];
    assert.equal(cases.length, 1, `tier "${tier}" must be exactly one case, found ${cases.length}`);
    assert.ok(
      cases[0]!.index! > predicateStart && cases[0]!.index! < predicateEnd,
      `tier "${tier}" is a case outside ${"triggerKeyMatches"}: a tier that is not a case of the one predicate is a second rule`,
    );
  }

  const segmenters = [...source.matchAll(/new Intl\.Segmenter\(\s*([^,)]*)/gu)];
  assert.equal(
    segmenters.length,
    1,
    `expected exactly one segmenter, found ${segmenters.map((m) => where(m.index!)).join(", ") || "none"}`,
  );
  assert.match(
    segmenters[0]![1]!.trim(),
    /^"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*"$/u,
    `${where(segmenters[0]!.index!)} must name its locale as a string literal, got ${segmenters[0]![1]!.trim()}: ` +
      "an ambient locale makes matching depend on the machine's regional settings",
  );

  // A regex literal is the only other place a character classification can live. The population is the literals
  // that decide whether a character is part of a WORD - the general categories a word is built from, a script, and
  // `\w` - because that is the question a boundary asks. A validity check on a whole string (`/\p{Cc}/` for a
  // title, say) answers a different question and is not a second boundary rule.
  const literals = [...source.matchAll(/\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/gu)];
  const wordClassLiterals = literals.filter((match) =>
    /\\p\{L\}|\\p\{N\}|\\p\{Pc\}|\\p\{Script|\\p\{Han\}|\[0-9A-Za-z_\]|\[A-Za-z0-9_\]|\[a-zA-Z0-9_\]|\\w/u.test(
      match[0],
    ),
  );
  assert.ok(wordClassLiterals.length >= 2, "examined fewer than two word-class literals: the scan is wrong");
  for (const literal of wordClassLiterals) {
    assert.ok(
      literal.index! >= union.index! && literal.index! < predicateEnd,
      `${where(literal.index!)} classifies a character with ${literal[0]} outside the tier rule: a second ` +
        "definition of a boundary drifts from the one every matcher asks",
    );
  }

  for (const shortcut of [...source.matchAll(/charCodeAt|codePointAt/gu)]) {
    assert.fail(
      `${where(shortcut.index!)} decides a boundary from a character code: a character's word-ness is the tier ` +
        "rule's single answer, never a numeric range written beside it",
    );
  }

  for (const borrowed of literals.filter((match) => /\\b/u.test(match[0]))) {
    assert.fail(
      `${where(borrowed.index!)} borrows a regex \\b word boundary (${borrowed[0]}): it forms none inside CJK, ` +
        "so it cannot be the rule a Chinese key is judged by",
    );
  }
});
