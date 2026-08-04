import type { Database } from "../../shared/sqlite";

export interface IdentityRekeyMapRow {
    oldProjectPath: string;
    newProjectPath: string;
    rekeyedAt: number;
}

interface IdentityRekeyMapDbRow {
    old_project_path: string;
    new_project_path: string;
    rekeyed_at: number;
}

function toIdentityRekeyMap(row: IdentityRekeyMapDbRow): IdentityRekeyMapRow {
    return {
        oldProjectPath: row.old_project_path,
        newProjectPath: row.new_project_path,
        rekeyedAt: row.rekeyed_at,
    };
}

export function upsertIdentityRekeyMap(
    db: Database,
    oldProjectPath: string,
    newProjectPath: string,
    rekeyedAt = Date.now(),
): IdentityRekeyMapRow {
    db.prepare(
        `INSERT INTO v22_identity_rekey_map (old_project_path, new_project_path, rekeyed_at)
         VALUES (?, ?, ?)
         ON CONFLICT(old_project_path) DO UPDATE SET
            new_project_path = excluded.new_project_path,
            rekeyed_at = excluded.rekeyed_at`,
    ).run(oldProjectPath, newProjectPath, rekeyedAt);
    const row = getIdentityRekeyMap(db, oldProjectPath);
    if (!row) {
        throw new Error(`Failed to upsert v22 identity rekey map for ${oldProjectPath}`);
    }
    return row;
}

export function getIdentityRekeyMap(
    db: Database,
    oldProjectPath: string,
): IdentityRekeyMapRow | null {
    const row = db
        .prepare(
            `SELECT old_project_path, new_project_path, rekeyed_at
             FROM v22_identity_rekey_map
             WHERE old_project_path = ?`,
        )
        .get(oldProjectPath) as IdentityRekeyMapDbRow | undefined;
    return row ? toIdentityRekeyMap(row) : null;
}

export function listIdentityRekeyMaps(db: Database): IdentityRekeyMapRow[] {
    const rows = db
        .prepare(
            `SELECT old_project_path, new_project_path, rekeyed_at
             FROM v22_identity_rekey_map
             ORDER BY old_project_path ASC`,
        )
        .all() as IdentityRekeyMapDbRow[];
    return rows.map(toIdentityRekeyMap);
}

export function deleteIdentityRekeyMap(db: Database, oldProjectPath: string): boolean {
    const result = db
        .prepare("DELETE FROM v22_identity_rekey_map WHERE old_project_path = ?")
        .run(oldProjectPath) as { changes?: number };
    return (result.changes ?? 0) > 0;
}
