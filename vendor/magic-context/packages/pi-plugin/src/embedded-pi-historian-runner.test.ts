import { describe, expect, it, mock } from "bun:test";

import { EmbeddedPiHistorianRunner } from "./embedded-pi-historian-runner";

function registryFixture() {
  return {
    registry: {
      find: () => ({ id: "historian-model" }),
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-only", headers: { "x-test": "1" } }),
    },
  };
}

describe("EmbeddedPiHistorianRunner", () => {
  it("calls the embedded Pi AI stream with no tools and returns final text", async () => {
    const streamSpy = mock((_: unknown, context: { tools: unknown[] }, __: Record<string, unknown>) => {
      expect(context.tools).toEqual([]);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", message: { stopReason: "stop", content: [{ type: "text", text: "<compartment>safe</compartment>" }] } };
        },
      };
    });
    {
      const fixture = registryFixture();
      const runner = new EmbeddedPiHistorianRunner(streamSpy as never);
      runner.bindModelRegistry(fixture.registry as never);
      const result = await runner.run({
        agent: "historian",
        model: "cpa-oai/deepseek-v4-flash",
        systemPrompt: "historian system",
        userMessage: "history input",
        thinkingLevel: "high",
        timeoutMs: 1000,
      });
      expect(result).toMatchObject({ ok: true, assistantText: "<compartment>safe</compartment>", toolCallCount: 0 });
      expect(streamSpy).toHaveBeenCalledTimes(1);
    }
  });

  it("fails locally for an unavailable embedded model and has no CLI spawn path", async () => {
    const fixture = registryFixture();
    const runner = new EmbeddedPiHistorianRunner();
    runner.bindModelRegistry(fixture.registry as never);

    const result = await runner.run({
      agent: "historian",
      model: "cpa-oai/not-configured",
      systemPrompt: "historian system",
      userMessage: "history input",
      thinkingLevel: "high",
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({ ok: false, reason: "model_failed" });
    // The runner obtains a configured model only from the embedded registry;
    // no child-process/CLI seam exists on this implementation.
  });

  it("fails closed when no embedded registry has been bound", async () => {
    const result = await new EmbeddedPiHistorianRunner().run({
      agent: "historian",
      model: "cpa-oai/deepseek-v4-flash",
      systemPrompt: "system",
      userMessage: "input",
    });
    expect(result).toMatchObject({ ok: false, reason: "spawn_failed" });
  });

  it("aborts a hanging embedded stream at its bounded timeout without an external process", async () => {
    const streamSpy = mock(() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        yield { type: "done", message: { stopReason: "stop", content: [{ type: "text", text: "late" }] } };
      },
    }));
    const fixture = registryFixture();
    const runner = new EmbeddedPiHistorianRunner(streamSpy as never);
    runner.bindModelRegistry(fixture.registry as never);
    const result = await runner.run({
      agent: "historian",
      model: "cpa-oai/deepseek-v4-flash",
      systemPrompt: "system",
      userMessage: "input",
      timeoutMs: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });
});
