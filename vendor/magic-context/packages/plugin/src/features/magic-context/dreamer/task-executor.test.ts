/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from "bun:test";
import { createDreamTimerModuleClient } from "../../../plugin/dream-timer-module-client";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { ensureContextStoreUuid } from "../context-authority";
import {
    getMemoriesByProject,
    getUnclassifiedMemoryIds,
    insertMemory,
    recordMemoryVerifications,
} from "../memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { ensureProjectState, getProjectState } from "../storage-project-state";
import { getUserMemoryCandidates, insertUserMemory } from "../user-memory/storage-user-memory";
import { acquireLease } from "./lease";
import { applyRetrospectiveLearnings } from "./retrospective-learnings";
import { createDreamTaskExecutor } from "./task-executor";
import { leaseKeyFor } from "./task-registry";
import type { DreamTaskRuntimeConfig } from "./task-scheduler";

let db: Database | null = null;

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    runMigrations(database);
    return database;
}

function assistantMessages(text: string) {
    return [
        {
            info: { role: "assistant", time: { created: Date.now() } },
            parts: [{ type: "text", text }],
        },
    ];
}

describe("createDreamTaskExecutor — curate", () => {
    test("runs whole-pool curation without verification gate or watermark patch", async () => {
        db = freshDb();
        const project = "/repo/project";
        const first = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "First memory uses src/first.ts because it is load-bearing.",
        });
        const second = insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: "Second memory is a project workflow rule.",
        });
        recordMemoryVerifications(db, first.id, ["src/first.ts"], Date.now());
        insertUserMemory(db, "Prefer concise answers globally.", []);

        let capturedPrompt = "";
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                    capturedPrompt = args.body?.parts?.[0]?.text ?? "";
                    return {};
                }),
                messages: mock(async () => ({ data: assistantMessages("curation complete") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const config: DreamTaskRuntimeConfig = {
            task: "curate",
            schedule: "0 4 * * 0",
            timeoutMinutes: 20,
        };

        const result = await executor(config, {
            db,
            projectIdentity: project,
            holderId: "holder-curate",
            leaseKey: leaseKeyFor("curate", project),
        });

        expect(result).toEqual({ status: "completed", schedulePatch: undefined });
        expect(capturedPrompt).toContain("## Task: Curate Project Memory Pool (hygiene)");
        expect(capturedPrompt).toContain(first.content);
        expect(capturedPrompt).toContain(second.content);
        expect(capturedPrompt).toContain("Mapped files: src/first.ts");
        expect(capturedPrompt).toContain("### Global user profile (for the redundancy check)");
        expect(capturedPrompt).toContain("Prefer concise answers globally.");
        expect(capturedPrompt).not.toContain('ctx_memory(action="verified"');
        expect(capturedPrompt).not.toContain("verified_files");
    });

    test("adds the content language directive to curated prose tasks", async () => {
        db = freshDb();
        const project = "/repo/language-project";
        insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "The project stores prompts in src/prompts.ts.",
        });

        let capturedSystem = "";
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(async (args: { body?: { system?: string } }) => {
                    capturedSystem = args.body?.system ?? "";
                    return {};
                }),
                messages: mock(async () => ({ data: assistantMessages("curation complete") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            language: "tr",
        });

        await executor(
            { task: "curate", schedule: "0 4 * * 0", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-curate-language",
                leaseKey: leaseKeyFor("curate", project),
            },
        );

        expect(capturedSystem).toContain(
            "Write human-readable prose you author in: Turkish (Türkçe).",
        );
        expect(capturedSystem).toContain("Copy required output schemas exactly");
    });
});

