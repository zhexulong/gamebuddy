import { performance } from "node:perf_hooks";

import {
    captureLkgSlot,
    projectLkgEntry,
} from "../src/hooks/magic-context/lkg-replay";
import {
    captureSlot,
    lkgContentDigest,
    lkgContentDigestFromFields,
    resetLkgSlotsForTest,
} from "../src/hooks/magic-context/lkg-slot";
import { __rustModeTransformTest } from "../src/hooks/magic-context/rust-mode-transform";

type BenchMessage = {
    info: {
        id: string;
        role: "user";
        sessionID: string;
        model: { providerID: string; modelID: string };
        time: { created: number };
    };
    parts: Array<{ type: "text"; text: string }>;
};

type PhaseSamples = Record<string, number[]>;

function percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

function p95(samples: PhaseSamples): Record<string, number> {
    return Object.fromEntries(
        Object.entries(samples).map(([name, values]) => [
            `${name}P95Ms`,
            Number(percentile(values, 0.95).toFixed(3)),
        ]),
    );
}

function makeCorpus(bytes: number, count: number): BenchMessage[] {
    const body = "x".repeat(Math.max(1, Math.floor(bytes / count)));
    return Array.from({ length: count }, (_, index) => ({
        info: {
            id: `m-${index}`,
            role: "user" as const,
            sessionID: "bench",
            model: { providerID: "test", modelID: "bench" },
            time: { created: index + 1 },
        },
        parts: [{ type: "text" as const, text: `${body}${index}` }],
    }));
}

function measureLegacyCapture(bytes: number, count: number): void {
    const input = makeCorpus(bytes, count);
    const output = structuredClone(input);
    const samples = 25;
    const timings: PhaseSamples = { entryProjection: [], capture: [] };
    let peakRssDelta = 0;
    for (let sample = 0; sample < samples; sample += 1) {
        resetLkgSlotsForTest();
        const before = process.memoryUsage().rss;
        let startedAt = performance.now();
        const projected = projectLkgEntry(input);
        timings.entryProjection.push(performance.now() - startedAt);
        startedAt = performance.now();
        captureLkgSlot({
            sessionId: "bench",
            input: projected,
            output,
            modelKey: "test/bench",
            providerKey: "test",
            capturedAt: startedAt,
        });
        timings.capture.push(performance.now() - startedAt);
        peakRssDelta = Math.max(peakRssDelta, process.memoryUsage().rss - before);
    }
    console.log(
        JSON.stringify({
            benchmark: "legacy_lkg_capture",
            inputBytes: bytes,
            messages: count,
            ...p95(timings),
            peakRssDeltaMiB: Number((peakRssDelta / 1024 / 1024).toFixed(3)),
        }),
    );
}

function measureRustCapture(): void {
    const input = makeCorpus(36 * 1024 * 1024, 2_653);
    const served = makeCorpus(2 * 1024 * 1024, 310);
    const samples = 10;
    const timings: PhaseSamples = {
        ids: [],
        contentDigests: [],
        responseSerialize: [],
        slotWrite: [],
        total: [],
    };
    for (let sample = 0; sample < samples; sample += 1) {
        resetLkgSlotsForTest();
        const totalStartedAt = performance.now();
        let startedAt = performance.now();
        const ids = input.map((message) => message.info.id);
        timings.ids.push(performance.now() - startedAt);
        startedAt = performance.now();
        const inputContentDigests = input.map((message) => lkgContentDigest(message));
        timings.contentDigests.push(performance.now() - startedAt);
        startedAt = performance.now();
        const jsonPrefix = JSON.stringify(served);
        timings.responseSerialize.push(performance.now() - startedAt);
        startedAt = performance.now();
        captureSlot("bench", {
            jsonPrefix,
            inputIdSeq: ids,
            inputContentDigests: inputContentDigests as string[],
            lastInputMessageId: ids.at(-1)!,
            modelKey: "test/bench",
            providerKey: "test",
            capturedAt: Date.now(),
        });
        timings.slotWrite.push(performance.now() - startedAt);
        timings.total.push(performance.now() - totalStartedAt);
    }
    console.log(
        JSON.stringify({
            benchmark: "rust_live_shape_capture",
            inputBytes: 36 * 1024 * 1024,
            inputMessages: input.length,
            responseBytes: Buffer.byteLength(JSON.stringify(served)),
            responseMessages: served.length,
            ...p95(timings),
            digestOperationsPerCapture: input.length,
        }),
    );

    const snapshots = __rustModeTransformTest.contentSnapshotsFor(input);
    const asyncTimings: PhaseSamples = { synchronousPrepare: [], asyncDigestCommit: [] };
    for (let sample = 0; sample < samples; sample += 1) {
        let startedAt = performance.now();
        input.map((message) => message.info.id);
        JSON.stringify(served);
        asyncTimings.synchronousPrepare.push(performance.now() - startedAt);
        startedAt = performance.now();
        snapshots.map((snapshot) => lkgContentDigestFromFields(snapshot.fields));
        asyncTimings.asyncDigestCommit.push(performance.now() - startedAt);
    }
    console.log(
        JSON.stringify({
            benchmark: "rust_async_lkg_capture",
            inputBytes: 36 * 1024 * 1024,
            inputMessages: input.length,
            responseMessages: served.length,
            ...p95(asyncTimings),
            synchronousDigestOperationsPerCapture: 0,
            asynchronousDigestOperationsPerCapture: input.length,
            immutableSnapshotSource: "existing wire-cache content snapshots",
        }),
    );
}

measureLegacyCapture(2 * 1024 * 1024, 100);
measureLegacyCapture(6 * 1024 * 1024, 500);
measureRustCapture();
