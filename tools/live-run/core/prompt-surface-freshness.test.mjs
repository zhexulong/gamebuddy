import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertPromptSurfaceFresh,
  assessPromptSurfaceFreshness,
  PRODUCT_REFS,
  promptSurfacePopulation,
  promptSurfaceRefusal,
  promptSurfaceRuleFor,
} from "./prompt-surface-freshness.mjs";

/**
 * What these tests protect.
 *
 * Round 47 and round 48 were launched from a worktree whose `assets/tavern/presets/amber-game.json` was two commits
 * behind `main`, so both rounds measured a prompt whose chatter-forcing sentences had already been withdrawn and the
 * readings were attributed to the current prompt anyway. `tools/live-run/core/prompt-surface-freshness.mjs` refuses
 * that launch. This file makes each of its answers falsifiable:
 *
 *   - the POPULATION comes from the revision's tree and from declared rules, so a renamed prompt module joins by
 *     existing and a prompt test never joins at all;
 *   - "behind" is decided by PATCH equivalence, so a worktree that cherry-picked the prompt work is current (the
 *     failure that made a commit-identity comparison unusable) while one that did not is red;
 *   - a revision that is AHEAD is silent, which is the falsifier for comparing blobs alone;
 *   - an uncommitted edit is refused, because the run reads the worktree;
 *   - every way of being unable to answer is `not_measured` with a name, never a pass - including a population of
 *     zero, which would otherwise agree with itself;
 *   - the gate runs at the OUTERMOST layer that decides whether the launch exists at all: in the launch ladder,
 *     before the save copy, the deploy and any game process. Left in the inner runner it could only refuse a launch
 *     that had already paid for all three - measured 2026-11-14: two launches died at second 59 of a refused run, one
 *     of them after a 3.5 s SMAPI start and a 13.4 s wait for the Mod's bridge.
 *
 * The real-history case (`REAL_RED_REVISION`) is the tree the two rounds were actually launched from. A shallow
 * checkout cannot hold it and says so by name instead of passing.
 *
 * red-proof: history  `b13ed7fd`, the tree rounds 47 and 48 were launched from -> `live_run_prompt_surface_behind:
 *   assets/tavern/presets/amber-game.json:2 commits` with both subjects printed, exit 1
 * red-proof: inject  dropping `--cherry-pick` from the history call -> "the prompt fix that lands by cherry-pick is
 *   current" fails on `live_run_prompt_surface_behind:assets/tavern/presets/amber-game.json:1 commits` for a revision
 *   that holds the work under a new hash
 * red-proof: inject  counting a blob difference as "behind" without asking the history -> "a revision that is AHEAD
 *   of the branch is silent" fails with `live_run_prompt_surface_behind:assets/tavern/presets/amber-game.json:1 commits`
 * red-proof: inject  removing the worktree reading -> "an edit to the preset that no commit owns is dirty" fails, the
 *   assessment answering `current` for a prompt no commit owns
 * red-proof: inject  removing the shallow-clone refusal -> the shallow case answers from a truncated history instead of
 *   `live_run_prompt_surface_not_measured:shallow_clone`
 * red-proof: inject  making the prompt-module rule admit nothing -> "the modules that BUILD the model-facing prompt"
 *   fails, naming `host/src/game-surface-prompt-floor.ts` as outside the population
 * red-proof: inject  making an empty population pass -> "a population of zero refuses" fails, the gate agreeing with
 *   itself about nothing
 * red-proof: inject  no longer calling the gate from the launch ladder -> "the launch ladder calls the gate before the
 *   fixture, the deploy, the orchestrator and the game" fails with `assertPromptSurfaceFresh( is called nowhere`
 * red-proof: inject  calling the gate from the inner runner instead of the ladder -> the same test fails with
 *   `the launch no longer reaches: fixture_wait,save_copy,orchestrator,game_start`, and "there is one call site" fails
 *   naming the runner's second call
 */

/** The tree the two rounds were launched from: `amber-game.json` byte-identical to the commit before the fix. */
const REAL_RED_REVISION = "b13ed7fd";
const REAL_RED_PATH = "assets/tavern/presets/amber-game.json";
const REAL_RED_SUBJECTS = Object.freeze([
  "[persona] fix(persona): resolve prompt floor overlap by purging duplicate surface rules",
  "[persona] fix(persona): replace chatter-forcing positive prompts with action-intent and emote awareness",
]);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

const git = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const gitOk = (cwd, args) => {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
};

/** For the plumbing that reads a patch on stdin - `git patch-id` is the only one here. */
const gitPiped = (cwd, args, input) =>
  execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();

const scratch = [];
after(() => {
  for (const dir of scratch) writeFileSync(join(dir, ".keep-undone"), "");
});

const makeRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-surface-"));
  scratch.push(dir);
  git(dir, ["init", "-q", "."]);
  git(dir, ["config", "user.email", "gate@example.invalid"]);
  git(dir, ["config", "user.name", "prompt surface gate"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return dir;
};

const write = (dir, path, text) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text, "utf8");
};

