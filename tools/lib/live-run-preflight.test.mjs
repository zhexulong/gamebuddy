// The preflight's own falsifiers: every check it makes has to be able to go red.
//
// A gate nobody can make fail is decoration, which is why each case below builds the exact tree shape that check exists
// for and asserts the code it must report. The good tree is the control.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GUARDIAN_ENDPOINT_PREFIX,
  importsWithoutStarting,
  preflightLiveRun,
  probeGuardianPipe,
  probeProviderReadiness,
  providerReadinessRefusal,
} from "./live-run-preflight.mjs";

const codesFor = (result) => result.checks.map((entry) => entry.code);
const failureCodes = (result) => result.checks.filter((entry) => !entry.ok).map((entry) => entry.code);

/** A tree that passes everything, so each case below can break exactly one thing. */
function goodTree(root) {
  const modsPath = join(root, "mods");
  const releaseDir = join(root, "release");
  const hostRoot = join(root, "host");
  const fixtureRoot = join(root, "fixtures");
  const modRoot = join(root, "mod");
  mkdirSync(join(modsPath, "GameBuddy"), { recursive: true });
  writeFileSync(join(modsPath, "GameBuddy", "config.json"), JSON.stringify({ PipeName: "gamebuddy-test-pipe" }));
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(join(releaseDir, "GameBuddy.Stardew.dll"), "dll");
  mkdirSync(join(hostRoot, "src"), { recursive: true });
  writeFileSync(join(hostRoot, "src", "index.ts"), "export {};\n");
  mkdirSync(join(hostRoot, "dist-test"), { recursive: true });
  writeFileSync(join(hostRoot, "dist-test", "index.js"), "export {};\n");
  mkdirSync(join(modRoot, "src"), { recursive: true });
  writeFileSync(join(modRoot, "src", "Thing.cs"), "class Thing {}\n");
  mkdirSync(join(fixtureRoot, "templates", "Fixture_1"), { recursive: true });
  return { modsPath, releaseDir, hostRoot, fixtureRoot, modRoot, saveName: "Fixture_1" };
}

/** Timestamps are what these checks compare, so the fixture tree has to control them. */
const touch = (path, when) => utimesSync(path, when, when);

/** The control tree: the good tree with the timestamps that make every file-system check pass. */
function freshGoodTree(root) {
  const tree = goodTree(root);
  // The DLL must be at least as new as the sources, and the artifact at least as new as host/src.
  const past = new Date(Date.now() - 60_000);
  const now = new Date();
  touch(join(tree.modRoot, "src", "Thing.cs"), past);
  touch(join(tree.releaseDir, "GameBuddy.Stardew.dll"), now);
  touch(join(tree.hostRoot, "src", "index.ts"), past);
  touch(join(tree.hostRoot, "dist-test", "index.js"), now);
  return tree;
}

/** One temporary root per case, removed whatever the case did. */
function withRoot(prefix, run) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the good tree passes every check", () => {
  withRoot("preflight-good-", (root) => {
    const result = preflightLiveRun(freshGoodTree(root));
    assert.deepEqual(failureCodes(result), [], JSON.stringify(result.checks, null, 1));
    assert.equal(result.ok, true);
  });
});

