/**
 * verify prompt + manifest parser.
 *
 * verify checks each in-scope project memory against the CURRENT source and
 * emits ONE XML manifest (verified / update / archive). The agent reads code
 * and changes nothing; the HOST parses the manifest and applies the DB writes
 * (so the agent never needs a mutation tool). Calibrated in the shadow harness
 * with planted ground-truth controls (4/4: caught a stale number → update, a
 * wrong tool-count → archive, a same-session change → archive, and kept the
 * correct control verified). See .alfonso/plans/dreamer-v2-rework.md.
 *
 * The DANGEROUS failure mode is WRONG ARCHIVAL (deleting a TRUE memory), so the
 * prompt and the host apply both bias hard toward keeping memories.
 */

import { assertNoDuplicateManifestIds, extractCompleteManifestBody } from "./manifest-parser";

export const VERIFY_SYSTEM_PROMPT = `You are a memory verifier for the magic-context system. You verify project memories against the CURRENT code.

Each memory below comes with its backing file(s) — the code it makes a claim about. For EACH memory: read its backing files (you may read more if needed) and decide whether the memory is still accurate.

Tools (read-only): read, grep, glob, aft_search, aft_outline, aft_zoom. You read code to check claims; you change nothing.

Decide ONE of three outcomes per memory:
- VERIFIED — still accurate. Keep it as-is.
- UPDATE — the underlying fact is still true but a DETAIL drifted (a renamed symbol, moved file, changed number/name). Provide corrected content in terse present tense ("X uses Y", not "X was changed to Y"). Only update for genuine drift, not style.
- ARCHIVE — the code CLEARLY contradicts the memory, or the thing it describes no longer exists.

BE CONSERVATIVE ABOUT ARCHIVING. Wrong archival of a TRUE memory is the worst possible outcome — far worse than leaving a slightly-stale memory. If you cannot find the code, or you are unsure, or it might still be true somewhere you didn't look: mark it VERIFIED, never archived. Archive ONLY when you have positive evidence the code contradicts it.

Output ONE XML manifest at the very end and NOTHING else — no narration, no per-memory commentary, no reasoning:
<verify>
<verified id="N" files="path/a.ts,path/b.ts"/>
<update id="M" files="path/c.ts">corrected present-tense content</update>
<archive id="K" reason="specific evidence the code contradicts it"/>
</verify>

Rules:
- Every input memory id MUST appear exactly once, in exactly one of verified/update/archive.
- files = the COMPLETE current backing set (repo-relative, comma-separated). It may differ from the given mapping if a file moved — record what you actually verified against.
- Default to VERIFIED. update and archive are the exceptions, not the norm.`;

export interface VerifyPromptMemory {
    id: number;
    category: string;
    content: string;
    mappedFiles: string[];
}

export function buildVerifyPrompt(projectPath: string, memories: VerifyPromptMemory[]): string {
    const list = memories
        .map(
            (m) =>
                `[${m.id}] ${m.category}\nContent: ${m.content}\nBacking files: ${m.mappedFiles.join(", ")}`,
        )
        .join("\n\n");
    return `## Verify these memories against the code

Project: ${projectPath}

Read each memory's backing files, decide verified / update / archive (default verified; be conservative about archiving), then output ONE <verify> manifest covering every id.

<memories>
${list}
</memories>`;
}

export interface ParsedVerifyManifest {
    verified: Array<{ id: number; files: string[] }>;
    updated: Array<{ id: number; files: string[]; content: string }>;
    archived: Array<{ id: number; reason: string }>;
}

function attrOf(s: string, name: string): string | null {
    const m = s.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
    return m ? m[1] : null;
}

function filesOf(s: string): string[] {
    return (attrOf(s, "files") ?? "")
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
}

/** Parse the agent's complete `<verify>` manifest. The root close tag is
 *  mandatory so truncated output cannot apply a partial set of verdicts. */
export function parseVerifyManifest(text: string): ParsedVerifyManifest {
    const out: ParsedVerifyManifest = { verified: [], updated: [], archived: [] };
    const body = extractCompleteManifestBody(text, "verify");

    for (const m of body.matchAll(/<verified\b([^>]*)\/?>/g)) {
        const id = Number.parseInt(attrOf(m[1], "id") ?? "", 10);
        if (!Number.isInteger(id)) throw new Error("verify manifest entry missing numeric id");
        out.verified.push({ id, files: filesOf(m[1]) });
    }
    for (const m of body.matchAll(/<update\b([^>]*?)(?:\/>|>([\s\S]*?)<\/update>)/g)) {
        const id = Number.parseInt(attrOf(m[1], "id") ?? "", 10);
        if (!Number.isInteger(id)) throw new Error("verify manifest entry missing numeric id");
        out.updated.push({ id, files: filesOf(m[1]), content: (m[2] ?? "").trim() });
    }
    for (const m of body.matchAll(/<archive\b([^>]*)\/?>/g)) {
        const id = Number.parseInt(attrOf(m[1], "id") ?? "", 10);
        if (!Number.isInteger(id)) throw new Error("verify manifest entry missing numeric id");
        out.archived.push({ id, reason: attrOf(m[1], "reason") ?? "" });
    }
    assertNoDuplicateManifestIds(
        [...out.verified, ...out.updated, ...out.archived].map((entry) => entry.id),
        "verify",
    );
    return out;
}
