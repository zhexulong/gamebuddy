// Phase launch: drive the product's OWN entry (the pinned worktree's tools/desktop-composition-launch.mjs
// ::launchDesktopCompositionGateChild — the tracked authority; never rewritten) against a fresh gate-owned
// run root, open the product page in a private CDP Edge, wait for the app to mount, then hold until the
// stop flag appears. The run root is NEVER deleted; it is kept for the report. Only after the flag does
// this phase tear down processes and write the post-run isolation measurement.
//
// Invocation:  node phases/launch.mjs <path-to-run.json> [<cdp-port>]
// The deployment manifest's `runtimeRoot` is set to the launcher's OWN declared data root
// (desktopCompositionMutableRootPaths(root).data) — never overridden to the temp root, which is what
// made the declared layout look unused in older one-off runs.
import { access, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runPaths, loadRunConfig } from "../lib/config.mjs";

const run = loadRunConfig({ runConfigFile: process.argv[2] });
if (run === null) throw new Error(`run_config_unreadable:${process.argv[2]}`);
const cdpPort = Number(process.argv[3] ?? process.env.GB_SHOTS_CDP_PORT ?? 9341);
const paths = runPaths(run);

const LOG = paths.launchLog;
const say = (...parts) => {
  const line = parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ");
  appendFileSync(LOG, `${line}\n`);
};

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root) {
  const out = [];
  const visit = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  await visit(root);
  return out;
}

async function newestUnder(root) {
  let newest = null;
  for (const file of await walkFiles(root)) {
    let info;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    if (newest === null || info.mtimeMs > newest.mtimeMs) newest = { mtimeMs: info.mtimeMs, path: file };
  }
  return newest;
}

async function fingerprint(prod) {
  const tavern = join(prod, "data", "tavern");
  const files = await walkFiles(prod);
  const newest = await newestUnder(tavern);
  return {
    gameBuddyExists: await exists(prod),
    fileCount: files.length,
    tavernExists: await exists(tavern),
    newestTavernMtimeMs: newest === null ? null : newest.mtimeMs,
    newestTavernPath: newest === null ? null : newest.path,
  };
}

async function cdpEvaluate(wsUrl, expression) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", (event) =>
      reject(new Error(`cdp socket error: ${String(event?.message ?? event)}`)),
    );
  });
  socket.addEventListener("message", (event) => {
    let value;
    try {
      value = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const settle = pending.get(value.id);
    if (settle === undefined) return;
    pending.delete(value.id);
    settle(value);
  });
  await opened;
  const id = nextId++;
  const answer = await new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error("cdp evaluate timeout")), 15000);
    socket.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
  });
  socket.close();
  if (answer.error !== undefined) throw new Error(`cdp error: ${JSON.stringify(answer.error)}`);
  return answer.result?.result?.value;
}

