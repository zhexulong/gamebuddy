import type { DestinationIndexResult, DestinationIndexRow, NavigationReadResult } from "./protocol.js";

/**
 * `find_destination`, answered in the Host from the names the Mod publishes.
 *
 * <p>
 * WHY IT LIVES HERE. Searching a destination needs no game thread, no engine object and no world state - it is text
 * matching over a name list - so by `design/adr/0014-thin-stardew-mod.md` it is Host business, and the Mod publishes the
 * names it alone can read (`DestinationIndexPublication`). What follows is the Mod's own matcher, moved rather than
 * redesigned: the same normalization, the same tokenization, the same field weights, the same recall floor and the same
 * refusal vocabulary, so that every query the Mod answered is answered the same way and every query it refused is still
 * refused. The one thing that is new is where the ORDER comes from (see `PUBLICATION_ORDER`).
 * </p>
 *
 * <p>
 * WHAT IT MUST NOT DO. It never exposes a score, never turns a fuzzy match into an automatic destination choice, and never
 * invents a place: a query no published name covers is `not_found`, which is a different fact from "the nearest
 * neighbouring place". A query the wire cannot mean (`''`, a path, a digit) is `destination_search_invalid`.
 * </p>
 */

const MAXIMUM_CANDIDATES = 3;
const MAXIMUM_QUERY_RUNES = 128;

/**
 * Fuzzy candidates must score within 25% of the best candidate, so a near-tie is offered as a set rather than as one
 * arbitrary winner. This is a tie-collapse over the destinations the index already recalled, NOT a judgement that the
 * winner is the place the caller named: a margin cannot make an unrelated place plausible, and lowering or raising it
 * cannot make a query answer the place it asked for. What a candidate has to be is decided by the word floor
 * (`MINIMUM_QUERY_WORD_COVERAGE`) before this ratio ever applies.
 */
const AMBIGUOUS_SCORE_RATIO_MARGIN = 0.25;

/**
 * Field weights: the canonical label is the strongest signal, then the residents that live there, then what is bought or
 * done there, then name variants, and last the weaker fallback-locale and area labels. These are RANKING, so they are the
 * Host's; the Mod publishes the fields, never how much one is worth.
 */
const CANONICAL_LABEL_WEIGHT = 10.0;
const RELATED_NPC_WEIGHT = 5.0;
const SERVICE_TERM_WEIGHT = 3.0;
const ALIAS_WEIGHT = 2.0;
const FALLBACK_LOCALE_WEIGHT = 1.5;
const AREA_LABEL_WEIGHT = 1.0;

/** A complete CJK bigram hit is a precision signal, so it counts double. */
const CJK_BIGRAM_BOOST = 2.0;

/** BM25 term-frequency saturation (k1). */
const TERM_FREQUENCY_SATURATION = 1.2;

/** Latin words are not indexed as prefixes below this length. */
const MINIMUM_LATIN_PREFIX_LENGTH = 2;

/**
 * A destination must be recalled by at least half of the query's WORDS that the directory holds anywhere - a CJK bigram
 * or a latin word, never a lone CJK character. A query is asked in words, and one shared character is not evidence of a
 * place.
 *
 * <p>
 * MEASURED `round77`: `find_destination("矿洞")` and `find_destination("矿洞入口 Mine entrance")` both answered
 * `乔迪，肯特和山姆的家` and nothing else. The directory's own names for the mine are 矿井 / "Mines", and 矿洞 is the word
 * the Host's own world-state vocabulary prints for the mine entrance, so no destination declares it. The retired floor
 * measured the query's idf MASS and only over the tokens the directory happened to hold: 矿 is held by the mine and by
 * 煤矿森林, 洞 only by that villager's house (its residents sell the cave carrot at the Desert Festival), and the rarer
 * token's larger idf let the house cover "half the query's mass" while both places whose own names hold 矿 covered less
 * than half and were zeroed. The house was then the only candidate left. A word-shaped floor cannot do that: 矿洞 is a
 * word nothing holds, so the query is refused instead of answered with a neighbour.
 * </p>
 */