describe("createDreamTaskExecutor — parent session resolution", () => {
    test("concurrent task runs all create children under the resolved parentID (no race-NULL)", async () => {
        db = freshDb();
        const project = "/repo/project";
        for (let i = 0; i < 3; i += 1) {
            insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: `Memory ${i} backed by src/file${i}.ts.`,
            });
        }

        // Delay session.list so the resolution await spans both concurrent calls
        // — the exact window the old flag-before-await memo leaked undefined into.
        let listCalls = 0;
        const createParentIds: Array<string | undefined> = [];
        const client = {
            session: {
                list: mock(async () => {
                    listCalls += 1;
                    await new Promise((r) => setTimeout(r, 20));
                    return { data: [{ id: "real-parent-session" }] };
                }),
                create: mock(async (args: { body?: { parentID?: string } }) => {
                    createParentIds.push(args.body?.parentID);
                    return { data: { id: `child-${createParentIds.length}` } };
                }),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({ data: assistantMessages("done") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });

        // Two DIFFERENT lease domains run concurrently (as the scheduler does via
        // Promise.all): curate (memory domain) + maintain-docs (its own domain).
        const curateKey = leaseKeyFor("curate", project);
        const docsKey = leaseKeyFor("maintain-docs", project);
        expect(acquireLease(db, "h-curate", curateKey)).toBe(true);
        expect(acquireLease(db, "h-docs", docsKey)).toBe(true);
        await Promise.all([
            executor(
                { task: "curate", schedule: "0 4 * * 0", timeoutMinutes: 20 },
                { db, projectIdentity: project, holderId: "h-curate", leaseKey: curateKey },
            ),
            executor(
                { task: "maintain-docs", schedule: "0 4 * * 0", timeoutMinutes: 20 },
                { db, projectIdentity: project, holderId: "h-docs", leaseKey: docsKey },
            ),
        ]);

        // The list runs once (shared promise), and BOTH children carry the real
        // parent — none created with an undefined parentID.
        expect(listCalls).toBe(1);
        expect(createParentIds.length).toBe(2);
        expect(createParentIds.every((id) => id === "real-parent-session")).toBe(true);
    });
});

