// Phase capture: run the capture drivers (tools/live-run/frontend/capture/*.cjs) over CDP against the product tab.
// Each driver is its own process; its per-item facts file <out>/<shortName>.txt is written by the
// driver itself (a driver is the only observer of the screenshots and reports computed layout facts).
// A driver whose per-run marker file exists is skipped unless --force, so a crashed driver can be
// re-run without redoing the survivors.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readBlockedByProduct, readNotMeasured } from "../capture/game-launch-verdict.mjs";
import { KIT_ROOT, loadRunConfig, REPO_ROOT, runPaths } from "../lib/config.mjs";
import { recordRunGame } from "../lib/run-game.mjs";
import { registerRunProcess } from "../lib/run-owner.mjs";
import { DRIVERS } from "./drivers.mjs";

/* The roster lives in one module because the report reconciles the same list (drivers.mjs). */

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** A driver's facts file, or `null` when it wrote none - absence is the driver's, never an empty string's. */
async function factsText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const runConfigPath = argv[0];
  const run = loadRunConfig({ runConfigFile: runConfigPath });
  if (run === null) throw new Error(`run_config_unreadable:${runConfigPath}`);
  const paths = runPaths(run);
  const force = argv.includes("--force");
  const onlyKeys = argv
    .filter((arg) => arg.startsWith("--driver="))
    .flatMap((arg) =>
      arg
        .split("=")
        .slice(1)
        .join("=")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    );

  let launchState = null;
  try {
    launchState = JSON.parse(await readFile(paths.launchStateFile, "utf8"));
  } catch {
    throw new Error(`launch_state_missing:${paths.launchStateFile} — run the launch phase first`);
  }
  if (launchState.kind !== "mounted" || launchState.mounted !== true)
    throw new Error(`launch_state_not_mounted:${launchState.kind}`);

  const port = launchState.port;
  const cdpPort = launchState.cdpPort;

  const log = (line) => {
    appendFileSync(paths.captureLog, `${line}\n`);
    console.log(line);
  };
  await mkdir(paths.outRoot, { recursive: true });

  const selected = DRIVERS.filter((driver) => (onlyKeys.length === 0 ? true : onlyKeys.includes(driver.key)));
  appendFileSync(
    paths.captureLog,
    `\n===== capture invocation ${new Date().toISOString()} drivers=[${selected.map((d) => d.key).join(",")}] force=${force} =====\n`,
  );

  let failed = 0;
  let skippedByMarker = 0;
  /*
   * A driver that measured NOTHING is a third outcome, and it is counted here rather than left to the
   * exit code: the game-launch driver asserts every link of the product's chain up to the launch request
   * and then declares `NOT-MEASURED: <reason>` when this machine holds no prerequisite that can arm the
   * Guardian. Exiting 0 is right (nothing failed) and exiting non-zero would be a lie, but a totals line
   * reading `failed=0` alone would present an unmeasured path as a covered one. The verdict comes from
   * the driver's own facts file, so the classification lives where the driver wrote it
   * (`capture/game-launch-verdict.mjs`), never as a second copy here.
   */
  let notMeasuredCount = 0;
  const notMeasuredKeys = [];
  /*
   * A driver whose chain stopped at a gap the PRODUCT owns is a fourth outcome: it is not a pass (the
   * product's own target was not reached) and not a failure (nothing was refused - the instrument met a
   * step no run on any machine can cross, `game-launch-verdict.mjs` `PRODUCT_GAPS`). Counted by name so the
   * totals line says which gap, from the driver's own facts file, never from a second classification here.
   */
  let blockedByProductCount = 0;
  const blockedByProductKeys = [];
  /* The failed drivers by NAME. A count beside a mostly-green reconciliation is the shape the operator could
   * not act on: `failed=2 of 22` names nothing, and a reader has to go hunting through the log for which two.
   * The roster keys are printed in the DONE line so the failure and its owner are read together. */
  const failedKeys = [];
  const executed = [];
  const doneDir = join(paths.stateDir, "capture-done");
  await mkdir(doneDir, { recursive: true });
  for (const driver of selected) {
    const doneMarker = join(doneDir, `${driver.out}.driver-done`);
    // The game appears inside a driver (driver w asks the Host to launch one), so the boundary between two
    // drivers is where this run can see it while it is alive: one query for the game's images per driver, and
    // the pid is recorded in the run's registry for its teardown and for its own post-run assertion.
    const game = recordRunGame({ paths, stageRoot: paths.stageRoot });
    if (game.added.length > 0)
      log(
        `  GAME RECORDED ${game.added.map((row) => `${row.pid}(${row.role})`).join(" ")} - this run started it, so its cleanup ends it`,
      );
    else if (game.kind === "unverifiable") log("  GAME NOT RECORDED: the process table did not answer this boundary");
    if (!force && (await exists(doneMarker))) {
      skippedByMarker += 1;
      log(`SKIP ${driver.key} (done marker ${doneMarker} exists)`);
      continue;
    }
    executed.push(driver.key);
    log(`========== ${driver.key} ==========`);
    const started = Date.now();
    /*
     * The facts file is this driver's own reading of THIS execution, so the previous one is removed first.
     * Measured 2026-11-15: a driver crashed before flushing and the verdict read from the file the previous
     * execution left behind counted `not-measured=1` for a run that had failed - a stale reading presented as
     * this run's measurement, which is the exact shape the done-marker already prevents for execution.
     */
    await rm(join(paths.outRoot, driver.out), { force: true });
    let code;
    try {
      code = await runDriver(driver, { port, cdpPort, run, paths, log });
    } finally {
      /*
       * THE GAME APPEARS INSIDE A DRIVER, so the boundary AFTER it is where this run can still see the game it
       * caused alive - and a driver that failed is exactly when it must. Measured 2026-11-21 twice
       * (`frontend--r26pads`, `cabinseat-r26`): driver w asked the Host to launch a game, the driver failed,
       * and the run's own cleanup printed `RUN-GAME-CLEANUP: no game this run started` because only the
       * PRE-driver boundary recorded - a sentence about a run that had just opened a game. Recording here (in a
       * `finally`, so a driver that throws is covered too) is what lets the teardown end the game by exact pid
       * and lets the run's reading say which of "ended by this run" and "never started" actually happened.
       */
      const after = recordRunGame({ paths, stageRoot: paths.stageRoot });
      if (after.added.length > 0)
        log(
          `  GAME RECORDED AFTER ${driver.key} ${after.added.map((row) => `${row.pid}(${row.role})`).join(" ")} - the driver started it, so its cleanup ends it`,
        );
      else if (after.kind === "unverifiable")
        log(`  GAME NOT RECORDED AFTER ${driver.key}: the process table did not answer this boundary`);
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    log(`  exit=${code} elapsed=${elapsed}s`);
    if (code !== 0) {
      failed += 1;
      failedKeys.push(driver.key);
      log(`  DRIVER ${driver.key} FAILED (exit ${code})`);
    }
    await writeFile(doneMarker, JSON.stringify({ exit: code, elapsed }, null, 1), "utf8");
    const verdict = readNotMeasured(await factsText(join(paths.outRoot, driver.out)));
    if (verdict !== null) {
      notMeasuredCount += 1;
      notMeasuredKeys.push(`${driver.key}:${verdict.reason}`);
      log(
        `  NOT-MEASURED ${driver.key}: ${verdict.reason}${verdict.detail.length === 0 ? "" : ` - ${verdict.detail}`}`,
      );
    }
    const gap = readBlockedByProduct(await factsText(join(paths.outRoot, driver.out)));
    if (gap !== null) {
      blockedByProductCount += 1;
      blockedByProductKeys.push(`${driver.key}:${gap.gap}`);
      log(`  BLOCKED-BY-PRODUCT ${driver.key}: ${gap.gap}${gap.detail.length === 0 ? "" : ` - ${gap.detail}`}`);
    }
  }

  // `skipped` used to mean "filtered out by --driver=", so a driver skipped by a done marker was counted as
  // neither skipped nor failed - and a stage where every marker already existed printed
  // `failed=0 of 20 (skipped=0)` and exited 0 above eight-day-old screenshots. A run that executed nothing
  // verified nothing, so it is a failure with its own exit code rather than a pass.
  log(
    `DONE-CAPTURE failed=${failed} of ${selected.length} ran=${executed.length} skipped=${skippedByMarker} not-selected=${DRIVERS.length - selected.length} not-measured=${notMeasuredCount} blocked-by-product=${blockedByProductCount}${
      failedKeys.length === 0 ? "" : ` failed-drivers=[${failedKeys.join(",")}]`
    }${notMeasuredKeys.length === 0 ? "" : ` not-measured-drivers=[${notMeasuredKeys.join(",")}]`}${
      blockedByProductKeys.length === 0 ? "" : ` blocked-by-product-drivers=[${blockedByProductKeys.join(",")}]`
    }`,
  );
  if (selected.length === 0) {
    log(`capture_selected_nothing: --driver= matched none of ${DRIVERS.length} drivers, so this run verified nothing`);
    process.exit(4);
  }
  if (executed.length === 0) {
    log(
      `capture_ran_nothing: every selected driver was skipped by a done marker in ${doneDir}, so this run verified nothing; pass --force or use a fresh --out`,
    );
    process.exit(4);
  }
  process.exit(failed === 0 ? 0 : 3);
}

