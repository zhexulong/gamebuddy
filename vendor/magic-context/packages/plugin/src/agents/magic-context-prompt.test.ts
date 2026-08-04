import { describe, expect, it } from "bun:test";
import { buildMagicContextSection } from "./magic-context-prompt";

const CAVEMAN_MARKER = "BEWARE";
const CAVEMAN_PHRASE_TAIL = "consciously revert to full sentences";

const KNOWN_AGENT_IDENTITIES = [
    "sisyphus",
    "atlas",
    "hephaestus",
    "sisyphus-junior",
    "oracle",
    "athena",
    "athena-junior",
] as const;

describe("buildMagicContextSection — generic guidance", () => {
    it("emits the same generic guidance for all known agent identities", () => {
        const generic = buildMagicContextSection(null, 20, true, false, false, false);

        for (const agent of KNOWN_AGENT_IDENTITIES) {
            expect(buildMagicContextSection(agent, 20, true, false, false, false)).toBe(generic);
        }
    });

    it("does not emit legacy agent-tailored guidance", () => {
        const out = buildMagicContextSection("atlas", 20, true, false, false, false);

        expect(out).toContain("### Reduction Triggers");
        expect(out).toContain("Your current task requirements and constraints");
        expect(out).not.toContain("CRITICAL — you run long sessions");
        expect(out).not.toContain("delegation tool outputs from completed waves");
        expect(out).not.toContain("council member response outputs");
    });

    it("opens with the long-term-partner frame in BOTH ctx_reduce availability variants", () => {
        const reduce = buildMagicContextSection(null, 20, true, false, false, false);
        const noReduce = buildMagicContextSection(null, 20, false, false, false, false);

        for (const out of [reduce, noReduce]) {
            // Identity frame + the durability + no-scarcity + no-wind-down beats.
            expect(out).toContain("long-term partner on this project");
            expect(out).toContain("weeks, months, or even years");
            expect(out).toContain("effectively unbounded");
            expect(out).toContain("never a reason to wrap up, cut scope, rush, or defer");
            expect(out).toContain("Finishing a task does not end the session");
            expect(out).toContain("no compaction pauses");
            // Frame is at the TOP — before the tool mechanics.
            expect(out.indexOf("long-term partner")).toBeLessThan(out.indexOf("ctx_note"));
        }
    });

    it("uses the mode-specific partner-frame closer", () => {
        const reduce = buildMagicContextSection(null, 20, true, false, false, false);
        const noReduce = buildMagicContextSection(null, 20, false, false, false, false);

        // reduce mode: agent participates in housekeeping
        expect(reduce).toContain("Reduction prompts are routine housekeeping");
        expect(reduce).not.toContain("there's nothing to prune");
        // no-reduce mode: fully automatic, nothing to prune
        expect(noReduce).toContain("there's nothing to prune and no warnings to act on");
        expect(noReduce).not.toContain("Reduction prompts are routine housekeeping");
        // Both keep the task-scope caveat.
        for (const out of [reduce, noReduce]) {
            expect(out).toContain("never let context size change");
        }
    });

    it("no longer emits the scarcity-flavored 'compress early and often, don't wait for warnings' line", () => {
        const reduce = buildMagicContextSection(null, 20, true, false, false, false);
        expect(reduce).not.toContain("don't wait for warnings");
    });
});

describe("buildMagicContextSection — subagent mode", () => {
    const subagent = () => buildMagicContextSection(null, 20, true, false, false, false, true);

    it("emits ONLY the minimal §N§ + ctx_reduce mechanics", () => {
        const out = subagent();
        // Has the marker (injection idempotency) + the tag/ctx_reduce mechanics.
        expect(out).toContain("## Magic Context");
        expect(out).toContain("§N§ identifiers");
        expect(out).toContain("ctx_reduce");
        expect(out).toContain("The last 20 tags are protected");
    });

    it("OMITS the long-term-partner frame and primary-only guidance", () => {
        const out = subagent();
        expect(out).not.toContain("long-term partner");
        expect(out).not.toContain("weeks, months, or even years");
        expect(out).not.toContain("### Reduction Triggers");
        expect(out).not.toContain("ctx_memory");
        expect(out).not.toContain("ctx_search");
        expect(out).not.toContain("ctx_note");
        expect(out).not.toContain("ctx_expand");
    });

    it("threads protectedTags into the protected-count line", () => {
        const out = buildMagicContextSection(null, 7, true, false, false, false, true);
        expect(out).toContain("The last 7 tags are protected");
    });

    it("is much shorter than the full primary block", () => {
        const full = buildMagicContextSection(null, 20, true, false, false, false, false);
        expect(subagent().length).toBeLessThan(full.length / 2);
    });

    it("defaults subagentMode=false (legacy callers unaffected)", () => {
        const sixArg = buildMagicContextSection(null, 20, true, false, false, false);
        const explicitFalse = buildMagicContextSection(null, 20, true, false, false, false, false);
        expect(sixArg).toBe(explicitFalse);
        expect(sixArg).toContain("long-term partner");
    });
});

