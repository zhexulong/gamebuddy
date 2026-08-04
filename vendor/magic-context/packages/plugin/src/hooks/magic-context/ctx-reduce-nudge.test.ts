import { describe, expect, it } from "bun:test";
import {
    buildChannel1Reminder,
    buildChannel2Reminder,
    CHANNEL1_SENTINEL,
    CHANNEL2_MIN_RECLAIMABLE,
    CHANNEL2_USABLE_FRACTION,
    channel1RefireTokens,
    computePressure,
    computeTailTokenEstimate,
    computeTailToolTokens,
    decideChannel1,
    shouldTriggerChannel2,
} from "./ctx-reduce-nudge";
import type { MessageLike } from "./tag-messages";

function toolMsg(output: string): MessageLike {
    return {
        info: { id: "m", role: "assistant" },
        parts: [{ type: "tool", state: { output } }],
    } as unknown as MessageLike;
}

const BUDGET = 100_000;

describe("computeTailToolTokens", () => {
    it("sums non-dropped tool output, excludes sentinels", () => {
        const big = "x".repeat(40_000); // ~10k tokens
        const msgs = [toolMsg(big), toolMsg("[dropped §5§]"), toolMsg("[truncated]")];
        const tokens = computeTailToolTokens(msgs);
        expect(tokens).toBeGreaterThan(9_000);
        expect(tokens).toBeLessThan(11_000);
    });
    it("ignores non-tool parts", () => {
        const msg = {
            info: { id: "m", role: "user" },
            parts: [{ type: "text", text: "x".repeat(40_000) }],
        } as unknown as MessageLike;
        expect(computeTailToolTokens([msg])).toBe(0);
    });
});

describe("computeTailTokenEstimate", () => {
    it("estimates reclaimable tool output separately from the full live tail", () => {
        const msg = {
            info: { id: "m", role: "assistant" },
            parts: [
                { type: "text", text: "conversation ".repeat(1000) },
                {
                    type: "tool",
                    state: { input: { cmd: "echo hi" }, output: "tool output ".repeat(1000) },
                },
            ],
        } as unknown as MessageLike;

        const estimate = computeTailTokenEstimate([msg]);

        expect(estimate.tailToolTokens).toBeGreaterThan(0);
        expect(estimate.liveTailTokens).toBeGreaterThan(estimate.tailToolTokens);
    });
});

