import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { planActionsFromRegistrations, planShape } from "./body-program-script.js";
import { type BridgeMessage, type Scope, validateBridgeMessage } from "./protocol.js";
import { parseStrictBridgeJson } from "./strict-bridge-json.js";

/**
 * The approach declaration has to survive the WHOLE pipeline, not one of its layers.
 *
 * Measured 2026-10-25: `enter_exit` refused with `door_out_of_range` six tiles from the door, and the companion
 * learned the precondition only by being refused. The Mod had declared it; the declaration stopped at the surface
 * artifact, because `FarmhandActionDescriptorWire` had no `Approach` member and the Host accepted no `approach` key.
 * Every action therefore answered `approach_requirement_undeclared`, for every action, forever - and no test could
 * see it, because the tests that pinned `plan_shape` hand-built a registration the Mod could not send.
 *
 * This test removes the hand-built registration: it runs the Mod's OWN `hello_ack` serializer, validates the frame
 * with the Host's strict wire contract, and asks `plan_shape` what it now knows. Two actions, one pipeline: the one
 * that declares `adjacent,1` must arrive declared, and the one that declares nothing must arrive undeclared.
 */

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};

const helloTest =
  "GameBuddy.Stardew.Integration.Tests.BridgeSessionPublicationTests.Hello_PublishesReadOnlyWorldMapOperationWithoutEnablingExecution";

/**
 * The Mod's own project needs a licensed game folder (its build package refuses without one), so this test is gated
 * exactly the way CI gates the whole integration suite rather than stubbing a game assembly: a fake game path is
 * evidence of nothing.
 */
const gamePath = process.env.GAMEBUDDY_STARDEW_GAME_PATH;
const gameRequired =
  gamePath === undefined || gamePath.length === 0 ? "GAMEBUDDY_STARDEW_GAME_PATH is not configured" : false;

function runHelloSerializer(outputPath: string): Promise<void> {
  const repoRoot = /[\\/]host$/i.test(process.cwd()) ? resolve(process.cwd(), "..") : resolve(process.cwd());
  const project = resolve(
    repoRoot,
    "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/GameBuddy.Stardew.Integration.Tests.csproj",
  );
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "dotnet",
      ["test", project, "--filter", `FullyQualifiedName=${helloTest}`, "--no-restore", `-p:GamePath=${gamePath}`],
      {
        cwd: repoRoot,
        env: { ...process.env, GAMEBUDDY_HELLO_WIRE_OUTPUT: outputPath },
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
    const timer = setTimeout(() => child.kill(), 300_000);
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
            `hello_ack serializer test failed (code=${String(code)}, signal=${String(signal)}): ${Buffer.concat(chunks).toString("utf8")}`,
          ),
        );
    });
  });
}

test(
  "the Mod's own hello_ack carries the approach declaration into plan_shape, and its absence stays an explicit answer",
  {
    timeout: 330_000,
    skip: gameRequired,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gamebuddy-approach-pipeline-"));
    const outputPath = join(root, "hello_ack.json");
    let testError: unknown;
    try {
      await runHelloSerializer(outputPath);
      const parsed = parseStrictBridgeJson(await readFile(outputPath, "utf8")) as BridgeMessage;
      assert.equal(parsed.type, "hello_ack");
      assert.equal(
        validateBridgeMessage(parsed, scope, Date.now()),
        null,
        "the frame the Mod serializes must satisfy the strict Host contract that now accepts `approach`",
      );
      if (parsed.type !== "hello_ack") return;
      const actions = planActionsFromRegistrations(parsed.payload.registrations);

      // The declaring half: `pickup_forage` enforces `observation_binding_target_out_of_range` beyond Chebyshev 1,
      // and says so before the companion is refused.
      const declaring = planShape(actions, { actionId: "pickup_forage" });
      assert.equal(declaring.ok, true);
      if (!declaring.ok) return;
      assert.deepEqual(declaring.actions[0]?.approachRequirement, {
        declared: true,
        relation: "adjacent",
        withinTiles: 1,
      });

      // The undeclared half, through the same pipeline: `move_to_tile` has no standing precondition, and the answer
      // names the silence rather than inventing "stand anywhere".
      const silent = planShape(actions, { actionId: "move_to_tile" });
      assert.equal(silent.ok, true);
      if (!silent.ok) return;
      assert.deepEqual(silent.actions[0]?.approachRequirement, {
        declared: false,
        reasonCode: "approach_requirement_undeclared",
      });
    } catch (error) {
      testError = error;
    }

    try {
      await rm(root, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
    } catch (cleanupError) {
      throw new AggregateError(
        testError === undefined ? [cleanupError] : [testError, cleanupError],
        "approach pipeline fixture cleanup failed",
      );
    }
    if (testError !== undefined) throw testError;
  },
);
