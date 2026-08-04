/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import {
    getOverflowState,
    recordOverflowDetected,
} from "../../features/magic-context/storage-meta-persisted";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createEventHook, createToolExecuteAfterHook } from "./hook-handlers";

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function createTestHook(db: Database): ReturnType<typeof createToolExecuteAfterHook> {
    return createToolExecuteAfterHook({
        db,
        channel1StateBySession: new Map(),
    });
}

describe("createToolExecuteAfterHook todo snapshots", () => {
    test("rust mode forwards todo state to the module without changing TS capture", async () => {
        const db = createTestDb();
        try {
            const calls: Array<{ sessionId: string; stateJson: string; ownerMessageId: string }> =
                [];
            const hook = createToolExecuteAfterHook({
                db,
                channel1StateBySession: new Map(),
                transformMode: "rust",
                todoStateSet: async (input) => {
                    calls.push(input);
                },
            });
            await hook({
                tool: "todowrite",
                sessionID: "ses-rust-todo",
                args: {
                    todos: [{ status: "pending", priority: "high", content: "Forward me" }],
                    owner_message_id: "msg-owner",
                },
            });
            expect(calls).toEqual([
                {
                    sessionId: "ses-rust-todo",
                    stateJson: '[{"content":"Forward me","status":"pending","priority":"high"}]',
                    ownerMessageId: "msg-owner",
                },
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("todowrite persists the latest todo state", async () => {
        const db = createTestDb();
        try {
            const hook = createTestHook(db);

            await hook({
                tool: "todowrite",
                sessionID: "ses-todo",
                args: {
                    todos: [
                        {
                            status: "pending",
                            priority: "high",
                            content: "Review audit",
                            extra: true,
                        },
                    ],
                },
            });

            expect(getOrCreateSessionMeta(db, "ses-todo").lastTodoState).toBe(
                '[{"content":"Review audit","status":"pending","priority":"high"}]',
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("multiple todowrite calls replace the snapshot", async () => {
        const db = createTestDb();
        try {
            const hook = createTestHook(db);

            await hook({
                tool: "todowrite",
                sessionID: "ses-todo",
                args: { todos: [{ content: "First", status: "pending", priority: "low" }] },
            });
            await hook({
                tool: "todowrite",
                sessionID: "ses-todo",
                args: { todos: [{ content: "Second", status: "in_progress", priority: "high" }] },
            });

            expect(getOrCreateSessionMeta(db, "ses-todo").lastTodoState).toBe(
                '[{"content":"Second","status":"in_progress","priority":"high"}]',
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("non-todowrite tools do not update todo state", async () => {
        const db = createTestDb();
        try {
            const hook = createTestHook(db);
            updateSessionMeta(db, "ses-other", { lastTodoState: "[]" });

            await hook({
                tool: "read",
                sessionID: "ses-other",
                args: { todos: [{ content: "Nope", status: "pending", priority: "high" }] },
            });

            expect(getOrCreateSessionMeta(db, "ses-other").lastTodoState).toBe("[]");
        } finally {
            closeQuietly(db);
        }
    });

    test("subagent sessions skip todo snapshot updates", async () => {
        const db = createTestDb();
        try {
            const hook = createTestHook(db);
            updateSessionMeta(db, "ses-sub", { isSubagent: true });

            await hook({
                tool: "todowrite",
                sessionID: "ses-sub",
                args: { todos: [{ content: "Sub work", status: "pending", priority: "high" }] },
            });

            expect(getOrCreateSessionMeta(db, "ses-sub").lastTodoState).toBe("");
        } finally {
            closeQuietly(db);
        }
    });

    test("foreign todowrite statuses leave state unchanged", async () => {
        const db = createTestDb();
        try {
            const hook = createTestHook(db);
            updateSessionMeta(db, "ses-foreign", { lastTodoState: "[]" });

            await hook({
                tool: "todowrite",
                sessionID: "ses-foreign",
                args: { todos: [{ content: "Third-party", status: "done" }] },
            });

            expect(getOrCreateSessionMeta(db, "ses-foreign").lastTodoState).toBe("[]");
        } finally {
            closeQuietly(db);
        }
    });

    test("missing or non-array todowrite todos leave state unchanged", async () => {
        const db = createTestDb();
        try {
            const hook = createTestHook(db);
            updateSessionMeta(db, "ses-malformed", { lastTodoState: "[]" });

            await hook({
                tool: "todowrite",
                sessionID: "ses-malformed",
                args: {},
            });
            await hook({
                tool: "todowrite",
                sessionID: "ses-malformed",
                args: { todos: { content: "Not an array", status: "pending" } },
            });

            expect(getOrCreateSessionMeta(db, "ses-malformed").lastTodoState).toBe("[]");
        } finally {
            closeQuietly(db);
        }
    });

    test("malformed todowrite args leave state unchanged", async () => {
        const db = createTestDb();
        try {
            const hook = createTestHook(db);
            updateSessionMeta(db, "ses-malformed", { lastTodoState: "[]" });

            await hook({
                tool: "todowrite",
                sessionID: "ses-malformed",
                args: { todos: [{ content: "Missing status" }] },
            });

            expect(getOrCreateSessionMeta(db, "ses-malformed").lastTodoState).toBe("[]");
        } finally {
            closeQuietly(db);
        }
    });
});

describe("createEventHook mid-session model switch clears overflow state", () => {
    function makeAssistantEvent(sessionID: string, providerID: string, modelID: string) {
        return {
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        sessionID,
                        id: `msg-${Math.random().toString(36).slice(2)}`,
                        providerID,
                        modelID,
                        finish: "stop",
                        tokens: { input: 1000, cache: { read: 0, write: 0 } },
                    },
                },
            },
        };
    }

    test("clears detected_context_limit + needs_emergency_recovery on model change", async () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-model-switch";
            const liveModelBySession = new Map<string, { providerID: string; modelID: string }>();
            const hook = createEventHook({
                eventHandler: async () => {},
                contextUsageMap: new Map(),
                db,
                liveModelBySession,
                variantBySession: new Map(),
                agentBySession: new Map(),
                sessionDirectoryBySession: new Map(),
                historyRefreshSessions: new Set(),
                deferredHistoryRefreshSessions: new Set(),
                systemPromptRefreshSessions: new Set(),
                pendingMaterializationSessions: new Set(),
                deferredMaterializationSessions: new Set(),
                lastHeuristicsTurnId: new Map(),
                client: undefined as never,
                protectedTags: 5,
            });

            // First assistant response on the small-context model.
            await hook(makeAssistantEvent(sessionId, "anthropic", "claude-small"));
            // Session overflowed on the small model → records a detected limit + arms recovery.
            recordOverflowDetected(db, sessionId, 120_000);
            let overflow = getOverflowState(db, sessionId);
            expect(overflow.detectedContextLimit).toBe(120_000);
            expect(overflow.needsEmergencyRecovery).toBe(true);

            // User switches to a 1M-context model mid-session — next assistant event
            // carries the new model. The handler must clear BOTH the stale detected
            // limit and the recovery flag so the new model's pressure math is clean.
            await hook(makeAssistantEvent(sessionId, "anthropic", "claude-large"));
            overflow = getOverflowState(db, sessionId);
            expect(overflow.detectedContextLimit).toBe(0);
            expect(overflow.needsEmergencyRecovery).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("does NOT clear overflow state when the model is unchanged", async () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-same-model";
            const liveModelBySession = new Map<string, { providerID: string; modelID: string }>();
            const hook = createEventHook({
                eventHandler: async () => {},
                contextUsageMap: new Map(),
                db,
                liveModelBySession,
                variantBySession: new Map(),
                agentBySession: new Map(),
                sessionDirectoryBySession: new Map(),
                historyRefreshSessions: new Set(),
                deferredHistoryRefreshSessions: new Set(),
                systemPromptRefreshSessions: new Set(),
                pendingMaterializationSessions: new Set(),
                deferredMaterializationSessions: new Set(),
                lastHeuristicsTurnId: new Map(),
                client: undefined as never,
                protectedTags: 5,
            });

            await hook(makeAssistantEvent(sessionId, "anthropic", "claude-small"));
            recordOverflowDetected(db, sessionId, 120_000);
            // Same model again — detected limit must persist (authoritative on this model).
            await hook(makeAssistantEvent(sessionId, "anthropic", "claude-small"));
            const overflow = getOverflowState(db, sessionId);
            expect(overflow.detectedContextLimit).toBe(120_000);
            expect(overflow.needsEmergencyRecovery).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });
});
