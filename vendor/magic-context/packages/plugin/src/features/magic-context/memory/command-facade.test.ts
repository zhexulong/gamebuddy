/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { MemoryCommandFacade } from "./command-facade";

let db: Database;

function makeDatabase(): Database {
    const database = new Database(":memory:");
    database.exec(`
        CREATE TABLE memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL, category TEXT NOT NULL, content TEXT NOT NULL,
            normalized_hash TEXT NOT NULL, source_session_id TEXT, source_type TEXT DEFAULT 'historian',
            seen_count INTEGER DEFAULT 1, retrieval_count INTEGER DEFAULT 0,
            first_seen_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL, last_retrieved_at INTEGER, status TEXT DEFAULT 'active',
            expires_at INTEGER, verification_status TEXT DEFAULT 'unverified', verified_at INTEGER,
            superseded_by_memory_id INTEGER, merged_from TEXT, metadata_json TEXT,
            UNIQUE(project_path, category, normalized_hash)
        );
        CREATE TABLE memory_embeddings (memory_id INTEGER NOT NULL, embedding BLOB NOT NULL, model_id TEXT NOT NULL);
        CREATE TABLE memory_mutation_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT, project_path TEXT NOT NULL, mutation_type TEXT NOT NULL,
            target_memory_id INTEGER NOT NULL, superseded_by_id INTEGER, category TEXT, new_content TEXT,
            queued_at INTEGER NOT NULL
        );
    `);
    return database;
}

afterEach(() => closeQuietly(db));

const player = { principal: "player_direct" as const, delegated: false };
const companion = { principal: "companion_agent" as const, delegated: false };

