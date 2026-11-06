/**
 * Guard: the committed tree must be able to import itself.
 *
 * WHY
 *
 * An 8124-byte analysis module,
 * `integrations/stardew/action-development/src/analysis/stardew-mod-csharp-source.mjs`, was `git add`ed
 * and never committed, while the three modules importing it were committed (250bd142 committed the file,
 * which is what the three jobs were missing). It compiled, ran and passed locally, because the file was on
 * one disk. In a clean checkout three jobs went red and each reported a different symptom: `knip` printed
 * `Unresolved imports`, the ci-coverage gate failed, and the stardew-scaffold gate failed at step four. Three
 * diagnoses, one cause, and nothing in the tree connected them. A static import is a promise that the target
 * is in the same revision; a `git add` does not keep that promise, only a commit does.
 *
 * THE AUTHORITY IS THE COMMIT, not the index and not the working tree — that distinction is the defect
 * above. `git ls-files` reads the index, which holds a staged file exactly like a committed one, so a gate
 * built on it reports the half-landed module as present. Reading the working tree instead reports every
 * uncommitted edit as if it were HEAD's, which in a repository this busy means the gate is red for work in
 * progress and ignored within a day. Both halves therefore come from the commit: the file set from
 * `git ls-tree`, the contents from `git cat-file`.
 *
 * THE POPULATION is derived, never listed: every path the commit reports under the source roots below,
 * filtered to the extensions that carry static imports. A declared root that this checkout still has but the
 * commit has stopped feeding is a loud error rather than a quietly narrower gate.
 *
 * THE RULE. For each relative `from "./x.js"`, `import("./x.js")` or `require("./x.js")` in a population
 * file, resolve the target the way TypeScript's own ESM resolver does — a `.js` specifier means the
 * same-directory `.ts`/`.tsx`, or the `.js`; `.mjs`/`.cjs` are taken as written — and then ask the commit:
 *
 *   target committed ..................... held, nothing reported;
 *   target on disk but not committed ..... `untracked_import_target` — the shipped defect: the file exists
 *                                          on a disk and in no commit, so a clean checkout cannot import it;
 *   target neither committed nor on disk . `missing_from_head` — the importer names a module that has never
 *                                          existed, which is a broken commit rather than a half-landed one.
 *
 * IMPORTS ARE READ FROM SYNTAX, NOT FROM TEXT. The population contains gates whose fixtures are module
 * graphs written as strings — `tools/audit-totality.test.mjs` alone plants twenty fake modules that way —
 * and a regex over source reads every one of them as an import of a file that does not exist. TypeScript's
 * own parser answers the question the shared grammar defines, so a specifier counts only where the grammar
 * puts one: an `import`/`export` declaration's module specifier, or a `import(...)`/`require(...)` call with
 * a single string literal. The host package owns the TypeScript dependency; `host/` is where this repository
 * keeps it, and tools/check-head-typecheck.mjs already runs `tsc` from there for the same reason.
 *
 * WHAT IS SKIPPED, and why each is not a defect this gate can see:
 *   * non-relative specifiers (`node:fs`, `zod`, `@gamebuddy/host/*`) belong to the package resolver, and a
 *     relative path that walks into `node_modules` is that same case;
 *   * a computed specifier (`import(`./x/${name}.js`)`) has no single target to check;
 *   * a specifier containing a backslash names a path with a literal backslash in it, which no resolver here
 *     produces;
 *   * a Vite query or fragment (`./style.css?raw`) — the resolver's suffix, not part of the file name;
 *   * a target git is configured never to commit — a build output or a generated fixture directory. Its
 *     absence from the commit is the ignore rule working, so it cannot be the half-landed commit this gate
 *     is about; the rule is read from the repository's own ignore files, not from a list kept here.
 *
 * Usage:
 *   node tools/check-head-self-contained.mjs [--root <repository>] [--rev <commit>] [--quiet]
 *
 * Output is one JSON object on stdout: `{"gate","population","violations","status"}`. `status` is `passed`,
 * `failed`, or `blocked` — blocked when the population is empty, because a gate that read no file has
 * measured nothing and must not report success. Exit is 0 for passed, 1 for failed or blocked, 2 for an
 * error in the gate itself.
 *
 * red-proof: inject  a committed importer whose target is staged but never committed -> `untracked_import_target`
 *                    naming both paths ("a committed importer of an uncommitted module is a finding")
 * red-proof: inject  a committed importer of a file that was never written -> `missing_from_head`
 *                    ("a committed importer of nothing at all is a finding")
 * red-proof: inject  a commit holding no source file at all -> `status:"blocked"` and exit 1
 *                    ("an empty population is blocked, not passed")
 *                    (all five in tools/check-head-self-contained.test.mjs, on real `git init` repositories)
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const typescript = createRequire(join(REPOSITORY_ROOT, "host", "package.json"))("typescript");

/** The source roots that carry static imports. A root contributing no file is drift, not a narrower gate. */
const SOURCE_ROOTS = ["host/src", "dialogue-web/src", "dialogue-web/tests", "tools", "integrations"];
const SOURCE_FILE = /\.(?:ts|tsx|mjs|js|cjs)$/u;
/** A file's dialect, so `tsx` parses as JSX and everything else as the JavaScript it is. */
const SCRIPT_KIND = {
  ".ts": typescript.ScriptKind.TS,
  ".tsx": typescript.ScriptKind.TSX,
  ".mjs": typescript.ScriptKind.JS,
  ".js": typescript.ScriptKind.JS,
  ".cjs": typescript.ScriptKind.JS,
};

