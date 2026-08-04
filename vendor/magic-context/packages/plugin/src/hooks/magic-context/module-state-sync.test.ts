/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import {
    addProcessedImageStrippedIds,
    addStaleReduceStrippedIds,
    applyStrippedPlaceholderDelta,
    getCompartments,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { setProjectState } from "../../features/magic-context/storage-project-state";
import {
    insertTag,
    updateTagDropMode,
    updateTagStatus,
} from "../../features/magic-context/storage-tags";
import { insertUserMemory } from "../../features/magic-context/user-memory/storage-user-memory";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    buildModuleStateSyncPayload,
    buildPagedModuleStateSyncPayloads,
    loadModuleWatermarks,
    type ModuleStateSyncState,
    mirrorModuleCompartments,
    syncModuleState,
} from "./module-state-sync";
import {
    MODULE_PAGE_MAX_BYTES,
    moduleWireBodyBytes,
    resolveOrdinalsForModule,
} from "./module-wire";
import { closeReadOnlySessionDb } from "./read-session-db";

const databases: Database[] = [];
const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    for (const db of databases.splice(0)) closeQuietly(db);
    closeReadOnlySessionDb();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function createOpenCodeDb(
    sessionId: string,
    messages: Array<{ id: string; role: string; summary?: boolean; parts?: unknown[] }>,
): void {
    const dbPath = join(process.env.XDG_DATA_HOME ?? "", "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE part (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
        `);
        const insertMessage = db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        const insertPart = db.prepare(
            "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        messages.forEach((message, index) => {
            const timestamp = index + 1;
            insertMessage.run(
                message.id,
                sessionId,
                timestamp,
                timestamp,
                JSON.stringify({
                    id: message.id,
                    role: message.role,
                    summary: message.summary === true ? true : undefined,
                    finish: message.summary === true ? "stop" : undefined,
                }),
            );
            for (const part of message.parts ?? [{ type: "text", text: message.id }]) {
                insertPart.run(message.id, sessionId, timestamp, timestamp, JSON.stringify(part));
            }
        });
    } finally {
        closeQuietly(db);
    }
}

function createContextDb(): Database {
    const db = new Database(":memory:");
    databases.push(db);
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function syncState(generation = 1): {
    moduleGeneration: number;
    lastAckedSeq: number;
    lastAckedWatermarks: null;
    idOrdinalMemoGeneration: number;
    idOrdinalMemo: Map<string, number>;
    seedPassPending: boolean;
} {
    return {
        moduleGeneration: generation,
        lastAckedSeq: 0,
        lastAckedWatermarks: null,
        idOrdinalMemoGeneration: generation,
        idOrdinalMemo: new Map(),
        seedPassPending: true,
    };
}

function wireMessage(
    sessionId: string,
    id: string,
): {
    info: { id: string; role: string; sessionID: string };
    parts: Array<{ type: string; text: string }>;
} {
    return {
        info: { id, role: "user", sessionID: sessionId },
        parts: [{ type: "text", text: id }],
    };
}

function syntheticWireMessage(
    sessionId: string,
    id: string,
): {
    info: { id: string; role: string; sessionID: string };
    parts: Array<{ type: string; text: string; synthetic: true }>;
} {
    return {
        info: { id, role: "user", sessionID: sessionId },
        parts: [{ type: "text", text: id, synthetic: true }],
    };
}

describe("module drop-state cold-start seed", () => {
    it("maps dropped message and tool tags to deterministic module blocks", async () => {
        useTempDataHome("module-state-sync-drop-seed-");
        const sessionId = "ses-drop-seed";
        createOpenCodeDb(sessionId, [
            {
                id: "m1",
                role: "assistant",
                parts: [
                    {
                        type: "tool",
                        callID: "call-1",
                        tool: "edit",
                        state: {
                            status: "completed",
                            input: {
                                filePath: "src/main.ts",
                                content: "a very long edit payload that should be hinted",
                            },
                            output: "large output",
                        },
                    },
                ],
            },
            { id: "m2", role: "user" },
        ]);
        const db = createContextDb();
        insertTag(db, sessionId, "call-1", "tool", 100, 1, 0, "edit", 20, "m1");
        updateTagStatus(db, sessionId, 1, "dropped");
        updateTagDropMode(db, sessionId, 1, "edit_marker");
        insertTag(db, sessionId, "m2:p0", "message", 100, 2);
        updateTagStatus(db, sessionId, 2, "dropped");
        insertTag(db, sessionId, "missing-call", "tool", 100, 3, 0, "bash", 20, null);
        updateTagStatus(db, sessionId, 3, "dropped");

        const calls: unknown[] = [];
        await syncModuleState({
            client: {
                async call(args) {
                    calls.push(args.body);
                    return { result: { shadow_seq: 1 } };
                },
            },
            state: syncState(),
            pass: { db, sessionId, nowMs: 1 },
            projectRoot: "/tmp/project",
            force: true,
        });

        const body = calls[0] as {
            drop_seeds: Array<{
                block_id: string;
                related_block_ids?: string[];
                drop_mode: string;
                payload?: string;
            }>;
            drop_seed_skipped: number;
        };
        expect(body.drop_seeds).toEqual([
            expect.objectContaining({
                block_id: "m1#0",
                related_block_ids: ["m1#1"],
                drop_mode: "edit_marker",
            }),
            expect.objectContaining({ block_id: "m2#0", drop_mode: "full" }),
        ]);
        expect(body.drop_seeds[0]?.payload).toContain("src/main.ts");
        expect(body.drop_seed_skipped).toBe(1);
    });
});

describe("module strip-state cold-start seed", () => {
    it("carries frozen placeholder, stale-reduce, and image ids plus the tag watermark", async () => {
        const db = createContextDb();
        const sessionId = "ses-strip-seed";
        applyStrippedPlaceholderDelta(db, sessionId, { add: ["placeholder-message"] });
        addStaleReduceStrippedIds(db, sessionId, ["reduce-message"]);
        addProcessedImageStrippedIds(db, sessionId, ["image-message"]);
        db.prepare(
            "UPDATE session_meta SET cleared_reasoning_through_tag = ? WHERE session_id = ?",
        ).run(42, sessionId);

        const calls: unknown[] = [];
        await syncModuleState({
            client: {
                async call(args) {
                    calls.push(args.body);
                    return { result: { shadow_seq: 1 } };
                },
            },
            state: syncState(),
            pass: { db, sessionId, nowMs: 1 },
            projectRoot: "/tmp/project",
            force: true,
        });

        const body = calls[0] as {
            strip_seeds: Array<{ message_id: string; strip_kind: string }>;
            reasoning_cleared_through_tag: number;
        };
        expect(body.strip_seeds).toEqual([
            { message_id: "image-message", strip_kind: "processed_image" },
            { message_id: "placeholder-message", strip_kind: "placeholder" },
            { message_id: "reduce-message", strip_kind: "stale_reduce" },
        ]);
        expect(body.reasoning_cleared_through_tag).toBe(42);
    });
});

describe("historian compartment sync fence", () => {
    it("keeps the same delta pending when the module asks for a retry", async () => {
        const db = createContextDb();
        const state = syncState();
        let calls = 0;
        const result = await syncModuleState({
            client: {
                async call() {
                    calls += 1;
                    throw Object.assign(new Error("historian owns the compartment snapshot"), {
                        code: "historian_compartment_sync_busy",
                    });
                },
            },
            state,
            pass: { db, sessionId: "sync-busy", nowMs: 1 },
            projectRoot: "/tmp/project",
            force: true,
        });

        expect(result).toEqual({ status: "retry_busy" });
        expect(calls).toBe(1);
        expect(state.lastAckedSeq).toBe(0);
        expect(state.lastAckedWatermarks).toBeNull();
    });
});

describe("module state external epochs", () => {
    it("carries dashboard project and profile epochs on the completed sync page", async () => {
        const db = createContextDb();
        setProjectState(db, "/tmp/project", { projectMemoryEpoch: 9 });
        setProjectState(db, "__global__", { projectUserProfileVersion: 4 });
        const calls: unknown[] = [];
        await syncModuleState({
            client: {
                async call(args) {
                    calls.push(args.body);
                    return { result: { shadow_seq: 1 } };
                },
            },
            state: syncState(),
            pass: { db, sessionId: "ses-epoch", projectPath: "/tmp/project", nowMs: 1 },
            projectRoot: "/tmp/project",
            force: true,
        });
        const body = calls.at(-1) as Record<string, unknown>;
        expect(body.project_memory_epoch).toBe(9);
        expect(body.user_profile_version).toBe(4);
        expect(body.acked_watermarks).toEqual(
            expect.objectContaining({
                project_memory_epoch: 9,
                project_user_profile_version: 4,
            }),
        );
    });
});

describe("module state sync section deltas", () => {
    function createWorkspace(db: Database): void {
        db.exec(
            `INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
             VALUES (1, 'shared', 0, 0, '["CONSTRAINTS"]');
             INSERT INTO workspace_members
                 (workspace_id, project_path, display_name, display_path, added_at)
             VALUES
                 (1, '/tmp/project', 'project', '/tmp/project', 0),
                 (1, '/tmp/foreign', 'foreign', '/tmp/foreign', 0);`,
        );
        setProjectState(db, "/tmp/project", { projectMemoryEpoch: 1 });
        setProjectState(db, "/tmp/foreign", { projectMemoryEpoch: 1 });
    }

    async function buildDeltaPayload(args: {
        db: Database;
        state: ModuleStateSyncState;
        sessionId: string;
        force?: boolean;
    }): Promise<Record<string, unknown>> {
        const payload = await buildModuleStateSyncPayload({
            state: args.state,
            pass: {
                db: args.db,
                sessionId: args.sessionId,
                projectPath: "/tmp/project",
                nowMs: 1,
            },
            force: args.force ?? false,
            options: { stateSyncDeltas: true },
        });
        expect(payload).not.toBeNull();
        expect(typeof payload).toBe("object");
        if (!payload || typeof payload !== "object" || "method" in payload === false) {
            throw new Error("expected a state-sync payload");
        }
        return payload.params as Record<string, unknown>;
    }

    it("omits unchanged profile and workspace sections but preserves explicit changes", async () => {
        const db = createContextDb();
        const sessionId = "ses-state-sync-deltas";
        createWorkspace(db);
        insertUserMemory(db, "likes deltas", []);
        setProjectState(db, "__global__", { projectUserProfileVersion: 1 });
        const baseline = loadModuleWatermarks({ db, sessionId, projectPath: "/tmp/project" });
        const state = {
            ...syncState(),
            lastAckedWatermarks: baseline,
            seedPassPending: false,
        };

        updateSessionMeta(db, sessionId, { lastTodoState: '[{"content":"todo"}]' });
        const unrelated = await buildDeltaPayload({ db, state, sessionId });
        expect(unrelated).not.toHaveProperty("user_profile");
        expect(unrelated).not.toHaveProperty("workspace");

        setProjectState(db, "__global__", { projectUserProfileVersion: 2 });
        const profileChanged = await buildDeltaPayload({ db, state, sessionId });
        expect(profileChanged.user_profile).toEqual(["likes deltas"]);
        expect(profileChanged).not.toHaveProperty("workspace");
        state.lastAckedWatermarks = loadModuleWatermarks({
            db,
            sessionId,
            projectPath: "/tmp/project",
        });

        setProjectState(db, "/tmp/foreign", { projectMemoryEpoch: 2 });
        const workspaceChanged = await buildDeltaPayload({ db, state, sessionId });
        expect(workspaceChanged).toHaveProperty("workspace");
        expect(workspaceChanged).not.toHaveProperty("user_profile");

        const forced = await buildDeltaPayload({ db, state, sessionId, force: true });
        expect(forced.user_profile).toEqual(["likes deltas"]);
        expect(forced.workspace).toEqual(expect.objectContaining({ members: expect.any(Array) }));
    });

    it("uses omitted sections only after the module advertises the delta capability", async () => {
        const db = createContextDb();
        const sessionId = "ses-state-sync-capability";
        const baseline = loadModuleWatermarks({ db, sessionId, projectPath: "/tmp/project" });
        updateSessionMeta(db, sessionId, { lastTodoState: '[{"content":"todo"}]' });
        const state = {
            ...syncState(),
            lastAckedWatermarks: baseline,
            seedPassPending: false,
        };
        const calls: unknown[] = [];
        await syncModuleState({
            client: {
                async stateSyncCapabilities() {
                    return { state_sync_deltas: true };
                },
                async call(args) {
                    calls.push(args.body);
                    return { result: { shadow_seq: 1 } };
                },
            },
            state,
            pass: { db, sessionId, projectPath: "/tmp/project", nowMs: 1 },
            projectRoot: "/tmp/project",
            force: false,
        });
        expect(calls).toHaveLength(1);
        const body = calls[0] as Record<string, unknown>;
        expect(body).not.toHaveProperty("user_profile");
        expect(body).not.toHaveProperty("workspace");
    });
});

describe("module state authority direction", () => {
    it("omits module-owned memory sections from the TypeScript sender payload", async () => {
        const db = createContextDb();
        db.prepare(
            `INSERT INTO memories
                (project_path, category, content, normalized_hash, first_seen_at, created_at,
                 updated_at, last_seen_at, classified_at)
             VALUES (?, 'CONSTRAINTS', 'module-owned fact', 'hash', 0, 0, 0, 0, 1234)`,
        ).run("/tmp/project");
        const calls: unknown[] = [];
        const state = syncState();

        await syncModuleState({
            client: {
                async call(args) {
                    calls.push(args.body);
                    return { result: { shadow_seq: 1, memories_skipped: true } };
                },
            },
            state,
            pass: {
                db,
                sessionId: "ses-authority-direction",
                projectPath: "/tmp/project",
                nowMs: 1,
            },
            projectRoot: "/tmp/project",
            force: true,
            options: { authority: true, authorityState: "MODULE" },
        });

        const body = calls[0] as Record<string, unknown>;
        expect(body).not.toHaveProperty("memories");
        expect(body).not.toHaveProperty("memory_mutations");
        expect(state.authorityMemorySyncSkipLogged).toBe(true);
    });
});

describe("module compartment ordinal serialization", () => {
    it("uses canonical ordinals when stored boundaries include a summary row", async () => {
        useTempDataHome("module-state-sync-ordinal-basis-");
        const sessionId = "ses-ordinal-basis";
        createOpenCodeDb(sessionId, [
            { id: "m1", role: "user" },
            { id: "summary", role: "assistant", summary: true },
            { id: "m2", role: "assistant" },
            { id: "m3", role: "user" },
        ]);
        const db = createContextDb();
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 3,
                endMessage: 4,
                startMessageId: "m2",
                endMessageId: "m3",
                title: "After summary",
                content: "content",
            },
        ]);

        const state = syncState(7);
        const inputMessage = wireMessage(sessionId, "m2");
        const wire = await resolveOrdinalsForModule({
            sessionId,
            messages: [inputMessage],
            generation: state.moduleGeneration,
            memoGeneration: state.idOrdinalMemoGeneration,
            memo: state.idOrdinalMemo,
        });
        expect(wire).toEqual(
            expect.objectContaining({
                ok: true,
                annotatedInput: [expect.objectContaining({ absolute_ordinal: 2 })],
            }),
        );
        expect(state.idOrdinalMemo.get("m2")).toBe(2);
        expect(inputMessage).not.toHaveProperty("absolute_ordinal");

        const calls: unknown[] = [];
        await syncModuleState({
            client: {
                async call(args) {
                    calls.push(args.body);
                    return { result: { shadow_seq: 1 } };
                },
            },
            state,
            pass: { db, sessionId, nowMs: 1 },
            projectRoot: "/tmp/project",
            force: true,
        });

        const body = calls[0] as {
            compartments: Array<{ start_message: number; end_message: number }>;
        };
        expect(body.compartments).toEqual([
            expect.objectContaining({ start_message: 2, end_message: 3 }),
        ]);
    });

    it("keeps canonical ordinal drift fail-loud when the wire resolver finds a conflict", async () => {
        useTempDataHome("module-state-sync-ordinal-drift-");
        const sessionId = "ses-ordinal-drift";
        createOpenCodeDb(sessionId, [
            { id: "m1", role: "user" },
            { id: "summary", role: "assistant", summary: true },
            { id: "m2", role: "user" },
        ]);
        const state = syncState(3);
        state.idOrdinalMemo.set("m2", 3);

        const result = await resolveOrdinalsForModule({
            sessionId,
            messages: [wireMessage(sessionId, "m2")],
            generation: state.moduleGeneration,
            memoGeneration: state.idOrdinalMemoGeneration,
            memo: state.idOrdinalMemo,
            memoStoredCount: 3,
            memoCanonicalCount: 0,
        });

        expect(result).toEqual(expect.objectContaining({ ok: false, reason: "mismatch" }));
    });

    it("preserves stored ordinals when a session has no summary rows", async () => {
        useTempDataHome("module-state-sync-no-summary-");
        const sessionId = "ses-no-summary";
        createOpenCodeDb(sessionId, [
            { id: "m1", role: "user" },
            { id: "m2", role: "assistant" },
        ]);
        const db = createContextDb();
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "m1",
                endMessageId: "m2",
                title: "No summary",
                content: "content",
            },
        ]);

        const calls: unknown[] = [];
        await syncModuleState({
            client: {
                async call(args) {
                    calls.push(args.body);
                    return { result: { shadow_seq: 1 } };
                },
            },
            state: syncState(),
            pass: { db, sessionId, nowMs: 1 },
            projectRoot: "/tmp/project",
            force: true,
        });

        const body = calls[0] as {
            compartments: Array<{ start_message: number; end_message: number }>;
        };
        expect(body.compartments).toEqual([
            expect.objectContaining({ start_message: 1, end_message: 2 }),
        ]);
    });

    it("keeps persisted ordinals stable around an interior synthetic wire message", async () => {
        useTempDataHome("module-state-sync-interior-synthetic-");
        const sessionId = "ses-interior-synthetic";
        createOpenCodeDb(sessionId, [
            { id: "m1", role: "user" },
            { id: "m2", role: "assistant" },
            { id: "m3", role: "user" },
        ]);

        const result = await resolveOrdinalsForModule({
            sessionId,
            messages: [
                wireMessage(sessionId, "m1"),
                syntheticWireMessage(sessionId, "nudge"),
                wireMessage(sessionId, "m2"),
                wireMessage(sessionId, "m3"),
            ],
            generation: 1,
            memoGeneration: 1,
            memo: new Map(),
        });

        expect(result).toEqual(
            expect.objectContaining({
                ok: true,
                annotatedInput: [
                    expect.objectContaining({ absolute_ordinal: 1 }),
                    expect.objectContaining({ absolute_ordinal: 1 }),
                    expect.objectContaining({ absolute_ordinal: 2 }),
                    expect.objectContaining({ absolute_ordinal: 3 }),
                ],
            }),
        );
    });

    it("reports the first non-synthetic ordinal gap with its wire identity", async () => {
        useTempDataHome("module-state-sync-unresolved-diagnostic-");
        const sessionId = "ses-unresolved-diagnostic";
        createOpenCodeDb(sessionId, [
            { id: "m1", role: "user" },
            { id: "m2", role: "assistant" },
        ]);

        const result = await resolveOrdinalsForModule({
            sessionId,
            messages: [
                wireMessage(sessionId, "m1"),
                {
                    info: { id: "missing", role: "assistant", sessionID: sessionId },
                    parts: [{ type: "text", text: "missing" }],
                },
                wireMessage(sessionId, "m2"),
            ],
            generation: 1,
            memoGeneration: 1,
            memo: new Map(),
        });

        expect(result).toEqual(
            expect.objectContaining({
                ok: false,
                reason: "unresolved",
                messageId: "missing",
                messageIndex: 1,
                messageRole: "assistant",
            }),
        );
    });
});

describe("module incremental and paged assembly", () => {
    it("packs pages linearly and preserves item order under the wire cap", () => {
        createContextDb();
        const watermarks = {
            compartment_sequence: 0,
            memory_id: 0,
            m0_mutation_id: 0,
            memory_mutation_id: 0,
            last_todo_state_hash: "",
            project_memory_epoch: 0,
            project_user_profile_version: 0,
            reasoning_cleared_through_tag: 0,
        };
        const items = Array.from({ length: 900 }, (_, index) => ({
            id: index,
            content: "x".repeat(1200),
        }));
        const originalStringify = JSON.stringify;
        let serializedBytes = 0;
        JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
            const result = originalStringify(...args);
            if (typeof result === "string") serializedBytes += Buffer.byteLength(result);
            return result;
        }) as typeof JSON.stringify;
        let pages: ReturnType<typeof buildPagedModuleStateSyncPayloads> = [];
        try {
            pages = buildPagedModuleStateSyncPayloads({
                moduleGeneration: 1,
                expectedShadowSeq: 0,
                seedId: "seed",
                seedBoundaryId: null,
                compartments: items,
                memories: [],
                memoryMutations: [],
                userProfile: [],
                workspace: null,
                lastTodoState: "",
                watermarks,
            });
        } finally {
            JSON.stringify = originalStringify;
        }

        expect(pages.length).toBeGreaterThan(1);
        expect(pages.flatMap((page) => page.params.compartments)).toEqual(items);
        expect(serializedBytes).toBeLessThan(10_000_000);
        for (const page of pages) {
            expect(
                moduleWireBodyBytes({
                    method: "state_sync",
                    params: page.params,
                }),
            ).toBeLessThanOrEqual(MODULE_PAGE_MAX_BYTES);
        }
    });

    it("does not read memory pools for a todo-only watermark change", async () => {
        const db = createContextDb();
        const sessionId = "ses-todo-only-sync";
        const baseline = loadModuleWatermarks({ db, sessionId, projectPath: "/tmp/project" });
        updateSessionMeta(db, sessionId, { lastTodoState: '[{"content":"todo"}]' });
        const originalPrepare = db.prepare.bind(db);
        let memoryPoolReads = 0;
        db.prepare = ((sql: string) => {
            if (/FROM memories/i.test(sql) && !/MAX\(/i.test(sql)) memoryPoolReads += 1;
            return originalPrepare(sql);
        }) as typeof db.prepare;

        const payload = await buildModuleStateSyncPayload({
            state: { ...syncState(), lastAckedWatermarks: baseline, seedPassPending: false },
            pass: { db, sessionId, projectPath: "/tmp/project", nowMs: 1 },
            force: false,
        });

        expect(payload).not.toBeNull();
        expect(memoryPoolReads).toBe(0);
    });

    it("does not issue a full tag-table read during a force seed", async () => {
        const db = createContextDb();
        const originalPrepare = db.prepare.bind(db);
        let fullTagReads = 0;
        db.prepare = ((sql: string) => {
            if (/FROM tags WHERE session_id = \? ORDER BY tag_number/i.test(sql)) {
                fullTagReads += 1;
            }
            return originalPrepare(sql);
        }) as typeof db.prepare;

        await buildModuleStateSyncPayload({
            state: syncState(),
            pass: { db, sessionId: "ses-force-tags", nowMs: 1 },
            force: true,
        });

        expect(fullTagReads).toBeLessThanOrEqual(1);
    });
});

describe("module compartment mirror-back", () => {
    it("copies rows after the local watermark idempotently", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        initializeDatabase(db);
        runMigrations(db);
        const calls: number[] = [];
        const reader = {
            async getCompartmentsAfter(_sessionId: string, afterSequence: number) {
                calls.push(afterSequence);
                return afterSequence < 2
                    ? {
                          max_sequence: 2,
                          compartments: [
                              {
                                  sequence: 1,
                                  start_message: 1,
                                  end_message: 2,
                                  start_message_id: "m1#0",
                                  end_message_id: "m2#0",
                                  title: "First",
                                  content: "first content",
                                  created_at: 10,
                              },
                              {
                                  sequence: 2,
                                  start_message: 3,
                                  end_message: 4,
                                  start_message_id: "m3#0",
                                  end_message_id: "m4#0",
                                  title: "Second",
                                  content: "second content",
                                  created_at: 20,
                              },
                          ],
                      }
                    : { max_sequence: 2, compartments: [] };
            },
        };

        await mirrorModuleCompartments({ db, sessionId: "ses-mirror", reader });
        await mirrorModuleCompartments({ db, sessionId: "ses-mirror", reader });

        expect(calls).toEqual([-1, 2]);
        expect(getCompartments(db, "ses-mirror").map((row) => row.sequence)).toEqual([1, 2]);
    });
});
