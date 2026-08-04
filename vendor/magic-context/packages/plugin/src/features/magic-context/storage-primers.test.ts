/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { clearSession } from "./storage-meta-session";
import {
    createPrimer,
    getPrimerCandidatesForProject,
    insertPrimerCandidates,
    primerOccurrenceUtcDay,
    updatePrimerAnswer,
} from "./storage-primers";
import { bumpProjectMemoryEpoch, getProjectState } from "./storage-project-state";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("primer candidate storage", () => {
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
