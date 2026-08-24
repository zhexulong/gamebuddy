import { inflateSync } from "node:zlib";
import type { IdentityProfile } from "./identity-profile.js";
import { ST_CARD_DECODER_LIMITS_V1 } from "./tavern/compatibility-manifest.v1.js";
import type { WorldBookEntry } from "./worldbook.js";

const MAX_INPUT_BYTES = ST_CARD_DECODER_LIMITS_V1.inputBytes;
const MAX_JSON_DEPTH = ST_CARD_DECODER_LIMITS_V1.jsonDepth;
const MAX_JSON_NODES = ST_CARD_DECODER_LIMITS_V1.jsonNodes;
const MAX_PNG_CHUNKS = ST_CARD_DECODER_LIMITS_V1.pngChunks;
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export type StCardImportClassification =
  | "accepted_typed"
  | "preserved_opaque"
  | "dropped_unsupported"
  | "rejected_invalid";
export type StCardImportDisposition = Readonly<{
  field: string;
  classification: StCardImportClassification;
  reason: string;
}>;
export type StCardImportCandidate = Readonly<{
  profileCandidate: StCardImportPreview["profileCandidate"];
  worldBookCandidates: readonly WorldBookEntry[];
}>;
export type StCardImportReport = Readonly<{
  source: "json" | "png";
  format?: "st-v2" | "st-v3";
  candidate?: StCardImportCandidate;
  dispositions: readonly StCardImportDisposition[];
}>;

export type StCardImportPreview = Readonly<{
  format: "st-v2" | "st-v3";
  profileCandidate: Readonly<{
    profileId: string;
    identity: Readonly<{ name: string; role: string; continuity: string }>;
    persona?: IdentityProfile["persona"];
    examples: readonly Readonly<{ user: string; companion: string }>[];
    firstGreeting?: string;
  }>;
  worldBookCandidates: readonly WorldBookEntry[];
  unsupportedFields: readonly string[];
}>;

/**
 * Safely decodes a bounded ST V2/V3 JSON payload or PNG metadata. The result
 * consists exclusively of inert data candidates; no field is executed, placed
 * into a prompt, fetched, or otherwise interpreted as instructions.
 */
export function decodeStCard(input: string | Uint8Array): StCardImportReport {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  if (bytes.byteLength > MAX_INPUT_BYTES) return rejected("json", "input", "input_too_large");
  const source = isPng(bytes) ? "png" : "json";
  const json = source === "png" ? extractPngCardJson(bytes) : decodeUtf8(bytes);
  if (json === undefined)
    return rejected(source, source === "png" ? "png_metadata" : "input", "missing_or_invalid_card_payload");
  if (!hasSafeJsonShape(json)) return rejected(source, "input", "json_limits_exceeded");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return rejected(source, "input", "invalid_json");
  }
  if (!isRecord(value)) return rejected(source, "root", "card_must_be_an_object");
  return reportFromValue(value, source);
}

/** Backwards-compatible preview helper for already-decoded JSON values. */
export function previewStCard(value: unknown, fallbackProfileId = "gamebuddy.companion.imported"): StCardImportPreview {
  if (!isRecord(value)) throw new Error("invalid_st_card");
  return previewFromValue(value, fallbackProfileId);
}

/**
 * Maps an imported candidate's static persona and identity into a Host IdentityProfile,
 * ensuring 100% Prefix Caching in m[0].
 */
export function candidateToIdentityProfile(
  previewOrCandidate: StCardImportPreview | StCardImportCandidate,
  revision = 1,
): IdentityProfile {
  const profileCandidate =
    "profileCandidate" in previewOrCandidate
      ? previewOrCandidate.profileCandidate
      : (previewOrCandidate as StCardImportPreview).profileCandidate;
  return Object.freeze({
    schemaVersion: 1,
    profileId: profileCandidate.profileId,
    revision,
    identity: Object.freeze({
      name: profileCandidate.identity.name,
      role: profileCandidate.identity.role,
      continuity: profileCandidate.identity.continuity,
    }),
    ...(profileCandidate.persona === undefined ? {} : { persona: profileCandidate.persona }),
    ...(profileCandidate.examples === undefined || profileCandidate.examples.length === 0
      ? {}
      : { examples: profileCandidate.examples }),
  });
}

function reportFromValue(value: Record<string, unknown>, source: "json" | "png"): StCardImportReport {
  const preview = previewFromValue(value, "gamebuddy.companion.imported");
  const data = isRecord(value.data) ? value.data : value;
  const accepted = [
    "name",
    "description",
    "personality",
    "scenario",
    "first_mes",
    "first_message",
    "mes_example",
    "character_book",
  ].filter((field) => data[field] !== undefined);
  const dispositions: StCardImportDisposition[] = accepted.map((field) =>
    disposition(field, "accepted_typed", "bounded_inert_candidate"),
  );
  for (const field of Object.keys(data).sort()) {
    if (isUnsupported(field))
      dispositions.push(disposition(field, "dropped_unsupported", "executable_or_prompt_control_field"));
    else if (!accepted.includes(field) && field !== "spec")
      dispositions.push(disposition(field, "preserved_opaque", "not_interpreted"));
  }
  return Object.freeze({
    source,
    format: preview.format,
    candidate: Object.freeze({
      profileCandidate: preview.profileCandidate,
      worldBookCandidates: preview.worldBookCandidates,
    }),
    dispositions: Object.freeze(dispositions),
  });
}

