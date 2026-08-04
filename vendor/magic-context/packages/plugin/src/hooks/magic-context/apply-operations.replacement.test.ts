/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { buildReplacementContent } from "./apply-operations";

describe("buildReplacementContent — one canonical placeholder", () => {
    // The whole point: buildReplacementContent is a PURE function of tagId and
    // returns exactly `[dropped §N§]` for EVERY message (non-tool) drop, on every
    // path, every pass. Any version that varied the bytes by role/content/window
    // (e.g. a `[truncated §N§]` user-text preview) re-derived a DIFFERENT
    // placeholder across passes, which on a defer pass changed a tail message's
    // bytes and busted the whole prompt-cache prefix after it. These tests lock
    // the byte-identity that makes that class impossible.

    it("is a pure function of tagId — no target/content needed", () => {
        expect(buildReplacementContent(42)).toBe("[dropped \u00a742\u00a7]");
        expect(buildReplacementContent(100413)).toBe("[dropped \u00a7100413\u00a7]");
        expect(buildReplacementContent(7)).toBe("[dropped \u00a77\u00a7]");
    });

    it("is byte-identical to heuristic-cleanup's message placeholder", () => {
        // heuristic-cleanup.ts writes `[dropped §${tag.tagNumber}§]` — the two drop
        // paths MUST agree byte-for-byte or a tag that gets dropped on one path and
        // replayed on the other flips bytes and busts cache.
        const n = 591;
        expect(buildReplacementContent(n)).toBe(`[dropped \u00a7${n}\u00a7]`);
    });

    it("is deterministic across repeated calls (defer-replay stability)", () => {
        const a = buildReplacementContent(592);
        const b = buildReplacementContent(592);
        const c = buildReplacementContent(592);
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    it("matches DROPPED_PLACEHOLDER_PATTERN so a fully-dropped non-user message can be sentinelized", () => {
        // Old user-text drops used `[truncated §N§]` specifically to NOT match this
        // pattern; that belt-and-suspenders is gone (user-role messages are already
        // skipped by stripDroppedPlaceholderMessages' role guard) and was the sole
        // source of the byte instability.
        expect(/^\[dropped §\d+§\]$/.test(buildReplacementContent(11))).toBe(true);
    });
});
