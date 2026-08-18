import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readArtifactConfig } from "./production-artifact.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const hostRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RESULT_SCHEMA_VERSION = 1;
const GATE = "windows_reparse_live_gate/v1";
const PROBE_NAMES = Object.freeze(["regular", "junction", "directorySymlink", "nonLinkReparse"]);
const CONSUMER_NAMES = Object.freeze(["browserGenerator", "hostStaticVerifier"]);
const STATUS = new Set(["passed", "blocked"]);
const TYPESCRIPT_COMPILER_TIMEOUT_MS = 120_000;
const TYPESCRIPT_COMPILER_OUTPUT_LIMIT_BYTES = 64 * 1024;

function blankResult(reason, helperSha256 = null) {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    gate: GATE,
    status: "blocked",
    reason,
    helperSha256,
    probes: Object.fromEntries(PROBE_NAMES.map((name) => [name, "blocked"])),
    consumers: Object.fromEntries(CONSUMER_NAMES.map((name) => [name, "blocked"])),
  };
}

/** The audit shape is deliberately small and cannot contain fixture paths. */
export function isWindowsReparseLiveGateResult(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "consumers,gate,helperSha256,probes,reason,schemaVersion,status"
    && value.schemaVersion === RESULT_SCHEMA_VERSION
    && value.gate === GATE
    && STATUS.has(value.status)
    && typeof value.reason === "string" && /^[a-z0-9_]+$/.test(value.reason)
    && (value.helperSha256 === null || (typeof value.helperSha256 === "string" && /^[a-f0-9]{64}$/.test(value.helperSha256)))
    && exactStatusMap(value.probes, PROBE_NAMES)
    && exactStatusMap(value.consumers, CONSUMER_NAMES);
}

function exactStatusMap(value, names) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...names].sort().join(",")
    && names.every((name) => STATUS.has(value[name]));
}

function finish(result) {
  if (!isWindowsReparseLiveGateResult(result)) throw new Error("windows_reparse_live_gate_internal_result_invalid");
  result.status = result.reason === "passed" ? "passed" : "blocked";
  if (result.status === "passed" && (!PROBE_NAMES.every((name) => result.probes[name] === "passed") || !CONSUMER_NAMES.every((name) => result.consumers[name] === "passed")))
    throw new Error("windows_reparse_live_gate_internal_success_invalid");
  return Object.freeze(result);
}

async function readVerifiedSourceHelperSha256() {
  // This is audit metadata only. The emitted adapter below is the sole
  // authority that validates and mints use of this fixed source build pair.
  const manifest = await readFile(resolve(hostRoot, "native", "windows-reparse-inspector", ".dist", "win-x64", "windows-reparse-inspector.manifest.json"), "utf8");
  const match = /^\{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"GameBuddy\.WindowsReparseInspector\.exe","sha256":"([a-f0-9]{64})"\}\n$/.exec(manifest);
  if (match === null) throw new Error("fixed_helper_pair_unavailable");
  return match[1];
}

async function compileCurrentSource(emittedRoot) {
  const compiler = resolve(hostRoot, "node_modules", "typescript", "lib", "tsc.js");
  const compilerState = await lstat(compiler).catch(() => undefined);
  if (!compilerState?.isFile() || compilerState.isSymbolicLink()) throw new Error("current_source_emit_unavailable");
  await mkdir(emittedRoot, { recursive: true });
  await runBoundedProcess(process.execPath, [
    compiler,
    "--project", resolve(hostRoot, "tsconfig.production.json"),
    "--outDir", emittedRoot,
    "--pretty", "false",
  ]);
}

async function runBoundedProcess(command, args) {
  await new Promise((resolveProcess, rejectProcess) => {
    let child;
    let timer;
    let settled = false;
    let outputBytes = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectProcess(error); else resolveProcess();
    };
    const fail = () => {
      child?.kill();
      finish(new Error("current_source_emit_unavailable"));
    };
    const safeEnvironment = process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot };
    try {
      child = spawn(command, args, {
        cwd: hostRoot,
        env: safeEnvironment,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish(new Error("current_source_emit_unavailable"));
      return;
    }
    timer = setTimeout(fail, TYPESCRIPT_COMPILER_TIMEOUT_MS);
    const countOutput = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > TYPESCRIPT_COMPILER_OUTPUT_LIMIT_BYTES) fail();
    };
    child.stdout.on("data", countOutput);
    child.stderr.on("data", countOutput);
    child.once("error", () => finish(new Error("current_source_emit_unavailable")));
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null) return finish(new Error("current_source_emit_unavailable"));
      finish();
    });
  });
}