const commit = (dir, message) => {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
};

const PRESET = "assets/tavern/presets/amber-game.json";
const preset = (bubble) => JSON.stringify({ prompts: [{ identifier: "jailbreak", content: bubble }] }, null, 2);

describe("the population is derived from the launched tree, never a hand list", () => {
  test("every member is admitted by exactly one named rule, and the population is not empty", () => {
    const population = promptSurfacePopulation({ repositoryRoot });
    assert.ok(
      population.length > 0,
      "an empty population agrees with itself; it must never be what a run is judged by",
    );
    for (const path of population)
      assert.notEqual(promptSurfaceRuleFor(path), null, `${path} is in the population but no rule admits it`);
    assert.equal(new Set(population).size, population.length, "the population names a path twice");
    // Printed, not assumed: the gate guidance is that a verdict without its population cannot be argued with.
    assert.ok(
      population.every((path) => promptSurfaceRuleFor(path) !== null),
      `population of ${population.length} path(s)`,
    );
  });

  test("the modules that BUILD the model-facing prompt are members, found by what they export", () => {
    const tree = git(repositoryRoot, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n");
    const sources = tree.filter((path) => /\.(?:ts|mjs)$/u.test(path) && !/\.test|\.spec/u.test(path));
    const population = promptSurfacePopulation({ repositoryRoot });
    // The authority is the tree's own text: a module that exports one of these builders composes the prompt, and a
    // builder that moves to a new module must take its membership with it.
    const builders = [
      "export function buildGameCompanionSystemPrompt",
      "export function buildChatCompanionSystemPrompt",
      "export function provisionLiveRunPersona",
    ];
    const declaring = [];
    for (const path of sources) {
      const text = readFileSync(join(repositoryRoot, path), "utf8");
      const declared = builders.filter((builder) => text.includes(builder));
      if (declared.length > 0) declaring.push({ path, declared });
    }
    assert.ok(
      declaring.length >= 2,
      `examined ${sources.length} source(s) and found ${declaring.length} prompt builder(s)`,
    );
    for (const { path, declared } of declaring)
      assert.ok(
        population.includes(path),
        `${path} exports ${declared.join("/")} - the text the model reads - but is not in the population`,
      );
  });

  test("the reviewed card directory the persona module reads is covered by the preset rule", () => {
    const persona = readFileSync(join(repositoryRoot, "tools/live-run/core/persona.mjs"), "utf8");
    const cardDir = /assets\/tavern\/presets\/[A-Za-z0-9._-]+/u.exec(persona)?.[0];
    assert.ok(cardDir, "persona.mjs no longer names a card directory; this reading needs a new anchor");
    const tree = git(repositoryRoot, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n");
    const files = tree.filter((path) => path.startsWith(`${cardDir}/`));
    assert.ok(files.length > 0, `examined ${tree.length} tracked path(s) and found none under ${cardDir}`);
    const population = promptSurfacePopulation({ repositoryRoot });
    for (const path of files)
      assert.ok(population.includes(path), `${path} is mounted as the run's persona but is not in the population`);
  });

  test("a prompt TEST is in the tree and is NOT in the population", () => {
    const testModule = "host/src/game-surface-prompt-floor.test.ts";
    assert.ok(
      gitOk(repositoryRoot, ["cat-file", "-e", `HEAD:${testModule}`]),
      `${testModule} must exist for this pair to mean anything`,
    );
    const population = promptSurfacePopulation({ repositoryRoot });
    assert.ok(!population.includes(testModule), "a test asserts about the prompt; the model does not read it");
    assert.ok(population.includes("host/src/game-surface-prompt-floor.ts"), "the module beside it must be a member");
  });

  test("a prompt module added to the tree joins by existing, and an unrelated module does not", () => {
    const dir = makeRepo();
    write(dir, PRESET, preset("first"));
    write(dir, "host/src/zz-scenario-prompt-floor.ts", "export const floor = 1;\n");
    write(dir, "host/src/zz-unrelated-plumbing.ts", "export const plumbing = 1;\n");
    commit(dir, "base");
    const population = promptSurfacePopulation({ repositoryRoot: dir });
    assert.deepEqual([...population].sort(), [PRESET, "host/src/zz-scenario-prompt-floor.ts"]);
  });
});

describe("behind is decided by patch equivalence, not by commit identity", () => {
  test("the tree rounds 47 and 48 were launched from is red, naming the path, the count and both subjects", (t) => {
    if (!gitOk(repositoryRoot, ["cat-file", "-e", `${REAL_RED_REVISION}:${REAL_RED_PATH}`])) {
      t.skip(`not measured: shallow_clone or missing history - ${REAL_RED_REVISION} is not in this object database`);
      return;
    }
    const assessment = assessPromptSurfaceFreshness({ repositoryRoot, revision: REAL_RED_REVISION });
    assert.equal(assessment.status, "behind");
    const finding = assessment.findings.find((entry) => entry.path === REAL_RED_PATH);
    assert.ok(finding, `expected ${REAL_RED_PATH} among ${assessment.findings.map((entry) => entry.path).join(",")}`);
    // The count is the number of subjects, not a branch measured once: `main` keeps moving, and this assertion used to
    // read `2` - the number of persona commits it held when this test was written - which went stale the moment two
    // more landed. The durable claim is the one the report is read for: every subject counted is a subject named.
    assert.equal(
      finding.count,
      finding.subjects.length,
      `count ${finding.count} against ${finding.subjects.length} subject(s)`,
    );
    // `%h %s`: the short hash is what the operator pastes into `git show`, the subject is what they read.
    for (const message of REAL_RED_SUBJECTS)
      assert.ok(
        finding.subjects.some((subject) => subject.endsWith(message)),
        `missing ${message}; got ${finding.subjects.join(" | ")}`,
      );
    const refusal = promptSurfaceRefusal(assessment);
    assert.ok(
      refusal.includes(`live_run_prompt_surface_behind:${REAL_RED_PATH}:${finding.count} commits`),
      `the failure code must name the path and the count; got:\n${refusal}`,
    );
    for (const message of REAL_RED_SUBJECTS)
      assert.ok(refusal.includes(message), `the operator must see what is missing: ${message}`);
  });

  test("the prompt fix that lands by cherry-pick is current; the same tree without it is red", () => {
    const dir = makeRepo();
    write(dir, PRESET, preset("第一拍本能接话"));
    const base = commit(dir, "base");
    write(dir, PRESET, preset("搭档优先"));
    const fixed = commit(dir, "withdraw the chatter forcing");

    // The falsifier first: the parent has the old prompt and the branch holds one commit it lacks.
    const before = assessPromptSurfaceFreshness({ repositoryRoot: dir, revision: base });
    assert.equal(before.status, "behind");
    assert.equal(before.findings.find((entry) => entry.path === PRESET)?.count, 1);

    // The defect shape: the same work, applied to a different parent, so the copy has a new identity. Commit
    // identity says "missing" (the fix commit is not an ancestor); patch equivalence says "contained", which is what
    // a launch needs to know. The branch carries its own unrelated commit, which is why the parent differs - without
    // it a cherry-pick onto the same parent reproduces the identical object and proves nothing.
    git(dir, ["checkout", "-q", "-b", "feature", base]);
    write(dir, "host/src/zz-unrelated-plumbing.ts", "export const plumbing = 1;\n");
    commit(dir, "the branch's own unrelated work");
    git(dir, ["cherry-pick", fixed]);
    assert.notEqual(
      git(dir, ["rev-parse", "HEAD"]),
      fixed,
      "the cherry-picked copy must have a different identity for this to be a test",
    );
    assert.equal(
      git(dir, ["rev-parse", `HEAD:${PRESET}`]),
      git(dir, ["rev-parse", `main:${PRESET}`]),
      "the copy must carry the branch's content",
    );
    const after = assessPromptSurfaceFreshness({ repositoryRoot: dir, revision: "feature" });
    assert.equal(after.status, "current", promptSurfaceRefusal(after));
    assert.equal(assertPromptSurfaceFresh({ repositoryRoot: dir, revision: "feature" }).examined, 1);

    // The case a blob comparison cannot decide: one more edit on top of the copied fix, so the content DIFFERS from
    // the branch while the branch's work is present. Only patch equivalence can answer it, and answering it the other
    // way (commit identity) would keep this tree red forever.
    write(dir, PRESET, preset("搭档优先，再说一句"));
    commit(dir, "a later edit on top of the copied fix");
    assert.notEqual(
      git(dir, ["rev-parse", `HEAD:${PRESET}`]),
      git(dir, ["rev-parse", `main:${PRESET}`]),
      "the content must differ from the branch for this to be the hard case",
    );
    const onTop = assessPromptSurfaceFreshness({ repositoryRoot: dir, revision: "feature" });
    assert.equal(onTop.status, "current", promptSurfaceRefusal(onTop));
  });

  test("a revision that is AHEAD of the branch is silent, although its prompt content differs", () => {
    const dir = makeRepo();
    write(dir, PRESET, preset("first"));
    commit(dir, "base");
    write(dir, PRESET, preset("second"));
    commit(dir, "the branch's own edit");
    git(dir, ["checkout", "-q", "-b", "ahead"]);
    write(dir, PRESET, preset("third"));
    const ahead = commit(dir, "one more edit, only on this revision");
    const assessment = assessPromptSurfaceFreshness({ repositoryRoot: dir, revision: ahead });
    assert.equal(assessment.status, "current", promptSurfaceRefusal(assessment));
    // The falsifier for a blob-only comparison: the contents DO differ between the revision and `main`.
    assert.notEqual(git(dir, ["rev-parse", `HEAD:${PRESET}`]), git(dir, ["rev-parse", `main:${PRESET}`]));
  });

  test("a product branch the revision lacks is a named refusal, and it throws that code", () => {
    const dir = makeRepo();
    write(dir, PRESET, preset("first"));
    commit(dir, "base");
    write(dir, PRESET, preset("second"));
    commit(dir, "the branch's own edit");
    const assessment = assessPromptSurfaceFreshness({ repositoryRoot: dir, revision: "HEAD~1" });
    assert.equal(assessment.status, "behind");
    assert.throws(
      () => assertPromptSurfaceFresh({ repositoryRoot: dir, revision: "HEAD~1" }),
      (error) => {
        assert.match(
          error.message,
          new RegExp(`live_run_prompt_surface_behind:${PRESET.replaceAll("/", "\\/")}:1 commits`, "u"),
        );
        return true;
      },
    );
  });
});

describe("what the run actually reads: an uncommitted prompt edit is refused", () => {
  test("an edit to the preset that no commit owns is dirty, and committing it clears the refusal", () => {
    const dir = makeRepo();
    write(dir, PRESET, preset("reviewed"));
    commit(dir, "reviewed prompt");
    appendFileSync(join(dir, PRESET), "\n", "utf8");
    const dirty = assessPromptSurfaceFreshness({ repositoryRoot: dir });
    assert.equal(dirty.status, "dirty", promptSurfaceRefusal(dirty));
    assert.equal(promptSurfaceRefusal(dirty).includes(`live_run_prompt_surface_dirty:${PRESET}`), true);
    assert.throws(() => assertPromptSurfaceFresh({ repositoryRoot: dir }), /live_run_prompt_surface_dirty/u);
    // Falsifier: the same tree, committed, is current.
    commit(dir, "now the prompt is owned");
    assert.equal(assessPromptSurfaceFreshness({ repositoryRoot: dir }).status, "current");
  });
});

describe("a comparison that cannot be made is not_measured with a name, never a pass", () => {
  test("no product branch", () => {
    const dir = makeRepo();
    write(dir, PRESET, preset("only branch"));
    commit(dir, "base");
    git(dir, ["branch", "-m", "trunk"]);
    const assessment = assessPromptSurfaceFreshness({ repositoryRoot: dir });
    assert.equal(assessment.status, "not_measured");
    assert.equal(assessment.reason, `no_product_ref:${PRODUCT_REFS.join(",")}`);
    assert.throws(
      () => assertPromptSurfaceFresh({ repositoryRoot: dir }),
      /live_run_prompt_surface_not_measured:no_product_ref:origin\/main,main/u,
    );
  });

  test("a population of zero refuses instead of agreeing with itself", () => {
    const dir = makeRepo();
    write(dir, "src/unrelated.ts", "export const nothing = 1;\n");
    commit(dir, "base");
    const assessment = assessPromptSurfaceFreshness({ repositoryRoot: dir });
    assert.equal(assessment.status, "not_measured");
    assert.equal(assessment.reason, "empty_population");
    assert.throws(
      () => assertPromptSurfaceFresh({ repositoryRoot: dir }),
      /live_run_prompt_surface_not_measured:empty_population/u,
    );
  });

  test("not a repository at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "prompt-surface-nogit-"));
    scratch.push(dir);
    const assessment = assessPromptSurfaceFreshness({ repositoryRoot: dir });
    assert.equal(assessment.status, "not_measured");
    assert.equal(assessment.reason, "no_git");
  });

  test("a revision that does not resolve", () => {
    const dir = makeRepo();
    write(dir, PRESET, preset("anything"));
    commit(dir, "base");
    const assessment = assessPromptSurfaceFreshness({ repositoryRoot: dir, revision: "no-such-revision" });
    assert.equal(assessment.status, "not_measured");
    assert.equal(assessment.reason, "revision_unresolved:no-such-revision");
  });

  test("a shallow clone cannot answer, and says so by name", () => {
    const origin = makeRepo();
    write(origin, PRESET, preset("first"));
    commit(origin, "base");
    write(origin, PRESET, preset("second"));
    commit(origin, "the branch's own edit");
    const clone = mkdtempSync(join(tmpdir(), "prompt-surface-shallow-"));
    scratch.push(clone);
    git(dirname(clone), ["clone", "--quiet", "--depth", "1", pathToFileURL(origin).href, clone]);
    assert.equal(git(clone, ["rev-parse", "--is-shallow-repository"]), "true", "the fixture must really be shallow");
    const assessment = assessPromptSurfaceFreshness({ repositoryRoot: clone });
    assert.equal(assessment.status, "not_measured");
    assert.equal(assessment.reason, "shallow_clone");
    assert.throws(
      () => assertPromptSurfaceFresh({ repositoryRoot: clone }),
      /live_run_prompt_surface_not_measured:shallow_clone/u,
    );
  });
});

/**
 * WHERE THE GATE RUNS is a property of the launch, so it is read as a PREDICATE over a source text rather than as a
 * list of `indexOf` comparisons: a predicate can be handed a source that violates the property, which is the only way
 * to show the guard would have caught the placement it exists for.
 *
 * The anchors are CALL SITES, not declarations: `waitForGameLaunched` is DEFINED near the top of the ladder and its
 * `markPhase("game_launched")` sits there, 300 lines before anything runs. Anchoring on that text would report the
 * game's start as earlier than the fixture's, and the guard would pass for the wrong reason forever.
 */
const LADDER = "tools/live-run/game/launch-ladder-live.mjs";
const RUNNER = "tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs";
const GATE_CALL = "assertPromptSurfaceFresh(";

const gateRunsBeforeTheLaunchStarts = (source) => {
  const anchors = Object.freeze({
    fixture_wait: "await waitForFreeFixture()",
    save_copy: 'markPhase("save_template_copied"',
    orchestrator: 'spawn(node, ["tools/_ladder-live-orchestrator.mjs"]',
    game_start: "await waitForGameLaunched({",
  });
  const gate = source.indexOf(GATE_CALL);
  if (gate === -1) return Object.freeze({ ok: false, why: `${GATE_CALL} is called nowhere` });
  const positions = {};
  const missing = [];
  for (const [name, needle] of Object.entries(anchors)) {
    positions[name] = source.indexOf(needle);
    if (positions[name] === -1) missing.push(name);
  }
  if (missing.length > 0)
    return Object.freeze({ ok: false, why: `the launch no longer reaches: ${missing.join(",")}` });
  const behind = Object.keys(anchors).filter((name) => positions[name] < gate);
  if (behind.length > 0) return Object.freeze({ ok: false, why: `the gate runs after: ${behind.join(",")}` });
  return Object.freeze({ ok: true, why: null });
};

describe("the gate refuses before the launch starts, at the outermost layer", () => {
  const ladder = readFileSync(join(repositoryRoot, LADDER), "utf8");
  const runner = readFileSync(join(repositoryRoot, RUNNER), "utf8");

  test("the launch ladder calls the gate before the fixture, the deploy, the orchestrator and the game", () => {
    assert.ok(
      ladder.includes('from "../core/prompt-surface-freshness.mjs"'),
      "the launch ladder is the entry point every Game live run passes through, so the gate must be imported there",
    );
    assert.ok(
      ladder.includes(`${GATE_CALL}{ repositoryRoot: repo })`),
      "the gate must be given the repository this run reads, resolved once by the ladder",
    );
    assert.notEqual(
      assertPromptSurfaceFresh.constructor.name,
      "AsyncFunction",
      "a synchronous refusal cannot be dropped by a forgotten await; an async one can",
    );
    const placement = gateRunsBeforeTheLaunchStarts(ladder);
    assert.ok(placement.ok, placement.why);
  });

  test("the placement predicate is falsifiable: a call below the orchestrator spawn is refused by it", () => {
    // The falsifier is the same property against a source that violates it: the real ladder, with its one gate
    // statement moved to the end of the file - i.e. after SMAPI has been spawned and the game has been waited for.
    const statement = ladder.split("\n").find((line) => line.includes(GATE_CALL));
    assert.notEqual(statement, undefined, `the ladder no longer calls ${GATE_CALL}`);
    const moved = `${ladder.replace(`${statement}\n`, "")}\n${statement}\n`;
    const placement = gateRunsBeforeTheLaunchStarts(moved);
    assert.equal(placement.ok, false, "the predicate accepted a gate that runs after the game was launched");
    assert.match(placement.why, /the gate runs after: fixture_wait,save_copy,orchestrator,game_start/u);
  });

  test("there is one call site: the inner runner does not bill every launch a second git query", () => {
    // The runner is only ever spawned by the ladder's orchestrator, so a second call there can never be the first to
    // speak - it could only repeat a 36.7 s reading this tree produced (measured 2026-11-14: the gate alone, refusing)
    // at 20 s into every launch that passed. One authority for one fact.
    assert.equal(
      runner.includes(GATE_CALL),
      false,
      "the inner runner calls the gate a second time; the ladder has already refused or accepted this exact worktree",
    );
    assert.equal(runner.includes("prompt-surface-freshness.mjs"), false, "the inner runner still imports the gate");
    assert.equal(ladder.split(GATE_CALL).length - 1, 1, "the ladder calls the gate more than once");
  });

  test("the ladder prints the population it accepted, so a silent launch is visible", () => {
    assert.ok(
      ladder.includes("[run] prompt surface current: ${promptSurface.examined} path(s) against"),
      "a launch that passed the gate must say what it examined",
    );
  });
});

/**
 * THE COST IS PART OF THE GATE. A check nobody can afford is moved, weakened or skipped, and this one was on the
 * critical path of every launch: `git log --cherry-pick --right-only` per differing path per ref hashes a patch for
 * every commit in the symmetric difference, whatever the pathspec says. Measured 2026-11-14 on this repository with a
 * SINGLE differing population path: 32,779 ms for the implementation this file protects, against 548-677 ms for the
 * one in the tree now - 46,767 ms between `launcher_start` and `prompt_surface_checked` on the tree a launch was
 * actually measured from. The reading that decides whether a run starts must not cost more than the run's first
 * minute, so the check reports its own terms and the suite refuses a report that is missing, fabricated or unbounded.
 *
 * WHAT THE ORACLE IS. `git log --cherry-pick --right-only` is git's own answer to "does this ref hold work this
 * revision lacks", and it stays in this file as the authority the fast implementation is checked against: the cheap
 * path computes patch ids per commit rather than per range, and a second hand-written copy of what "the same patch"
 * means would agree today and disagree later.
 */
const MODULE = "tools/live-run/core/prompt-surface-freshness.mjs";
const CHECK_LINE = "prompt_surface_check ";
const COST_BUDGET_MS = 5_000;

const runCheckModule = (repositoryRootArg, revision = "HEAD") =>
  spawnSync(
    process.execPath,
    [join(repositoryRoot, MODULE), "--repository-root", repositoryRootArg, "--revision", revision],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 1 << 26,
    },
  );

