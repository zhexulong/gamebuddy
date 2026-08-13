import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	excludeMemorySource,
	isMemorySourceExcluded,
	validateMemorySourceRef,
} from "./memory-source-exclusion";
import { createTestDb } from "./test-utils.test";

const sourceRef = "pi-message:session-opaque:message-opaque";

describe("memory source exclusions", () => {
	it("validates only declared opaque source reference formats", () => {
		for (const ref of [
			sourceRef,
			"pi-range:session-opaque:start-opaque:end-opaque",
			"host-receipt:receipt-opaque",
		]) {
			expect(() => validateMemorySourceRef(ref)).not.toThrow();
		}
		for (const ref of [
			"",
			"pi-message::message",
			"pi-message:session:",
			"pi-message:session:message:extra",
			"pi-range:session:start",
			"host-receipt:",
			"unknown:opaque",
			"host-receipt:contains space",
			"host-receipt:contains\nnewline",
			"host-receipt:contains\u0000null",
		]) {
			expect(() => validateMemorySourceRef(ref)).toThrow("Invalid memory source reference");
		}
	});

	it("isolates exclusions by project and stores only the opaque reference", () => {
		const db = createTestDb();
		try {
			expect(isMemorySourceExcluded(db, { projectPath: "/project/a", sourceRef })).toBe(false);
			excludeMemorySource(db, { projectPath: "/project/a", sourceRef });
			excludeMemorySource(db, { projectPath: "/project/a", sourceRef });

			expect(isMemorySourceExcluded(db, { projectPath: "/project/a", sourceRef })).toBe(true);
			expect(isMemorySourceExcluded(db, { projectPath: "/project/b", sourceRef })).toBe(false);
			const rows = db
				.prepare("SELECT project_path, source_ref, created_at FROM memory_source_exclusions")
				.all() as Array<{ project_path: string; source_ref: string; created_at: number }>;
			expect(rows).toHaveLength(1);
			expect(rows[0].project_path).toBe("/project/a");
			expect(rows[0].source_ref).toBe(sourceRef);
			expect(rows[0].created_at).toBeGreaterThan(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("persists exclusions across database reopen", () => {
		const path = `${process.env.TMPDIR ?? "/tmp"}/mc-memory-source-exclusion-${crypto.randomUUID()}.db`;
		const first = createTestDb(path);
		try {
			excludeMemorySource(first, {
				projectPath: "/project/persisted",
				sourceRef: "host-receipt:receipt-opaque",
			});
		} finally {
			closeQuietly(first);
		}

		const reopened = createTestDb(path);
		try {
			expect(
				isMemorySourceExcluded(reopened, {
					projectPath: "/project/persisted",
					sourceRef: "host-receipt:receipt-opaque",
				}),
			).toBe(true);
		} finally {
			closeQuietly(reopened);
			try {
				rmSync(path, { force: true });
			} catch {
				// Bun's Windows SQLite adapter may keep a just-closed file briefly locked.
			}
		}
	});
});
