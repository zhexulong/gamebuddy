#!/usr/bin/env node
/**
 * Loop-closure feasibility gate for the Stardew action surface.
 *
 * An action must close a real loop to be worth implementing: ① the entry must be
 * public/callable, ② its native effect must be reachable without realtime input,
 * ③ that effect must be observable as a terminal write (world/item/warp/state),
 * and ④ the terminal must not be a menu that the Agent cannot dismiss.
 *
 * This gate derives its candidate list from the THREE adjudication tables in
 * stardew-action-inventory-reconciliation.mjs (SELECTOR_VERDICTS /
 * METHOD_VERDICTS / REJECTED_LAYER_VERDICTS) -- it does not keep its own copy.
 * Every `new_primitive_needed` row must carry an anchor of the form
 * `File.cs:line` (optionally `-> File.cs:line` for a chained terminal); the gate
 * resolves that anchor in the target-version decompile and checks the signals
 * mechanically. A unit that cannot be verified fails the gate, so a seam that
 * turns private or disappears breaks the build instead of silently keeping the
 * primitive on the plan.
 *
 * Verdicts:
 *   closable      entry is public, reaches a non-menu terminal
 *   blocked       private entry, realtime-input-only, or menu-only terminal
 *   verify_chain  the anchor is a delegation chain; the terminal hop still needs
 *                 a live receipt but the static shape is sound
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SELECTOR_VERDICTS, METHOD_VERDICTS } from "../integrations/stardew/action-development/src/analysis/stardew-action-inventory-reconciliation.mjs";
import { REJECTED_LAYER_VERDICTS } from "../integrations/stardew/action-development/src/analysis/stardew-rejected-layer-verdicts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REF = path.join(ROOT, "ref", "external", "StardewValleyDecompiled", "Stardew Valley");

class Missing extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new Missing(code, message);
}

/** Balanced-brace extraction of the first method body matching `member`. */
function methodBody(src, member) {
  const re = new RegExp(
    `(?:public|private|protected|internal)(?:\\s+(?:static|virtual|override|abstract|sealed|async|extern|unsafe|new|readonly))*\\s+[\\w<>,\\[\\].\\s?]+?\\s+${member}\\s*\\([^)]*\\)\\s*(?:=>)?\\s*\\{`,
    "g",
  );
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf("{", m.index + m[0].length - 1);
  if (open < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let j = open; j < src.length; j++) {
    const ch = src[j];
    if (ch === '"' && src[j - 1] !== "\\") inStr = !inStr;
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { body: src.slice(open, j + 1), decl: src.slice(m.index, open).trim() };
    }
  }
  return null;
}