describe("decideChannel1 — trajectories", () => {
    // severity = undroppedTokens / estimatedInputTokens (the reclaimable share of
    // the live input). pressure is a separate clamped GATE (>= 0.8). Default
    // estimatedInput=200k so undropped maps directly to a share: 40k→0.20,
    // 80k→0.40, 130k→0.65.
    const base = {
        workingWindowTokens: BUDGET,
        estimatedInputTokens: 200_000,
        lastNudgeUndropped: 0,
        lastNudgeLevel: "" as const,
        hasRecentReduce: false,
    };

    it("pressure gate: below the floor → silent even with an urgent reclaimable share", () => {
        // share = 150k/200k = 0.75 (would be urgent), but pressure 0.6 < 0.8 gate.
        const d = decideChannel1({ ...base, undroppedTokens: 150_000, pressure: 0.6 });
        expect(d.fire).toBe(false);
    });
    it("below the absolute token floor → silent", () => {
        const d = decideChannel1({
            ...base,
            undroppedTokens: 9_000,
            estimatedInputTokens: 12_000,
            pressure: 1.0,
        });
        expect(d.fire).toBe(false); // below CHANNEL1_FLOOR_TOKENS
    });
    it("low reclaimable share at high pressure → silent", () => {
        // share = 20k/200k = 0.10 < gentle; pressure passes the gate but share is low.
        const d = decideChannel1({ ...base, undroppedTokens: 20_000, pressure: 1.0 });
        expect(d.fire).toBe(false);
    });
    it("gentle band: ~25% reclaimable share, gate passed", () => {
        const d = decideChannel1({ ...base, undroppedTokens: 50_000, pressure: 0.9 });
        // share = 0.25 → gentle [0.2,0.4)
        expect(d.fire).toBe(true);
        expect(d.level).toBe("gentle");
    });
    it("firm band: ~45% reclaimable share", () => {
        const d = decideChannel1({ ...base, undroppedTokens: 90_000, pressure: 0.9 });
        // share = 0.45 → firm [0.4,0.65)
        expect(d.fire).toBe(true);
        expect(d.level).toBe("firm");
    });
    it("urgent band: ~70% reclaimable share", () => {
        const d = decideChannel1({ ...base, undroppedTokens: 140_000, pressure: 0.9 });
        // share = 0.70 ≥ 0.65 → urgent
        expect(d.fire).toBe(true);
        expect(d.level).toBe("urgent");
    });
    // The core defect fix: over-threshold pressure (>1) must NOT inflate the band.
    // Previously severity = share × pressure² so this would have read urgent.
    it("pressure clamp: over-threshold pressure does not inflate the band", () => {
        const d = decideChannel1({ ...base, undroppedTokens: 60_000, pressure: 1.5 });
        // share = 0.30 → gentle; pressure clamps to 1.0 (gate passes), stays gentle.
        expect(d.fire).toBe(true);
        expect(d.level).toBe("gentle");
    });
    it("post-ctx_reduce suppression: never fire on a reduce turn", () => {
        const d = decideChannel1({
            ...base,
            undroppedTokens: 140_000,
            pressure: 0.9,
            hasRecentReduce: true,
        });
        expect(d.fire).toBe(false);
    });
    it("budget-scaled cadence uses a 5% interval with a 10k floor", () => {
        expect(channel1RefireTokens(100_000)).toBe(10_000);
        expect(channel1RefireTokens(1_000_000)).toBe(50_000);
    });
    it("cadence: the initial fire waits for the budget-scaled interval", () => {
        const d = decideChannel1({
            ...base,
            workingWindowTokens: 1_000_000,
            undroppedTokens: 40_000,
            estimatedInputTokens: 100_000, // share 0.4 (firm), band would fire
            pressure: 0.9,
        });
        // 5% of a 1M working window is 50k, so a 40k pile is below cadence → quiet.
        expect(d.fire).toBe(false);
    });
    it("band suppression: does not repeat the same level on cadence alone", () => {
        const d = decideChannel1({
            ...base,
            undroppedTokens: 60_000, // share 0.30, still gentle
            pressure: 0.9,
            lastNudgeUndropped: 40_000,
            lastNudgeLevel: "gentle",
        });
        // grew 20k but same-band repetition is noise.
        expect(d.fire).toBe(false);
    });
    it("band suppression: fires immediately when severity escalates", () => {
        const d = decideChannel1({
            ...base,
            undroppedTokens: 90_000, // share 0.45 → firm
            pressure: 0.9,
            lastNudgeUndropped: 85_000,
            lastNudgeLevel: "gentle",
        });
        // an escalation (gentle→firm) even though cadence grew only 5k.
        expect(d.fire).toBe(true);
        expect(d.level).toBe("firm");
        expect(d.nextLastNudgeLevel).toBe("firm");
    });
    it("post-ctx_reduce reset clears the persisted level", () => {
        const d = decideChannel1({
            ...base,
            undroppedTokens: 140_000,
            pressure: 0.9,
            lastNudgeUndropped: 120_000,
            lastNudgeLevel: "urgent",
            hasRecentReduce: true,
        });
        expect(d.fire).toBe(false);
        expect(d.nextLastNudge).toBe(0);
        expect(d.nextLastNudgeLevel).toBe("");
    });
    it("cadence re-arms after a reduce drops undropped below last mark", () => {
        const d = decideChannel1({
            ...base,
            undroppedTokens: 50_000, // share 0.25 → gentle
            pressure: 0.9,
            lastNudgeUndropped: 120_000,
            lastNudgeLevel: "urgent",
        });
        // undropped fell below last mark → reset to 0/none → 50k ≥ 0+10k cadence.
        expect(d.fire).toBe(true);
        expect(d.nextLastNudge).toBe(50_000);
        expect(d.nextLastNudgeLevel).toBe("gentle");
    });

    // Regression for the reported symptom: a tool-dominant tail near/over the
    // execute threshold no longer auto-escalates to URGENT. Old metric:
    // severity = share × pressure²; with share 0.40 and pressure 1.2 it read
    // 0.40 × 1.44 = 0.576 (near-urgent) and any higher pressure pushed it over.
    // New metric: pressure clamps to a gate, severity = the plain 0.40 share → firm.
    it("regression: tool-heavy tail over the threshold reads firm, not urgent", () => {
        const d = decideChannel1({
            ...base,
            undroppedTokens: 80_000, // share = 0.40
            pressure: 1.2, // over threshold; clamps to 1.0 (gate passes)
            lastNudgeUndropped: 0,
            lastNudgeLevel: "",
        });
        expect(d.fire).toBe(true);
        expect(d.level).toBe("firm");
    });

    // A small reclaimable pile near the threshold stays quiet (the numerator
    // reclaimable share is small regardless of how close to compaction we are).
    it("small reclaimable share stays quiet even at full pressure", () => {
        const d = decideChannel1({
            ...base,
            undroppedTokens: 25_000, // share = 0.125 < gentle
            pressure: 1.0,
            lastNudgeUndropped: 0,
            lastNudgeLevel: "",
        });
        expect(d.fire).toBe(false);
    });
});

