#!/usr/bin/env node
/**
 * Falsifier suite for `tools/check-persona-prose.mjs`.
 *
 * Every red arm is driven through the real gate binary against a real `git init` repository, because the gate's whole
 * question is a diff: a stub would answer a question nobody asked. The derivation arms (what counts as prose) are
 * driven directly, so a card field that quietly stops being read is a failure here rather than a silent narrowing.
 *
 * red-proof: inject   the second commit of a throwaway repository rewrites `data.system_prompt` 20 -> 8 characters
 *                     with no marker -> exit 1 naming that field and both missing halves; the same commit with
 *                     `[persona]` and a PERSONA-REVISION.md line -> exit 0
 * red-proof: history  `--range 796f701a^..796f701a` against this repository's real history -> 9 fields named,
 *                     `persona_commit_without_marker:796f701a`
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  VIOLATION,
  changedProse,
  documentLeaves,
  judge,
  presetPromptLeaves,
  runCheck,
} from "./check-persona-prose.mjs";

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), "check-persona-prose.mjs");
const CARD = "assets/tavern/presets/default-companion/card.json";
const REVISION = "assets/tavern/presets/PERSONA-REVISION.md";

const git = (root, args) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=persona-prose",
      "-c",
      "user.email=persona-prose@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

function writeFiles(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A throwaway repository whose first commit is `files`, so every diff the suite asks about is a real one. */
function repository(files, context) {
  const root = mkdtempSync(join(tmpdir(), "persona-prose-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  writeFiles(root, files);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed: the shipped tree"]);
  return root;
}

function commit(root, files, message) {
  writeFiles(root, files);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
}