const reportedTimings = (result) => {
  const line = result.stderr.split("\n").find((entry) => entry.startsWith(CHECK_LINE));
  assert.notEqual(line, undefined, `the check printed no ${CHECK_LINE}line; stderr was:\n${result.stderr}`);
  return JSON.parse(line.slice(CHECK_LINE.length));
};

describe("the check reports its own cost, and that cost is bounded", () => {
  test("the gate prints its per-term timings, and the report is the check's measurement of this tree", () => {
    const population = promptSurfacePopulation({ repositoryRoot });
    const startedAt = performance.now();
    const result = runCheckModule(repositoryRoot);
    const wallClockMs = performance.now() - startedAt;
    const timings = reportedTimings(result);
    // The population, not a constant: a number that does not follow the tree it read is a number nobody can use.
    assert.equal(
      timings.paths,
      population.length,
      `the report claims ${timings.paths} path(s) for ${population.length}`,
    );
    for (const term of ["resolveMs", "lsTreeMs", "historyMs", "patchIdMs", "diffMs"])
      assert.equal(typeof timings[term], "number", `the report has no ${term}`);
    assert.ok(timings.gitCalls > 0, "a check that ran no git process cannot have read this tree");
    assert.ok(timings.totalMs > 0, "the report claims the check took no time at all");
    // The terms ARE the total, and the total is inside the wall clock: a report that outlives the process that printed
    // it, or that leaves an unnamed remainder, is not a measurement.
    const named = ["resolveMs", "lsTreeMs", "historyMs", "patchIdMs", "diffMs"].reduce(
      (sum, term) => sum + timings[term],
      0,
    );
    assert.ok(
      Math.abs(named - timings.totalMs) <= 5,
      `the terms (${named} ms) do not add up to the reported total (${timings.totalMs} ms)`,
    );
    assert.ok(
      wallClockMs >= timings.totalMs,
      `the check reports ${timings.totalMs} ms but the run that printed it took ${Math.round(wallClockMs)} ms`,
    );
    // The falsifier for `paths` being a constant: a fixture whose population is one path must say one path.
    const dir = makeRepo();
    write(dir, PRESET, preset("first"));
    commit(dir, "base");
    assert.equal(reportedTimings(runCheckModule(dir)).paths, 1, "the report does not follow the tree it read");
  });

  test("a path only one side changed is answered without hashing a patch; a path both sides changed is not", () => {
    // Nothing differs anywhere: no history walk at all.
    const identical = makeRepo();
    write(identical, PRESET, preset("first"));
    commit(identical, "base");
    const settled = assessPromptSurfaceFreshness({ repositoryRoot: identical });
    assert.equal(settled.status, "current");
    assert.equal(settled.timings.historyMs, 0, "a tree whose prompt content matches paid for a history walk");
    assert.equal(settled.timings.patchIdMs, 0, "a tree whose prompt content matches hashed a patch");

    // Only the branch changed the path: one history walk answers it, and no patch identity is needed - no commit of
    // the revision touches the path, so no patch of the revision's can be a copy.
    const branchOnly = makeRepo();
    write(branchOnly, PRESET, preset("first"));
    commit(branchOnly, "base");
    git(branchOnly, ["checkout", "-q", "-b", "feature"]);
    write(branchOnly, PRESET, preset("second"));
    commit(branchOnly, "the branch's own edit");
    const ahead = assessPromptSurfaceFreshness({ repositoryRoot: branchOnly, revision: "feature" });
    assert.equal(ahead.status, "current");
    assert.ok(ahead.timings.historyMs > 0, "the branch's change was never asked about");
    assert.equal(ahead.timings.patchIdMs, 0, "a one-sided change was priced as a patch-equivalence question");

    // Both sides changed it: now, and only now, the patches have to be hashed. Built from its own base, because a
    // cherry-pick onto a path already edited on the same line conflicts and a conflicted fixture proves nothing.
    const bothSides = makeRepo();
    write(bothSides, PRESET, preset("first"));
    const forkPoint = commit(bothSides, "base");
    write(bothSides, PRESET, preset("the product branch's fix"));
    const productFix = commit(bothSides, "the product branch's edit");
    git(bothSides, ["checkout", "-q", "-b", "feature", forkPoint]);
    // The branch needs its own commits before the pick, or the pick reproduces main's commit object and proves nothing.
    write(bothSides, "host/src/zz-unrelated-plumbing.ts", "export const plumbing = 1;\n");
    commit(bothSides, "the branch's own unrelated work");
    git(bothSides, ["cherry-pick", productFix]);
    write(bothSides, PRESET, preset("the product branch's fix, and the feature's own ending"));
    commit(bothSides, "the feature's own edit on top of the copied fix");
    assert.notEqual(blobAt(bothSides, "feature", PRESET), blobAt(bothSides, "main", PRESET));
    const ambiguous = assessPromptSurfaceFreshness({ repositoryRoot: bothSides, revision: "feature" });
    assert.equal(ambiguous.status, "current", promptSurfaceRefusal(ambiguous));
    assert.ok(ambiguous.timings.patchIdMs > 0, "two edits to one path were decided without comparing their patches");
  });

  test("the check stays inside its budget on this repository", () => {
    // 32,779 ms is what the `--cherry-pick` implementation cost on this tree with ONE differing path, and 46,767 ms
    // is what a launch spent on a tree that passed. The budget is 7x the new cost, so it is a ceiling on the shape of
    // the work rather than a stopwatch on the machine.
    const timings = reportedTimings(runCheckModule(repositoryRoot));
    assert.ok(
      timings.totalMs < COST_BUDGET_MS,
      `the check took ${timings.totalMs} ms of its own clock (budget ${COST_BUDGET_MS} ms): ${JSON.stringify(timings)}`,
    );
  });

  test("the check runs a fixed number of git processes, not one per population path per ref", () => {
    // The ceiling is the worst case of the shape this guard protects, term by term: resolving the root, the revision
    // and the refs; one tree read per revision; one history walk per ref, and a second only for a path it found work
    // on; two patch-id reads for a path both sides changed; the worktree comparison. Three processes per path per ref
    // is the shape this guard exists for - 48 of them on a sixteen-path population, before the history walk on top.
    const timings = reportedTimings(runCheckModule(repositoryRoot));
    const ceiling = 6 + 2 * timings.refs + 2 * timings.paths;
    assert.ok(
      timings.gitCalls <= ceiling,
      `the check ran ${timings.gitCalls} git process(es) for ${timings.paths} path(s) and ${timings.refs} ref(s), ceiling ${ceiling}`,
    );
  });
});

