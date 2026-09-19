#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const inventoryPath = path.join(root, "migration/document-inventory.csv");

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

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

const rows = parseCsv(await readFile(inventoryPath, "utf8"));
const header = rows.shift();
const index = Object.fromEntries(header.map((name, position) => [name, position]));

for (const row of rows) {
  const oldPath = row[index.old_path];
  row[index.status] = "archived";
  row[index.action] = "redacted-snapshot";
  row[index.target_path] = `archive/legacy-sources/${oldPath}`;
  const existing = row[index.notes];
  const archiveNote = "Historical snapshot archived; current rules live only in governed owner documents.";
  row[index.notes] = existing.includes(archiveNote) ? existing : `${existing}${existing ? " " : ""}${archiveNote}`;
}

const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
await writeFile(inventoryPath, csv, "utf8");
console.log(JSON.stringify({ archivedRows: rows.length }));
