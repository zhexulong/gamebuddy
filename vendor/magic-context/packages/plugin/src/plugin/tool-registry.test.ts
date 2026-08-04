/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import type { MagicContextPluginConfig } from "../config";
import { closeDatabase, openDatabase } from "../features/magic-context/storage";
import type { RustToolBackends } from "./rust-tool-backends";
import { createToolRegistry } from "./tool-registry";
import type { PluginContext } from "./types";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* ignore */
        }
    }
    tempDirs.length = 0;
});

function isolateDb(): void {
    const dir = mkdtempSync(join(tmpdir(), "tool-registry-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

// createToolRegistry only reads ctx.directory; the rest of PluginContext is
// unused, so a minimal stub is sufficient.
const ctx = { directory: process.cwd() } as unknown as PluginContext;

function buildRegistry(
    config: Partial<MagicContextPluginConfig>,
    rustToolBackends?: RustToolBackends,
): Record<string, ToolDefinition> {
    return createToolRegistry({
        ctx,
        pluginConfig: { enabled: true, ...config } as MagicContextPluginConfig,
        rustToolBackends,
    });
}

describe("createToolRegistry — memory gating", () => {
    it("advertises only real ctx_* fields", () => {
        isolateDb();
        const tools = buildRegistry({});
        const expectedFields: Record<string, string[]> = {
            ctx_reduce: ["drop"],
            ctx_expand: ["start", "end", "verbose", "message"],
            ctx_note: [
                "action",
                "content",
                "surface_condition",
                "filter",
                "limit",
                "offset",
                "note_id",
            ],
            ctx_search: ["query", "limit", "sources"],
            ctx_memory: ["action", "content", "category", "ids", "limit", "reason"],
        };

        for (const [name, fields] of Object.entries(expectedFields)) {
            const definition = tools[name];
            expect(definition).toBeDefined();
            const jsonSchema = tool.schema.toJSONSchema(
                tool.schema.object(definition?.args ?? {}),
            ) as { properties?: Record<string, unknown> };
            expect(Object.keys(jsonSchema.properties ?? {}).sort()).toEqual([...fields].sort());
            expect(jsonSchema.properties).not.toHaveProperty("reduced");
            expect(jsonSchema.properties).not.toHaveProperty("summary");
        }
    });

    it("registers ctx_memory when memory is enabled (default)", () => {
        isolateDb();
        const tools = buildRegistry({});
        expect(Object.keys(tools)).toContain("ctx_memory");
        expect(Object.keys(tools)).toContain("ctx_search");
    });

    it("keeps ctx_note on context.db in rust mode", async () => {
        isolateDb();
        let moduleCalls = 0;
        const tools = buildRegistry(
            { transform_mode: "rust" },
            {
                reduce: async () => {
                    moduleCalls += 1;
                    return { ok: true, queued: 1 };
                },
                memorySync: () => {
                    moduleCalls += 1;
                },
            },
        );

        const result = await tools.ctx_note.execute(
            { action: "write", content: "Notes remain on the OpenCode leg." },
            { sessionID: "ses-note-rust", directory: process.cwd() },
        );
        const db = openDatabase();
        const row = db
            ?.prepare("SELECT content FROM notes WHERE session_id = ?")
            .get("ses-note-rust") as { content: string } | undefined;

        expect(result).toContain("Saved session note");
        expect(row?.content).toBe("Notes remain on the OpenCode leg.");
        expect(moduleCalls).toBe(0);
    });

    it("omits ctx_memory when memory.enabled is false, but keeps ctx_search", () => {
        isolateDb();
        const tools = buildRegistry({ memory: { enabled: false } as never });
        expect(Object.keys(tools)).not.toContain("ctx_memory");
        expect(Object.keys(tools)).toContain("ctx_search");
        // ctx_note / ctx_expand are unaffected by the memory gate.
        expect(Object.keys(tools)).toContain("ctx_note");
        expect(Object.keys(tools)).toContain("ctx_expand");
    });
});
