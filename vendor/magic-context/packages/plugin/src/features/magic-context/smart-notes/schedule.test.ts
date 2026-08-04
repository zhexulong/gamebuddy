import { describe, expect, test } from "bun:test";

import { nextSmartNoteCheckDueAt } from "./schedule";

function collectDeltas(
    cron: string,
    options: { now: number; floorMs: number; ceilingMs: number; hashPrefix: string },
): number[] {
    return Array.from(
        { length: 128 },
        (_, index) =>
            nextSmartNoteCheckDueAt(cron, {
                now: options.now,
                noteId: index + 1,
                hash: `${options.hashPrefix}-${index}`,
                floorMs: options.floorMs,
                ceilingMs: options.ceilingMs,
            }) - options.now,
    );
}

describe("nextSmartNoteCheckDueAt", () => {
    test("keeps a floor-1ms schedule at or above the floor after jitter", () => {
        const floorMs = 60_000;
        const ceilingMs = 10 * floorMs;
        const deltas = collectDeltas("* * * * *", {
            now: Date.UTC(2026, 0, 1, 0, 0, 59, 999),
            floorMs,
            ceilingMs,
            hashPrefix: "floor",
        });

        expect(Math.min(...deltas)).toBeGreaterThanOrEqual(floorMs);
        expect(Math.max(...deltas)).toBeLessThanOrEqual(ceilingMs);
    });

    test("keeps a ceiling-clamped schedule at or below the ceiling after jitter", () => {
        const floorMs = 1_000;
        const ceilingMs = 60_000;
        const deltas = collectDeltas("0 * * * *", {
            now: Date.UTC(2026, 0, 1, 0, 0, 0, 0),
            floorMs,
            ceilingMs,
            hashPrefix: "ceiling",
        });

        expect(Math.min(...deltas)).toBeGreaterThanOrEqual(floorMs);
        expect(Math.max(...deltas)).toBeLessThanOrEqual(ceilingMs);
    });
});
