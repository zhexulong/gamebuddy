/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    buildCompartmentAgentPrompt,
    COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT,
} from "./compartment-prompt";

describe("compartment prompts", () => {
    it("has an extraction-free structural recomp prompt", () => {
        expect(COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT).toContain("structural recomp");
        expect(COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT).toContain("no <facts>");
        expect(COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT).toContain("no <events>");
        expect(COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT).toContain("no <user_observations>");
        expect(COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT).toContain("no <primer_candidates>");
    });

    it("marks recomp user prompts as extraction-free", () => {
        const prompt = buildCompartmentAgentPrompt({
            seedExamples: "",
            sessionReferences: "",
            projectMemory: "",
            inputSource: "Messages 1-1:\n\nU: hi",
            memoryEnabled: false,
            extractionFree: true,
        });
        expect(prompt).toContain("<extraction>disabled</extraction>");
        expect(prompt).toContain(
            "Do NOT emit <facts>, <events>, <user_observations>, or <primer_candidates>",
        );
    });
});
