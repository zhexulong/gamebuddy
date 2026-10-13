/**
 * A gate whose helper reads a different source than the one it claims.
 *
 *   The measured instance this gate exists for (`host/src/tavern/default-companion-preset.test.ts`,
 *   fixed in the sibling commit): the file's own doc comment said "This test reads
 *   `git show HEAD:...` the same way, so the two sides always measure the same text", and the
 *   helper really did contain that `git show` — behind
 *
 *     if (existsSync(file)) return JSON.parse(await readFile(file, "utf8"));
 *
 *   In a checkout the file always exists, so the committed read was unreachable and the test
 *   compared the working tree against itself. It passed while an uncommitted card rewrite sat in
 *   the tree, and the release generator that the same contract looked after
 *   (`host/scripts/compile-default-companion-preset.mjs --committed`) measured the committed card.
 *   One contract, two texts, and nothing red.
 *
 * Two rules, both decidable from the source text alone:
 *
 *  - `provenance_claim_reads_filesystem`: a function whose NAME or ADJACENT doc comment claims
 *    commit provenance (`committed`, `git show`, `HEAD:`) must not also read a file. A filesystem
 *    read is an unpinned source; where it can supply the same value the pinned read becomes dead
 *    code and the claim false.
 *  - `pinned_read_with_unpinned_fallback`: a function that reads committed text through git and
 *    also gates a filesystem read on `existsSync` has the same fallback shape even when its name
 *    says nothing.
 *
 * What this gate is NOT, and deliberately does not pretend to be: the general shape "a helper
 * whose name promises source X but whose implementation reads Y" is not decidable from a name, so
 * no general rule is invented here. The commit-provenance spelling above is the shape that was
 * measured; the other instances of the class (a gate whose suite could not compile at all, so it
 * enforced nothing; a zone manifest listing 16 files while the tree held 42) are named in that
 * commit's report and are not gated here — each of them is a different, separately decidable
 * property and belongs to its own owner.
 *
 * Corpus: every `*.test.{ts,mjs}` and every `check-*|audit-*|verify-*.mjs` under `host/src`,
 * `host/scripts` and `tools` — the files whose job is to assert. `dialogue-web/**` and `vendor/**`
 * are not in it.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const typescript = createRequire(import.meta.url)("typescript");
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CORPUS_DIRECTORIES = ["host/src", "host/scripts", "tools"];
const CORPUS_FILE = /(\.test\.(ts|mjs)|^(check|audit|verify)-.*\.mjs)$/u;
const SKIPPED_DIRECTORY = /^(node_modules|dist.*|\.tmp.*|scratch|vendor)$/u;

const CLAIM_IN_NAME = /(?<!un)committed/iu;
const CLAIM_IN_COMMENT = /(?<!un)committed|git show|HEAD:/iu;
const FILESYSTEM_READ = new Set(["readFile", "readFileSync", "readJson", "readJsonSync", "readTextFile", "readTextFileSync"]);
const GIT_COMMAND = /\b(show|cat-file|ls-tree)\b/u;

const callName = (node) => {
  const callee = node.expression;
  if (typescript.isIdentifier(callee)) return callee.text;
  if (typescript.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
};

/** The comment block that documents `anchor`, or "" when the nearest text above it is code. */
function adjacentComment(text, anchor) {
  let cursor = anchor;
  let newlines = 0;
  while (cursor > 0) {
    const character = text[cursor - 1];
    if (character === "\n") {
      newlines += 1;
      if (newlines > 2) return "";
      cursor -= 1;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      cursor -= 1;
      continue;
    }
    break;
  }
  const before = text.slice(0, cursor);
  if (before.endsWith("*/")) {
    const open = before.lastIndexOf("/*");
    return open < 0 ? "" : before.slice(open);
  }
  const lines = before.split("\n");
  const commentLines = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trimStart();
    if (!line.startsWith("//")) break;
    commentLines.unshift(line);
  }
  return commentLines.join("\n");
}

const functionName = (node) => {
  if (node.name !== undefined && typeof node.name.text === "string") return node.name.text;
  const parent = node.parent;
  if (typescript.isVariableDeclaration(parent) && typescript.isIdentifier(parent.name)) return parent.name.text;
  if (typescript.isPropertyAssignment(parent)) return parent.name.getText();
  return "";
};

