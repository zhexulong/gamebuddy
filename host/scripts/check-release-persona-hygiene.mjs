#!/usr/bin/env node
/**
 * check-release-persona-hygiene.mjs
 *
 * The release gate that decides whether authored CHARACTER content would ship.
 *
 * Why a byte gate and not a name list: the product's reviewed companion is the
 * owner's own character, and the repository has carried third-party /
 * fan-made cards beside it (`.gitignore:135-138` excludes
 * `assets/tavern/presets/deepseek-chan/`, `local-*`, `*.private` for exactly
 * that reason). A denylist of card names would have to be extended every time
 * somebody drops a new one in, and it would still miss the same bytes renamed.
 * What "would ship" therefore means here, precisely:
 *
 *   - a development seed that lives OUTSIDE the packaged artifact is fine — the
 *     committed `assets/tavern/presets/default-companion` preset is a build-time
 *     dev seed and is not scanned, because it is not part of a generation;
 *   - the SAME BYTES inside a packaged generation are not: whatever they are
 *     called, shipping them is the trademark / fan-copyright / non-all-ages
 *     exposure the gate exists to stop.
 *
 * So the gate inspects the exact bytes of a candidate generation and fails,
 * naming the offending asset path, on any of:
 *
 *   - `companion_card_file`: a file named `card.json`, `worldbook.json`,
 *     `*.card.json` or `*.worldbook.json` — the companion seed PAIR the
 *     product's own import/provisioning writes into a runtime root, never into
 *     an immutable generation;
 *   - `card_payload`: bytes carrying a SillyTavern card spec value
 *     (`"spec": "chara_card_v2" | "chara_card_v3" | "ccv3"`) AND the payload
 *     that value describes - a real `name` beside at least one prose field
 *     holding `MIN_CARD_CONTENT_CHARS` or more of authored text. That is what a
 *     card looks like inside a `.js`/`.json` asset that was renamed or inlined.
 *     The marker ALONE is not a card, and this is a fixed false positive rather
 *     than a theory: the import box's own placeholder is
 *     `{"spec":"chara_card_v3","data":{"name":"…"}}`
 *     (`dialogue-web/src/components/CharacterCardImport.tsx`), Vite bundles it
 *     verbatim, and a marker-only rule refused every generation built after that
 *     rule landed - including the generation the running product was installed
 *     from - over the product's own help text. A placeholder has no card and no
 *     data; a shipped card has a payload;
 *   - `encoded_card_payload`: the same card, base64-encoded so a plain-text scan
 *     cannot read it. Every long base64 run in the bytes is decoded and the
 *     decoded bytes are scanned by the same rules (a decoded card object or
 *     array scores past the threshold; a decoded PNG with a `chara` chunk is
 *     `embedded_card_png`). This closes the "encode it and the scanner sees
 *     nothing" bypass;
 *   - `untyped_card_payload`: a whole-file JSON value — an object OR a
 *     top-level array of objects — whose weighted card score crosses
 *     `CARD_SCORE_THRESHOLD` without a `spec` member: a v1 card, or a v2/v3
 *     card whose spec was stripped, under an arbitrary name. The former rule
 *     demanded all six CCv2 core fields, so a real card that simply omitted
 *     `mes_example` sailed through;
 *   - `embedded_card_png`: a PNG whose text chunks use the `chara` / `ccv3` /
 *     `character` keyword, i.e. an embedded card payload.
 *
 * The weighted card score, and why its threshold is where it is:
 *
 *   name +2, description +3, personality +2, scenario +2, first_mes +3,
 *   mes_example +2, a `spec` marker +3, and any prose field of
 *   `MIN_CARD_CONTENT_CHARS` or more +3. The repository's own reviewed card
 *   (`assets/tavern/presets/default-companion/card.json`) scores **20**:
 *   3 (spec) + 14 (all six core fields present) + 3 (its `description` is 1658
 *   characters of prose). The import box's placeholder scores **5**: 3 (spec) +
 *   2 (a name that is one ellipsis) and no prose. `CARD_SCORE_THRESHOLD = 8`
 *   therefore sits far above the placeholder and the help text around it, and
 *   far below the reviewed card, while a real card that omits `mes_example`
 *   still scores 12 and a v1 card with all six short fields scores 14 - so
 *   "the card forgot one field" can no longer hide a card.
 *
 * The gate reads at most `MAX_SCANNED_BYTES` per file. Larger files are still
 * checked by NAME: the bundled runtime, the native helpers and the Mod bundle
 * are multi-megabyte binaries whose exact bytes the generation inventory pins
 * by digest anyway, so a card cannot be smuggled through them without changing
 * a fact the release already verifies.
 *
 * Honest limits: a card whose every prose field is shorter than
 * `MIN_CARD_CONTENT_CHARS` scores on its field weights alone (14 for a full
 * card), so it is still read - but a card that omits enough fields to score
 * below 8 is refused only if it lands under a card-shaped file name. Base64
 * detection reads the standard `+/` alphabet, not the URL-safe `-_` one, and
 * decodes at most `MAX_BASE64_CANDIDATES` runs per file. The prose threshold is
 * a length, so it says nothing about what the prose is.
 *
 * Wiring: `production-artifact.mjs` runs `assertReleasePersonaHygiene` over the
 * staging tree before that tree can become a generation, and over the selected
 * generation in `assertCompleteProductionArtifact`. Both call sites fail the
 * build/recheck with `release_persona_hygiene_violation:<path>:<kind>`.
 */