describe("createDreamTaskExecutor — classify-memories", () => {
    test("runs the non-agentic XML transform and applies the manifest host-side", async () => {
        db = freshDb();
        const project = "/repo/project";
        // Stage 2 needs >= 10 memories in the pool to classify at all.
        const ids: number[] = [];
        for (let i = 0; i < 12; i += 1) {
            const m = insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: `Memory ${i}: the transform lives in src/file${i}.ts.`,
            });
            if (m) ids.push(m.id);
        }

        let capturedPrompt = "";
        let capturedAgent = "";
        // The classifier emits ONE <classify> manifest; the host parses + applies.
        const manifest = `<classify>\n${ids
            .map(
                (id) =>
                    `<memory id="${id}" importance="${40 + (id % 30)}" scope="project" shareable="true"/>`,
            )
            .join("\n")}\n</classify>`;
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(
                    async (args: {
                        body?: { agent?: string; parts?: Array<{ text?: string }> };
                    }) => {
                        capturedPrompt = args.body?.parts?.[0]?.text ?? "";
                        capturedAgent = args.body?.agent ?? "";
                        return {};
                    },
                ),
                messages: mock(async () => ({ data: assistantMessages(manifest) })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });

        // classify applies the manifest host-side under a lease-guarded
        // transaction, so the holder must actually hold the lease.
        const leaseKey = leaseKeyFor("classify-memories", project);
        expect(acquireLease(db, "holder-classify", leaseKey)).toBe(true);

        const result = await executor(
            { task: "classify-memories", schedule: "0 6 * * *", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-classify",
                leaseKey,
            },
        );

        expect(result).toEqual({ status: "completed", schedulePatch: undefined });
        // Zero-tool pure transform agent + the new XML prompt (no ctx_memory call).
        expect(capturedAgent).toBe("dreamer-classifier");
        expect(capturedPrompt).toContain("## Task: Classify Project Memories");
        expect(capturedPrompt).toContain("Emit one <classify> manifest");
        expect(capturedPrompt).not.toContain('ctx_memory(action="classify"');

        // Host applied the manifest: every memory is now classified (classified_at
        // stamped → no longer unclassified) and importance moved off the default.
        const stillUnclassified = getUnclassifiedMemoryIds(db, ids);
        expect(stillUnclassified).toEqual([]);
    });

    test("direct authority.status selects rust MODULE without a prior transform", async () => {
        db = freshDb();
        const project = "/repo/rust-classify";
        ensureContextStoreUuid(db);
        const sensitive = insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: "Use token sk-test-secret only on my localhost machine.",
        });
        const contextMemories = [sensitive];
        for (let i = 0; i < 11; i += 1) {
            contextMemories.push(
                insertMemory(db, {
                    projectPath: project,
                    category: "ARCHITECTURE",
                    content: `The cache-neutral classification path is module-owned (${i}).`,
                }),
            );
        }
        for (const [index, memory] of contextMemories.entries()) {
            db.prepare(
                "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', ?, ?, ?)",
            ).run(project, 10000 + index, memory.id);
            db.prepare(
                "INSERT INTO mirror_live_memory_rows(module_project, module_row_id, category, normalized_hash) VALUES (?, ?, ?, ?)",
            ).run(project, 10000 + index, memory.category, memory.normalizedHash);
        }
        const moduleCalls: Array<{ method: string; body: unknown }> = [];
        let authorityStatusCalls = 0;
        const client = {
            session: {
                list: mock(async () => ({ data: [{ id: "parent" }] })),
                create: mock(async () => ({ data: { id: "must-not-create" } })),
                delete: mock(async () => ({})),
            },
        };
        // This must be a class-backed fake: object-literal mocks cannot expose a detached-method
        // regression because they do not need instance state through the timer adapter.
        class StatefulTimerModuleClient {
            private readonly instanceState = "timer-transport";

            async authorityStatus() {
                authorityStatusCalls += 1;
                if (this.instanceState !== "timer-transport")
                    throw new Error("lost transport this");
                return { authority: { state: "MODULE", generation: 3 } };
            }

            async call(args: { method: string; body: unknown }) {
                if (this.instanceState !== "timer-transport")
                    throw new Error("lost transport this");
                moduleCalls.push(args);
                if (args.method === "dreamer.run_task") {
                    const body = args.body as { payload: { items: Array<{ memory_id: number }> } };
                    return {
                        ok: true,
                        manifest_text: `<classify>${body.payload.items
                            .map(
                                (item) =>
                                    `<memory id="${item.memory_id}" importance="80" scope="project" shareable="true"/>`,
                            )
                            .join("")}</classify>`,
                        truncated: false,
                    };
                }
                const rows = (args.body as { arguments: { rows: Array<{ memory_id: number }> } })
                    .arguments.rows;
                return { accepted: rows.map((row) => row.memory_id), rejected: [] };
            }
        }
        const moduleClient = createDreamTimerModuleClient(new StatefulTimerModuleClient() as never);
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            moduleClient: moduleClient as never,
        });
        const leaseKey = leaseKeyFor("classify-memories", project);
        expect(acquireLease(db, "holder-rust-classify", leaseKey)).toBe(true);
        const result = await executor(
            { task: "classify-memories", schedule: "0 6 * * *", timeoutMinutes: 20 },
            { db, projectIdentity: project, holderId: "holder-rust-classify", leaseKey },
        );
        expect(result.status).toBe("completed");
        expect(authorityStatusCalls).toBe(1);
        expect(client.session.create).not.toHaveBeenCalled();
        expect(moduleCalls.map((call) => call.method)).toEqual([
            "dreamer.run_task",
            "memory.set_classification",
        ]);
        const applyBody = moduleCalls[1].body as {
            arguments: { rows: Array<{ memory_id: number; shareable: boolean }> };
        };
        expect(applyBody.arguments.rows.find((row) => row.memory_id === 10000)?.shareable).toBe(
            false,
        );
    });
    test("module failures are transient and never fall back to a TypeScript child", async () => {
        db = freshDb();
        const project = "/repo/rust-classify-failure";
        ensureContextStoreUuid(db);
        for (let i = 0; i < 12; i += 1) {
            const memory = insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: `Module classification failure fixture ${i}.`,
            });
            db.prepare(
                "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', ?, ?, ?)",
            ).run(project, 11000 + i, memory.id);
            db.prepare(
                "INSERT INTO mirror_live_memory_rows(module_project, module_row_id, category, normalized_hash) VALUES (?, ?, ?, ?)",
            ).run(project, 11000 + i, memory.category, memory.normalizedHash);
        }

        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "must-not-create" } })),
                delete: mock(async () => ({})),
            },
        };
        const moduleCalls: string[] = [];
        class FailingTimerModuleClient {
            private readonly instanceState = "timer-transport";

            async authorityStatus() {
                if (this.instanceState !== "timer-transport")
                    throw new Error("lost transport this");
                return { authority: { state: "MODULE", generation: 9 } };
            }

            async call(args: { method: string }) {
                if (this.instanceState !== "timer-transport")
                    throw new Error("lost transport this");
                moduleCalls.push(args.method);
                throw new Error("module transport unavailable");
            }
        }
        const moduleClient = createDreamTimerModuleClient(new FailingTimerModuleClient() as never);
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            moduleClient: moduleClient as never,
        });
        const leaseKey = leaseKeyFor("classify-memories", project);
        expect(acquireLease(db, "holder-rust-classify-failure", leaseKey)).toBe(true);

        const result = await executor(
            { task: "classify-memories", schedule: "0 6 * * *", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-rust-classify-failure",
                leaseKey,
            },
        );

        expect(result.status).toBe("failed");
        expect(result.transient).toBe(true);
        expect(result.error).toContain("Rust classify module failed");
        expect(client.session.create).not.toHaveBeenCalled();
        expect(moduleCalls).toEqual(["dreamer.run_task"]);
    });
});

