import { createHash } from "node:crypto";

/**
 * The only GameBuddy-to-Magic-Context stable-context boundary.
 *
 * This module intentionally accepts immutable values only. It does not expose a
 * database, message, compartment, m[0], m[1], marker, cursor, or fold API.
 * It does not write Host messages or Magic Context storage. Its materialization
 * output is an immutable m[0]-compatible stable block consumed only by the Pi
 * context handler. Publication is explicit, per Pi session, and process-local:
 * neither Host nor this boundary writes Magic Context storage or messages.
 */
export const GAMEBUDDY_STABLE_CONTEXT_SOURCE_VERSION =
    "gamebuddy-stable-context-source/v1" as const;

export type GameBuddyStableContextSurface = "tavern";
export type GameBuddyStableContextSourceKind =
    | "persona"
    | "scenario"
    | "dialogue_examples"
    | "worldbook";

export interface GameBuddyStableContextBinding {
    continuityId: string;
    sessionId: string;
    surface: GameBuddyStableContextSurface;
}

export interface GameBuddyStableContextSourceRecord {
    sourceId: string;
    kind: GameBuddyStableContextSourceKind;
    revision: string;
    canonicalHash: string;
    content: string;
    budgetTokens: number;
    totalOrderKey: string;
    provenance: string;
}

export interface GameBuddyStableContextSnapshot extends GameBuddyStableContextBinding {
    version: typeof GAMEBUDDY_STABLE_CONTEXT_SOURCE_VERSION;
    canonicalHash: string;
    sources: readonly GameBuddyStableContextSourceRecord[];
}

export type GameBuddyStableContextSourceFailureCode =
    | "adapter_unavailable"
    | "invalid_snapshot"
    | "binding_mismatch"
    | "hash_mismatch"
    | "unknown_source_kind"
    | "duplicate_effective_source";

/**
 * Immutable, renderer-ready m[0] input. This deliberately contains text only:
 * it cannot create a message, mutate m[0]/m[1], or access SQLite.
 */
export interface GameBuddyStableContextMaterialization {
    binding: Readonly<GameBuddyStableContextBinding>;
    snapshotCanonicalHash: string;
    budgetTokens: number;
    /** Validated renderer input retained only by the Magic Context fork. */
    sources: readonly Readonly<GameBuddyStableContextSourceRecord>[];
    renderedBlock: string;
}

export class GameBuddyStableContextSourceError extends Error {
    constructor(
        readonly code: GameBuddyStableContextSourceFailureCode,
        message: string,
    ) {
        super(message);
        this.name = "GameBuddyStableContextSourceError";
    }
}

const SOURCE_KINDS = new Set<GameBuddyStableContextSourceKind>([
    "persona",
    "scenario",
    "dialogue_examples",
    "worldbook",
]);
const SHA256 = /^[a-f0-9]{64}$/;

function fail(code: GameBuddyStableContextSourceFailureCode, message: string): never {
    throw new GameBuddyStableContextSourceError(code, message);
}

function requireText(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
        fail("invalid_snapshot", `${field} must be a non-empty string`);
    }
    return value;
}

