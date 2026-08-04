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
 *   1. transform.ts: `channel2MetricsKnown = fullFeatureMode && …` (trigger)
 *   2. event-handler.ts: `if (meta.isSubagent) return;` (delivery wrapper)
 * Both are removed. The ONLY gate now is ctx_reduce being effective (the
 * enclosing Channel-1 block) so we never nudge toward an uncallable tool.
 * This guard pins that against a silent revert.
 */

function codeWithoutComments(path: string): string {
    return readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
}

describe("channel 2 fires for subagents", () => {
    it("transform trigger does NOT gate channel2MetricsKnown on fullFeatureMode", () => {
        const src = codeWithoutComments(join(import.meta.dir, "transform.ts"));
        const idx = src.indexOf("const channel2MetricsKnown =");
        expect(idx).toBeGreaterThan(-1);
        // The whole assignment up to its terminating semicolon must not mention
        // fullFeatureMode (it used to lead the conjunction).
        const stmt = src.slice(idx, src.indexOf(";", idx));
        expect(stmt).not.toContain("fullFeatureMode");
        // It still requires the metrics to be known.
        expect(stmt).toContain("resolvedContextLimit");
        expect(stmt).toContain("resolvedExecuteThresholdPct");
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
