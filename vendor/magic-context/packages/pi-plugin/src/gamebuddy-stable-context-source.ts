import { createHash } from "node:crypto";

export type GameBuddyAuthoredSourceKind = "persona" | "scenario" | "dialogue_examples" | "lorebook_constant";
export type GameBuddyChatContextScope = Readonly<{
  continuityId: string; sessionId: string; surface: "tavern"; threadId: string;
  profile: Readonly<{ profileId: string; revision: number; canonicalHash: string }>;
}>;
export type GameBuddyAuthoredStableSource = Readonly<{
  sourceId: string; kind: GameBuddyAuthoredSourceKind; revision: string; canonicalHash: string;
  content: string; budgetTokens: number; totalOrderKey: string; provenance: string;
}>;
export type GameBuddyAuthoredStableCatalog = Readonly<{
  version: "gamebuddy-authored-context-catalog/v2"; scope: GameBuddyChatContextScope;
  canonicalHash: string; stableSources: readonly GameBuddyAuthoredStableSource[];
}>;
export type GameBuddyAuthoredStableSourceRef = Readonly<{
  sourceId: string; kind: GameBuddyAuthoredSourceKind; revision: string; canonicalHash: string; totalOrderKey: string;
}>;
export type GameBuddyAuthoredStablePlanProjection = Readonly<{
  sourceRefs: readonly GameBuddyAuthoredStableSourceRef[]; stableTokenCount: number;
}>;
export type GameBuddyAuthoredContextMaterialization = Readonly<{
  scope: GameBuddyChatContextScope; snapshotCanonicalHash: string; budgetTokens: number;
  sources: readonly GameBuddyAuthoredStableSource[]; renderedBlock: string;
}>;

export type GameBuddyStableContextSourceFailureCode = "invalid_catalog" | "binding_mismatch" | "hash_mismatch" | "unknown_source_kind" | "duplicate_effective_source";
export class GameBuddyStableContextSourceError extends Error { constructor(readonly code: GameBuddyStableContextSourceFailureCode, message: string) { super(message); this.name = "GameBuddyStableContextSourceError"; } }
export const GAMEBUDDY_AUTHORED_CONTEXT_CATALOG_VERSION = "gamebuddy-authored-context-catalog/v2" as const;
const kinds = new Set<GameBuddyAuthoredSourceKind>(["persona", "scenario", "dialogue_examples", "lorebook_constant"]);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
const fail = (c: GameBuddyStableContextSourceFailureCode, m: string): never => { throw new GameBuddyStableContextSourceError(c, m); };
const text = (v: unknown, field: string) => typeof v === "string" && v.length > 0 ? v : fail("invalid_catalog", `${field} must be non-empty`);
const hash = (v: unknown, field: string) => /^[a-f0-9]{64}$/.test(text(v, field)) ? v as string : fail("invalid_catalog", `${field} must be sha256`);
const freeze = <T>(v: T): T => { if (v && typeof v === "object") { Object.freeze(v); for (const x of Object.values(v as object)) freeze(x); } return v; };

