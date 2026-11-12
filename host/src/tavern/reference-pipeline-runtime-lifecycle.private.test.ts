import assert from "node:assert/strict";
import test from "node:test";

import { closeReferencePipelineRuntime } from "./reference-pipeline-runtime-lifecycle.js";

function drain(recorder: string[], name: string, failure?: Error) {
  return Object.freeze({
    async close(): Promise<void> {
      recorder.push(name);
      if (failure !== undefined) throw failure;
    },
  });
}

test("failed reference listener drain retains the mounted lease for controlled retry", async () => {
  const calls: string[] = [];
  const failure = new Error("listener_drain_failed");
  await assert.rejects(
    closeReferencePipelineRuntime({
      server: drain(calls, "server", failure),
      pipelineService: drain(calls, "service"),
      lease: drain(calls, "lease"),
      facade: drain(calls, "facade"),
    }),
    failure,
  );
  assert.deepEqual(calls, ["server"]);
});

test("failed pre-listener service drain retains the mounted lease for controlled retry", async () => {
  const calls: string[] = [];
  const failure = new Error("service_drain_failed");
  await assert.rejects(
    closeReferencePipelineRuntime({
      pipelineService: drain(calls, "service", failure),
      lease: drain(calls, "lease"),
      facade: drain(calls, "facade"),
    }),
    failure,
  );
  assert.deepEqual(calls, ["service"]);
});

test("successful reference drain closes listener/service before lease then facade", async () => {
  const calls: string[] = [];
  await closeReferencePipelineRuntime({
    server: drain(calls, "server"),
    pipelineService: drain(calls, "service"),
    lease: drain(calls, "lease"),
    facade: drain(calls, "facade"),
  });
  assert.deepEqual(calls, ["server", "lease", "facade"]);
});
