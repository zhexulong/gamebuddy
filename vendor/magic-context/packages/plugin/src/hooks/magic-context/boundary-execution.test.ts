/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    applyMidTurnDeferral,
    type BypassInput,
    detectMidTurnBypassReason,
} from "./boundary-execution";

describe("applyMidTurnDeferral", () => {
    it("implements the boundary-execution decision table", () => {
        expect(
            applyMidTurnDeferral({
                base: "execute",
                bypassReason: "force-materialize",
                midTurn: true,
            }),
        ).toEqual({ midTurnAdjustedSchedulerDecision: "execute", sideEffect: "none" });

        expect(
            applyMidTurnDeferral({ base: "execute", bypassReason: "none", midTurn: true }),
        ).toEqual({ midTurnAdjustedSchedulerDecision: "defer", sideEffect: "set-flag" });

        expect(
            applyMidTurnDeferral({ base: "execute", bypassReason: "none", midTurn: false }),
        ).toEqual({ midTurnAdjustedSchedulerDecision: "execute", sideEffect: "none" });

        expect(
            applyMidTurnDeferral({ base: "defer", bypassReason: "none", midTurn: true }),
        ).toEqual({ midTurnAdjustedSchedulerDecision: "defer", sideEffect: "none" });
    });

    it("keeps defer base decisions deferred even when a bypass reason is present", () => {
        expect(
            applyMidTurnDeferral({
                base: "defer",
                bypassReason: "force-materialize",
                midTurn: true,
            }),
        ).toEqual({ midTurnAdjustedSchedulerDecision: "defer", sideEffect: "none" });
    });
});

describe("detectMidTurnBypassReason", () => {
    function makeInput(overrides: Partial<BypassInput> = {}): BypassInput {
        return {
            contextUsage: { percentage: 0 },
            sessionMeta: { isSubagent: false },
            historyRefreshSessions: new Set<string>(),
            sessionId: "session-1",
            effectiveExecuteThresholdPercentage: 65,
            ...overrides,
        };
    }

    it("fires force-materialize at the band derived above the execute threshold", () => {
        expect(
            detectMidTurnBypassReason(
                makeInput({
                    contextUsage: { percentage: 91 },
                    effectiveExecuteThresholdPercentage: 90,
                }),
            ),
        ).toBe("none");
        expect(
            detectMidTurnBypassReason(
                makeInput({
                    contextUsage: { percentage: 92 },
                    effectiveExecuteThresholdPercentage: 90,
                }),
            ),
        ).toBe("force-materialize");
    });

    it("fires explicit-bust when history refresh is pending", () => {
        expect(
            detectMidTurnBypassReason(
                makeInput({ historyRefreshSessions: new Set<string>(["session-1"]) }),
            ),
        ).toBe("explicit-bust");
    });

    it("fires subagent for subagent sessions", () => {
        expect(detectMidTurnBypassReason(makeInput({ sessionMeta: { isSubagent: true } }))).toBe(
            "subagent",
        );
    });

    it("fires none when no bypass applies", () => {
        expect(detectMidTurnBypassReason(makeInput())).toBe("none");
    });
});
