import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildWindowsAfUnixReparseFixture,
  helperFileName as afUnixFixtureHelperFileName,
  outputRoot as afUnixFixtureOutputRoot,
} from "./build-windows-af-unix-reparse-fixture.mjs";
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
const AF_UNIX_FIXTURE_READY_TIMEOUT_MS = 15_000;
const AF_UNIX_FIXTURE_EXIT_TIMEOUT_MS = 15_000;
const AF_UNIX_FIXTURE_OUTPUT_LIMIT_BYTES = 16 * 1024;
const LIVE_GATE_CLEANUP_TIMEOUT_MS = 30_000;
const DIRECTORY_SYMLINK_CAPABILITY_ERROR_CODES = new Set(["EPERM", "EACCES", "ENOTSUP"]);

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
      if (timer !== undefined) clearTimeout(timer);
      if (error) rejectProcess(error); else resolveProcess();
    };
    const fail = () => {
      try { child?.kill(); } catch { /* the bounded failure is already recorded */ }
      finish(new Error("current_source_emit_unavailable"));
    };
    const safeEnvironment = process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot };
    try {
      child = spawn(command, args, {
        cwd: hostRoot,
        env: safeEnvironment,
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish(new Error("current_source_emit_unavailable"));
      return;
    }
    timer = setTimeout(fail, TYPESCRIPT_COMPILER_TIMEOUT_MS);
    const countOutput = (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > TYPESCRIPT_COMPILER_OUTPUT_LIMIT_BYTES) fail();
    };
    child.stdout?.on("data", countOutput);
    child.stderr?.on("data", countOutput);
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
  const boundary = adapter?.BUILD_ARTIFACT_REPARSE_INSPECTION;
  if (typeof boundary?.create !== "function" || typeof adapter.inspectWindowsReparse !== "function" || typeof adapter.inspectWindowsPathIdentity !== "function" || typeof boundary?.assertNoReparse !== "function")
    throw new Error("build_inspector_adapter_unavailable");
  return adapter;
}

async function isDirectoryLink(path) {
  const state = await lstat(path).catch(() => undefined);
  return state?.isSymbolicLink() === true;
}

function isDirectorySymlinkCapabilityUnavailable(error) {
  return error !== null && typeof error === "object" && DIRECTORY_SYMLINK_CAPABILITY_ERROR_CODES.has(error.code);
}

