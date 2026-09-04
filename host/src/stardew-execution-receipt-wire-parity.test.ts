import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { diagnoseBridgeMessage, validateBridgeMessage, type Scope } from "./protocol.js";
import { parseStrictBridgeJson } from "./strict-bridge-json.js";

const hostRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};
const projectPath = resolve(
  hostRoot,
  "../integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/GameBuddy.Stardew.Integration.Tests.csproj",
);

test("source-built Stardew execution receipt passes the Host strict validator", { timeout: 150_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "gamebuddy-execution-receipt-wire-"));
  const outputPath = join(root, "execution-receipt.json");
  try {
    try {
      execFileSync(
        "dotnet",
        [
          "test",
          projectPath,
          "--no-restore",
          "--filter",
          "FullyQualifiedName=GameBuddy.Stardew.Integration.Tests.FarmhandTypedReceiptContractTests.RegisteredMachineInspect_ProducesExactWorldNotReadyReceipt",
          "--verbosity",
          "minimal",
        ],
        {
          cwd: resolve(hostRoot, ".."),
          env: { ...process.env, GAMEBUDDY_EXECUTION_RECEIPT_WIRE_OUTPUT: outputPath },
          stdio: "pipe",
        },
      );
    } catch (error) {
      const commandError = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number | null };
      const redact = (value: Buffer | string | undefined) =>
        String(value ?? "")
          .replace(/[A-Za-z]:[\\/][^\\r\\n]*/g, "<path>")
          .slice(-4_096);
      throw new Error(
        `stardew_receipt_parity_dotnet_failed:${commandError.status ?? "unknown"}:stdout=${redact(commandError.stdout)}:stderr=${redact(commandError.stderr)}`,
        { cause: error },
      );
    }

    const raw = readFileSync(outputPath, "utf8");
    assert.ok(Buffer.byteLength(raw, "utf8") <= 16_384);
    const parsed = parseStrictBridgeJson(raw);
    assert.equal(diagnoseBridgeMessage(parsed, scope, Date.now()), null);
    assert.equal(validateBridgeMessage(parsed, scope, Date.now()), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
