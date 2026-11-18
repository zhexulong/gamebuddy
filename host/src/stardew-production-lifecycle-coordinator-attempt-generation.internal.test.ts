/**
 * `game.instance.generation` is a NUMBER ABOUT AN ATTEMPT, and this file is where that claim is
 * either true or decoration.
 *
 * The defect it was written against: the coordinator held
 * `const expectedPlayerHostInstanceGeneration = 1` and published it at the launch-ready moment, so
 * every inferior in every process was instance 1. A browser that had already started one game could
 * not name the next one, and the refusal it got for trying (`stardew_game_instance_generation_conflict`)
 * named the wrong fact - the Host had not seen a conflicting request, it had only ever had one number.
 *
 * Two readings, in this order, because the second is worthless without the first:
 *
 *  1. two attempts over one durable installation, driven through the real coordinator and the real
 *     Guardian session seam: the first publishes 1, the second publishes 2, and the second attempt
 *     actually starts (its reservation is not refused, its Player Host launch reaches the platform);
 *  2. a population gate over every source site that names the number - derived from a directory scan
 *     rather than a list - so a site added tomorrow cannot reintroduce the constant.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createDesktopGuardianGameRuntimePlatform,
  createStardewPlayerHostRuntimeLaunchCollaboratorFactory,
} from "./composition/stardew/stardew-guardian-platform.js";
import type { DesktopGuardianSession, GuardianRoleExit } from "./containment/auth/desktop-guardian-session.internal.js";
import {
  canonicalTemporaryRoot,
  containedSessionAck,
  createFixture,
  installLifecycleTestHooks,
  withWindowsPlatform,
} from "./stardew-production-lifecycle-coordinator.test-support.js";

installLifecycleTestHooks();

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/**
 * The SOURCE tree, not the compiled one this file is running from: a gate that read `host/dist-test`
 * would examine JavaScript no one edits and report a population that agrees with itself.
 */
const SOURCE_ROOT = join(REPOSITORY_ROOT, "host", "src");

/**
 * One Guardian session whose role exits this test publishes.
 *
 * It is the only thing in the process that can say the Player Host is gone, so it is also the only
 * thing that can end attempt 1 the way a player quitting the game ends it.
 */
function guardianSession(): Readonly<{
  session: DesktopGuardianSession;
  launches: string[];
  report(exit: GuardianRoleExit): void;
}> {
  const watchers: Array<(exit: GuardianRoleExit) => void> = [];
  const launches: string[] = [];
  const session: DesktopGuardianSession = Object.freeze({
    onRoleExit(handler: (exit: GuardianRoleExit) => void) {
      watchers.push(handler);
    },
    arm: async () => containedSessionAck("arm_attempt"),
    launch: async (input) => {
      launches.push(input.role);
      return containedSessionAck("launch_role", input.role);
    },
    contain: async (input) => containedSessionAck("contain_role", input.role),
    recover: async () => Object.freeze({ outcome: "contained" as const }),
    close: async () => undefined,
  });
  return Object.freeze({
    session,
    launches,
    report(exit: GuardianRoleExit): void {
      for (const watcher of watchers) watcher(exit);
    },
  });
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

/** Stages the fixture's Player Host and stops: the moment the browser is asked to name the instance. */
async function stagePlayerHost(fixture: Fixture): Promise<void> {
  await fixture.coordinator.activationOwner.activate(fixture.broker.issue("lifecycle_activation"));
  await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
    apiVersion: 1,
    idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
  });
}

async function launchPlayerHost(fixture: Fixture, generation: number, idempotencyKey: string): Promise<void> {
  await fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
    apiVersion: 1,
    idempotencyKey,
    expectedInstanceGeneration: generation,
  });
}

