import { ONGOING_INTERACTION_HISTORIAN_SYSTEM_PROMPT } from "../../../hooks/magic-context/ongoing-interaction-historian-prompt.generated";
import { COMPARTMENT_AGENT_SYSTEM_PROMPT } from "../../../hooks/magic-context/historian-prompt.generated";

export const MEMORY_DOMAINS = ["coding-project", "ongoing-interaction"] as const;
export type MemoryDomain = (typeof MEMORY_DOMAINS)[number];

export const ONGOING_INTERACTION_MEMORY_CATEGORIES = [
    "SEMANTIC_MEMORY",
    "INTERACTION_EPISODE",
] as const;

export const DEFAULT_CODING_PROJECT_MEMORY_CATEGORIES = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
] as const;

export function historianSystemPromptForDomain(domain: MemoryDomain): string {
    return domain === "ongoing-interaction"
        ? ONGOING_INTERACTION_HISTORIAN_SYSTEM_PROMPT
        : COMPARTMENT_AGENT_SYSTEM_PROMPT;
}

export function factCategoriesForDomain(domain: MemoryDomain): readonly string[] {
    return domain === "ongoing-interaction"
        ? ONGOING_INTERACTION_MEMORY_CATEGORIES
        : DEFAULT_CODING_PROJECT_MEMORY_CATEGORIES;
}