describe("buildMagicContextSection: memory gating", () => {
    // buildMagicContextSection's 9th positional parameter is memoryEnabled
    // (defaults to true). The 7-arg legacy call below relies on that default.
    it("memory ON (default) keeps the ctx_memory guidance and is byte-identical to legacy callers", () => {
        const legacy = buildMagicContextSection(null, 20, true, false, false, false, false);
        const memOn = buildMagicContextSection(
            null,
            20,
            true,
            false,
            false,
            false,
            false,
            undefined,
            true,
        );
        expect(memOn).toBe(legacy);
        expect(memOn).toContain("Use `ctx_memory`");
        expect(memOn).toContain("**Save to memory proactively**");
    });

    it("memory OFF drops ALL ctx_memory guidance but keeps ctx_search", () => {
        const off = buildMagicContextSection(
            null,
            20,
            true,
            false,
            false,
            false,
            false,
            undefined,
            false,
        );
        expect(off).not.toContain("ctx_memory");
        expect(off).not.toContain("Save to memory proactively");
        expect(off).toContain("Use `ctx_search`");
        // no dangling blank line where the block was removed
        expect(off).not.toContain("\n\nUse `ctx_search`");
    });

    it("memory OFF gates the guidance in no-reduce mode too", () => {
        const off = buildMagicContextSection(
            null,
            20,
            false,
            false,
            false,
            false,
            false,
            undefined,
            false,
        );
        expect(off).not.toContain("ctx_memory");
        expect(off).toContain("Use `ctx_search`");
    });
});

describe("buildMagicContextSection — caveman compression warning", () => {
    it("emits the warning when caveman is enabled and ctx_reduce is unavailable", () => {
        const out = buildMagicContextSection(
            null, // agent
            20, // protectedTags (ignored in no-reduce path)
            false, // ctx_reduce is unavailable in this session.
            false, // dreamerEnabled
            false, // temporalAwarenessEnabled
            true, // cavemanTextCompressionEnabled
        );
        expect(out).toContain(CAVEMAN_MARKER);
        expect(out).toContain(CAVEMAN_PHRASE_TAIL);
        expect(out).toContain("DO NOT mimic this style");
    });

    it("omits the warning when caveman is disabled", () => {
        const out = buildMagicContextSection(
            null,
            20,
            false, // ctx_reduce is unavailable in this session.
            false, // dreamerEnabled
            false, // temporalAwarenessEnabled
            false, // cavemanTextCompressionEnabled = false
        );
        expect(out).not.toContain(CAVEMAN_MARKER);
        expect(out).not.toContain(CAVEMAN_PHRASE_TAIL);
    });

    it("emits the warning when ctx_reduce is callable and caveman is enabled", () => {
        // Caveman compression is independent from ctx_reduce availability, so
        // reduce-enabled primary guidance must still warn about rewritten prose.
        const out = buildMagicContextSection(
            null,
            20,
            true, // ctx_reduce is callable in this session.
            false, // dreamerEnabled
            false, // temporalAwarenessEnabled
            true, // cavemanTextCompressionEnabled
        );
        expect(out).toContain(CAVEMAN_MARKER);
        expect(out).toContain(CAVEMAN_PHRASE_TAIL);
    });

    it("omits the warning by default (parameter optional)", () => {
        // Old callers that didn't pass the new parameter must continue to
        // produce identical output (no warning leaked into legacy paths).
        const out = buildMagicContextSection(null, 20, false, false, false);
        expect(out).not.toContain(CAVEMAN_MARKER);
    });
});
