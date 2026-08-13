import { describe, expect, test } from "bun:test";
import {
    DEFAULT_CODING_PROJECT_MEMORY_CATEGORIES,
    factCategoriesForDomain,
    historianSystemPromptForDomain,
    ONGOING_INTERACTION_MEMORY_CATEGORIES,
} from "./domain";
import { parseCompartmentOutput } from "../../../hooks/magic-context/compartment-parser";

const interactionOutput = `<output>
<compartments>
<compartment start="1" end="2" title="brief exchange" episode_type="interaction" importance="40"><p1>The player named a lamp and discussed a completed tool tidy-up.</p1></compartment>
</compartments>
<facts>
<SEMANTIC_MEMORY>* The player explicitly prefers being offered options before a consequential decision.</SEMANTIC_MEMORY>
<INTERACTION_EPISODE>* We finished organizing tools during this game.</INTERACTION_EPISODE>
</facts>
<meta><messages_processed>1-2</messages_processed><unprocessed_from>3</unprocessed_from></meta>
</output>`;

describe("ongoing-interaction memory domain", () => {
    test("uses a dedicated historian prompt that keeps completed activity episodic", () => {
        const prompt = historianSystemPromptForDomain("ongoing-interaction");
        expect(prompt).toContain("Episodic Memory");
        expect(prompt).toContain("Semantic Memory gate");
        expect(prompt).toContain("We finished organizing tools during this game.");
        expect(prompt).toContain("must not be promoted");
        expect(prompt).toContain("IdentityProfile");
        expect(prompt).toContain("Live World");
        expect(historianSystemPromptForDomain("coding-project")).not.toBe(prompt);
    });

    test("accepts only the ongoing-interaction fact taxonomy", () => {
        expect(factCategoriesForDomain("ongoing-interaction")).toEqual(
            ONGOING_INTERACTION_MEMORY_CATEGORIES,
        );
        expect(factCategoriesForDomain("coding-project")).toEqual(
            DEFAULT_CODING_PROJECT_MEMORY_CATEGORIES,
        );

        const parsed = parseCompartmentOutput(
            interactionOutput,
            factCategoriesForDomain("ongoing-interaction"),
        );
        expect(parsed.facts).toEqual([
            {
                category: "SEMANTIC_MEMORY",
                content: "The player explicitly prefers being offered options before a consequential decision.",
            },
            {
                category: "INTERACTION_EPISODE",
                content: "We finished organizing tools during this game.",
            },
        ]);

        const codingParsed = parseCompartmentOutput(
            interactionOutput,
            factCategoriesForDomain("coding-project"),
        );
        expect(codingParsed.facts).toEqual([]);
    });
});
