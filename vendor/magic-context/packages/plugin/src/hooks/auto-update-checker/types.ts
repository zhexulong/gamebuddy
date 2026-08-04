import { z } from "zod";

export const NpmPackageEnvelopeSchema = z.object({
    "dist-tags": z.record(z.string(), z.string()).optional().default({}),
});

export const OpencodePluginTupleSchema = z.tuple([z.string(), z.record(z.string(), z.unknown())]);

export const OpencodeConfigSchema = z.object({
    plugin: z.array(z.union([z.string(), OpencodePluginTupleSchema])).optional(),
});

export const PackageJsonSchema = z
    .object({
        name: z.string().optional(),
        version: z.string().optional(),
        dependencies: z.record(z.string(), z.string()).optional(),
    })
    .passthrough();

export interface AutoUpdateCheckerOptions {
    enabled?: boolean;
    showStartupToast?: boolean;
    autoUpdate?: boolean;
    npmRegistryUrl?: string;
    fetchTimeoutMs?: number;
    signal?: AbortSignal;
    /**
     * Storage directory used for cross-process check coordination. The
     * checker writes `last-update-check.json` here so concurrent plugin
     * instances (multi-project TUI launches) only hit npm once per
     * `checkIntervalMs`. Pass `null`/omit for fail-open behavior — the
     * check still runs, just without dedup. Recommended: pass the
     * plugin's existing storage path (e.g. `getMagicContextStorageDir()`).
     */
    storageDir?: string | null;
    /**
     * Minimum interval between checks across all plugin instances on
     * this machine. Default: 1 hour.
     */
    checkIntervalMs?: number;
    /**
     * Delay before the post-init check fires. Lets OpenCode finish boot
     * before the npm round-trip starts. Default: 5000ms.
     */
    initDelayMs?: number;
}

export interface PluginEntryInfo {
    entry: string;
    isPinned: boolean;
    pinnedVersion: string | null;
    configPath: string;
}