test("two attempts over one installation are instance 1 and instance 2, and the second one starts", async (t) => {
  await withWindowsPlatform(async () => {
    const runtimeRoot = await canonicalTemporaryRoot("gamebuddy-two-attempts-");
    const firstGuardian = guardianSession();
    const first = await createFixture({
      runtimeRoot,
      attempt: 1,
      overrides: {
        runtimeLaunchContained: createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
          createDesktopGuardianGameRuntimePlatform(firstGuardian.session),
        ),
      },
    });
    let firstReady: number;
    try {
      await stagePlayerHost(first);
      firstReady = first.coordinator.launchReadinessReader.readLaunchReadinessView().generation;
      t.diagnostic(`attempt 1: launch-ready generation ${firstReady}`);
      assert.equal(firstReady, 1, "the first instance of this installation is 1");
      // The browser names the instance it means, and the Host accepts exactly that number.
      await launchPlayerHost(first, firstReady, "BCEiM0RVZneImaq7zN3u_w");
      assert.deepEqual(firstGuardian.launches, ["player_host"], "attempt 1 launched the Player Host");
      // The player quits the game: the Guardian reports the native exit of the Player Host role.
      firstGuardian.report(Object.freeze({ role: "player_host", exitCode: 0 }));
    } finally {
      await first.coordinator.close();
      await first.broker.close();
    }

    const secondGuardian = guardianSession();
    const second = await createFixture({
      runtimeRoot,
      attempt: 2,
      seedRegistration: false,
      overrides: {
        runtimeLaunchContained: createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
          createDesktopGuardianGameRuntimePlatform(secondGuardian.session),
        ),
      },
    });
    try {
      // The boot pass every attempt runs: the ended attempt's registration pointer is released
      // only on the OS's proof that its Guardian-owned objects are gone.
      const reconcile = await second.coordinator.reconcileHeldBootstrapRegistration();
      t.diagnostic(
        `attempt 2: reconcile examined ${reconcile.examined} · released ${reconcile.released} · ` +
          `finalised ${reconcile.finalised} · ${JSON.stringify(reconcile.records.map((record) => record.outcome))}`,
      );
      assert.equal(reconcile.examined, 1, "the ended attempt is the one record the boot pass had to read");
      assert.equal(reconcile.released, 1, "and it released it, which is what lets attempt 2 reserve at all");

      // The reservation attempt 2 makes is the one `dbe8d84e` recorded as refused. If it still were,
      // this stage would throw and nothing after it would run.
      await stagePlayerHost(second);
      const secondReady = second.coordinator.launchReadinessReader.readLaunchReadinessView().generation;
      t.diagnostic(`attempt 2: launch-ready generation ${secondReady}`);
      assert.equal(secondReady, 2, "the second instance of the same installation is 2, not 1");
      await launchPlayerHost(second, secondReady, "BCEiM0RVZneImaq7zN3u_w");
      t.diagnostic(`attempt 2: Player Host launches ${JSON.stringify(secondGuardian.launches)}`);
      assert.deepEqual(secondGuardian.launches, ["player_host"], "and the second attempt actually starts");
    } finally {
      await second.coordinator.close();
      await second.broker.close();
    }
  });
});

/**
 * The number the browser is handed, and the number it is checked against, must both be the attempt's.
 *
 * The population is derived from the type that CARRIES the number - `StardewGameSurfaceLaunchReadinessView`
 * - rather than from a file list: any file that names the view is a file whose `generation:` lines are
 * sites, so a new publisher is in the population the moment it is written. Every site is then classified
 * by what it names:
 *
 *  - `origin`   - the declaration's zero: "this lifecycle has not bound an attempt". The only literal
 *                 the number is allowed to be, because it is not a number ABOUT any instance.
 *  - `derived`  - an expression that reaches the attempt (the durable record's number, the variable
 *                 that holds it, or the view field that carries it).
 *  - `constant` - a literal in the number's position. This is the defect.
 */
type Site = Readonly<{ file: string; line: number; text: string; kind: "origin" | "derived" | "constant" }>;

const NUMBER_TOKEN = "PlayerHostInstanceGeneration";
const CARRIER_TYPE = "StardewGameSurfaceLaunchReadinessView";

