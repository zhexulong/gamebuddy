import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gate = "host_windows_test_preflight/v1";
const TEST_ROOTS = Object.freeze(["host/scripts", "host/src"]);

export async function checkHostWindowsTestPreflight({ root = repositoryRoot } = {}) {
  const inspectedFiles = (await Promise.all(TEST_ROOTS.map((directory) => collectTests(root, directory))))
    .flat()
    .sort();
  const violations = [];
  for (const relativePath of inspectedFiles) {
    const source = await readFile(path.join(root, relativePath), "utf8");
    violations.push(...inspectPosixFixtureParents(relativePath, source));
    if (relativePath === "host/scripts/run-test-suite.test.mjs") {
      violations.push(...inspectWindowsNegativeDefaults(relativePath, source));
    }
  }
  violations.sort((left, right) =>
    `${left.path}:${left.line}:${left.code}`.localeCompare(`${right.path}:${right.line}:${right.code}`),
  );
  return Object.freeze({ gate, verdict: violations.length === 0 ? "passed" : "blocked", inspectedFiles, violations });
}

async function collectTests(root, relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await collectTests(root, relativePath)));
    else if (entry.isFile() && (relativePath.endsWith(".test.mjs") || relativePath.endsWith(".test.ts"))) {
      const status = await lstat(path.join(root, relativePath));
      if (status.isFile()) paths.push(relativePath);
    }
  }
  return paths;
}

export function inspectPosixFixtureParents(relativePath, source) {
  const tokens = tokenize(source);
  const violations = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "mkdtemp" || tokens[index + 1]?.value !== "(") continue;
    const close = matching(tokens, index + 1, "(", ")");
    if (close < 0) continue;
    const argument = tokens.slice(index + 2, close);
    if (isPosixLiteral(argument) || isJoinOrResolveWithPosixParent(tokens, argument, index)) {
      violations.push(issue(relativePath, tokens[index].line, "posix_fixture_parent_on_windows"));
    }
  }
  return violations;
}

function isJoinOrResolveWithPosixParent(tokens, argument, mkdtempIndex) {
  if (!(["join", "resolve"].includes(argument[0]?.value) && argument[1]?.value === "(")) return false;
  const close = matching(argument, 1, "(", ")");
  if (close !== argument.length - 1) return false;
  const parent = argument[2];
  if (isPosixLiteral([parent])) return true;
  if (parent?.type !== "word") return false;
  const scope = enclosingScope(tokens, mkdtempIndex);
  const declarations = scope.filter((declaration) => declaration.name === parent.value);
  return declarations.length === 1 && declarations[0].value.startsWith("/");
}

function isPosixLiteral(tokens) {
  return tokens.length === 1 && tokens[0]?.type === "string" && tokens[0].value.startsWith("/");
}

function enclosingScope(tokens, position) {
  const opens = [];
  for (let index = 0; index < position; index += 1) {
    if (tokens[index].value === "{") opens.push(index);
    if (tokens[index].value === "}") opens.pop();
  }
  const start = opens.at(-1) ?? -1;
  const end = start < 0 ? tokens.length : matching(tokens, start, "{", "}");
  const declarations = [];
  let depth = 0;
  for (let index = start + 1; index < end; index += 1) {
    if (tokens[index].value === "{") {
      depth += 1;
      continue;
    }
    if (tokens[index].value === "}") {
      depth -= 1;
      continue;
    }
    if (
      depth !== 0 ||
      tokens[index].value !== "const" ||
      tokens[index + 1]?.type !== "word" ||
      tokens[index + 2]?.value !== "="
    )
      continue;
    const value = tokens[index + 3];
    if (value?.type === "string") declarations.push({ name: tokens[index + 1].value, value: value.value });
  }
  return declarations;
}

export function inspectWindowsNegativeDefaults(relativePath, source) {
  const violations = [];
  const assertion =
    /assert\.throws\s*\(\s*\(\s*\)\s*=>\s*testDependencyInvocations\s*\(\s*\{([\s\S]*?)\}\s*\)\s*(?:,|\))/gu;
  for (const match of source.matchAll(assertion)) {
    const properties = match[1];
    if (!/\bplatform\s*:\s*['"]win32['"]/u.test(properties)) continue;
    const bun = /\bbunExecutable\s*:\s*([^,}\n]+)/u.exec(properties);
    if (bun === null || bun[1].trim() === "undefined") {
      violations.push(
        issue(relativePath, source.slice(0, match.index).split("\n").length, "negative_env_default_not_overridden"),
      );
    }
  }
  return violations;
}

function issue(pathname, line, code) {
  return Object.freeze({ path: pathname, line, code });
}

function matching(tokens, start, open, close) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === open) depth += 1;
    if (tokens[index].value === close && --depth === 0) return index;
  }
  return -1;
}

function tokenize(source) {
  const result = [];
  for (let index = 0; index < source.length; ) {
    const line = source.slice(0, index).split("\n").length;
    const char = source[index];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? source.length : close + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      const start = index++;
      let value = "";
      let interpolated = false;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") index += 1;
        if (quote === "`" && source[index] === "$" && source[index + 1] === "{") interpolated = true;
        value += source[index++] ?? "";
      }
      if (source[index] === quote) index += 1;
      result.push({ type: interpolated ? "template" : "string", value, line, offset: start });
      continue;
    }
    if (/[A-Za-z_$]/u.test(char)) {
      const start = index++;
      while (/[A-Za-z0-9_$]/u.test(source[index] ?? "")) index += 1;
      result.push({ type: "word", value: source.slice(start, index), line, offset: start });
      continue;
    }
    result.push({ type: "punctuation", value: char, line, offset: index++ });
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await checkHostWindowsTestPreflight();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.verdict === "passed" ? 0 : 1;
}