/**
 * The fast answer and git's own answer, on real trees. Each case is a tree the cheap algorithm could plausibly get
 * wrong: a real branch divergence with twelve missing prompt commits across five paths, a cherry-picked copy whose
 * content matches under a new hash, a later edit on top of that copy, a revision that is ahead, and a path both sides
 * changed where exactly one of the two branch commits is present.
 */
const blobAt = (dir, revision, path) => {
  try {
    return git(dir, ["rev-parse", "--verify", `${revision}:${path}`]);
  } catch {
    return null;
  }
};

const oracleFindings = ({ dir, revision, refs }) => {
  const commit = git(dir, ["rev-parse", "--verify", `${revision}^{commit}`]);
  const findings = [];
  for (const path of promptSurfacePopulation({ repositoryRoot: dir, revision: commit })) {
    const launched = blobAt(dir, commit, path);
    const holders = refs.filter((ref) => blobAt(dir, ref, path) !== launched);
    if (holders.length === 0) continue;
    const subjects = [];
    for (const ref of holders) {
      const found = git(dir, [
        "log",
        "--no-merges",
        "--cherry-pick",
        "--right-only",
        "--format=%h %s",
        `${commit}...${ref}`,
        "--",
        path,
      ])
        .split("\n")
        .filter((line) => line.length > 0);
      for (const subject of found) if (!subjects.includes(subject)) subjects.push(subject);
    }
    if (subjects.length > 0) findings.push({ path, count: subjects.length, subjects });
  }
  return findings;
};

