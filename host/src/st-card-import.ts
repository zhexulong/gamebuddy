import type { IdentityProfile } from "./identity-profile.js";
import type { WorldBook, WorldBookEntry } from "./worldbook.js";

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
 * Parses common ST V2/V3 JSON fields into a preview only. It performs no
 * import, no prompt positioning, and no script/regex/HTML/macro execution.
 * PNG/CHARX decoding remains an explicit file-import shell responsibility.
 */
export function previewStCard(value: unknown, fallbackProfileId = "gamebuddy.companion.imported"): StCardImportPreview {
  if (!isRecord(value)) throw new Error("invalid_st_card");
  const data = isRecord(value.data) ? value.data : value;
  const spec = typeof value.spec === "string" ? value.spec : typeof data.spec === "string" ? data.spec : undefined;
  const format = spec === "chara_card_v3" ? "st-v3" : "st-v2";
  const name = boundedText(data.name, 128) ?? "Imported Companion";
  const description = boundedText(data.description, 1_024);
  const personality = boundedText(data.personality, 1_024);
  const scenario = boundedText(data.scenario, 1_024);
  const greeting = boundedText(data.first_mes, 1_024) ?? boundedText(data.first_message, 1_024);
  const examples = parseExamples(boundedMultilineText(data.mes_example, 4_096));
  const profileId = idFromName(name, fallbackProfileId);
  const persona = description === undefined && personality === undefined ? undefined : Object.freeze({
    core: description ?? personality!,
    interactionStyle: personality ?? "Respect the player's agency and do not invent shared experiences.",
    expressionStyle: "Use natural player-facing language; do not use system or tool language.",
  });
  const worldBookCandidates = extractCharacterBook(data.character_book, format);
  const unsupportedFields = Object.keys(data).filter((key) => isUnsupported(key)).sort();
  return Object.freeze({
    format,
    profileCandidate: Object.freeze({
      profileId,
      identity: Object.freeze({ name, role: "the player's game companion", continuity: scenario ?? "Maintain one continuous shared experience with the player across chat and game surfaces." }),
      ...(persona === undefined ? {} : { persona }),
      examples: Object.freeze(examples),
      ...(greeting === undefined ? {} : { firstGreeting: greeting }),
    }),
    worldBookCandidates: Object.freeze(worldBookCandidates),
    unsupportedFields: Object.freeze(unsupportedFields),
  });
}

export function confirmStCardProfile(preview: StCardImportPreview, revision = 1): IdentityProfile {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("invalid_profile_revision");
  return Object.freeze({ schemaVersion: 1, profileId: preview.profileCandidate.profileId, revision, identity: preview.profileCandidate.identity, ...(preview.profileCandidate.persona === undefined ? {} : { persona: preview.profileCandidate.persona }), ...(preview.profileCandidate.examples.length === 0 ? {} : { examples: preview.profileCandidate.examples }) });
}

export function confirmStCardWorldBook(preview: StCardImportPreview, worldBookId: string, revision = 1): WorldBook {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(worldBookId) || !Number.isSafeInteger(revision) || revision < 1) throw new Error("invalid_worldbook_confirmation");
  return Object.freeze({ schemaVersion: 1, worldBookId, revision, alwaysOnPremise: "", entries: preview.worldBookCandidates });
}

function extractCharacterBook(value: unknown, format: "st-v2" | "st-v3"): WorldBookEntry[] {
  if (!isRecord(value) || !Array.isArray(value.entries)) return [];
  return value.entries.slice(0, 128).flatMap((raw, index) => {
    if (!isRecord(raw)) return [];
    const content = boundedText(raw.content, 4_000);
    if (content === undefined) return [];
    const title = boundedText(raw.comment, 256) ?? boundedText(raw.name, 256) ?? `Imported background ${index + 1}`;
    return [Object.freeze({ entryId: `st-${format}-${index + 1}`, title, content, scope: "setting" as const, provenance: "st-card-import" as const, tokenBudget: "small" as const })];
  });
}
function parseExamples(value: string | undefined): readonly Readonly<{ user: string; companion: string }>[] {
  if (value === undefined) return [];
  const pairs = value.split(/(?:<START>|\n{2,})/u).map((part) => part.trim()).filter(Boolean).slice(0, 4).flatMap((part) => {
    const user = part.match(/(?:\{\{user\}\}|You|User)\s*:\s*([^\n]+)/iu)?.[1]?.trim();
    const companion = part.match(/(?:\{\{char\}\}|Character|Assistant)\s*:\s*([^\n]+)/iu)?.[1]?.trim();
    return user !== undefined && companion !== undefined && user.length <= 512 && companion.length <= 512 ? [Object.freeze({ user, companion })] : [];
  });
  return Object.freeze(pairs);
}
function isUnsupported(key: string): boolean { return /^(?:system_prompt|post_history(?:_instructions)?|regex(?:es)?|macros?|stscript|script|quick_?repl(?:ies)?|html|extensions?|prompt_?order|creator_notes|alternate_greetings)$/iu.test(key); }
function idFromName(name: string, fallback: string): string { const id = name.toLocaleLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 96); return id.length > 0 ? `gamebuddy.companion.${id}` : fallback; }
function boundedText(value: unknown, max: number): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined; }
function boundedMultilineText(value: unknown, max: number): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(value) ? value : undefined; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
