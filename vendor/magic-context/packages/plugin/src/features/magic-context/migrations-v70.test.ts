/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database, type Database as DatabaseType } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

// The exact stranded shape from issue #246: a model (deepseek-v4-flash-free)
// closed <p1> with </p2>. The old strict tier regex missed P1, so the whole tier
// markup landed in `content` with p1 NULL and legacy=1.
const MANGLED_INNER = "<p1>\nfull narrative\n</p2>\n<p2>condensed</p2><p3>outcome</p3><p4/>";

interface CompartmentRow {
    id: number;
    content: string;
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
    legacy: number;
}

interface RecompRow {
    id: number;
    content: string;
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
}

function plantStrandedRows(db: DatabaseType): { compartmentId: number; recompId: number } {
    const compartmentId = Number(
        (
            db
                .prepare(
                    `INSERT INTO compartments
                        (session_id, sequence, start_message, end_message, title, content, legacy, p1, created_at)
                     VALUES ('ses-heal', 1, 1, 2, 'mangled', ?, 1, NULL, 1000)`,
                )
                .run(MANGLED_INNER) as { lastInsertRowid: number | bigint }
        ).lastInsertRowid,
    );
    const recompId = Number(
        (
            db
                .prepare(
                    `INSERT INTO recomp_compartments
                        (session_id, sequence, start_message, end_message, title, content, pass_number, p1, created_at)
                     VALUES ('ses-heal', 1, 1, 2, 'mangled', ?, 1, NULL, 1000)`,
                )
                .run(MANGLED_INNER) as { lastInsertRowid: number | bigint }
        ).lastInsertRowid,
    );
    return { compartmentId, recompId };
}

function readCompartment(db: DatabaseType, id: number): CompartmentRow {
    return db
        .prepare("SELECT id, content, p1, p2, p3, p4, legacy FROM compartments WHERE id = ?")
        .get(id) as CompartmentRow;
}

function readRecomp(db: DatabaseType, id: number): RecompRow {
    return db
        .prepare("SELECT id, content, p1, p2, p3, p4 FROM recomp_compartments WHERE id = ?")
        .get(id) as RecompRow;
}

/** Drop the v70 record so runMigrations re-applies the heal pass. */
function resetV70(db: DatabaseType): void {
    db.prepare("DELETE FROM schema_migrations WHERE version >= 70").run();
}

describe("migration v70: heal compartments stranded by mismatched tier close (issue #246)", () => {
    test("heals a mangled-close legacy row into populated tiers and clears legacy", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            const { compartmentId } = plantStrandedRows(db);
            resetV70(db);

            runMigrations(db);

            const row = readCompartment(db, compartmentId);
            expect(row.p1).toBe("full narrative");
            expect(row.p2).toBe("condensed");
            expect(row.p3).toBe("outcome");
            expect(row.p4).toBe("");
            expect(row.legacy).toBe(0);
            // content is deliberately left untouched.
            expect(row.content).toBe(MANGLED_INNER);
        } finally {
            closeQuietly(db);
        }
    });

    test("heals the same shape in recomp_compartments (no legacy column)", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            const { recompId } = plantStrandedRows(db);
            resetV70(db);

            runMigrations(db);

            const row = readRecomp(db, recompId);
            expect(row.p1).toBe("full narrative");
            expect(row.p2).toBe("condensed");
            expect(row.p3).toBe("outcome");
            expect(row.p4).toBe("");
            expect(row.content).toBe(MANGLED_INNER);
        } finally {
            closeQuietly(db);
        }
    });

    test("is idempotent — re-running the heal pass changes nothing", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            const { compartmentId } = plantStrandedRows(db);
            resetV70(db);
            runMigrations(db);
            const first = readCompartment(db, compartmentId);

            resetV70(db);
            runMigrations(db);
            const second = readCompartment(db, compartmentId);

            expect(second).toEqual(first);
            expect(second.legacy).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("leaves a non-parsing legacy row stranded (legacy stays 1)", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            // content mentions <p1 but yields no non-empty P1 body.
            const id = Number(
                (
                    db
                        .prepare(
                            `INSERT INTO compartments
                                (session_id, sequence, start_message, end_message, title, content, legacy, p1, created_at)
                             VALUES ('ses-heal', 2, 3, 4, 'unparseable', '<p1></p1> flat noise', 1, NULL, 1000)`,
                        )
                        .run() as { lastInsertRowid: number | bigint }
                ).lastInsertRowid,
            );
            resetV70(db);

            runMigrations(db);

            const row = readCompartment(db, id);
            expect(row.legacy).toBe(1);
            expect(row.p1).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});
