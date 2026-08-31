import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type WorkerRecord = {
    pid: number;
    dataHome?: string;
    dbPath: string;
};

const pluginDir = join(import.meta.dir, "..");
const fixtureFiles = [
    "./test-fixtures/parallel-db-isolation/worker-a.ts",
    "./test-fixtures/parallel-db-isolation/worker-b.ts",
];

function runProbe(probeDir: string, sharedDataHome?: string) {
    mkdirSync(probeDir, { recursive: true });
    const startedAt = Date.now();
    const result = spawnSync(
        process.execPath,
        ["test", "--parallel=2", "--parallel-delay=0", "--timeout=30000", ...fixtureFiles],
        {
            cwd: pluginDir,
            encoding: "utf8",
            env: {
                ...process.env,
                MC_PARALLEL_DB_PROBE_DIR: probeDir,
                ...(sharedDataHome ? { MC_PARALLEL_DB_PROBE_SHARED_DATA_HOME: sharedDataHome } : {}),
            },
        },
    );
    return { ...result, durationMs: Date.now() - startedAt };
}

function outputOf(result: ReturnType<typeof runProbe>): string {
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function readRecord(probeDir: string, name: string): WorkerRecord {
    return JSON.parse(readFileSync(join(probeDir, name), "utf8")) as WorkerRecord;
}

function main(): void {
    const root = mkdtempSync(join(tmpdir(), "mc-parallel-db-probe-"));
    try {
        const sharedDir = join(root, "shared-data-home");
        const shared = runProbe(join(root, "shared"), sharedDir);
        const sharedOutput = outputOf(shared);
        if (shared.status === 0) {
            throw new Error("shared-data-home probe unexpectedly passed; it did not exercise SQLite contention");
        }
        if (!/SQLITE_BUSY|database is locked/i.test(sharedOutput)) {
            throw new Error(`shared-data-home probe failed without a SQLite lock error:\n${sharedOutput}`);
        }
        if (shared.durationMs < 4_500) {
            throw new Error(
                `shared-data-home lock surfaced too quickly (${shared.durationMs}ms); busy_timeout was not observed`,
            );
        }

        const isolated = runProbe(join(root, "isolated"));
        const isolatedOutput = outputOf(isolated);
        if (isolated.status !== 0) {
            throw new Error(`worker-isolated probe failed:\n${isolatedOutput}`);
        }

        const workerA = readRecord(join(root, "isolated"), "worker-a.json");
        const workerB = readRecord(join(root, "isolated"), "worker-b.json");
        if (workerA.pid === workerB.pid) {
            throw new Error("--parallel=2 did not use two worker processes");
        }
        if (!workerA.dataHome || !workerB.dataHome || workerA.dataHome === workerB.dataHome) {
            throw new Error("parallel workers shared MAGIC_CONTEXT_TEST_DATA_DIR");
        }
        if (workerA.dbPath === workerB.dbPath) {
            throw new Error("parallel workers resolved the same default database path");
        }

        console.log(
            `shared data-home: SQLITE_BUSY after ${shared.durationMs}ms (busy_timeout observed); ` +
                `isolated workers: pid ${workerA.pid} -> ${workerA.dataHome}, pid ${workerB.pid} -> ${workerB.dataHome}`,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

main();
