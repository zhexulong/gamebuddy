import { describe, expect, it } from "bun:test";
import { isCompactionEnabled } from "./agent-disable";
import { MagicContextConfigSchema } from "./schema/magic-context";

// Back-compat acceptance for the compaction-off config gate (issue #266 S1).
// The knob defaults at BOTH levels so `{}`, `{ compaction: {} }`, and a config
// with no block all yield compaction.enabled === true — default-on behavior is
// byte-identical to today (no behavior is gated yet in this slice; these are
// schema-level assertions).

describe("compaction config back-compat (issue #266 S1)", () => {
    it("parses {} with compaction.enabled === true (default-on at top level)", () => {
        const parsed = MagicContextConfigSchema.parse({});
        expect(parsed.compaction).toBeDefined();
        expect(parsed.compaction.enabled).toBe(true);
        expect(isCompactionEnabled(parsed)).toBe(true);
    });

    it("parses { compaction: {} } with compaction.enabled === true (default-on at block level)", () => {
        const parsed = MagicContextConfigSchema.parse({ compaction: {} });
        expect(parsed.compaction.enabled).toBe(true);
        expect(isCompactionEnabled(parsed)).toBe(true);
    });

    it("parses a config with no compaction block (absent block → default-on)", () => {
        const parsed = MagicContextConfigSchema.parse({ memory: { enabled: false } });
        expect(parsed.compaction).toBeDefined();
        expect(parsed.compaction.enabled).toBe(true);
        expect(isCompactionEnabled(parsed)).toBe(true);
    });

    it("resolves explicit user-tier compaction.enabled === false", () => {
        const parsed = MagicContextConfigSchema.parse({ compaction: { enabled: false } });
        expect(parsed.compaction.enabled).toBe(false);
        expect(isCompactionEnabled(parsed)).toBe(false);
    });

    it("resolves explicit compaction.enabled === true", () => {
        const parsed = MagicContextConfigSchema.parse({ compaction: { enabled: true } });
        expect(parsed.compaction.enabled).toBe(true);
        expect(isCompactionEnabled(parsed)).toBe(true);
    });

    it("absent block is byte-identical to default block for compaction (no behavior gated yet)", () => {
        // Both resolve to the same { enabled: true } shape, so a config with no
        // compaction block and one with `{ compaction: {} }` produce the same
        // parsed compaction value.
        const absent = MagicContextConfigSchema.parse({ memory: { enabled: true } });
        const empty = MagicContextConfigSchema.parse({ compaction: {} });
        expect(absent.compaction).toEqual(empty.compaction);
    });
});
