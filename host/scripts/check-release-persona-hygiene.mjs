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
 *     `mes_example` sailed through. The score alone is deliberately NOT
 *     enough: `name` and `description` are fields every dependency manifest
 *     carries, and a 69-character description beside a name scores exactly the
 *     threshold, so the value must ALSO hold a field only a character card has
 *     (`CARD_ONLY_FIELDS`, or `tags` beside `avatar`). Without that half the
 *     rule refused `node_modules/@aws/lambda-invoke-store/package.json` — a
 *     gate naming a character card while looking at something with no card
 *     field in it, which is a build nobody can run rather than a card nobody
 *     should ship;
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
 * The score is a NECESSARY condition, not a sufficient one, for an untyped
 * value: `name` (+2) and a description of `MIN_CARD_CONTENT_CHARS` or more
 * (+3, +3) cross the threshold on their own, and those two fields are on every
 * `package.json` in the dependency closure. Identification therefore also
 * requires a card-only field, and `cardScore` itself is unchanged so the
 * anchors below stay the facts they are stated as.
 *
 * The gate reads at most `MAX_SCANNED_BYTES` per file. Larger files are still
 * checked by NAME: the bundled runtime, the native helpers and the Mod bundle
 * are multi-megabyte binaries whose exact bytes the generation inventory pins
 * by digest anyway, so a card cannot be smuggled through them without changing
 * a fact the release already verifies.
 *
 * Scan surface - what this gate reads, and what it deliberately does not:
 *
 * The surface is the PACKAGED GENERATION ARTIFACT and nothing outside it, and
 * inside it exactly what that generation declares it ships. The declaration is
 * the generation's own `production-inventory.json` - the inventory the builder
 * writes for that generation (`production-artifact.mjs`, `createInventory`) -
 * and the gate reads exactly the paths in its `entries`, at the declared path: no
 * more, because a path the artifact does not declare is not part of the artifact,
 * and no less, because a declared path that is missing, dangling or not a file is
 * an inconsistency this gate refuses rather than quietly skips.
 *
 * Concretely that is whatever that generation declared: the browser artifact
 * (`browser/tavern/v1/**`), the emitted Host modules and the generation's own
 * manifests, the packaged Mod (`native/stardew-mod/**`), the allowlisted
 * resources, the voice gateway, the native helper pairs, the bundled Node
 * distribution (`runtime/**`, whose own `node_modules/npm/**` is npm's), and the
 * declared external runtime closure (`node_modules/**`).
 *
 * Deliberately NOT read:
 *
 *   - anything outside the generation root. Sibling generations, the
 *     `current.json` pointer, the publisher lock and pre-rename staging leftovers
 *     are not part of any one generation, and reading them made this gate's
 *     verdict a property of the checkout rather than of the artifact: two
 *     invocations of the same gate could inspect different sets. The CLI walked
 *     `host/dist` - the whole output root - for exactly that reason; it now takes
 *     a generation and refuses anything else with a bounded code
 *     (`release_persona_hygiene_inventory_required`). A directory that declares no
 *     inventory is not a generation and is never walked;
 *   - anything inside the generation root that the inventory does not declare.
 *     The artifact's own statement of what it ships is the authority; this gate
 *     does not fall back to "whatever is reachable from the root". Bytes that are
 *     inside the generation but outside its declaration are not read, so they
 *     cannot change this gate's verdict;
 *   - the inventory itself and the three admission sidecars
 *     (`guardian-admission.json`, `host-runtime-admission.json`,
 *     `voice-gateway-admission.json`). The builder writes those four beside the
 *     inventory and excludes all four from `entries` by construction, and none of
 *     them is free-standing content: the inventory is compared WHOLE
 *     (`production_inventory_mismatch_or_orphan`) and each admission sidecar is
 *     re-derived byte-for-byte by its own verifier, so a sidecar that is not the
 *     canonical one is refused before this gate is reached. This is the one
 *     subtree inside a generation this gate deliberately does not read, named
 *     here rather than left implicit.
 *
 * Dependency trees inside the generation are in scope ON PURPOSE:
 *
 *   - those bytes ship. They are the generation the player runs, which is this
 *     gate's own premise, and nothing about being third-party changes what a
 *     player receives;
 *   - the artifact inventory does not answer this question. It records a
 *     per-file digest under one tree-level `declared_external_runtime_closure`
 *     claim, and `verifyExternalRuntimeClosure` checks reachability, module
 *     ingress and link placement - not content. "Pinned" means a published
 *     generation re-verifies byte-for-byte; it does not mean "no card in it".
 *     Nothing in the pipeline compares a closure file against an upstream
 *     published digest, so it cannot stand in for a content rule;
 *   - part of that closure is repository-authored: `pnpm deploy` resolves `file:`
 *     dependencies out of `vendor/**` (`production-artifact-closure-staging.mjs`),
 *     so "it came from the registry" is not true of every closure byte;
 *   - the false positive that motivates excluding `node_modules` was a RULE
 *     defect - `name` plus a description of `MIN_CARD_CONTENT_CHARS` crosses the
 *     threshold and every manifest has both - and it was fixed in the rule. A
 *     future false positive in third-party bytes must be fixed the same way,
 *     because a path left unread is a hole a card can sit in undetected;
 *   - it costs no new I/O class: `createInventory` already reads and digests
 *     every artifact file, and this gate reads each of them at most once.
 *
 * The only bytes not read are excluded by the ceilings, which are properties of
 * the bytes and not of a path: a file larger than `MAX_SCANNED_BYTES` is checked
 * by name only, a value larger than `MAX_JSON_PARSE_BYTES` is not parsed as a
 * whole JSON value, and at most `MAX_BASE64_CANDIDATES` runs are decoded per
 * file. The gate reports how much surface it covered (`assertReleasePersonaHygiene`
 * returns a `surface` census and the CLI prints it), so what was read is visible
 * in the CI log instead of inferred.
 *
 * Links, and why the read is deterministic: a declared path is read by resolving
 * the PATH, never by re-deriving a file set from how the local filesystem happens
 * to represent it. A link - Windows junction, directory symlink, file symlink -
 * is RESOLVED and its target's bytes are inspected exactly as if the bytes sat at
 * the declared path, which is the path reported; so the same declared files in
 * two link representations report the same findings. A hardlink is an ordinary
 * file and is read at each declared path it appears at, as it always was. Two
 * declared paths that resolve to one real file are the same bytes: the second is
 * skipped, and the finding is reported once, at the first path in lexicographic
 * order. A dangling declared link fails the gate
 * (`release_persona_hygiene_unresolvable_link:<path>`) rather than being silently
 * dropped. This is measured, not theorized: deciding by
 * `readdir`'s entry type instead - which is what this gate did - sent a linked
 * dependency directory to `inspectFile`, whose link guard threw
 * `release_persona_hygiene_non_regular_entry`, so identical dependency bytes were
 * REPORTED when the tree held real files and NOT READ when it held links. A
 * pnpm-style tree and an unlinked copy of it gave different answers for the same
 * content, which is a release gate whose verdict is a property of the checkout.
 *
 * Honest limits: a card whose every prose field is shorter than
 * `MIN_CARD_CONTENT_CHARS` scores on its field weights alone (14 for a full
 * card), so it is still read - but a card that omits enough fields to score
 * below 8 is refused only if it lands under a card-shaped file name. Base64
 * detection reads the standard `+/` alphabet, not the URL-safe `-_` one, and
 * decodes at most `MAX_BASE64_CANDIDATES` runs per file. The prose threshold is
 * a length, so it says nothing about what the prose is.
 *
 * Wiring: `production-artifact.mjs` writes the generation's own inventory and
 * only then runs `assertReleasePersonaHygiene` over that staging tree, so the gate
 * reads the same declared file set the generation is about to ship with, and
 * `assertCompleteProductionArtifact` runs it over the generation selected by
 * `current.json`. Both call sites fail the build/recheck with
 * `release_persona_hygiene_violation:<path>:<kind>`.
 */

import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
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
 * The fields ONLY a character card carries. `name` and `description` are not
 * among them: every dependency manifest has both, and `name` plus a
 * 69-character `description` is exactly `CARD_SCORE_THRESHOLD`, which is how
 * this gate came to report `node_modules/@aws/lambda-invoke-store/package.json`
 * as a spec-stripped card. An untyped value is a card when the score crosses
 * AND it holds one of these, so the evidence that identifies a card is never a
 * field a manifest also has.
 */
const CARD_ONLY_FIELDS = Object.freeze([
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "character_book",
  "creator",
  "character_version",
  "alternate_greetings",
]);
/** The one card-only shape whose evidence is a PAIR rather than a single field. */
const CARD_ONLY_PAIR_FIELDS = Object.freeze(["tags", "avatar"]);
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
/** True when a field's value carries something, in any of a card's JSON shapes. */
function carriesContent(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return isRecord(value) && Object.keys(value).length > 0;
}
/** The record a card's fields live in: the CCv2 payload under `data`, or the value itself. */
function cardFields(value) {
  return isRecord(value.data) ? value.data : value;
}
/** True when the value holds at least one field only a character card has. */
function hasCardOnlyEvidence(value) {
  const data = cardFields(value);
  if (!isRecord(data)) return false;
  if (CARD_ONLY_FIELDS.some((field) => carriesContent(data[field]))) return true;
  return CARD_ONLY_PAIR_FIELDS.every((field) => carriesContent(data[field]));
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
  const data = cardFields(value);
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
  // A spec member identifies the card on its own. Without one the score has to
  // be earned by a field only a card has, because the threshold is reachable
  // from `name` + a long `description`, which everything in `node_modules` has.
  if (typeof value.spec === "string" && CARD_SPEC_VALUES.has(value.spec)) return "card_payload";
  return hasCardOnlyEvidence(value) ? "untyped_card_payload" : null;
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

async function inspectFile({ absolute, path, name, size, findings, surface }) {
  if (COMPANION_SEED_FILE.test(name)) {
    findings.push(Object.freeze({ path, kind: "companion_card_file" }));
    return;
  }
  if (size === 0 || size > MAX_SCANNED_BYTES) {
    surface.filesNameCheckedOnly += 1;
    return;
  }
  surface.filesInspected += 1;
  const bytes = await readFile(absolute);
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
  if (size <= MAX_JSON_PARSE_BYTES) {
    const value = parseJsonValue(bytes.toString("utf8"));
    if (value !== null) {
      const kind = jsonCardKind(value);
      if (kind !== null) findings.push(Object.freeze({ path, kind }));
    }
  }
}

/** What the read covered, so the scan surface is reported rather than inferred. */
function emptySurface() {
  return { declaredFiles: 0, filesInspected: 0, filesNameCheckedOnly: 0, linksResolved: 0, duplicateTargetsSkipped: 0 };
}

function requireArtifactRoot(artifactRoot) {
  if (typeof artifactRoot !== "string" || artifactRoot.length === 0)
    throw new Error("release_persona_hygiene_root_required");
  return resolve(artifactRoot);
}

/** A generation-relative artifact path: no drive, no backslash, no `.` or `..`. */
function isArtifactPath(path) {
  return typeof path === "string" && path.length > 0 && !isAbsolute(path) && !path.includes("\\")
    && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Windows resolves `C:\\X` and `c:\\x` to one file; POSIX does not fold case. */
const samePath = (left, right) => (process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right);

/**
 * The generation's own declared file set: every path its
 * `production-inventory.json` - the inventory the builder writes for that
 * generation - states it ships, in lexicographic order. A directory without that
 * inventory is not a generation and is refused
 * (`release_persona_hygiene_inventory_required`) rather than walked.
 */
export async function readDeclaredArtifactFiles({ artifactRoot }) {
  const root = requireArtifactRoot(artifactRoot);
  let text;
  try {
    text = await readFile(resolve(root, "production-inventory.json"), "utf8");
  } catch {
    throw new Error("release_persona_hygiene_inventory_required");
  }
  let inventory;
  try {
    inventory = JSON.parse(text);
  } catch {
    throw new Error("release_persona_hygiene_inventory_invalid");
  }
  if (!isRecord(inventory) || !Array.isArray(inventory.entries))
    throw new Error("release_persona_hygiene_inventory_invalid");
  const declared = new Set();
  for (const entry of inventory.entries) {
    const path = isRecord(entry) ? entry.path : undefined;
    if (!isArtifactPath(path))
      throw new Error(`release_persona_hygiene_inventory_invalid:${typeof path === "string" ? path : ""}`);
    declared.add(path);
  }
  return Object.freeze([...declared].sort((left, right) => left.localeCompare(right, "en")));
}

/**
 * Reads one declared path, resolving it: a link at or above the path is followed
 * and the bytes at its target are what that path ships. A declared path that is
 * absent, dangling, or not a file refuses the generation. Two declared paths that
 * resolve to one real file are the same bytes, read once at the first of them.
 */
async function inspectDeclaredFile({ root, path, findings, surface, seen, rootReal }) {
  const absolute = resolve(root, path);
  let state;
  try {
    state = await lstat(absolute);
  } catch {
    throw new Error(`release_persona_hygiene_declared_file_missing:${path}`);
  }
  if (state.isSymbolicLink()) {
    try {
      state = await stat(absolute);
    } catch {
      throw new Error(`release_persona_hygiene_unresolvable_link:${path}`);
    }
  }
  if (!state.isFile()) throw new Error(`release_persona_hygiene_non_regular_entry:${path}`);
  const canonical = await realpath(absolute);
  // Measured against the generation's own canonical root, so how the root itself
  // is reached does not read as a link inside the generation.
  if (!samePath(canonical, resolve(rootReal, path))) surface.linksResolved += 1;
  if (seen.has(canonical)) {
    surface.duplicateTargetsSkipped += 1;
    return;
  }
  seen.add(canonical);
  await inspectFile({ absolute, path, name: basename(path), size: state.size, findings, surface });
}

/**
 * The one read pass: every path the generation declared, in lexicographic order,
 * and nothing else. Returns the findings in that order and fills `surface` with
 * what it covered. See the scan-surface docstring.
 */
async function inspectDeclaredFiles({ root, declared, surface }) {
  const findings = [];
  const seen = new Set();
  const rootReal = await realpath(root);
  surface.declaredFiles = declared.length;
  for (const path of declared) await inspectDeclaredFile({ root, path, findings, surface, seen, rootReal });
  return findings;
}

/**
 * Every character-card finding in one packaged generation, over that generation's
 * own declared file set, in deterministic (lexicographic) order. `artifactRoot`
 * is the generation root — the exact bytes that would ship — never the output root
 * that holds generations, and never the repository, whose dev seeds and test
 * fixtures are deliberately out of scope.
 */
export async function scanReleasePersonaHygiene({ artifactRoot }) {
  const root = requireArtifactRoot(artifactRoot);
  const declared = await readDeclaredArtifactFiles({ artifactRoot: root });
  return Object.freeze(await inspectDeclaredFiles({ root, declared, surface: emptySurface() }));
}

/**
 * Fails the build with a bounded message naming the first offending asset. One
 * finding is enough to refuse the generation; the message stays a single line so
 * the CI log's reason is the reason. On success it returns the declared file set
 * it read and the covered surface census alongside the (empty) findings.
 */
export async function assertReleasePersonaHygiene({ artifactRoot }) {
  const root = requireArtifactRoot(artifactRoot);
  const surface = emptySurface();
  const declared = await readDeclaredArtifactFiles({ artifactRoot: root });
  const findings = await inspectDeclaredFiles({ root, declared, surface });
  if (findings.length > 0)
    throw new Error(`release_persona_hygiene_violation:${findings[0].path}:${findings[0].kind}`);
  return Object.freeze({
    findings: Object.freeze(findings),
    artifactRoot: root,
    declaredFiles: declared,
    surface: Object.freeze(surface),
  });
}

/** Human-readable report for the CLI; the assertion above stays the machine gate. */
export function describePersonaHygieneFindings(findings) {
  return findings.map((finding) => `${finding.kind}\t${finding.path}`).join("\n");
}

/**
 * The CLI takes a generation. With no argument it names the fixed output root,
 * which declares no inventory and is therefore refused with the bounded code
 * rather than walked - the whole-output-root default is what let the same gate
 * scan different sets on two invocations.
 */
const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  const target = resolve(process.argv[2] ?? resolve(scriptPath, "..", "..", "dist"));
  try {
    const root = requireArtifactRoot(target);
    const surface = emptySurface();
    const declared = await readDeclaredArtifactFiles({ artifactRoot: root });
    const findings = await inspectDeclaredFiles({ root, declared, surface });
    const censused = `declared=${surface.declaredFiles}\tfiles=${surface.filesInspected}\tname-only=${surface.filesNameCheckedOnly}\tlinks=${surface.linksResolved}\tduplicate-targets=${surface.duplicateTargetsSkipped}`;
    if (findings.length === 0) {
      console.log(`release_persona_hygiene_ok\t${root.split(sep).join("/")}\t${censused}`);
    } else {
      console.error(`release_persona_hygiene_violation:${findings[0].path}:${findings[0].kind}`);
      console.error(describePersonaHygieneFindings(findings));
      console.error(censused);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
