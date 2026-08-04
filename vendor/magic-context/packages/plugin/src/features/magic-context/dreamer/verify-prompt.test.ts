import { describe, expect, it } from "bun:test";

import { buildVerifyPrompt, parseVerifyManifest } from "./verify-prompt";

describe("parseVerifyManifest", () => {
    it("parses verified / update / archive with attribute-order tolerance", () => {
        const text = `narration
<verify>
<verified id="1" files="a/b.ts,c/d.ts"/>
<update id="2" files="x.ts">X uses Y now</update>
<archive id="3" reason="the symbol no longer exists"/>
<verified files="z.ts" id="4"/>
</verify>`;
        const out = parseVerifyManifest(text);
        expect(out.verified).toEqual([
            { id: 1, files: ["a/b.ts", "c/d.ts"] },
            { id: 4, files: ["z.ts"] },
        ]);
        expect(out.updated).toEqual([{ id: 2, files: ["x.ts"], content: "X uses Y now" }]);
        expect(out.archived).toEqual([{ id: 3, reason: "the symbol no longer exists" }]);
    });

    it("handles a self-closing update (no content)", () => {
        const out = parseVerifyManifest(`<verify><update id="7" files="a.ts"/></verify>`);
        expect(out.updated).toEqual([{ id: 7, files: ["a.ts"], content: "" }]);
    });

    it("rejects a truncated manifest with no closing root", () => {
        expect(() => parseVerifyManifest(`<verify><archive id="9" reason="r"/>`)).toThrow(
            /closing root/,
        );
    });

    it("rejects duplicate ids and invalid entries", () => {
        expect(() =>
            parseVerifyManifest(
                `<verify><verified id="9" files="a.ts"/><archive id="9" reason="r"/></verify>`,
            ),
        ).toThrow(/duplicate id/);
        expect(() =>
            parseVerifyManifest(`<verify><verified id="x" files="a.ts"/></verify>`),
        ).toThrow(/numeric id/);
    });
});

describe("buildVerifyPrompt", () => {
    it("lists each memory with its backing files and instructs default-verified", () => {
        const prompt = buildVerifyPrompt("git:abc", [
            { id: 1, category: "ARCHITECTURE", content: "foo", mappedFiles: ["a.ts", "b.ts"] },
        ]);
        expect(prompt).toContain("[1] ARCHITECTURE");
        expect(prompt).toContain("Backing files: a.ts, b.ts");
        expect(prompt).toContain("default verified");
    });
});
