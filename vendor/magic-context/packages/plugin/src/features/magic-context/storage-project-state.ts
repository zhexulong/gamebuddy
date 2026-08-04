import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";

export const GLOBAL_USER_PROFILE_PROJECT_PATH = "__global__";

export interface ProjectStateRow {
    projectPath: string;
    projectMemoryEpoch: number;
    projectUserProfileVersion: number;
    updatedAt: number;
}

interface ProjectStateDbRow {
    project_path: string;
    project_memory_epoch: number;
    project_user_profile_version: number;
    updated_at: number;
}

function toProjectState(row: ProjectStateDbRow): ProjectStateRow {
    return {
        projectPath: row.project_path,
        projectMemoryEpoch: row.project_memory_epoch,
        projectUserProfileVersion: row.project_user_profile_version,
        updatedAt: row.updated_at,
    };
}

function getNow(now?: number): number {
    return now ?? Date.now();
}

const getProjectStateStatements = new WeakMap<Database, PreparedStatement>();

export function getProjectState(db: Database, projectPath: string): ProjectStateRow | null {
    let statement = getProjectStateStatements.get(db);
    if (!statement) {
        statement = db.prepare(
            `SELECT project_path, project_memory_epoch, project_user_profile_version, updated_at
             FROM project_state
             WHERE project_path = ?`,
        );
        getProjectStateStatements.set(db, statement);
    }
    const row = statement.get(projectPath) as ProjectStateDbRow | undefined;
    return row ? toProjectState(row) : null;
}

export function ensureProjectState(
    db: Database,
    projectPath: string,
    now = Date.now(),
): ProjectStateRow {
    db.prepare(
        `INSERT OR IGNORE INTO project_state
            (project_path, project_memory_epoch, project_user_profile_version, updated_at)
         VALUES (?, 0, 0, ?)`,
    ).run(projectPath, now);
    const state = getProjectState(db, projectPath);
    if (!state) {
        throw new Error(`Failed to create project_state row for ${projectPath}`);
    }
    return state;
}

export function bumpProjectMemoryEpoch(
    db: Database,
    projectPath: string,
    now = Date.now(),
): ProjectStateRow {
    db.prepare(
        `INSERT INTO project_state
            (project_path, project_memory_epoch, project_user_profile_version, updated_at)
         VALUES (?, 1, 0, ?)
         ON CONFLICT(project_path) DO UPDATE SET
            project_memory_epoch = project_memory_epoch + 1,
            updated_at = excluded.updated_at`,
    ).run(projectPath, now);
    const state = getProjectState(db, projectPath);
    if (!state) {
        throw new Error(`Failed to bump project memory epoch for ${projectPath}`);
    }
    return state;
}

export function bumpProjectUserProfileVersion(
    db: Database,
    projectPath = GLOBAL_USER_PROFILE_PROJECT_PATH,
    now = Date.now(),
): ProjectStateRow {
    db.prepare(
        `INSERT INTO project_state
            (project_path, project_memory_epoch, project_user_profile_version, updated_at)
         VALUES (?, 0, 1, ?)
         ON CONFLICT(project_path) DO UPDATE SET
            project_user_profile_version = project_user_profile_version + 1,
            updated_at = excluded.updated_at`,
    ).run(projectPath, now);
    const state = getProjectState(db, projectPath);
    if (!state) {
        throw new Error(`Failed to bump project user profile version for ${projectPath}`);
    }
    return state;
}

export function setProjectState(
    db: Database,
    projectPath: string,
    updates: {
        projectMemoryEpoch?: number;
        projectUserProfileVersion?: number;
        updatedAt?: number;
    },
): ProjectStateRow {
    const now = getNow(updates.updatedAt);
    ensureProjectState(db, projectPath, now);
    db.prepare(
        `UPDATE project_state SET
            project_memory_epoch = COALESCE(?, project_memory_epoch),
            project_user_profile_version = COALESCE(?, project_user_profile_version),
            updated_at = ?
         WHERE project_path = ?`,
    ).run(
        updates.projectMemoryEpoch ?? null,
        updates.projectUserProfileVersion ?? null,
        now,
        projectPath,
    );
    const state = getProjectState(db, projectPath);
    if (!state) {
        throw new Error(`Failed to set project_state row for ${projectPath}`);
    }
    return state;
}

export function deleteProjectState(db: Database, projectPath: string): boolean {
    const result = db
        .prepare("DELETE FROM project_state WHERE project_path = ?")
        .run(projectPath) as {
        changes?: number;
    };
    return (result.changes ?? 0) > 0;
}