const MINIMUM_QUERY_WORD_COVERAGE = 0.5;

/**
 * THE TIE-BREAK, AND WHY IT IS NOT A NEW PRODUCT DECISION.
 *
 * The Mod ordered candidates by score, then by canonical label, then by canonical identity, all ordinally. Identity is
 * private and is not published, so what the Host has instead is the PUBLICATION ORDER: `DerivedDestinationSet` sorts its
 * directory by exactly that pair before publishing it, so a row's position IS its (label, identity) rank. Ordering equal
 * scores by label and then by position therefore reproduces the Mod's order member for member - it is the same order,
 * carried by a different key, not a re-chosen one. Positions are read from the list the Mod sent, never from the Host's
 * own sorting of it.
 */
type SearchTokenKind = "latin" | "cjk_unigram" | "cjk_bigram";

type SearchToken = Readonly<{ text: string; kind: SearchTokenKind }>;

type PostingList = Readonly<{
  inverseDocumentFrequency: number;
  destinations: readonly number[];
  weightedFrequencies: readonly number[];
}>;

type PublishedIndex = Extract<DestinationIndexResult, { status: "index" }>;

/**
 * Splits search text into the tokens the index is keyed by. Normalization is idempotent: case, width and separator runs
 * are folded once, so already-normalized text can be re-tokenized safely.
 */
function normalizeText(value: string): string {
  let normalized = "";
  let pendingSpace = false;
  for (const character of value.normalize("NFKC").toLowerCase()) {
    if (isSeparator(character)) {
      if (normalized.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      normalized += " ";
      pendingSpace = false;
    }
    normalized += character;
  }
  return normalized.trim();
}

function isSeparator(character: string): boolean {
  return /[\s\p{Pc}\p{Pd}\p{Po}]/u.test(character);
}

/**
 * CJK text is written without word separators, so it is tokenized as single characters plus adjacent character pairs;
 * every other letter or digit run becomes one lower-case latin word. Anything else separates runs.
 */
function tokenize(text: string): readonly SearchToken[] {
  const tokens: SearchToken[] = [];
  const normalized = normalizeText(text);
  if (normalized.length === 0) return tokens;
  let latinRun = "";
  let cjkRun: string[] = [];
  const flushLatin = (): void => {
    if (latinRun.length === 0) return;
    tokens.push({ text: latinRun, kind: "latin" });
    latinRun = "";
  };
  const flushCjk = (): void => {
    if (cjkRun.length === 0) return;
    for (const character of cjkRun) tokens.push({ text: character, kind: "cjk_unigram" });
    for (let index = 0; index + 1 < cjkRun.length; index += 1)
      tokens.push({ text: cjkRun[index]! + cjkRun[index + 1]!, kind: "cjk_bigram" });
    cjkRun = [];
  };
  for (const character of normalized) {
    if (isCjk(character)) {
      flushLatin();
      cjkRun.push(character);
      continue;
    }
    if (/^[\p{L}\p{N}]$/u.test(character)) {
      flushCjk();
      latinRun += character;
      continue;
    }
    flushLatin();
    flushCjk();
  }
  flushLatin();
  flushCjk();
  return tokens;
}

function isCjk(character: string): boolean {
  const value = character.codePointAt(0) ?? 0;
  return (
    (value >= 0x3005 && value <= 0x3007) || // iteration marks within CJK symbols
    (value >= 0x3040 && value <= 0x30ff) || // Hiragana + Katakana
    (value >= 0x3400 && value <= 0x4dbf) || // CJK Unified Ideographs Extension A
    (value >= 0x4e00 && value <= 0x9fff) || // CJK Unified Ideographs
    (value >= 0xac00 && value <= 0xd7af) || // Hangul Syllables
    (value >= 0xf900 && value <= 0xfaff) || // CJK Compatibility Ideographs
    (value >= 0x20000 && value <= 0x2fa1f) // CJK Unified Ideographs Extensions B-F
  );
}

/**
 * Keys one token contributes. A latin word is also keyed under every prefix of at least two runes, which is what lets
 * the partial word "min" recall "Mine", "Mines", "Minecart" and "Mining Guild"; the per-key idf keeps such short prefixes
 * from dominating a result.
 */
function indexKeys(token: SearchToken): readonly string[] {
  const keys: string[] = [token.text];
  if (token.kind !== "latin") return keys;
  const runes = [...token.text];
  let prefix = "";
  for (let index = 0; index + 1 < runes.length; index += 1) {
    prefix += runes[index]!;
    if (index + 1 >= MINIMUM_LATIN_PREFIX_LENGTH) keys.push(prefix);
  }
  return keys;
}

/** Builds the inverted index for one publication. An empty directory yields an empty index that scores everything zero. */
function buildIndex(destinations: readonly DestinationIndexRow[]): ReadonlyMap<string, PostingList> {
  const recalled = new Map<string, { destination: number; weightedFrequency: number }[]>();
  destinations.forEach((destination, at) => {
    for (const [key, weightedFrequency] of weightedTerms(destination))
      appendTo(recalled, key, { destination: at, weightedFrequency });
  });
  const postings = new Map<string, PostingList>();
  for (const [key, entries] of recalled) {
    postings.set(key, {
      inverseDocumentFrequency: Math.log(
        1.0 + (destinations.length - entries.length + 0.5) / (entries.length + 0.5),
      ),
      destinations: entries.map((entry) => entry.destination),
      weightedFrequencies: entries.map((entry) => entry.weightedFrequency),
    });
  }
  return postings;
}

function appendTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else existing.push(value);
}

