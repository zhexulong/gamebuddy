// A bare worktree does not populate git submodules, and the pin must say so instead of letting an empty
// directory become a module error four steps later.
//
// Measured 2026-11-25 (round32 attempt 1, `D:\gb-runs\round32-out`, kit run FROM a bare worktree):
// `git worktree add --detach` left `vendor/{pi-koe,magic-context}` empty, `pin.ps1` §2 faithfully
// junctioned those empty directories into the stage worktree, and the first symptom was
//   code: 'ERR_MODULE_NOT_FOUND',
//   url: 'file:///D:/gb-runs/round32-out.stage/worktree/vendor/pi-koe/scripts/build-release-artifact.mjs'
// at generation-build step 4 - after the host typecheck, the Mod build and the reclaimer had all been
// paid for. Two live rounds were spent on it. The same run then supplied three artifacts by hand
// (`git submodule update --init` at the pin's recorded commits, `magic-context/packages/pi-plugin/dist`
// copied after proving the product's submodule was at the same commit with clean source, and pi-koe's
// two `tsc --project` runs invoked directly because pnpm's pre-run check aborts on a junctioned
// `node_modules`). Those three hand steps are the pin's §2/§2b now, and these tests drive the real
// `pin.ps1` to prove it: an empty submodule is NAMED before any build, the supply at the recorded
// commit then succeeds end to end, and a submodule at a commit the pin does not record is refused with
// both commits named.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN_SCRIPT = fileURLToPath(new URL("./pin.ps1", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const HOST_TYPESCRIPT = join(REPO_ROOT, "host", "node_modules", "typescript");
const DOTNET_SDK_LOCK = join(REPO_ROOT, "host", "scripts", "dotnet-sdk-lock.mjs");

/** The two native helpers §4c copies, each with the builder the pin hands to `verified-helper-pair.mjs`. */
const HELPERS = [
  { name: "windows-stale-lock-reclaimer", module: "build-windows-stale-lock-reclaimer.mjs" },
  { name: "windows-stardew-folder-picker", module: "build-windows-stardew-folder-picker.mjs" },
];

function seedFile(path, body = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { windowsHide: true, encoding: "utf8" }).trim();
}

function commitAll(repo, message) {
  git(repo, ["add", "-A", "--force"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=pin@test", "-c", "user.name=pin", "commit", "-q", "-m", message], {
    windowsHide: true,
  });
  return git(repo, ["rev-parse", "HEAD"]);
}

/** A tiny repository standing in for one submodule origin, with one commit per version handed out. */
function seedSubmoduleOrigin(path, files) {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-q"]);
  for (const [relative, body] of Object.entries(files)) seedFile(join(path, relative), body);
  return commitAll(path, "origin");
}

/**
 * The pinned repository: everything `pin.ps1` §1-§4d reads from the main checkout, as placeholders, plus
 * the two submodules as real gitlinks whose origins are local paths.
 *
 * `protocol.file.allow=always` is set in the fixture's config because a local-path submodule origin is
 * otherwise refused by this git; the live pin clones the real ssh urls.
 */