import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The companion seed pair's file names, and the card-shaped variants of them. */
const COMPANION_SEED_FILE = /^(?:card|worldbook)\.json$|\.card\.json$|\.worldbook\.json$/iu;
/** A card's spec value, written as a JSON member (a comparison literal has no `:`). */
const CARD_SPEC_MEMBER = /"spec"\s*:\s*"(?:chara_card_v2|chara_card_v3|ccv3)"/u;
const CARD_SPEC_VALUES = new Set(["chara_card_v2", "chara_card_v3", "ccv3"]);
/** The CCv2 core fields a card is scored on, and each field's weight. */
const CARD_FIELD_WEIGHTS = Object.freeze({
  name: 2,
  description: 3,
  personality: 2,
  scenario: 2,
  first_mes: 3,
  mes_example: 2,
});
const CARD_SPEC_WEIGHT = 3;
const CARD_PROSE_WEIGHT = 3;
/**
 * The score a JSON object or array must reach to be a card. The reviewed card
 * scores 20 and the import-box placeholder scores 5 (see the docstring); 8 is
 * the midpoint that admits a card missing any one field.
 */
export const CARD_SCORE_THRESHOLD = 8;
const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_CARD_KEYWORDS = new Set(["chara", "ccv3", "character"]);
/**
 * A card's own name, as a JSON member whose value is a name and not an example.
 * The placeholder this gate once refused carries `"name":"…"`: one ellipsis
 * character, no letters. This gate reads bytes as latin1, where U+2026 is the
 * three bytes `â`, U+0080 and `¦`, so the class carries both spellings and the
 * guard fires whichever decoding found it. It is the weaker of the two halves:
 * on the bundled placeholder it is the prose field that does the rejecting.
 */
const CARD_NAME_MEMBER = /"name"\s*:\s*"([^"\\]{1,256})"/u;
const NAME_THAT_IS_ONLY_PUNCTUATION = /^[\s.…·．。\-_â\u0080¦]+$/u;
/** The fields a card's payload keeps its authored prose in. */
const CARD_CONTENT_FIELDS = Object.freeze([
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "system_prompt",
  "post_history_instructions",
]);
/**
 * How much authored prose one field must hold before it is content rather than
 * an example. Chosen from the repository's own reviewed card
 * (`assets/tavern/presets/default-companion/card.json`, a real card the tests
 * prove by bytes): its shortest prose field is `personality` at 65 characters,
 * so 64 clears every field of every card this repository actually carries and is
 * still a sentence of prose no help text writes. Production is the exact bytes
 * of a generation, so the constant is quoted in the docstring above rather than
 * tuned per release.
 */
