import { describe, expect, it } from "bun:test";
import { canConsumeDeferredOnThisPass } from "./cache-busting-signals";

/**
 * `canConsumeDeferredOnThisPass` is the mid-turn-aware gate that decides whether
 * a deferred publication signal (deferred history refresh / materialization) may
 * be consumed on THIS transform pass. It takes the MID-TURN-ADJUSTED scheduler
 * decision, so a deferred publish that lands mid-turn (decision downgraded to
 * "defer") is NOT consumed until the next non-mid-turn execute/force pass. Pi
 * now mirrors this exact logic (it previously read the raw deferred-set
 * membership, draining mid-turn where OpenCode stayed deferred).
 */
describe("canConsumeDeferredOnThisPass", () => {
    it("defers when mid-turn (decision=defer) and below force threshold", () => {
        expect(
            canConsumeDeferredOnThisPass({
                schedulerDecision: "defer",
                contextPercentage: 50,
                justAwaitedPublication: false,
                activeRunBlocksMaterialization: false,
            }),
        ).toBe(false);
    });

    it("consumes on an execute pass", () => {
        expect(
            canConsumeDeferredOnThisPass({
                schedulerDecision: "execute",
                contextPercentage: 70,
                justAwaitedPublication: false,
                activeRunBlocksMaterialization: false,
            }),
        ).toBe(true);
    });

    it("consumes mid-turn only at the resolved force-materialization band", () => {
        const input = {
            schedulerDecision: "defer" as const,
            justAwaitedPublication: false,
            activeRunBlocksMaterialization: false,
            forceMaterializationPercentage: 92,
        };
        expect(canConsumeDeferredOnThisPass({ ...input, contextPercentage: 91 })).toBe(false);
        expect(canConsumeDeferredOnThisPass({ ...input, contextPercentage: 92 })).toBe(true);
    });

    it("always consumes right after awaiting a publication (inline await path)", () => {
        expect(
            canConsumeDeferredOnThisPass({
                schedulerDecision: "defer",
                contextPercentage: 10,
                justAwaitedPublication: true,
                activeRunBlocksMaterialization: false,
            }),
        ).toBe(true);
    });

    it("blocks when an active run blocks materialization (below force threshold)", () => {
        expect(
            canConsumeDeferredOnThisPass({
                schedulerDecision: "execute",
                contextPercentage: 70,
                justAwaitedPublication: false,
                activeRunBlocksMaterialization: true,
            }),
        ).toBe(false);
    });
});