describe("computePressure", () => {
    it("derives pressure from prospective input + turn tokens", () => {
        const p = computePressure({
            lastInputTokens: 120_000,
            turnToolTokens: 10_000,
            contextLimit: 200_000,
            executeThresholdPercentage: 65,
        });
        // usage% = 130000/200000*100 = 65; pressure = 65/65 = 1.0
        expect(p).toBeCloseTo(1.0, 2);
    });
    it("returns 0 on unknown limit (cold start)", () => {
        expect(
            computePressure({
                lastInputTokens: 0,
                turnToolTokens: 0,
                contextLimit: 0,
                executeThresholdPercentage: 65,
            }),
        ).toBe(0);
    });
});

describe("buildChannel1Reminder", () => {
    it("wraps in the versioned sentinel and reports the amount", () => {
        const r = buildChannel1Reminder("firm", 42_000);
        expect(r).toContain(CHANNEL1_SENTINEL);
        expect(r).toContain("</system-reminder>");
        expect(r).toContain("~42k");
    });

    it("renders oldest reclaimable hints from stored tool names", () => {
        const r = buildChannel1Reminder("firm", 42_000, [
            { tagNumber: 123, toolName: "read" },
            { tagNumber: 145, toolName: "grep" },
            { tagNumber: 150, toolName: null },
        ]);
        expect(r).toContain("oldest reclaimable: §123§ read · §145§ grep · §150§ tool.");
    });
});

describe("buildChannel2Reminder", () => {
    it("includes optional oldest reclaimable hints", () => {
        const r = buildChannel2Reminder(30_000, [{ tagNumber: 7, toolName: "bash" }]);
        expect(r).toContain("oldest reclaimable: §7§ bash.");
    });
});

describe("shouldTriggerChannel2 — ceiling (reclaimable ≥ usable/3)", () => {
    it("fires when reclaimable is at least a third of the usable working range", () => {
        // usable=90k → third=30k; reclaimable=30k ⇒ fire
        expect(shouldTriggerChannel2({ reclaimableTokens: 30_000, usableTokens: 90_000 })).toBe(
            true,
        );
    });
    it("the AFT regression: 54k reclaimable on a wide 1M session does NOT fire", () => {
        // Big-context session: usable is large (lots of working room), so 54k is
        // well under a third — the old absolute-40k gate wrongly fired here.
        expect(shouldTriggerChannel2({ reclaimableTokens: 54_000, usableTokens: 300_000 })).toBe(
            false,
        );
    });
    it("the SAME 54k on a tight 120k usable session DOES fire (size-relative)", () => {
        // usable=120k → third=40k; 54k ≥ 40k ⇒ fire. One rule, both contexts.
        expect(shouldTriggerChannel2({ reclaimableTokens: 54_000, usableTokens: 120_000 })).toBe(
            true,
        );
    });
    it("stays quiet below the absolute reclaimable floor regardless of ratio", () => {
        // usable tiny (near threshold) → ratio satisfied, but pile is trivial.
        expect(
            shouldTriggerChannel2({
                reclaimableTokens: CHANNEL2_MIN_RECLAIMABLE - 1,
                usableTokens: 1_000,
            }),
        ).toBe(false);
    });
    it("escalates when at/over threshold (usable ≤ 0) with a real pile", () => {
        expect(shouldTriggerChannel2({ reclaimableTokens: 50_000, usableTokens: 0 })).toBe(true);
    });
    it("uses the 1/3 fraction constant", () => {
        expect(CHANNEL2_USABLE_FRACTION).toBeCloseTo(1 / 3, 5);
    });
});

describe("buildChannel2Reminder", () => {
    it("is a plain system-reminder and reports the amount", () => {
        const r = buildChannel2Reminder(55_000);
        expect(r).toContain("<system-reminder>");
        expect(r).toContain("</system-reminder>");
        expect(r).toContain("~55k");
        expect(r).toContain("ctx_reduce");
    });
});
