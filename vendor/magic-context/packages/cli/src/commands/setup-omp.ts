import { ompModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";
import { OmpAdapter } from "../adapters/omp";
import {
    detectOmpBinary,
    getOmpAvailableModels,
    getOmpSetting,
    getOmpVersion,
    listOmpPlugins,
    OMP_PLUGIN_PACKAGE,
    runOmpCommand,
} from "../lib/omp-helpers";
import {
    getOmpAgentDir,
    getOmpNonGlobalConfigSources,
    getOmpPluginsLockPath,
    getOmpUserConfigPath,
} from "../lib/paths";
import {
    type PiCompatibleSetupHost,
    type RunSetupOptions,
    runSetup as runPiCompatibleSetup,
    type SetupEnvironment,
} from "./setup-pi";

export interface OmpSetupDeps {
    detectOmpBinary: typeof detectOmpBinary;
    getOmpVersion: typeof getOmpVersion;
    getOmpAvailableModels: typeof getOmpAvailableModels;
    getOmpSetting: typeof getOmpSetting;
    listOmpPlugins: typeof listOmpPlugins;
    runOmpCommand: typeof runOmpCommand;
}

export interface RunOmpSetupOptions extends RunSetupOptions {
    deps?: Partial<OmpSetupDeps>;
}

const DEFAULT_DEPS: OmpSetupDeps = {
    detectOmpBinary,
    getOmpVersion,
    getOmpAvailableModels,
    getOmpSetting,
    listOmpPlugins,
    runOmpCommand,
};

function resolveDeps(overrides: Partial<OmpSetupDeps> = {}): OmpSetupDeps {
    return { ...DEFAULT_DEPS, ...overrides };
}

function createOmpEnvironment(deps: OmpSetupDeps): SetupEnvironment {
    return {
        detectPiBinary: deps.detectOmpBinary,
        getPiVersion: deps.getOmpVersion,
        getAvailableModels: deps.getOmpAvailableModels,
        paths: {
            getPiAgentConfigDir: getOmpAgentDir,
            getPiUserConfigPath: getOmpUserConfigPath,
            getPiUserExtensionsPath: getOmpPluginsLockPath,
        },
    };
}

function createOmpHost(deps: OmpSetupDeps): PiCompatibleSetupHost {
    const adapterDeps = {
        detectOmpBinary: deps.detectOmpBinary,
        listOmpPlugins: deps.listOmpPlugins,
        runOmpCommand: deps.runOmpCommand,
    };
    return {
        displayName: "Oh My Pi (OMP)",
        cliName: "omp",
        packageSource: OMP_PLUGIN_PACKAGE,
        installCommand: `omp plugin install ${OMP_PLUGIN_PACKAGE}`,
        minimumVersion: "17.1.7",
        versionWarning: (version, minimum) =>
            `OMP ${version} is older than the tested minimum ${minimum}. ` +
            "Upgrade with `omp update` before enabling Magic Context.",
        modelRefToCanonical: ompModelRefToCanonical,
        ensurePluginEntry: async () => new OmpAdapter(adapterDeps).ensurePluginEntry(),
        beforeWrite: async ({ binaryPath, cwd, prompts, dryRun, configureHost }) => {
            if (!configureHost && !new OmpAdapter(adapterDeps).hasPluginEntry()) {
                return async () => {};
            }
            const compaction = deps.getOmpSetting(binaryPath, "compaction.enabled");
            const memoryBackend = deps.getOmpSetting(binaryPath, "memory.backend");
            if (compaction === null || memoryBackend === null) {
                prompts.log.error(
                    "Could not read OMP compaction/memory settings; refusing to install two context managers blindly.",
                );
                return false;
            }

            const changes: Array<{
                key: "compaction.enabled" | "memory.backend";
                from: string;
                to: string;
            }> = [];
            if (compaction === true) {
                const disable = await prompts.confirm(
                    "Disable OMP native compaction? Magic Context must own context management end to end.",
                    true,
                );
                if (!disable) {
                    prompts.log.error("OMP native compaction conflicts with Magic Context.");
                    return false;
                }
                changes.push({ key: "compaction.enabled", from: "true", to: "false" });
            }
            if (memoryBackend !== "off") {
                const disable = await prompts.confirm(
                    `Disable OMP memory backend "${memoryBackend}"? Running two automatic memory injectors duplicates context and writes.`,
                    true,
                );
                if (!disable) {
                    prompts.log.error(
                        "OMP automatic memory conflicts with Magic Context memory injection.",
                    );
                    return false;
                }
                changes.push({ key: "memory.backend", from: memoryBackend, to: "off" });
            }
            const nonGlobalSources = getOmpNonGlobalConfigSources(cwd);
            if (changes.length > 0 && nonGlobalSources.length > 0) {
                prompts.log.error(
                    "OMP effective settings come from project/overlay config; refusing to mutate the global config.\n" +
                        nonGlobalSources.map((path) => `- ${path}`).join("\n") +
                        "\nEdit those files directly, then rerun setup.",
                );
                return false;
            }

            if (dryRun) {
                for (const change of changes) {
                    prompts.log.message(
                        `[dry-run] would run \`omp config set ${change.key} ${change.to}\``,
                    );
                }
                return async () => {};
            }

            const applied: typeof changes = [];
            const rollback = async () => {
                for (const change of [...applied].reverse()) {
                    const result = deps.runOmpCommand(
                        binaryPath,
                        ["config", "set", change.key, change.from],
                        10_000,
                    );
                    if (result.ok) prompts.log.info(`Restored OMP ${change.key}=${change.from}`);
                    else prompts.log.error(result.stderr || `Could not restore OMP ${change.key}`);
                }
            };
            for (const change of changes) {
                const result = deps.runOmpCommand(
                    binaryPath,
                    ["config", "set", change.key, change.to],
                    10_000,
                );
                if (!result.ok) {
                    prompts.log.error(result.stderr || `Could not set OMP ${change.key}`);
                    await rollback();
                    return false;
                }
                applied.push(change);
                prompts.log.success(`Set OMP ${change.key}=${change.to}`);
            }
            return rollback;
        },
        rollbackPluginEntry: async (registration) => {
            if (registration.action === "already_present") return;
            const omp = deps.detectOmpBinary();
            if (!omp) return;
            const action = registration.action === "added" ? "uninstall" : "disable";
            deps.runOmpCommand(omp.path, ["plugin", action, OMP_PLUGIN_PACKAGE], 120_000);
        },
    };
}

const OMP_ENV = createOmpEnvironment(DEFAULT_DEPS);
const OMP_HOST = createOmpHost(DEFAULT_DEPS);

export async function runSetup(options: RunOmpSetupOptions = {}): Promise<number> {
    const { deps: overrides, ...setupOptions } = options;
    const deps = overrides ? resolveDeps(overrides) : DEFAULT_DEPS;
    return runPiCompatibleSetup({
        ...setupOptions,
        env: setupOptions.env ?? (overrides ? createOmpEnvironment(deps) : OMP_ENV),
        host: setupOptions.host ?? (overrides ? createOmpHost(deps) : OMP_HOST),
    });
}

export const __test = {
    createOmpEnvironment: (overrides: Partial<OmpSetupDeps> = {}) =>
        createOmpEnvironment(resolveDeps(overrides)),
    createOmpHost: (overrides: Partial<OmpSetupDeps> = {}) => createOmpHost(resolveDeps(overrides)),
};
