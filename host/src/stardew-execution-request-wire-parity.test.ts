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
    const timer = setTimeout(() => child.kill(), 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolvePromise();
      else
        reject(
          new Error(
            `execution request parser test failed (code=${String(code)}, signal=${String(signal)}): ${Buffer.concat(chunks).toString("utf8")}`,
          ),
        );
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