async function main() {
  await writeFile(LOG, "", "utf8");
  await rm(paths.stopFlag, { force: true });
  await rm(paths.launchStateFile, { force: true });

  say(`=== SHOTS LAUNCH (tag ${run.tag}, pinned ${run.commit}, no overlay; run root KEPT) ===`);
  say("worktree:", paths.worktree);
  say("artifact:", paths.artifact);
  say("run root (KEPT, never removed):", paths.runRoot);
  say("cdp port:", cdpPort);

  const launcher = await import(pathToFileURL(join(paths.worktree, "tools", "desktop-composition-launch.mjs")).href);
  const { launchDesktopCompositionGateChild, desktopCompositionMutableRootPaths, assertDesktopCompositionRunRoots } =
    launcher;
  for (const name of [
    "launchDesktopCompositionGateChild",
    "desktopCompositionMutableRootPaths",
    "assertDesktopCompositionRunRoots",
    "readDesktopCompositionRuntimeRoot",
  ]) {
    if (typeof launcher[name] !== "function") throw new Error(`launcher_export_missing:${name}`);
  }

  const prod = join(run.homeLocalAppData ?? "C:\\Users\\long\\AppData\\Local", "GameBuddy");
  const prodBefore = await fingerprint(prod);
  say("production LOCALAPPDATA parent:", prod);
  say("production fingerprint BEFORE:", JSON.stringify(prodBefore));

  await rm(paths.runRoot, { recursive: true, force: true });
  for (const name of ["data", "operational", "presentation"])
    await mkdir(join(paths.runRoot, "GameBuddy", name), { recursive: true });
  const declaredDataRoot = desktopCompositionMutableRootPaths(paths.runRoot).data;
  await mkdir(declaredDataRoot, { recursive: true });
  await writeFile(
    paths.deploymentManifest,
    JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot: declaredDataRoot,
      principal: {
        playerId: `${run.tag}_player`,
        companionId: `${run.tag}_companion`,
        continuityId: `${run.tag}_continuity`,
      },
      bootstrapOperationId: `${run.tag}_bootstrap_${Date.now()}`,
      authorityGeneration: 1,
    }),
    "utf8",
  );
  say("manifest runtimeRoot (the launcher's own declared data root):", declaredDataRoot);

  const measureNow = async () =>
    launcher.measureDesktopCompositionRunRoots({
      root: paths.runRoot,
      runtimeRoot: declaredDataRoot,
    });

  say("run root BEFORE launch:", JSON.stringify(await measureNow()));

  let stderr = "";
  let child;
  let launch;
  try {
    launch = await launchDesktopCompositionGateChild({
      outputRoot: paths.artifact,
      root: paths.runRoot,
      surface: "composed-reference-game",
      manifestPath: paths.deploymentManifest,
      readyTimeoutMs: 240_000,
      spawnImpl: (command, args, options) => {
        child = spawn(command, args, options);
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        return child;
      },
    });
  } catch (error) {
    say("LAUNCH FAILED:", String(error).slice(0, 800));
    say("child stderr (first 1500):", stderr.slice(0, 1500));
    await writeFile(
      paths.launchStateFile,
      JSON.stringify({ kind: "launch_failed", detail: String(error).slice(0, 800), prodBefore }, null, 1),
      "utf8",
    );
    say("DONE-LAUNCH-FAILED");
    process.exit(2);
  }

  say("bootstrap ack schema:", launch.ack.schema, "status=", launch.ack.status);
  say("child pid:", launch.child.pid, "alive=", launch.child.exitCode === null);
  say("ENTRY STDERR BYTES (=0 required):", Buffer.byteLength(stderr, "utf8"));
  if (stderr.length > 0) say("entry stderr (first 800):", stderr.slice(0, 800));
  say("entry alive after ack:", launch.child.exitCode === null);

  const launchUrl = await launch.waitForReady().catch((error) => {
    say("READY FAILED:", String(error).slice(0, 600));
    say("child stderr:", stderr.slice(0, 1500));
    return null;
  });
  if (launchUrl === null) {
    say("DONE-LAUNCH-FAILED");
    process.exit(2);
  }
  const port = new URL(launchUrl).port;
  say("READY at", launchUrl.replace(/boot=[^&]*/u, "boot=<redacted>"), "port=", port);
  say("entry alive at ready:", launch.child.exitCode === null);

  let measurement = null;
  try {
    measurement = await launch.measureRunRoots();
    say("measureRunRoots().root:", measurement.root);
    say("measureRunRoots().runtimeRoot (resolved):", measurement.runtimeRoot);
    say("measureRunRoots().programRoot (excluded from resolved count):", measurement.programRoot);
    say("measureRunRoots().declared:", JSON.stringify(measurement.declared));
    say("measureRunRoots().declaredFileCount:", measurement.declaredFileCount);
    say("measureRunRoots().resolved:", JSON.stringify(measurement.resolved));
    try {
      assertDesktopCompositionRunRoots(measurement);
      say("assertDesktopCompositionRunRoots(AFTER LAUNCH): PASSED");
    } catch (error) {
      say("assertDesktopCompositionRunRoots(AFTER LAUNCH): FAILED ->", String(error).slice(0, 500));
    }
  } catch (error) {
    say("measureRunRoots FAILED:", String(error).slice(0, 500));
  }

  await writeFile(paths.portFile, port, "ascii");

  const browser = spawn(
    run.edgeExe,
    [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${paths.browserProfile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=msEdgeFirstRun,CalculateNativeWinOcclusion",
      "--window-size=1460,940",
      launchUrl,
    ],
    { detached: false, stdio: "ignore", windowsHide: false },
  );
  say("browser pid:", browser.pid, "exe:", run.edgeExe, "cdpPort:", cdpPort);

  let version = null;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
      break;
    } catch {
      /* not up yet */
    }
  }
  say("cdp version browser:", version === null ? "NONE" : String(version.Browser));

  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      target = list.find((item) => item.type === "page" && String(item.url).includes(`127.0.0.1:${port}`)) ?? null;
    } catch {
      target = null;
    }
    if (target !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  let mounted = false;
  let title = null;
  if (target !== null) {
    title = target.title;
    for (let i = 0; i < 40; i += 1) {
      try {
        mounted = await cdpEvaluate(
          target.webSocketDebuggerUrl,
          "(() => (document.getElementById('root')?.innerHTML.length ?? 0) > 500 && document.querySelector('.app-bar') !== null)()",
        );
      } catch {
        mounted = false;
      }
      if (mounted === true) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  say("page target:", target === null ? "NONE" : String(target.url).replace(/boot=[^&]*/u, "boot=<redacted>"));
  say("page title:", String(title));
  say("page mounted:", Boolean(mounted));
  say("entry alive after mount:", launch.child.exitCode === null);
  say("ENTRY STDERR BYTES after mount:", Buffer.byteLength(stderr, "utf8"));

  const prodAfterLaunch = await fingerprint(prod);
  say("production fingerprint AFTER LAUNCH:", JSON.stringify(prodAfterLaunch));

  await writeFile(
    paths.launchStateFile,
    JSON.stringify(
      {
        kind: "mounted",
        tag: run.tag,
        commit: run.commit,
        port,
        cdpPort,
        childPid: launch.child.pid ?? null,
        browserPid: browser.pid ?? null,
        runRoot: paths.runRoot,
        manifestPath: paths.deploymentManifest,
        declaredDataRoot,
        artifactRoot: paths.artifact,
        worktree: paths.worktree,
        stderrBytes: Buffer.byteLength(stderr, "utf8"),
        mounted: Boolean(mounted),
        title,
        launchUrlRedacted: launchUrl.replace(/boot=[^&]*/u, "boot=<redacted>"),
        measureRunRootsAfterLaunch: measurement,
        prodBefore,
        prodAfterLaunch,
      },
      null,
      1,
    ),
    "utf8",
  );

  say("--- waiting for the stop flag at", paths.stopFlag, "---");
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (await exists(paths.stopFlag)) {
      say("stop flag seen");
      break;
    }
  }

  say("=== teardown (processes only; the run root is KEPT) ===");
  try {
    launch.dispose();
  } catch {
    /* already gone */
  }
  try {
    launch.child.kill();
  } catch {
    /* already gone */
  }
  try {
    browser.kill();
  } catch {
    /* already gone */
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
  say("child exited code=", launch.child.exitCode, "alive after kill=", launch.child.exitCode === null);
  const prodAfter = await fingerprint(prod);
  say("production fingerprint AFTER:", JSON.stringify(prodAfter));

  const postMeasurement = await measureNow();
  say("post-run declared:", JSON.stringify(postMeasurement.declared));
  say("post-run declaredFileCount:", postMeasurement.declaredFileCount);
  say("post-run resolved:", JSON.stringify(postMeasurement.resolved));
  try {
    assertDesktopCompositionRunRoots(postMeasurement);
    say("assertDesktopCompositionRunRoots(AFTER RUN): PASSED");
  } catch (error) {
    say("assertDesktopCompositionRunRoots(AFTER RUN): FAILED ->", String(error).slice(0, 500));
  }

  const jsonl = (await walkFiles(paths.runRoot)).filter((file) => file.endsWith(".jsonl"));
  say("session jsonl files at teardown:", JSON.stringify(jsonl));
  say("run root total files at teardown:", (await walkFiles(paths.runRoot)).length);
  say("RUN ROOT KEPT AT:", paths.runRoot, "exists:", await exists(paths.runRoot));
  await writeFile(
    paths.rootLayoutFile,
    JSON.stringify({ prodAfter, postRun: postMeasurement, runRootKeptAt: paths.runRoot, jsonl }, null, 1),
    "utf8",
  );
  say("DONE-LAUNCH");
  process.exit(0);
}

await main().catch((error) => {
  appendFileSync(LOG, `LAUNCH SCRIPT FAILED: ${String(error).slice(0, 800)}\nDONE-LAUNCH-FAILED\n`);
  process.exit(2);
});
