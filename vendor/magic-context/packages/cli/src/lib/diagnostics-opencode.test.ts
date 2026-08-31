import { describe, expect, it } from "bun:test";
import { Database } from "@magic-context/core/shared/sqlite";
import {
    collectRecentSessionsFromDatabase,
    type RecentSessionSummary,
} from "./diagnostics-opencode";

describe("collectRecentSessionsFromDatabase", () => {
    it("includes newest children under recent parents while keeping the picker capped", () => {
        const database = new Database(":memory:");
        try {
            database.exec(`
                CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    directory TEXT NOT NULL,
                    title TEXT,
                    time_updated INTEGER NOT NULL,
                    parent_id TEXT,
                    time_archived INTEGER
                )
            `);
            const insert = database.prepare(
                "INSERT INTO session (id, directory, title, time_updated, parent_id, time_archived) VALUES (?, ?, ?, ?, ?, ?)",
            );
            const add = (
                id: string,
                timeUpdated: number,
                parentId: string | null = null,
                archived: number | null = null,
            ) => insert.run(id, "/project", id, timeUpdated, parentId, archived);

            add("ses_parent001", 100);
            add("ses_child001", 300, "ses_parent001");
            add("ses_child002", 290, "ses_parent001");
            add("ses_child003", 280, "ses_parent001");
            add("ses_child004", 270, "ses_parent001");
            add("ses_child_archived", 400, "ses_parent001", 1);
            add("ses_parent002", 250);
            add("ses_parent003", 240);
            add("ses_parent004", 230);
            add("ses_parent005", 220);
            add("ses_parent006", 210);

            const sessions = collectRecentSessionsFromDatabase(database);
            const ids = sessions.map((session) => session.sessionId);
            expect(ids).toEqual([
                "ses_parent001",
                "ses_child001",
                "ses_child002",
                "ses_child003",
                "ses_parent002",
                "ses_parent003",
                "ses_parent004",
                "ses_parent005",
            ]);
            expect(ids).not.toContain("ses_child004");
            expect(ids).not.toContain("ses_parent006");
            expect(sessions[1]).toMatchObject<Partial<RecentSessionSummary>>({
                sessionId: "ses_child001",
                parentSessionId: "ses_parent001",
            });
        } finally {
            database.close();
        }
    });
});
