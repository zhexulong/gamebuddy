import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";

import { assertNoWindowsReparse, inspectWindowsReparse } from "./index.js";
import { createTestWindowsReparseInspector } from "./index.test-support.js";

type Outcome = "regular" | "reparse" | "malformed" | "unavailable" | "timeout" | "nonzero" | "stderr" | "overflow";

for (const outcome of ["regular", "reparse", "malformed", "unavailable", "timeout", "nonzero", "stderr", "overflow"] as const) {
  test(`inspectWindowsReparse ${outcome} child behavior`, async () => {
    const capability = createTestWindowsReparseInspector(() => syntheticChild(outcome));
    const inspected = inspectWindowsReparse(capability, "/absolute/test-path");
    if (outcome === "regular" || outcome === "reparse") assert.equal(await inspected, outcome);
    else await assert.rejects(inspected, /windows_reparse_inspection_unavailable/);
  });
}

test("assertNoWindowsReparse rejects an exact reparse result", async () => {
  const capability = createTestWindowsReparseInspector(() => syntheticChild("reparse"));
  await assert.rejects(assertNoWindowsReparse(capability, "/absolute/test-path"), /windows_reparse_inspection_unavailable/);
});

test("inspectWindowsReparse rejects invalid capabilities and relative paths", async () => {
  await assert.rejects(inspectWindowsReparse(undefined, "/absolute/test-path"), /windows_reparse_inspection_unavailable/);
  const capability = createTestWindowsReparseInspector(() => syntheticChild("regular"));
  await assert.rejects(inspectWindowsReparse(capability, "relative/test-path"), /windows_reparse_inspection_unavailable/);
});

test("public policy entry does not expose test-only capability minting", async () => {
  const source = await readFile(resolve(fileURLToPath(new URL("../..", import.meta.url)), "src", "windows-reparse-inspector", "index.ts"), "utf8");
  assert.doesNotMatch(source, /__testOnly|test-support/);
});

function syntheticChild(outcome: Outcome): ChildProcess {
  if (outcome === "unavailable") throw new Error("spawn unavailable");
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => {
      if (outcome === "timeout") queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    },
  });
  child.stdin.on("data", () => {
    if (outcome === "timeout") return;
    if (outcome === "overflow") child.stdout.end(Buffer.alloc(64 * 1024 + 1));
    else if (outcome === "malformed") child.stdout.end('{"schemaVersion":1,"result":"other"}\n');
    else child.stdout.end(`{"schemaVersion":1,"result":"${outcome}"}\n`);
    if (outcome === "stderr") child.stderr.end("unexpected");
    else child.stderr.end();
    queueMicrotask(() => child.emit("close", outcome === "nonzero" ? 1 : 0, null));
  });
  return child as unknown as ChildProcess;
}
