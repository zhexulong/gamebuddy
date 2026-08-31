/**
 * Shared model-selection UX for the setup wizard (both OpenCode and Pi).
 *
 * Replaces the old per-harness `buildModelSelection` recommendation trees, which
 * hardcoded a curated list of "recommended" model ids. That was wrong for two
 * reasons: it surfaced models the user often didn't have, and it buried the
 * user's actual models below a capped tail (issue #144). Instead we now show the
 * user's FULL real model list, sorted, in a scrollable type-ahead picker, with a
 * short explanation of what each background role does and the (important) note
 * that these roles do NOT need a frontier model.
 */
import type { PromptIO, SelectOption } from "./prompts";

export type ModelRole = "historian" | "dreamer" | "sidekick";

interface RoleCopy {
    title: string;
    /** What the role does + the "a smaller/cheaper model is fine" guidance. */
    blurb: string;
    pickMessage: string;
    placeholder: string;
}

const ROLE_COPY: Record<ModelRole, RoleCopy> = {
    historian: {
        title: "Historian",
        blurb:
            "The historian runs in the background and condenses older conversation into\n" +
            "compact summaries, so your context never overflows. It works on one bounded\n" +
            "chunk at a time and runs often — it does NOT need a frontier model. A smaller,\n" +
            "cheaper, faster model (a mini / flash / haiku tier) works well here and keeps\n" +
            "your costs down.",
        pickMessage: "Select a model for the historian",
        placeholder: "type to filter (e.g. haiku, flash, mini)…",
    },
    dreamer: {
        title: "Dreamer",
        blurb:
            "The dreamer runs periodically (typically overnight) to consolidate and maintain\n" +
            "your project memories. It is not on the hot path and does NOT need a frontier\n" +
            "model — a cheaper or local model is a good fit here.",
        pickMessage: "Select a model for the dreamer",
        placeholder: "type to filter (e.g. flash, local, glm)…",
    },
    sidekick: {
        title: "Sidekick",
        blurb:
            "The sidekick augments your prompt with relevant project context when you run\n" +
            "/ctx-aug. Fast models are preferred here.",
        pickMessage: "Select a model for the sidekick",
        placeholder: "type to filter…",
    },
};

/** De-duplicate and sort the model catalog for display (provider-grouped via a
 *  plain lexical sort, since ids are `provider/model`). */
export function sortModelsForPicker(models: string[]): string[] {
    return [...new Set(models)].sort((a, b) => a.localeCompare(b));
}

export function modelOptions(models: string[]): SelectOption[] {
    return sortModelsForPicker(models).map((model) => ({ label: model, value: model }));
}

/**
 * Show the role explanation, then let the user pick a model from their full
 * catalog via a scrollable type-ahead list. When no models were detected
 * (fetch failed), fall back to free-text entry so the user can still type an id
 * — never block setup behind an empty list.
 */
export async function pickModel(
    prompts: PromptIO,
    allModels: string[],
    role: ModelRole,
): Promise<string> {
    const copy = ROLE_COPY[role];
    prompts.note(copy.blurb, copy.title);

    const options = modelOptions(allModels);
    if (options.length === 0) {
        return (
            await prompts.text(`${copy.pickMessage} (type a provider/model id)`, {
                placeholder: "e.g. anthropic/claude-haiku-4-5",
                validate: (value) =>
                    value.trim().length === 0 ? "A model id is required" : undefined,
            })
        ).trim();
    }
    return prompts.selectAutocomplete(copy.pickMessage, options, {
        placeholder: copy.placeholder,
    });
}
