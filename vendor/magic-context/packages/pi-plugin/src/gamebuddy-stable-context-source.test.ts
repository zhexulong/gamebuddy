import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
    GAMEBUDDY_STABLE_CONTEXT_SOURCE_VERSION,
    GameBuddyStableContextSource,
    GameBuddyStableContextSourceError,
    materializeGameBuddyStableContextSnapshot,
    publishGameBuddyStableContextSnapshot,
    readPublishedGameBuddyStableContext,
    clearPublishedGameBuddyStableContext,
    validateGameBuddyStableContextSnapshot,
} from "./gamebuddy-stable-context-source";
import { renderM0Pi } from "./inject-compartments-pi";
import { createTestDb } from "./test-utils.test";

const binding = {
    continuityId: "continuity-opaque",
    sessionId: "session-opaque",
    surface: "tavern" as const,
};
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const canonicalJson = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
};

function snapshot(overrides: Record<string, unknown> = {}) {
    const sources = [
        {
            sourceId: "scenario-1",
            kind: "scenario",
            revision: "1",
            content: "A quiet tavern.",
            canonicalHash: hash("A quiet tavern."),
            budgetTokens: 100,
            totalOrderKey: "0001",
            provenance: "tavern/scenario/1",
        },
    ];
    const body = {
        version: GAMEBUDDY_STABLE_CONTEXT_SOURCE_VERSION,
        ...binding,
        sources,
        ...overrides,
    };
    return {
        ...body,
        canonicalHash:
            typeof overrides.canonicalHash === "string"
                ? overrides.canonicalHash
                : hash(canonicalJson(body)),
    };
}

describe("GameBuddyStableContextSource", () => {
    it("accepts a bound, canonical snapshot and deep-freezes its boundary value", () => {
        const value = validateGameBuddyStableContextSnapshot(snapshot(), binding);
        expect(Object.isFrozen(value)).toBe(true);
        expect(Object.isFrozen(value.sources)).toBe(true);
        expect(Object.isFrozen(value.sources[0])).toBe(true);
        expect(() => ((value.sources[0] as { content: string }).content = "mutated")).toThrow();
    });

    it("publishes, reads, replaces, and clears exact session-scoped snapshots", () => {
        const firstBinding = { ...binding, sessionId: "publication-session-a" };
        const secondBinding = { ...binding, sessionId: "publication-session-b" };
        try {
            const first = publishGameBuddyStableContextSnapshot(firstBinding, snapshot(firstBinding));
            const second = publishGameBuddyStableContextSnapshot(secondBinding, snapshot(secondBinding));
            expect(readPublishedGameBuddyStableContext(firstBinding.sessionId)).toBe(first);
            expect(readPublishedGameBuddyStableContext(secondBinding.sessionId)).toBe(second);
            expect(readPublishedGameBuddyStableContext(firstBinding.sessionId)?.binding).toEqual(firstBinding);

            const tombstone = publishGameBuddyStableContextSnapshot(
                firstBinding,
                snapshot({ ...firstBinding, sources: [] }),
            );
            expect(tombstone.sources).toEqual([]);
            expect(readPublishedGameBuddyStableContext(firstBinding.sessionId)).toBe(tombstone);
            expect(readPublishedGameBuddyStableContext(secondBinding.sessionId)).toBe(second);

            clearPublishedGameBuddyStableContext(firstBinding.sessionId);
            expect(readPublishedGameBuddyStableContext(firstBinding.sessionId)).toBeUndefined();
            expect(readPublishedGameBuddyStableContext(secondBinding.sessionId)).toBe(second);
        } finally {
            clearPublishedGameBuddyStableContext(firstBinding.sessionId);
            clearPublishedGameBuddyStableContext(secondBinding.sessionId);
        }
    });

    it("fails closed for missing adapters, binding mismatch, hash mismatch, and unknown kinds", () => {
        const adapter = new GameBuddyStableContextSource(binding);
        expect(() => adapter.readSnapshot()).toThrow(GameBuddyStableContextSourceError);
        expect(() =>
            materializeGameBuddyStableContextSnapshot(snapshot(), {
                ...binding,
                surface: "invalid" as "tavern",
            }),
        ).toThrow("active binding surface is unsupported");
        expect(() =>
            validateGameBuddyStableContextSnapshot(snapshot({ sessionId: "other" }), binding),
        ).toThrow("does not match active binding");
        expect(() =>
            validateGameBuddyStableContextSnapshot(snapshot({ continuityId: "other" }), binding),
        ).toThrow("does not match active binding");
        expect(() =>
            materializeGameBuddyStableContextSnapshot(snapshot({ continuityId: "other" }), binding),
        ).toThrow("does not match active binding");
        expect(() =>
            validateGameBuddyStableContextSnapshot(
                snapshot({ canonicalHash: "0".repeat(64) }),
                binding,
            ),
        ).toThrow("does not match canonical snapshot content");
        const invalid = snapshot();
        (invalid.sources[0] as { kind: string }).kind = "untrusted";
        expect(() => validateGameBuddyStableContextSnapshot(invalid, binding)).toThrow(
            "unsupported source kind",
        );
    });

    it("renders approved Tavern stable sources deterministically without message or SQLite access", () => {
        const first = snapshot();
        const second = snapshot();
        second.sources = [
            {
                sourceId: "persona-1",
                kind: "persona",
                revision: "2",
                content: "<trusted & immutable>",
                canonicalHash: hash("<trusted & immutable>"),
                budgetTokens: 50,
                totalOrderKey: "0000",
                provenance: "tavern/persona/2",
            },
            ...first.sources,
        ];
        const body = {
            version: GAMEBUDDY_STABLE_CONTEXT_SOURCE_VERSION,
            ...binding,
            sources: second.sources,
        };
        second.canonicalHash = hash(canonicalJson(body));

        const materialized = materializeGameBuddyStableContextSnapshot(second, binding);
        const adapter = new GameBuddyStableContextSource(binding);
        adapter.replaceSnapshot(second);
        expect(adapter.materializationStatus).toBe("available");
        expect(adapter.materialize()).toEqual(materialized);
        expect(materialized.renderedBlock).toContain('kind="persona"');
        expect(materialized.renderedBlock.indexOf('kind="persona"')).toBeLessThan(
            materialized.renderedBlock.indexOf('kind="scenario"'),
        );
        expect(materialized.renderedBlock).toContain("&lt;trusted &amp; immutable&gt;");
        expect(materialized.budgetTokens).toBe(150);
        expect(Object.isFrozen(materialized)).toBe(true);
        expect(Object.keys(adapter).sort()).toEqual(["binding", "materializationStatus"]);
    });

    it("materializes the validated block as an m[0] sibling without synthetic messages or storage writes", () => {
        const db = createTestDb();
        try {
            const stableContext = materializeGameBuddyStableContextSnapshot(snapshot(), binding);
            const m0 = renderM0Pi(
                {
                    sessionId: binding.sessionId,
                    projectIdentity: "gamebuddy-test",
                    projectDirectory: process.cwd(),
                    stableContext,
                },
                db,
                "",
            );
            expect(m0).toContain(stableContext.renderedBlock);
            expect(m0).toContain("<session-history></session-history>");
        } finally {
            db.close();
        }
    });
});