/** The native effect signals, aligned with the extractor vocabulary. */
const SIGNALS = {
  realtime: /didPlayerJustRightClick|didPlayerJustClickAtAll|isAnyGamePadButtonBeingPressed|Game1\.(oldMouseState|mouseState|oldKBState|inputState|isKeyDown)|receiveLeftClick|receiveKeyPress/,
  menu: /activeClickableMenu\s*=\s*new|ShowMenu\(|TryOpenShopMenu|OpenDonationMenu|createQuestionDialogue/,
  dialogue: /Game1\.drawDialogue|drawObjectDialogue|drawDialogue\(/,
  worldWrite: /\.Value\s*=[^=]|health\s*[-+]?=|numberOfWeeds|heldObject\s*=|displayItem|fruit\[|\.Add\(|\.Remove\(|\bSeedDropItems\b|TryGetDrop/,
  warp: /warpFarmer|MinecartWarp|enterMine|PassOutNewDay|new\s+Warp\s*\(/,
  giveItem: /addItemToInventory|StoreHayInAnySilo|TryAdd|Items\.Add|DropObject/,
  state: /\b\w+\.Value\s*=\s*(?:true|false)|\bon\s*=|\bisRafting\b|\bopen\s*=|lightSourceId/,
};

/** Find a file by basename under the decompile root. */
async function findInRef(basename) {
  const stack = [REF];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await import("node:fs/promises").then((f) => f.readdir(dir, { withFileTypes: true }));
    } catch {
      return null;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === basename) return full;
    }
  }
  return null;
}

/**
 * Parse an anchor into hops. Accepted forms:
 *   `File.cs:123`
 *   `File.cs:123 -> File.cs:456`
 *   `File.cs:123 -> File.cs:456 Helper -> File.cs:789 other`
 * Trailing prose after a hop's line number (a helper name) is allowed -- the
 * tables use it to name the delegating member.
 */
function parseAnchor(anchor) {
  if (!anchor) return null;
  const hops = [];
  for (const raw of String(anchor).split("->")) {
    const h = raw.trim();
    if (!h) continue;
    const m = h.match(/^([A-Za-z0-9_.]+)\.cs:(\d+)/);
    // A trailing segment that is not a `File.cs:line` hop is prose describing the
    // terminal (e.g. `fruit[j]=null + new Debris`); it carries no location and is
    // skipped. At least one real hop must remain.
    if (!m) continue;
    hops.push({ file: `${m[1]}.cs`, line: Number(m[2]) });
  }
  if (hops.length === 0) throw new Error(`anchor has no File.cs:line hop: "${anchor}"`);
  return hops;
}

async function anchorExists(hop) {
  const p = await findInRef(hop.file);
  if (!p) return { exists: false, why: `file ${hop.file} not found in decompile` };
  const text = await readFile(p, "utf8");
  const lines = text.split("\n");
  if (hop.line > lines.length) return { exists: false, why: `line ${hop.line} beyond ${hop.file} (${lines.length} lines)` };
  return { exists: true, text, lines, line: hop.line };
}

/** Check one hop: public entry? realtime? terminal write inside the method at line? */
function checkHop(anchor, hop, { lines, line }) {
  const lineText = lines[line - 1] ?? "";
  // Selector hop: the anchor is a `case "X":` line inside the big map-Action
  // interpreter. Resolve visibility from the enclosing method and check the
  // case branch segment (this case until the next `case ` / `break;`).
  if (/^\s*case\s*"[^"]*"\s*:/.test(lineText)) {
    const decl = enclosingDeclaration(lines, line);
    if (!decl) return { vis: "UNRESOLVED", body: null, why: `no enclosing declaration for selector at ${hop.file}:${line}` };
    const branch = caseBranch(lines, line);
    if (!branch) return { vis: decl.vis, body: null, why: `no branch body resolved for ${hop.file}:${line}` };
    const rt = SIGNALS.realtime.test(branch);
    const terminal = SIGNALS.worldWrite.test(branch) || SIGNALS.warp.test(branch) || SIGNALS.giveItem.test(branch) || SIGNALS.state.test(branch);
    const menuOnly = SIGNALS.menu.test(branch) && !terminal;
    return { vis: decl.vis, rt, terminal, menuOnly, bodyLength: branch.length, why: null, selector: true };
  }
  // Method hop: scan upward for the declaring member.
  let declLine = null;
  let declText = "";
  for (let l = line; l >= Math.max(1, line - 120); l--) {
    const t = lines[l - 1];
    if (/^\s*(public|private|protected|internal)\s/.test(t) && /\w+\s*\([^)]*\)/.test(t) && !t.trim().startsWith("//")) {
      declLine = l;
      declText = t;
      break;
    }
  }
  const vis = declText ? (/^\s*public\s/.test(declText) ? "public" : /^\s*protected\s/.test(declText) ? "protected" : "private") : "UNRESOLVED";
  // Extract the body of that declared member by balancing from the first `{`.
  const body = extractBodyFromLine(lines, declLine);
  if (!body) return { vis, body: null, why: `no body resolved for ${hop.file}:${declLine}` };
  const rt = SIGNALS.realtime.test(body);
  const terminal = SIGNALS.worldWrite.test(body) || SIGNALS.warp.test(body) || SIGNALS.giveItem.test(body) || SIGNALS.state.test(body);
  const menuOnly = SIGNALS.menu.test(body) && !terminal;
  return { vis, rt, terminal, menuOnly, bodyLength: body.length, why: null };
}

/** The visibility of the method enclosing `line` (for selector hops). */
function enclosingDeclaration(lines, line) {
  for (let l = line; l >= Math.max(1, line - 3000); l--) {
    const t = lines[l - 1];
    if (/^\s*(public|private|protected|internal)\s/.test(t) && /\w+\s*\([^)]*\)/.test(t) && !t.trim().startsWith("//")) {
      const vis = /^\s*public\s/.test(t) ? "public" : /^\s*protected\s/.test(t) ? "protected" : "private";
      return { vis, declLine: l };
    }
  }
  return null;
}

