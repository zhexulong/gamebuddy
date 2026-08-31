#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

type CommandResult = { exit_status: number; output: string };

const e2eRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(e2eRoot, "../..");
const source = resolve(e2eRoot, "tests/rust-ctx-reduce-roundtrip.test.ts");
const command =
    "MC_E2E_MODE=rust bun test --timeout 600000 --max-concurrency=1 tests/rust-ctx-reduce-roundtrip.test.ts";
const beforeTarget = "input: { drop: String(dropTag) },";
const afterTarget = "input: { drop: String(dropTag + 1_000_000) },";
const decoder = new TextDecoder();

function runDrill(): CommandResult {
    const result = Bun.spawnSync({
        cmd: [
            "bun",
            "test",
            "--timeout",
            "600000",
            "--max-concurrency=1",
            "tests/rust-ctx-reduce-roundtrip.test.ts",
        ],
        cwd: e2eRoot,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, MC_E2E_MODE: "rust" },
    });
    return {
        exit_status: result.exitCode,
        output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
    };
}

const before = readFileSync(source, "utf8");
const occurrences = before.split(beforeTarget).length - 1;
if (occurrences !== 1) {
    throw new Error(`CTX_REDUCE_UNKNOWN_TARGET: expected one mutation target, found ${occurrences}`);
}
const after = before.replace(beforeTarget, afterTarget);
writeFileSync(source, after);
let observedFailure: CommandResult;
try {
    observedFailure = runDrill();
} finally {
    writeFileSync(source, before);
}
const revertedRerun = runDrill();

if (observedFailure.exit_status === 0) {
    throw new Error("CTX_REDUCE_UNKNOWN_TARGET: mutation did not redden the queued-ledger assertion");
}
if (!observedFailure.output.includes("toBeGreaterThan")) {
    throw new Error("CTX_REDUCE_UNKNOWN_TARGET: failure did not reach the queued-ledger assertion");
}
if (revertedRerun.exit_status !== 0) {
    throw new Error("CTX_REDUCE_UNKNOWN_TARGET: reverted ctx_reduce drill did not pass");
}

const record = {
    drill: "RUST-CTX-REDUCE-ROUNDTRIP",
    command,
    mutations: [
        {
            name: "CTX_REDUCE_UNKNOWN_TARGET",
            applied_diff: {
                path: relative(repoRoot, source),
                before: beforeTarget,
                after: afterTarget,
                changed: before !== after,
            },
            observed_failure: observedFailure,
            reverted_rerun: {
                ...revertedRerun,
                status: "pass",
            },
            adequacy_finding: null,
        },
    ],
};
writeFileSync(
    resolve(e2eRoot, "mutations/rust-ctx-reduce-roundtrip.json"),
    `${JSON.stringify(record, null, 2)}\n`,
);
console.log("wrote mutations/rust-ctx-reduce-roundtrip.json");
