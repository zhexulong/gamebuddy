#!/usr/bin/env node
/**
 * validate-tavern-card.mjs
 *
 * Deterministic SillyTavern Character Card V2 (CCv2) and WorldBook specification gate.
 * Validates character cards and world books against official SillyTavern schemas,
 * dialogue syntax rules, and GameBuddy runtime constraints.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export function validateCharacterCardV2(card, { source = "card.json" } = {}) {
  const errors = [];

  if (typeof card !== "object" || card === null) {
    return { ok: false, errors: [`${source}: Root must be an object`] };
  }

  // 1. Root spec fields
  if (card.spec !== "chara_card_v2") {
    errors.push(`${source}: spec must be 'chara_card_v2', got '${card.spec}'`);
  }
  if (card.spec_version !== "2.0") {
    errors.push(`${source}: spec_version must be '2.0', got '${card.spec_version}'`);
  }
  if (typeof card.data !== "object" || card.data === null) {
    errors.push(`${source}: data must be an object`);
    return { ok: false, errors };
  }

  const d = card.data;

  // 2. Mandatory core fields
  const requiredStrings = ["name", "description", "personality", "scenario", "first_mes", "mes_example"];
  for (const field of requiredStrings) {
    if (typeof d[field] !== "string" || d[field].trim().length === 0) {
      errors.push(`${source}: data.${field} must be a non-empty string`);
    }
  }

  // 3. Dialogue example syntax check
  if (typeof d.mes_example === "string") {
    if (!d.mes_example.includes("<START>")) {
      errors.push(`${source}: data.mes_example should contain '<START>' conversation separators`);
    }
    if (!d.mes_example.includes("{{char}}") && !d.mes_example.includes(d.name)) {
      errors.push(`${source}: data.mes_example should reference {{char}} or character name '${d.name}'`);
    }
    if (!d.mes_example.includes("{{user}}")) {
      errors.push(`${source}: data.mes_example should reference {{user}}`);
    }
  }

  // 4. Alternate greetings (if present)
  if (d.alternate_greetings !== undefined) {
    if (!Array.isArray(d.alternate_greetings)) {
      errors.push(`${source}: data.alternate_greetings must be an array of strings`);
    } else {
      for (let i = 0; i < d.alternate_greetings.length; i++) {
        if (typeof d.alternate_greetings[i] !== "string" || d.alternate_greetings[i].trim().length === 0) {
          errors.push(`${source}: data.alternate_greetings[${i}] must be a non-empty string`);
        }
      }
    }
  }

  // 5. Embedded character book (if present)
  if (d.character_book !== undefined) {
    if (typeof d.character_book !== "object" || d.character_book === null) {
      errors.push(`${source}: data.character_book must be an object`);
    } else {
      const cb = d.character_book;
      if (!Array.isArray(cb.entries)) {
        errors.push(`${source}: data.character_book.entries must be an array`);
      } else {
        let hasConstant = false;
        let hasKeyword = false;
        for (let i = 0; i < cb.entries.length; i++) {
          const e = cb.entries[i];
          if (typeof e.content !== "string" || e.content.trim().length === 0) {
            errors.push(`${source}: character_book.entries[${i}].content must be non-empty`);
          }
          if (!Array.isArray(e.keys)) {
            errors.push(`${source}: character_book.entries[${i}].keys must be an array`);
          } else if (e.keys.some((k) => typeof k !== "string" || k.trim().length === 0)) {
            errors.push(`${source}: character_book.entries[${i}].keys must not contain empty strings`);
          }
          if (e.constant === true) hasConstant = true;
          if (e.constant !== true) hasKeyword = true;
        }
        if (!hasConstant) {
          errors.push(`${source}: character_book must contain at least one always-on entry (constant: true)`);
        }
        if (!hasKeyword) {
          errors.push(`${source}: character_book must contain at least one keyword-gated entry (constant: false)`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateWorldBook(wb, { source = "worldbook.json" } = {}) {
  const errors = [];
  if (typeof wb !== "object" || wb === null) {
    return { ok: false, errors: [`${source}: Root must be an object`] };
  }
  if (wb.schemaVersion !== 1) {
    errors.push(`${source}: schemaVersion must be 1, got ${wb.schemaVersion}`);
  }
  if (typeof wb.worldBookId !== "string" || wb.worldBookId.trim().length === 0) {
    errors.push(`${source}: worldBookId must be a non-empty string`);
  }
  if (typeof wb.revision !== "number" || wb.revision < 1) {
    errors.push(`${source}: revision must be a positive integer`);
  }
  if (!Array.isArray(wb.entries) || wb.entries.length === 0) {
    errors.push(`${source}: entries must be a non-empty array`);
  } else {
    let hasConstant = false;
    let hasKeyword = false;
    for (let i = 0; i < wb.entries.length; i++) {
      const e = wb.entries[i];
      if (typeof e.entryId !== "string" || e.entryId.length === 0) {
        errors.push(`${source}: entries[${i}].entryId must be a non-empty string`);
      }
      if (typeof e.title !== "string" || e.title.length === 0) {
        errors.push(`${source}: entries[${i}].title must be a non-empty string`);
      }
      if (typeof e.content !== "string" || e.content.length === 0) {
        errors.push(`${source}: entries[${i}].content must be a non-empty string`);
      }
      if (e.constant === true) hasConstant = true;
      if (e.constant !== true) hasKeyword = true;
    }
    if (!hasConstant) errors.push(`${source}: must contain at least one constant: true entry`);
    if (!hasKeyword) errors.push(`${source}: must contain at least one keyword entry`);
  }
  return { ok: errors.length === 0, errors };
}

export function validatePresetDirectory(dirPath) {
  const name = path.basename(dirPath);
  console.log(`[audit] Validating Tavern Preset: ${name} (${dirPath})`);

  const cardPath = path.join(dirPath, "card.json");
  const wbPath = path.join(dirPath, "worldbook.json");
  const attrPath = path.join(dirPath, "ATTRIBUTION.md");

  if (!fs.existsSync(cardPath)) {
    console.error(`  [FAIL] Missing card.json in ${dirPath}`);
    return false;
  }
  if (!fs.existsSync(wbPath)) {
    console.error(`  [FAIL] Missing worldbook.json in ${dirPath}`);
    return false;
  }
  if (!fs.existsSync(attrPath)) {
    console.error(`  [FAIL] Missing ATTRIBUTION.md in ${dirPath}`);
    return false;
  }

  const card = JSON.parse(fs.readFileSync(cardPath, "utf8"));
  const wb = JSON.parse(fs.readFileSync(wbPath, "utf8"));

  const cardRes = validateCharacterCardV2(card, { source: `${name}/card.json` });
  const wbRes = validateWorldBook(wb, { source: `${name}/worldbook.json` });

  let allOk = true;
  if (!cardRes.ok) {
    allOk = false;
    for (const err of cardRes.errors) console.error(`  [CARD ERROR] ${err}`);
  }
  if (!wbRes.ok) {
    allOk = false;
    for (const err of wbRes.errors) console.error(`  [WORLDBOOK ERROR] ${err}`);
  }

  if (allOk) {
    console.log(`  [PASS] CCv2 & WorldBook specifications verified ✓ (Persona: ${card.data.name})`);
  }
  return allOk;
}

// CLI Execution
const targetArg = process.argv[2];
if (targetArg) {
  const target = path.resolve(ROOT, targetArg);
  const ok = validatePresetDirectory(target);
  process.exit(ok ? 0 : 1);
} else {
  const presetsDir = path.join(ROOT, "assets", "tavern", "presets");
  let totalPass = true;
  for (const entry of fs.readdirSync(presetsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const ok = validatePresetDirectory(path.join(presetsDir, entry.name));
      if (!ok) totalPass = false;
    }
  }
  process.exit(totalPass ? 0 : 1);
}
