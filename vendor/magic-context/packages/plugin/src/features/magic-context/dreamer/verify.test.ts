/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import {
    getProjectEmbeddings,
    insertMemory,
    loadAllEmbeddings,
    peekProjectEmbeddings,
    resetEmbeddingCacheForTests,
    saveEmbedding,
} from "../memory";
import { getMemoryById } from "../memory/storage-memory";
import {
    getMemoryVerifications,
    recordMemoryVerifications,
} from "../memory/storage-memory-verifications";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { acquireLease } from "./lease";
import { applyVerifyManifest, runVerify, type VerifyArgs } from "./verify";

const tempDirs: string[] = [];

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function tempProject(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "mc-verify-"));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "old.ts"), "export const oldValue = 1;", "utf8");
    writeFileSync(path.join(dir, "src", "new.ts"), "export const newValue = 2;", "utf8");
    return dir;
}

function verifyArgs(db: Database, sessionDirectory: string, projectIdentity: string): VerifyArgs {
    const holderId = "verify-holder";
    const leaseKey = `verify-${Math.random()}`;
    expect(acquireLease(db, holderId, leaseKey)).toBe(true);
    return {
        db,
        client: {} as never,
        projectIdentity,
        parentSessionId: undefined,
        sessionDirectory,
        holderId,
        leaseKey,
        deadline: Date.now() + 60_000,
    };
}

afterEach(() => {
    resetEmbeddingCacheForTests();
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

function assistantMessages(text: string) {
    return [
        {
            info: { role: "assistant", time: { created: Date.now() } },
            parts: [{ type: "text", text }],
        },
    ];
}

function successfulVerifyClient(onPrompt?: () => void) {
    let manifest = "";
    return {
        session: {
            create: async () => ({ data: { id: "verify-child" } }),
            prompt: async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                const prompt = args.body?.parts?.[0]?.text ?? "";
                const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
                manifest = `<verify>${ids.map((id) => `<verified id="${id}" files="src/fact.ts"/>`).join("")}</verify>`;
                onPrompt?.();
                return {};
            },
            messages: async () => ({ data: assistantMessages(manifest) }),
            delete: async () => ({}),
        },
    };
}

function addMappedMemories(db: Database, projectIdentity: string, count: number): void {
    for (let index = 0; index < count; index += 1) {
        const memory = insertMemory(db, {
            projectPath: projectIdentity,
            category: "ARCHITECTURE",
            content: `Mapped fact ${index}.`,
            sourceSessionId: "ses",
        });
        recordMemoryVerifications(db, memory.id, ["src/fact.ts"], 1_000);
    }
}

describe("runVerify disposition", () => {
    test("banks a completed batch and reports the deadline remainder", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-deadline";
            const dir = tempProject();
            addMappedMemories(db, projectIdentity, 51);
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = successfulVerifyClient(() => {
                args.deadline = Date.now() - 1;
            }) as never;

            const result = await runVerify(args);

            expect(result.verified).toBe(50);
            expect(result.remaining).toBe(1);
            expect(result.complete).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("reports complete after fully draining the selected set", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-complete";
            const dir = tempProject();
            addMappedMemories(db, projectIdentity, 1);
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = successfulVerifyClient() as never;

            const result = await runVerify(args);
            expect(result.verified).toBe(1);
            expect(result.remaining).toBe(0);
            expect(result.complete).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test("reports a swallowed batch failure as incomplete", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-failure";
            const dir = tempProject();
            addMappedMemories(db, projectIdentity, 1);
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = {
                session: {
                    create: async () => {
                        throw new Error("provider unavailable");
                    },
                },
            } as never;

            const result = await runVerify(args);
            expect(result.complete).toBe(false);
            expect(result.remaining).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("applyVerifyManifest", () => {
    test("content rewrites clear stale file mappings and embedding cache", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Old value lives in src/old.ts.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, memory.id, ["src/old.ts"], 1_000);
            saveEmbedding(db, memory.id, new Float32Array([1, 2, 3, 4]), "model-a");
            expect(getProjectEmbeddings(db, projectIdentity, "model-a").has(memory.id)).toBe(true);

            const result = await applyVerifyManifest(
                verifyArgs(db, dir, projectIdentity),
                [
                    {
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        mappedFiles: ["src/old.ts"],
                    },
                ],
                `<verify><update id="${memory.id}" files="src/new.ts">New value lives in src/new.ts.</update></verify>`,
            );

            expect(result).toEqual({ verified: 0, updated: 1, archived: 0 });
            expect(getMemoryById(db, memory.id)?.content).toBe("New value lives in src/new.ts.");
            expect(getMemoryVerifications(db, [memory.id]).has(memory.id)).toBe(false);
            expect(loadAllEmbeddings(db, projectIdentity, "model-a").has(memory.id)).toBe(false);
            expect(peekProjectEmbeddings(projectIdentity, "model-a")?.has(memory.id)).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("rejects conflicting terminal verdicts for the same memory id", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Old value lives in src/old.ts.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, memory.id, ["src/old.ts"], 1_000);

            await expect(
                applyVerifyManifest(
                    verifyArgs(db, dir, projectIdentity),
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            mappedFiles: ["src/old.ts"],
                        },
                    ],
                    `<verify><verified id="${memory.id}" files="src/old.ts"/><archive id="${memory.id}" reason="stale"/></verify>`,
                ),
            ).rejects.toThrow(/duplicate id/);

            expect(getMemoryById(db, memory.id)?.status).toBe("active");
            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state?.files).toEqual(["src/old.ts"]);
            expect(state?.verifiedAt).toBe(1_000);
        } finally {
            closeQuietly(db);
        }
    });

    test("rejects a truncated manifest before any DB write", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Old value lives in src/old.ts.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, memory.id, ["src/old.ts"], 1_000);

            await expect(
                applyVerifyManifest(
                    verifyArgs(db, dir, projectIdentity),
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            mappedFiles: ["src/old.ts"],
                        },
                    ],
                    `<verify><archive id="${memory.id}" reason="stale"/>`,
                ),
            ).rejects.toThrow(/closing root/);

            expect(getMemoryById(db, memory.id)?.status).toBe("active");
            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state?.files).toEqual(["src/old.ts"]);
            expect(state?.verifiedAt).toBe(1_000);
        } finally {
            closeQuietly(db);
        }
    });
});
