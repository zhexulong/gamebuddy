import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  diagnoseBridgeMessage,
  validateBridgeMessage,
  type Scope,
} from "./protocol.js";
import { parseStrictBridgeJson } from "./strict-bridge-json.js";

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};
const serializerTest =
  "GameBuddy.Stardew.Core.Tests.BridgeProtocolSerializationTests.TrySerialize_SnapshotWireParityFixture_WritesHostWireParityFixtureWhenRequested";

function runSerializer(outputPath: string): Promise<void> {
  const repoRoot = /[\\/]host$/i.test(process.cwd()) ? resolve(process.cwd(), "..") : resolve(process.cwd());
  const project = resolve(
    repoRoot,
    "integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/GameBuddy.Stardew.Core.Tests.csproj",
  );
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "dotnet",
      ["test", project, "--filter", `FullyQualifiedName=${serializerTest}`, "--no-restore"],
      {
        cwd: repoRoot,
        env: { ...process.env, GAMEBUDDY_SNAPSHOT_WIRE_OUTPUT: outputPath },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
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
            `snapshot serializer test failed (code=${String(code)}, signal=${String(signal)}): ${Buffer.concat(chunks).toString("utf8")}`,
          ),
        );
    });
  });
}

test("real C# snapshot serializer output passes the strict Host wire contract", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-snapshot-wire-"));
  const outputPath = join(root, "snapshot.json");
  let testError: unknown;
  try {
    await assert.rejects(stat(outputPath), { code: "ENOENT" });
    await runSerializer(outputPath);
    const file = await readFile(outputPath);
    assert.ok(file.byteLength > 0 && file.byteLength <= 256 * 1024);
    const parsed = parseStrictBridgeJson(file.toString("utf8"));
    assert.equal(diagnoseBridgeMessage(parsed, scope, Date.now()), "accepted");
    assert.equal(validateBridgeMessage(parsed, scope, Date.now()), null);
  } catch (error) {
    testError = error;
  }

  try {
    await rm(root, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
    await assert.rejects(stat(root), { code: "ENOENT" });
  } catch (cleanupError) {
    throw new AggregateError(
      testError === undefined ? [cleanupError] : [testError, cleanupError],
      "snapshot wire parity cleanup failed",
    );
  }
  if (testError !== undefined) throw testError;
});
