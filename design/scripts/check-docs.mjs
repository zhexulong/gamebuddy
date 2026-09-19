#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."));
const ignoredDirs = new Set([".git", "node_modules"]);
const governedRoots = ["handbook", "architecture", "domains", "adr", "operations", "tasks", "research"];
const checkedRoots = [...governedRoots, "archive"];
const longStatuses = new Set(["draft", "current", "superseded", "archived"]);
const taskStatuses = new Set(["planned", "active", "blocked", "completed", "cancelled"]);
const taskTypes = new Set(["task", "task-plan", "task-requirements", "task-design"]);
const archivedSnapshotRoot = "archive/legacy-sources/";
const coverageStatuses = new Set(["unreviewed", "in-review", "reviewed", "accepted"]);
const dispositions = new Set(["", "consolidated", "split", "superseded", "historical-only", "obsolete", "gap"]);
const activeTaskRoot = "tasks/active/";
const errors = [];
const warnings = [];
const ids = new Map();
const documents = new Map();

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(absolute)));
    else result.push(absolute);
  }
  return result;
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function scalar(lines, key) {
  const prefix = `${key}:`;
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length).trim().replace(/^['"]|['"]$/g, "") ?? "";
}

function list(lines, key) {
  const index = lines.findIndex((candidate) => candidate === `${key}:`);
  if (index < 0) return [];
  const values = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const match = /^\s+-\s+(.+)$/.exec(lines[cursor]);
    if (!match) break;
    values.push(match[1].trim().replace(/^['"]|['"]$/g, ""));
  }
  return values;
}

function frontmatter(content) {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return null;
  const lines = content.slice(4, end).split("\n");
  return {
    id: scalar(lines, "id"),
    type: scalar(lines, "type"),
    status: scalar(lines, "status"),
    owner: scalar(lines, "owner"),
    owners: list(lines, "owners"),
    specs: list(lines, "specs"),
    supersedes: list(lines, "supersedes"),
  };
}

function isGoverned(file) {
  const relative = rel(file);
  return file === path.join(root, "README.md") || governedRoots.some((prefix) => relative.startsWith(`${prefix}/`));
}

function isCheckedDocument(file) {
  const relative = rel(file);
  return file === path.join(root, "README.md") || checkedRoots.some((prefix) => relative.startsWith(`${prefix}/`));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  return rows;
}

function isExternalTarget(target) {
  return /^(?:https?:|mailto:|#)/i.test(target);
}

function markdownHeadings(content) {
  return new Set(content.split(/\r?\n/).filter((line) => /^#{1,6}\s+/.test(line)).map((line) => line.replace(/^#+\s+/, "").trim()));
}

const files = await walk(root);
const markdown = files.filter((file) => file.endsWith(".md"));
const checkedMarkdown = markdown.filter(isCheckedDocument);
const knownRelativePaths = new Set(files.map(rel));

for (const file of checkedMarkdown) {
  const relative = rel(file);
  const content = await readFile(file, "utf8");
  const metadata = frontmatter(content);
  documents.set(relative, { metadata, content });

  if (isGoverned(file) && path.basename(file) !== "README.md" && !metadata && !relative.startsWith(archivedSnapshotRoot)) {
    errors.push(`${relative}: missing frontmatter`);
  }
  if (relative.startsWith(archivedSnapshotRoot) && path.basename(file) !== "README.md") {
    const requiredBanner = "此文件是迁移时保存的脱敏历史快照，不是现行规范";
    if (!content.includes(requiredBanner)) errors.push(`${relative}: missing archived snapshot warning`);
  }
  if (metadata) {
    for (const key of ["id", "type", "status"]) {
      if (!metadata[key]) errors.push(`${relative}: missing ${key}`);
    }
    if (!metadata.owner && metadata.owners.length === 0) errors.push(`${relative}: missing owner/owners`);
    if (metadata.id) {
      if (ids.has(metadata.id)) errors.push(`${relative}: duplicate id ${metadata.id} (also ${ids.get(metadata.id)})`);
      else ids.set(metadata.id, relative);
    }
    const allowed = taskTypes.has(metadata.type) ? taskStatuses : longStatuses;
    if (relative.startsWith(activeTaskRoot) && taskTypes.has(metadata.type) && !["planned", "active", "blocked"].includes(metadata.status)) {
      errors.push(`${relative}: completed or cancelled task must move to archive/tasks`);
    }
    if (metadata.status && !allowed.has(metadata.status)) {
      errors.push(`${relative}: invalid ${taskTypes.has(metadata.type) ? "task " : ""}status ${metadata.status}`);
    }
  }

  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, "").split("#", 1)[0];
    if (!raw || isExternalTarget(raw) || raw.includes("${")) continue;
    let decoded;
    try { decoded = decodeURIComponent(raw); } catch { decoded = raw; }
    const target = rel(path.resolve(path.dirname(file), decoded));
    if (target.startsWith("../")) {
      warnings.push(`${relative}: link leaves docs repository: ${raw}`);
      continue;
    }
    const directoryTarget = raw.endsWith("/") && knownRelativePaths.has(`${target}/README.md`);
    if (!knownRelativePaths.has(target) && !directoryTarget) errors.push(`${relative}: missing link target ${raw}`);
  }
}

for (const [relative, document] of documents) {
  const metadata = document.metadata;
  if (!metadata || !taskTypes.has(metadata.type) || !["planned", "active", "blocked"].includes(metadata.status)) continue;
  for (const spec of metadata.specs) {
    const target = spec.replace(/^\.\//, "");
    const resolved = documents.get(target);
    if (!resolved) errors.push(`${relative}: missing spec ${spec}`);
    else if (["superseded", "archived"].includes(resolved.metadata?.status)) {
      errors.push(`${relative}: active task references ${resolved.metadata.status} spec ${spec}`);
    }
  }
}

const coverageFile = path.join(root, "migration", "semantic-coverage.csv");
if (knownRelativePaths.has("migration/semantic-coverage.csv")) {
  const rows = parseCsv(await readFile(coverageFile, "utf8"));
  const header = rows.shift() ?? [];
  const columns = Object.fromEntries(header.map((name, index) => [name, index]));
  const coverageSources = new Set();
  const coverageSections = new Map();
  const coverageStatusCounts = new Map([...coverageStatuses].map((status) => [status, 0]));
  let batch002ReviewCount = 0;
  for (const row of rows) {
    const source = row[columns.old_path];
    const disposition = row[columns.disposition];
    const status = row[columns.review_status];
    if (!source) errors.push("migration/semantic-coverage.csv: empty old_path");
    coverageSources.add(source);
    const sections = coverageSections.get(source) ?? [];
    sections.push(row[columns.source_sections]);
    coverageSections.set(source, sections);
    coverageStatusCounts.set(status, (coverageStatusCounts.get(status) ?? 0) + 1);
    if (!knownRelativePaths.has(`${archivedSnapshotRoot}${source}`)) errors.push(`migration/semantic-coverage.csv: missing source archive ${source}`);
    if (!dispositions.has(disposition)) errors.push(`migration/semantic-coverage.csv: ${source} has invalid disposition ${disposition}`);
    if (!coverageStatuses.has(status)) errors.push(`migration/semantic-coverage.csv: ${source} has invalid review_status ${status}`);
    if (status !== "unreviewed" && !row[columns.review_evidence]) errors.push(`migration/semantic-coverage.csv: ${source} needs review_evidence`);
    if (["reviewed", "accepted"].includes(status) && !disposition) errors.push(`migration/semantic-coverage.csv: ${source} reviewed entry needs disposition`);
    if (["reviewed", "accepted"].includes(status) && !row[columns.preserved_constraints] && !row[columns.intentionally_removed]) errors.push(`migration/semantic-coverage.csv: ${source} reviewed entry needs preserved or removed rationale`);
    if (["gap", "historical-only", "obsolete", "superseded"].includes(disposition) && !row[columns.intentionally_removed] && !row[columns.open_gap]) errors.push(`migration/semantic-coverage.csv: ${source} needs disposition rationale`);
    if (disposition === "gap" && !row[columns.current_owners]) errors.push(`migration/semantic-coverage.csv: ${source} gap needs accountable current owner`);
    const reviewEvidence = row[columns.review_evidence] ?? "";
    if (reviewEvidence.includes("migration/coverage-batch-002-review.md")) batch002ReviewCount += 1;
    const strictGapAccountability = /migration\/coverage-batch-(?:00[2-9]|0[1-9]\d|[1-9]\d{2,})-review\.md/.test(reviewEvidence);
    if (["reviewed", "accepted"].includes(status) && row[columns.open_gap] && strictGapAccountability) {
      const openGap = row[columns.open_gap];
      for (const marker of ["accountable owner:", "target artifact:", "next step:", "blocking reason:", "closure evidence:"]) {
        const count = openGap.toLowerCase().split(marker).length - 1;
        if (count !== 1) errors.push(`migration/semantic-coverage.csv: ${source} open_gap needs exactly one ${marker}; found ${count}`);
      }
      const targetArtifact = openGap.match(/target artifact:\s*([^;]+)/i)?.[1]?.trim();
      if (!targetArtifact || !knownRelativePaths.has(targetArtifact)) errors.push(`migration/semantic-coverage.csv: ${source} open_gap has missing target artifact ${targetArtifact ?? ""}`);
    }
    if (status !== "unreviewed" && row[columns.current_owners]) {
      for (const owner of row[columns.current_owners].split(/;\s*/).filter(Boolean)) {
        const [ownerPath, heading] = owner.split("#", 2);
        if (!knownRelativePaths.has(ownerPath)) errors.push(`migration/semantic-coverage.csv: ${source} missing current owner ${ownerPath}`);
        else if (heading) {
          const ownerContent = await readFile(path.join(root, ownerPath), "utf8");
          if (!markdownHeadings(ownerContent).has(heading)) errors.push(`migration/semantic-coverage.csv: ${source} missing owner heading ${owner}`);
        }
      }
    }
  }
  const inventoryRows = parseCsv(await readFile(path.join(root, "migration", "document-inventory.csv"), "utf8"));
  for (const row of inventoryRows.slice(1)) {
    const source = row[0];
    if (!coverageSources.has(source)) errors.push(`migration/semantic-coverage.csv: missing inventory source ${source}`);
    const archive = await readFile(path.join(root, archivedSnapshotRoot, source), "utf8");
    const expected = archive.split(/\r?\n/).filter((line) => /^#{1,6}\s+/.test(line)).map((line) => line.replace(/^#+\s+/, "").trim());
    if (!expected.length) expected.push("[no Markdown headings; inspect prose]");
    const actual = coverageSections.get(source) ?? [];
    const expectedCounts = new Map();
    const actualCounts = new Map();
    for (const section of expected) expectedCounts.set(section, (expectedCounts.get(section) ?? 0) + 1);
    for (const section of actual) actualCounts.set(section, (actualCounts.get(section) ?? 0) + 1);
    for (const section of new Set([...expectedCounts.keys(), ...actualCounts.keys()])) {
      if ((expectedCounts.get(section) ?? 0) !== (actualCounts.get(section) ?? 0)) errors.push(`migration/semantic-coverage.csv: ${source} section mismatch ${section}`);
    }
  }
  if (coverageSources.size !== inventoryRows.length - 1) errors.push(`migration/semantic-coverage.csv: expected ${inventoryRows.length - 1} unique sources, found ${coverageSources.size}`);
  if (knownRelativePaths.has("migration/coverage-batch-002-review.md") && batch002ReviewCount !== 378) errors.push(`migration/semantic-coverage.csv: Batch 002 review must cover 378 records, found ${batch002ReviewCount}`);
  const summary = await readFile(path.join(root, "migration", "semantic-coverage-summary.md"), "utf8");
  for (const status of coverageStatuses) {
    const count = (coverageStatusCounts.get(status) ?? 0).toLocaleString("en-US");
    if (!summary.includes(`| \`${status}\` | ${count} |`)) errors.push(`migration/semantic-coverage-summary.md: stale ${status} count; expected ${count}`);
  }
}

const inventoryFile = path.join(root, "migration", "document-inventory.csv");
if (knownRelativePaths.has("migration/document-inventory.csv")) {
  const rows = parseCsv(await readFile(inventoryFile, "utf8"));
  const header = rows.shift() ?? [];
  const columns = Object.fromEntries(header.map((name, index) => [name, index]));
  const inventoryTargets = new Set();
  for (const row of rows) {
    const oldPath = row[columns.old_path];
    const target = row[columns.target_path];
    if (row[columns.status] !== "archived" || row[columns.action] !== "redacted-snapshot") {
      errors.push(`migration/document-inventory.csv: ${oldPath} is not marked as an archived redacted snapshot`);
    }
    if (target !== `${archivedSnapshotRoot}${oldPath}`) {
      errors.push(`migration/document-inventory.csv: ${oldPath} has unexpected target ${target}`);
    }
    if (inventoryTargets.has(target)) errors.push(`migration/document-inventory.csv: duplicate target ${target}`);
    inventoryTargets.add(target);
    if (!knownRelativePaths.has(target)) errors.push(`migration/document-inventory.csv: missing archived target ${target}`);
  }
  const snapshots = [...knownRelativePaths].filter((relative) => relative.startsWith(archivedSnapshotRoot) && relative.endsWith(".md") && relative !== `${archivedSnapshotRoot}README.md`);
  for (const snapshot of snapshots) {
    if (!inventoryTargets.has(snapshot)) errors.push(`${snapshot}: archived snapshot missing from inventory`);
  }
}

for (const file of files) {
  const info = await stat(file);
  if (info.size > 512_000) warnings.push(`${rel(file)}: large repository artifact (${info.size} bytes)`);
}

if (warnings.length) {
  console.warn(`Warnings (${warnings.length}):`);
  for (const warning of warnings) console.warn(`- ${warning}`);
}
if (errors.length) {
  console.error(`Errors (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation checks passed: ${checkedMarkdown.length} current/archive Markdown files, ${ids.size} governed IDs.`);
}
