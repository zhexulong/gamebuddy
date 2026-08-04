import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { assertNoDuplicateManifestIds, extractCompleteManifestBody } from "./manifest-parser";

/**
 * map-memories prompt + host-side helpers.
 *
 * map-memories is a ONE-TIME backfill: it locates the repo file(s) that back
 * each project memory (or marks it file-independent), recording the mapping so
 * the verify task can run incrementally from the start (verify reads "which
 * files changed since this memory's verification" — without a mapping, the first
 * verify would have to check the whole pool and time out, the cold-start trap).
 *
 * The agent only LOCATES backing files; the host parses its single XML manifest
 * and writes the mappings via recordMemoryMapping (mapped, not yet content-
 * verified). The prompt was calibrated in the shadow harness on real memory
 * pools (DeepSeek-v4-Flash); see .alfonso/plans/dreamer-v2-rework.md.
 */

export const MAP_MEMORIES_SYSTEM_PROMPT = `You are a memory mapper for the magic-context system. You map project memories to the repository files that back them.

A memory's BACKING FILES are the file(s) whose code the memory makes a claim about — the files you would open to check whether the memory is accurate. You do NOT judge accuracy, rewrite, or remove anything. You only LOCATE backing files.

Tools (read-only): read, grep, glob, aft_search, aft_outline, aft_zoom. Each memory may come with "Likely files" already named in it and confirmed to exist — confirm those FIRST (cheap) instead of searching. Use search/grep to FIND code only when no likely files are given. Do not guess — confirm a file exists and genuinely backs the memory before listing it. Keep reads minimal: you do not need to read a whole file to confirm it backs a one-line claim.

For each memory decide ONE of:
- Backing files found → the COMPLETE set of repo-relative paths whose code the memory is about.
- File-independent → the memory describes EXTERNAL behavior (a provider / API / platform / protocol limit, e.g. "Anthropic returns 400 on empty content"), or a pure process / workflow / philosophy rule, with NO specific local file that backs it.

Output ONE XML manifest at the very end and NOTHING else — no narration, no per-memory commentary, no reasoning:
<mappings>
<memory id="N" files="path/a.ts,path/b.ts"/>
<memory id="M" independent="true"/>
</mappings>

Rules:
- Every input memory id MUST appear exactly once.
- files: repo-relative, comma-separated, no spaces inside a path. Only files that actually exist and genuinely back the memory.
- A BACKING FILE is CODE that implements or handles the claim — not a file that merely mentions it. A markdown doc (.md), a PARITY/notes file, or a test that only DESCRIBES an external fact is NOT a backing file. If the only place a memory's fact appears is prose/docs/a test (no code implements or handles it), mark it independent="true".
- Many CONSTRAINTS are HYBRID: "external system does X, and OUR code handles it here." Map those to the HANDLING code (you can verify the handling, even though you can't verify the external behavior). Only mark independent when there is NO local code that implements or handles the fact.
- Prefer the most specific file(s); do not pad with tangential files. Most memories map to one file; some to a few.
- When you genuinely cannot find any local backing and it is not clearly external, still emit the memory with independent="true" (do not drop it).`;

// CONTEXT GUARD: seed at most this many candidate PATHS per memory (path strings
// only — never file contents, which is what blows up context). The agent
// confirms these instead of blind-searching to find them. ~half the pool names a
// path; the seed is a free assist for that half, not load-bearing.
export const MAX_SEED_PATHS_PER_MEMORY = 3;

// Repo-relative path-like tokens with a source/code extension. Deliberately
// narrow: a multi-segment path (a/b/c.ts), optionally wrapped in backticks. We
// only SEED what the memory already names; the agent still confirms (paths can
// be stale/renamed → the host validates existence before seeding).
// NOTE: built FRESH per call via matchAll — a shared /g regex carries lastIndex
// across calls and silently skips matches at the start of later inputs.
const PATH_PATTERN =
    "`?((?:[\\w.-]+\\/)+[\\w.-]+\\.(?:ts|tsx|js|jsx|mjs|cjs|rs|go|py|json|jsonc|sql|toml|sh))`?";

/** Extract candidate backing-file paths a memory NAMES, keep only those that
 *  EXIST in the repo, dedupe, cap. Pure host-side seeding — no LLM, no contents. */
export function extractMemoryCandidatePaths(content: string, repoDir: string): string[] {
    const found = new Set<string>();
    const root = path.resolve(repoDir);
    for (const match of content.matchAll(new RegExp(PATH_PATTERN, "g"))) {
        const rel = match[1];
        if (rel.includes("..")) continue;
        const abs = path.resolve(repoDir, rel);
        if (!abs.startsWith(`${root}/`)) continue;
        try {
            if (existsSync(abs) && statSync(abs).isFile()) found.add(rel);
        } catch {
            /* unreadable → skip */
        }
        if (found.size >= MAX_SEED_PATHS_PER_MEMORY) break;
    }
    return [...found];
}

export interface MapMemoryInput {
    id: number;
    category: string;
    content: string;
    candidates: string[];
}

export function buildMapMemoriesPrompt(projectPath: string, memories: MapMemoryInput[]): string {
    const list = memories
        .map((m) => {
            const seed = m.candidates.length
                ? `\nLikely files (named in the memory, confirmed to exist): ${m.candidates.join(", ")}`
                : "";
            return `[${m.id}] ${m.category}\n${m.content}${seed}`;
        })
        .join("\n\n");
    return `## Map these memories to their backing files

Project: ${projectPath}

For each memory below, find the repo file(s) it makes a claim about, or mark it file-independent. When "Likely files" are listed, those paths are named in the memory and confirmed to exist — START there: confirm each actually backs the claim (a quick read/outline), drop any that don't, add others only if genuinely needed. Search from scratch only when no likely files are given. Then output ONE <mappings> manifest covering every id.

<memories>
${list}
</memories>`;
}

export interface ParsedMemoryMapping {
    id: number;
    files: string[];
    independent: boolean;
}

/** Parse the agent's complete `<mappings>` manifest. A missing root close tag is
 *  treated as truncation and rejects the whole batch. */
export function parseMapMemoriesManifest(text: string): ParsedMemoryMapping[] {
    const out: ParsedMemoryMapping[] = [];
    const body = extractCompleteManifestBody(text, "mappings");
    for (const m of body.matchAll(/<memory\b([^>]*)\/?>/g)) {
        const attrs = m[1];
        const idMatch = attrs.match(/\bid\s*=\s*"(\d+)"/);
        if (!idMatch) throw new Error("mappings manifest entry missing numeric id");
        const id = Number.parseInt(idMatch[1], 10);
        if (!Number.isInteger(id)) throw new Error("mappings manifest entry missing numeric id");
        const independent = /\bindependent\s*=\s*"(?:true|1)"/i.test(attrs);
        const filesMatch = attrs.match(/\bfiles\s*=\s*"([^"]*)"/);
        const files = filesMatch
            ? filesMatch[1]
                  .split(",")
                  .map((f) => f.trim())
                  .filter(Boolean)
            : [];
        out.push({ id, files, independent: independent || files.length === 0 });
    }
    assertNoDuplicateManifestIds(
        out.map((entry) => entry.id),
        "mappings",
    );
    return out;
}