function runDriver(driver, { port, cdpPort, run, paths, log }) {
  return new Promise((resolve) => {
    const driverFile = join(KIT_ROOT, "capture", driver.file);
    const proc = spawn(process.execPath, [driverFile, String(port), String(cdpPort)], {
      cwd: REPO_ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        GB_SHOTS_OUT: paths.outRoot,
        GB_SHOTS_REPO: REPO_ROOT,
        GB_SHOTS_CDP_PORT: String(cdpPort),
        GB_SHOTS_CREDENTIAL_PRESENT: run.credentialPresent === true ? "1" : "0",
        GB_SHOTS_WIRE_REQUESTS: paths.wireRequestsFile,
        GB_SHOTS_LAUNCH_STATE: paths.launchStateFile,
        GB_SHOTS_TAG: run.tag,
      },
    });
    // Recorded with the run's owner: a driver that outlives this phase whose command line names no
    // stage path is otherwise invisible to the run's teardown and to its post-run assertion.
    registerRunProcess(paths, { pid: proc.pid, role: `capture:${driver.key}` });
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length > 0) log(`  | ${line.trim()}`);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", (error) => log(`  spawn error: ${String(error).slice(0, 300)}`));
    proc.on("close", (code) => {
      if (buffer.trim().length > 0)
        for (const line of buffer.split("\n")) if (line.trim().length > 0) log(`  | ${line.trim()}`);
      resolve(code ?? 1);
    });
  });
}

await main().catch((error) => {
  console.log(`CAPTURE PHASE FAILED: ${String(error).slice(0, 800)}`);
  process.exit(3);
});