const MIN_CARD_CONTENT_CHARS = 64;
const MAX_SCANNED_BYTES = 8 * 1024 * 1024;
const MAX_JSON_PARSE_BYTES = 1024 * 1024;
/** A long run of base64 characters: long enough that prose never produces one. */
const BASE64_CANDIDATE = /[A-Za-z0-9+/]{120,}={0,2}/gu;
const MAX_BASE64_CANDIDATES = 64;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasPngSignature(bytes) {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}
function readU32(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}
function ascii(bytes) {
  return String.fromCharCode(...bytes);
}

/** True when the PNG carries an embedded card text chunk (`chara` / `ccv3` / `character`). */
function hasEmbeddedCardChunk(bytes) {
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = ascii(bytes.subarray(offset + 4, offset + 8));
    const chunkStart = offset + 8;
    if (length < 0 || chunkStart + length > bytes.length) return false;
    const chunk = bytes.subarray(chunkStart, chunkStart + length);
    if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      const terminator = chunk.indexOf(0);
      if (terminator > 0 && PNG_CARD_KEYWORDS.has(ascii(chunk.subarray(0, terminator)).trim().toLowerCase()))
        return true;
    }
    offset = chunkStart + length + 4;
    if (type === "IEND") return false;
  }
  return false;
}

/** `"description": "<64+ characters of prose>"`, escapes included. */
function hasSubstantiveContentField(text) {
  return CARD_CONTENT_FIELDS.some((field) =>
    new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){${MIN_CARD_CONTENT_CHARS},})"`, "u").test(text),
  );
}

/**
 * A spec marker WITH the prose it describes: a card payload, not a UI example.
 * Both halves are required - the marker alone matched the product's own import
 * placeholder, and prose alone is not identified as a card by anything.
 */
function carriesCardPayload(text) {
  if (!CARD_SPEC_MEMBER.test(text)) return false;
  const name = CARD_NAME_MEMBER.exec(text);
  if (name === null || NAME_THAT_IS_ONLY_PUNCTUATION.test(name[1])) return false;
  return hasSubstantiveContentField(text);
}

/** The weighted card score of one decoded object (see the docstring). */
export function cardScore(value) {
  if (!isRecord(value)) return 0;
  let score = 0;
  if (typeof value.spec === "string" && CARD_SPEC_VALUES.has(value.spec)) score += CARD_SPEC_WEIGHT;
  const data = isRecord(value.data) ? value.data : value;
  if (isRecord(data)) {
    for (const [field, weight] of Object.entries(CARD_FIELD_WEIGHTS))
      if (typeof data[field] === "string" && data[field].trim().length > 0) score += weight;
    if (
      CARD_CONTENT_FIELDS.some(
        (field) => typeof data[field] === "string" && data[field].length >= MIN_CARD_CONTENT_CHARS,
      )
    )
      score += CARD_PROSE_WEIGHT;
  }
  return score;
}

/**
 * The finding kind for a decoded JSON value, unwrapping a top-level array: a
 * value that scores as a card is a typed card when it carries a spec member and
 * an untyped one when it does not.
 */
function jsonCardKind(value) {
  if (Array.isArray(value)) {
    for (const element of value) {
      const kind = jsonCardKind(element);
      if (kind !== null) return kind;
    }
    return null;
  }
  if (!isRecord(value) || cardScore(value) < CARD_SCORE_THRESHOLD) return null;
  return typeof value.spec === "string" && CARD_SPEC_VALUES.has(value.spec) ? "card_payload" : "untyped_card_payload";
}

/** Parse a JSON value that starts with `{` or `[`, or return null. */
function parseJsonValue(text) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Decode every long base64 run in the bytes and report the first that carries a
 * card: a decoded PNG with a card chunk, a decoded payload with a spec marker
 * and prose, or a decoded object/array that scores past the threshold.
 */
