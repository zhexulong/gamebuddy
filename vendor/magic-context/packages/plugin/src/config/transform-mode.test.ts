import { describe, expect, it } from "bun:test";

import { resolveTransformMode } from "./transform-mode";

describe("resolveTransformMode", () => {
    it("falls back to ts and warns when rust lacks user-level subc", () => {
        expect(
            resolveTransformMode({
                configured: "rust",
                userTierHasSubc: false,
            }),
        ).toEqual({
            mode: "ts",
            warnings: ["rust mode requires user-level subc configuration; running ts."],
        });
    });

    it("keeps rust when trusted user-level subc is present", () => {
        expect(
            resolveTransformMode({
                configured: "rust",
                userTierHasSubc: true,
            }),
        ).toEqual({ mode: "rust", warnings: [] });
    });

    it("keeps ts without warnings when ts is configured", () => {
        expect(
            resolveTransformMode({
                configured: "ts",
                userTierHasSubc: false,
            }),
        ).toEqual({ mode: "ts", warnings: [] });
    });

    it("accepts caveman compression in rust mode without a warning", () => {
        const result = resolveTransformMode({
            configured: "rust",
            userTierHasSubc: true,
            shadowTransformEnabled: false,
        });

        expect(result.mode).toBe("rust");
        expect(result.warnings).toEqual([]);
    });
});