/** The text of one switch branch starting at the case line, up to the next `case ` / end. */
function caseBranch(lines, line) {
  const out = [];
  let depth = 0;
  let inStr = false;
  for (let l = line - 1; l < lines.length; l++) {
    const t = lines[l];
    out.push(t);
    for (let c = 0; c < t.length; c++) {
      const ch = t[c];
      if (ch === '"' && t[c - 1] !== "\\") inStr = !inStr;
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ";" && depth === 0 && /^\s*case\s+"/.test(t.trim())) return out.join("\n");
      else if (ch === ";" && depth === 0 && /break;|return true;/.test(t.trim()) && l > line - 1) return out.join("\n");
    }
  }
  return out.join("\n");
}

function extractBodyFromLine(lines, declLine) {
  if (!declLine) return null;
  // Find the `{` after the declaration line.
  let open = null;
  for (let l = declLine - 1; l < Math.min(lines.length, declLine + 8); l++) {
    const idx = lines[l].indexOf("{");
    if (idx >= 0) {
      open = { line: l + 1, col: idx };
      break;
    }
  }
  if (!open) return null;
  let depth = 0;
  let inStr = false;
  const out = [];
  for (let l = open.line - 1; l < lines.length; l++) {
    const lineText = lines[l];
    out.push(lineText);
    for (let c = l === open.line - 1 ? open.col : 0; c < lineText.length; c++) {
      const ch = lineText[c];
      if (ch === '"' && lineText[c - 1] !== "\\") inStr = !inStr;
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return out.join("\n");
      }
    }
  }
  return null;
}

/** Collect every new-primitive row from the three tables, dedupe by anchor. */
function collectCandidates() {
  const rows = [];
  for (const [key, v] of Object.entries(SELECTOR_VERDICTS)) {
    if (v?.group === "new_primitive_needed") rows.push({ key, at: v.at, actionId: v.actionId, anchor: v.anchor, reason: v.reason });
  }
  for (const [key, v] of Object.entries(METHOD_VERDICTS)) {
    if (v?.group === "new_primitive_needed") rows.push({ key, actionId: v.actionId, anchor: v.anchor, reason: v.reason });
  }
  for (const [key, v] of Object.entries(REJECTED_LAYER_VERDICTS)) {
    if (v?.group === "new_primitive_needed") rows.push({ key, actionId: v.actionId, anchor: v.anchor, reason: v.reason });
  }
  return rows;
}

/**
 * `--candidates <file.json>` drives the gate from an explicit list instead of the
 * shipped tables. Tests use it to exercise the block rules without touching the
 * shared adjudication tables (mutating those in-test has bitten this repository
 * before). The file is a JSON array of `{ actionId, anchor }`.
 */
async function candidatesFromArgs() {
  const a = process.argv.indexOf("--candidates");
  if (a < 0) return collectCandidates();
  const file = process.argv[a + 1];
  if (!file) fail("arguments_invalid", "--candidates requires a file path");
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(parsed)) fail("arguments_invalid", "--candidates file must contain a JSON array");
  return parsed;
}