async function loadBuildInspectorAdapter(emittedRoot) {
  // This fresh adapter alone derives the repository-fixed source helper pair
  // at host/native/windows-reparse-inspector/.dist/win-x64 and mints its opaque
  // build capability after its own manifest/hash verification.
  const adapter = await import(pathToFileURL(resolve(emittedRoot, "windows-reparse-inspector", "index.js")).href);
  if (typeof adapter.createBuildWindowsReparseInspector !== "function" || typeof adapter.inspectWindowsReparse !== "function" || typeof adapter.assertNoWindowsReparse !== "function")
    throw new Error("build_inspector_adapter_unavailable");
  return adapter;
}

async function isDirectoryLink(path) {
  const state = await lstat(path).catch(() => undefined);
  return state?.isSymbolicLink() === true;
}

async function prepareConsumerFixture(root, name) {
  const artifact = resolve(root, `${name}-artifact`);
  const targetAssets = resolve(root, `${name}-target-assets`);
  const asset = Buffer.from("console.log('reparse gate');\n", "utf8");
  const assets = join(artifact, "assets");
  await mkdir(assets, { recursive: true });
  await writeFile(join(assets, "app-abcdef12.js"), asset);
  await writeFile(join(artifact, "index.html"), "<!doctype html><title>Tavern</title>", "utf8");
  await writeFile(join(artifact, "tavern-browser-artifact-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    browserContract: "tavern_browser_api/v1",
    profileId: "gamebuddy.tavern.browser.v1",
    entryHtml: "index.html",
    assets: [{ path: "assets/app-abcdef12.js", sha256: createHash("sha256").update(asset).digest("hex"), bytes: asset.length, mime: "text/javascript" }],
  }), "utf8");
  return { artifact, entry: assets, targetAssets };
}

async function replaceAssetsWithReparseLink(fixture, linkType) {
  // Move the verified ordinary assets byte-for-byte, then replace only its
  // artifact entry with the exact link under test.
  await rename(fixture.entry, fixture.targetAssets);
  await symlink(fixture.targetAssets, fixture.entry, linkType);
}

async function loadConsumers(emittedRoot) {
  const browser = await import(pathToFileURL(resolve(hostRoot, "..", "dialogue-web", "scripts", "browser-artifact-manifest.mjs")).href);
  const staticArtifact = await import(pathToFileURL(resolve(emittedRoot, "tavern", "static-artifact", "index.js")).href);
  if (typeof browser.verifyProductionArtifactManifest !== "function" || typeof staticArtifact.verifyTavernStaticArtifact !== "function")
    throw new Error("consumer_rejection_interface_unavailable");
  return { browser, staticArtifact };
}

async function verifyConsumers(artifact, consumers, inspector, inspectorAdapter) {
  // Do not call the browser factory: it resolves the mutable global emitted root.
  // This exact policy preserves the shared opaque capability from the fresh adapter.
  const browserPolicy = Object.freeze({ inspect: async (path) => await inspectorAdapter.assertNoWindowsReparse(inspector, path) });
  const browserAccepted = await consumers.browser.verifyProductionArtifactManifest(artifact, browserPolicy).then(() => true, () => false);
  const staticAccepted = await consumers.staticArtifact.verifyTavernStaticArtifact(artifact, {
    browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.tavern.browser.v1",
  }, inspector).then(() => true, () => false);
  return { browserAccepted, staticAccepted };
}

async function assertConsumersReject(fixture, linkType, consumers, inspector, inspectorAdapter) {
  // A rejection is evidence only when both consumers first accept this exact
  // ordinary artifact under the same fresh adapter capability and policy.
  const baseline = await verifyConsumers(fixture.artifact, consumers, inspector, inspectorAdapter);
  if (!baseline.browserAccepted || !baseline.staticAccepted)
    return { baselineAccepted: false, linkClassified: false, browserRejected: false, staticRejected: false };

  await replaceAssetsWithReparseLink(fixture, linkType);
  const linkClassified = await isDirectoryLink(fixture.entry)
    && (await inspectorAdapter.inspectWindowsReparse(inspector, fixture.entry)) === "reparse";
  if (!linkClassified)
    return { baselineAccepted: true, linkClassified: false, browserRejected: false, staticRejected: false };

  const mutation = await verifyConsumers(fixture.artifact, consumers, inspector, inspectorAdapter);
  return {
    baselineAccepted: true,
    linkClassified: true,
    browserRejected: !mutation.browserAccepted,
    staticRejected: !mutation.staticAccepted,
  };
}