function run(root, args = []) {
  const result = spawnSync(process.execPath, [GATE, "--root", root, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

const card = (systemPrompt) =>
  JSON.stringify(
    {
      spec: "chara_card_v2",
      data: { name: "A", system_prompt: systemPrompt, extensions: { gamebuddy: { game: "stardew" } } },
    },
    null,
    2,
  );

test("a card document's prose is every scalar leaf except the declared non-prose subtree", () => {
  const leaves = documentLeaves({
    data: {
      system_prompt: "hello",
      character_book: { entries: [{ content: "words", id: 7, constant: true }] },
      extensions: { gamebuddy: { stardew: { farmer_appearance: { hair: 12 } } } },
    },
  });
  assert.deepEqual([...leaves.keys()].sort(), [
    "data.character_book.entries.0.constant",
    "data.character_book.entries.0.content",
    "data.character_book.entries.0.id",
    "data.system_prompt",
  ]);
  assert.equal(leaves.get("data.system_prompt"), "hello");
  assert.equal(leaves.get("data.character_book.entries.0.id"), "7");
});

test("a preset document's prose is the prompts' name and content, not the sampler block", () => {
  const leaves = presetPromptLeaves({
    temperature: 1,
    description: "framing",
    prompts: [
      { name: "main", content: "words", system_prompt: "{{system}}" },
      { name: "worldInfoBefore", marker: true },
      "a bare string is not a prompt object",
    ],
  });
  assert.deepEqual([...leaves.keys()].sort(), ["prompts.0.content", "prompts.0.name", "prompts.1.name"]);
});

test("a rewrite that keeps the length is still a change, and the lengths are what the finding prints", () => {
  const before = new Map([
    ["a\u0000f", { path: "a", field: "f", text: "cat" }],
    ["b\u0000g", { path: "b", field: "g", text: "gone" }],
  ]);
  const after = new Map([
    ["a\u0000f", { path: "a", field: "f", text: "dog" }],
    ["c\u0000h", { path: "c", field: "h", text: "arriving" }],
  ]);
  const changes = changedProse(before, after);
  assert.deepEqual(changes, [
    { path: "a", field: "f", oldLen: 3, newLen: 3 },
    { path: "b", field: "g", oldLen: 4, newLen: 0 },
    { path: "c", field: "h", oldLen: 0, newLen: 8 },
  ]);
});

test("both halves of the decision are required, and every arm names what drifted and what is missing", () => {
  const changes = [{ path: CARD, field: "data.system_prompt", oldLen: 560, newLen: 204 }];
  const violation = `${VIOLATION}:${CARD}:data.system_prompt:560->204`;

  const both = judge({ changes, message: "feat: [persona] her voice", revisionRecordUpdated: true, label: "x" });
  assert.equal(both.status, "passed");
  assert.deepEqual(both.findings, []);

  const markerOnly = judge({
    changes,
    message: "feat: [persona] her voice",
    revisionRecordUpdated: false,
    label: "c1",
  });
  assert.equal(markerOnly.status, "failed");
  assert.deepEqual(markerOnly.findings, [violation, "persona_commit_without_revision_record:c1"]);

  const recordOnly = judge({ changes, message: "feat: her voice", revisionRecordUpdated: true, label: "c2" });
  assert.deepEqual(recordOnly.findings, [violation, "persona_commit_without_marker:c2"]);

  const neither = judge({ changes, message: null, revisionRecordUpdated: false, label: "c3" });
  assert.deepEqual(neither.findings, [
    violation,
    "persona_commit_message_not_supplied:c3",
    "persona_commit_without_revision_record:c3",
  ]);

  assert.deepEqual(judge({ changes: [], message: null, revisionRecordUpdated: false, label: "c4" }), {
    status: "passed",
    findings: [],
  });
});

test("a committed rewrite with no marker and no record is red, naming the field and both missing halves", (context) => {
  const root = repository({ [CARD]: card("x".repeat(20)) }, context);
  commit(root, { [CARD]: card("y".repeat(8)) }, "feat: her voice reads better this way");
  const { status, stdout } = run(root, ["--range", "HEAD~1..HEAD"]);
  assert.equal(status, 1);
  assert.match(
    stdout,
    /^files examined 1 · prose fields 3 · mode range · commits examined 1 · prose commits 1 · changed 1/mu,
  );
  assert.equal(
    stdout.includes(`${VIOLATION}:${CARD}:data.system_prompt:20->8`),
    true,
    `the drifting member has to be named in the finding: ${stdout}`,
  );
  assert.equal(
    stdout.includes("persona_commit_without_marker:") && stdout.includes("persona_commit_without_revision_record:"),
    true,
  );
});

test("the same rewrite is green when the commit carries the marker and adds its register line", (context) => {
  const root = repository({ [CARD]: card("x".repeat(20)) }, context);
  commit(
    root,
    {
      [CARD]: card("y".repeat(8)),
      [REVISION]: "# Persona revision register\n\n- 2026-11-10 · pending · data.system_prompt · shorter · the owner\n",
    },
    "feat: [persona] her system prompt says it in eight characters",
  );
  const { status, stdout } = run(root, ["--range", "HEAD~1..HEAD"]);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /changed 1/mu);
});

test("each half of the decision alone is red, and the half that is missing is the one named", (context) => {
  const root = repository({ [CARD]: card("x".repeat(20)) }, context);
  commit(root, { [CARD]: card("y".repeat(9)) }, "feat: [persona] no line in the register");
  commit(
    root,
    { [CARD]: card("z".repeat(7)), [REVISION]: "- 2026-11-10 · pending · data.system_prompt · shorter · the owner\n" },
    "feat: the register says so, the message does not",
  );
  const { status, stdout } = run(root, ["--range", "HEAD~2..HEAD"]);
  assert.equal(status, 1);
  assert.equal(stdout.match(/persona_commit_without_revision_record:/gu)?.length, 1, stdout);
  assert.equal(stdout.match(/persona_commit_without_marker:/gu)?.length, 1, stdout);
  assert.match(stdout, /prose commits 2 · changed 2/mu);
});

test("a change that is not prose is green and prints a measured zero", (context) => {
  const preset = "assets/tavern/presets/amber.json";
  const document = (temperature) =>
    JSON.stringify({ temperature, description: "framing", prompts: [{ name: "main", content: "words" }] });
  const root = repository({ [preset]: document(1), [CARD]: card("x".repeat(20)) }, context);
  commit(root, { [preset]: document(0.4), [CARD]: card("x".repeat(20)) }, "refactor: the sampler runs cooler");
  const { status, stdout } = run(root, ["--range", "HEAD~1..HEAD"]);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /prose commits 0 · changed 0/mu);
});

test("the uncommitted rewrite the incidents actually took is red in the working tree, and green once restored", (context) => {
  const root = repository({ [CARD]: card("x".repeat(20)) }, context);
  writeFiles(root, { [CARD]: card("y".repeat(8)) });
  const staged = run(root, ["--staged"]);
  assert.equal(staged.status, 0, "the rewrite is not in the index yet, and the staged form says so");

  const worktree = run(root);
  assert.equal(worktree.status, 1);
  assert.equal(worktree.stdout.includes(`${VIOLATION}:${CARD}:data.system_prompt:20->8`), true, worktree.stdout);
});

test("the staged form reds on a prose change with no message supplied, and greens with the marker and the register", (context) => {
  const root = repository({ [CARD]: card("x".repeat(20)) }, context);
  writeFiles(root, {
    [CARD]: card("y".repeat(8)),
    [REVISION]: "- 2026-11-10 · pending · data.system_prompt · shorter · the owner\n",
  });
  git(root, ["add", "-A"]);

  const noMessage = run(root, ["--staged"]);
  assert.equal(noMessage.status, 1);
  assert.equal(
    noMessage.stdout.includes("persona_commit_message_not_supplied:the staged commit"),
    true,
    noMessage.stdout,
  );

  const withMessage = run(root, ["--staged", "--message", "feat: [persona] her voice, shorter"]);
  assert.equal(withMessage.status, 0, withMessage.stdout);
});

test("zero population and an unreadable document are blocked, never green", (context) => {
  const empty = repository({ "README.md": "no presets here\n" }, context);
  const blocked = run(empty);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stdout, /persona_prose_population_empty/mu);

  const broken = repository({ [CARD]: "{ not json" }, context);
  const unreadable = run(broken);
  assert.equal(unreadable.status, 2);
  assert.match(unreadable.stdout, /persona_prose_unreadable:assets\/tavern\/presets\/default-companion\/card\.json/mu);
});

test("a range with no commits is blocked rather than a pass over nothing", (context) => {
  const root = repository({ [CARD]: card("x".repeat(20)) }, context);
  const { status, stdout } = run(root, ["--range", "HEAD..HEAD"]);
  assert.equal(status, 2);
  assert.match(stdout, /persona_prose_range_empty:HEAD\.\.HEAD/mu);
});

test("the default run of this repository reads the shipped preset, and finds it unchanged", () => {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = runCheck({ root: repositoryRoot });
  assert.equal(result.status, "passed");
  assert.match(
    result.lines[0],
    /^files examined [1-9]\d* · prose fields [1-9]\d* · mode worktree_vs_HEAD · changed 0$/mu,
  );
  for (const name of ["default-companion/card.json", "default-companion/worldbook.json"])
    assert.equal(
      result.lines.some((line) => line.includes(`assets/tavern/presets/${name}`)),
      true,
      `${name} has to be in the population: ${result.lines.join(" | ")}`,
    );
});