const git = (repositoryRoot, args, options = {}) =>
  execFileSync("git", args, {
    cwd: repositoryRoot,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });

/**
 * Every path the commit holds, the submodules it delegates to, and the source roots that contributed none.
 *
 * A submodule appears as one `commit` entry, so a file inside it belongs to another repository's history: an
 * import of it is not this commit's to satisfy.
 */
function readCommitFileSet(repositoryRoot, revision) {
  const entries = git(repositoryRoot, ["ls-tree", "-r", "-z", revision], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [metadata, path] = entry.split("\t");
      const [mode, type] = metadata.split(" ");
      return { path, mode, type };
    });
  const files = entries.map(({ path }) => path);
  const submodules = entries.filter(({ type }) => type === "commit").map(({ path }) => path);
  const emptyRoots = SOURCE_ROOTS.filter(
    // Only roots this checkout has can be checked: a fixture repository carries the one root it plants, and a
    // root whose directory is gone is a different finding from a root the commit has stopped feeding.
    (root) => existsSync(join(repositoryRoot, root)) && !files.some((file) => file.startsWith(`${root}/`)),
  );
  return { files, submodules, emptyRoots };
}

/** The paths git is configured never to commit: a build output or a fixture directory is not a missing commit. */
function readIgnored(repositoryRoot, paths) {
  if (paths.length === 0) return new Set();
  try {
    const ignored = git(repositoryRoot, ["check-ignore", "-z", "--stdin"], {
      encoding: "utf8",
      input: `${paths.join("\0")}\0`,
    });
    return new Set(ignored.split("\0").filter(Boolean));
  } catch (error) {
    // `check-ignore` exits 1 when it recognises none of the paths, which is the ordinary case.
    if (error.status === 1) return new Set();
    throw error;
  }
}

/** The contents of the named paths as the commit holds them, in one `git cat-file --batch` process. */
function readCommittedContents(repositoryRoot, revision, paths) {
  // `--batch` takes object names, so each path is named as `<revision>:<path>`; a bare path would be read
  // from the index, which is the authority this gate deliberately does not use.
  const batch = git(repositoryRoot, ["cat-file", "--batch"], {
    input: `${paths.map((path) => `${revision}:${path}`).join("\n")}\n`,
  });
  const contents = new Map();
  let offset = 0;
  for (const path of paths) {
    const headerEnd = batch.indexOf(0x0a, offset);
    const [, type, size] = batch.toString("utf8", offset, headerEnd).split(" ");
    if (Number.isNaN(Number(size))) throw new Error(`head_self_contained_object_missing:${path}:${type}:${revision}`);
    const start = headerEnd + 1;
    contents.set(path, batch.toString("utf8", start, start + Number(size)));
    offset = start + Number(size) + 1;
  }
  return contents;
}

/**
 * The files a relative specifier can mean, in the order TypeScript's resolver tries them.
 *
 * `./x.js` is the ESM spelling of `./x.ts`: TypeScript source compiled to JavaScript is imported under the
 * extension it will have at runtime, so the `.ts`/`.tsx` beside it is the real target and a `.js` sibling is
 * the fallback for modules that genuinely are JavaScript.
 */