/**
 * Runs the one current, fixed Windows evidence attempt. The helper capability
 * is minted and consumed only by the emitted shared adapter; this gate cannot
 * access its executable path or launch it directly.
 */
export async function runWindowsReparseLiveGate() {
  if (process.platform !== "win32") return finish(blankResult("windows_platform_required"));

  let helperSha256;
  try {
    const config = await readArtifactConfig(hostRoot);
    if (config.windowsReparseInspector === undefined) return finish(blankResult("fixed_helper_pair_unavailable"));
    helperSha256 = await readVerifiedSourceHelperSha256();
  } catch {
    return finish(blankResult("fixed_helper_pair_unavailable"));
  }

  let root;
  let emittedRoot;
  const cleanupRunDirectories = async () => {
    await Promise.allSettled([
      emittedRoot === undefined ? undefined : rm(emittedRoot, { recursive: true, force: true }),
      root === undefined ? undefined : rm(root, { recursive: true, force: true }),
    ]);
  };
  try {
    root = await mkdtemp(resolve(tmpdir(), "gamebuddy-windows-reparse-live-gate-"));
    // The emitted adapter derives hostRoot by walking two parents from
    // emittedRoot/windows-reparse-inspector/index.js. Keep this generated
    // directory as a direct, normal private child of hostRoot.
    emittedRoot = await mkdtemp(join(hostRoot, ".windows-reparse-live-gate-"));
    const emittedState = await lstat(emittedRoot);
    if (!emittedState.isDirectory() || emittedState.isSymbolicLink())
      throw new Error("current_source_emit_unavailable");
  } catch {
    await cleanupRunDirectories();
    return finish(blankResult("current_source_emit_unavailable", helperSha256));
  }
  const result = blankResult("probe_fixture_unavailable", helperSha256);
  try {
    await compileCurrentSource(emittedRoot);
    const inspectorAdapter = await loadBuildInspectorAdapter(emittedRoot);
    const inspector = await inspectorAdapter.createBuildWindowsReparseInspector();
    const regular = resolve(root, "regular.txt");
    await writeFile(regular, "regular", "utf8");
    result.probes.regular = (await inspectorAdapter.inspectWindowsReparse(inspector, regular)) === "regular" ? "passed" : "blocked";

    const consumers = await loadConsumers(emittedRoot);
    const consumerVerdicts = [];
    for (const [name, linkType, probeName] of [
      ["junction", "junction", "junction"],
      ["directory-symlink", "dir", "directorySymlink"],
    ]) {
      const fixture = await prepareConsumerFixture(root, name);
      const verdict = await assertConsumersReject(fixture, linkType, consumers, inspector, inspectorAdapter);
      if (!verdict.baselineAccepted || !verdict.linkClassified) continue;
      result.probes[probeName] = "passed";
      consumerVerdicts.push(verdict);
    }
    // Do not aggregate a browser rejection from one artifact with a Host
    // rejection from another: every accepted ordinary baseline's exact
    // classified mutation must be rejected by both.
    if (consumerVerdicts.length > 0 && consumerVerdicts.every((verdict) => verdict.baselineAccepted && verdict.browserRejected))
      result.consumers.browserGenerator = "passed";
    if (consumerVerdicts.length > 0 && consumerVerdicts.every((verdict) => verdict.baselineAccepted && verdict.staticRejected))
      result.consumers.hostStaticVerifier = "passed";

    // No safe approved non-link reparse fixture or fixed producer currently
    // exists in this repository. It must remain an explicit blocked outcome.
    result.probes.nonLinkReparse = "blocked";
    result.reason = "non_link_reparse_fixture_unavailable";
    return finish(result);
  } catch (error) {
    result.reason = error?.message === "current_source_emit_unavailable"
      ? "current_source_emit_unavailable"
      : error?.message === "consumer_rejection_interface_unavailable"
        ? "consumer_rejection_interface_unavailable"
        : "probe_fixture_unavailable";
    return finish(result);
  } finally {
    await cleanupRunDirectories();
  }
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  const result = await runWindowsReparseLiveGate().catch(() => finish(blankResult("live_gate_internal_failure")));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "passed") process.exitCode = 1;
}
