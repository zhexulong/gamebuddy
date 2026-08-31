import { describe, expect, it } from "bun:test";

import { migrateLegacyExperimental } from "./migrate-experimental";

describe("migrateLegacyExperimental — mural", () => {
    it("moves a legacy mural object and emits a deprecation warning", () => {
        const warnings: string[] = [];
        const migrated = migrateLegacyExperimental(
            { experimental: { mural: { enabled: true, model: "provider/cues" } } },
            warnings,
        );

        expect(migrated).toMatchObject({ mural: { enabled: true, model: "provider/cues" } });
        expect((migrated.experimental as Record<string, unknown>).mural).toBeUndefined();
        expect(warnings).toEqual([
            'Deprecated "experimental.mural"; use top-level "mural" instead (migrated in memory; run `doctor` to persist).',
        ]);
    });

    it("preserves explicit top-level values when both spellings exist", () => {
        const warnings: string[] = [];
        const migrated = migrateLegacyExperimental(
            {
                mural: { enabled: false, model: "provider/new" },
                experimental: { mural: { enabled: true, model: "provider/old" } },
            },
            warnings,
        );

        expect(migrated.mural).toEqual({ enabled: false, model: "provider/new" });
        expect(warnings).toHaveLength(0);
    });

    it("coerces a legacy boolean mural into the block shape", () => {
        const warnings: string[] = [];
        const migrated = migrateLegacyExperimental({ experimental: { mural: true } }, warnings);

        expect(migrated.mural).toEqual({ enabled: true });
        expect(warnings[0]).toContain('use top-level "mural"');
    });
});
