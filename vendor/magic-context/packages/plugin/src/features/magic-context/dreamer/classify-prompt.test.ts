import { describe, expect, it } from "bun:test";

import { buildClassifyPrompt, parseClassifyManifest } from "./classify-prompt";

describe("parseClassifyManifest", () => {
    it("parses importance/scope/shareable, clamping and normalizing", () => {
        const text = `noise
<classify>
<memory id="1" importance="75" scope="project" shareable="true"/>
<memory id="2" importance="200" scope="universe" shareable="false"/>
<memory shareable="1" scope="ecosystem" importance="40" id="3"/>
</classify>`;
        const out = parseClassifyManifest(text);
        expect(out).toEqual([
            { id: 1, importance: 75, scope: "project", shareable: true },
            { id: 2, importance: 100, scope: "universe", shareable: false }, // clamped to 100
            { id: 3, importance: 40, scope: "ecosystem", shareable: true },
        ]);
    });

    it("rejects invalid scope", () => {
        expect(() =>
            parseClassifyManifest(
                `<classify><memory id="5" importance="50" scope="bogus" shareable="true"/></classify>`,
            ),
        ).toThrow(/invalid scope/);
    });

    it("rejects truncated, duplicate, and invalid entries", () => {
        expect(() => parseClassifyManifest(`<classify><memory id="5" importance="50"/>`)).toThrow(
            /closing root/,
        );
        expect(() =>
            parseClassifyManifest(
                `<classify><memory id="5" importance="50"/><memory id="5" shareable="true"/></classify>`,
            ),
        ).toThrow(/duplicate id/);
        expect(() =>
            parseClassifyManifest(`<classify><memory id="x" importance="50"/></classify>`),
        ).toThrow(/numeric id/);
        expect(() => parseClassifyManifest(`<classify><memory id="9"/></classify>`)).toThrow(
            /classification fields/,
        );
    });
});

describe("buildClassifyPrompt", () => {
    it("renders the pool and instructs a single <classify> manifest", () => {
        const prompt = buildClassifyPrompt({
            projectPath: "git:abc",
            memories: [
                {
                    id: 1,
                    category: "ARCHITECTURE",
                    content: "foo",
                    importance: 50,
                    scope: "project",
                    shareable: false,
                },
            ],
        });
        expect(prompt).toContain("[1] ARCHITECTURE");
        expect(prompt).toContain("Emit one <classify> manifest");
        // No anchors block when none given.
        expect(prompt).not.toContain("Already-classified reference memories");
    });

    it("renders the anchor block when anchors are provided (Stage 3)", () => {
        const prompt = buildClassifyPrompt({
            projectPath: "git:abc",
            memories: [
                {
                    id: 2,
                    category: "CONSTRAINTS",
                    content: "bar",
                    importance: 50,
                    scope: "project",
                    shareable: false,
                },
            ],
            anchors: [{ id: 99, category: "ARCHITECTURE", content: "anchor", importance: 80 }],
        });
        expect(prompt).toContain("Already-classified reference memories");
        expect(prompt).toContain("[99] ARCHITECTURE importance=80");
        expect(prompt).toContain("do NOT re-score them");
    });
});
