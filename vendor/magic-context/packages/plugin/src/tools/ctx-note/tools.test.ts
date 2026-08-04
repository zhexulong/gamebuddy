import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { createCtxNoteTools } from "./tools";

function createTestDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
    CREATE TABLE authority_managed (
      project_path TEXT PRIMARY KEY,
      context_store_uuid TEXT NOT NULL,
      marked_at INTEGER NOT NULL
    );
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'session',
      status TEXT NOT NULL DEFAULT 'active',
      content TEXT NOT NULL,
      session_id TEXT,
      project_path TEXT,
      surface_condition TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_checked_at INTEGER,
      ready_at INTEGER,
      ready_reason TEXT,
      harness TEXT NOT NULL DEFAULT 'opencode',
      anchor_ordinal INTEGER
    );
    CREATE TABLE message_history_index (
      session_id TEXT PRIMARY KEY,
      last_indexed_ordinal INTEGER NOT NULL DEFAULT 0,
      dirty_floor_ordinal INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
  `);
    return db;
}

const toolContext = (sessionID = "ses-note", directory = "/workspace/project-a") =>
    ({ sessionID, directory }) as never;

describe("createCtxNoteTools", () => {
    let db: Database;
    let tools: ReturnType<typeof createCtxNoteTools>;

    beforeEach(() => {
        db = createTestDb();
        tools = createCtxNoteTools({
            db,
            resolveProjectPath: (directory) =>
                directory.includes("project-b") ? "git:project-b" : "git:project-a",
        });
    });

    it("writes and reads session notes", async () => {
        const writeResult = await tools.ctx_note.execute(
            { action: "write", content: "Remember the user prefers build on integrate." },
            toolContext(),
        );
        const readResult = await tools.ctx_note.execute({ action: "read" }, toolContext());

        expect(writeResult).toContain("Saved session note #1");
        expect(readResult).toContain("## Session Notes");
        expect(readResult).toContain("#1");
        expect(readResult).toContain("Remember the user prefers build on integrate.");
    });

    it("routes notes only when the notes domain reports module authority", async () => {
        const routed: Array<{ action: string; memoryProject: string }> = [];
        tools = createCtxNoteTools({
            db,
            resolveProjectPath: () => "git:project-a",
            rustToolBackends: {
                authorityState: async ({ domain }) => (domain === "notes" ? "MODULE" : "TS"),
                note: async (request) => {
                    routed.push({
                        action: request.action,
                        memoryProject: request.memoryProject,
                    });
                    return { content: [{ type: "text", text: "module note result" }] };
                },
                noteEvaluationAvailable: () => true,
            },
        });
        const result = await tools.ctx_note.execute(
            { action: "write", content: "module owned note" },
            toolContext(),
        );
        expect(result).toBe("module note result");
        expect(routed).toEqual([{ action: "write", memoryProject: "git:project-a" }]);
        expect(db.prepare("SELECT COUNT(*) AS count FROM notes").get()).toEqual({ count: 0 });
    });

    it("maps a raced module drain rejection to the transition retry message", async () => {
        tools = createCtxNoteTools({
            db,
            resolveProjectPath: () => "git:project-a",
            rustToolBackends: {
                authorityState: async () => "MODULE",
                note: async () => ({
                    error: {
                        code: "authority_draining",
                        message: "authority is draining",
                    },
                }),
            },
        });
        const result = await tools.ctx_note.execute(
            { action: "write", content: "retry me" },
            toolContext(),
        );
        expect(result).toBe(
            "Error: Rust notes authority is not ready; TypeScript fallback is disabled.",
        );
        expect(db.prepare("SELECT COUNT(*) AS count FROM notes").get()).toEqual({ count: 0 });
    });

    it("keeps TS note handling when the notes domain reports TS authority", async () => {
        let routed = false;
        tools = createCtxNoteTools({
            db,
            resolveProjectPath: () => "git:project-a",
            rustToolBackends: {
                authorityState: async () => "TS",
                note: async () => {
                    routed = true;
                    return "unexpected";
                },
            },
        });
        const result = await tools.ctx_note.execute(
            { action: "write", content: "TS owned note" },
            toolContext(),
        );
        expect(result).toContain("Saved session note");
        expect(routed).toBe(false);
    });

    it("rejects module smart-note writes when evaluation is unavailable", async () => {
        tools = createCtxNoteTools({
            db,
            dreamerEnabled: true,
            resolveProjectPath: () => "git:project-a",
            rustToolBackends: {
                authorityState: async () => "MODULE",
                note: async () => "must not be called",
                noteEvaluationAvailable: () => false,
            },
        });
        const result = await tools.ctx_note.execute(
            {
                action: "write",
                content: "wait for release",
                surface_condition: "when release exists",
            },
            toolContext(),
        );
        expect(result).toContain("evaluation is unavailable");
        expect(db.prepare("SELECT COUNT(*) AS count FROM notes").get()).toEqual({ count: 0 });
    });

    it("defaults to read (not write) when content is an empty string and no action is given", async () => {
        // GPT-family models fill every optional param, so a read arrives as
        // { content: "", surface_condition: "" } with no action. That must
        // default to read, not infer write and reject the empty content.
        await tools.ctx_note.execute(
            { action: "write", content: "An existing note" },
            toolContext(),
        );
        const result = await tools.ctx_note.execute(
            { content: "", surface_condition: "" },
            toolContext(),
        );

        expect(result).not.toContain("'content' is required");
        expect(result).toContain("## Session Notes");
        expect(result).toContain("An existing note");
    });

    it("anchors a note to the live message-tail ordinal and renders it with an expand hint", async () => {
        db.prepare(
            "INSERT INTO message_history_index (session_id, last_indexed_ordinal, updated_at) VALUES (?, ?, ?)",
        ).run("ses-note", 512, 1);

        await tools.ctx_note.execute(
            { action: "write", content: "Anchored decision" },
            toolContext(),
        );
        const readResult = await tools.ctx_note.execute({ action: "read" }, toolContext());

        expect(readResult).toContain("↳ @msg 512");
        expect(readResult).toContain("ctx_expand(start=N-x, end=N)");
    });

    it("omits the anchor (and hint) when the session has no indexed tail yet", async () => {
        await tools.ctx_note.execute(
            { action: "write", content: "Unanchored decision" },
            toolContext(),
        );
        const readResult = await tools.ctx_note.execute({ action: "read" }, toolContext());

        expect(readResult).not.toContain("↳ @msg");
        expect(readResult).not.toContain("ctx_expand(start=N-x");
    });

    it("requires content for writes", async () => {
        const result = await tools.ctx_note.execute({ action: "write" }, toolContext());

        expect(result).toContain("Error");
        expect(result).toContain("'content' is required");
    });

    it("dismisses session notes and can still inspect them with filter='all'", async () => {
        await tools.ctx_note.execute({ action: "write", content: "First note" }, toolContext());
        const dismissResult = await tools.ctx_note.execute(
            { action: "dismiss", note_id: 1 },
            toolContext(),
        );
        const readResult = await tools.ctx_note.execute({ action: "read" }, toolContext());
        const readAllResult = await tools.ctx_note.execute(
            { action: "read", filter: "all" },
            toolContext(),
        );

        expect(dismissResult).toContain("Note #1 dismissed");
        expect(readResult).toContain("No session notes or smart notes");
        expect(readAllResult).toContain("dismissed");
        expect(readAllResult).toContain("First note");
    });

    it("rejects dismissing another session's session note", async () => {
        await tools.ctx_note.execute(
            { action: "write", content: "Other session note" },
            toolContext("ses-b"),
        );

        const dismissResult = await tools.ctx_note.execute(
            { action: "dismiss", note_id: 1 },
            toolContext("ses-a"),
        );
        const readOtherResult = await tools.ctx_note.execute(
            { action: "read", filter: "all" },
            toolContext("ses-b"),
        );

        expect(dismissResult).toContain("not found in your session/project");
        expect(readOtherResult).toContain("Other session note");
        expect(readOtherResult).not.toContain("dismissed");
    });

    it("updates own session notes but rejects another session's session note", async () => {
        await tools.ctx_note.execute(
            { action: "write", content: "Original session note" },
            toolContext("ses-a"),
        );

        const ownUpdate = await tools.ctx_note.execute(
            { action: "update", note_id: 1, content: "Updated session note" },
            toolContext("ses-a"),
        );
        const otherUpdate = await tools.ctx_note.execute(
            { action: "update", note_id: 1, content: "Hijacked session note" },
            toolContext("ses-b"),
        );
        const readResult = await tools.ctx_note.execute(
            { action: "read", filter: "all" },
            toolContext("ses-a"),
        );

        expect(ownUpdate).toContain("Updated note #1");
        expect(otherUpdate).toContain("not found in your session/project");
        expect(readResult).toContain("Updated session note");
        expect(readResult).not.toContain("Hijacked session note");
    });

    it("dismisses own project smart notes but rejects another project's smart note", async () => {
        tools = createCtxNoteTools({
            db,
            dreamerEnabled: true,
            resolveProjectPath: (directory) =>
                directory.includes("project-b") ? "git:project-b" : "git:project-a",
        });

        await tools.ctx_note.execute(
            {
                action: "write",
                content: "Project B smart note",
                surface_condition: "When project B is ready",
            },
            toolContext("ses-b", "/workspace/project-b"),
        );

        const wrongProjectDismiss = await tools.ctx_note.execute(
            { action: "dismiss", note_id: 1 },
            toolContext("ses-a", "/workspace/project-a"),
        );
        const ownProjectDismiss = await tools.ctx_note.execute(
            { action: "dismiss", note_id: 1 },
            toolContext("ses-a", "/workspace/project-b"),
        );

        expect(wrongProjectDismiss).toContain("not found in your session/project");
        expect(ownProjectDismiss).toContain("Note #1 dismissed");
    });

    it("rejects updating another project's smart note", async () => {
        tools = createCtxNoteTools({
            db,
            dreamerEnabled: true,
            resolveProjectPath: (directory) =>
                directory.includes("project-b") ? "git:project-b" : "git:project-a",
        });

        await tools.ctx_note.execute(
            {
                action: "write",
                content: "Project B smart note",
                surface_condition: "When project B is ready",
            },
            toolContext("ses-b", "/workspace/project-b"),
        );

        const wrongProjectUpdate = await tools.ctx_note.execute(
            { action: "update", note_id: 1, content: "Project A hijack" },
            toolContext("ses-a", "/workspace/project-a"),
        );
        const readProjectB = await tools.ctx_note.execute(
            { action: "read", filter: "all" },
            toolContext("ses-b", "/workspace/project-b"),
        );

        expect(wrongProjectUpdate).toContain("not found in your session/project");
        expect(readProjectB).toContain("Project B smart note");
        expect(readProjectB).not.toContain("Project A hijack");
    });

    it("updates smart notes", async () => {
        tools = createCtxNoteTools({
            db,
            dreamerEnabled: true,
            resolveProjectPath: () => "git:test-project",
        });

        await tools.ctx_note.execute(
            {
                action: "write",
                content: "Implement the cleanup after the API settles.",
                surface_condition: "When PR #42 is merged",
            },
            toolContext(),
        );

        const updateResult = await tools.ctx_note.execute(
            {
                action: "update",
                note_id: 1,
                content: "Implement the cleanup after the schema settles.",
                surface_condition: "When PR #108 is merged",
            },
            toolContext(),
        );
        const readAllResult = await tools.ctx_note.execute(
            { action: "read", filter: "all" },
            toolContext(),
        );

        expect(updateResult).toContain("Updated note #1");
        expect(readAllResult).toContain("Implement the cleanup after the schema settles.");
        expect(readAllResult).toContain("When PR #108 is merged");
    });

    it("pages read newest-first with limit/offset and a continuation footer", async () => {
        for (let i = 1; i <= 30; i += 1) {
            await tools.ctx_note.execute(
                { action: "write", content: `note number ${i}` },
                toolContext(),
            );
        }

        // Default read: newest 25, footer pointing at the 5 older ones.
        const firstPage = await tools.ctx_note.execute({ action: "read" }, toolContext());
        expect(firstPage).toContain("note number 30"); // newest present
        expect(firstPage).toContain("note number 6"); // 25th newest present
        expect(firstPage).not.toContain("note number 5\n"); // older than page 1
        expect(firstPage).toContain(
            'Showing 25 of 30 (newest first) — 5 older: ctx_note(action="read", offset=25)',
        );

        // Older page via offset.
        const secondPage = await tools.ctx_note.execute(
            { action: "read", offset: 25 },
            toolContext(),
        );
        expect(secondPage).toContain("note number 5");
        expect(secondPage).toContain("note number 1");
        expect(secondPage).not.toContain("note number 30");
        expect(secondPage).not.toContain("older: ctx_note"); // no further pages

        // Custom limit caps the page.
        const small = await tools.ctx_note.execute({ action: "read", limit: 3 }, toolContext());
        expect(small).toContain("note number 30");
        expect(small).toContain("note number 28");
        expect(small).not.toContain("note number 27\n");
        expect(small).toContain("Showing 3 of 30");
    });

    it("pages ready smart notes with the same default offset contract", async () => {
        const insert = db.prepare(
            "INSERT INTO notes(type, status, content, project_path, surface_condition, created_at, updated_at, ready_at) VALUES ('smart', 'ready', ?, 'git:project-a', 'condition', ?, ?, ?)",
        );
        for (let i = 1; i <= 105; i += 1) {
            insert.run(`ready note ${i}`, i, i, i);
        }

        const page = await tools.ctx_note.execute(
            { action: "read", limit: 5, offset: 100 },
            toolContext(),
        );
        expect(page).toContain("## 🔔 Ready Smart Notes");
        expect(page).toContain("ready note 5");
        expect(page).toContain("ready note 1");
        expect(page).not.toContain("ready note 6\n");
        expect(page).not.toContain("older: ctx_note");
    });
});
