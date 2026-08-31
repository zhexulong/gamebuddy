import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseStrictBridgeJson } from "./strict-bridge-json.js";
import {
  validateBridgeMessage,
  type BridgeMessage,
  type Scope,
} from "./protocol.js";

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_1",
  worldId: "world_1",
  playerId: "player_1",
  companionId: "companion_1",
};
const serializerTest =
  "GameBuddy.Stardew.Core.Tests.BridgeProtocolSerializationTests.TrySerialize_NavigationResolvedEnvelope_WritesHostWireParityFixtureWhenRequested";

function runSerializer(outputPath: string): Promise<void> {
  const repoRoot = /[\\/]host$/i.test(process.cwd())
    ? resolve(process.cwd(), "..")
    : resolve(process.cwd());
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
        env: { ...process.env, GAMEBUDDY_NAVIGATION_WIRE_OUTPUT: outputPath },
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
            `navigation serializer test failed (code=${String(code)}, signal=${String(signal)}): ${Buffer.concat(chunks).toString("utf8")}`,
          ),
        );
    });
  });
}

test("real C# navigation serializer output passes the strict Host wire contract", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-navigation-wire-"));
  const outputPath = join(root, "navigation-read-result.json");
  let testError: unknown;
  try {
    await assert.rejects(stat(outputPath), { code: "ENOENT" });
    const startedAt = Date.now();
    await runSerializer(outputPath);
    const file = await readFile(outputPath);
    assert.ok(file.byteLength > 0 && file.byteLength <= 64 * 1024);
    const json = file.toString("utf8");
    const parsed = parseStrictBridgeJson(json);
    assert.equal(validateBridgeMessage(parsed, scope, Date.now()), null);
    const message = parsed as BridgeMessage;
    assert.equal(message.type, "navigation_read_result");
    assert.ok(message.timestampMs >= startedAt - 5_000);
    assert.ok(message.timestampMs <= Date.now() + 5_000);
    assert.equal(message.type, "navigation_read_result");
    assert.deepEqual(Object.keys(message.payload).sort(), [
      "candidates",
      "destination",
      "entries",
      "nextCursor",
      "reason",
      "status",
      "unlockState",
    ]);
    assert.deepEqual(message.payload, {
      status: "resolved",
      reason: "exact_current_locale",
      entries: null,
      nextCursor: null,
      candidates: null,
      destination: { kind: "label", label: "Farm", ref: null },
      unlockState: "unknown",
    });
    for (const forbidden of ["score", "query", "execution", "receipt", "evidence"])
      assert.equal(forbidden in message.payload, false);
  } catch (error) {
    testError = error;
  }

  try {
    await rm(root, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
    await assert.rejects(stat(root), { code: "ENOENT" });
  } catch (cleanupError) {
    throw new AggregateError(
      testError === undefined ? [cleanupError] : [testError, cleanupError],
      "navigation wire parity cleanup failed",
    );
  }
  if (testError !== undefined) throw testError;
});