export function validateGameBuddyAuthoredStableCatalog(value: unknown, expected: GameBuddyChatContextScope): GameBuddyAuthoredStableCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid_catalog", "catalog must be an object");
  const input = value as Record<string, unknown>;
  if (input.version !== GAMEBUDDY_AUTHORED_CONTEXT_CATALOG_VERSION) return fail("invalid_catalog", "unsupported catalog version");
  if (canonical(input.scope) !== canonical(expected)) return fail("binding_mismatch", "catalog scope mismatch");
  if (!Array.isArray(input.stableSources)) return fail("invalid_catalog", "stableSources must be an array");
  const sources = input.stableSources.map((raw) => {
    if (!raw || typeof raw !== "object") return fail("invalid_catalog", "source must be object");
    const r = raw as Record<string, unknown>; const kind = text(r.kind, "source.kind");
    if (!kinds.has(kind as GameBuddyAuthoredSourceKind)) return fail("unknown_source_kind", kind);
    const content = text(r.content, "source.content"); const contentHash = hash(r.canonicalHash, "source.canonicalHash");
    if (contentHash !== sha(content)) return fail("hash_mismatch", "source hash mismatch");
    if (!Number.isSafeInteger(r.budgetTokens) || (r.budgetTokens as number) <= 0) return fail("invalid_catalog", "invalid budget");
    return freeze({ sourceId: text(r.sourceId, "source.sourceId"), kind: kind as GameBuddyAuthoredSourceKind, revision: text(r.revision, "source.revision"), canonicalHash: contentHash, content, budgetTokens: r.budgetTokens as number, totalOrderKey: text(r.totalOrderKey, "source.totalOrderKey"), provenance: text(r.provenance, "source.provenance") });
  });
  const ids = new Set<string>();
  const orderKeys = new Set<string>();
  for (const s of sources) {
    const id = `${s.kind}\0${s.sourceId}`;
    if (ids.has(id)) return fail("duplicate_effective_source", id);
    ids.add(id);
    if (!/^[0-9]{4,}$/.test(s.totalOrderKey) || orderKeys.has(s.totalOrderKey))
      return fail("invalid_catalog", "source totalOrderKey must be unique and numeric");
    orderKeys.add(s.totalOrderKey);
  }
  const body = { version: GAMEBUDDY_AUTHORED_CONTEXT_CATALOG_VERSION, scope: expected, stableSources: sources };
  if (hash(input.canonicalHash, "catalog.canonicalHash") !== sha(canonical(body))) return fail("hash_mismatch", "catalog hash mismatch");
  return freeze({ ...body, canonicalHash: input.canonicalHash as string });
}
export function materializeGameBuddyAuthoredStableCatalog(value: unknown, scope: GameBuddyChatContextScope): GameBuddyAuthoredContextMaterialization {
  const catalog = validateGameBuddyAuthoredStableCatalog(value, scope);
  const sources = [...catalog.stableSources].sort((a,b) => `${a.totalOrderKey}\0${a.kind}\0${a.sourceId}\0${a.revision}\0${a.canonicalHash}`.localeCompare(`${b.totalOrderKey}\0${b.kind}\0${b.sourceId}\0${b.revision}\0${b.canonicalHash}`));
  const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const renderedBlock = `<gamebuddy-authored-context version="v2" continuity-id="${esc(scope.continuityId)}" session-id="${esc(scope.sessionId)}" thread-id="${esc(scope.threadId)}" canonical-hash="${catalog.canonicalHash}">\n${sources.map(s => `<gamebuddy-authored-source kind="${s.kind}" source-id="${esc(s.sourceId)}" revision="${esc(s.revision)}" canonical-hash="${s.canonicalHash}">\n${esc(s.content)}\n</gamebuddy-authored-source>`).join("\n")}\n</gamebuddy-authored-context>`;
  return freeze({ scope, snapshotCanonicalHash: catalog.canonicalHash, budgetTokens: sources.reduce((n,s) => n+s.budgetTokens, 0), sources, renderedBlock });
}

// Process-local renderer state. Only the construction-private bridge publishes entries;
// context-handler consumes them through this owner hook (never through the package root).
const authoredRenderer = new Map<string, GameBuddyAuthoredContextMaterialization>();
export function __gamebuddyReadAuthoredMaterialization(sessionId: string): GameBuddyAuthoredContextMaterialization | undefined {
  return authoredRenderer.get(sessionId);
}
export function __gamebuddyReplaceAuthoredMaterialization(sessionId: string, value: GameBuddyAuthoredContextMaterialization): void {
  authoredRenderer.set(sessionId, value);
}
export function __gamebuddyClearAuthoredMaterialization(sessionId: string, expected?: GameBuddyAuthoredContextMaterialization): void {
  if (expected === undefined || authoredRenderer.get(sessionId) === expected) authoredRenderer.delete(sessionId);
}

// These aliases are type-only seams used by the existing injector; no v1 runtime
// publication/read/clear API is retained.
export type GameBuddyStableContextMaterialization = GameBuddyAuthoredContextMaterialization;
export type GameBuddyStableContextSourceRecord = GameBuddyAuthoredStableSource;
