#!/usr/bin/env node
/**
 * The three gate zones, and what each one actually needs before it can run.
 *
 * The failure this exists for: every suite used to be "the tests", so one CSS
 * edit ran a suite that wanted a built Host artifact and a Chromium port and
 * reported red for a reason that had nothing to do with the edit. The zones are
 * separated by dependency and lifecycle, and each zone declares its own
 * prerequisite here and *refuses by name* when the prerequisite is missing,
 * instead of failing somewhere inside a runner with an error about something
 * else.
 *
 *   static    - pure source/contract analysis. Needs the workspace's
 *               dependencies (and `tsx`, which lets node import the TypeScript
 *               sources) and nothing else: no build artifact, no browser, no
 *               socket. This is the zone a local commit runs.
 *   artifact  - builds and verifies a real browser artifact. Needs the artifact
 *               toolchain (`vite` + `vite.config.ts` + the manifest scripts);
 *               the suites build their own artifact into a private directory.
 *   mounted   - drives the shipped shell in Chromium. Needs an installed
 *               browser and the vite dev server on the one port the journeys
 *               bake into their URLs.
 *
 * The suites are read out of the zone commands themselves, so a suite cannot be
 * added to a command and skip its probe, and the port the fast zones must leave
 * alone is read out of `playwright.config.ts`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testsRoot = resolve(packageRoot, "tests");
const packageManifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));

const ZONES = Object.freeze({
  static: Object.freeze({
    script: "test:static",
    prerequisite:
      "the workspace dependencies of dialogue-web are installed and `tsx` is importable; " +
      "no build artifact, no browser, no listening socket",
  }),
  artifact: Object.freeze({
    script: "test:artifact",
    prerequisite:
      "the artifact toolchain is installed (`vite` CLI, `vite.config.ts`, the static-artifact manifest scripts); " +
      "the suites build the artifact they verify into a private staging directory",
  }),
  mounted: Object.freeze({
    script: "test:mounted",
    prerequisite:
      "`@playwright/test` and its Chromium browser are installed, and the vite dev server can own the journeys' port; " +
      "the zone must not share that port with the fast zones",
  }),
});

const refuse = (zone, reason, detail) => {
  process.stderr.write(
    `[zone:${zone}] refused: ${reason}\n` +
      `  declared prerequisite: ${ZONES[zone]?.prerequisite ?? "none (unknown zone)"}\n` +
      `  ${detail}\n`,
  );
  process.exit(2);
};

/** The zone's own command is the single source of truth for what it runs. */
const declaredSuites = (zone) => {
  const command = packageManifest.scripts?.[ZONES[zone].script];
  if (typeof command !== "string")
    refuse(zone, "zone_command_missing", `package.json declares no ${ZONES[zone].script} script`);
  return [...command.matchAll(/(?:^|\s)(tests\/[^\s"']+\.test\.mjs)/gu)].map((match) => match[1]);
};

/** The one port the mounted journeys bake into their URLs. */
const mountedPort = (() => {
  const config = readFileSync(resolve(packageRoot, "playwright.config.ts"), "utf8");
  const declared = /--port\s+(\d+)/u.exec(config)?.[1];
  if (declared === undefined)
    refuse("mounted", "journey_port_undeclared", "playwright.config.ts declares no --port for its dev server");
  return declared;
})();

/**
 * Zone 1's defining property: it reads source, not output. A pure-source suite
 * that starts reading a published generation would make every local commit need
 * a build again, so that is a refusal here rather than a runtime error later.
 */
const assertNoBuildArtifact = (suites) => {
  const artifactMarkers = ["current.json", "GAMEBUDDY_TAVERN_BROWSER_OUTPUT_ROOT", "host/dist", "generations/"];
  for (const suite of suites) {
    const source = readFileSync(resolve(packageRoot, suite), "utf8");
    const marker = artifactMarkers.find((candidate) => source.includes(candidate));
    if (marker !== undefined)
      refuse(
        "static",
        "static_suite_requires_build_artifact",
        `${suite} reads "${marker}", so it belongs to the artifact or mounted zone`,
      );
  }
};

/** The fast zones and the browser zone must not want the same port. */
const assertPortUnclaimed = (zone) => {
  const command = packageManifest.scripts[ZONES[zone].script];
  if (new RegExp(`(^|\\s)(--port\\s+)?${mountedPort}(\\s|$)`, "u").test(command))
    refuse(
      zone,
      "port_shared_with_mounted_zone",
      `${ZONES[zone].script} names port ${mountedPort}, which the mounted journeys own`,
    );
};

const assertInstalled = (zone, relativePath, reason, detail) => {
  if (!existsSync(resolve(packageRoot, relativePath))) refuse(zone, reason, detail);
};

/* ==========================================================================
   The mounted zone's port lock

   Two mounted zones at once share no code; they collide only on the one port
   their journeys bake in (4173). `playwright.config.ts` pins that port with
   `--strictPort`, so the loser cannot just pick another: vite dies on "Port
   4173 is already in use" and every journey reddens for a reason that has
   nothing to do with the product. The lock below is the structural fix: a
   departure lock on the port itself, so the second invocation waits for the
   first instead of colliding. `--run -- <command...>` is how `test:mounted`
   drives the whole run through the probe after the probe passes; the plain
   probe (which the conformance gate calls first, before its own playwright
   run) is unchanged.
   ========================================================================== */

const MOUNT_LOCK_TIMEOUT_MS = 300_000;

/** Parses `--run -- <command...>` off the invocation tail, or returns undefined. */
function runCommandOf(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    if (argv[index] !== "--run" || argv[index + 1] !== "--") continue;
    const command = argv.slice(index + 2);
    if (command.length === 0)
      refuse("mounted", "mounted_run_requires_command", "`--run -- <command...>` needs a command after the `--`");
    return command;
  }
  return undefined;
}

const runArgv = runCommandOf(process.argv.slice(2));

const MOUNT_LOCK_DIR = join(packageRoot, ".tmp", `mount-${mountedPort}.lock`);
const MOUNT_LOCK_OWNER = join(MOUNT_LOCK_DIR, "owner.json");

function mountLockOwner() {
  try {
    const owner = JSON.parse(readFileSync(MOUNT_LOCK_OWNER, "utf8"));
    return typeof owner?.pid === "number" && typeof owner?.startedAtMs === "number" ? owner : null;
  } catch {
    return null;
  }
}

function writeMountLockOwner() {
  writeFileSync(MOUNT_LOCK_OWNER, `${JSON.stringify({ pid: process.pid, startedAtMs: Date.now() })}\n`, "utf8");
}

function releaseMountedLock() {
  try {
    rmSync(MOUNT_LOCK_DIR, { recursive: true, force: true });
  } catch {
    /* nothing to release */
  }
}

async function holdMountedLock() {
  // `mkdirSync(recursive: false)` needs the PARENT to exist. `packageRoot` is a
  // checkout, but `packageRoot/.tmp` is ignored and untracked, so on a fresh
  // clone it does not exist - and its ENOENT was caught by the loop below,
  // misread as an unreadable stale lock, "cleaned" with a no-op rmSync and
  // retried with NO sleep. That is an unbounded busy loop that writes nothing:
  // measured in CI as `test:mounted` printing one line and then hanging for 106
  // and 50 minutes. Creating the parent first makes the lock the small atomic
  // act it was meant to be (EEXIST is the only expected failure).
  mkdirSync(dirname(MOUNT_LOCK_DIR), { recursive: true });
  const deadline = Date.now() + MOUNT_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(MOUNT_LOCK_DIR, { recursive: false });
      writeMountLockOwner();
      process.once("exit", releaseMountedLock);
      return;
    } catch {
      const owner = mountLockOwner();
      if (owner === null) {
        // The directory exists but holds no readable owner: a stale lock whose
        // holder died without cleanup. Removal is safe here - we have not bound
        // the port ourselves, so we cannot be racing a live holder - and the
        // next loop iteration retries the acquire.
        try {
          rmSync(MOUNT_LOCK_DIR, { recursive: true, force: true });
        } catch {
          /* another holder is removing it; the loop retries */
        }
        await sleep(250);
        continue;
      }
      const waited = Math.round((Date.now() - owner.startedAtMs) / 1000);
      process.stderr.write(
        `[zone:mounted] port ${mountedPort} is held by pid ${owner.pid} (${waited} s); waiting for the running mounted zone to release it\n`,
      );
      if (Date.now() > deadline)
        refuse(
          "mounted",
          "mounted_port_lock_timeout",
          `port ${mountedPort} stayed held by pid ${owner.pid} for ${MOUNT_LOCK_TIMEOUT_MS} ms; kill it or wait for it to finish`,
        );
      await sleep(250);
    }
  }
}

const probes = {
  static() {
    const suites = declaredSuites("static");
    if (suites.length === 0)
      refuse("static", "zone_command_empty", `${ZONES.static.script} names no tests/*.test.mjs suite`);
    const absent = suites.filter((suite) => !existsSync(resolve(packageRoot, suite)));
    if (absent.length > 0)
      refuse("static", "zone_suite_missing", `${ZONES.static.script} names suites that do not exist: ${absent.join(", ")}`);
    assertInstalled(
      "static",
      "node_modules/tsx/package.json",
      "workspace_dependencies_missing",
      "run `pnpm install` from the repository root: this zone imports the TypeScript sources through tsx",
    );
    assertNoBuildArtifact(suites);
    assertPortUnclaimed("static");
    return `${suites.length} suite file(s), no build artifact, no browser, no port`;
  },
  artifact() {
    const suites = declaredSuites("artifact");
    if (suites.length === 0)
      refuse("artifact", "zone_command_empty", `${ZONES.artifact.script} names no tests/*.test.mjs suite`);
    const absent = suites.filter((suite) => !existsSync(resolve(packageRoot, suite)));
    if (absent.length > 0)
      refuse("artifact", "zone_suite_missing", `${ZONES.artifact.script} names suites that do not exist: ${absent.join(", ")}`);
    assertInstalled(
      "artifact",
      "node_modules/vite/bin/vite.js",
      "artifact_build_toolchain_missing",
      "run `pnpm install` from the repository root: this zone builds a real artifact",
    );
    assertInstalled(
      "artifact",
      "vite.config.ts",
      "artifact_build_toolchain_missing",
      "the artifact build config is not in the tree",
    );
    assertInstalled(
      "artifact",
      "scripts/browser-artifact-manifest.mjs",
      "artifact_build_toolchain_missing",
      "the artifact manifest authority is not in the tree",
    );
    assertPortUnclaimed("artifact");
    return `${suites.length} suite file(s), artifact toolchain present, no port`;
  },
  async mounted() {
    // The zone is the whole journey directory, so the corpus, not a file list in
    // the command, is what has to be present.
    const journeys = readdirSync(testsRoot).filter((entry) => entry.endsWith(".spec.ts"));
    if (journeys.length === 0)
      refuse("mounted", "mounted_zone_empty", `no journey (*.spec.ts) in ${testsRoot}`);
    assertInstalled(
      "mounted",
      "node_modules/vite/bin/vite.js",
      "vite_dev_server_missing",
      "the journeys' own webServer command is not installed",
    );
    assertPortUnclaimed("static");
    assertPortUnclaimed("artifact");
    const { chromium } = await import("@playwright/test");
    if (!existsSync(chromium.executablePath()))
      refuse(
        "mounted",
        "playwright_browser_missing",
        `run \`pnpm exec playwright install --with-deps chromium\`: no Chromium at ${chromium.executablePath()}`,
      );
    // The journeys own one port (4173, `--strictPort`), so two mounted zones at
    // once is one failure that looks like the product's: the losing server
    // cannot bind and every journey reddens. The probe therefore acquires a
    // named lock on that port before the zone runs and holds it across the
    // whole run, so the second invocation waits instead of colliding. It is a
    // departure lock, not a port check (`assertPortUnclaimed` still guards the
    // fast zones against *sharing* the port in the first place): it is held
    // for the lifetime of the child, and `process.once("exit")` releases it
    // even when the child dies. `--run -- <command...>` is how `test:mounted`
    // drives the run through this holding probe; the plain probe (which the
    // conformance gate calls first, before its own playwright run) stays what
    // it was.
    if (runArgv !== undefined) {
      await holdMountedLock();
      const code = spawnSync(runArgv[0], runArgv.slice(1), {
        stdio: "inherit",
        cwd: packageRoot,
        shell: process.platform === "win32",
      }).status;
      releaseMountedLock();
      process.exit(code ?? 1);
    }
    return `${journeys.length} journey file(s), Chromium installed, dev server port ${mountedPort}`;
  },
};

/**
 * The `--run -- ...` mode is a zone invocation of its own, parsed before the
 * zone dispatch so the mounted probe can decide whether to hold the lock.
 * It must not be mistaken for the zone name.
 */
const zone = runArgv !== undefined ? "mounted" : process.argv[2];
if (zone === undefined || !Object.hasOwn(probes, zone))
  refuse(
    zone ?? "(none)",
    "unknown_zone",
    `usage: node tests/gate-zone-prerequisite.mjs ${Object.keys(probes).join("|")} [--run -- <command...>]`,
  );

const detail = await probes[zone]();
process.stdout.write(
  `[zone:${zone}] script=${ZONES[zone].script} prerequisite=${ZONES[zone].prerequisite} — ${detail}\n`,
);
