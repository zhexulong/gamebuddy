import type { BuiltinCommandConfig } from "./types";

export function getMagicContextBuiltinCommands(): BuiltinCommandConfig {
    return {
        "ctx-status": {
            template: "ctx-status",
            description: "Show magic context status, pending queue, cache TTL, and debug info",
        },
        "ctx-recomp": {
            template: "ctx-recomp",
            description:
                "Rebuild compartments and facts from raw history (full or <start>-<end> range)",
        },
        "ctx-wrapup": {
            template: "ctx-wrapup",
            description: "Compact older live history while keeping the newest messages raw",
        },
        "ctx-session-upgrade": {
            template: "ctx-session-upgrade",
            description:
                "Upgrade this session to the latest history format: rebuild compartments and migrate project memories",
        },
        "ctx-flush": {
            template: "ctx-flush",
            description: "Force-process all pending magic context operations immediately",
        },
        "ctx-aug": {
            template: "ctx-aug",
            description: "Augment your prompt with project memory context via sidekick agent",
        },
        "ctx-dream": {
            template: "ctx-dream",
            description: "Run the hidden dreamer maintenance pass for this project now",
        },
        "ctx-embed": {
            template: "ctx-embed",
            description:
                "Embedding status, or start/pause history compartment embedding (start | pause)",
        },
    };
}
