export type ContextLimitProvenance = "prompt_only" | "combined" | "unknown";

export function normalizeContextLimitProvenance(value: unknown): ContextLimitProvenance {
    if (value === "prompt_only" || value === "combined") return value;
    return "unknown";
}
