import { test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { closeDatabase, openDatabase, resolveDatabasePath } from "../../src/features/magic-context/storage-db";
import { Database } from "../../src/shared/sqlite";
import { closeQuietly } from "../../src/shared/sqlite-helpers";

const probeDir = process.env.MC_PARALLEL_DB_PROBE_DIR;
if (!probeDir) throw new Error("MC_PARALLEL_DB_PROBE_DIR is required for the parallel DB probe");

const sharedDataHome = process.env.MC_PARALLEL_DB_PROBE_SHARED_DATA_HOME;
if (sharedDataHome) {
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = sharedDataHome;
    process.env.XDG_DATA_HOME = sharedDataHome;
}

function record(name: string): void {
    const { dbPath } = resolveDatabasePath();
    writeFileSync(
        join(probeDir, name),
        JSON.stringify({
            pid: process.pid,
            dataHome: process.env.MAGIC_CONTEXT_TEST_DATA_DIR,
            dbPath,
        }),
    );
}

test("worker A holds its default database write lock", async () => {
    const { dbPath } = resolveDatabasePath();
    mkdirSync(dirname(dbPath), { recursive: true });

    const initialized = openDatabase();
    if (!initialized) throw new Error("worker A could not initialize its default database");
    closeDatabase();

    const lock = new Database(dbPath);
    try {
        lock.exec("PRAGMA busy_timeout=0");
        lock.exec("BEGIN IMMEDIATE");
        record("worker-a.json");
        await Bun.sleep(6_000);
        lock.exec("COMMIT");
    } finally {
        closeQuietly(lock);
    }
});