/** A function's own text, without the nested functions it contains (each is judged on its own). */
function callsInScope(node) {
  const calls = [];
  const walk = (inner) => {
    if (inner !== node && typescript.isFunctionLike(inner)) return;
    if (typescript.isCallExpression(inner)) calls.push(inner);
    typescript.forEachChild(inner, walk);
  };
  typescript.forEachChild(node, walk);
  return calls;
}

/** The findings for one gate source. Pure: it never touches the filesystem. */
export function findingsForSource(relativePath, text) {
  const findings = [];
  const source = typescript.createSourceFile(
    relativePath,
    text,
    typescript.ScriptTarget.ESNext,
    true,
    relativePath.endsWith(".ts") ? typescript.ScriptKind.TS : typescript.ScriptKind.JS,
  );
  const lineOf = (node) => text.slice(0, node.getStart(source)).split("\n").length;
  const visit = (node) => {
    if (typescript.isFunctionLike(node) && !typescript.isCallSignatureDeclaration(node)) {
      const name = functionName(node);
      const anchor = (() => {
        const parent = node.parent;
        if (typescript.isVariableDeclaration(parent) && typescript.isVariableStatement(parent.parent)) return parent.parent;
        return node;
      })();
      const comment = adjacentComment(text, anchor.getStart(source));
      const calls = callsInScope(node);
      const reads = calls.filter((call) => {
        const callee = callName(call);
        return callee !== undefined && FILESYSTEM_READ.has(callee);
      });
      const gitReads = calls.filter((call) => {
        if (callName(call) !== "execFileSync" && callName(call) !== "execSync" && callName(call) !== "spawnSync") return false;
        const argumentText = call.arguments
          .map((argument) =>
            typescript.isStringLiteralLike(argument)
              ? argument.text
              : typescript.isArrayLiteralExpression(argument)
                ? argument.elements.map((element) => (typescript.isStringLiteralLike(element) ? element.text : "")).join(" ")
                : "",
          )
          .join(" ");
        return argumentText.includes("git") && GIT_COMMAND.test(argumentText);
      });
      const guards = calls.filter((call) => callName(call) === "existsSync");
      const claims = CLAIM_IN_NAME.test(name) || CLAIM_IN_COMMENT.test(comment);
      if (claims && reads.length > 0) {
        findings.push({
          rule: "provenance_claim_reads_filesystem",
          file: relativePath,
          line: lineOf(node),
          name: name === "" ? "(anonymous)" : name,
          detail: `claims commit provenance in ${CLAIM_IN_NAME.test(name) ? "its name" : "its doc comment"} and performs ${reads.length} filesystem read(s)`,
        });
      }
      if (gitReads.length > 0 && guards.length > 0 && reads.length > 0) {
        findings.push({
          rule: "pinned_read_with_unpinned_fallback",
          file: relativePath,
          line: lineOf(node),
          name: name === "" ? "(anonymous)" : name,
          detail: `reads committed text through git, guards on existsSync and performs ${reads.length} filesystem read(s)`,
        });
      }
    }
    typescript.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

export function discoverGateSources(root) {
  const found = [];
  const walk = (directory) => {
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORY.test(entry.name)) walk(join(directory, entry.name));
      } else if (CORPUS_FILE.test(entry.name)) found.push(join(directory, entry.name));
    }
  };
  for (const directory of CORPUS_DIRECTORIES) walk(join(root, directory));
  return found.sort();
}

export function scanGateSources(root) {
  return discoverGateSources(root).flatMap((path) =>
    findingsForSource(path.slice(root.length + 1).replaceAll("\\", "/"), readFileSync(path, "utf8")),
  );
}

const render = (findings) => findings.map((finding) => `  ${finding.rule} ${finding.file}:${finding.line} ${finding.name} — ${finding.detail}`).join("\n");

const PRE_FIX_HELPER = `
async function committedAsset(name: string): Promise<unknown> {
  const file = join(presetDirectory(), name);
  if (existsSync(file)) {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(file, "utf8"));
  }
  const bytes = execFileSync("git", ["show", \`HEAD:assets/tavern/presets/default-companion/\${name}\`], { cwd: repositoryRoot(), encoding: "utf8" });
  return JSON.parse(bytes);
}`;

