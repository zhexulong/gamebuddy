/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { insertMemory } from "../memory";
import {
    getMemoryVerifications,
    recordMemoryMapping,
} from "../memory/storage-memory-verifications";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { acquireLease } from "./lease";
import { applyBatchMappings, type MapMemoriesArgs, mapMemories } from "./map-memories";

const tempDirs: string[] = [];

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function tempProject(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "mc-map-memories-"));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "fact.ts"), "export const fact = true;", "utf8");
    return dir;
}

function mapArgs(db: Database, sessionDirectory: string, projectIdentity: string): MapMemoriesArgs {
    const holderId = "map-holder";
    const leaseKey = `map-${Math.random()}`;
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

function successfulMapClient(onPrompt?: () => void) {
    let manifest = "";
    return {
        session: {
            create: async () => ({ data: { id: "map-child" } }),
            prompt: async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                const prompt = args.body?.parts?.[0]?.text ?? "";
                const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
                manifest = `<mappings>${ids.map((id) => `<memory id="${id}" independent="true"/>`).join("")}</mappings>`;
                onPrompt?.();
                return {};
            },
            messages: async () => ({ data: assistantMessages(manifest) }),
            delete: async () => ({}),
        },
    };
}

describe("mapMemories disposition", () => {
    test("banks a completed batch and reports the deadline remainder", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-deadline";
            const dir = tempProject();
            for (let index = 0; index < 81; index += 1) {
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Independent fact ${index}.`,
                    sourceSessionId: "ses",
                });
            }
            const args = mapArgs(db, dir, projectIdentity);
            args.client = successfulMapClient(() => {
                args.deadline = Date.now() - 1;
            }) as never;

            const result = await mapMemories(args);

            expect(result).toEqual({
                mapped: 0,
                independent: 80,
                batches: 1,
                remaining: 1,
                complete: false,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("reports complete after fully draining the selected set", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-complete";
            const dir = tempProject();
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Independent fact.",
                sourceSessionId: "ses",
            });
            const args = mapArgs(db, dir, projectIdentity);
            args.client = successfulMapClient() as never;

            expect(await mapMemories(args)).toEqual({
                mapped: 0,
                independent: 1,
                batches: 1,
                remaining: 0,
                complete: true,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("reports a swallowed batch failure as incomplete", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:map-failure";
            const dir = tempProject();
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Independent fact.",
                sourceSessionId: "ses",
            });
            const args = mapArgs(db, dir, projectIdentity);
            args.client = {
                session: {
                    create: async () => {
                        throw new Error("provider unavailable");
                    },
                },
            } as never;

            const result = await mapMemories(args);
            expect(result.complete).toBe(false);
            expect(result.remaining).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("applyBatchMappings", () => {
    test("complete manifest writes the mapping", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Fact lives in src/fact.ts.",
                sourceSessionId: "ses",
            });

            const result = await applyBatchMappings(
                mapArgs(db, dir, projectIdentity),
                [
                    {
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        candidates: [],
                    },
                ],
                `<mappings><memory id="${memory.id}" files="src/fact.ts"/></mappings>`,
            );

            expect(result).toEqual({ mapped: 1, independent: 0 });
            expect(getMemoryVerifications(db, [memory.id]).get(memory.id)?.files).toEqual([
                "src/fact.ts",
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("truncated manifest rejects before replacing an existing mapping", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Fact lives in src/fact.ts.",
                sourceSessionId: "ses",
            });
            recordMemoryMapping(db, memory.id, [], 1_000);

            await expect(
                applyBatchMappings(
                    mapArgs(db, dir, projectIdentity),
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            candidates: [],
                        },
                    ],
                    `<mappings><memory id="${memory.id}" files="src/fact.ts"/>`,
                ),
            ).rejects.toThrow(/closing root/);

            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state?.files).toEqual([]);
            expect(state?.hasSentinel).toBe(true);
            expect(state?.mappedAt).toBe(1_000);
        } finally {
            closeQuietly(db);
        }
    });
});
