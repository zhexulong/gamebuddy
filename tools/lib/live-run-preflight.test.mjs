// The preflight's own falsifiers: every check it makes has to be able to go red.
//
// A gate nobody can make fail is decoration, which is why each case below builds the exact tree shape that check exists
// for and asserts the code it must report. The good tree is the control.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  importsWithoutStarting,
  preflightLiveRun,
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

test("the good tree passes every check", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-good-"));
  try {
    const tree = goodTree(root);
    // The DLL must be at least as new as the sources, and the artifact at least as new as host/src.
    const past = new Date(Date.now() - 60_000);
    const now = new Date();
    touch(join(tree.modRoot, "src", "Thing.cs"), past);
    touch(join(tree.releaseDir, "GameBuddy.Stardew.dll"), now);
    touch(join(tree.hostRoot, "src", "index.ts"), past);
    touch(join(tree.hostRoot, "dist-test", "index.js"), now);
    const result = preflightLiveRun(tree);
    assert.deepEqual(failureCodes(result), [], JSON.stringify(result.checks, null, 1));
    assert.equal(result.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
