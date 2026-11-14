import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    assert.equal(finding.count, 2);
    // `%h %s`: the short hash is what the operator pastes into `git show`, the subject is what they read.
    for (const message of REAL_RED_SUBJECTS)
      assert.ok(
        finding.subjects.some((subject) => subject.endsWith(message)),
        `missing ${message}; got ${finding.subjects.join(" | ")}`,
      );
    const refusal = promptSurfaceRefusal(assessment);
    assert.ok(
      refusal.includes(`live_run_prompt_surface_behind:${REAL_RED_PATH}:2 commits`),
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
