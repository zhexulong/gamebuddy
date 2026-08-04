import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard for dream-task token telemetry (Dreamer v2).
//
// The dashboard enriches each dream-run task row by grouping
// `subagent_invocations` WHERE subagent='dreamer' GROUP BY task, then matching
// `task` to the dream_runs row name. In v2 the dream_runs row name is the
// CANONICAL task name (`config.task`), and the three specialized runners record
// their LLM token usage from their own modules — so each must (a) call
// recordChildInvocation, and (b) use subagent:"dreamer" with the EXACT canonical
// task string, otherwise the dashboard shows "—" tokens for a real LLM call.

const HERE = import.meta.dir;

function read(relFromFeatures: string): string {
    return readFileSync(join(HERE, "..", relFromFeatures), "utf-8");
}

describe("dream-task token telemetry mapping", () => {
    it('user-memory review records a dreamer invocation tagged task:"review-user-memories"', () => {
        const src = read("user-memory/review-user-memories.ts");
        expect(src.includes("recordChildInvocation")).toBe(true);
        expect(src.includes('subagent: "dreamer"')).toBe(true);
        expect(src.includes('task: "review-user-memories"')).toBe(true);
    });

    it('smart-notes records a dreamer invocation tagged task:"evaluate-smart-notes"', () => {
        const src = read("dreamer/evaluate-smart-notes.ts");
        expect(src.includes("recordChildInvocation")).toBe(true);
        expect(src.includes('subagent: "dreamer"')).toBe(true);
        expect(src.includes('task: "evaluate-smart-notes"')).toBe(true);
    });

    it("the agentic executor records invocations under the canonical task name", () => {
        const exec = read("dreamer/task-executor.ts");
        // The agentic path records with `task` = the canonical config.task name
        // (verify/curate/maintain-docs).
        expect(exec.includes("recordChildInvocation")).toBe(true);
        expect(exec.includes('subagent: "dreamer"')).toBe(true);
        expect(exec.includes("task,")).toBe(true);
    });
});