async function main() {
  const candidates = await candidatesFromArgs();
  const results = [];
  const failures = [];
  const labelOf = (r) => `${r.actionId ?? "?"} (${r.at ? `${r.at}.` : ""}${r.key})`;

  for (const cand of candidates) {
    let hops;
    try {
      hops = parseAnchor(cand.anchor);
    } catch (e) {
      failures.push({ id: labelOf(cand), code: "anchor_unparseable", message: e.message });
      results.push({ ...cand, verdict: "blocked", why: e.message });
      continue;
    }
    if (!hops || hops.length === 0) {
      failures.push({ id: labelOf(cand), code: "anchor_missing", message: `no anchor for ${cand.key}` });
      results.push({ ...cand, verdict: "blocked", why: "no anchor" });
      continue;
    }

    const checked = [];
    let verdict = null;
    let why = null;
    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i];
      const st = await anchorExists(hop);
      if (!st.exists) {
        failures.push({ id: labelOf(cand), code: "anchor_not_in_decompile", message: `${hop.file}:${hop.line} ${st.why}` });
        checked.push({ hop, exists: false, why: st.why });
        verdict = "blocked";
        why = st.why;
        break;
      }
      const h = checkHop(cand.anchor, hop, st);
      checked.push({ hop, exists: true, ...h });
      // Only the FIRST hop is the Agent-facing entry; later hops are helpers that
      // may legitimately be private (FruitTree.shake, Grass.TryDropItemsOnCut).
      if (i === 0 && h.vis !== "public") {
        verdict = "blocked";
        why = `${hop.file}:${hop.line} entry is ${h.vis}`;
        break;
      }
      if (h.rt && !h.terminal) {
        verdict = "blocked";
        why = `${hop.file}:${hop.line} requires realtime input and has no terminal write`;
        break;
      }
      if (h.menuOnly) {
        verdict = "blocked";
        why = `${hop.file}:${hop.line} only mounts a menu the Agent cannot dismiss`;
        break;
      }
      if (h.terminal) {
        verdict = "closable";
        why = `${hop.file}:${hop.line} public, no realtime input, observable terminal`;
        break;
      }
      // No terminal in this hop's own body -- if there's a next hop, continue.
    }
    if (!verdict) {
      // All hops checked, none had a terminal.
      verdict = "verify_chain";
      why = "public entry with no terminal in the hop bodies checked; chain terminal needs live receipt";
    }
    results.push({ ...cand, verdict, why, hops: checked.map((c) => ({ file: c.hop.file, line: c.hop.line, exists: c.exists, vis: c.vis, rt: c.rt, terminal: c.terminal ?? null, menuOnly: c.menuOnly ?? null })) });
  }

  const quiet = process.argv.includes("--quiet");
  if (!quiet) {
    for (const r of results) console.log(`  ${r.verdict.padEnd(14)} ${labelOf(r).padEnd(38)} ${r.why ?? ""}`);
  }

  if (failures.length) {
    for (const f of failures) console.error(`  ${f.code}: ${f.id} ${f.message}`);
    process.exitCode = 1;
    return;
  }
  const blocked = results.filter((r) => r.verdict === "blocked");
  if (blocked.length) {
    console.error(`loop-closure gate: ${blocked.length} blocked candidate(s)`);
    for (const b of blocked) console.error(`  ${labelOf(b)}: ${b.why}`);
    process.exitCode = 1;
    return;
  }
  const closable = results.filter((r) => r.verdict === "closable").length;
  const chain = results.filter((r) => r.verdict === "verify_chain").length;
  console.log(`loop-closure gate: ${results.length} candidates, ${closable} closable, ${chain} verify-chain, 0 blocked`);
}

main().catch((e) => {
  console.error(String(e.message ?? e));
  process.exitCode = 1;
});