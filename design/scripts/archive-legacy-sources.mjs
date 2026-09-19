#!/usr/bin/env node

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const archiveRoot = "archive/legacy-sources";
const excludedRoots = new Set([
  ".git",
  ".github",
  "node_modules",
  "handbook",
  "architecture",
  "domains",
  "adr",
  "operations",
  "research",
  "tasks",
  "archive",
  "scripts",
  "templates",
  "migration",
]);
const excludedRootFiles = new Set(["README.md"]);

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute)));
    else files.push(path.relative(root, absolute).replaceAll("\\", "/"));
  }
  return files;
}

function isLegacyMarkdown(file) {
  const first = file.split("/", 1)[0];
  return file.toLowerCase().endsWith(".md") && !excludedRootFiles.has(file) && !excludedRoots.has(first);
}

function logicalSourcePath(source) {
  return source.startsWith(".migration-sources/") ? source.slice(".migration-sources/".length) : source;
}

function archivePath(source) {
  return `${archiveRoot}/${source}`;
}

function redact(content) {
  return content
    .replace(/file:\/\/\/[^\s"'`)\]>]+/gi, "<LOCAL_PATH>")
    .replace(/\b[A-Za-z]:(?:\\\\)+(?:[^\s"'`)\]>]+(?:\\\\)+)*[^\s"'`)\]>]*/g, "<LOCAL_PATH>")
    .replace(/\b[A-Za-z]:[\\/](?![\\/])(?:[^\s"'`)\]>]+[\\/])*[^\s"'`)\]>]*/g, "<LOCAL_PATH>")
    .replace(/\/(?:home|Users)\/[^\s"'`)\]>]+/g, "<LOCAL_PATH>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/gi, "Bearer <REDACTED>")
    .replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "<REDACTED_GITHUB_TOKEN>")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "<REDACTED_PROVIDER_KEY>")
    .replace(/\b(api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}["']?/gi, "$1: <REDACTED>")
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "<REDACTED_PRIVATE_KEY>");
}

function rewriteLinks(content, source, legacySet) {
  return content.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (whole, label, rawTarget) => {
    const target = rawTarget.trim().replace(/^<|>$/g, "");
    if (!target || /^(?:https?:|mailto:|#)/i.test(target)) return whole;
    const [withoutAnchor, anchor = ""] = target.split("#", 2);
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), withoutAnchor));
    if (legacySet.has(resolved)) {
      const from = path.posix.dirname(archivePath(source));
      const to = archivePath(resolved);
      const relative = path.posix.relative(from, to) || path.posix.basename(to);
      return `[${label}](${relative}${anchor ? `#${anchor}` : ""})`;
    }
    return `${label}（历史链接：\`${rawTarget}\`）`;
  });
}

if (redact("https://github.com/zhexulong/gamebuddy-docs") !== "https://github.com/zhexulong/gamebuddy-docs") {
  throw new Error("redaction must preserve HTTPS URLs");
}
if (redact("C:/Users/example/private.txt") !== "<LOCAL_PATH>") {
  throw new Error("redaction must replace Windows absolute paths");
}
if (redact(String.raw`E:\\projects\\private\\artifact.txt`) !== "<LOCAL_PATH>") {
  throw new Error("redaction must replace JSON-escaped Windows absolute paths");
}

const files = await walk(root);
const sources = files.filter(isLegacyMarkdown).sort();
await rm(path.join(root, archiveRoot), { recursive: true, force: true });
const logicalSources = sources.map(logicalSourcePath);
const legacySet = new Set(logicalSources);
if (logicalSources.length !== legacySet.size) throw new Error("duplicate logical migration source path");

for (const source of sources) {
  const logicalSource = logicalSourcePath(source);
  const target = archivePath(logicalSource);
  const original = await readFile(path.join(root, source), "utf8");
  const body = rewriteLinks(redact(original), logicalSource, legacySet)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n*$/, "\n");
  const rootReadme = path.posix.relative(path.posix.dirname(target), "README.md");
  const banner = [
    "> [!WARNING]",
    `> 此文件是迁移时保存的脱敏历史快照，不是现行规范。现行入口见 [\`README.md\`](${rootReadme})。`,
    `> 原路径：\`${logicalSource}\`。本机路径、credential 形态和 runtime artifact 路径可能已替换为占位符。`,
    "",
  ].join("\n");
  await mkdir(path.dirname(path.join(root, target)), { recursive: true });
  await writeFile(path.join(root, target), `${banner}${body}`, "utf8");
}

await writeFile(
  path.join(root, archiveRoot, "README.md"),
  [
    "# 旧资料脱敏快照",
    "",
    "本目录按原相对路径保存迁移前资料。所有内容均为历史背景，不是 current authority。",
    "",
    "需要了解现行行为时，从仓库根 `README.md` 进入 `handbook/`、`architecture/`、`domains/` 和 `tasks/`。",
    "",
  ].join("\n"),
  "utf8",
);

console.log(JSON.stringify({ archivedMarkdown: sources.length, archiveRoot }));
