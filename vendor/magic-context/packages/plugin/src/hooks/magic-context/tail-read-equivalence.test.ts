/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    buildInMemoryTailRawMessages,
    readRawSessionMessagesFromDb,
    readRawSessionTailFromDb,
} from "./read-session-raw";
import { buildTrueRawTokenIndex, computeRawRangeFingerprint } from "./read-session-true-raw-tokens";

// Locks the O(tail) protected-tail read: reading only the messages after the
// last compartment boundary (anchored at the marker) must produce the exact same
// boundary inputs as reading the whole session. Two invariants:
//   1. readRawSessionTailFromDb == the full reader's tail slice (ids, absolute
//      ordinals, parts, version) and reports the correct absolute count.
//   2. buildTrueRawTokenIndex over the tail slice (with absoluteMessageCount)
//      gives byte-identical offset-forward results vs the full-array index.

function makeDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    `);
    return db;
}

interface Msg {
    id: string;
    role: string;
    summary?: boolean;
    finish?: string;
    parts: Array<Record<string, unknown>>;
}

function seed(db: Database, sessionId: string, messages: Msg[]): void {
    const insM = db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    const insP = db.prepare(
        "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    messages.forEach((m, i) => {
        const t = i + 1;
        const data: Record<string, unknown> = { id: m.id, role: m.role, sessionID: sessionId };
        if (m.summary !== undefined) data.summary = m.summary;
        if (m.finish !== undefined) data.finish = m.finish;
        insM.run(m.id, sessionId, t, t, JSON.stringify(data));
        for (const p of m.parts) insP.run(m.id, sessionId, t, t, JSON.stringify(p));
    });
}

function buildSession(n: number): Msg[] {
    const out: Msg[] = [];
    for (let i = 1; i <= n; i += 1) {
        const role = i % 2 === 1 ? "user" : "assistant";
        out.push({
            id: `m-${String(i).padStart(4, "0")}`,
            role,
            parts: [
                { type: "text", text: `message ${i} ${"lorem ipsum ".repeat((i % 5) + 1)}` },
                ...(role === "assistant"
                    ? [
                          {
                              type: "tool",
                              callID: `c-${i}`,
                              state: { input: { x: i }, output: `out ${i}`.repeat(i % 3) },
                          },
                      ]
                    : []),
            ],
        });
    }
    return out;
}

describe("tail read equivalence (O(tail) protected-tail read)", () => {
    const SES = "ses-tail";

    it("tail reader matches the full reader's tail slice + reports correct absolute count", () => {
        const db = makeDb();
        try {
            seed(db, SES, buildSession(40));
            const full = readRawSessionMessagesFromDb(db, SES);
            expect(full.length).toBe(40);

            // Pretend the last compartment ended at ordinal 30 (anchor = the
            // message at that ordinal).
            const base = 30;
            const anchorId = full[base - 1].id;
            const tail = readRawSessionTailFromDb(db, SES, base, anchorId);
            expect(tail).not.toBeNull();
            if (!tail) return;

            // Absolute count == what the full reader produced.
            expect(tail.absoluteMessageCount).toBe(full.length);

            // The tail slice == full[base-1 ..] (inclusive of the anchor),
            // identical ids / absolute ordinals / parts / version.
            const expected = full.slice(base - 1);
            expect(tail.messages.length).toBe(expected.length);
            for (let i = 0; i < expected.length; i += 1) {
                expect(tail.messages[i].id).toBe(expected[i].id);
                expect(tail.messages[i].ordinal).toBe(expected[i].ordinal);
                expect(tail.messages[i].role).toBe(expected[i].role);
                expect(JSON.stringify(tail.messages[i].parts)).toBe(
                    JSON.stringify(expected[i].parts),
                );
            }
            // First tail ordinal is the anchor's absolute ordinal (== base).
            expect(tail.messages[0].ordinal).toBe(base);
        } finally {
            closeQuietly(db);
        }
    });

    it("ordinal-base index over the tail slice == full-array index for every offset-forward query", () => {
        const db = makeDb();
        try {
            seed(db, SES, buildSession(50));
            const full = readRawSessionMessagesFromDb(db, SES);
            const base = 38;
            const anchorId = full[base - 1].id;
            const tail = readRawSessionTailFromDb(db, SES, base, anchorId);
            if (!tail) throw new Error("tail null");

            const opts = { providerShapeVersion: "opencode-v1" as const, cacheNamespace: "t" };
            const fullIdx = buildTrueRawTokenIndex(SES, full, { ...opts, cacheNamespace: "full" });
            const tailIdx = buildTrueRawTokenIndex(SES, tail.messages, {
                ...opts,
                cacheNamespace: "tail",
                absoluteMessageCount: tail.absoluteMessageCount,
            });

            // Absolute count matches.
            expect(tailIdx.rawMessageCount).toBe(fullIdx.rawMessageCount);

            const offset = base; // offset-forward queries start at the boundary
            for (let o = offset; o <= full.length + 1; o += 1) {
                expect(tailIdx.tokenForOrdinal(o)).toBe(fullIdx.tokenForOrdinal(o));
                expect(tailIdx.messageIdAtOrdinal(o)).toBe(fullIdx.messageIdAtOrdinal(o));
                expect(tailIdx.suffixTokensFromOrdinal(o)).toBe(fullIdx.suffixTokensFromOrdinal(o));
            }
            // findSuffixStartForTokens can return a cut BELOW the offset when the
            // requested token target exceeds the eligible-tail total (it would
            // need pre-boundary messages). The boundary resolver always clamps
            // this via `Math.max(boundary, runtimeFloor)` with runtimeFloor >=
            // offset, so the contract that matters is "equal AFTER clamping to
            // offset" — which holds because for any cut >= offset the full and
            // tail prefix differences are identical (the pre-offset sum cancels).
            for (const tokens of [1, 500, 2_000, 10_000, 100_000]) {
                expect(Math.max(offset, tailIdx.findSuffixStartForTokens(tokens))).toBe(
                    Math.max(offset, fullIdx.findSuffixStartForTokens(tokens)),
                );
            }
            for (let s = offset; s < full.length; s += 3) {
                expect(tailIdx.rangeTokens(s, full.length + 1)).toBe(
                    fullIdx.rangeTokens(s, full.length + 1),
                );
                expect(tailIdx.findHeadEndForCap(s, full.length + 1, 3_000)).toBe(
                    fullIdx.findHeadEndForCap(s, full.length + 1, 3_000),
                );
            }
        } finally {
            closeQuietly(db);
        }
    });

    it("returns null when the anchor message id is missing (caller falls back to full read)", () => {
        const db = makeDb();
        try {
            seed(db, SES, buildSession(10));
            expect(readRawSessionTailFromDb(db, SES, 5, "does-not-exist")).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    it("in-memory tail (args.messages view) == DB tail reader for all boundary inputs", () => {
        const db = makeDb();
        try {
            const msgs = buildSession(40);
            seed(db, SES, msgs);
            const full = readRawSessionMessagesFromDb(db, SES);
            const base = 30;
            const anchorId = full[base - 1].id;
            const dbTail = readRawSessionTailFromDb(db, SES, base, anchorId);
            if (!dbTail) throw new Error("tail null");

            // Simulate the transform's args.messages: OpenCode hands the
            // post-marker tail (anchor onward) as in-memory objects.
            const views = msgs.slice(base - 1).map((m) => ({
                id: m.id,
                role: m.role,
                parts: m.parts.map((part) => ({
                    ...part,
                    transientRuntimeOnly: "ignored by boundary fingerprint",
                })),
                summary: m.summary,
                finish: m.finish,
            }));
            const mem = buildInMemoryTailRawMessages({
                messages: views,
                lastCompartmentEnd: base,
                anchorMessageId: anchorId,
            });
            if (!mem) throw new Error("mem null");
            expect(mem.anchorFound).toBe(true);
            expect(mem.absoluteMessageCount).toBe(dbTail.absoluteMessageCount);
            expect(mem.messages.length).toBe(dbTail.messages.length);
            for (let i = 0; i < dbTail.messages.length; i += 1) {
                expect(mem.messages[i].id).toBe(dbTail.messages[i].id);
                expect(mem.messages[i].ordinal).toBe(dbTail.messages[i].ordinal);
                expect(mem.messages[i].parts.length).toBe(dbTail.messages[i].parts.length);
            }

            // Token index byte-identity over both sources.
            const opts = { providerShapeVersion: "opencode-v1" as const };
            const dbIdx = buildTrueRawTokenIndex(SES, dbTail.messages, {
                ...opts,
                cacheNamespace: "eq-db",
                absoluteMessageCount: dbTail.absoluteMessageCount,
            });
            const memIdx = buildTrueRawTokenIndex(SES, mem.messages, {
                ...opts,
                cacheNamespace: "eq-mem",
                absoluteMessageCount: mem.absoluteMessageCount,
            });
            for (let o = base; o <= full.length + 1; o += 1) {
                expect(memIdx.tokenForOrdinal(o)).toBe(dbIdx.tokenForOrdinal(o));
                expect(memIdx.suffixTokensFromOrdinal(o)).toBe(dbIdx.suffixTokensFromOrdinal(o));
            }

            // Content-stable fingerprint identity (the staleness check must not
            // reject a memory-derived snapshot when revalidating from the DB).
            expect(computeRawRangeFingerprint(mem.messages, base, full.length + 1)).toBe(
                computeRawRangeFingerprint(dbTail.messages, base, full.length + 1),
            );
        } finally {
            closeQuietly(db);
        }
    });

    it("in-memory converter: marker lag drops the pre-anchor prefix; anchor-absent returns anchorFound=false; no-compartment starts at 1", () => {
        const msgs = buildSession(12);
        // Marker lag: args.messages starts BEFORE the anchor (extra older rows).
        const anchorIdx = 4; // anchor = 5th message
        const lagged = msgs.map((m) => ({ id: m.id, role: m.role, parts: m.parts }));
        const laggedResult = buildInMemoryTailRawMessages({
            messages: lagged,
            lastCompartmentEnd: 200, // arbitrary absolute ordinal of the anchor
            anchorMessageId: msgs[anchorIdx].id,
        });
        if (!laggedResult) throw new Error("lagged null");
        expect(laggedResult.anchorFound).toBe(true);
        // Anchor keeps its absolute ordinal; the pre-anchor prefix is dropped.
        expect(laggedResult.messages[0].id).toBe(msgs[anchorIdx].id);
        expect(laggedResult.messages[0].ordinal).toBe(200);
        expect(laggedResult.messages.length).toBe(msgs.length - anchorIdx);
        expect(laggedResult.absoluteMessageCount).toBe(200 + (msgs.length - anchorIdx) - 1);

        // Anchor absent → anchorFound=false (caller falls back to DB path).
        const absent = buildInMemoryTailRawMessages({
            messages: lagged,
            lastCompartmentEnd: 200,
            anchorMessageId: "missing-anchor",
        });
        if (!absent) throw new Error("absent null");
        expect(absent.anchorFound).toBe(false);

        // No-compartment session: ordinals from 1 over the whole array.
        const fresh = buildInMemoryTailRawMessages({
            messages: lagged,
            lastCompartmentEnd: 0,
            anchorMessageId: null,
        });
        if (!fresh) throw new Error("fresh null");
        expect(fresh.messages[0].ordinal).toBe(1);
        expect(fresh.absoluteMessageCount).toBe(msgs.length);

        // Summary rows are filtered BEFORE ordinal assignment; malformed rows
        // keep their ordinal slot without an element (DB reader contract).
        const withNoise = [
            { id: "n-1", role: "user", parts: [{ type: "text", text: "a" }] },
            { id: "n-sum", role: "assistant", summary: true, finish: "stop", parts: [] },
            { id: "", role: "assistant", parts: [{ type: "text", text: "malformed" }] },
            { id: "n-2", role: "assistant", parts: [{ type: "text", text: "b" }] },
        ];
        const noisy = buildInMemoryTailRawMessages({
            messages: withNoise,
            lastCompartmentEnd: 0,
            anchorMessageId: null,
        });
        if (!noisy) throw new Error("noisy null");
        expect(noisy.messages.map((m) => m.id)).toEqual(["n-1", "n-2"]);
        expect(noisy.messages.map((m) => m.ordinal)).toEqual([1, 3]);
        expect(noisy.absoluteMessageCount).toBe(3);
    });

    it("skips compaction-summary rows in the tail identically to the full reader", () => {
        const db = makeDb();
        try {
            seed(db, SES, [
                ...buildSession(5),
                { id: "m-sum", role: "assistant", summary: true, finish: "stop", parts: [] },
                { id: "m-0007", role: "user", parts: [{ type: "text", text: "after marker" }] },
                { id: "m-0008", role: "assistant", parts: [{ type: "text", text: "reply" }] },
            ]);
            const full = readRawSessionMessagesFromDb(db, SES);
            // Summary row filtered → 7 real messages, contiguous ordinals 1..7.
            expect(full.length).toBe(7);
            expect(full.some((m) => m.id === "m-sum")).toBe(false);

            const base = 5;
            const anchorId = full[base - 1].id;
            const tail = readRawSessionTailFromDb(db, SES, base, anchorId);
            if (!tail) throw new Error("tail null");
            expect(tail.absoluteMessageCount).toBe(7);
            // tail = ordinals 5,6,7 (anchor inclusive), summary excluded.
            expect(tail.messages.map((m) => m.ordinal)).toEqual([5, 6, 7]);
            expect(tail.messages.some((m) => m.id === "m-sum")).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });
});