/** Every term one destination is keyed by, already weighted by the field it came from. */
function weightedTerms(destination: DestinationIndexRow): ReadonlyMap<string, number> {
  const terms = new Map<string, number>();
  addField(terms, CANONICAL_LABEL_WEIGHT, [destination.label]);
  addField(terms, RELATED_NPC_WEIGHT, destination.relatedNpcs);
  addField(terms, SERVICE_TERM_WEIGHT, destination.serviceTerms);
  addField(terms, ALIAS_WEIGHT, destination.aliases);
  addField(terms, FALLBACK_LOCALE_WEIGHT, [destination.fallbackLabel]);
  addField(terms, AREA_LABEL_WEIGHT, [destination.contextLabel]);
  return terms;
}

function addField(terms: Map<string, number>, fieldWeight: number, texts: readonly (string | null)[]): void {
  const frequencies = new Map<string, number>();
  for (const text of texts) {
    if (text === null) continue;
    for (const token of tokenize(text))
      for (const key of indexKeys(token)) frequencies.set(key, (frequencies.get(key) ?? 0) + 1);
  }
  for (const [key, frequency] of frequencies) {
    const saturated = (frequency * (TERM_FREQUENCY_SATURATION + 1.0)) / (frequency + TERM_FREQUENCY_SATURATION);
    terms.set(key, (terms.get(key) ?? 0) + fieldWeight * saturated);
  }
}

/**
 * Scores one normalized query against every destination, aligned with the publication order. A destination that cannot be
 * recalled, that covers less than half of the query's words, or that is scored against an empty query scores exactly
 * zero.
 */