describe("MemoryCommandFacade", () => {
    it("marks player-direct creates and updates with player governance", () => {
        db = makeDatabase();
        const facade = new MemoryCommandFacade(db);
        const created = facade.create({
            actor: player,
            projectPath: "/repo",
            category: "USER_DIRECTIVES",
            content: "Use focused tests",
            metadataJson: JSON.stringify({ source: "ui" }),
        });
        expect(JSON.parse(created.memory.metadataJson ?? "{}")).toEqual({
            source: "ui",
            governance: { authority: "player" },
        });

        const updated = facade.update({
            projectPath: created.memory.projectPath,
            id: created.memory.id,
            stateToken: created.stateToken,
            actor: player,
            content: "Use focused integration tests",
        });
        expect(JSON.parse(updated.memory.metadataJson ?? "{}").governance.authority).toBe("player");
        expect(db.prepare("SELECT mutation_type FROM memory_mutation_log").all()).toEqual([
            { mutation_type: "update" },
            { mutation_type: "update" },
        ]);
    });

    it("rejects stale tokens and companion mutation of player or permanent records without delegation", () => {
        db = makeDatabase();
        const facade = new MemoryCommandFacade(db);
        const created = facade.create({
            actor: player,
            projectPath: "/repo",
            category: "USER_DIRECTIVES",
            content: "Player owned",
        });
        expect(() =>
            facade.archive({
                projectPath: created.memory.projectPath,
                id: created.memory.id,
                stateToken: created.stateToken,
                actor: companion,
            }),
        ).toThrow("requires delegation");

        const updated = facade.update({
            projectPath: created.memory.projectPath,
            id: created.memory.id,
            stateToken: created.stateToken,
            actor: player,
            content: "Player owned revised",
        });
        expect(() =>
            facade.archive({
                projectPath: created.memory.projectPath,
                id: created.memory.id,
                stateToken: created.stateToken,
                actor: player,
            }),
        ).toThrow("stale state");
        expect(() =>
            facade.pin({
                projectPath: updated.memory.projectPath,
                id: updated.memory.id,
                stateToken: updated.stateToken,
                actor: companion,
            }),
        ).toThrow("requires delegation");
        expect(
            facade.pin({
                projectPath: updated.memory.projectPath,
                id: updated.memory.id,
                stateToken: updated.stateToken,
                actor: { ...companion, delegated: true },
            }).memory.status,
        ).toBe("permanent");
    });

    it("archives, restores, unpins, and deletes through storage and mutation queue", () => {
        db = makeDatabase();
        const facade = new MemoryCommandFacade(db);
        const created = facade.create({
            actor: companion,
            projectPath: "/repo",
            category: "KNOWN_ISSUES",
            content: "Transient record",
        });
        const archived = facade.archive({
            projectPath: created.memory.projectPath,
            id: created.memory.id,
            stateToken: created.stateToken,
            actor: companion,
        });
        expect(archived.memory.status).toBe("archived");
        const restored = facade.restore({
            projectPath: archived.memory.projectPath,
            id: archived.memory.id,
            stateToken: archived.stateToken,
            actor: companion,
        });
        const pinned = facade.pin({
            projectPath: restored.memory.projectPath,
            id: restored.memory.id,
            stateToken: restored.stateToken,
            actor: companion,
        });
        expect(() =>
            facade.unpin({
                projectPath: pinned.memory.projectPath,
                id: pinned.memory.id,
                stateToken: pinned.stateToken,
                actor: companion,
            }),
        ).toThrow("requires delegation");
        const unpinned = facade.unpin({
            projectPath: pinned.memory.projectPath,
            id: pinned.memory.id,
            stateToken: pinned.stateToken,
            actor: { ...companion, delegated: true },
        });
        facade.deleteEntry({
            projectPath: unpinned.memory.projectPath,
            id: unpinned.memory.id,
            stateToken: unpinned.stateToken,
            actor: companion,
        });
        expect(db.prepare("SELECT * FROM memories WHERE id = ?").get(created.memory.id)).toBeNull();
        expect(
            db.prepare("SELECT mutation_type, category FROM memory_mutation_log ORDER BY id").all(),
        ).toEqual([
            { mutation_type: "update", category: "KNOWN_ISSUES" },
            { mutation_type: "archive", category: null },
            { mutation_type: "update", category: "__mc_visibility__" },
            { mutation_type: "update", category: "__mc_visibility__" },
            { mutation_type: "update", category: "__mc_visibility__" },
            { mutation_type: "delete", category: null },
        ]);
    });

    it("queues an active create even when storage deduplicates it, so a stale m[1] can refresh", () => {
        db = makeDatabase();
        const facade = new MemoryCommandFacade(db);
        const first = facade.create({ actor: companion, projectPath: "/repo", category: "SEMANTIC_MEMORY", content: "We share a tea ritual." });
        const second = facade.create({ actor: companion, projectPath: "/repo", category: "SEMANTIC_MEMORY", content: "We share a tea ritual." });
        expect(second.memory.id).toBe(first.memory.id);
        expect(second.stateToken).toBe(first.stateToken);
        expect(db.prepare("SELECT seen_count FROM memories WHERE id = ?").get(first.memory.id)).toEqual({ seen_count: 1 });
        expect(db.prepare("SELECT mutation_type, target_memory_id, category FROM memory_mutation_log ORDER BY id").all()).toEqual([
            { mutation_type: "update", target_memory_id: first.memory.id, category: "SEMANTIC_MEMORY" },
            { mutation_type: "update", target_memory_id: first.memory.id, category: "SEMANTIC_MEMORY" },
        ]);
    });

    it("deduplicates the Node node:sqlite extended unique error exactly as Bun's unique code", () => {
        db = makeDatabase();
        const facade = new MemoryCommandFacade(db);
        const first = facade.create({ actor: companion, projectPath: "/repo", category: "SEMANTIC_MEMORY", content: "Node SQLite duplicate." });
        // node:sqlite reports ERR_SQLITE_ERROR / errcode 2067 instead of Bun's
        // SQLITE_CONSTRAINT_UNIQUE. The production facade must retain the
        // original immutable revision rather than leaking the raw constraint.
        const second = facade.create({ actor: companion, projectPath: "/repo", category: "SEMANTIC_MEMORY", content: "Node SQLite duplicate." });
        expect(second.memory.id).toBe(first.memory.id);
        expect(second.stateToken).toBe(first.stateToken);
    });

    it("merges a player-selected source into a same-project target", () => {
        db = makeDatabase();
        const facade = new MemoryCommandFacade(db);
        const target = facade.create({ actor: player, projectPath: "/repo", category: "USER_DIRECTIVES", content: "Preferred plan" });
        const source = facade.create({ actor: player, projectPath: "/repo", category: "USER_DIRECTIVES", content: "Old plan" });
        const merged = facade.merge({
            projectPath: "/repo", id: source.memory.id, stateToken: source.stateToken,
            targetStateToken: target.stateToken, actor: player,
        });
        expect(merged.memory.id).toBe(target.memory.id);
        expect(db.prepare("SELECT status, superseded_by_memory_id FROM memories WHERE id = ?").get(source.memory.id)).toEqual({
            status: "archived", superseded_by_memory_id: target.memory.id,
        });
        expect(db.prepare("SELECT mutation_type, target_memory_id, superseded_by_id FROM memory_mutation_log ORDER BY id DESC LIMIT 1").get()).toEqual({
            mutation_type: "superseded", target_memory_id: source.memory.id, superseded_by_id: target.memory.id,
        });
    });

    it("requires project identity and rejects cross-project memory ids", () => {
        db = makeDatabase();
        const facade = new MemoryCommandFacade(db);
        expect(() =>
            facade.create({
                actor: companion,
                projectPath: "",
                category: "KNOWN_ISSUES",
                content: "Missing identity",
            }),
        ).toThrow("requires a project path");

        const created = facade.create({
            actor: companion,
            projectPath: "/repo-a",
            category: "KNOWN_ISSUES",
            content: "Project A only",
        });
        expect(() =>
            facade.update({
                projectPath: "/repo-b",
                id: created.memory.id,
                stateToken: created.stateToken,
                actor: companion,
                content: "Cross-project mutation",
            }),
        ).toThrow("does not belong to this project");
        expect(
            db.prepare("SELECT content FROM memories WHERE id = ?").get(created.memory.id),
        ).toEqual({
            content: "Project A only",
        });
    });
});
