// Phase capture: run the capture drivers (tools/live-run/frontend/capture/*.cjs) over CDP against the product tab.
// Each driver is its own process; its per-item facts file <out>/<shortName>.txt is written by the
// driver itself (a driver is the only observer of the screenshots and reports computed layout facts).
// A driver whose per-run marker file exists is skipped unless --force, so a crashed driver can be
// re-run without redoing the survivors.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, access, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runPaths, loadRunConfig, REPO_ROOT, KIT_ROOT } from "../lib/config.mjs";
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
  /* The failed drivers by NAME. A count beside a mostly-green reconciliation is the shape the operator could
   * not act on: `failed=2 of 22` names nothing, and a reader has to go hunting through the log for which two.
   * The roster keys are printed in the DONE line so the failure and its owner are read together. */
  const failedKeys = [];
  const executed = [];
  const doneDir = join(paths.stateDir, "capture-done");
  await mkdir(doneDir, { recursive: true });
  for (const driver of selected) {
    const doneMarker = join(doneDir, `${driver.out}.driver-done`);
    if (!force && (await exists(doneMarker))) {
      skippedByMarker += 1;
      log(`SKIP ${driver.key} (done marker ${doneMarker} exists)`);
      continue;
    }
    executed.push(driver.key);
    log(`========== ${driver.key} ==========`);
    const started = Date.now();
    const code = await runDriver(driver, { port, cdpPort, run, paths, log });
    const elapsed = Math.round((Date.now() - started) / 1000);
    log(`  exit=${code} elapsed=${elapsed}s`);
    if (code !== 0) {
      failed += 1;
      failedKeys.push(driver.key);
      log(`  DRIVER ${driver.key} FAILED (exit ${code})`);
    }
    await writeFile(doneMarker, JSON.stringify({ exit: code, elapsed }, null, 1), "utf8");
  }

  // `skipped` used to mean "filtered out by --driver=", so a driver skipped by a done marker was counted as
  // neither skipped nor failed - and a stage where every marker already existed printed
  // `failed=0 of 20 (skipped=0)` and exited 0 above eight-day-old screenshots. A run that executed nothing
  // verified nothing, so it is a failure with its own exit code rather than a pass.
  log(
    `DONE-CAPTURE failed=${failed} of ${selected.length} ran=${executed.length} skipped=${skippedByMarker} not-selected=${DRIVERS.length - selected.length}${
      failedKeys.length === 0 ? "" : ` failed-drivers=[${failedKeys.join(",")}]`
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
