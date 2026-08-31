/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { clearSession } from "./storage-meta-session";
import {
    createPrimer,
    getActivePrimers,
    getPrimerCandidatesForProject,
    insertPrimerCandidates,
    primerOccurrenceUtcDay,
    updatePrimerAnswer,
    updatePrimerSupport,
} from "./storage-primers";
import { bumpProjectMemoryEpoch, getProjectState } from "./storage-project-state";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("primer candidate storage", () => {
    it("retains scoped candidate provenance after promotion and candidate deletion", () => {
        const db = freshDb();
        const [candidateId] = insertPrimerCandidates(db, [
            {
                projectPath: "git:abc",
                harness: "pi",
                sessionId: "ses_source",
                question: "How does cache work?",
                sourceCompartmentStart: 2,
                sourceCompartmentEnd: 7,
                sourceStartMessageId: "msg_2",
                sourceEndMessageId: "msg_7",
                sourceMessageTime: Date.UTC(2026, 0, 1),
            },
        ]);

        db.transaction(() => {
            createPrimer(db, {
                projectPath: "git:abc",
                question: "How does cache work?",
                totalSupport: 1,
                lastObservedAt: Date.UTC(2026, 0, 1),
                sourceCandidateIds: [candidateId],
            });
            db.prepare("DELETE FROM primer_candidates WHERE id = ?").run(candidateId);
        })();

        expect(getPrimerCandidatesForProject(db, "git:abc")).toHaveLength(0);
        expect(getActivePrimers(db, "git:abc")[0].sourceProvenance).toEqual([
            {
                candidateId,
                projectPath: "git:abc",
                harness: "pi",
                sessionId: "ses_source",
                sourceCompartmentStart: 2,
                sourceCompartmentEnd: 7,
                sourceStartMessageId: "msg_2",
                sourceEndMessageId: "msg_7",
            },
        ]);
    });

    it("preserves prior provenance while adding support from a new candidate", () => {
        const db = freshDb();
        const firstSource = {
            projectPath: "git:abc",
            harness: "opencode",
            sessionId: "ses_first",
            question: "How does cache work?",
            sourceStartMessageId: "msg_1",
            sourceEndMessageId: "msg_3",
            sourceMessageTime: Date.UTC(2026, 0, 1),
        };
        const [firstCandidateId] = insertPrimerCandidates(db, [firstSource]);
        const primerId = createPrimer(db, {
            projectPath: "git:abc",
            question: firstSource.question,
            totalSupport: 1,
            lastObservedAt: firstSource.sourceMessageTime,
            sourceCandidateIds: [firstCandidateId],
        });
        db.prepare("DELETE FROM primer_candidates WHERE id = ?").run(firstCandidateId);
        const [secondCandidateId] = insertPrimerCandidates(db, [
            {
                ...firstSource,
                sessionId: "ses_second",
                sourceStartMessageId: "msg_8",
                sourceEndMessageId: "msg_10",
                sourceMessageTime: Date.UTC(2026, 0, 8),
            },
        ]);

        db.transaction(() => {
            updatePrimerSupport(db, {
                primerId,
                totalSupport: 2,
                lastObservedAt: Date.UTC(2026, 0, 8),
                sourceCandidateIds: [firstCandidateId, secondCandidateId],
            });
            db.prepare("DELETE FROM primer_candidates WHERE id = ?").run(secondCandidateId);
        })();

        expect(getActivePrimers(db, "git:abc")[0].sourceProvenance).toEqual([
            expect.objectContaining({ candidateId: firstCandidateId, sessionId: "ses_first" }),
            expect.objectContaining({ candidateId: secondCandidateId, sessionId: "ses_second" }),
        ]);
    });

    it("reports legacy bare candidate ids as unknown provenance", () => {
        const db = freshDb();
        db.prepare(
            `INSERT INTO primers
                (project_path, question, answer, status, total_support, source_candidate_ids, created_at, updated_at)
             VALUES (?, ?, '', 'active', 1, ?, 1, 1)`,
        ).run("git:legacy", "How did this work?", "[73]");

        const [primer] = getActivePrimers(db, "git:legacy");
        expect(primer.sourceCandidateIds).toEqual([73]);
        expect(primer.sourceProvenance).toBeNull();
    });

    it("upserts on the stable source occurrence key, not normalized question", () => {
        const db = freshDb();
        const base = {
            projectPath: "git:abc",
            harness: "opencode",
            sessionId: "ses_1",
            sourceCompartmentStart: 1,
            sourceCompartmentEnd: 5,
            sourceStartMessageId: "msg_1",
            sourceEndMessageId: "msg_5",
            sourceMessageTime: Date.UTC(2026, 0, 1),
        };

        insertPrimerCandidates(db, [{ ...base, question: "How does cache work?" }]);
        insertPrimerCandidates(db, [
            {
                ...base,
                question: "How is prompt caching structured?",
                normalizedQuestion: "different normalized hint",
            },
        ]);

        const rows = getPrimerCandidatesForProject(db, "git:abc");
        expect(rows).toHaveLength(1);
        expect(rows[0].question).toBe("How is prompt caching structured?");
        expect(rows[0].normalizedQuestion).toBe("different normalized hint");
    });

    it("clearSession deletes session-scoped primer candidates", () => {
        const db = freshDb();
        insertPrimerCandidates(db, [
            {
                projectPath: "git:abc",
                harness: "pi",
                sessionId: "ses_private",
                question: "How does private state work?",
                sourceStartMessageId: "a",
                sourceEndMessageId: "b",
                sourceMessageTime: Date.UTC(2026, 0, 1),
            },
        ]);

        clearSession(db, "ses_private");

        expect(getPrimerCandidatesForProject(db, "git:abc")).toHaveLength(0);
    });

    it("uses fixed UTC calendar days for recurrence", () => {
        expect(primerOccurrenceUtcDay(Date.UTC(2026, 0, 1, 23, 59))).toBe("2026-01-01");
        expect(primerOccurrenceUtcDay(Date.UTC(2026, 0, 2, 0, 1))).toBe("2026-01-02");
    });

    it("updatePrimerAnswer is cache-neutral: no epoch bump, no mutation-log row", () => {
        const db = freshDb();
        // Seed an epoch row so a bump would be observable.
        bumpProjectMemoryEpoch(db, "git:abc");
        const epochBefore = getProjectState(db, "git:abc")?.project_memory_epoch ?? 0;
        const mutationsBefore = (
            db.prepare("SELECT COUNT(*) AS n FROM memory_mutation_log").get() as { n: number }
        ).n;

        const primerId = createPrimer(db, {
            projectPath: "git:abc",
            question: "How does the cache split work?",
            totalSupport: 2,
            lastObservedAt: Date.UTC(2026, 0, 8),
            sourceCandidateIds: [1, 2],
        });
        updatePrimerAnswer(db, primerId, "An answer grounded in current source.");

        // The whole reason refresh-primers must use the locked no-ctx_memory
        // investigator: a primer answer write must NEVER touch the project memory
        // epoch (which busts m[0]) or the supersede-delta mutation log (m[1]).
        expect(getProjectState(db, "git:abc")?.project_memory_epoch ?? 0).toBe(epochBefore);
        expect(
            (db.prepare("SELECT COUNT(*) AS n FROM memory_mutation_log").get() as { n: number }).n,
        ).toBe(mutationsBefore);
    });
});
