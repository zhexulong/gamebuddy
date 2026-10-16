// Phase capture: run the capture drivers (tools/shots/capture/*.cjs) over CDP against the product tab.
// Each driver is its own process; its per-item facts file <out>/<shortName>.txt is written by the
// driver itself (a driver is the only observer of the screenshots and reports computed layout facts).
// A driver whose per-run marker file exists is skipped unless --force, so a crashed driver can be
// re-run without redoing the survivors.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, access, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runPaths, loadRunConfig, REPO_ROOT, KIT_ROOT } from "../lib/config.mjs";

const DRIVERS = [
  { key: "a-surfaces", file: "a-surfaces.cjs", out: "a-surfaces.txt" },
  { key: "b-characters", file: "b-characters.cjs", out: "b-characters.txt" },
  { key: "c-settings", file: "c-settings.cjs", out: "c-settings.txt" },
  { key: "d-game", file: "d-game.cjs", out: "d-game.txt" },
  { key: "e-chats-rows", file: "e-chats-rows.cjs", out: "e-chats-rows.txt" },
  { key: "f-turn-variant", file: "f-turn-variant.cjs", out: "f-turn-variant.txt" },
  { key: "g-defects", file: "g-defects.cjs", out: "g-defects.txt" },
  { key: "h-probe", file: "h-probe.cjs", out: "h-probe.txt" },
  { key: "i-followup", file: "i-followup.cjs", out: "i-followup.txt" },
  { key: "j-card-import", file: "j-card-import.cjs", out: "j-card-import.txt" },
  { key: "k-chat-select", file: "k-chat-select.cjs", out: "k-chat-select.txt" },
];

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
  for (const driver of selected) {
    const doneMarker = join(paths.outRoot, `${driver.out}.driver-done`);
    if (!force && (await exists(doneMarker))) {
      log(`SKIP ${driver.key} (done marker ${doneMarker} exists)`);
      continue;
    }
    log(`========== ${driver.key} ==========`);
    const started = Date.now();
    const code = await runDriver(driver, { port, cdpPort, run, paths, log });
    const elapsed = Math.round((Date.now() - started) / 1000);
    log(`  exit=${code} elapsed=${elapsed}s`);
    if (code !== 0) {
      failed += 1;
      log(`  DRIVER ${driver.key} FAILED (exit ${code})`);
    }
    await writeFile(doneMarker, JSON.stringify({ exit: code, elapsed }, null, 1), "utf8");
  }

  log(`DONE-CAPTURE failed=${failed} of ${selected.length} (skipped=${DRIVERS.length - selected.length})`);
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
