import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { newEnvelope, serializeBounded, type Scope } from "./protocol.js";

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_1",
  worldId: "world_1",
  playerId: "player_1",
  companionId: "companion_1",
};
const parserTest =
  "GameBuddy.Stardew.Core.Tests.BridgeProtocolSerializationTests.TryDeserializeExecutionRequest_HostSerializedNavigationRequest_IsAccepted";
/**
 * The signature of a build that lost a race for the shared C# project: four
 * compiled Host test files run `dotnet test` against the same
 * `GameBuddy.Stardew.Core.Tests` project, so a build that finds `obj/` held by a
 * sibling fails with an MSBuild/C# file-in-use error instead of a parse verdict.
 */
const sharedProjectName = "GameBuddy.Stardew.Core.Tests";
const sharedBuildContention = /being used by another process|MSB3491|CS2012/;
const parserBudgetMs = 120_000;
/**
 * `close` fires only once stdout and stderr end. A shared-build descendant
 * (testhost or a reused MSBuild node) can inherit those pipes and outlive the
 * `dotnet` process, so waiting on `close` alone can neither resolve nor reject
 * and the compiled file never exits. Five seconds is far above the normal
 * millisecond gap between `exit` and `close`.
 */
const stdioDrainMs = 5_000;

function runParser(inputPath: string): Promise<void> {
  const repoRoot = /[\\/]host$/i.test(process.cwd()) ? resolve(process.cwd(), "..") : resolve(process.cwd());
  const project = resolve(
    repoRoot,
    "integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/GameBuddy.Stardew.Core.Tests.csproj",
  );
  return new Promise((resolvePromise, reject) => {
    const child = spawn("dotnet", ["test", project, "--filter", `FullyQualifiedName=${parserTest}`, "--no-restore"], {
      cwd: repoRoot,
      env: { ...process.env, GAMEBUDDY_EXECUTION_REQUEST_WIRE_INPUT: inputPath },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const collect = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size <= 256 * 1024) chunks.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const failure = (detail: string, code: number | null, signal: NodeJS.Signals | null) => {
      const output = Buffer.concat(chunks).toString("utf8");
      const cause = sharedBuildContention.test(output)
        ? `shared project ${sharedProjectName} build was contended by a concurrent wire-parity test`
        : "parser test failed";
      return new Error(
        `execution request wire parity ${cause} (code=${String(code)}, signal=${String(signal)})${detail}: ${output}`,
      );
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (drain !== undefined) clearTimeout(drain);
      // Release inherited pipe handles: without this a killed `dotnet` whose
      // shared-build descendants still hold our stdio leaves `close` pending
      // forever, and this file then hangs the suite instead of failing.
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (error === undefined) resolvePromise();
      else reject(error);
    };
    timer = setTimeout(() => {
      child.kill();
      settle(
        new Error(
          `execution request wire parity parser test exceeded ${parserBudgetMs}ms and was killed; it waits on the shared project ${sharedProjectName} build`,
        ),
      );
    }, parserBudgetMs);
    child.once("error", (error) => settle(error));
    child.once("exit", (code, signal) => {
      drain = setTimeout(
        () => settle(failure(" (stdio stayed open after exit; a shared-build descendant held the pipe)", code, signal)),
        stdioDrainMs,
      );
    });
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) settle();
      else settle(failure("", code, signal));
    });
  });
}

test("real Host execution request serializer output passes the strict C# wire contract", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-execution-request-wire-"));
  const inputPath = join(root, "execution-request.json");
  let testError: unknown;
  try {
    await assert.rejects(stat(inputPath), { code: "ENOENT" });
    const request = newEnvelope(
      "execution_request",
      scope,
      {
        requestId: "req_host_navigation_request",
        idempotencyKey: "idemp_host_navigation_request",
        action: "navigate_to_destination",
        args: { destination: { kind: "label", label: "Farm" } },
        expectedRevision: 1,
        deadlineMs: Date.now() + 30_000,
      },
      "corr_host_navigation_request",
    );
    const json = serializeBounded(request);
    assert.ok(Buffer.byteLength(json, "utf8") > 0 && Buffer.byteLength(json, "utf8") <= 256 * 1024);
    await writeFile(inputPath, json, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await runParser(inputPath);
  } catch (error) {
    testError = error;
  }

  try {
    await rm(root, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
    await assert.rejects(stat(root), { code: "ENOENT" });
  } catch (cleanupError) {
    throw new AggregateError(
      testError === undefined ? [cleanupError] : [testError, cleanupError],
      "execution request wire parity cleanup failed",
    );
  }
  if (testError !== undefined) throw testError;
});