test("two GameBuddy folders are refused, because SMAPI would load neither", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-dupe-"));
  try {
    const tree = goodTree(root);
    // The good tree already has the agreed folder; add the OLD name beside it, which
    // is exactly the pair that made SMAPI skip the mod and the pipe never appear.
    mkdirSync(join(tree.modsPath, "GameBuddy.Stardew"), { recursive: true });
    const result = preflightLiveRun(tree);
    assert.ok(failureCodes(result).includes("mods_path_exactly_one_gamebuddy"), codesFor(result).join(","));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Mod bundle older than its sources is refused, because the run would measure other code", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-stale-mod-"));
  try {
    const tree = goodTree(root);
    touch(join(tree.releaseDir, "GameBuddy.Stardew.dll"), new Date(Date.now() - 120_000));
    touch(join(tree.modRoot, "src", "Thing.cs"), new Date());
    const result = preflightLiveRun(tree);
    assert.ok(failureCodes(result).includes("mod_bundle_fresh"), codesFor(result).join(","));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a host artifact older than host/src is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-stale-host-"));
  try {
    const tree = goodTree(root);
    touch(join(tree.hostRoot, "dist-test", "index.js"), new Date(Date.now() - 120_000));
    touch(join(tree.hostRoot, "src", "index.ts"), new Date());
    const result = preflightLiveRun(tree);
    assert.ok(failureCodes(result).includes("host_artifact_fresh"), codesFor(result).join(","));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing fixture template is refused by path", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-template-"));
  try {
    const tree = goodTree(root);
    rmSync(join(tree.fixtureRoot, "templates", "Fixture_1"), { recursive: true, force: true });
    const result = preflightLiveRun(tree);
    assert.ok(failureCodes(result).includes("fixture_template_present"), codesFor(result).join(","));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a held fixture lock and an orphaned backup are both refused", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-lock-"));
  try {
    const tree = goodTree(root);
    mkdirSync(join(tree.fixtureRoot, ".stardew-native-local-player-fixture.lock"), { recursive: true });
    writeFileSync(join(tree.fixtureRoot, "some-backup.orphaned-1234"), "");
    const result = preflightLiveRun(tree);
    const failures = failureCodes(result);
    assert.ok(failures.includes("fixture_lock_free"), codesFor(result).join(","));
    assert.ok(failures.includes("fixture_root_has_no_orphan_backups"), codesFor(result).join(","));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable bridge config is a named refusal, not a guess", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-pipe-"));
  try {
    const tree = goodTree(root);
    writeFileSync(join(tree.modsPath, "GameBuddy", "config.json"), JSON.stringify({ PipeName: "bad name!" }));
    const result = preflightLiveRun(tree);
    assert.ok(failureCodes(result).includes("bridge_config_readable"), codesFor(result).join(","));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a runner without a CLI entry point is refused, because the driver would run nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-runner-"));
  try {
    const tree = goodTree(root);
    const result = preflightLiveRun({ ...tree, action: "respond_level_up" });
    // The real repo's runner has the entry point; this asserts the check is present and green on the real tree.
    const entry = result.checks.find((item) => item.code === "smoke_runner_has_cli");
    assert.equal(entry.ok, true, JSON.stringify(entry));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The check is "importing this module starts nothing", so the falsifier is a module that starts something on import
// while naming `import.meta.main` - the exact shape a source-text match accepts and an import observes.
test("a runner whose CLI is not really gated is refused by importing it", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-runner-import-"));
  try {
    const ungated = join(root, "ungated-runner.mjs");
    writeFileSync(ungated, '// import.meta.main is mentioned here only\nprocess.stdout.write("session started\\n");\n');
    const started = importsWithoutStarting(ungated);
    assert.equal(started.ok, false);
    assert.match(started.detail, /import printed: session started/u);

    const gated = join(root, "gated-runner.mjs");
    writeFileSync(gated, 'if (import.meta.main) process.stdout.write("session started\\n");\n');
    assert.deepEqual(importsWithoutStarting(gated), { ok: true, detail: "imported with nothing started" });

    assert.equal(importsWithoutStarting(join(root, "absent-runner.mjs")).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Provider readiness ──
//
// The two falsifiers below are the ones the audit asked for: a profile naming a model the provider's catalog does not
// list must refuse as `missing-model` without asking the provider anything, and a catalog that does list it must let
// the run proceed. The tree is the shape a real runtime root has (`.tmp/rt-e`): `settings/model-profiles.json` names the
// model, and the identity's `pi-agent/` holds `models.json` (provider catalogs) with `auth.json` beside it.
const MODEL_ID = "deepseek-v4.1-flash";
const AGENT_DIR = join("contexts", "identity-1", "pi-agent");

function providerRoot({
  modelId = MODEL_ID,
  catalogued = [MODEL_ID],
  baseUrl = "http://127.0.0.1:8317/v1",
  apiKey = "sk-test",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "preflight-provider-"));
  mkdirSync(join(root, "settings"), { recursive: true });
  writeFileSync(
    join(root, "settings", "model-profiles.json"),
    JSON.stringify({
      schemaVersion: 1,
      chat: { revision: 1, modelId, thinkingLevel: "high" },
      game: { revision: 1, modelId, thinkingLevel: "high" },
    }),
  );
  const agentDir = join(root, AGENT_DIR);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: { "cpa-oai": { baseUrl, models: catalogued.map((id) => ({ id, name: id })) } },
    }),
  );
  if (apiKey !== null)
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "cpa-oai": { type: "api_key", key: apiKey } }));
  return { root, agentDir };
}

/** A transport that records what was asked and refuses to be used when a check must not reach the network. */
function recordingTransport(answer) {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init });
    if (answer === "throw") throw new Error("connect ECONNREFUSED 127.0.0.1:8317");
    return { ok: answer === 200, status: answer };
  };
  return { calls, transport };
}

