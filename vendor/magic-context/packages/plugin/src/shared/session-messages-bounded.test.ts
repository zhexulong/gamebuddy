/// <reference types="bun-types" />

// Regression guard: every `client.session.messages(...)` call in plugin code
// must include `limit` in its `query`. Without `limit`, OpenCode's legacy
// messages endpoint hydrates the ENTIRE session into RAM — catastrophic on
// huge sessions (10k+ messages) which is exactly when Magic Context shines.
//
// Background: the plugin only ever needs the latest assistant message of a
// helper subagent (historian / dreamer / sidekick / key-files / user-memory)
// or a bounded tail of the active session (conflict-warning cleanup). Both
// fit comfortably in `limit: 50` with massive headroom.
//
// If you add a new `session.messages(...)` call, this test fails until you
// include a `limit` in the query. The test does a static source-text scan
// so it catches the issue at lint-time without runtime mocking overhead.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_SRC = join(__dirname, "..", "..", "src");

/** Recursively walk a directory and return paths of all `.ts` files
 *  excluding `.test.ts`, `.gen.ts`, and node_modules. */
function walkSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist") continue;
        const full = join(dir, entry);
        const s = statSync(full);
        if (s.isDirectory()) {
            walkSourceFiles(full, out);
        } else if (
            s.isFile() &&
            entry.endsWith(".ts") &&
            !entry.endsWith(".test.ts") &&
            !entry.endsWith(".gen.ts")
        ) {
            out.push(full);
        }
    }
    return out;
}

/** Find call expressions matching `session.messages(...)` and return the
 *  source text of each call (from "session.messages(" to its matching ")"). */
function findSessionMessagesCalls(source: string): string[] {
    const calls: string[] = [];
    const needle = "session.messages(";
    let i = 0;
    while (true) {
        const idx = source.indexOf(needle, i);
        if (idx === -1) break;
        // Skip comments — if the line starts with `*` or `//` we ignore.
        const lineStart = source.lastIndexOf("\n", idx) + 1;
        const linePrefix = source.slice(lineStart, idx).trimStart();
        if (linePrefix.startsWith("//") || linePrefix.startsWith("*")) {
            i = idx + needle.length;
            continue;
        }
        // Walk forward to find the matching closing paren, respecting
        // brace/bracket/paren nesting.
        let depth = 1;
        let j = idx + needle.length;
        while (j < source.length && depth > 0) {
            const ch = source[j];
            if (ch === "(" || ch === "{" || ch === "[") depth++;
            else if (ch === ")" || ch === "}" || ch === "]") depth--;
            j++;
        }
        if (depth === 0) {
            calls.push(source.slice(idx, j));
        }
        i = j;
    }
    return calls;
}

describe("session.messages() callsites must include query.limit", () => {
    const files = walkSourceFiles(PLUGIN_SRC);
    const violations: Array<{ file: string; callText: string }> = [];

    for (const file of files) {
        // Skip the regression test itself
        if (file.endsWith("session-messages-bounded.test.ts")) continue;
        const source = readFileSync(file, "utf-8");
        const calls = findSessionMessagesCalls(source);
        for (const call of calls) {
            // The call text spans from "session.messages(" to the closing
            // ")". A correct call must mention `limit` (the SDK key) somewhere
            // inside that span — typically `query: { ..., limit: N }`.
            if (!/\blimit\b/.test(call)) {
                violations.push({ file: file.replace(PLUGIN_SRC, "<plugin>/src"), callText: call });
            }
        }
    }

    it("has no unbounded session.messages() calls in plugin code", () => {
        if (violations.length > 0) {
            const report = violations
                .map(
                    (v) =>
                        `\n  in ${v.file}:\n    ${v.callText.replace(/\n/g, "\n    ").slice(0, 300)}`,
                )
                .join("\n");
            throw new Error(
                `Found ${violations.length} unbounded session.messages() call(s). ` +
                    `Add \`limit: 50\` (or appropriate bound) to query.${report}`,
            );
        }
        expect(violations).toEqual([]);
    });
});
