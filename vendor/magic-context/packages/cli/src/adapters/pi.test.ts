import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAdapter } from "./pi";

const originalPiDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

afterEach(() => {
    if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiDir;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PiAdapter settings safety", () => {
    it("aborts plugin updates when existing settings are malformed", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-pi-adapter-"));
        tempDirs.push(root);
        process.env.PI_CODING_AGENT_DIR = root;
        const settingsPath = join(root, "settings.json");
        const malformed = `{"packages":[\n`;
        writeFileSync(settingsPath, malformed);

        const result = await new PiAdapter().ensurePluginEntry();

        expect(result.ok).toBe(false);
        expect(result.message).toContain("Refusing to overwrite unparseable config");
        expect(readFileSync(settingsPath, "utf-8")).toBe(malformed);
    });
});