function scoreAll(
  count: number,
  postings: ReadonlyMap<string, PostingList>,
  normalizedQuery: string,
): readonly number[] {
  const scores = new Array<number>(count).fill(0);
  if (count === 0) return scores;

  const tokens = tokenize(normalizedQuery);
  if (tokens.length === 0) return scores;

  const askedInWords = tokens.some((token) => token.kind !== "cjk_unigram");
  const coveredWords = new Array<number>(count).fill(0);
  const visited = new Set<string>();
  let queryWords = 0;
  for (const token of tokens) {
    if (visited.has(token.text)) continue;
    visited.add(token.text);
    const posting = postings.get(token.text);
    if (posting === undefined) continue;
    // A CJK character is part of a word, not a word of its own: it orders candidates, and counts towards the floor only
    // when the query carries nothing word-shaped to be matched on.
    const isWord = !askedInWords || token.kind !== "cjk_unigram";
    if (isWord) queryWords += 1;
    const mass = posting.inverseDocumentFrequency * (token.kind === "cjk_bigram" ? CJK_BIGRAM_BOOST : 1.0);
    for (let entry = 0; entry < posting.destinations.length; entry += 1) {
      const destination = posting.destinations[entry]!;
      scores[destination] = scores[destination]! + mass * posting.weightedFrequencies[entry]!;
      if (isWord) coveredWords[destination] = coveredWords[destination]! + 1;
    }
  }

  // Not one word of the query is a word this directory holds: the query names nothing this world can answer, which is a
  // different fact from "the nearest neighbouring place", and the only honest answer is that no such place exists.
  if (queryWords === 0) return new Array<number>(count).fill(0);

  const requiredWords = Math.ceil(queryWords * MINIMUM_QUERY_WORD_COVERAGE);
  for (let destination = 0; destination < scores.length; destination += 1)
    if (coveredWords[destination]! < requiredWords) scores[destination] = 0;
  return scores;
}

/**
 * Answers one destination query the way the Mod used to answer it, from the names the Mod published.
 *
 * The four answers are the same four facts the Mod reported: the one place the query names (`resolved`), the places it
 * could mean (`candidates`, at most three, never ordered by anything a caller sees), no such place (`not_found`), and a
 * query that is not a place name at all (`invalid`). `generation` is not read here on purpose: it names the publication
 * the rows came from, and the rows themselves are what the matching uses.
 */
export function findDestination(index: PublishedIndex, query: string | null): NavigationReadResult {
  const normalizedQuery = normalizeQuery(query);
  if (normalizedQuery === null) return invalidResult();

  const destinations = index.destinations;
  const exactCurrent: number[] = [];
  const exactFallback: number[] = [];
  const exactAlias: number[] = [];
  destinations.forEach((destination, at) => {
    if (normalizeText(destination.label) === normalizedQuery) exactCurrent.push(at);
    if (destination.fallbackLabel !== null && normalizeText(destination.fallbackLabel) === normalizedQuery)
      exactFallback.push(at);
    if (destination.aliases.some((alias) => normalizeText(alias) === normalizedQuery)) exactAlias.push(at);
  });
  const exact = distinctByRef(destinations, [...exactCurrent, ...exactFallback, ...exactAlias]);

  if (exact.length > 1)
    return candidatesResult(
      "ambiguous_exact",
      exact.slice(0, MAXIMUM_CANDIDATES).map((at) => toCandidate(destinations, at, true)),
    );
  if (exactCurrent.length === 1)
    return resolvedResult("exact_current_locale", toCandidate(destinations, exactCurrent[0]!, false));
  if (exactFallback.length === 1)
    return resolvedResult("exact_fallback_locale", toCandidate(destinations, exactFallback[0]!, false));
  if (exactAlias.length === 1) return resolvedResult("exact_alias", toCandidate(destinations, exactAlias[0]!, true));

  const scores = scoreAll(destinations.length, buildIndex(destinations), normalizedQuery);
  const fuzzy = destinations
    .map((destination, at) => ({ at, label: destination.label, score: at < scores.length ? scores[at]! : 0 }))
    .filter((match) => match.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || compareOrdinal(left.label, right.label) || left.at - right.at,
    );
  if (fuzzy.length === 0) return notFoundResult();

  const cutoff = fuzzy[0]!.score * (1.0 - AMBIGUOUS_SCORE_RATIO_MARGIN);
  const candidates = fuzzy
    .filter((match) => match.score >= cutoff)
    .slice(0, MAXIMUM_CANDIDATES)
    .map((match) => toCandidate(destinations, match.at, true));
  return candidatesResult("fuzzy_match", candidates);
}

