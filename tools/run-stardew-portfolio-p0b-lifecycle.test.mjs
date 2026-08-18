import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { runPortfolioP0bLifecycle } from "./run-stardew-portfolio-p0b-lifecycle.mjs";

function makeInputs(root, overrides = {}) {
  const profileRoot = join(root, "profile");
  return {
    platform: "win32",
    gamePath: join(root, "game"),
    profileRoot,
    dataRoot: join(root, "data"),
    saveRoot: join(root, "saves"),
    releaseDir: join(root, "release"),
    backupName: "native-bootstrap",
    logicalSaveName: "GameBuddyPortfolioNative02",
    observedSaveSlot: "GameBuddyPortfolioNative02_445880081",
    startManifestPath: join(root, "evidence", "start-manifest.json"),
    signingKeyEnvironmentVariableName: "GAMEBUDDY_P0B_KEY",
    timeoutSeconds: 30,
    env: { GAMEBUDDY_P0B_KEY: "secret-never-logged" },
    ...overrides,
  };
}

async function prepareConfig(profileRoot, values) {
  await mkdir(join(profileRoot, "GameBuddy"), { recursive: true });
  await writeFile(
    join(profileRoot, "GameBuddy", "config.json"),
    JSON.stringify({
      Portfolio: {
        P0bLifecycleProducer: {
          Enable: true,
          LogicalSaveName: values.logicalSaveName,
          ObservedSaveSlot: values.observedSaveSlot,
          TimeoutSeconds: values.timeoutSeconds,
          StartManifestPath: values.startManifestPath,
          SigningKeyEnvironmentVariableName: values.signingKeyEnvironmentVariableName,
        },
      },
    }),
  );
}

function fakeProcess(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  return child;
}

async function prepareGameTarget(input) {
  await mkdir(input.gamePath, { recursive: true });
  await writeFile(join(input.gamePath, "StardewModdingAPI.exe"), "test-target");
}

const noStardewProcesses = async () => [];

test("P0b runner prepares once and launches exactly one SMAPI process with inherited key and exact mods path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-p0b-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = makeInputs(root);
  await prepareGameTarget(input);
  const calls = [];
  await mkdir(join(root, "evidence"), { recursive: true });
  let preparedCalls = 0;
  const result = await runPortfolioP0bLifecycle({
    ...input,
    processList: noStardewProcesses,
    prepare: async (prepared) => {
      preparedCalls += 1;
      assert.equal(prepared.signingKey, undefined);
      await prepareConfig(input.profileRoot, input);
      return { state: "p0b_lifecycle_producer_prepared" };
    },
    spawnProcess: (executable, args, spawnOptions) => {
      calls.push({ executable, args, spawnOptions });
      const child = fakeProcess(7123);
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
    wait: () => new Promise((resolve) => setTimeout(resolve, 20)),
    timeoutMs: 100,
  });
  assert.equal(preparedCalls, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, join(input.gamePath, "StardewModdingAPI.exe"));
  assert.deepEqual(calls[0].args, ["--mods-path", input.profileRoot]);
  assert.equal(calls[0].spawnOptions.shell, false);
  assert.equal(calls[0].spawnOptions.env.GAMEBUDDY_P0B_KEY, input.env.GAMEBUDDY_P0B_KEY);
  assert.equal(result.state, "completed");
  assert.equal(result.transaction, "retained");
});

test("P0b runner fails preflight without spawning when the process-local key is missing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-p0b-runner-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = makeInputs(root, { env: {} });
  await prepareGameTarget(input);
  let spawnCount = 0;
  await assert.rejects(
    () =>
      runPortfolioP0bLifecycle({
        ...input,
        processList: noStardewProcesses,
        prepare: async () => assert.fail("prepare must not run"),
        spawnProcess: () => {
          spawnCount += 1;
        },
      }),
    /portfolio_p0b_signing_key_environment_value_missing/,
  );
  assert.equal(spawnCount, 0);
});

test("P0b runner blocks a pre-existing Stardew process before prepare and spawn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-p0b-runner-process-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = makeInputs(root);
  const events = [];
  let spawnCount = 0;
  await assert.rejects(
    () =>
      runPortfolioP0bLifecycle({
        ...input,
        processList: async (names) => {
          events.push(["process-list", names]);
          return ["StardewModdingAPI.exe"];
        },
        prepare: async () => {
          events.push(["prepare"]);
          assert.fail("prepare must not run");
        },
        spawnProcess: () => {
          spawnCount += 1;
        },
      }),
    /portfolio_p0b_stardew_process_running:StardewModdingAPI\.exe/,
  );
  assert.deepEqual(events, [["process-list", ["StardewModdingAPI.exe", "Stardew Valley.exe"]]]);
  assert.equal(spawnCount, 0);
});

test("P0b runner blocks a process-query error before prepare and spawn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-p0b-runner-process-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = makeInputs(root);
  let prepareCount = 0;
  let spawnCount = 0;
  await assert.rejects(
    () =>
      runPortfolioP0bLifecycle({
        ...input,
        processList: async () => {
          throw new Error("tasklist unavailable");
        },
        prepare: async () => {
          prepareCount += 1;
        },
        spawnProcess: () => {
          spawnCount += 1;
        },
      }),
    /portfolio_p0b_process_query_failed/,
  );
  assert.equal(prepareCount, 0);
  assert.equal(spawnCount, 0);
});

test("P0b runner kills the complete child tree on timeout and retains transaction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-p0b-runner-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = makeInputs(root);
  await prepareGameTarget(input);
  await mkdir(join(root, "evidence"), { recursive: true });
  await prepareConfig(input.profileRoot, input);
  const calls = [];
  const processChecks = [];
  await assert.rejects(
    () =>
      runPortfolioP0bLifecycle({
        ...input,
        processList: noStardewProcesses,
        prepare: async () => ({ state: "p0b_lifecycle_producer_prepared" }),
        spawnProcess: (executable, args, spawnOptions) => {
          calls.push({ executable, args, spawnOptions });
          const child = fakeProcess(calls.length === 1 ? 8123 : 8124);
          if (executable === "taskkill") queueMicrotask(() => child.emit("close", 0, null));
          return child;
        },
        wait: () => Promise.resolve(),
        processExists: async (pid) => {
          processChecks.push(pid);
          return false;
        },
        timeoutMs: 1,
      }),
    /portfolio_p0b_launch_timeout/,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].executable, "taskkill");
  assert.deepEqual(calls[1].args, ["/PID", "8123", "/T", "/F"]);
  assert.equal(calls[1].spawnOptions.shell, false);
  assert.deepEqual(processChecks, [8123]);
});