const FIXED_HELPER = `
/** The COMMITTED text of one preset asset, read from git at HEAD. */
function committedAsset(name: string): unknown {
  const spec = \`HEAD:assets/tavern/presets/default-companion/\${name}\`;
  try {
    return JSON.parse(execFileSync("git", ["show", spec], { cwd: repositoryRoot(), encoding: "utf8" }));
  } catch (error) {
    throw new Error(\`committed_asset_unreadable: git could not show \${spec}\`);
  }
}

/** The WORKING TREE's text of one preset asset. */
async function workingTreeAsset(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(presetDirectory(), name), "utf8"));
}

/** The generator's own name: it makes no provenance claim, so its dual mode is not a finding. */
async function readAsset(name: string, fromCommitted: boolean): Promise<unknown> {
  if (!fromCommitted) return JSON.parse(await readFile(join(presetDirectory(), name), "utf8"));
  return JSON.parse(execFileSync("git", ["show", \`HEAD:\${name}\`], { encoding: "utf8" }));
}`;

test("rule.1: the measured defect is a finding — the claimed committed read is behind a file fallback", (t) => {
  const findings = findingsForSource("host/src/tavern/planted.test.ts", PRE_FIX_HELPER);
  assert.deepEqual(
    findings.map((finding) => finding.rule).toSorted(),
    ["pinned_read_with_unpinned_fallback", "provenance_claim_reads_filesystem"],
    `both rules must see it:\n${render(findings)}`,
  );
  const claim = findings.find((finding) => finding.rule === "provenance_claim_reads_filesystem");
  assert.equal(claim.name, "committedAsset");
  assert.equal(claim.line, 2, "the finding names the helper's own line");
  t.diagnostic(`rule.1: planted pre-fix helper -> ${render(findings).trim()}`);
});

test("rule.2: the fixed file is not a finding — the committed helper reads git, the working-tree helper says so", (t) => {
  const findings = findingsForSource("host/src/tavern/default-companion-preset.test.ts", FIXED_HELPER);
  assert.deepEqual(findings, [], `no false positive for an honest split:\n${render(findings)}`);
  t.diagnostic("rule.2: 3 honest helpers (committed/working-tree/unclaimed dual mode) -> 0 findings");
});

test("rule.3: the same fallback under a name that claims nothing is still a finding", () => {
  const findings = findingsForSource(
    "host/scripts/planted.mjs",
    `function readPinned(name) {\n  const file = join(dir, name);\n  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));\n  return JSON.parse(execFileSync("git", ["show", \`HEAD:\${name}\`], { encoding: "utf8" }));\n}`,
  );
  assert.deepEqual(
    findings.map((finding) => finding.rule),
    ["pinned_read_with_unpinned_fallback"],
    `the fallback shape is a finding on its own:\n${render(findings)}`,
  );
});

test("rule.4: a filesystem-only helper with no provenance claim is not a finding", () => {
  const findings = findingsForSource(
    "host/scripts/planted.mjs",
    `async function workingTreeAsset(name) {\n  return JSON.parse(await readFile(join(presetDirectory(), name), "utf8"));\n}\nfunction readNames() {\n  return readdirSync(dir);\n}`,
  );
  assert.deepEqual(findings, [], `reading the working tree is not the defect:\n${render(findings)}`);
});

test("live: every gate source in host/src, host/scripts and tools measures the source it claims", (t) => {
  const sources = discoverGateSources(REPOSITORY_ROOT);
  assert.ok(sources.length > 300, `the corpus must not silently shrink: ${sources.length} sources`);
  for (const directory of CORPUS_DIRECTORIES)
    assert.ok(
      sources.some((path) => path.startsWith(join(REPOSITORY_ROOT, directory))),
      `${directory} contributed no gate source; the corpus pattern has rotted`,
    );
  assert.ok(
    sources.includes(join(REPOSITORY_ROOT, "host/src/tavern/default-companion-preset.test.ts")),
    "the file this gate was written for must be inside the corpus",
  );
  const findings = scanGateSources(REPOSITORY_ROOT);
  assert.equal(findings.length, 0, `gate_source_provenance_failed findings=${findings.length}\n${render(findings)}`);
  t.diagnostic(`live: ${sources.length} gate sources, 0 findings`);
});