async function seedPinnedRepo(root) {
  const repo = join(root, "repo");
  const piKoeOrigin = join(root, "origin", "pi-koe");
  const magicContextOrigin = join(root, "origin", "magic-context");

  // The gateway's own two-project layout, which `build:all` compiles protocol-first. The fixture keeps the
  // two projects independent: a source that imported the package would need the install's
  // `@gamebuddy/voice-protocol` link, and the install is not what this test is about.
  seedSubmoduleOrigin(piKoeOrigin, {
    "package.json": '{"name":"pi-koe","private":true,"type":"module"}\n',
    "tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmitOnError: true, outDir: "dist", rootDir: "src", skipLibCheck: true }, include: ["src/**/*.ts"] }, null, 2)}\n`,
    "src/main.ts": 'export const main = "gateway";\n',
    "packages/voice-protocol/package.json": '{"name":"@gamebuddy/voice-protocol","private":true,"type":"module"}\n',
    "packages/voice-protocol/tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmitOnError: true, declaration: true, outDir: "dist", rootDir: "src", skipLibCheck: true }, include: ["src/**/*.ts"] }, null, 2)}\n`,
    "packages/voice-protocol/src/index.ts": 'export const protocol = "v1";\n',
  });
  const magicContextPin = seedSubmoduleOrigin(magicContextOrigin, {
    "packages/pi-plugin/package.json": '{"name":"@cortexkit/pi-magic-context","type":"module"}\n',
    "packages/pi-plugin/src/index.ts": 'export const plugin = "magic-context";\n',
  });

  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);

  // §1, §3, §4, §4b: the placeholders the pin junctions or copies.
  seedFile(join(repo, "node_modules", ".gitkeep"));
  seedFile(join(repo, "host", "node_modules", "typescript", "lib", "tsc.js"));
  seedFile(join(repo, "dialogue-web", "node_modules", "vite", "bin", "vite.js"));
  for (const sibling of ["rolldown", "postcss", "esbuild", "picomatch", "tinyglobby", "jiti", "lightningcss", "yaml"])
    seedFile(join(repo, "node_modules", ".pnpm", "node_modules", sibling, ".gitkeep"));

  // §4d: the launcher exports the pin refuses a commit without.
  seedFile(
    join(repo, "tools", "desktop-composition-launch.mjs"),
    `${[
      "launchDesktopCompositionGateChild",
      "desktopCompositionMutableRootPaths",
      "measureDesktopCompositionRunRoots",
      "assertDesktopCompositionRunRoots",
      "readDesktopCompositionRuntimeRoot",
      "readProductionPointer",
    ]
      .map((name) => `export function ${name}() {}`)
      .join("\n")}\n`,
  );

  // §4c: both helpers, each beside the pair ITS OWN builder accepts (`canonicalManifest`), so the
  // acceptance rule is never re-spelled here.
  seedFile(join(repo, "host", "scripts", "dotnet-sdk-lock.mjs"), readFileSync(DOTNET_SDK_LOCK, "utf8"));
  for (const helper of HELPERS) {
    const builderPath = join(repo, "host", "scripts", helper.module);
    seedFile(builderPath, readFileSync(join(REPO_ROOT, "host", "scripts", helper.module), "utf8"));
    const builder = await import(pathToFileURL(builderPath).href);
    const binary = `the ${helper.name} this fixture published\n`;
    const pairRoot = join(repo, "host", "native", helper.name, ".dist", "win-x64");
    seedFile(join(pairRoot, builder.helperFileName), binary);
    seedFile(
      join(pairRoot, builder.manifestFileName),
      builder.canonicalManifest(createHash("sha256").update(binary).digest("hex")),
    );
  }

  git(repo, ["config", "protocol.file.allow", "always"]);
  git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", piKoeOrigin, "vendor/pi-koe"]);
  git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", magicContextOrigin, "vendor/magic-context"]);
  const pinnedSha = commitAll(repo, "pin");
  const piKoePin = git(repo, ["rev-parse", `${pinnedSha}:vendor/pi-koe`]);

  // A commit the pin does NOT record, fetched into the checkout's submodule clone so test 3 can leave
  // that checkout drifted forward while the gitlink still records `piKoePin`.
  seedFile(join(piKoeOrigin, "src/main.ts"), 'export const main = "gateway-2";\n');
  const piKoeSecond = commitAll(piKoeOrigin, "second");
  git(join(repo, "vendor", "pi-koe"), ["fetch", "-q", "origin"]);

  // The candidate artifacts §2b consumes, in the checkout that holds the submodules: tsc from the
  // repository's real install (so the fixture's compiles are real), and the two gitignored build
  // outputs a `bun`/`pnpm` run would have left behind.
  mkdirSync(join(repo, "vendor", "pi-koe", "node_modules"), { recursive: true });
  symlinkSync(HOST_TYPESCRIPT, join(repo, "vendor", "pi-koe", "node_modules", "typescript"), "junction");
  seedFile(join(repo, "vendor", "pi-koe", "node_modules", "esbuild", "package.json"), '{"name":"esbuild"}\n');
  seedFile(
    join(repo, "vendor", "magic-context", "packages", "pi-plugin", "dist", "index.js"),
    'export const plugin = "magic-context";\n',
  );

  return {
    repo,
    piKoeOrigin,
    piKoePin,
    piKoeSecond,
    magicContextPin,
    stageRoot: join(root, "shots.stage"),
    worktree: join(root, "shots.stage", "worktree"),
    logPath: join(root, "pin.log"),
  };
}

function runPin(fixture) {
  // `GIT_ALLOW_PROTOCOL=file` is what lets the fixture's local-path submodule origins stand in for the
  // product's ssh urls: this git refuses the `file` transport by default, and the pin must not need to
  // know that. The live pin clones `git@github.com:...` and needs no such allowance.
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        PIN_SCRIPT,
        "-Repo",
        fixture.repo,
        "-Worktree",
        fixture.worktree,
        "-StageRoot",
        fixture.stageRoot,
        "-Commit",
        "HEAD",
        "-Log",
        fixture.logPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" } },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("close", (code) => resolve({ code, output }));
  });
}

