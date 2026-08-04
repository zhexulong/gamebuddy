import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import type { GitCommit } from "./git-log-reader";
import { searchGitCommitsSync } from "./search-git-commits";
import { saveCommitEmbedding } from "./storage-git-commit-embeddings";
import { upsertCommits } from "./storage-git-commits";

function makeCommit(index: number): GitCommit {
    const sha = index.toString(16).padStart(40, "0");
    return {
        sha,
        shortSha: sha.slice(0, 7),
        message: `semantic commit ${index}`,
        author: "dev@example.com",
        committedAtMs: 1_700_000_000_000 + index,
    };
}

describe("searchGitCommitsSync", () => {
    let db: Database;

    beforeEach(() => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
    });

    afterEach(() => {
        closeQuietly(db);
    });

    it("loads a large semantic-only commit set through one JSON batch", () => {
        const projectPath = "git:semantic-batch";
        const modelId = "mock:model";
        const commits = Array.from({ length: 1_200 }, (_, index) => makeCommit(index));
        upsertCommits(db, projectPath, commits);
        for (const commit of commits) {
            saveCommitEmbedding(db, commit.sha, new Float32Array([1, 0]), modelId);
        }

        const results = searchGitCommitsSync(db, projectPath, "lexical-miss-token", {
            limit: 5,
            queryEmbedding: new Float32Array([1, 0]),
            queryModelId: modelId,
        });

        expect(results).toHaveLength(5);
        expect(results.every((result) => result.matchType === "semantic")).toBe(true);
        expect(results.map((result) => result.commit.sha)).toEqual(
            commits
                .slice(-5)
                .reverse()
                .map((commit) => commit.sha),
        );
    });
});
