import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

/**
 * The module note mirror UPDATE writes notes.anchor_block_id. The column only
 * ever existed module-side (mc_notes); on upgraded context databases every
 * mirror apply threw "no such column" and rust-mode transforms fell to raw.
 */
describe("migration v63", () => {
    let db: Database;

    beforeEach(() => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
    });

    afterEach(() => {
        db.close();
    });

    it("adds anchor_block_id to notes", () => {
        const columns = db.prepare("PRAGMA table_info(notes)").all() as Array<{ name: string }>;
        expect(columns.some((column) => column.name === "anchor_block_id")).toBe(true);
    });

    it("accepts the note mirror update column set", () => {
        db.prepare(
            "INSERT INTO notes (type, status, content, session_id, created_at, updated_at) VALUES ('session', 'active', 'x', 'ses_1', 1, 1)",
        ).run();
        // The exact column the mirror consumer writes; before v63 this threw.
        db.prepare("UPDATE notes SET anchor_block_id = ? WHERE id = 1").run("msg_abc#2");
        const row = db.prepare("SELECT anchor_block_id FROM notes WHERE id = 1").get() as {
            anchor_block_id: string;
        };
        expect(row.anchor_block_id).toBe("msg_abc#2");
    });
});