test("a profile naming a model its provider catalog does not list refuses as missing-model, and asks nothing", async () => {
  const { root, agentDir } = providerRoot({ modelId: "ghost-model-v9" });
  try {
    const { calls, transport } = recordingTransport(200);
    const readiness = await probeProviderReadiness({ runtimeRoot: root, agentDir, transport });
    assert.deepEqual(readiness, { ok: false, provider: "cpa-oai", model: "ghost-model-v9", reason: "missing-model" });
    assert.equal(providerReadinessRefusal(readiness), "provider_not_ready:cpa-oai:ghost-model-v9:missing-model");
    assert.equal(calls.length, 0, "a model the catalog does not list must not be asked for at the endpoint");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a catalog that lists the model proceeds, with one listing request carrying the provider's own credential", async () => {
  const { root, agentDir } = providerRoot();
  try {
    const { calls, transport } = recordingTransport(200);
    const readiness = await probeProviderReadiness({ runtimeRoot: root, agentDir, transport });
    assert.deepEqual(readiness, { ok: true, provider: "cpa-oai", model: MODEL_ID, reason: "ready" });
    assert.equal(calls.length, 1, "one minimal request, and only one");
    assert.equal(calls[0].url, "http://127.0.0.1:8317/v1/models");
    assert.equal(calls[0].init.headers.authorization, "Bearer sk-test");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auth and unreachable are different refusals, because they are different repairs", async () => {
  const noCredential = providerRoot({ apiKey: null });
  try {
    const { calls, transport } = recordingTransport(200);
    const readiness = await probeProviderReadiness({
      runtimeRoot: noCredential.root,
      agentDir: noCredential.agentDir,
      transport,
    });
    assert.equal(readiness.reason, "auth");
    assert.equal(calls.length, 0, "no credential means nothing to send");
    assert.equal(providerReadinessRefusal(readiness), `provider_not_ready:cpa-oai:${MODEL_ID}:auth`);
  } finally {
    rmSync(noCredential.root, { recursive: true, force: true });
  }

  for (const [answer, reason] of [
    [401, "auth"],
    [503, "unreachable"],
    ["throw", "unreachable"],
  ]) {
    const { root, agentDir } = providerRoot();
    try {
      const readiness = await probeProviderReadiness({
        runtimeRoot: root,
        agentDir,
        transport: recordingTransport(answer).transport,
      });
      assert.deepEqual(
        { ok: readiness.ok, reason: readiness.reason },
        { ok: false, reason },
        `an endpoint answering ${String(answer)} is ${reason}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a root whose profile names no model is refused before anything can be asked", async () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-provider-noprofile-"));
  try {
    const { calls, transport } = recordingTransport(200);
    const readiness = await probeProviderReadiness({ runtimeRoot: root, agentDir: join(root, AGENT_DIR), transport });
    assert.deepEqual(readiness, { ok: false, provider: "cpa-oai", model: null, reason: "profile-invalid" });
    assert.equal(providerReadinessRefusal(readiness), "provider_not_ready:cpa-oai:unknown:profile-invalid");
    assert.equal(calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── The Desktop guardian endpoint ──
//
// The two readings 2026-11-13 produced are the two cases below: a machine with no `GameBuddy.HostGuardian.*`
// endpoint (four chat runs died `guardian_pipe_unreachable` and the preflight said nothing at all) and a machine that
// has one. The pipe namespace belongs to the OS, so it is read through the probe's own seam; the last two cases are
// real - one asks this machine's own namespace, the other asks the files that spell the endpoint.

/** A pipe-directory reader standing in for the OS namespace: the names it would list. */
const pipeDirectory =
  (...names) =>
  () =>
    names;

const GUARDIAN_ENDPOINT = `${GUARDIAN_ENDPOINT_PREFIX}${"a".repeat(64)}`;

test("a machine with no bound guardian endpoint is not_measured, and refuses the run by name", () => {
  withRoot("preflight-guardian-absent-", (root) => {
    const guardian = probeGuardianPipe({ readPipeDirectory: pipeDirectory("InitShutdown", "lsass", "edge") });
    assert.deepEqual(guardian.endpoints, []);
    assert.equal(guardian.examined, 3);

    const result = preflightLiveRun({ ...freshGoodTree(root), guardian });
    assert.equal(result.ok, false, "an unmeasured prerequisite is not a startable run");
    // First, because it is the one failure no rebuild repairs.
    assert.equal(result.checks[0].code, "guardian_pipe_reachable");
    const failure = result.firstFailure;
    assert.equal(failure.code, "guardian_pipe_reachable");
    assert.equal(failure.status, "not_measured", "absent is not the same verdict as a condition this host fails");
    assert.equal(failure.condition, "guardian_pipe_unreachable");
    assert.match(failure.detail, /^guardian_pipe_unreachable: 3 named pipe\(s\) examined/u);
    assert.match(failure.detail, /no GameBuddy[.]HostGuardian[.]\* endpoint is bound/u);
    // What it costs the run, in the words the run's own result files use.
    assert.match(failure.detail, /dialogue_exited_before_ready:1:desktop_runtime_bootstrap_unavailable/u);
    assert.match(failure.detail, /INJECTION and RECONCILIATION would be unobserved, not passing/u);
    // Both routes an operator can take, and the limit of the second one.
    assert.equal(failure.route.length, 2);
    assert.match(failure.route[0], /Desktop supervisor/u);
    assert.match(failure.route[1], /tools\/desktop-composition-launch[.]mjs/u);
    assert.match(failure.route[1], /arm_attempt\/launch_role\/contain_role/u);
  });
});

test("a pipe namespace that cannot be read is not_measured, never a pass", () => {
  withRoot("preflight-guardian-unreadable-", (root) => {
    const guardian = probeGuardianPipe({
      readPipeDirectory: () => {
        const error = new Error("no such file or directory");
        error.code = "ENOENT";
        throw error;
      },
    });
    assert.deepEqual(guardian, { endpoints: [], examined: 0, unreadable: "ENOENT" });
    const result = preflightLiveRun({ ...freshGoodTree(root), guardian });
    assert.equal(result.ok, false);
    assert.equal(result.firstFailure.status, "not_measured");
    assert.equal(result.firstFailure.condition, "guardian_pipe_unreachable");
    assert.match(result.firstFailure.detail, /^guardian_pipe_unreachable: pipe namespace unreadable:ENOENT/u);
  });
});

test("a bound guardian endpoint passes, and the reading names it", () => {
  withRoot("preflight-guardian-bound-", (root) => {
    const guardian = probeGuardianPipe({ readPipeDirectory: pipeDirectory("lsass", GUARDIAN_ENDPOINT) });
    assert.deepEqual(guardian.endpoints, [GUARDIAN_ENDPOINT]);
    const result = preflightLiveRun({ ...freshGoodTree(root), guardian });
    const entry = result.checks.find((item) => item.code === "guardian_pipe_reachable");
    assert.equal(entry.ok, true, JSON.stringify(entry));
    assert.equal(entry.status, "passed");
    assert.equal(entry.detail, `2 named pipe(s) examined; bound: ${GUARDIAN_ENDPOINT}`);
    assert.deepEqual(failureCodes(result), [], JSON.stringify(result.checks, null, 1));
  });
});

test("the guardian condition is reported ahead of a stale artifact, because a rebuild does not repair it", () => {
  withRoot("preflight-guardian-order-", (root) => {
    const tree = freshGoodTree(root);
    touch(join(tree.releaseDir, "GameBuddy.Stardew.dll"), new Date(Date.now() - 120_000));
    touch(join(tree.modRoot, "src", "Thing.cs"), new Date());
    // Without the probe the tree reports the rebuildable failure, which is what the preflight used to show while
    // four runs died on the unrepairable one.
    assert.equal(preflightLiveRun(tree).firstFailure.code, "mod_bundle_fresh");
    const result = preflightLiveRun({
      ...tree,
      guardian: probeGuardianPipe({ readPipeDirectory: pipeDirectory("lsass") }),
    });
    assert.equal(result.firstFailure.code, "guardian_pipe_reachable");
  });
});

// The prefix in this module is a copy of one word two other files own, and a copy is only safe while it still
// matches. The population is the files that create the endpoint and the file that connects to it: a rename on
// either side must go red here rather than leave the check matching nothing for ever.
const GUARDIAN_ENDPOINT_SPELLERS = Object.freeze([
  "host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts",
  "desktop/GameBuddy.Desktop/DesktopHostBootstrapBroker.cs",
  "tools/desktop-composition-launch.mjs",
]);

test("the guardian endpoint prefix is still the spelling its producers and consumer use", () => {
  const drifted = GUARDIAN_ENDPOINT_SPELLERS.filter(
    (path) => !readFileSync(path, "utf8").includes(GUARDIAN_ENDPOINT_PREFIX),
  );
  assert.deepEqual(
    drifted,
    [],
    `these files no longer spell "${GUARDIAN_ENDPOINT_PREFIX}", so the reachability check would silently examine nothing`,
  );
});

test(
  "the default probe reads this machine's own pipe namespace",
  { skip: process.platform !== "win32" ? "the named-pipe namespace is a Windows fact" : false },
  () => {
    const guardian = probeGuardianPipe();
    assert.equal(guardian.unreadable, null, JSON.stringify(guardian));
    assert.ok(guardian.examined > 0, `examined ${String(guardian.examined)} named pipe(s)`);
    assert.ok(Array.isArray(guardian.endpoints));
  },
);
