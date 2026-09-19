#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const inventoryPath = path.join(root, "migration/document-inventory.csv");
const outputPath = path.join(root, "migration/semantic-coverage.csv");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell.replace(/\r$/, "")); if (row.some(Boolean)) rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function csvCell(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function candidateOwner(row) {
  const domain = row.domain;
  if (domain === "game" || domain === "stardew") return "domains/game/README.md; domains/stardew/README.md; architecture/game-action-model.md";
  if (domain === "memory") return "architecture/continuity-and-memory.md; domains/memory/README.md";
  if (domain === "voice") return "domains/voice/README.md";
  if (domain === "engineering") return "architecture/runtime-boundaries.md; architecture/release-model.md; operations/README.md";
  return "handbook/product-overview.md; handbook/current-status.md";
}

const inventoryRows = parseCsv(await readFile(inventoryPath, "utf8"));
const header = inventoryRows.shift();
const columns = Object.fromEntries(header.map((name, index) => [name, index]));
const output = [["old_path", "source_sections", "disposition", "current_owners", "preserved_constraints", "intentionally_removed", "open_gap", "review_status", "review_evidence"]];

for (const row of inventoryRows) {
  const oldPath = row[columns.old_path];
  const archiveFile = path.join(root, "archive/legacy-sources", oldPath);
  let sections = ["[archive snapshot unavailable; inspect source]"];
  try {
    const content = await readFile(archiveFile, "utf8");
    const headings = content.split(/\r?\n/).filter((line) => /^#{1,6}\s+/.test(line)).map((line) => line.replace(/^#+\s+/, "").trim());
    sections = headings.length ? headings : ["[no Markdown headings; inspect prose]"];
  } catch { /* Keep the ledger explicit about a missing source. */ }
  for (const section of sections) {
    output.push([oldPath, section, "", candidateOwner(Object.fromEntries(header.map((name, index) => [name, row[index]]))), "", "", "Not yet reviewed; chapter-level semantic coverage is unproven.", "unreviewed", ""]);
  }
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${output.map((row) => row.map(csvCell).join(",")).join("\n")}\n`, "utf8");
console.log(JSON.stringify({ records: output.length - 1, output: "migration/semantic-coverage.csv" }));
