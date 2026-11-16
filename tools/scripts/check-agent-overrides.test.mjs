/**
 * The agent-override gate, tried against fixtures it has never seen.
 *
 * Every case below is a shape the live machine produced or a shape it will produce: a copy that forgot one field, a
 * source whose body moved, a declaration that outlived the difference it declared, a directory the loader reads and one
 * it does not. The population cases are the reason this file exists - the gate was written after a timeout fix was
 * placed in `~/.pi/agent/agents` while the loader was reading `PI_CODING_AGENT_DIR`, so a suite that only ever builds
 * one user directory would certify exactly the blindness that caused the incident.
 */
// red-proof: inject  add one line to a package definition's body in a fixture copy -> `agent_override_undeclared`
//                    quoting both halves plus the file to update, exit 1 (audit.3 and audit.11 below)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { firstBodyDifference, parseFrontmatter } from "./check-agent-overrides.mjs";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "check-agent-overrides.mjs");

/** A definition file the way the loader writes one: frontmatter, a blank line, then the prompt. */
function definition(dir, name, frontmatter, body) {
  writeFileSync(join(dir, `${name}.md`), ["---", ...frontmatter, "---", "", body, ""].join("\n"));
}

/**
 * A tree shaped like the live one: an agent dir whose `npm/` carries the package definitions, a repository whose
 * `.pi/agents` shadows them per project, and `$HOME` above both.
 */
