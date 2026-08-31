export const DATABASE_REPAIR_COMMAND = "bunx @cortexkit/magic-context@latest doctor repair-db";

export function formatDatabaseRepairGuidance(dbPath: string): string {
    // Do not promise salvage unconditionally: .recover needs a sqlite3 shell built
    // with SQLITE_ENABLE_DBPAGE_VTAB, and distro builds without it exist. On such a
    // machine repair-db backs up and stops without modifying the database.
    return `Database: ${dbPath}. Recovery: run \`${DATABASE_REPAIR_COMMAND}\` (salvage needs a sqlite3 shell built with SQLITE_ENABLE_DBPAGE_VTAB; without one, the command backs up and stops without modifying the database).`;
}