/**
 * The exact arm's union, in publication order, one row per destination handle.
 *
 * The Mod deduplicated its three exact arms on the destination IDENTITY, because one place can be published under two
 * labels (the farm's water landmark declares the farm's identity on purpose). A handle names exactly that identity, so
 * two rows sharing a handle are one destination here for the same reason, and the first of them - publication order - is
 * the row the Mod would have kept.
 */
function distinctByRef(destinations: readonly DestinationIndexRow[], at: readonly number[]): readonly number[] {
  const seen = new Set<string>();
  const kept: number[] = [];
  for (const index of [...new Set(at)].sort((left, right) => left - right)) {
    const ref = destinations[index]!.ref;
    if (seen.has(ref)) continue;
    seen.add(ref);
    kept.push(index);
  }
  return kept;
}

/**
 * One candidate's public shape. A label selector is minted only where the label names exactly one place and the answer is
 * an exact one: a fuzzy match, an alias and an ambiguous label are offered as the opaque handle, so a caller can never
 * copy a plausible-looking label out of a candidate list and have it bind a place the list did not name.
 */
function toCandidate(
  destinations: readonly DestinationIndexRow[],
  at: number,
  forceOpaqueSelector: boolean,
): Readonly<{
  label: string;
  contextLabel: string | null;
  destination: Readonly<{ kind: "label"; label: string; ref: null }> | Readonly<{ kind: "ref"; label: null; ref: string }>;
  unlockState: "unknown";
}> {
  const destination = destinations[at]!;
  const ambiguous = destinations.filter((other) => other.label === destination.label).length > 1;
  return {
    label: destination.label,
    contextLabel: destination.contextLabel,
    destination:
      ambiguous || forceOpaqueSelector
        ? { kind: "ref", label: null, ref: destination.ref }
        : { kind: "label", label: destination.label, ref: null },
    unlockState: "unknown",
  };
}

/**
 * The query a caller may ask. The bounds and the refusal are the Mod's own: a query is 1..128 characters (runes), carries
 * no control character, no `/`, `\` or `:`, and no digit - a place is named in words, and a path, a coordinate or a
 * version string is not a place name. `null` is refused rather than read as "everything".
 */
function normalizeQuery(value: string | null): string | null {
  if (value === null) return null;
  const runes = [...value];
  if (runes.length < 1 || runes.length > MAXIMUM_QUERY_RUNES) return null;
  if (/[\p{Cc}]/u.test(value) || /[/\\:]/u.test(value) || /\p{Nd}/u.test(value)) return null;
  const normalized = normalizeText(value);
  return normalized.length === 0 ? null : normalized;
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resolvedResult(
  reason: "exact_current_locale" | "exact_fallback_locale" | "exact_alias",
  candidate: ReturnType<typeof toCandidate>,
): NavigationReadResult {
  return {
    status: "resolved",
    reason,
    entries: null,
    nextCursor: null,
    candidates: null,
    destination: candidate.destination,
    unlockState: candidate.unlockState,
  };
}

function candidatesResult(
  reason: "ambiguous_exact" | "fuzzy_match",
  candidates: readonly ReturnType<typeof toCandidate>[],
): NavigationReadResult {
  return {
    status: "candidates",
    reason,
    entries: null,
    nextCursor: null,
    candidates,
    destination: null,
    unlockState: null,
  };
}

function notFoundResult(): NavigationReadResult {
  return {
    status: "not_found",
    reason: "destination_not_found",
    entries: null,
    nextCursor: null,
    candidates: null,
    destination: null,
    unlockState: null,
  };
}

function invalidResult(): NavigationReadResult {
  return {
    status: "invalid",
    reason: "destination_search_invalid",
    entries: null,
    nextCursor: null,
    candidates: null,
    destination: null,
    unlockState: null,
  };
}


