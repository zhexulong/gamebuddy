import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { getOrCreateSessionMeta } from "./storage-meta";

const V32_COLUMNS = [
    "prior_boundary_ordinal",
    "protected_tail_policy_version",
    "protected_tail_drain_window_started_at",
    "protected_tail_drain_tokens",
    "recovery_no_eligible_head_count",
    "force_emergency_bypass_window_start",
    "force_emergency_bypass_used",
    "last_usage_context_limit",
] as const;

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

describe("migration v32 — protected-tail metadata", () => {
    test("fresh DB schema includes protected-tail columns and defaults", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            const columns = columnNames(db, "session_meta");
            for (const column of V32_COLUMNS) expect(columns).toContain(column);
            const meta = getOrCreateSessionMeta(db, "ses-v32-fresh");
            expect(meta.priorBoundaryOrdinal).toBe(1);
            expect(meta.protectedTailPolicyVersion).toBe(0);
            expect(meta.protectedTailDrainWindowStartedAt).toBe(0);
            expect(meta.protectedTailDrainTokens).toBe(0);
            expect(meta.recoveryNoEligibleHeadCount).toBe(0);
            expect(meta.forceEmergencyBypassWindowStart).toBe(0);
            expect(meta.forceEmergencyBypassUsed).toBe(0);
            expect(meta.lastUsageContextLimit).toBe(0);
            expect(
                db
                    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                    .get(),
            ).toEqual({ version: LATEST_MIGRATION_VERSION });
        } finally {
            closeQuietly(db);
        }
    });

    test("migrated DB adds and heals protected-tail columns idempotently", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
				CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
				INSERT INTO schema_migrations (version, description, applied_at) VALUES (31, 'pre-v32 fixture', 1);
				CREATE TABLE session_meta (
					session_id TEXT PRIMARY KEY,
					harness TEXT NOT NULL DEFAULT 'opencode',
					last_response_time INTEGER DEFAULT 0,
					cache_ttl TEXT DEFAULT '5m',
					counter INTEGER DEFAULT 0,
					last_nudge_tokens INTEGER DEFAULT 0,
					last_nudge_band TEXT DEFAULT '',
					last_transform_error TEXT DEFAULT '',
					is_subagent INTEGER DEFAULT 0,
					last_context_percentage REAL DEFAULT 0,
					last_input_tokens INTEGER DEFAULT 0,
					observed_safe_input_tokens INTEGER DEFAULT 0,
					cache_alert_sent INTEGER DEFAULT 0,
					times_execute_threshold_reached INTEGER DEFAULT 0,
					compartment_in_progress INTEGER DEFAULT 0,
					system_prompt_hash TEXT DEFAULT '',
					cleared_reasoning_through_tag INTEGER DEFAULT 0,
					prior_boundary_ordinal INTEGER
				);
				INSERT INTO session_meta (session_id, prior_boundary_ordinal) VALUES ('ses-bad', NULL);
			`);

            runMigrations(db);
            runMigrations(db);

            const columns = columnNames(db, "session_meta");
            for (const column of V32_COLUMNS) expect(columns).toContain(column);
            const row = db
                .prepare(
                    `SELECT prior_boundary_ordinal, protected_tail_policy_version,
					        protected_tail_drain_window_started_at, protected_tail_drain_tokens,
					        recovery_no_eligible_head_count, force_emergency_bypass_window_start,
					        force_emergency_bypass_used, last_usage_context_limit
					 FROM session_meta WHERE session_id = 'ses-bad'`,
                )
                .get();
            expect(row).toEqual({
                prior_boundary_ordinal: 1,
                protected_tail_policy_version: 0,
                protected_tail_drain_window_started_at: 0,
                protected_tail_drain_tokens: 0,
                recovery_no_eligible_head_count: 0,
                force_emergency_bypass_window_start: 0,
                force_emergency_bypass_used: 0,
                last_usage_context_limit: 0,
            });
        } finally {
            closeQuietly(db);
        }
    });
});
