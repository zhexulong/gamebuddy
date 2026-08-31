import { describe, expect, it } from "bun:test";
import {
    coercePinKeyFilesValue,
    migrateExperimentalPinKeyFilesForDoctor,
} from "./migrate-experimental-doctor";

describe("migrateExperimentalPinKeyFilesForDoctor", () => {
    it("coerces boolean experimental.pin_key_files and preserves sub-fields", () => {
        const cfg: Record<string, unknown> = {
            experimental: { pin_key_files: true },
        };
        expect(migrateExperimentalPinKeyFilesForDoctor(cfg)).toBe(true);
        expect(cfg.experimental).toBeUndefined();
        expect(cfg.dreamer).toEqual({ pin_key_files: { enabled: true } });
    });

    it("merges token_budget and min_reads from experimental object", () => {
        const cfg: Record<string, unknown> = {
            experimental: {
                pin_key_files: { enabled: true, token_budget: 8000, min_reads: 3 },
            },
            dreamer: { pin_key_files: { enabled: false } },
        };
        migrateExperimentalPinKeyFilesForDoctor(cfg);
        expect((cfg.dreamer as Record<string, unknown>).pin_key_files).toEqual({
            enabled: false,
            token_budget: 8000,
            min_reads: 3,
        });
    });

    it("coerces primitive dreamer.pin_key_files with object experimental block", () => {
        const cfg: Record<string, unknown> = {
            experimental: {
                pin_key_files: { token_budget: 5000, min_reads: 2 },
            },
            dreamer: { pin_key_files: true },
        };
        migrateExperimentalPinKeyFilesForDoctor(cfg);
        expect((cfg.dreamer as Record<string, unknown>).pin_key_files).toEqual({
            token_budget: 5000,
            min_reads: 2,
            enabled: true,
        });
    });
});

describe("coercePinKeyFilesValue", () => {
    it("maps boolean and shallow-clones objects", () => {
        expect(coercePinKeyFilesValue(false)).toEqual({ enabled: false });
        expect(coercePinKeyFilesValue({ enabled: true, token_budget: 1 })).toEqual({
            enabled: true,
            token_budget: 1,
        });
    });
});