describe("createDreamTaskExecutor — compress-cues", () => {
    test("parks MODULE authority before any provider call", async () => {
        db = freshDb();
        const project = "/repo/module-cues";
        ensureContextStoreUuid(db);
        insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "A cue candidate that must not be sent to a provider.",
        });
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "must-not-create" } })),
                prompt: mock(async () => ({})),
            },
        };
        const authorityStatus = mock(async () => ({
            authority: { state: "MODULE", generation: 12 },
        }));
        const moduleCall = mock(async () => ({}));
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            experimentalMural: { enabled: true },
            moduleClient: { authorityStatus, call: moduleCall } as never,
        });
        const leaseKey = leaseKeyFor("compress-cues", project);
        expect(acquireLease(db, "holder-module-cues", leaseKey)).toBe(true);

        const result = await executor(
            { task: "compress-cues", schedule: "0 7 * * *", timeoutMinutes: 20 },
            { db, projectIdentity: project, holderId: "holder-module-cues", leaseKey },
        );

        expect(result.status).toBe("failed");
        expect(result.transient).toBe(true);
        expect(result.error).toContain("MODULE memory authority has no cue write facade");
        expect(authorityStatus).toHaveBeenCalledTimes(1);
        expect(client.session.create).not.toHaveBeenCalled();
        expect(client.session.prompt).not.toHaveBeenCalled();
        expect(moduleCall).not.toHaveBeenCalled();
    });

    test("reports a structural membership failure as transient", async () => {
        db = freshDb();
        const project = "/repo/malformed-cues";
        insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "A cue candidate omitted by the manifest.",
        });
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "cue-child" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({ data: assistantMessages("<cues></cues>") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            experimentalMural: { enabled: true },
        });
        const leaseKey = leaseKeyFor("compress-cues", project);
        expect(acquireLease(db, "holder-malformed-cues", leaseKey)).toBe(true);

        const result = await executor(
            { task: "compress-cues", schedule: "0 7 * * *", timeoutMinutes: 20 },
            { db, projectIdentity: project, holderId: "holder-malformed-cues", leaseKey },
        );

        expect(result.status).toBe("failed");
        expect(result.transient).toBe(true);
        expect(result.error).toContain("1 selected memories remain");
        expect(client.session.prompt).toHaveBeenCalledTimes(1);
    });

    test("reports a fully drained cue set as completed", async () => {
        db = freshDb();
        const project = "/repo/complete-cues";
        const memory = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "A cue candidate completed by the manifest.",
        });
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "cue-child" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: assistantMessages(
                        `<cues><cue id="${memory.id}">completed anchor</cue></cues>`,
                    ),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            experimentalMural: { enabled: true },
        });
        const leaseKey = leaseKeyFor("compress-cues", project);
        expect(acquireLease(db, "holder-complete-cues", leaseKey)).toBe(true);

        const result = await executor(
            { task: "compress-cues", schedule: "0 7 * * *", timeoutMinutes: 20 },
            { db, projectIdentity: project, holderId: "holder-complete-cues", leaseKey },
        );

        expect(result).toEqual({ status: "completed" });
    });
});