function findingsOf(files: readonly Readonly<{ file: string; source: string }>[]): Readonly<{
  files: number;
  carriers: number;
  examined: number;
  derived: number;
  constant: number;
  findings: readonly string[];
}> {
  const sites: Site[] = [];
  const findings: string[] = [];
  let carriers = 0;
  for (const { file, source } of files) {
    const carriesTheView = source.includes(CARRIER_TYPE);
    if (carriesTheView) carriers += 1;
    for (const [index, text] of source.split("\n").entries()) {
      const named = new RegExp(`\\b\\w*${NUMBER_TOKEN}\\w*\\s*[=!]==?\\s*(.+?)\\);?$`, "iu").exec(text);
      const assignment = new RegExp(`^\\s*(?:let|const|var)\\s+\\w*${NUMBER_TOKEN}\\w*\\s*=\\s*(.+?);?$`, "iu").exec(
        text,
      );
      const reassignment = new RegExp(`^\\s*\\w*${NUMBER_TOKEN}\\w*\\s*=\\s*(.+?);?$`, "iu").exec(text);
      const publication = carriesTheView ? /^\s*generation:\s*(.+?),?$/u.exec(text) : null;
      const candidate = assignment?.[1] ?? reassignment?.[1] ?? publication?.[1] ?? named?.[1];
      if (candidate === undefined) continue;
      const kind: Site["kind"] = /^\d+$/u.test(candidate.trim())
        ? candidate.trim() === "0"
          ? "origin"
          : "constant"
        : "derived";
      sites.push(Object.freeze({ file, line: index + 1, text: text.trim(), kind }));
    }
  }
  for (const site of sites) {
    if (site.kind !== "constant") continue;
    findings.push(`constant_instance_generation:${site.file}:${site.line} names ${site.text}`);
  }
  // Fail on zero: a population that found nothing agrees with itself.
  if (carriers === 0) findings.push("no_launch_readiness_view_in_population");
  if (sites.length === 0) findings.push("no_instance_generation_site_examined");
  return Object.freeze({
    files: files.length,
    carriers,
    examined: sites.length,
    derived: sites.filter((site) => site.kind !== "constant").length,
    constant: sites.filter((site) => site.kind === "constant").length,
    findings: Object.freeze(findings),
  });
}

/** Every source file under `host/src`, because a site can be added anywhere the number travels. */
function sourceFiles(
  directory: string = SOURCE_ROOT,
  prefix = "",
): readonly Readonly<{ file: string; source: string }>[] {
  const files: Array<Readonly<{ file: string; source: string }>> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    const file = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path, file));
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    files.push(Object.freeze({ file, source: readFileSync(path, "utf8") }));
  }
  return Object.freeze(files);
}

test("a_generation_counts_the_instances_it_names: every site reads the number from the attempt", (t) => {
  const files = sourceFiles();
  const reading = findingsOf(files);
  t.diagnostic(
    `a_generation_counts_the_instances_it_names: files examined ${reading.files} · carrying the view ` +
      `${reading.carriers} · readers examined ${reading.examined} · derived ${reading.derived} · constant ${reading.constant}`,
  );
  assert.ok(
    reading.carriers >= 2,
    `the launch-readiness view is named by its publisher and its projection, saw ${reading.carriers}`,
  );
  assert.ok(
    reading.examined >= 3,
    `the scan found the declaration, the publication and the comparator, saw ${reading.examined}`,
  );
  assert.deepEqual(reading.findings, []);
});

/**
 * The falsifier, and it is the real defect rather than a lookalike: the constant this unit replaced,
 * fed to the same rule. If this passes, the rule above proves nothing.
 */
test("a_generation_counts_the_instances_it_names (falsifier): the constant is named at its own site", (t) => {
  const planted = findingsOf([
    Object.freeze({
      file: "stardew-production-lifecycle-coordinator.internal.ts",
      source: [
        "  const expectedPlayerHostInstanceGeneration = 1;",
        '  const view: StardewGameSurfaceLaunchReadinessView = Object.freeze({\n    generation: 1,\n    status: "ready",\n  });',
        '  return Object.freeze({ generation: expectedPlayerHostInstanceGeneration, status: "ready" });',
        "  if (command.expectedInstanceGeneration !== expectedPlayerHostInstanceGeneration) refuse();",
      ].join("\n"),
    }),
    Object.freeze({
      file: "game-browser-state-provider.ts",
      source: [
        '  const view: StardewGameSurfaceLaunchReadinessView = { generation: 0, status: "none", playerHostExitCode: null };',
        "  generation: 1,",
      ].join("\n"),
    }),
  ]);
  t.diagnostic(
    `falsifier: readers examined ${planted.examined} · derived ${planted.derived} · constant ${planted.constant} · ` +
      planted.findings.join(" | "),
  );
  assert.equal(planted.constant, 3);
  assert.match(
    planted.findings[0]!,
    /constant_instance_generation:stardew-production-lifecycle-coordinator\.internal\.ts:1 /u,
  );
  assert.match(
    planted.findings[1]!,
    /constant_instance_generation:stardew-production-lifecycle-coordinator\.internal\.ts:3 /u,
  );
  assert.match(planted.findings[2]!, /constant_instance_generation:game-browser-state-provider\.ts:2 /u);
  // The same rule over the real tree is not simply always-red.
  assert.deepEqual(findingsOf(sourceFiles()).findings, []);
});