function previewFromValue(value: Record<string, unknown>, fallbackProfileId: string): StCardImportPreview {
  const data = isRecord(value.data) ? value.data : value;
  const spec = typeof value.spec === "string" ? value.spec : typeof data.spec === "string" ? data.spec : undefined;
  const format = spec === "chara_card_v3" || spec === "ccv3" ? "st-v3" : "st-v2";
  const name = boundedText(data.name, ST_CARD_DECODER_LIMITS_V1.nameBytes) ?? "Imported Companion";
  const description = boundedMultilineText(data.description, ST_CARD_DECODER_LIMITS_V1.textBytes);
  const personality = boundedMultilineText(data.personality, ST_CARD_DECODER_LIMITS_V1.textBytes);
  const scenario = boundedMultilineText(data.scenario, ST_CARD_DECODER_LIMITS_V1.textBytes);
  const greeting =
    boundedMultilineText(data.first_mes, ST_CARD_DECODER_LIMITS_V1.textBytes) ??
    boundedMultilineText(data.first_message, ST_CARD_DECODER_LIMITS_V1.textBytes);
  const examples = parseExamples(boundedMultilineText(data.mes_example, ST_CARD_DECODER_LIMITS_V1.examplesBytes));
  const persona =
    description === undefined && personality === undefined
      ? undefined
      : Object.freeze({
          core: description ?? personality!,
          interactionStyle: personality ?? "Respect the player's agency and do not invent shared experiences.",
          expressionStyle: "Use natural player-facing language; do not use system or tool language.",
        });
  const worldBookCandidates = extractCharacterBook(data.character_book, format);
  const unsupportedFields = Object.keys(data).filter(isUnsupported).sort();
  return Object.freeze({
    format,
    profileCandidate: Object.freeze({
      profileId: idFromName(name, fallbackProfileId),
      identity: Object.freeze({
        name,
        role: "the player's game companion",
        continuity:
          scenario ?? "Maintain one continuous shared experience with the player across chat and game surfaces.",
      }),
      ...(persona === undefined ? {} : { persona }),
      examples: Object.freeze(examples),
      ...(greeting === undefined ? {} : { firstGreeting: greeting }),
    }),
    worldBookCandidates: Object.freeze(worldBookCandidates),
    unsupportedFields: Object.freeze(unsupportedFields),
  });
}

