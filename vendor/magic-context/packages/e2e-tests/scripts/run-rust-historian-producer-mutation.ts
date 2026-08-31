#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

type CommandResult = { exit_status: number; output: string };

const e2eRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(e2eRoot, "../..");
const source = resolve(e2eRoot, "src/rust-runner/fake-broca.ts");
const tierPattern = /<p[1-4]>[\s\S]*?<\/p[1-4]>/g;
const decoder = new TextDecoder();

function runTest(expectBad: boolean): CommandResult {
    const env: Record<string, string> = { ...process.env, MC_E2E_MODE: "rust" };
    if (expectBad) env.MC_RUST_E2E_BROCA_EXPECT_BAD = "1";
    else delete env.MC_RUST_E2E_BROCA_EXPECT_BAD;
    const result = Bun.spawnSync({
        cmd: [
            "bun",
            "test",
            "--timeout",
            "600000",
            "--max-concurrency=1",
            "tests/rust-historian-producer.test.ts",
        ],
        cwd: e2eRoot,
        stdout: "pipe",
        stderr: "pipe",
        env,
    });
    return {
        exit_status: result.exitCode,
        output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
    };
}

const before = readFileSync(source, "utf8");
const matches = before.match(tierPattern) ?? [];
if (matches.length !== 4) {
    throw new Error(`RUST_HISTORIAN_BAD_TIER: expected four tier blocks, found ${matches.length}`);
}
const oldText = matches.join("\n");
const replacement = "<tier-tags-removed>";
const after = before.replace(tierPattern, "");
writeFileSync(source, after);
let observedFailure: CommandResult;
let validationProbe: CommandResult;
try {
    observedFailure = runTest(false);
    validationProbe = runTest(true);
} finally {
    writeFileSync(source, before);
}
const revertedRerun = runTest(false);
if (observedFailure.exit_status === 0) {
    throw new Error("RUST_HISTORIAN_BAD_TIER: mutation did not redden the validation assertion");
}
if (validationProbe.exit_status !== 0) {
    throw new Error("RUST_HISTORIAN_BAD_TIER: invalid-output probe did not observe the validation failure");
}
if (revertedRerun.exit_status !== 0) {
    throw new Error("RUST_HISTORIAN_BAD_TIER: reverted producer test did not pass");
}

const record = {
    drill: "RUST-HISTORIAN-PRODUCER",
    command: "MC_E2E_MODE=rust bun test --timeout 600000 --max-concurrency=1 tests/rust-historian-producer.test.ts",
    mutations: [
        {
            name: "RUST_HISTORIAN_BAD_TIER",
            applied_diff: {
                path: relative(repoRoot, source),
                before: oldText,
                after: replacement,
                changed: before !== after,
            },
            observed_failure: observedFailure,
            validation_probe: validationProbe,
            reverted_rerun: {
                ...revertedRerun,
                status: "pass",
            },
            adequacy_finding: null,
        },
    ],
};
writeFileSync(
    resolve(e2eRoot, "mutations/rust-historian-producer.json"),
    `${JSON.stringify(record, null, 2)}\n`,
);
console.log("wrote mutations/rust-historian-producer.json");