function requireHash(value: unknown, field: string): string {
    const hash = requireText(value, field);
    if (!SHA256.test(hash)) fail("invalid_snapshot", `${field} must be lowercase SHA-256`);
    return hash;
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function sha256(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function freeze<T>(value: T): T {
    if (value !== null && typeof value === "object") {
        Object.freeze(value);
        for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    }
    return value;
}

function parseSource(value: unknown): GameBuddyStableContextSourceRecord {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return fail("invalid_snapshot", "source must be an object");
    }
    const input = value as Record<string, unknown>;
    const kind = requireText(input.kind, "source.kind");
    if (!SOURCE_KINDS.has(kind as GameBuddyStableContextSourceKind)) {
        return fail("unknown_source_kind", `unsupported source kind: ${kind}`);
    }
    const budgetTokens = input.budgetTokens;
    if (
        typeof budgetTokens !== "number" ||
        !Number.isSafeInteger(budgetTokens) ||
        budgetTokens <= 0
    ) {
        return fail("invalid_snapshot", "source.budgetTokens must be a positive safe integer");
    }
    const content = requireText(input.content, "source.content");
    const canonicalHash = requireHash(input.canonicalHash, "source.canonicalHash");
    if (canonicalHash !== sha256(content)) {
        return fail("hash_mismatch", "source.canonicalHash does not match source.content");
    }
    return {
        sourceId: requireText(input.sourceId, "source.sourceId"),
        kind: kind as GameBuddyStableContextSourceKind,
        revision: requireText(input.revision, "source.revision"),
        canonicalHash,
        content,
        budgetTokens,
        totalOrderKey: requireText(input.totalOrderKey, "source.totalOrderKey"),
        provenance: requireText(input.provenance, "source.provenance"),
    };
}

/** Validates and deep-freezes a Host-owned canonical artifact snapshot. */
export function validateGameBuddyStableContextSnapshot(
    value: unknown,
    expectedBinding: GameBuddyStableContextBinding,
): Readonly<GameBuddyStableContextSnapshot> {
    const continuityId = requireText(expectedBinding.continuityId, "binding.continuityId");
    const sessionId = requireText(expectedBinding.sessionId, "binding.sessionId");
    if (expectedBinding.surface !== "tavern") {
        return fail("binding_mismatch", "active binding surface is unsupported");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return fail("invalid_snapshot", "snapshot must be an object");
    }
    const input = value as Record<string, unknown>;
    if (input.version !== GAMEBUDDY_STABLE_CONTEXT_SOURCE_VERSION) {
        return fail("invalid_snapshot", "unsupported snapshot version");
    }
    for (const field of ["continuityId", "sessionId", "surface"] as const) {
        if (input[field] !== expectedBinding[field]) {
            return fail("binding_mismatch", `snapshot ${field} does not match active binding`);
        }
    }
    if (!Array.isArray(input.sources)) {
        return fail("invalid_snapshot", "snapshot.sources must be an array");
    }
    const sources = input.sources.map(parseSource);
    const identities = new Set<string>();
    for (const source of sources) {
        const identity = `${source.kind}\u0000${source.sourceId}`;
        if (identities.has(identity)) {
            return fail("duplicate_effective_source", "duplicate source kind/sourceId");
        }
        identities.add(identity);
    }
    const canonicalHash = requireHash(input.canonicalHash, "snapshot.canonicalHash");
    const hashInput = {
        version: GAMEBUDDY_STABLE_CONTEXT_SOURCE_VERSION,
        continuityId,
        sessionId,
        surface: expectedBinding.surface,
        sources,
    };
    if (canonicalHash !== sha256(canonicalJson(hashInput))) {
        return fail(
            "hash_mismatch",
            "snapshot.canonicalHash does not match canonical snapshot content",
        );
    }
    return freeze({ ...hashInput, canonicalHash, sources });
}

function escapeXmlText(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeXmlAttribute(value: string): string {
    return escapeXmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/**
 * Validate an untrusted Host artifact and render it into a deterministic,
 * immutable stable m[0] block. Source content is XML-escaped, never interpreted
 * as messages, scripts, HTML, or a database command.
 */
export function materializeGameBuddyStableContextSnapshot(
    value: unknown,
    expectedBinding: GameBuddyStableContextBinding,
): Readonly<GameBuddyStableContextMaterialization> {
    const snapshot = validateGameBuddyStableContextSnapshot(value, expectedBinding);
    const sources = [...snapshot.sources].sort((left, right) => {
        const leftKey = `${left.totalOrderKey}\u0000${left.kind}\u0000${left.sourceId}\u0000${left.revision}\u0000${left.canonicalHash}`;
        const rightKey = `${right.totalOrderKey}\u0000${right.kind}\u0000${right.sourceId}\u0000${right.revision}\u0000${right.canonicalHash}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const renderedSources = sources.map(
        (source) =>
            `<gamebuddy-stable-source kind="${source.kind}" source-id="${escapeXmlAttribute(source.sourceId)}" revision="${escapeXmlAttribute(source.revision)}" canonical-hash="${source.canonicalHash}" budget-tokens="${source.budgetTokens}" total-order-key="${escapeXmlAttribute(source.totalOrderKey)}" provenance="${escapeXmlAttribute(source.provenance)}">\n${escapeXmlText(source.content)}\n</gamebuddy-stable-source>`,
    );
    const renderedBlock = `<gamebuddy-stable-context version="${GAMEBUDDY_STABLE_CONTEXT_SOURCE_VERSION}" continuity-id="${escapeXmlAttribute(snapshot.continuityId)}" session-id="${escapeXmlAttribute(snapshot.sessionId)}" surface="${snapshot.surface}" canonical-hash="${snapshot.canonicalHash}">\n${renderedSources.join("\n")}\n</gamebuddy-stable-context>`;
    return freeze({
        binding: { ...expectedBinding },
        snapshotCanonicalHash: snapshot.canonicalHash,
        budgetTokens: sources.reduce((total, source) => total + source.budgetTokens, 0),
        sources,
        renderedBlock,
    });
}

/** Controlled in-process boundary for replacing and materializing snapshots. */
const publishedSourcesByPiSession = new Map<
    string,
    Readonly<GameBuddyStableContextMaterialization>
>();

/**
 * Publish one verified Tavern snapshot for the exact live Pi session named by
 * its binding. Re-publishing that binding atomically replaces the effective
 * source set; an empty `sources` array is the explicit tombstone state.
 */
export function publishGameBuddyStableContextSnapshot(
    binding: GameBuddyStableContextBinding,
    value: unknown,
): Readonly<GameBuddyStableContextMaterialization> {
    const materialization = materializeGameBuddyStableContextSnapshot(value, binding);
    publishedSourcesByPiSession.set(binding.sessionId, materialization);
    return materialization;
}

/**
 * Returns a materialization only for its exact live Pi session. Callers must
 * not infer a binding from cwd, project identity, or another session.
 */
export function readPublishedGameBuddyStableContext(
    sessionId: string,
): Readonly<GameBuddyStableContextMaterialization> | undefined {
    return publishedSourcesByPiSession.get(sessionId);
}

/** Remove a session-scoped publication when its Pi session is disposed. */
export function clearPublishedGameBuddyStableContext(sessionId: string): void {
    publishedSourcesByPiSession.delete(sessionId);
}

export class GameBuddyStableContextSource {
    readonly materializationStatus = "available" as const;
    #snapshot: Readonly<GameBuddyStableContextSnapshot> | undefined;

    readonly binding: Readonly<GameBuddyStableContextBinding>;

    constructor(binding: GameBuddyStableContextBinding) {
        this.binding = freeze({ ...binding });
    }

    replaceSnapshot(value: unknown): void {
        this.#snapshot = validateGameBuddyStableContextSnapshot(value, this.binding);
    }

    readSnapshot(): Readonly<GameBuddyStableContextSnapshot> {
        if (!this.#snapshot) {
            return fail("adapter_unavailable", "no verified stable-context snapshot is available");
        }
        return this.#snapshot;
    }

    materialize(): Readonly<GameBuddyStableContextMaterialization> {
        return materializeGameBuddyStableContextSnapshot(this.readSnapshot(), this.binding);
    }
}