export function candidateTargets(specifier, importer) {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  if (base.endsWith(".js")) return [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`, base];
  if (base.endsWith(".mjs") || base.endsWith(".cjs")) return [base];
  if (posix.extname(base) !== "") return [base];
  return [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
}

/** The relative specifiers one file names, minus the spellings that name no file this gate can resolve. */
function readSpecifiers(source, file) {
  const scriptKind = SCRIPT_KIND[posix.extname(file)];
  const parsed = typescript.createSourceFile(file, source, typescript.ScriptTarget.Latest, false, scriptKind);
  const specifiers = [];
  const collect = (node) => {
    const literal = specifierOf(node);
    if (literal !== undefined) specifiers.push(literal);
    node.forEachChild(collect);
  };
  collect(parsed);
  return specifiers.flatMap((specifier) => {
    // A specifier containing a backslash names a path with a literal backslash in it, which no resolver here
    // produces; a Vite query or fragment is the resolver's suffix, and the file it names is the part before it.
    if (specifier.includes("\\")) return [];
    const target = specifier.replace(/[?#].*$/u, "");
    if (!(target.startsWith("./") || target.startsWith("../"))) return [];
    return [{ specifier, target }];
  });
}

/**
 * The module specifier a syntax node carries, if it is one the grammar puts there.
 *
 * `import x from` / `export ... from` / `import x = require("...")` carry a declaration; `import(...)` and
 * `require(...)` carry it as a call. Anything else — a string inside a fixture, a template literal naming a
 * computed path — is data, not an import.
 */
function specifierOf(node) {
  if (typescript.isImportDeclaration(node) || typescript.isExportDeclaration(node)) {
    const { moduleSpecifier } = node;
    return moduleSpecifier !== undefined && typescript.isStringLiteral(moduleSpecifier)
      ? moduleSpecifier.text
      : undefined;
  }
  if (typescript.isImportEqualsDeclaration(node) && typescript.isExternalModuleReference(node.moduleReference))
    return typescript.isStringLiteral(node.moduleReference.expression)
      ? node.moduleReference.expression.text
      : undefined;
  if (typescript.isCallExpression(node) && node.arguments.length === 1) {
    const [argument] = node.arguments;
    const namesAModule =
      node.expression.kind === typescript.SyntaxKind.ImportKeyword ||
      (typescript.isIdentifier(node.expression) && node.expression.text === "require");
    return namesAModule && typescript.isStringLiteral(argument) ? argument.text : undefined;
  }
  return undefined;
}

/**
 * Every import in the commit that the commit cannot satisfy.
 *
 * A violation is one line, in the shape an operator can grep: the code names the defect, then the importer,
 * then the specifier as written, then — for a target that exists on disk only — the file in no commit.
 */
export function auditHeadSelfContained({ repositoryRoot = REPOSITORY_ROOT, revision = "HEAD" } = {}) {
  const { files, submodules, emptyRoots } = readCommitFileSet(repositoryRoot, revision);
  if (emptyRoots.length > 0)
    throw new Error(`head_self_contained_root_empty:${emptyRoots.join(",")}:${revision}:${repositoryRoot}`);
  const committed = new Set(files);
  const inSubmodule = (candidate) => submodules.some((submodule) => candidate.startsWith(`${submodule}/`));
  const population = files
    .filter((file) => SOURCE_FILE.test(file) && SOURCE_ROOTS.some((root) => file.startsWith(`${root}/`)))
    .sort();
  const contents = readCommittedContents(repositoryRoot, revision, population);
  const missing = [];
  for (const importer of population) {
    for (const { specifier, target } of readSpecifiers(contents.get(importer), importer)) {
      const candidates = candidateTargets(target, importer);
      if (candidates.some((candidate) => committed.has(candidate))) continue;
      if (candidates.every(inSubmodule)) continue;
      missing.push({ importer, specifier, candidates });
    }
  }
  const onDisk = (candidates) => candidates.find((candidate) => existsSync(join(repositoryRoot, candidate)));
  const resolved = missing.map((entry) => ({ ...entry, candidate: onDisk(entry.candidates) }));
  const ignored = readIgnored(repositoryRoot, [
    ...new Set(resolved.flatMap(({ candidate }) => (candidate === undefined ? [] : [candidate]))),
  ]);
  const violations = resolved.flatMap(({ importer, specifier, candidate }) => {
    if (candidate === undefined) return [`missing_from_head:${importer}:${specifier}`];
    if (ignored.has(candidate)) return [];
    return [`untracked_import_target:${importer}:${specifier}:${candidate}`];
  });
  violations.sort();
  return {
    gate: "head-self-contained",
    population: population.length,
    violations,
    status: verdictOf({ population, violations }),
  };
}

/** A gate that read no file measured nothing, which is never a pass; any violation is a failure. */
function verdictOf({ population, violations }) {
  if (population.length === 0) return "blocked";
  return violations.length === 0 ? "passed" : "failed";
}

/** The operator's sentence for one violation; the two codes mean different fixes. */
export function describeViolation(violation) {
  const [code, importer, specifier, resolved] = violation.split(":");
  if (code === "untracked_import_target")
    return `${importer} imports "${specifier}", which resolves to ${resolved}: that file exists on disk but is in no commit, so a clean checkout of HEAD cannot import it`;
  return `${importer} imports "${specifier}", which is neither committed nor on disk: the importer names a module that has never existed`;
}

function main(argv) {
  const argumentValue = (name) => {
    const index = argv.indexOf(name);
    const value = index >= 0 ? argv[index + 1] : undefined;
    return typeof value === "string" && !value.startsWith("--") ? value : undefined;
  };
  const root = argumentValue("--root");
  const revision = argumentValue("--rev") ?? "HEAD";
  const reading = auditHeadSelfContained({
    repositoryRoot: root === undefined ? REPOSITORY_ROOT : resolve(root),
    revision,
  });
  process.stdout.write(`${JSON.stringify(reading, null, 2)}\n`);
  if (reading.status === "passed") return 0;
  if (reading.status === "blocked") {
    process.stderr.write(
      `head_self_contained blocked: ${revision} holds no source file under ${SOURCE_ROOTS.join(", ")}\n`,
    );
    return 1;
  }
  process.stderr.write(
    `head_self_contained failed: ${reading.violations.length} import(s) the commit cannot satisfy\n`,
  );
  if (!argv.includes("--quiet"))
    for (const violation of reading.violations) process.stderr.write(`  ${describeViolation(violation)}\n`);
  return 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
