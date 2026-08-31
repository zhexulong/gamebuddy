import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard: Channel 2 (the synthetic-user ceiling nudge) fires for
 * subagents, not just primaries.
 *
 * Subagents don't reliably self-`ctx_reduce` even with the tool available and
 * Channel-1 reminders injected (observed live: a mason ignored escalating
 * gentle→firm→urgent Channel-1 nudges at 86.9% pressure). Channel 2 — the
 * synthetic-user interrupt the run loop must address — is the firmer lever, and
 * a subagent runs under the same in-process client so promptAsync reaches it.
 * The two gates that previously excluded subagents were:
 *   1. transform.ts: a `fullFeatureMode` trigger gate
 *   2. event-handler.ts: `if (meta.isSubagent) return;` (delivery wrapper)
 * Both are removed. Channel 2 remains armed for subagents when ctx_reduce is
 * callable, while delivery additionally requires the subagent's run to still be
 * active so a terminal report cannot be followed by a synthetic turn. This
 * guard pins the subagent-enabled trigger and delivery wiring against a silent
 * revert.
 */

function codeWithoutComments(path: string): string {
    return readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
}

describe("channel 2 fires for subagents", () => {
    it("transform trigger does NOT gate the persisted U/T baseline on fullFeatureMode", () => {
        const src = codeWithoutComments(join(import.meta.dir, "transform.ts"));
        const idx = src.indexOf("const channelBaseline =");
        expect(idx).toBeGreaterThan(-1);
        const triggerBlock = src.slice(idx, src.indexOf("const elapsed", idx));
        expect(triggerBlock).not.toContain("fullFeatureMode");
        expect(triggerBlock).toContain("evaluateChannel2");
        expect(triggerBlock).toContain("channelBaseline.evaluable");
    });

    it("delivery wrapper does NOT early-return for subagents", () => {
        const src = codeWithoutComments(join(import.meta.dir, "event-handler.ts"));
        const fnIdx = src.indexOf("async function deliverChannel2IfPending");
        expect(fnIdx).toBeGreaterThan(-1);
        const fnBody = src.slice(fnIdx, src.indexOf("\n}\n", fnIdx));
        // The old guard was `if (meta.isSubagent) return;` — it must be gone.
        expect(fnBody).not.toContain("isSubagent");
    });
});
