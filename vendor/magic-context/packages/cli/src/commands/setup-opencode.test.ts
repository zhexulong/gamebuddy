import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "comment-json";
import {
    addPluginToOpenCodeConfig,
    addPluginToTuiConfig,
    findDcpPluginIndexes,
    writeMagicContextConfig,
} from "./setup-opencode";

const tempDirs: string[] = [];

function tempDir(): string {
    const path = mkdtempSync(join(tmpdir(), "mc-opencode-setup-"));
    tempDirs.push(path);
    return path;
}

afterEach(() => {
    for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("setup-opencode config safety", () => {
    it("leaves malformed existing config unchanged", () => {
        const path = join(tempDir(), "magic-context.jsonc");
        const malformed = `{\n  "historian": {\n`;
        writeFileSync(path, malformed);

        expect(() =>
            writeMagicContextConfig(path, {
                historianModel: "anthropic/claude-sonnet-4-6",
                dreamerEnabled: false,
                dreamerModel: null,
                sidekickEnabled: false,
                sidekickModel: null,
                claudeMax: false,
            }),
        ).toThrow(`Refusing to overwrite unparseable config ${path}`);
        expect(readFileSync(path, "utf-8")).toBe(malformed);
    });

    it("re-detects targets created after discovery and merges them", () => {
        const root = tempDir();
        const opencodePath = join(root, "opencode.jsonc");
        const tuiPath = join(root, "tui.jsonc");
        writeFileSync(opencodePath, `{"theme":"dark","plugin":["other"]}`);
        writeFileSync(tuiPath, `{"layout":"wide","plugin":["other-tui"]}`);

        // "none" is the stale pre-prompt detection result.
        addPluginToOpenCodeConfig(opencodePath, "none");
        addPluginToTuiConfig(tuiPath, "none");

        expect(parseJsonc(readFileSync(opencodePath, "utf-8"))).toMatchObject({
            theme: "dark",
            plugin: ["other", "@cortexkit/opencode-magic-context@latest"],
        });
        expect(parseJsonc(readFileSync(tuiPath, "utf-8"))).toMatchObject({
            layout: "wide",
            plugin: ["other-tui", "@cortexkit/opencode-magic-context@latest"],
        });
    });

    it("creates a missing config and merges a valid config", () => {
        const root = tempDir();
        const missingPath = join(root, "opencode.json");
        addPluginToOpenCodeConfig(missingPath, "none");
        expect(parseJsonc(readFileSync(missingPath, "utf-8"))).toMatchObject({
            compaction: { auto: false, prune: false },
        });

        const validPath = join(root, "existing.jsonc");
        writeFileSync(
            validPath,
            `{"theme":"dark","plugin":["other","@tarquinen/opencode-dcp@latest"]}`,
        );
        addPluginToOpenCodeConfig(validPath, "jsonc", true);
        const merged = parseJsonc(readFileSync(validPath, "utf-8")) as {
            theme?: string;
            plugin?: string[];
            compaction?: { auto?: boolean; prune?: boolean };
        };
        expect(merged).toMatchObject({
            theme: "dark",
            compaction: { auto: false, prune: false },
        });
        expect(merged.plugin).toContain("other");
        expect(merged.plugin).not.toContain("@tarquinen/opencode-dcp@latest");
    });
});

describe("setup-opencode per-harness config", () => {
    it("writes fresh OpenCode choices only inside OpenCode harness blocks", () => {
        const path = join(tempDir(), "magic-context.jsonc");

        writeMagicContextConfig(path, {
            historianModel: "fresh/historian",
            dreamerEnabled: true,
            dreamerModel: "fresh/dreamer",
            sidekickEnabled: false,
            sidekickModel: null,
            claudeMax: false,
        });

        const config = parseJsonc(readFileSync(path, "utf-8")) as {
            historian?: { model?: string; opencode?: { model?: string } };
            dreamer?: { model?: string; opencode?: { model?: string } };
        };
        expect(config.historian?.opencode?.model).toBe("fresh/historian");
        expect(config.historian).not.toHaveProperty("model");
        expect(config.dreamer?.opencode?.model).toBe("fresh/dreamer");
        expect(config.dreamer).not.toHaveProperty("model");
    });

    it("migrates flat fields through the shared raw loader before writing OpenCode choices", () => {
        const path = join(tempDir(), "magic-context.jsonc");
        writeFileSync(
            path,
            JSON.stringify({
                historian: { model: "legacy/historian" },
                dreamer: {
                    model: "legacy/dreamer",
                    tasks: { curate: { schedule: "0 3 * * *" } },
                },
            }),
        );

        writeMagicContextConfig(path, {
            historianModel: "new/historian",
            dreamerEnabled: true,
            dreamerModel: "new/dreamer",
            sidekickEnabled: false,
            sidekickModel: null,
            claudeMax: false,
        });

        const config = parseJsonc(readFileSync(path, "utf-8")) as {
            historian?: {
                model?: string;
                opencode?: { model?: string };
                pi?: { model?: string };
            };
            dreamer?: {
                model?: string;
                opencode?: { model?: string };
                pi?: { model?: string };
                tasks?: { curate?: { schedule?: string } };
            };
        };
        expect(config.historian?.opencode?.model).toBe("new/historian");
        expect(config.historian?.pi?.model).toBe("legacy/historian");
        expect(config.historian).not.toHaveProperty("model");
        expect(config.dreamer?.opencode?.model).toBe("new/dreamer");
        expect(config.dreamer?.pi?.model).toBe("legacy/dreamer");
        expect(config.dreamer?.tasks?.curate?.schedule).toBe("0 3 * * *");
        expect(config.dreamer).not.toHaveProperty("model");
    });
});

describe("setup-opencode DCP preflight", () => {
    it("is tuple-safe and only matches canonical opencode-dcp entries", () => {
        const plugins: unknown[] = [
            ["@plannotator/opencode@latest", { workflow: "plan-agent" }],
            "@some-fork/opencode-dcp-fork",
            ["@tarquinen/opencode-dcp@latest", { enabled: true }],
            "file:///tmp/opencode-dcp-dev",
        ];

        expect(() => findDcpPluginIndexes(plugins)).not.toThrow();
        expect(findDcpPluginIndexes(plugins)).toEqual([2]);
    });
});

// --- Compaction-off mode writer (issue #266 S2) ---
// In compaction-off mode the setup writer MUST NOT write
// compaction.auto=false / compaction.prune=false into opencode.jsonc —
// native compaction (or nothing) is the user's chosen window manager, so
// pre-existing native compaction fields are left byte-for-byte as found.
describe("setup-opencode compaction-off writer (issue #266)", () => {
    it("skips the compaction.auto=false write when compactionEnabled=false", () => {
        const root = tempDir();
        const configPath = join(root, "opencode.jsonc");
        writeFileSync(configPath, JSON.stringify({ compaction: { auto: true, prune: true } }));

        addPluginToOpenCodeConfig(configPath, "jsonc", false, false);

        const merged = parseJsonc(readFileSync(configPath, "utf-8")) as {
            compaction?: { auto?: boolean; prune?: boolean };
        };
        // Pre-existing native compaction values preserved byte-for-byte.
        expect(merged.compaction).toEqual({ auto: true, prune: true });
    });

    it("writes compaction.auto=false when compactionEnabled=true (default mode-on)", () => {
        const root = tempDir();
        const configPath = join(root, "opencode.jsonc");
        writeFileSync(configPath, JSON.stringify({ compaction: { auto: true, prune: true } }));

        addPluginToOpenCodeConfig(configPath, "jsonc", false, true);

        const merged = parseJsonc(readFileSync(configPath, "utf-8")) as {
            compaction?: { auto?: boolean; prune?: boolean };
        };
        expect(merged.compaction).toEqual({ auto: false, prune: false });
    });

    it("does not create a compaction block when compactionEnabled=false and none exists", () => {
        const root = tempDir();
        const configPath = join(root, "opencode.jsonc");
        addPluginToOpenCodeConfig(configPath, "jsonc", false, false);

        const merged = parseJsonc(readFileSync(configPath, "utf-8")) as {
            compaction?: unknown;
        };
        expect(merged.compaction).toBeUndefined();
    });

    // Mutation direction: with mode ON, the write DOES happen. Proves the
    // off-gate isn't just always-skip.
    it("mutation direction: same config gets auto=false when mode forced on", () => {
        const root = tempDir();
        const configPath = join(root, "opencode.jsonc");
        writeFileSync(configPath, JSON.stringify({ compaction: { auto: true } }));

        addPluginToOpenCodeConfig(configPath, "jsonc", false, false);
        const afterOff = parseJsonc(readFileSync(configPath, "utf-8")) as {
            compaction?: { auto?: boolean };
        };
        expect(afterOff.compaction?.auto).toBe(true);

        addPluginToOpenCodeConfig(configPath, "jsonc", false, true);
        const afterOn = parseJsonc(readFileSync(configPath, "utf-8")) as {
            compaction?: { auto?: boolean };
        };
        expect(afterOn.compaction?.auto).toBe(false);
    });
});

describe("setup-opencode JSONC byte preservation", () => {
    it("removes DCP and updates compaction without reformatting the existing config", () => {
        const configPath = join(tempDir(), "opencode.jsonc");
        const original =
            "// leading comment\r\n" +
            "{\r\n" +
            '\t"plugin": [\r\n' +
            "\t\t// first plugin\r\n" +
            '\t\t"@keep/first",\r\n' +
            "\t\t// removed DCP plugin\r\n" +
            '\t\t"@tarquinen/opencode-dcp@latest",\r\n' +
            "\t\t// Magic Context stays\r\n" +
            '\t\t"@cortexkit/opencode-magic-context@latest",\r\n' +
            "\t], // array comment\r\n" +
            '\t"compaction": {\r\n' +
            "\t\t// preserve nested comment\r\n" +
            '\t\t"auto": true,\r\n' +
            '\t\t"prune": true,\r\n' +
            "\t},\r\n" +
            '\t"theme": "dark",\r\n' +
            "}\r\n";
        const expected =
            "// leading comment\r\n" +
            "{\r\n" +
            '\t"plugin": [\r\n' +
            "\t\t// first plugin\r\n" +
            '\t\t"@keep/first",\r\n' +
            "\t\t// Magic Context stays\r\n" +
            '\t\t"@cortexkit/opencode-magic-context@latest",\r\n' +
            "\t], // array comment\r\n" +
            '\t"compaction": {\r\n' +
            "\t\t// preserve nested comment\r\n" +
            '\t\t"auto": false,\r\n' +
            '\t\t"prune": false,\r\n' +
            "\t},\r\n" +
            '\t"theme": "dark",\r\n' +
            "}\r\n";
        writeFileSync(configPath, original);

        addPluginToOpenCodeConfig(configPath, "jsonc", true);

        expect(readFileSync(configPath, "utf-8")).toBe(expected);
        expect(readFileSync(configPath, "utf-8")).not.toContain("removed DCP plugin");
    });
});
