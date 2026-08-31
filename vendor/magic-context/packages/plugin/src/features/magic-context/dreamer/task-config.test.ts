import { describe, expect, it } from "bun:test";

import { buildDreamTaskRuntimeConfigs } from "./task-config";

describe("per-harness dream task runtime config", () => {
    it("applies the 20-minute default independently in each harness", () => {
        const dreamer = {
            tasks: {
                verify: { schedule: "0 3 * * *" },
                curate: { schedule: "0 4 * * *" },
            },
            opencode: {
                model: "anthropic/claude-sonnet",
                tasks: { verify: { timeout_minutes: 35 } },
            },
            pi: {
                model: "github-copilot/gpt-5",
                tasks: { curate: { timeout_minutes: 27 } },
            },
        };

        const opencode = buildDreamTaskRuntimeConfigs(dreamer, "opencode");
        const pi = buildDreamTaskRuntimeConfigs(dreamer, "pi");
        const timeout = (
            configs: ReturnType<typeof buildDreamTaskRuntimeConfigs>,
            task: "verify" | "curate",
        ) => configs.find((config) => config.task === task)?.timeoutMinutes;

        expect(timeout(opencode, "verify")).toBe(35);
        expect(timeout(pi, "verify")).toBe(20);
        expect(timeout(opencode, "curate")).toBe(20);
        expect(timeout(pi, "curate")).toBe(27);
    });
});
