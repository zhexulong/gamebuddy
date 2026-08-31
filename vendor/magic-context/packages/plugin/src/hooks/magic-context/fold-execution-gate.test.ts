import { describe, expect, it } from "bun:test";
import { foldExecutesThisPass } from "./fold-execution-gate";

describe("foldExecutesThisPass twin predicate", () => {
    it.each([
        "OpenCode",
        "Pi",
    ])("%s keeps advisory folds closed and opens only after materialization", () => {
        expect(foldExecutesThisPass(true, false)).toBe(false);
        expect(foldExecutesThisPass(true, true)).toBe(true);
        expect(foldExecutesThisPass(false, true)).toBe(false);
    });
});
