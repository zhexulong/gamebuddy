export type ResolvedTransformMode = "ts" | "rust";

export interface ResolveTransformModeArgs {
    configured: ResolvedTransformMode;
    userTierHasSubc: boolean;
    compactionEnabled: boolean;
}

export const RUST_COMPACTION_OFF_WARNING =
    "compaction-off mode does not support rust transform mode; using the TypeScript transform.";

const RUST_REQUIRES_USER_SUBC_WARNING =
    "rust mode requires user-level subc configuration; running ts.";

export function resolveTransformMode(args: ResolveTransformModeArgs): {
    mode: ResolvedTransformMode;
    warnings: string[];
} {
    if (args.configured === "rust" && !args.compactionEnabled) {
        return {
            mode: "ts",
            warnings: [RUST_COMPACTION_OFF_WARNING],
        };
    }

    if (args.configured === "rust" && !args.userTierHasSubc) {
        return {
            mode: "ts",
            warnings: [RUST_REQUIRES_USER_SUBC_WARNING],
        };
    }

    return { mode: args.configured, warnings: [] };
}
