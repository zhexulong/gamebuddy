import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (c) => c.name,
    );
}

describe("migration v25 — pi_stable_id_scheme column", () => {
    test("adds pi_stable_id_scheme to a legacy session_meta lacking it", () => {
        const db = new Database(":memory:");
        try {
            // Minimal legacy session_meta WITHOUT pi_stable_id_scheme, stamped at v24.
            db.exec(`
				CREATE TABLE schema_migrations (
					version INTEGER PRIMARY KEY,
					description TEXT NOT NULL,
					applied_at INTEGER NOT NULL
				);
				INSERT INTO schema_migrations (version, description, applied_at)
				VALUES (24, 'legacy v24', 1);

				CREATE TABLE session_meta (
					session_id TEXT PRIMARY KEY,
					harness TEXT NOT NULL DEFAULT 'opencode'
				);
				INSERT INTO session_meta (session_id, harness)
				VALUES ('ses-legacy', 'pi');
			`);

            expect(columnNames(db, "session_meta")).not.toContain("pi_stable_id_scheme");

            runMigrations(db);

            // Column added; existing row reads NULL (= scheme 0 = legacy → cutover).
            expect(columnNames(db, "session_meta")).toContain("pi_stable_id_scheme");
            const row = db
                .prepare("SELECT pi_stable_id_scheme AS s FROM session_meta WHERE session_id = ?")
                .get("ses-legacy") as { s: number | null };
            expect(row.s).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("is idempotent when the column already exists", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
				CREATE TABLE schema_migrations (
					version INTEGER PRIMARY KEY,
					description TEXT NOT NULL,
					applied_at INTEGER NOT NULL
				);
				INSERT INTO schema_migrations (version, description, applied_at)
				VALUES (24, 'legacy v24', 1);

				CREATE TABLE session_meta (
					session_id TEXT PRIMARY KEY,
					harness TEXT NOT NULL DEFAULT 'opencode',
					pi_stable_id_scheme INTEGER
				);
			`);
            // Should not throw on the guarded ADD COLUMN.
            expect(() => runMigrations(db)).not.toThrow();
            expect(columnNames(db, "session_meta")).toContain("pi_stable_id_scheme");
        } finally {
            closeQuietly(db);
        }
    });
});
