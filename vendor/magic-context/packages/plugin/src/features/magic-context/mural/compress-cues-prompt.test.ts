import { describe, expect, test } from "bun:test";

import {
    buildCompressCuesPrompt,
    CUE_BUDGET_HIGH,
    CUE_BUDGET_LOW,
    cueBudgetFor,
    parseCuesManifest,
} from "./compress-cues-prompt";
import { validateCue } from "./cue-validation";

describe("compress-cues prompt", () => {
    test("budget is 90 for importance >= 70, else 50", () => {
        expect(cueBudgetFor(70)).toBe(CUE_BUDGET_HIGH);
        expect(cueBudgetFor(69)).toBe(CUE_BUDGET_LOW);
        expect(cueBudgetFor(100)).toBe(90);
        expect(cueBudgetFor(10)).toBe(50);
    });

    test("prompt lists every memory id with its budget", () => {
        const prompt = buildCompressCuesPrompt({
            projectPath: "git:test",
            memories: [
                { id: 11, category: "ARCHITECTURE", importance: 80, content: "high one" },
                { id: 22, category: "NAMING", importance: 40, content: "low one" },
            ],
        });
        expect(prompt).toContain("[11]");
        expect(prompt).toContain("budget 90");
        expect(prompt).toContain("[22]");
        expect(prompt).toContain("budget 50");
    });
});

describe("parseCuesManifest (fail-closed root)", () => {
    test("parses a complete manifest and unescapes XML", () => {
        const parsed = parseCuesManifest(
            `<cues><cue id="7">a &lt;b&gt; &amp; c</cue><cue id="8">plain</cue></cues>`,
        );
        expect(parsed).toEqual([
            { id: 7, cue: "a <b> & c" },
            { id: 8, cue: "plain" },
        ]);
    });

    test("rejects a truncated manifest with no closing root (no partial apply)", () => {
        expect(() => parseCuesManifest(`<cues><cue id="7">only</cue><cue id="8">trunc`)).toThrow(
            /closing root/,
        );
    });

    test("rejects text with no cues root at all", () => {
        expect(() => parseCuesManifest("here are your cues: none")).toThrow(/complete root/);
    });

    test("ignores prose around a complete root", () => {
        const parsed = parseCuesManifest(
            `sure, here you go:\n<cues><cue id="1">x→y</cue></cues>\ndone`,
        );
        expect(parsed).toEqual([{ id: 1, cue: "x→y" }]);
    });
});

describe("validateCue (per-cue, applied on write)", () => {
    test("accepts a within-budget plain cue", () => {
        expect(validateCue("queue name → worker", 50)).toBeNull();
    });

    test("rejects an over-budget cue for its importance band", () => {
        expect(validateCue("x".repeat(51), 50)?.reason).toContain("over-budget");
        // The same length is fine at high importance (budget 90).
        expect(validateCue("x".repeat(51), 80)).toBeNull();
    });

    test("rejects an empty cue", () => {
        expect(validateCue("   ", 50)?.reason).toBe("empty");
    });

    test("rejects a leaked source id", () => {
        expect(validateCue("see #7863 for detail", 80)?.reason).toBe("leaked-id");
    });

    test("rejects unbalanced parentheses", () => {
        expect(validateCue("thing (mechanism", 80)?.reason).toBe("unbalanced-parens");
    });

    test("requires a ⊘ marker when a prohibition trigger word is present", () => {
        expect(validateCue("must not write cache", 80)?.reason).toBe("prohibition-missing-marker");
    });

    test("requires a parenthesized mechanism after a ⊘ marker", () => {
        expect(validateCue("⊘cache write", 80)?.reason).toBe("polarity-missing-mechanism");
        expect(validateCue("⊘cache write (ABI break)", 80)).toBeNull();
    });
});