test(
  "an empty submodule is named before any build, and the supply at the recorded commit then succeeds",
  { timeout: 300_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "gb-pin-submodule-"));
    let fixture;
    try {
      fixture = await seedPinnedRepo(root);
      // The origin is away, so the supply cannot succeed: the state a machine with an unreachable
      // submodule url is in. It must be named at §2, not surface later as a module error.
      const hidden = `${fixture.piKoeOrigin}.away`;
      renameSync(fixture.piKoeOrigin, hidden);

      const refused = await runPin(fixture);
      const refusedLog = readFileSync(fixture.logPath, "utf8");

      assert.match(
        refusedLog,
        new RegExp(`submodule_empty: vendor/pi-koe \\(the pin records ${fixture.piKoePin}`, "u"),
        `the empty checkout must be named at the step that meets it; the pin said:\n${refusedLog.slice(-3000)}`,
      );
      assert.match(refusedLog, /submodule_supply_failed: vendor\/pi-koe/u);
      assert.match(refusedLog, /DONE-PIN-FAIL \(a submodule the pin needs is not in the worktree\)/u);
      assert.equal(refused.code, 1, `the pin must refuse; it said:\n${refused.output.slice(-2000)}`);

      // The whole point: nothing downstream was paid for. Before this the first sign came at build
      // step 4, after the host typecheck, the Mod build and the reclaimer.
      for (const marker of [
        "=== 3. host/node_modules",
        "=== 4. dialogue-web/node_modules",
        "=== 4c. native helper pairs",
        "=== 5. CONTAINMENT CHECK ===",
      ]) {
        assert.ok(!refusedLog.includes(marker), `the pin ran past the empty submodule into "${marker}"`);
      }
      assert.doesNotMatch(refusedLog, /DONE-PIN$/mu, "the pin ended as a success with an empty submodule");

      // Recovery: the origin is back and the same --out succeeds. The stage still holds the failed run's
      // worktree, so this also exercises §1's re-create next to the new supply.
      renameSync(hidden, fixture.piKoeOrigin);
      const supplied = await runPin(fixture);
      const suppliedLog = readFileSync(fixture.logPath, "utf8");

      assert.equal(
        supplied.code,
        0,
        `the pin must succeed once the submodule can be supplied; it said:\n${supplied.output.slice(-3000)}`,
      );
      assert.doesNotMatch(
        suppliedLog,
        /submodule_supply_failed:/u,
        "a submodule the pin supplied was reported as failed",
      );
      assert.match(
        suppliedLog,
        new RegExp(`submodule_supplied: vendor/pi-koe ${fixture.piKoePin} \\(\\d+ files\\)`, "u"),
        `a supplied submodule must name its path, its commit and how much it supplied:\n${suppliedLog.slice(-3000)}`,
      );
      assert.match(
        suppliedLog,
        new RegExp(`submodule_supplied: vendor/magic-context ${fixture.magicContextPin} \\(\\d+ files\\)`, "u"),
      );
      // §2b: the three artifacts round32 had to supply by hand.
      assert.match(
        suppliedLog,
        /pi_koe_node_modules_junctioned: .*\(that checkout's pi-koe is at .*, the commit this pin records\)/u,
      );
      assert.match(
        suppliedLog,
        /pi_koe_dist_compiled: voice-protocol exit=0 entry=vendor\\pi-koe\\packages\\voice-protocol\\dist\\index\.js/u,
      );
      assert.match(suppliedLog, /pi_koe_dist_compiled: voice-gateway exit=0 entry=vendor\\pi-koe\\dist\\main\.js/u);
      assert.match(
        suppliedLog,
        new RegExp(
          `magic_context_dist_supplied: .*source_sha=${fixture.magicContextPin} pin=${fixture.magicContextPin} source_clean=yes \\(\\d+ files\\)`,
          "u",
        ),
        `the copied build output must carry the proof it was copied from:\n${suppliedLog.slice(-3000)}`,
      );
      assert.match(suppliedLog, /DONE-PIN$/mu);
      // The no-overlay proof still holds with real submodule checkouts and their build outputs in place.
      assert.match(suppliedLog, /worktree diff vs HEAD = \[\]/u);
    } finally {
      if (fixture)
        execFileSync("git", ["-C", fixture.repo, "worktree", "prune"], { windowsHide: true, stdio: "ignore" });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a submodule at a commit the pin does not record is refused with both commits named",
  { timeout: 300_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "gb-pin-submodule-sha-"));
    let fixture;
    try {
      fixture = await seedPinnedRepo(root);
      // The candidate checkout's pi-koe drifts forward: the gitlink still records the pinned commit while
      // the dependency install beside it was produced by a later one. Consuming that install is exactly
      // the unprovable supply this step exists to refuse.
      git(join(fixture.repo, "vendor", "pi-koe"), ["checkout", "-q", fixture.piKoeSecond]);
      assert.equal(git(join(fixture.repo, "vendor", "pi-koe"), ["rev-parse", "HEAD"]), fixture.piKoeSecond);

      const result = await runPin(fixture);
      const log = readFileSync(fixture.logPath, "utf8");

      assert.match(
        log,
        new RegExp(
          `submodule_mismatch: .*vendor\\\\pi-koe pin=${fixture.piKoePin} checkout=${fixture.piKoeSecond}`,
          "u",
        ),
        `the drift must name both commits; the pin said:\n${log.slice(-3000)}`,
      );
      assert.match(log, /pi_koe_node_modules_unavailable: .*examined \d+ checkout\(s\)/u);
      assert.equal(result.code, 1, `the pin must refuse; it said:\n${result.output.slice(-2000)}`);
      assert.match(log, /DONE-PIN-FAIL \(a submodule dependency install the pin needs is not on this machine\)/u);
      assert.ok(!log.includes("=== 3. host/node_modules"), "the pin ran past the unproven install into §3");
      assert.doesNotMatch(log, /DONE-PIN$/mu);
    } finally {
      if (fixture)
        execFileSync("git", ["-C", fixture.repo, "worktree", "prune"], { windowsHide: true, stdio: "ignore" });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a pin run FROM a bare worktree takes the install and the dist from the main worktree, by proof",
  { timeout: 300_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "gb-pin-from-worktree-"));
    let fixture;
    let lane;
    try {
      fixture = await seedPinnedRepo(root);
      const main = fixture.repo;
      // The round31/round32 recipe (`.tmp/lane-round31.md` §5): run the kit FROM a detached worktree at
      // the same commit. Its own `vendor/{pi-koe,magic-context}` are EMPTY stubs - that is what round32's
      // pin junctioned into the stage, and what killed its generation build on a missing module - so the
      // install and the dist can only come from the main worktree, and only through this step's proof.
      // (The recipe also junctions the three `node_modules` by hand; the fixture commits those as
      // placeholders, so here they are already in the worktree.)
      lane = join(root, "lane");
      git(main, ["worktree", "add", "--detach", lane, "HEAD"]);
      assert.deepEqual(
        readdirSync(join(lane, "vendor", "pi-koe")),
        [],
        "the lane worktree must start with an empty submodule",
      );

      const result = await runPin({ ...fixture, repo: lane });
      const log = readFileSync(fixture.logPath, "utf8");

      assert.equal(
        result.code,
        0,
        `the pin must succeed from a bare worktree; it said:\n${result.output.slice(-3000)}`,
      );
      assert.match(log, new RegExp(`submodule_supplied: vendor/pi-koe ${fixture.piKoePin} \\(\\d+ files\\)`, "u"));
      assert.match(log, new RegExp(`pi_koe_node_modules_absent: ${lane.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")}`, "u"));
      assert.match(
        log,
        new RegExp(
          `pi_koe_node_modules_junctioned: ${main.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")}\\\\vendor\\\\pi-koe\\\\node_modules`,
          "u",
        ),
        `the install must come from the checkout that is at the recorded commit:\n${log.slice(-3000)}`,
      );
      assert.match(
        log,
        new RegExp(
          `magic_context_dist_supplied: ${main.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")}\\\\vendor\\\\magic-context`,
          "u",
        ),
      );
      assert.match(log, /pi_koe_dist_compiled: voice-gateway exit=0/u);
      assert.match(log, /DONE-PIN$/mu);
    } finally {
      if (fixture) {
        if (lane)
          execFileSync("git", ["-C", fixture.repo, "worktree", "remove", "--force", lane], {
            windowsHide: true,
            stdio: "ignore",
          });
        execFileSync("git", ["-C", fixture.repo, "worktree", "prune"], { windowsHide: true, stdio: "ignore" });
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
