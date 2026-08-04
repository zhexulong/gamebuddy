import { describe, expect, it } from "bun:test";

import {
    buildContentLanguageDirective,
    buildMigrationLanguageDirective,
    buildPrimaryLanguageDirective,
    isValidLanguageCode,
    resolveLanguageName,
    withContentLanguageDirective,
    withMigrationLanguageDirective,
} from "./language-directive";

const EXHAUSTIVE_STRUCTURAL_TOKENS = [
    "summary",
    "symptom",
    "model_or_provider_involved",
    "ord_span",
    "provider_sdk",
    "model_behavior",
    "tool_protocol",
    "host_integration",
    "historian_pipeline",
    "edit_pipeline",
    "environment",
    "undocumented_internal",
    "other",
    "fixed",
    "workaround",
    "external_blocker",
    "contained_failure",
    "deferred",
    "unknown_but_bounded",
    "user",
    "test_result",
    "tool_result",
    "self_review",
    "unprocessed_from",
    "verified",
    "update",
    "archive",
    "candidate_ids",
    "update_existing",
    "memory_id",
    "dismiss_existing",
    "consume_candidate_ids",
    "migrated",
    "user_observations",
    "answer",
] as const;

describe("resolveLanguageName", () => {
    it("maps a 2-letter ISO 639-1 code to 'English (Endonym)'", () => {
        expect(resolveLanguageName("tr")).toBe("Turkish (Türkçe)");
        expect(resolveLanguageName("es")).toBe("Spanish (Español)");
        expect(resolveLanguageName("ja")).toBe("Japanese (日本語)");
    });
    it("normalizes case and surrounding whitespace", () => {
        expect(resolveLanguageName("  TR ")).toBe("Turkish (Türkçe)");
    });
    it("returns the bare English name when the endonym matches it", () => {
        expect(resolveLanguageName("en")).toBe("English");
    });
    it("returns '' for unset, blank, non-codes, and unknown codes", () => {
        expect(resolveLanguageName()).toBe("");
        expect(resolveLanguageName("   ")).toBe("");
        expect(resolveLanguageName("Turkish")).toBe(""); // full name rejected
        expect(resolveLanguageName("tur")).toBe(""); // 3-letter rejected
        expect(resolveLanguageName("zz")).toBe(""); // not a real language
        expect(resolveLanguageName("e1")).toBe("");
    });
    it("isValidLanguageCode mirrors resolveLanguageName", () => {
        expect(isValidLanguageCode("tr")).toBe(true);
        expect(isValidLanguageCode("zz")).toBe(false);
        expect(isValidLanguageCode("Español")).toBe(false);
    });
});

describe("language directives", () => {
    it("emits the content directive with the resolved name and structural rule", () => {
        const directive = buildContentLanguageDirective("tr");
        expect(directive).toContain("Write human-readable prose you author in: Turkish (Türkçe).");
        expect(directive).toContain("Copy required output schemas exactly");
        expect(directive).toContain("No relevant memories found");
    });

    it("emits the preserve-user-quotes variant", () => {
        const directive = buildContentLanguageDirective("es", {
            preserveUserQuotes: true,
        });
        expect(directive).toContain(
            "Preserve U: lines and directly quoted user text in their original source language; write the surrounding summary prose in Spanish (Español).",
        );
    });

    it("emits the retrospective no-quote variant", () => {
        const directive = buildContentLanguageDirective("tr", { retrospective: true });
        expect(directive).toContain(
            "Write the lesson text in Turkish (Türkçe); paraphrase source text and never quote the user.",
        );
        expect(directive).not.toContain("directly quoted user text");
    });

    it("emits the migration preserve-language variant", () => {
        const directive = buildMigrationLanguageDirective("pt");
        expect(directive).toContain("Preserve each migrated memory's existing language");
        expect(directive).toContain(
            "do NOT translate a memory just because an output language is set",
        );
        expect(directive).not.toContain("Write human-readable prose you author");
    });

    it("emits the primary one-liner with the resolved name", () => {
        expect(buildPrimaryLanguageDirective("zh")).toBe(
            "Use Chinese (中文) for your natural-language replies to the user unless the user explicitly asks for another language. Keep code, identifiers, file paths, commands, logs, and quoted text verbatim.",
        );
    });

    it("returns empty or unchanged for blank or invalid language", () => {
        expect(buildContentLanguageDirective()).toBe("");
        expect(buildContentLanguageDirective("   ")).toBe("");
        expect(buildContentLanguageDirective("Turkish")).toBe(""); // full name not a code
        expect(buildMigrationLanguageDirective()).toBe("");
        expect(buildPrimaryLanguageDirective()).toBe("");
        expect(withContentLanguageDirective("base", "")).toBe("base");
        expect(withMigrationLanguageDirective("base", " ")).toBe("base");
        expect(withContentLanguageDirective("base", "zz")).toBe("base"); // unknown code
    });

    it("does not inline the exhaustive structural token inventory", () => {
        const directive = buildContentLanguageDirective("tr");
        for (const token of EXHAUSTIVE_STRUCTURAL_TOKENS) {
            const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            expect(directive, token).not.toMatch(
                new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`),
            );
        }
    });
});
