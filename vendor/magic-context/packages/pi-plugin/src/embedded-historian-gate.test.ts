import { describe, expect, it, mock } from "bun:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";

import {
    type EmbeddedHistorianGateScenario,
    runEmbeddedHistorianAuthoringGateInMemoryForTest,
} from "./embedded-historian-gate";

const outputs: Record<EmbeddedHistorianGateScenario, string> = {
    semantic: `<output>
<compartments><compartment start="1" end="2" title="Confirmed preference" episode_type="interaction" importance="40"><p1>The player explicitly confirmed a durable preference for future decisions.</p1></compartment></compartments>
<facts><SEMANTIC_MEMORY>
* The player explicitly confirmed a durable preference to be offered options before a consequential decision.
</SEMANTIC_MEMORY></facts>
<meta><messages_processed>1-2</messages_processed><unprocessed_from>3</unprocessed_from></meta>
</output>`,
    interaction: `<output>
<compartments><compartment start="1" end="2" title="Unresolved conversation" episode_type="interaction" importance="70"><p1>The player and assistant explicitly agreed to resume a named unresolved topic later.</p1></compartment></compartments>
<facts><INTERACTION_EPISODE>
* The player and assistant explicitly agreed to resume the named unresolved topic in a future interaction.
</INTERACTION_EPISODE></facts>
<meta><messages_processed>1-2</messages_processed><unprocessed_from>3</unprocessed_from></meta>
</output>`,
    "ordinary-process": `<output>
<compartments><compartment start="1" end="2" title="Completed game process" episode_type="interaction" importance="20"><p1>An ordinary game process completed and does not require future recall.</p1></compartment></compartments>
<meta><messages_processed>1-2</messages_processed><unprocessed_from>3</unprocessed_from></meta>
</output>`,
};

function runnerFor(scenario: EmbeddedHistorianGateScenario): SubagentRunner {
    return {
        harness: "pi-embedded-sdk",
        run: mock(async () => ({ ok: true, assistantText: outputs[scenario], durationMs: 1 })),
    } as unknown as SubagentRunner;
}

describe("embedded Historian authoring gate", () => {
    it("uses the shared admission lifecycle for both durable categories and rejects an ordinary process", async () => {
        for (const scenario of ["semantic", "interaction", "ordinary-process"] as const) {
            const directory = `/gamebuddy-test/${scenario}`;
            const result = await runEmbeddedHistorianAuthoringGateInMemoryForTest({
                registry: {} as ModelRegistry,
                directory,
                model: "test/model",
                timeoutMs: 1_000,
                scenario,
                testAutoPromote: true,
                runner: runnerFor(scenario),
            });

            expect(result.compartmentCount).toBeGreaterThan(0);
            expect(result).toMatchObject(
                scenario === "semantic"
                    ? { semanticMemoryCount: 1, interactionEpisodeCount: 0, testAutoPromote: true }
                    : scenario === "interaction"
                      ? {
                            semanticMemoryCount: 0,
                            interactionEpisodeCount: 1,
                            testAutoPromote: true,
                        }
                      : {
                            semanticMemoryCount: 0,
                            interactionEpisodeCount: 0,
                            testAutoPromote: true,
                        },
            );
        }
    });
});
