import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

describe("configuration reference docs", () => {
    const docsPath = path.resolve(
        import.meta.dir,
        "..",
        "..",
        "docs",
        "src",
        "content",
        "docs",
        "reference",
        "configuration.md",
    );

    test("committed configuration.md matches generator output (run `bun packages/plugin/scripts/build-config-docs.ts` if this fails)", async () => {
        const { buildConfigDocs } = await import("./build-config-docs");
        const committed = fs.readFileSync(docsPath, "utf-8");
        const regenerated = buildConfigDocs();
        expect(committed).toBe(regenerated);
    });
});
