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
 *   - `untyped_card_payload`: a whole-file JSON object carrying the CCv2 core
 *     card fields (`name`, `description`, `personality`, `scenario`,
 *     `first_mes`, `mes_example`, all strings) without a `spec` member — a v1
 *     card under an arbitrary name;
 *   - `embedded_card_png`: a PNG whose text chunks use the `chara` / `ccv3` /
 *     `character` keyword, i.e. an embedded card payload.
 *
 * The gate reads at most `MAX_SCANNED_BYTES` per file. Larger files are still
 * checked by NAME: the bundled runtime, the native helpers and the Mod bundle
 * are multi-megabyte binaries whose exact bytes the generation inventory pins
 * by digest anyway, so a card cannot be smuggled through them without changing
 * a fact the release already verifies.
 *
 * Honest limits: a card whose every prose field is shorter than
 * `MIN_CARD_CONTENT_CHARS` is not read as a payload by bytes and is refused only
 * if it lands under a card-shaped file name; and the prose threshold is a
 * length, so it says nothing about what the prose is.
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
/** The CCv2 core fields every card carries; presence of all six in one JSON object is a card. */
const UNTYPED_CARD_FIELDS = ["name", "description", "personality", "scenario", "first_mes", "mes_example"];
const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_CARD_KEYWORDS = new Set(["chara", "ccv3", "character"]);
/**
 * A card's own name, as a JSON member whose value is a name and not an example.
 * The placeholder this gate once refused carries `"name":"…"`: one ellipsis
 * character, no letters.
 */
const CARD_NAME_MEMBER = /"name"\s*:\s*"([^"\\]{1,256})"/u;
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
  if (name === null || /^[\s.…·．。\-_]+$/u.test(name[1])) return false;
  return hasSubstantiveContentField(text);
}

/** The CCv2 core card fields, present together as non-empty strings. */
function isUntypedCard(value) {
  const data = isRecord(value.data) ? value.data : value;
  return UNTYPED_CARD_FIELDS.every(
    (field) => typeof data[field] === "string" && data[field].trim().length > 0,
  );
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
  if (state.size <= MAX_JSON_PARSE_BYTES && text.trimStart().startsWith("{")) {
    try {
      if (isUntypedCard(JSON.parse(bytes.toString("utf8"))))
        findings.push(Object.freeze({ path, kind: "untyped_card_payload" }));
    } catch {
      // Not JSON: nothing more to say about it.
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
