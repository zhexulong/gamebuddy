import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([".git", "node_modules"]);
const migratedRoots = new Set([".github", "handbook", "architecture", "domains", "adr", "operations", "tasks", "archive", "scripts", "templates", "migration"]);
const migratedRootFiles = new Set(["README.md"]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute)));
    else files.push(path.relative(root, absolute).replaceAll("\\", "/"));
  }
  return files;
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function classify(file) {
  const name = path.basename(file).toUpperCase();
  const lower = file.toLowerCase();
  let type = "reference";
  if (name.includes("IMPLEMENTATION_PLAN")) type = "implementation-plan";
  else if (name.includes("DESIGN") || name.includes("ARCHITECTURE") || name.includes("SPEC")) type = "design";
  else if (lower.includes("/research/") || lower.startsWith("research/")) type = "research";
  else if (name.includes("RUNBOOK")) type = "operations";
  else if (lower.includes("/review/") || lower.startsWith("review/")) type = "review";
  else if (lower.includes("legacy/") || lower.startsWith("archive/")) type = "archive";

  let domain = "cross-cutting";
  if (/CHAT|TAVERN|DIALOGUE/.test(name)) domain = "chat";
  else if (/MEMORY|CONTEXT|CONTINUITY/.test(name)) domain = "memory";
  else if (/VOICE|ASR|TTS|MULTIMODAL/.test(name)) domain = "voice";
  else if (/STARDEW|FARMHAND|MINE|NAVIGATION/.test(name)) domain = "stardew";
  else if (/GAME_ACTION|GAMEPLAY|GAME_PIPELINE|CATEGORY_THEORETIC/.test(name)) domain = "game";
  else if (/COMMUNITY|CONNECTOR/.test(name)) domain = "community-connectors";
  else if (/TEST|EVIDENCE|BDD|RELEASE|WINDOWS|DISTRIBUTION/.test(name)) domain = "engineering";

  const status = lower.includes("legacy/") ? "archived-source" : type === "research" ? "research-source" : "historical-source";
  const owner = {
    chat: "chat",
    memory: "memory",
    voice: "voice",
    stardew: "stardew-integration",
    game: "game-runtime",
    "community-connectors": "game-platform",
    engineering: "release-engineering",
    "cross-cutting": "product",
  }[domain];
  const base = path.basename(file);
  const action = type === "research" ? "redact-and-retain" : type === "archive" ? "redact-and-archive" : "extract-and-archive";
  const targetPath = type === "research"
    ? `research/${base}`
    : type === "review"
      ? `archive/reviews/${base}`
      : `archive/legacy-numbered/${base}`;
  const notes = type === "research"
    ? "Non-authoritative research; revalidate current facts before adoption."
    : "Long-term rules must be extracted into a current owner before the source is archived.";
  return { type, domain, status, owner, action, targetPath, notes };
}

function markdownLinks(text) {
  const links = [];
  const regex = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of text.matchAll(regex)) {
    const target = match[1].trim();
    if (!target || /^(https?:|mailto:|#)/i.test(target)) continue;
    links.push(target.split("#", 1)[0].replaceAll("\\", "/"));
  }
  return links;
}

const allFiles = (await walk(root)).sort();
const sourceFiles = allFiles.filter((file) => {
  const first = file.split("/", 1)[0];
  return !migratedRootFiles.has(file) && !migratedRoots.has(first);
});
const markdown = sourceFiles.filter((file) => file.toLowerCase().endsWith(".md"));
const rows = [];
const edges = [];
const missing = [];
const fileSet = new Set(allFiles);

for (const file of markdown) {
  const text = await readFile(path.join(root, file), "utf8");
  const firstHeading = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  const numberPrefix = path.basename(file).match(/^(\d+)_/)?.[1] ?? "";
  const { type, domain, status, owner, action, targetPath, notes } = classify(file);
  const links = markdownLinks(text);
  rows.push({ oldPath: file, title: firstHeading, numberPrefix, type, domain, status, owner, action, targetPath, notes });

  for (const link of links) {
    const resolved = path.normalize(path.join(path.dirname(file), link)).replaceAll("\\", "/");
    edges.push({ source: file, target: resolved });
    if (!fileSet.has(resolved)) missing.push({ source: file, target: resolved });
  }
}

const header = ["old_path", "title", "number_prefix", "type", "domain", "status", "owner", "action", "target_path", "notes"];
const csv = [header, ...rows.map((row) => Object.values(row))].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
await writeFile(path.join(root, "migration/document-inventory.csv"), csv, "utf8");
await writeFile(path.join(root, "migration/link-graph.json"), JSON.stringify({ generatedFrom: "repository working tree", nodes: markdown, edges }, null, 2) + "\n", "utf8");
await writeFile(path.join(root, "migration/missing-links.json"), JSON.stringify(missing, null, 2) + "\n", "utf8");

const duplicateNumbers = Object.entries(Object.groupBy(rows.filter((row) => row.numberPrefix), (row) => row.numberPrefix))
  .filter(([, items]) => items.length > 1)
  .map(([prefix, items]) => ({ prefix, files: items.map((item) => item.oldPath) }));
await writeFile(path.join(root, "migration/duplicate-number-prefixes.json"), JSON.stringify(duplicateNumbers, null, 2) + "\n", "utf8");

console.log(JSON.stringify({ files: sourceFiles.length, markdown: markdown.length, links: edges.length, missingLinks: missing.length, duplicateNumberGroups: duplicateNumbers.length }));
