import { describe, expect, it } from "bun:test";
import { OMP_PLUGIN_PACKAGE } from "../lib/omp-helpers";
import { OmpAdapter } from "./omp";

describe("OmpAdapter", () => {
    it("detects an enabled Magic Context plugin from injected OMP probes", () => {
        const binaryPath = "/virtual/bin/omp";
        const detectionProbes: string[] = [];
        const pluginListProbes: string[] = [];
        const adapter = new OmpAdapter({
            detectOmpBinary: () => {
                detectionProbes.push(binaryPath);
                return { path: binaryPath, source: "path" };
            },
            listOmpPlugins: (path) => {
                pluginListProbes.push(path);
                return [
                    {
                        name: OMP_PLUGIN_PACKAGE,
                        version: "0.33.0",
                        enabled: true,
                    },
                ];
            },
            runOmpCommand: () => {
                throw new Error("read-only adapter probes must not run OMP commands");
            },
        });

        expect(adapter.isInstalled()).toBe(true);
        expect(adapter.hasPluginEntry()).toBe(true);
        expect(adapter.getInstalledPluginVersion()).toBe("0.33.0");
        expect(detectionProbes).toEqual([binaryPath, binaryPath, binaryPath]);
        expect(pluginListProbes).toEqual([binaryPath, binaryPath]);
    });
});
