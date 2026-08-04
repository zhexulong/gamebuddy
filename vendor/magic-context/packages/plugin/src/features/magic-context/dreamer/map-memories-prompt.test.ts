import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    buildMapMemoriesPrompt,
    extractMemoryCandidatePaths,
    parseMapMemoriesManifest,
} from "./map-memories-prompt";

describe("parseMapMemoriesManifest", () => {
    it("parses files and independent flags, tolerant of attribute order", () => {
        const text = `prose before
<mappings>
<memory id="1" files="a/b.ts,c/d.ts"/>
<memory id="2" independent="true"/>
<memory files="x/y.ts" id="3"/>
</mappings>`;
        const out = parseMapMemoriesManifest(text);
        expect(out).toEqual([
            { id: 1, files: ["a/b.ts", "c/d.ts"], independent: false },
            { id: 2, files: [], independent: true },
            { id: 3, files: ["x/y.ts"], independent: false },
        ]);
    });

    it("treats a memory with no files (and not explicit independent) as independent", () => {
        const out = parseMapMemoriesManifest(`<mappings><memory id="9"/></mappings>`);
        expect(out).toEqual([{ id: 9, files: [], independent: true }]);
    });

    it("trims file whitespace", () => {
        const out = parseMapMemoriesManifest(
            `<mappings><memory id="5" files=" a.ts ,  b.ts "/></mappings>`,
        );
        expect(out).toEqual([{ id: 5, files: ["a.ts", "b.ts"], independent: false }]);
    });

    it("rejects truncated, duplicate, and invalid entries", () => {
        expect(() => parseMapMemoriesManifest(`<mappings><memory id="5" files="a.ts"/>`)).toThrow(
            /closing root/,
        );
        expect(() =>
            parseMapMemoriesManifest(
                `<mappings><memory id="5" files="a.ts"/><memory id="5" independent="true"/></mappings>`,
            ),
        ).toThrow(/duplicate id/);
        expect(() =>
            parseMapMemoriesManifest(`<mappings><memory id="x" files="a.ts"/></mappings>`),
        ).toThrow(/numeric id/);
    });
});

describe("extractMemoryCandidatePaths", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mc-map-prompt-"));
    writeFileSync(path.join(dir, "real.ts"), "x");
    const sub = path.join(dir, "pkg");
    require("node:fs").mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "file.ts"), "x");

    it("returns only repo-relative paths that actually exist", () => {
        const found = extractMemoryCandidatePaths(
            "In `pkg/file.ts`, X does Y; also nonexistent/ghost.ts is referenced.",
            dir,
        );
        expect(found).toEqual(["pkg/file.ts"]);
    });

    it("does not seed when the memory names no path (conceptual memory)", () => {
        const found = extractMemoryCandidatePaths(
            "The classify task scores importance, scope, and shareability.",
            dir,
        );
        expect(found).toEqual([]);
    });

    it("ignores traversal paths", () => {
        const found = extractMemoryCandidatePaths("see ../escape/file.ts", dir);
        expect(found).toEqual([]);
    });

    it("resets regex state per call (no lastIndex bleed across memories)", () => {
        // The bug this guards: a module-level /g regex carries lastIndex; calling
        // twice must each resolve the leading path.
        const a = extractMemoryCandidatePaths("pkg/file.ts is here", dir);
        const b = extractMemoryCandidatePaths("pkg/file.ts is here", dir);
        expect(a).toEqual(["pkg/file.ts"]);
        expect(b).toEqual(["pkg/file.ts"]);
        rmSync(dir, { recursive: true, force: true });
    });
});

describe("buildMapMemoriesPrompt", () => {
    it("includes the seed line only when candidates exist", () => {
        const prompt = buildMapMemoriesPrompt("git:abc", [
            { id: 1, category: "ARCHITECTURE", content: "foo", candidates: ["a/b.ts"] },
            { id: 2, category: "CONSTRAINTS", content: "bar", candidates: [] },
        ]);
        expect(prompt).toContain("[1] ARCHITECTURE");
        expect(prompt).toContain("Likely files (named in the memory, confirmed to exist): a/b.ts");
        expect(prompt).toContain("[2] CONSTRAINTS\nbar");
        // memory 2 has no candidates → no seed line for it
        expect(prompt).not.toContain("Likely files (named in the memory, confirmed to exist): \n");
    });
});
