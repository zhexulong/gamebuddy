import { execFileSync } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const EXCLUDED_PREFIXES = Object.freeze([
  ".git/",
  "node_modules/",
  "vendor/",
  ".commit-snapshots/",
  ".commit-validation/",
  ".pi/",
  "host/dist/",
  "host/dist-test/",
  "host/.memory-live-check/",
  "dialogue-web/dist/",
  "dialogue-web/playwright-report/",
  "dialogue-web/test-results/",
  "**decompile-output**/",
  "contentprobe.out",
  "tools/stardew-content-probe/",
]);
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".bmp",
  ".dll",
  ".exe",
  ".gif",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mp3",
  ".mp4",
  ".nupkg",
  ".pdf",
  ".png",
  ".so",
  ".tar",
  ".tgz",
  ".wasm",
  ".webm",
  ".woff",
  ".woff2",
  ".zip",
]);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export async function collectOwnedTextPaths({ root = REPOSITORY_ROOT, git = gitPaths } = {}) {
  const normalizedRoot = await realpath(root);
  const tracked = await git(["ls-files", "-z"], normalizedRoot);
  const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], normalizedRoot);
  return [...new Set([...parseNullPaths(tracked), ...parseNullPaths(untracked)])]
    .filter((relativePath) => typeof relativePath === "string" && relativePath.length > 0)
    .filter((relativePath) => isOwnedCandidate(relativePath))
    .sort((left, right) => left.localeCompare(right));
}

export async function checkTextHygiene({ root = REPOSITORY_ROOT, git = gitPaths } = {}) {
  const normalizedRoot = await realpath(root);
  const violations = [];
  for (const relativePath of await collectOwnedTextPaths({ root: normalizedRoot, git })) {
    const absolutePath = resolveOwnedPath(normalizedRoot, relativePath);
    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
    if (!fileStat.isFile() || fileStat.size > MAX_TEXT_BYTES || hasBinaryExtension(relativePath)) continue;
    const bytes = await readFile(absolutePath);
    violations.push(...inspectText(relativePath, bytes));
  }
  return Object.freeze({
    verdict: violations.length === 0 ? "passed" : "blocked",
    checkedAt: new Date().toISOString(),
    violations: Object.freeze(violations),
  });
}

export function inspectText(relativePath, bytes) {
  const issues = [];
  if (bytes.includes(0)) return [issue(relativePath, "embedded_nul")];
  if (bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) issues.push(issue(relativePath, "utf8_bom"));
  const text = bytes.toString("utf8");
  if (text.includes("\uFFFD")) issues.push(issue(relativePath, "invalid_utf8"));
  const hasCrLf = text.includes("\r\n");
  const hasLf = /(?<!\r)\n/.test(text);
  const hasBareCr = /\r(?!\n)/.test(text);
  if (hasBareCr || (hasCrLf && hasLf)) issues.push(issue(relativePath, "mixed_eol"));
  if (text.length > 0 && !text.endsWith("\n")) issues.push(issue(relativePath, "missing_final_newline"));
  text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .forEach((line, index) => {
      if (/[ \t]+$/.test(line)) issues.push(issue(relativePath, "trailing_whitespace", index + 1));
    });
  return issues;
}

function issue(pathname, reason, line) {
  return Object.freeze({ path: pathname, reason, ...(line === undefined ? {} : { line }) });
}

function isOwnedCandidate(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  return !EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix) || normalized.includes(prefix));
}

function hasBinaryExtension(relativePath) {
  return BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function resolveOwnedPath(root, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const absolutePath = path.resolve(root, normalized);
  if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error("text_hygiene_path_escape");
  return absolutePath;
}

function normalizeRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error("text_hygiene_invalid_path");
  }
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("text_hygiene_invalid_path");
  }
  return normalized;
}

function parseNullPaths(output) {
  return output.split("\0").filter(Boolean);
}

function gitPaths(arguments_, cwd) {
  return execFileSync("git", arguments_, { cwd, encoding: "utf8", windowsHide: true });
}

function isMissingPath(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkTextHygiene();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.verdict === "passed" ? 0 : 1;
}
