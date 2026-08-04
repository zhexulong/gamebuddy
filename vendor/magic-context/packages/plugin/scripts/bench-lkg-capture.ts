import { performance } from "node:perf_hooks";
import {
    captureLkgSlot,
    projectLkgEntry,
} from "../src/hooks/magic-context/lkg-replay";
import { resetLkgSlotsForTest } from "../src/hooks/magic-context/lkg-slot";

type BenchMessage = {
    info: { id: string; role: "user"; sessionID: string; model: { providerID: string; modelID: string }; time: { created: number } };
    parts: Array<{ type: "text"; text: string }>;
};

function percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
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

const samples = 25;
for (const [label, bytes, count] of [["2MB", 2 * 1024 * 1024, 100], ["6MB", 6 * 1024 * 1024, 500]] as const) {
    const input = makeCorpus(bytes, count);
    const output = structuredClone(input);
    const projectionTimings: number[] = [];
    const captureTimings: number[] = [];
    let peakRssDelta = 0;
    for (let sample = 0; sample < samples; sample += 1) {
        resetLkgSlotsForTest();
        const before = process.memoryUsage().rss;
        const projectionStarted = performance.now();
        const projected = projectLkgEntry(input);
        projectionTimings.push(performance.now() - projectionStarted);
        const captureStarted = performance.now();
        captureLkgSlot({
            sessionId: "bench",
            input: projected,
            output,
            modelKey: "test/bench",
            providerKey: "test",
            capturedAt: captureStarted,
        });
        captureTimings.push(performance.now() - captureStarted);
        peakRssDelta = Math.max(peakRssDelta, process.memoryUsage().rss - before);
    }
    console.log(JSON.stringify({
        corpus: label,
        messages: count,
        p95EntryProjectionMs: Number(percentile(projectionTimings, 0.95).toFixed(3)),
        p95CaptureMs: Number(percentile(captureTimings, 0.95).toFixed(3)),
        peakRssDeltaMiB: Number((peakRssDelta / 1024 / 1024).toFixed(3)),
    }));
}