function fixture(t, { packageAgents = [], projectAgents = [], userAgents = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-overrides-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const userDir = join(agentDir, "agents");
  const packageDir = join(agentDir, "npm", "node_modules", "pi-subagents", "agents");
  const projectDir = join(root, "repo", ".pi", "agents");
  for (const dir of [userDir, packageDir, projectDir]) mkdirSync(dir, { recursive: true });
  const ctx = { root, home, agentDir, userDir, packageDir, projectDir, repo: join(root, "repo") };
  for (const agent of packageAgents)
    definition(packageDir, agent.name, agent.frontmatter, agent.body ?? `${agent.name} body`);
  for (const agent of projectAgents)
    definition(projectDir, agent.name, agent.frontmatter, agent.body ?? `${agent.name} body`);
  for (const agent of userAgents)
    definition(userDir, agent.name, agent.frontmatter, agent.body ?? `${agent.name} body`);
  return ctx;
}

/** A user-level file written after the fixture exists, so it can name the package path it tracks. */
function userFile(ctx, name, frontmatter, body, dir = ctx.userDir) {
  mkdirSync(dir, { recursive: true });
  definition(dir, name, frontmatter, body);
}

function run(ctx, { env = {} } = {}) {
  const result = spawnSync(process.execPath, [GATE, "--repo-root", ctx.repo], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: ctx.home,
      USERPROFILE: ctx.home,
      PI_CODING_AGENT_DIR: ctx.agentDir,
      PI_SUBAGENT_EXTRA_AGENT_DIRS: "",
      ...env,
    },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const base = (name) => [`name: ${name}`, `description: ${name} definition`, "tools: read"];

test("audit.1: a copy that differs only where it declares an override passes, and says what it examined", (t) => {
  const pkg = base("reviewer");
  const ctx = fixture(t, { packageAgents: [{ name: "reviewer", frontmatter: pkg, body: "You review." }] });
  userFile(
    ctx,
    "reviewer",
    [...pkg, "timeoutMs: 3600000", "override: timeoutMs", `tracks: ${join(ctx.packageDir, "reviewer.md")}`],
    "You review.",
  );
  const { status, out } = run(ctx);
  assert.equal(status, 0, out);
  assert.match(out, /overrides examined 1 · shadowing a project file 0 · shadowing a package file 1/u);
  assert.match(out, /drifted 0/u);
});

test("audit.2: a field that differs without being declared fails, naming the field and the file to update", (t) => {
  const pkg = base("scout");
  const ctx = fixture(t, { packageAgents: [{ name: "scout", frontmatter: pkg }] });
  userFile(ctx, "scout", [...pkg, "timeoutMs: 3600000", `tracks: ${join(ctx.packageDir, "scout.md")}`], "scout body");
  const { status, out } = run(ctx);
  assert.equal(status, 1, out);
  assert.match(out, /agent_override_undeclared:scout:timeoutMs/u);
  assert.match(out, /update .*scout\.md/u, "the finding must say which file to update");
  assert.match(out, /drifted 1/u);
});

test("audit.3: a source whose body moved is named with both halves and the file to re-sync", (t) => {
  const pkg = base("worker");
  const ctx = fixture(t, {
    packageAgents: [{ name: "worker", frontmatter: pkg, body: "You are worker.\nThe package learned a new sentence." }],
  });
  userFile(
    ctx,
    "worker",
    [...pkg, `tracks: ${join(ctx.packageDir, "worker.md")}`],
    "You are worker.\nThe copy kept the old sentence.",
  );
  const { status, out } = run(ctx);
  assert.equal(status, 1, out);
  assert.match(out, /agent_override_undeclared:worker:body/u);
  assert.match(out, /body line 2 differs/u);
  assert.match(out, /"The copy kept the old sentence\."/u, "the user half must be quoted");
  assert.match(out, /"The package learned a new sentence\."/u, "the tracked half must be quoted");
  assert.match(out, /declare `override: body`/u);
});

test("audit.4: a declared override that no longer differs is stale, and says which line to remove", (t) => {
  const pkg = base("evo");
  const ctx = fixture(t, { packageAgents: [{ name: "evo", frontmatter: pkg }] });
  userFile(ctx, "evo", [...pkg, "override: timeoutMs", `tracks: ${join(ctx.packageDir, "evo.md")}`], "evo body");
  const { status, out } = run(ctx);
  assert.equal(status, 1, out);
  assert.match(out, /agent_override_stale:evo:timeoutMs/u);
  assert.match(out, /exception outlived its reason/u);
});

test("audit.5: `tracks: none` skips the body comparison and is counted as not-a-copy", (t) => {
  const pkg = base("worker");
  const ctx = fixture(t, { packageAgents: [{ name: "worker", frontmatter: pkg, body: "The package body." }] });
  userFile(
    ctx,
    "worker",
    [...pkg, "timeoutMs: 3600000", "tracks: none", "override: body, timeoutMs"],
    "A completely different agent wearing the same name.",
  );
  const { status, out } = run(ctx);
  assert.equal(status, 0, out);
  assert.match(out, /not-a-copy 1/u);
  assert.match(out, /drifted 0/u);
  assert.doesNotMatch(out, /:body/u, "a non-copy's body is its own identity");
});

test("audit.6: `tracks: none` still names a field the definition it collides with now carries", (t) => {
  const pkg = base("worker");
  const ctx = fixture(t, {
    packageAgents: [{ name: "worker", frontmatter: [...pkg, "fast: true"], body: "The package body." }],
  });
  userFile(ctx, "worker", [...pkg, "tracks: none", "override: body"], "A different agent.");
  const { status, out } = run(ctx);
  assert.equal(status, 1, out);
  assert.match(out, /agent_override_undeclared:worker:fast/u);
  assert.doesNotMatch(out, /:body/u);
});

test("audit.7: a shadow that does not say whether it is a copy is itself the finding", (t) => {
  const project = base("reviewer");
  const ctx = fixture(t, { projectAgents: [{ name: "reviewer", frontmatter: project }] });
  userFile(ctx, "reviewer", [...project, "timeoutMs: 3600000"], "reviewer body");
  const { status, out } = run(ctx);
  assert.equal(status, 1, out);
  assert.match(out, /agent_override_undeclared:reviewer:tracks/u);
  assert.match(out, /add `tracks: <that path>` if this file is meant to be a copy/u);
  assert.match(out, /`tracks: none` if it is a different agent wearing the same name/u);
});

test("audit.8: a `tracks:` path that no longer exists is `tracked_source_missing`, not a silent pass", (t) => {
  const ctx = fixture(t, {});
  userFile(ctx, "scout", [...base("scout"), `tracks: ${join(ctx.root, "gone", "scout.md")}`], "scout body");
  const { status, out } = run(ctx);
  assert.equal(status, 1, out);
  assert.match(out, /tracked_source_missing:.*scout\.md:.*gone/u);
  assert.match(out, /a moved or renamed upstream agent is drift, not `not-a-copy`/u);
});

test("audit.9: an empty user layer is exit 2 with `examined 0`, never a pass", (t) => {
  const ctx = fixture(t, { packageAgents: [{ name: "worker", frontmatter: base("worker") }] });
  const { status, out } = run(ctx);
  assert.equal(status, 2, out);
  assert.match(out, /examined 0/u);
});

test("audit.10: a typo in the variable that decides the layer is `user_agent_dir_unresolved`, exit 2", (t) => {
  const ctx = fixture(t, { userAgents: [{ name: "worker", frontmatter: base("worker") }] });
  const { status, out } = run(ctx, { env: { PI_CODING_AGENT_DIR: join(ctx.root, "no-such-agent-dir") } });
  assert.equal(status, 2, out);
  assert.match(out, /user_agent_dir_unresolved/u);
});

test("audit.11: the directory the loader does not read is measured AND labelled `loader-scanned no`", (t) => {
  const pkg = base("worker");
  const ctx = fixture(t, { packageAgents: [{ name: "worker", frontmatter: pkg, body: "The package body." }] });
  // The incident: the copies were written here, while the agent dir pointed somewhere else.
  const inertDir = join(ctx.home, ".pi", "agent", "agents");
  userFile(ctx, "worker", [...pkg, `tracks: ${join(ctx.packageDir, "worker.md")}`], "The copy body.", inertDir);
  const elsewhere = join(ctx.root, "data", "agent");
  mkdirSync(join(elsewhere, "agents"), { recursive: true });
  userFile(
    elsewhere,
    "worker",
    [...pkg, `tracks: ${join(ctx.packageDir, "worker.md")}`],
    "The copy body.",
    join(elsewhere, "agents"),
  );

  const { status, out } = run(ctx, { env: { PI_CODING_AGENT_DIR: elsewhere } });
  assert.equal(status, 1, out, "a drifted copy in an unread directory is still drift, never a pass");
  assert.match(out, new RegExp(`user dir ${inertDir.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")}.*loader-scanned no`, "u"));
  assert.match(out, /agent_override_undeclared:worker:body/u);
});

test("audit.12: an extra user directory named by the environment is part of the population", (t) => {
  const extra = join(tmpdir(), `agent-overrides-extra-${process.pid}`);
  t.after(() => rmSync(extra, { recursive: true, force: true }));
  const pkg = base("auditor");
  userFile({ userDir: extra }, "auditor", [...pkg, `tracks: ${join(extra, "missing.md")}`], "auditor body");
  const ctx = fixture(t, {});
  const { status, out } = run(ctx, { env: { PI_SUBAGENT_EXTRA_AGENT_DIRS: extra } });
  assert.equal(status, 1, out);
  assert.match(out, /tracked_source_missing:/u);
});

test("audit.13: chain definitions and `.agents/skills` prose are not agent definitions", (t) => {
  const ctx = fixture(t, { userAgents: [{ name: "worker", frontmatter: [...base("worker"), "tracks: none"] }] });
  userFile(ctx, "pair.chain", base("pair"), "chain", ctx.userDir);
  const skillDir = join(ctx.repo, ".agents", "skills", "guide");
  mkdirSync(skillDir, { recursive: true });
  definition(skillDir, "SKILL", ["name: guide", "description: a prose guide"], "node_modules text");
  const { status, out } = run(ctx);
  assert.equal(status, 0, out);
  assert.match(out, /overrides examined 1/u);
});

test("audit.14: the first body difference is the first disagreeing line, and null when they agree", () => {
  assert.equal(firstBodyDifference("a\nb", "a\nb"), null);
  assert.deepEqual(firstBodyDifference("a\nb\nc", "a\nB\nc"), { line: 2, user: "b", tracked: "B" });
  assert.deepEqual(firstBodyDifference("a", "a\nb"), { line: 2, user: "<body ends here>", tracked: "b" });
});

test("audit.15: a block frontmatter value is one key, and an unclosed `---` means the whole file is body", () => {
  const block = parseFrontmatter("---\nname: x\ntools: >\n  read,\n  write\ndescription: y\n---\n\nbody text\n");
  assert.equal(block.frontmatter.tools, "read,\nwrite");
  assert.equal(block.frontmatter.name, "x");
  assert.equal(block.frontmatter.description, "y");
  assert.equal(block.body, "body text");
  assert.deepEqual(parseFrontmatter("no frontmatter here").frontmatter, {});
});