describe("createDreamTaskExecutor — retrospective", () => {
    test("retrospective memory insert leaves project memory epoch unchanged", () => {
        db = freshDb();
        const project = "/repo/project";
        ensureProjectState(db, project, 1);
        const epochBefore = getProjectState(db, project)?.projectMemoryEpoch;

        const applied = applyRetrospectiveLearnings({
            db,
            projectIdentity: project,
            sourceSessionId: "s1",
            learnings: [
                {
                    route: "memory",
                    category: "PROJECT_RULES",
                    content:
                        "Verify provider-executed tool availability before describing it as supported.",
                },
            ],
            userMemoryCollectionEnabled: false,
            sourceUserTexts: [],
        });

        expect(applied.memoryWritten).toBe(1);
        expect(getProjectState(db, project)?.projectMemoryEpoch).toBe(epochBefore);
    });

    test("gate returns 'n' → one gate turn, child created+deleted, watermark advances, no deepen", async () => {
        db = freshDb();
        const project = "/repo/project";
        const provider = {
            listProjectSessions: mock(() => [{ sessionId: "s1" }]),
            readUserMessagesSince: mock(() => ({
                messages: [
                    {
                        sessionId: "s1",
                        ordinal: 1,
                        role: "user" as const,
                        text: "Please add a focused migration test for the new config key.",
                        ts: 200,
                    },
                ],
                truncated: false,
            })),
            readUserMessagesBefore: mock(() => []),
        };
        let prompts = 0;
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "retro-child" } })),
                prompt: mock(async () => {
                    prompts += 1;
                    return {};
                }),
                // Gate turn → verdict "n" (no friction). The deepen turn never runs.
                messages: mock(async () => ({ data: assistantMessages("n") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            retrospectiveRawProvider: provider,
            userMemoryCollectionEnabled: true,
        });

        const result = await executor(
            { task: "retrospective", schedule: "0 5 * * *", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-retro-clean",
                leaseKey: leaseKeyFor("retrospective", project),
            },
        );

        // Completed with the content watermark advanced to the max ts scanned.
        expect(result).toEqual({
            status: "completed",
            schedulePatch: { retrospectiveWatermarkMs: 200 },
        });
        expect(client.session.create).toHaveBeenCalled();
        expect(prompts).toBe(1); // gate only — no deepen turn
        expect(client.session.delete).toHaveBeenCalled(); // child always cleaned up
        expect(getMemoriesByProject(db, project)).toHaveLength(0);
    });

    test("signal deepens, parses XML, host-applies memory and gated observation", async () => {
        db = freshDb();
        const project = "/repo/project";
        const provider = {
            listProjectSessions: mock(() => [{ sessionId: "s1" }]),
            readUserMessagesSince: mock(() => ({
                messages: [
                    {
                        sessionId: "s1",
                        ordinal: 1,
                        role: "user" as const,
                        text: "Please verify provider-executed tools on the wire before saying they work.",
                        ts: 200,
                    },
                    {
                        sessionId: "s1",
                        ordinal: 2,
                        role: "assistant" as const,
                        text: "It should work.",
                        ts: 210,
                    },
                    {
                        sessionId: "s1",
                        ordinal: 3,
                        role: "user" as const,
                        text: "Please verify provider executed tools on wire before saying they work.",
                        ts: 220,
                    },
                ],
                truncated: false,
            })),
        };
        provider.readUserMessagesBefore = mock(() => []);
        // The two turns share one `messages` mock — drive the response off the
        // per-prompt system string the runner sets: gate system → "y: <ord>",
        // deepen system → the learnings XML.
        const captured: Array<{ agent: string; system: string; prompt: string }> = [];
        let lastSystem = "";
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "retro-child" } })),
                prompt: mock(
                    async (args: {
                        body?: {
                            agent?: string;
                            system?: string;
                            parts?: Array<{ text?: string }>;
                        };
                    }) => {
                        lastSystem = args.body?.system ?? "";
                        captured.push({
                            agent: args.body?.agent ?? "",
                            system: lastSystem,
                            prompt: args.body?.parts?.[0]?.text ?? "",
                        });
                        return {};
                    },
                ),
                messages: mock(async () => {
                    const isGate = lastSystem.includes("friction detector");
                    return {
                        data: assistantMessages(
                            isGate
                                ? "y: 3"
                                : `<learnings>
  <learning route="memory" category="PROJECT_RULES">Verify provider-executed tool availability on wire before describing it as supported.</learning>
  <learning route="observation">Prefers concise root-cause summaries before implementation details.</learning>
  <learning route="memory" category="PROJECT_RULES">On 2026-06-01 the user said &quot;wrong again&quot;.</learning>
</learnings>`,
                        ),
                    };
                }),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            retrospectiveRawProvider: provider,
            userMemoryCollectionEnabled: true,
        });

        const result = await executor(
            { task: "retrospective", schedule: "0 5 * * *", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-retro-hit",
                leaseKey: leaseKeyFor("retrospective", project),
            },
        );

        expect(result).toEqual({
            status: "completed",
            schedulePatch: { retrospectiveWatermarkMs: 220 },
        });
        // Two turns: gate (friction-detector system) then deepen (learning system).
        expect(captured).toHaveLength(2);
        expect(captured[0]?.system).toContain("friction detector");
        expect(captured[1]?.agent).toBe("dreamer-retrospective");
        expect(captured[1]?.system).toContain("retrospective learning agent");
        expect(captured[1]?.prompt).toContain("### Friction window");
        expect(captured[1]?.prompt).not.toContain("ctx_memory");
        const memories = getMemoriesByProject(db, project);
        expect(memories.map((memory) => memory.content)).toEqual([
            "Verify provider-executed tool availability on wire before describing it as supported.",
        ]);
        expect(memories[0]?.sourceType).toBe("dreamer");
        expect(getUserMemoryCandidates(db).map((candidate) => candidate.content)).toEqual([
            "Prefers concise root-cause summaries before implementation details.",
        ]);
    });

    test("drops observation learnings when user-memory collection is disabled", async () => {
        db = freshDb();
        const project = "/repo/project";
        const provider = {
            listProjectSessions: mock(() => [{ sessionId: "s1" }]),
            readUserMessagesSince: mock(() => ({
                messages: [
                    {
                        sessionId: "s1",
                        ordinal: 1,
                        role: "user" as const,
                        text: "Please stop assuming CLI commands work without checking the actual output.",
                        ts: 200,
                    },
                    {
                        sessionId: "s1",
                        ordinal: 2,
                        role: "user" as const,
                        text: "Please stop assuming CLI commands work without checking actual output.",
                        ts: 220,
                    },
                ],
                truncated: false,
            })),
            readUserMessagesBefore: mock(() => []),
        };
        let lastSystem = "";
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "retro-child" } })),
                prompt: mock(async (args: { body?: { system?: string } }) => {
                    lastSystem = args.body?.system ?? "";
                    return {};
                }),
                messages: mock(async () => ({
                    data: assistantMessages(
                        lastSystem.includes("friction detector")
                            ? "y: 2"
                            : `<learnings>
  <learning route="observation">Prefers tool claims backed by observed command output.</learning>
</learnings>`,
                    ),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            retrospectiveRawProvider: provider,
            userMemoryCollectionEnabled: false,
        });

        await executor(
            { task: "retrospective", schedule: "0 5 * * *", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-retro-observation-off",
                leaseKey: leaseKeyFor("retrospective", project),
            },
        );

        expect(getUserMemoryCandidates(db)).toEqual([]);
    });
});