function extractPngCardJson(bytes: Uint8Array): string | undefined {
  let offset = 8;
  for (let count = 0; offset + 12 <= bytes.length && count < MAX_PNG_CHUNKS; count++) {
    const length = readU32(bytes, offset);
    const type = ascii(bytes.subarray(offset + 4, offset + 8));
    offset += 8;
    if (length > MAX_INPUT_BYTES || offset + length + 4 > bytes.length) return undefined;
    const chunk = bytes.subarray(offset, offset + length);
    offset += length + 4;
    const text =
      type === "tEXt"
        ? pngText(chunk)
        : type === "zTXt"
          ? pngCompressedText(chunk)
          : type === "iTXt"
            ? pngInternationalText(chunk)
            : undefined;
    if (text !== undefined) {
      const kw = text.keyword.toLowerCase();
      if (kw === "chara" || kw === "ccv3" || kw === "character") return decodeCharaValue(text.value);
    }
    if (type === "IEND") break;
  }
  return undefined;
}
function decodeCharaValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  const cleaned = trimmed.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(cleaned) || cleaned.length % 4 !== 0) return undefined;
  return decodeUtf8(Buffer.from(cleaned, "base64"));
}
function pngText(chunk: Uint8Array): { keyword: string; value: string } | undefined {
  const split = chunk.indexOf(0);
  return split < 1
    ? undefined
    : { keyword: ascii(chunk.subarray(0, split)), value: decodeUtf8(chunk.subarray(split + 1)) ?? "" };
}
function pngCompressedText(chunk: Uint8Array): { keyword: string; value: string } | undefined {
  const split = chunk.indexOf(0);
  if (split < 1 || split + 2 > chunk.length) return undefined;
  const compressionMethod = chunk[split + 1];
  if (compressionMethod !== 0) return undefined;
  try {
    const payload = inflateSync(chunk.subarray(split + 2), { maxOutputLength: MAX_INPUT_BYTES });
    return { keyword: ascii(chunk.subarray(0, split)), value: decodeUtf8(payload) ?? "" };
  } catch {
    return undefined;
  }
}
function pngInternationalText(chunk: Uint8Array): { keyword: string; value: string } | undefined {
  const first = chunk.indexOf(0);
  if (first < 1 || first + 3 > chunk.length) return undefined;
  const compressed = chunk[first + 1] === 1;
  if (chunk[first + 2] !== 0) return undefined;
  let offset = first + 3;
  for (let fields = 0; fields < 2; fields++) {
    const end = chunk.indexOf(0, offset);
    if (end < offset) return undefined;
    offset = end + 1;
  }
  try {
    const payload = compressed
      ? inflateSync(chunk.subarray(offset), { maxOutputLength: MAX_INPUT_BYTES })
      : chunk.subarray(offset);
    return { keyword: ascii(chunk.subarray(0, first)), value: decodeUtf8(payload) ?? "" };
  } catch {
    return undefined;
  }
}
function hasSafeJsonShape(text: string): boolean {
  let depth = 0;
  let nodes = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      nodes++;
    } else if (char === "{" || char === "[") {
      if (++depth > MAX_JSON_DEPTH) return false;
    } else if (char === "}" || char === "]") depth--;
    if (nodes > MAX_JSON_NODES || depth < 0) return false;
  }
  return !quoted && depth === 0;
}
function rejected(source: "json" | "png", field: string, reason: string): StCardImportReport {
  return Object.freeze({ source, dispositions: Object.freeze([disposition(field, "rejected_invalid", reason)]) });
}
function disposition(
  field: string,
  classification: StCardImportClassification,
  reason: string,
): StCardImportDisposition {
  return Object.freeze({ field, classification, reason });
}
function extractCharacterBook(value: unknown, format: "st-v2" | "st-v3"): WorldBookEntry[] {
  if (
    !isRecord(value) ||
    !Array.isArray(value.entries) ||
    utf8Bytes(JSON.stringify(value)) > ST_CARD_DECODER_LIMITS_V1.characterBookBytes
  )
    return [];
  return value.entries.slice(0, ST_CARD_DECODER_LIMITS_V1.characterBookEntries).flatMap((raw, index) => {
    if (!isRecord(raw)) return [];
    const content = boundedMultilineText(raw.content, ST_CARD_DECODER_LIMITS_V1.characterBookEntryBytes);
    if (content === undefined) return [];
    const title =
      boundedText(raw.comment, ST_CARD_DECODER_LIMITS_V1.characterBookTitleBytes) ??
      boundedText(raw.name, ST_CARD_DECODER_LIMITS_V1.characterBookTitleBytes) ??
      `Imported background ${index + 1}`;
    return [
      Object.freeze({
        entryId: `st-${format}-${index + 1}`,
        title,
        content,
        scope: "setting" as const,
        provenance: "st-card-import" as const,
        tokenBudget: "small" as const,
      }),
    ];
  });
}
function parseExamples(value: string | undefined): readonly Readonly<{ user: string; companion: string }>[] {
  if (value === undefined) return [];
  return Object.freeze(
    value
      .split(/(?:<START>|\n{2,})/u)
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 4)
      .flatMap((part) => {
        const user = part
          .match(/(?:\{\{user\}\}|You|User)\s*:\s*([\s\S]*?)(?=(?:\{\{char\}\}|Character|Assistant)\s*:|$)/iu)?.[1]
          ?.trim();
        const companion = part
          .match(/(?:\{\{char\}\}|Character|Assistant)\s*:\s*([\s\S]*?)(?=(?:\{\{user\}\}|You|User)\s*:|$)/iu)?.[1]
          ?.trim();
        return user !== undefined &&
          companion !== undefined &&
          user.length > 0 &&
          companion.length > 0 &&
          user.length <= 512 &&
          companion.length <= 512
          ? [Object.freeze({ user, companion })]
          : [];
      }),
  );
}
function isUnsupported(key: string): boolean {
  return /^(?:system_prompt|post_history(?:_instructions)?|regex(?:es)?|macros?|stscript|script|quick_?repl(?:ies)?|html|extensions?|prompt_?order|creator_notes|alternate_greetings|presets?|remote(?:_resources?)?)$/iu.test(
    key,
  );
}
function idFromName(name: string, fallback: string): string {
  const id = name
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  return id.length > 0 ? `gamebuddy.companion.${id}` : fallback;
}
function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === "string" &&
    utf8Bytes(value) > 0 &&
    utf8Bytes(value) <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}
function boundedMultilineText(value: unknown, max: number): string | undefined {
  return typeof value === "string" &&
    utf8Bytes(value) > 0 &&
    utf8Bytes(value) <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}
function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
function decodeUtf8(value: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return undefined;
  }
}
function isPng(value: Uint8Array): boolean {
  return value.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => value[index] === byte);
}
function readU32(value: Uint8Array, offset: number): number {
  return ((value[offset]! << 24) >>> 0) + (value[offset + 1]! << 16) + (value[offset + 2]! << 8) + value[offset + 3]!;
}
function ascii(value: Uint8Array): string {
  return String.fromCharCode(...value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
