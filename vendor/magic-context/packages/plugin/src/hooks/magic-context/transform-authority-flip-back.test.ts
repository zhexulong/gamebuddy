/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import {
    type AuthorityStatus,
    getAuthorityManagedMarker,
    installAuthorityManagedMarker,
} from "../../features/magic-context/context-authority";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getProjectState } from "../../features/magic-context/storage-project-state";
import { Database } from "../../shared/sqlite";
import type { RustModeModuleClient } from "./rust-mode-transform";
import { recoverTsAuthorityProject } from "./transform";

const PROJECT = "git:flip-back";

function status(domain: "memories" | "notes", state: AuthorityStatus["state"]): AuthorityStatus {
    return {
        context_store_uuid: "store",
        project: PROJECT,
        domain,
        state,
        generation: 1,
        captured_upper_bound: 0,
        coordinator_token: "drain-token",
    };
}

describe("TS authority flip-back", () => {
    test("drains real authority protocol, removes the marker, and bumps the memory epoch once", async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        installAuthorityManagedMarker(db, PROJECT);
        const states = new Map<"memories" | "notes", AuthorityStatus["state"]>([
            ["memories", "MODULE"],
            ["notes", "MODULE"],
        ]);
        const roots: string[] = [];
        const module: RustModeModuleClient = {
            call: async () => ({ ok: true }),
            authorityStatus: async (args) => {
                roots.push(String(args.projectRoot));
                return { authority: status(args.domain, states.get(args.domain) ?? "TS") };
            },
            authorityPrepare: async () => ({ authority: status("memories", "MODULE") }),
            authorityDrain: async (args) => {
                const domain = String(args.domain) as "memories" | "notes";
                if (args.action === "finish") states.set(domain, "TS");
                else states.set(domain, "DRAINING");
                return { authority: status(domain, states.get(domain) ?? "TS") };
            },
            mirrorPull: async (args) => ({
                page: {
                    domain: args.domain,
                    cursor: args.cursor,
                    next_cursor: args.cursor,
                    has_more: false,
                    rows: [],
                },
            }),
        };

        await expect(
            recoverTsAuthorityProject({
                db,
                projectPath: PROJECT,
                projectRoot: "/repo-root",
                module,
            }),
        ).resolves.toBe("completed");

        expect(getAuthorityManagedMarker(db, PROJECT)).toBeNull();
        expect(getProjectState(db, PROJECT)?.projectMemoryEpoch).toBe(1);
        expect(roots.every((root) => root === "/repo-root")).toBe(true);
        expect(() =>
            insertMemory(db, {
                projectPath: PROJECT,
                category: "CONSTRAINTS",
                content: "writes are unfenced after the drain",
                sourceSessionId: "ses-flip-back",
            }),
        ).not.toThrow();
        db.close();
    });
});