function isContainedPath(root, candidate) {
  const remainder = relative(root, candidate);
  return remainder !== "" && !isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`);
}

function sameWindowsPath(left, right) {
  return resolve(left).replaceAll("\\", "/").toLowerCase() === resolve(right).replaceAll("\\", "/").toLowerCase();
}

async function assertPrivateDirectory(path, parent) {
  if (!isAbsolute(path) || resolve(path) !== path || !isContainedPath(parent, path)) throw new Error("probe_fixture_unavailable");
  const state = await lstat(path).catch(() => undefined);
  if (!state?.isDirectory() || state.isSymbolicLink()) throw new Error("probe_fixture_unavailable");
  const physicalPath = await realpath(path).catch(() => undefined);
  if (physicalPath === undefined || !sameWindowsPath(physicalPath, path)) throw new Error("probe_fixture_unavailable");
}

async function assertFixtureHelper(fixture) {
  if (fixture === null || typeof fixture !== "object" || typeof fixture.helperPath !== "string" || typeof fixture.sha256 !== "string")
    throw new Error("probe_fixture_unavailable");
  const helperPath = resolve(fixture.helperPath);
  const expectedHelperPath = resolve(afUnixFixtureOutputRoot, afUnixFixtureHelperFileName);
  if (!isAbsolute(fixture.helperPath) || helperPath !== fixture.helperPath || !sameWindowsPath(helperPath, expectedHelperPath) || !/^[a-f0-9]{64}$/.test(fixture.sha256))
    throw new Error("probe_fixture_unavailable");
  await assertPrivateDirectory(afUnixFixtureOutputRoot, resolve(afUnixFixtureOutputRoot, ".."));
  const helperState = await lstat(helperPath).catch(() => undefined);
  if (!helperState?.isFile() || helperState.isSymbolicLink()) throw new Error("probe_fixture_unavailable");
  const physicalHelperPath = await realpath(helperPath).catch(() => undefined);
  if (physicalHelperPath === undefined || !sameWindowsPath(physicalHelperPath, helperPath)) throw new Error("probe_fixture_unavailable");
  const actualSha256 = createHash("sha256").update(await readFile(helperPath)).digest("hex");
  if (actualSha256 !== fixture.sha256) throw new Error("probe_fixture_unavailable");
  return Object.freeze({ helperPath, sha256: actualSha256 });
}

function startAfUnixFixture(helperPath, socketPath) {
  if (!isAbsolute(helperPath) || resolve(helperPath) !== helperPath || !isAbsolute(socketPath) || resolve(socketPath) !== socketPath)
    throw new Error("probe_fixture_unavailable");
  let resolveReady;
  let rejectReady;
  let readySettled = false;
  const readyPromise = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const state = {
    child: undefined,
    stdout: "",
    stderr: "",
    outputBytes: 0,
    ready: false,
    readyPromise,
    failure: undefined,
    closed: undefined,
    stopped: undefined,
  };
  const fail = (reason) => {
    if (state.failure === undefined) state.failure = new Error(reason);
    if (!readySettled) {
      readySettled = true;
      rejectReady?.(state.failure);
    }
  };
  try {
    state.child = spawn(helperPath, [socketPath], {
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    fail("af_unix_fixture_spawn_failed");
    return state;
  }
  const child = state.child;
  child.once("error", () => fail("af_unix_fixture_process_failed"));
  child.stdout?.on("data", (chunk) => {
    const bytes = Buffer.from(chunk);
    state.outputBytes += bytes.length;
    state.stdout += bytes.toString("utf8");
    if (state.outputBytes > AF_UNIX_FIXTURE_OUTPUT_LIMIT_BYTES) return fail("af_unix_fixture_output_overflow");
    if (!state.ready) {
      if (!"ready\n".startsWith(state.stdout)) return fail("af_unix_fixture_ready_invalid");
      if (state.failure === undefined && state.stdout === "ready\n" && state.stderr === "") {
        state.ready = true;
        readySettled = true;
        resolveReady?.();
      }
    } else if (state.stdout !== "ready\n") {
      fail("af_unix_fixture_output_invalid");
    }
  });
  child.stderr?.on("data", (chunk) => {
    const bytes = Buffer.from(chunk);
    state.outputBytes += bytes.length;
    state.stderr += bytes.toString("utf8");
    if (state.outputBytes > AF_UNIX_FIXTURE_OUTPUT_LIMIT_BYTES) fail("af_unix_fixture_output_overflow");
    else fail("af_unix_fixture_stderr");
  });
  child.once("close", (code, signal) => {
    state.closed = Object.freeze({ code, signal });
    if (!state.ready) fail("af_unix_fixture_exited_before_ready");
    else if (code !== 0 || signal !== null) fail("af_unix_fixture_process_failed");
  });
  if (child.stdout === undefined || child.stderr === undefined || child.stdin === undefined) fail("af_unix_fixture_stdio_unavailable");
  return state;
}

async function waitForAfUnixFixtureReady(fixtureProcess) {
  let timer;
  try {
    await Promise.race([
      fixtureProcess.readyPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("af_unix_fixture_ready_timeout")), AF_UNIX_FIXTURE_READY_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (fixtureProcess.failure === undefined) fixtureProcess.failure = error instanceof Error ? error : new Error("af_unix_fixture_ready_failed");
    throw fixtureProcess.failure;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!fixtureProcess.ready || fixtureProcess.failure !== undefined || fixtureProcess.closed !== undefined || fixtureProcess.stdout !== "ready\n" || fixtureProcess.stderr !== "")
    throw new Error("af_unix_fixture_ready_invalid");
}

function waitForAfUnixFixtureExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ closed: true, code: child.exitCode, signal: child.signalCode });
  return new Promise((resolveExit) => {
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      child.off("close", onClose);
      resolveExit(value);
    };
    const onClose = (code, signal) => finish({ closed: true, code, signal });
    child.once("close", onClose);
    timer = setTimeout(() => finish({ closed: false, code: null, signal: null }), timeoutMs);
    timer.unref?.();
  });
}

async function stopAfUnixFixture(fixtureProcess) {
  if (fixtureProcess === undefined) return true;
  if (fixtureProcess.stopped !== undefined) return fixtureProcess.stopped;
  const child = fixtureProcess.child;
  if (child === undefined) return false;
  try {
    child.stdin?.end();
  } catch {
    fixtureProcess.stopped = false;
    return false;
  }
  let exit = await waitForAfUnixFixtureExit(child, AF_UNIX_FIXTURE_EXIT_TIMEOUT_MS);
  if (!exit.closed) {
    let killed = false;
    try { killed = child.kill(); } catch { /* cleanup is reported below */ }
    if (!killed && child.exitCode === null && child.signalCode === null) {
      fixtureProcess.stopped = false;
      return false;
    }
    exit = await waitForAfUnixFixtureExit(child, AF_UNIX_FIXTURE_EXIT_TIMEOUT_MS);
  }
  // A fixture process may have failed its capability probe (for example, an
  // AF_UNIX socket path can exceed Windows' native address limit). That is a
  // blocked probe, not a cleanup failure: cleanup is successful once the
  // process has actually closed. Keep those two facts separate so the gate
  // reports the real probe disposition instead of masking it as cleanup.
  fixtureProcess.stopped = exit.closed;
  return fixtureProcess.stopped;
}

async function prepareConsumerFixture(root, name) {
  const artifact = resolve(root, `${name}-artifact`);
  const targetAssets = resolve(root, `${name}-target-assets`);
  if (!isContainedPath(root, artifact) || !isContainedPath(root, targetAssets)) throw new Error("probe_fixture_unavailable");
  const asset = Buffer.from("console.log('reparse gate');\n", "utf8");
  const assets = join(artifact, "assets");
  await mkdir(assets, { recursive: true });
  await assertPrivateDirectory(artifact, root);
  await assertPrivateDirectory(assets, artifact);
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
  if (!isAbsolute(fixture.entry) || !isAbsolute(fixture.targetAssets) || !isContainedPath(fixture.artifact, fixture.entry) || !isContainedPath(resolve(fixture.artifact, ".."), fixture.targetAssets))
    throw new Error("probe_fixture_unavailable");
  if (await lstat(fixture.targetAssets).catch(() => undefined) !== undefined) throw new Error("probe_fixture_unavailable");
  await rename(fixture.entry, fixture.targetAssets);
  await symlink(fixture.targetAssets, fixture.entry, linkType);
}

async function assertAfUnixSocket(socketPath, inspector, inspectorAdapter, fixtureProcess) {
  if (!isAbsolute(socketPath) || resolve(socketPath) !== socketPath || fixtureProcess.failure !== undefined || fixtureProcess.stdout !== "ready\n" || fixtureProcess.stderr !== "")
    throw new Error("probe_fixture_unavailable");
  const legacy = await inspectorAdapter.inspectWindowsReparse(inspector, socketPath);
  const identity = await inspectorAdapter.inspectWindowsPathIdentity(inspector, socketPath);
  return legacy === "reparse" && identity.objectKind === "regular_file" && identity.isReparsePoint === true;
}

async function assertConsumersRejectAfUnix(fixture, helper, consumers, inspector, inspectorAdapter) {
  const baseline = await verifyConsumers(fixture.artifact, consumers, inspector, inspectorAdapter);
  if (!baseline.browserAccepted || !baseline.staticAccepted)
    return { baselineAccepted: false, linkClassified: false, browserRejected: false, staticRejected: false };

  let fixtureProcess;
  try {
    if (await lstat(fixture.entry).catch(() => undefined) === undefined || await lstat(fixture.targetAssets).catch(() => undefined) !== undefined)
      throw new Error("probe_fixture_unavailable");
    await rename(fixture.entry, fixture.targetAssets);
    fixtureProcess = startAfUnixFixture(helper.helperPath, fixture.entry);
    await waitForAfUnixFixtureReady(fixtureProcess);
    const linkClassified = await assertAfUnixSocket(fixture.entry, inspector, inspectorAdapter, fixtureProcess);
    if (!linkClassified)
      return { baselineAccepted: true, linkClassified: false, browserRejected: false, staticRejected: false };

    const mutation = await verifyConsumers(fixture.artifact, consumers, inspector, inspectorAdapter);
    return {
      baselineAccepted: true,
      linkClassified: true,
      browserRejected: !mutation.browserAccepted,
      staticRejected: !mutation.staticAccepted,
    };
  } finally {
    if (!await stopAfUnixFixture(fixtureProcess)) throw new Error("af_unix_fixture_cleanup_failed");
  }
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
  const browserPolicy = Object.freeze({ inspect: async (path) => await inspectorAdapter.BUILD_ARTIFACT_REPARSE_INSPECTION.assertNoReparse(inspector, path) });
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
  const removeRunDirectory = async (path) => {
    if (path === undefined) return true;
    try {
      await rm(path, { recursive: true, force: true });
      return (await lstat(path).catch(() => undefined)) === undefined;
    } catch {
      return false;
    }
  };
  const cleanupRunDirectories = async () => {
    let timer;
    const cleanup = Promise.all([
      removeRunDirectory(emittedRoot),
      removeRunDirectory(root),
    ]).then((values) => values.every(Boolean), () => false);
    const timeout = new Promise((resolveCleanup) => {
      timer = setTimeout(() => resolveCleanup(false), LIVE_GATE_CLEANUP_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([cleanup, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  try {
    const rootParent = parse(resolve(tmpdir())).root;
    root = await mkdtemp(join(rootParent, "gamebuddy-windows-reparse-live-gate-"));
    await assertPrivateDirectory(root, rootParent);
    // The emitted adapter derives hostRoot by walking two parents from
    // emittedRoot/windows-reparse-inspector/index.js. Keep this generated
    // directory as a direct, normal private child of hostRoot.
    emittedRoot = await mkdtemp(join(hostRoot, ".windows-reparse-live-gate-"));
    await assertPrivateDirectory(emittedRoot, hostRoot);
  } catch {
    const cleaned = await cleanupRunDirectories();
    return finish(blankResult(cleaned ? "current_source_emit_unavailable" : "probe_fixture_cleanup_failed", helperSha256));
  }

  const result = blankResult("probe_fixture_unavailable", helperSha256);
  try {
    await compileCurrentSource(emittedRoot);
    const inspectorAdapter = await loadBuildInspectorAdapter(emittedRoot);
    const inspector = await inspectorAdapter.BUILD_ARTIFACT_REPARSE_INSPECTION.create();

    const regular = resolve(root, "regular.txt");
    await writeFile(regular, "regular", "utf8");
    result.probes.regular = (await inspectorAdapter.inspectWindowsReparse(inspector, regular)) === "regular" ? "passed" : "blocked";

    const consumers = await loadConsumers(emittedRoot);
    const consumerVerdicts = [];
    let directorySymlinkUnavailable = false;
    for (const [name, linkType, probeName] of [
      ["junction", "junction", "junction"],
      ["directory-symlink", "dir", "directorySymlink"],
    ]) {
      const fixture = await prepareConsumerFixture(root, name);
      let verdict;
      try {
        verdict = await assertConsumersReject(fixture, linkType, consumers, inspector, inspectorAdapter);
      } catch (error) {
        if (probeName === "directorySymlink" && isDirectorySymlinkCapabilityUnavailable(error)) {
          directorySymlinkUnavailable = true;
          continue;
        }
        throw error;
      }
      if (!verdict.baselineAccepted || !verdict.linkClassified) continue;
      result.probes[probeName] = "passed";
      consumerVerdicts.push(verdict);
    }

    // Build and launch the repository-owned producer only after the fresh
    // emitted adapter has been loaded. The helper path remains internal and is
    // never copied into the redacted gate result.
    const afUnixFixture = await assertFixtureHelper(await buildWindowsAfUnixReparseFixture());
    // Keep the AF_UNIX socket entry short enough for Windows' native Unix
    // domain socket address limit while retaining the exact artifact/assets
    // mutation used by the other consumer probes.
    const nonLinkFixture = await prepareConsumerFixture(root, "n");
    const nonLinkVerdict = await assertConsumersRejectAfUnix(nonLinkFixture, afUnixFixture, consumers, inspector, inspectorAdapter);
    if (nonLinkVerdict.baselineAccepted && nonLinkVerdict.linkClassified) {
      result.probes.nonLinkReparse = "passed";
      consumerVerdicts.push(nonLinkVerdict);
    }

    // Do not aggregate a browser rejection from one artifact with a Host
    // rejection from another: every accepted ordinary baseline's exact
    // classified mutation must be rejected by both.
    if (consumerVerdicts.length > 0 && consumerVerdicts.every((verdict) => verdict.baselineAccepted && verdict.browserRejected))
      result.consumers.browserGenerator = "passed";
    if (consumerVerdicts.length > 0 && consumerVerdicts.every((verdict) => verdict.baselineAccepted && verdict.staticRejected))
      result.consumers.hostStaticVerifier = "passed";

    if (PROBE_NAMES.every((name) => result.probes[name] === "passed") && CONSUMER_NAMES.every((name) => result.consumers[name] === "passed"))
      result.reason = "passed";
    else if (result.probes.nonLinkReparse !== "passed")
      result.reason = "non_link_reparse_fixture_unavailable";
    else if (directorySymlinkUnavailable)
      result.reason = "directory_symlink_fixture_unavailable";
  } catch (error) {
    result.reason = error?.message === "current_source_emit_unavailable"
      ? "current_source_emit_unavailable"
      : error?.message === "consumer_rejection_interface_unavailable"
        ? "consumer_rejection_interface_unavailable"
        : error?.message === "af_unix_fixture_cleanup_failed"
          ? "probe_fixture_cleanup_failed"
          : "probe_fixture_unavailable";
  }

  if (!await cleanupRunDirectories()) result.reason = "probe_fixture_cleanup_failed";
  return finish(result);
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  const result = await runWindowsReparseLiveGate().catch(() => finish(blankResult("live_gate_internal_failure")));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "passed") process.exitCode = 1;
}