const behindShape = (assessment) =>
  assessment.findings
    .filter((finding) => finding.kind === "behind")
    .map((finding) => ({ path: finding.path, count: finding.count, subjects: [...finding.subjects] }));

const assertMatchesPatchEquivalence = ({ dir, revision = "HEAD", refs = ["main"] }) => {
  const assessment = assessPromptSurfaceFreshness({ repositoryRoot: dir, revision, productRefs: refs });
  assert.deepEqual(
    behindShape(assessment),
    oracleFindings({ dir, revision: assessment.revision, refs }),
    `the check's findings differ from git's own patch equivalence on ${dir} at ${assessment.revision}`,
  );
  return assessment;
};

describe("the verdict is git's own patch equivalence, computed more cheaply", () => {
  test("the tree rounds 47 and 48 were launched from: every path, every missing commit", (t) => {
    if (!gitOk(repositoryRoot, ["cat-file", "-e", `${REAL_RED_REVISION}:${REAL_RED_PATH}`])) {
      t.skip(`not measured: shallow_clone or missing history - ${REAL_RED_REVISION} is not in this object database`);
      return;
    }
    // Five population paths and twelve missing commits on that tree: the case a per-path-only comparison, or a blob
    // comparison without the history, gets wrong in both directions.
    assertMatchesPatchEquivalence({ dir: repositoryRoot, revision: REAL_RED_REVISION, refs: ["main"] });
  });

  test("a cherry-picked copy is current, and an edit on top of the copy is still current", () => {
    const dir = makeRepo();
    write(dir, PRESET, preset("第一拍本能接话"));
    const base = commit(dir, "base");
    write(dir, PRESET, preset("搭档优先"));
    const fixed = commit(dir, "withdraw the chatter forcing");
    git(dir, ["checkout", "-q", "-b", "feature", base]);
    write(dir, "host/src/zz-unrelated-plumbing.ts", "export const plumbing = 1;\n");
    commit(dir, "the branch's own unrelated work");
    git(dir, ["cherry-pick", fixed]);
    assert.equal(
      blobAt(dir, "feature", PRESET),
      blobAt(dir, "main", PRESET),
      "the copy must carry the branch's content",
    );
    assert.equal(assertMatchesPatchEquivalence({ dir, revision: "feature" }).status, "current");

    write(dir, PRESET, preset("搭档优先，再说一句"));
    commit(dir, "a later edit on top of the copied fix");
    assert.notEqual(
      blobAt(dir, "feature", PRESET),
      blobAt(dir, "main", PRESET),
      "the content must differ for this case",
    );
    assert.equal(assertMatchesPatchEquivalence({ dir, revision: "feature" }).status, "current");
  });

  test("both sides edited: the carried commit is silent and the missing one is named", () => {
    const dir = makeRepo();
    write(dir, PRESET, preset("first"));
    const base = commit(dir, "base");
    write(dir, PRESET, preset("second"));
    const carried = commit(dir, "the branch's first edit");
    write(dir, PRESET, preset("third"));
    commit(dir, "the branch's second edit");
    git(dir, ["checkout", "-q", "-b", "feature", base]);
    git(dir, ["cherry-pick", carried]);
    write(dir, PRESET, preset("the feature's own further edit"));
    commit(dir, "the feature's own further edit");
    const assessment = assertMatchesPatchEquivalence({ dir, revision: "feature" });
    assert.equal(assessment.findings.length, 1, promptSurfaceRefusal(assessment));
    assert.equal(assessment.findings[0].subjects.length, 1, "the carried copy must not be counted as missing");
    assert.match(assessment.findings[0].subjects[0], /the branch's second edit/u);
  });

  test("a prompt change re-applied inside a commit that changed other files is still carried", () => {
    // The case that separates "the same patch" from "a patch with the same text in it": `--cherry-pick` hashes only
    // the part of each commit that touches the path in question, so a revision that re-applied the prompt sentence
    // inside a commit whose OTHER files differ carries the work, and the blobs differ because a later commit edited
    // the prompt again. Decided from the whole commit patch, this tree would be refused for work it already has.
    const dir = makeRepo();
    const plumbing = "host/src/zz-unrelated-plumbing.ts";
    write(dir, PRESET, preset("first"));
    write(dir, plumbing, "export const plumbing = 1;\n");
    const base = commit(dir, "base");
    write(dir, PRESET, preset("second"));
    write(dir, plumbing, "export const plumbing = 2;\n");
    const product = commit(dir, "the product branch's prompt fix, and its own plumbing");
    git(dir, ["checkout", "-q", "-b", "feature", base]);
    write(dir, PRESET, preset("second"));
    write(dir, plumbing, "export const plumbing = 3;\n");
    commit(dir, "the same prompt sentence, different plumbing");
    write(dir, PRESET, preset("second, and the feature's own ending"));
    commit(dir, "the feature's own edit on top");

    // The fixture has to be the hard case, or this test agrees with itself: the blobs differ, the patch limited to the
    // prompt path is the same on both sides, and the whole-commit patches are not.
    assert.notEqual(blobAt(dir, "feature", PRESET), blobAt(dir, "main", PRESET), "the prompt content must differ");
    const patchIds = (patchText) =>
      gitPiped(dir, ["patch-id", "--stable"], patchText)
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => line.split(" ")[0]);
    const reApplied = git(dir, ["rev-list", "--no-merges", "feature", "--not", "main", "--", PRESET]).split("\n")[1];
    const patchOf = (shas, paths) =>
      git(dir, ["log", "--no-walk=unsorted", "--patch", "--format=commit %H", ...shas, ...(paths ?? [])]);
    assert.equal(
      patchIds(patchOf([product, reApplied])).length,
      2,
      "both whole-commit patches must reach the comparison",
    );
    assert.equal(patchOf([product]).includes("plumbing = 2"), true, "the product commit must touch the plumbing");
    assert.notEqual(
      new Set(patchIds(patchOf([product, reApplied]))).size,
      1,
      "the whole-commit patches must differ for this to be the hard case",
    );
    assert.equal(
      patchIds(patchOf([product], ["--", PRESET]))[0],
      patchIds(patchOf([reApplied], ["--", PRESET]))[0],
      "the prompt part of the two commits must be the same for this to be the hard case",
    );
    const assessment = assertMatchesPatchEquivalence({ dir, revision: "feature" });
    assert.equal(assessment.status, "current", promptSurfaceRefusal(assessment));
  });
});