function encodedCardKind(text) {
  let seen = 0;
  for (const match of text.matchAll(BASE64_CANDIDATE)) {
    if (seen >= MAX_BASE64_CANDIDATES) return null;
    seen += 1;
    const decoded = Buffer.from(match[0], "base64");
    if (decoded.length === 0) continue;
    if (hasPngSignature(decoded) && hasEmbeddedCardChunk(decoded)) return "embedded_card_png";
    const decodedText = decoded.toString("latin1");
    if (carriesCardPayload(decodedText)) return "encoded_card_payload";
    const value = parseJsonValue(decoded.toString("utf8"));
    if (value !== null) {
      const kind = jsonCardKind(value);
      if (kind !== null) return "encoded_card_payload";
    }
  }
  return null;
}

async function inspectFile(absolutePath, name, findings, prefix) {
  const path = prefix === "" ? name : `${prefix}/${name}`;
  if (COMPANION_SEED_FILE.test(name)) {
    findings.push(Object.freeze({ path, kind: "companion_card_file" }));
    return;
  }
  const state = await lstat(absolutePath);
  if (!state.isFile() || state.isSymbolicLink()) throw new Error(`release_persona_hygiene_non_regular_entry:${path}`);
  if (state.size === 0 || state.size > MAX_SCANNED_BYTES) return;
  const bytes = await readFile(absolutePath);
  if (hasPngSignature(bytes) && hasEmbeddedCardChunk(bytes)) {
    findings.push(Object.freeze({ path, kind: "embedded_card_png" }));
    return;
  }
  const text = bytes.toString("latin1");
  if (carriesCardPayload(text)) {
    findings.push(Object.freeze({ path, kind: "card_payload" }));
    return;
  }
  const encoded = encodedCardKind(text);
  if (encoded !== null) {
    findings.push(Object.freeze({ path, kind: encoded }));
    return;
  }
  if (state.size <= MAX_JSON_PARSE_BYTES) {
    const value = parseJsonValue(bytes.toString("utf8"));
    if (value !== null) {
      const kind = jsonCardKind(value);
      if (kind !== null) findings.push(Object.freeze({ path, kind }));
    }
  }
}

/**
 * Every character-card finding in one packaged generation, in deterministic
 * (lexicographic) order. `artifactRoot` is the generation root — the exact bytes
 * that would ship — never the repository, whose dev seeds and test fixtures are
 * deliberately out of scope.
 */
export async function scanReleasePersonaHygiene({ artifactRoot }) {
  if (typeof artifactRoot !== "string" || artifactRoot.length === 0)
    throw new Error("release_persona_hygiene_root_required");
  const root = resolve(artifactRoot);
  const findings = [];
  const walk = async (absolute, prefix) => {
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) await walk(child, prefix === "" ? entry.name : `${prefix}/${entry.name}`);
      else await inspectFile(child, entry.name, findings, prefix);
    }
  };
  await walk(root, "");
  return Object.freeze(findings);
}

/**
 * Fails the build with a bounded message naming the first offending asset. One
 * finding is enough to refuse the generation; the message stays a single line so
 * the CI log's reason is the reason.
 */
export async function assertReleasePersonaHygiene({ artifactRoot }) {
  const findings = await scanReleasePersonaHygiene({ artifactRoot });
  if (findings.length > 0)
    throw new Error(`release_persona_hygiene_violation:${findings[0].path}:${findings[0].kind}`);
  return Object.freeze({ findings, artifactRoot: resolve(artifactRoot) });
}

/** Human-readable report for the CLI; the assertion above stays the machine gate. */
export function describePersonaHygieneFindings(findings) {
  return findings.map((finding) => `${finding.kind}\t${finding.path}`).join("\n");
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  const target = process.argv[2] ?? resolve(scriptPath, "..", "..", "dist");
  const findings = await scanReleasePersonaHygiene({ artifactRoot: target });
  if (findings.length === 0) {
    console.log(`release_persona_hygiene_ok\t${resolve(target).split(sep).join("/")}`);
  } else {
    console.error(`release_persona_hygiene_violation:${findings[0].path}:${findings[0].kind}`);
    console.error(describePersonaHygieneFindings(findings));
    process.exitCode = 1;
  }
}
