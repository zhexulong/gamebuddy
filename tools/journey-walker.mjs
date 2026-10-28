#!/usr/bin/env node
// journey-walker — one run that drives every interactive control in the mounted product and prints
// every trace of dishonesty it finds.
//
// It owns no launcher: it delegates launching to the shots kit's own phases
// (`tools/shots/run.mjs launch` → `phases/launch.mjs` → the pinned worktree's
// `tools/desktop-composition-launch.mjs`), which already pin a commit, claim the CDP port with its
// lock, isolate a run root and tear down only the pids they started. This file adds the walk:
//
//   node tools/journey-walker.mjs --out D:\gb-modcheck\journey1 --launch --commit HEAD
//   node tools/journey-walker.mjs --out D:\gb-modcheck\journey1            (attach to a mounted run)
//   node tools/journey-walker.mjs --out <stage> --only=widths
//
// Phases: walk (every control per surface), extremes (spam new chat, empty the list, drawers, drafts,
// toggles), widths (320/400/768/1440/2560 overflow + clipping), scan (one full-DOM text scan).
// `--only=<phase>[,<phase>]` runs a subset; `report` is always printed.
//
// Global capture runs throughout: `console.error`, `unhandledrejection`, every 4xx/5xx response, and a
// lexical scan of the rendered DOM for `None`/`undefined`/`null`/`NaN`/`[object Object]`, a raw
// catalogue key (camelCase) or a raw wire member (snake_case). Every hit is attributed to the surface,
// the control and the viewport width that was live when it was observed.
//
// Exit code is non-zero when anything was found. A clean run still prints the per-surface counts of
// controls walked, so "green" means "walked N controls and saw nothing".
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KIT_ROOT,
  REPO_ROOT,
  defaultStageFor,
  loadRunConfig,
  runPaths,
  saveRunConfig,
  sanitizeTag,
} from "./shots/lib/config.mjs";

export const WALKER_ROOT = dirname(fileURLToPath(import.meta.url));

/** The five widths every resize assertion runs at, in the order the owner named them. */
export const WIDTHS = [320, 400, 768, 1440, 2560];

/** The peer surfaces, with the AppBar name that selects each and the region's own data-testid. */
export const SURFACES = [
  { key: "chat", label: "聊天", testid: "chat-surface" },
  { key: "game", label: "游戏", testid: "game-surface" },
  { key: "chats", label: "会话", testid: "chats-surface" },
  { key: "characters", label: "角色", testid: "characters-surface" },
  { key: "settings", label: "设置", testid: "settings-surface" },
  { key: "memory", label: "记忆", testid: "memory-surface" },
];

export const PHASES = ["walk", "extremes", "widths", "scan"];

/**
 * The tokens the DOM scan refuses, as named detectors. A detector is a name, a severity and a regex;
 * keeping them apart is what lets the report say WHICH dishonesty it saw rather than "a bad string".
 */
export const TEXT_DETECTORS = [
  { name: "literal_undefined", severity: 3, pattern: /\bundefined\b/ },
  { name: "literal_null", severity: 3, pattern: /\bnull\b/ },
  { name: "literal_nan", severity: 3, pattern: /\bNaN\b/ },
  { name: "literal_none", severity: 3, pattern: /\bNone\b/ },
  { name: "object_object", severity: 3, pattern: /\[object Object\]/ },
  // A raw catalogue key is a camelCase word with no space in it: `chatHandle`, `openingOptionName`.
  { name: "raw_catalogue_key", severity: 2, pattern: /\b[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*\b/ },
  // A raw wire member is a snake_case run: `chat_handle`, `state_revision`.
  { name: "raw_wire_member", severity: 2, pattern: /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/ },
];

/**
 * Tokens the camelCase detector must not fire on: the product's own brand name is spelled that way on
 * purpose and is not a leaked identifier. Kept to an exact list so it cannot swallow a real leak.
 */
export const ALLOWED_TOKENS = ["GameBuddy"];

/**
 * Containers whose text is machine output by design (the Host's own diagnostics JSON). They are
 * excluded from the lexical scan and the exclusion is printed in the report; the test asserts a token
 * planted OUTSIDE them is still found, so the exclusion never widens into a blind spot.
 */
export const TEXT_EXCLUSIONS = ['[data-testid="game-diagnostics-json"]', "pre", "code"];

/** Read the DOM scan's text in the page: visible text nodes under the app root, exclusions applied. */
export const SCAN_TEXT_IN_PAGE = function scanTextInPage(exclusions) {
  const root = document.getElementById("root") ?? document.body;
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.nodeValue ?? "";
    if (text.trim().length === 0) continue;
    const el = node.parentElement;
    if (el === null || el.closest("script,style") !== null) continue;
    let excluded = false;
    for (const selector of exclusions) {
      if (el.closest(selector) !== null) {
        excluded = true;
        break;
      }
    }
    if (excluded) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    out.push({ text: text.slice(0, 240), path: describeElement(el) });
  }
  return out;

  function describeElement(el) {
    const parts = [el.tagName.toLowerCase()];
    if (el.id) parts.push(`#${el.id}`);
    const testId = el.getAttribute("data-testid");
    if (testId) parts.push(`[data-testid="${testId}"]`);
    const aria = el.getAttribute("aria-label");
    if (aria) parts.push(`[aria-label="${aria.slice(0, 40)}"]`);
    return parts.join("");
  }
};

/** The horizontal overflow and clipped-to-zero measurement, taken in the page. */
export const MEASURE_LAYOUT_IN_PAGE = function measureLayoutInPage() {
  const doc = document.documentElement;
  const viewportWidth = window.innerWidth;
  const interactive =
    'button, a[href], input, select, textarea, summary, [role="button"], [role="menuitem"], [role="tab"]';
  const clipped = [];
  for (const el of document.querySelectorAll(interactive)) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (el.getAttribute("aria-hidden") === "true") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      clipped.push({
        path: describeElement(el),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        text: (el.textContent ?? "").trim().slice(0, 40),
      });
    }
  }
  return {
    viewportWidth,
    documentScrollWidth: doc.scrollWidth,
    documentClientWidth: doc.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    overflow: doc.scrollWidth - viewportWidth,
    clipped,
  };

  function describeElement(el) {
    const parts = [el.tagName.toLowerCase()];
    const testId = el.getAttribute("data-testid");
    if (testId) parts.push(`[data-testid="${testId}"]`);
    const aria = el.getAttribute("aria-label");
    if (aria) parts.push(`[aria-label="${aria.slice(0, 40)}"]`);
    if (parts.length === 1) parts.push(`[text="${(el.textContent ?? "").trim().slice(0, 30)}"]`);
    return parts.join("");
  }
};

/** Stamp the visible interactive controls of one surface and describe each one. */
export const STAMP_CONTROLS_IN_PAGE = function stampControlsInPage(testId) {
  const root = testId === null ? document.body : document.querySelector(`section[data-testid="${testId}"]`);
  if (root === null) return { rootPresent: false, controls: [] };
  const selector =
    'button, a[href], input, select, textarea, summary, [role="button"], [role="menuitem"], [role="tab"]';
  const controls = [];
  for (const el of root.querySelectorAll(selector)) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const index = controls.length;
    el.setAttribute("data-journey-index", String(index));
    controls.push({
      index,
      tag: el.tagName.toLowerCase(),
      testId: el.getAttribute("data-testid"),
      ariaLabel: el.getAttribute("aria-label"),
      text: (el.textContent ?? "").trim().slice(0, 60),
      type: el.getAttribute("type"),
      role: el.getAttribute("role"),
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
    });
  }
  return { rootPresent: true, controls };
};

/** The observable state an action can change, read before and after a click. */
export const OBSERVE_STATE_IN_PAGE = function observeStateInPage() {
  const root = document.getElementById("root") ?? document.body;
  return {
    url: location.href,
    hash: location.hash,
    textLength: (root.innerText ?? "").length,
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    backdrops: document.querySelectorAll('[data-testid$="-backdrop"]').length,
    armed: document.querySelectorAll('[data-testid$="-confirm"], [data-testid$="-confirm-yes"]').length,
    detailsOpen: document.querySelectorAll("details[open]").length,
  };
};

/** Find the control a signature names in the CURRENT render, and return its live index. */
export const LOCATE_CONTROL_IN_PAGE = function locateControlInPage(testId, signature) {
  const root = testId === null ? document.body : document.querySelector(`section[data-testid="${testId}"]`);
  if (root === null) return null;
  const selector =
    'button, a[href], input, select, textarea, summary, [role="button"], [role="menuitem"], [role="tab"]';
  let visibleIndex = 0;
  for (const el of root.querySelectorAll(selector)) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const candidate = `${el.tagName.toLowerCase()}|${el.getAttribute("data-testid") ?? ""}|${
      el.getAttribute("aria-label") ?? ""
    }|${(el.textContent ?? "").trim().slice(0, 60)}`;
    if (candidate === signature) return visibleIndex;
    visibleIndex += 1;
  }
  return null;
};

/** A control's identity across renders: never its list position, which shifts with the data. */
export function controlSignature(control) {
  return `${control.tag}|${control.testId ?? ""}|${control.ariaLabel ?? ""}|${control.text ?? ""}`;
}

/** One detector pass over one text; returns the detector names that fired. */
export function classifyText(text) {
  const hits = [];
  for (const detector of TEXT_DETECTORS) {
    for (const match of text.matchAll(new RegExp(detector.pattern.source, `${detector.pattern.flags}g`))) {
      const token = match[0];
      if (ALLOWED_TOKENS.includes(token)) continue;
      hits.push({ detector: detector.name, severity: detector.severity, token });
    }
  }
  return hits;
}

/**
 * The findings log, its context, and the named skips. The context (surface/control/width) is set by
 * the phase driver and stamped onto every hit, so an asynchronous console error still says where it
 * was seen.
 */
export class Findings {
  constructor() {
    this.items = [];
    this.skips = [];
    this.tallies = {};
    this.caps = [];
    this.context = { surface: null, control: null, width: null };
  }

  withContext(next) {
    this.context = { ...this.context, ...next };
  }

  add(finding) {
    this.items.push({ ...this.context, ...finding });
  }

  count(extra = {}) {
    return this.items.filter((item) => Object.entries(extra).every(([key, value]) => item[key] === value)).length;
  }

  skip(skip) {
    this.skips.push({ ...this.context, ...skip });
  }

  cap(record) {
    this.caps.push(record);
  }

  surfaceTally(key) {
    if (this.tallies[key] === undefined) this.tallies[key] = { walked: 0, skipped: 0, findings: 0 };
    return this.tallies[key];
  }

  /** Findings ranked highest-severity first, then by surface, then by control. */
  ranked() {
    return [...this.items].sort(
      (a, b) =>
        (b.severity ?? 0) - (a.severity ?? 0) ||
        String(a.surface ?? "").localeCompare(String(b.surface ?? "")) ||
        String(a.control ?? "").localeCompare(String(b.control ?? "")),
    );
  }
}

/** Exit non-zero exactly when the run found something. */
export function reportExitCode(findings) {
  return findings.items.length > 0 ? 1 : 0;
}

/** Parse the walker's own arguments; the shots kit's flags are passed through by `--set`. */
export function parseWalkerArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    if (body.includes("=")) {
      const [key, ...rest] = body.split("=");
      values[key] = rest.join("=");
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        values[body] = next;
        i += 1;
      } else {
        values[body] = true;
      }
    }
  }
  return values;
}

/** Which phases `--only` selects; an unknown phase is a named refusal, never a silent full run. */
export function selectPhases(only) {
  if (typeof only !== "string" || only.trim().length === 0) return [...PHASES];
  const requested = only
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const phase of requested) {
    if (!PHASES.includes(phase)) throw new Error(`unknown_phase:${phase} (expected ${PHASES.join(", ")})`);
  }
  return PHASES.filter((phase) => requested.includes(phase));
}

/**
 * The dishonesty scan over one page's visible text. Pure over its input so the suite can plant a token
 * in a fixture and prove the scan reports it.
 *
 * @param {ReadonlyArray<{ text: string, path: string }>} nodes
 */
export function scanTextNodes(nodes, context) {
  const hits = [];
  for (const node of nodes) {
    for (const hit of classifyText(node.text)) {
      hits.push({
        kind: "text",
        severity: hit.severity,
        detector: hit.detector,
        token: hit.token,
        detail: node.text,
        path: node.path,
        ...context,
      });
    }
  }
  return hits;
}

/** One line per finding, then the ranked list and the tallies. */
export function renderReport({ findings, phasesRun, launchState, capMs, elapsedMs, exclusions }) {
  const lines = [];
  lines.push("===== journey walker =====");
  lines.push(`phases run: ${phasesRun.join(", ")}`);
  if (launchState !== null) {
    lines.push(
      `mounted: commit ${launchState.commit} product port ${launchState.port} cdp port ${launchState.cdpPort}`,
    );
  }
  lines.push(`excluded from the text scan (by design): ${exclusions.join(", ")}`);
  lines.push("");
  lines.push("--- controls walked per surface (a clean run still says what it walked) ---");
  const surfaces = Object.keys(findings.tallies).sort();
  for (const surface of surfaces) {
    const tally = findings.tallies[surface];
    lines.push(`  ${surface}: walked=${tally.walked} skipped=${tally.skipped} findings=${tally.findings}`);
  }
  lines.push(
    `  TOTAL: walked=${surfaces.reduce((n, s) => n + findings.tallies[s].walked, 0)} skipped=${surfaces.reduce(
      (n, s) => n + findings.tallies[s].skipped,
      0,
    )} findings=${findings.items.length}`,
  );
  lines.push("");
  lines.push("--- named skips (a control that cannot be driven headlessly is a skip, never a pass) ---");
  if (findings.skips.length === 0) lines.push("  none");
  for (const skip of findings.skips) {
    lines.push(
      `  SKIP ${skip.what} :: ${skip.reason} (surface=${skip.surface ?? "n/a"} control=${skip.control ?? "n/a"} width=${skip.width ?? "n/a"})`,
    );
  }
  lines.push("");
  lines.push("--- known limits ---");
  if (findings.caps.length === 0) lines.push("  none");
  for (const cap of findings.caps) lines.push(`  CAP ${cap.what} :: ${cap.reason} (limit=${cap.limit})`);
  lines.push("");
  lines.push(`--- findings (${findings.items.length}) ---`);
  if (findings.items.length === 0) lines.push("  none");
  for (const item of findings.items) {
    lines.push(
      `  [${item.kind}] surface=${item.surface ?? "n/a"} control=${item.control ?? "n/a"} width=${item.width ?? "n/a"} :: ${item.detail}`,
    );
  }
  lines.push("");
  lines.push("--- ranked (severity, then surface, then control) ---");
  if (findings.ranked().length === 0) lines.push("  none");
  for (const item of findings.ranked()) {
    lines.push(
      `  sev${item.severity ?? 0} ${item.kind} ${item.detector ?? item.status ?? ""} :: ${item.detail} @ ${item.surface ?? "n/a"}/${item.control ?? "n/a"}/${item.width ?? "n/a"}`,
    );
  }
  lines.push("");
  const overBudget = elapsedMs > capMs;
  lines.push(
    `budget: ${Math.round(elapsedMs / 1000)}s of ${Math.round(capMs / 1000)}s allowed${overBudget ? " (OVER BUDGET)" : ""}`,
  );
  lines.push(findings.items.length === 0 ? "RESULT: clean" : `RESULT: ${findings.items.length} finding(s)`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------
// The driven walk. Everything below talks to a mounted product over CDP and honours two honesty rules:
// an action that cannot be driven is a NAMED SKIP, and a control that was clicked is counted even when
// it changed nothing.
// ---------------------------------------------------------------------------------------------------

const DEFAULT_BUDGET_MS = 360_000;
const CLICK_TIMEOUT_MS = 4_000;
const SETTLE_MS = 250;

function requireFrom(repoRoot, candidates) {
  const require = createRequire(import.meta.url);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      /* next candidate */
    }
  }
  throw new Error(`playwright_not_resolvable (tried ${candidates.join(", ")}) from ${repoRoot}`);
}

function loadChromium() {
  // The product's own dev dependency is the first choice, the pnpm store second: the same order the
  // shots kit's `capture/common.cjs` uses, kept here because the walker runs in the main checkout.
  const module = requireFrom(REPO_ROOT, [
    join(REPO_ROOT, "dialogue-web", "node_modules", "@playwright", "test"),
    join(REPO_ROOT, "dialogue-web", "node_modules", "playwright"),
    "playwright",
  ]);
  const chromium = module.chromium;
  if (chromium === undefined) throw new Error("playwright_chromium_missing");
  return chromium;
}

class Walker {
  constructor({ page, findings, phasesRun, budgetMs }) {
    this.page = page;
    this.findings = findings;
    this.phasesRun = phasesRun;
    this.budgetMs = budgetMs;
    this.startedAt = Date.now();
    this.width = null;
    this.responseLogged = new Set();
    this.errorsSinceSettle = [];
    this.controlsWalked = 0;
  }

  elapsedMs() {
    return Date.now() - this.startedAt;
  }

  /** A phase that reached the budget stops at a boundary and records the cap rather than running on. */
  budgetExceeded(phase) {
    if (this.elapsedMs() < this.budgetMs) return false;
    this.findings.cap({
      what: phase,
      reason: "walk stopped at the run budget; remaining controls were not driven",
      limit: `${Math.round(this.budgetMs / 1000)}s`,
    });
    return true;
  }

  setSurface(surface) {
    this.findings.withContext({ surface: surface === null ? null : surface.key, control: null });
  }

  setControl(control) {
    this.findings.withContext({ control });
  }

  setWidth(width) {
    this.width = width;
    this.findings.withContext({ width: width === null ? null : `${width}px` });
  }

  /** Attach the global capture before anything is clicked. */
  attachCapture() {
    this.page.on("console", (message) => {
      if (message.type() !== "error") return;
      this.findings.add({
        kind: "console_error",
        severity: 3,
        detail: message.text().split("\n")[0].slice(0, 240),
      });
    });
    this.page.on("pageerror", (error) => {
      this.findings.add({ kind: "unhandled_rejection", severity: 3, detail: String(error).slice(0, 240) });
    });
    this.page.on("response", (response) => {
      const status = response.status();
      if (status < 400) return;
      const key = `${status} ${response.url()}`;
      if (this.responseLogged.has(key)) return;
      this.responseLogged.add(key);
      this.findings.add({
        kind: "http_error",
        severity: 3,
        status,
        detail: `${status} ${response.request().method()} ${response.url().split("#")[0].slice(0, 160)}`,
      });
    });
  }

  /** The page-level text scan: the phase-3 detector over the whole rendered document. */
  async scanDocument(label) {
    const nodes = await this.page.evaluate(SCAN_TEXT_IN_PAGE, TEXT_EXCLUSIONS);
    const hits = scanTextNodes(nodes, {
      surface: this.findings.context.surface,
      control: this.findings.context.control,
      width: this.findings.context.width,
    });
    for (const hit of hits) {
      const surfaceTally = this.findings.surfaceTally(hit.surface ?? "global");
      surfaceTally.findings += 1;
      this.findings.add({ ...hit, detail: `${hit.detail} :: ${hit.path}` });
    }
    return { label, nodes: nodes.length, hits: hits.length };
  }

  /** Bring the bar entry for a surface into view without clicking it (activation has side effects). */
  async presentSurfaceEntries() {
    return await this.page.evaluate(() => {
      const moreTrigger = document.querySelector(".app-bar-more-trigger");
      return {
        barEntries: [...document.querySelectorAll(".app-bar-actions .nav-button[aria-label]")].map((el) =>
          el.getAttribute("aria-label"),
        ),
        foldTriggerPresent: moreTrigger !== null,
      };
    });
  }

  /**
   * Drive one stamped control. `stamp` is the render-time snapshot; the live index is re-resolved from
   * the signature so a control that shifted after an earlier click is still driven at its real position.
   */
  async driveControl({ testId, stamp, name, action }) {
    const located = await this.page.evaluate(LOCATE_CONTROL_IN_PAGE, [testId, controlSignature(stamp)]);
    if (located === null) {
      this.findings.skip({ what: name, reason: "control_not_present_after_earlier_actions" });
      const tally = this.findings.surfaceTally(this.findings.context.surface ?? "global");
      tally.skipped += 1;
      return { outcome: "skipped" };
    }
    const before = await this.page.evaluate(OBSERVE_STATE_IN_PAGE);
    let outcome = "clicked";
    try {
      if (stamp.tag === "input" || stamp.tag === "textarea") {
        const target = this.page.locator(`[data-journey-index="${located}"]`);
        await target.fill("journey-walker", { timeout: CLICK_TIMEOUT_MS });
        await target.fill("", { timeout: CLICK_TIMEOUT_MS });
        outcome = "typed_and_cleared";
      } else if (stamp.tag === "select") {
        outcome = "select_skipped_no_option_contract";
      } else if (stamp.disabled === true) {
        outcome = "disabled";
      } else {
        await this.page.locator(`[data-journey-index="${located}"]`).click({ timeout: CLICK_TIMEOUT_MS });
      }
      await this.page.waitForTimeout(SETTLE_MS);
    } catch (error) {
      const message = String(error).split("\n")[0].slice(0, 200);
      if (/intercepts pointer events|Timeout .* exceeded/u.test(message)) {
        this.findings.skip({ what: name, reason: `not_clickable:${message}` });
        const tally = this.findings.surfaceTally(this.findings.context.surface ?? "global");
        tally.skipped += 1;
        return { outcome: "skipped" };
      }
      throw error;
    }
    if (action !== undefined) await action();
    const after = await this.page.evaluate(OBSERVE_STATE_IN_PAGE);
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    if (after.armed > before.armed) {
      this.findings.add({
        kind: "control_observation",
        severity: 1,
        outcome: "armed_confirmation",
        detail: `${name}: a confirmation armed after the press and was left armed`,
      });
    }
    await this.page.evaluate(() => {
      for (const el of document.querySelectorAll("[data-journey-index]")) el.removeAttribute("data-journey-index");
    });
    this.controlsWalked += 1;
    const tally = this.findings.surfaceTally(this.findings.context.surface ?? "global");
    tally.walked += 1;
    return { outcome, changed };
  }

  /**
   * The escaping moves that return the UI to a known state after a control was driven: a confirmation
   * that stayed armed is dismissed with its own cancel, an open drawer is closed with Escape. Both are
   * the product's own gestures, so recovery never guesses at a DOM shape.
   */
  async returnToKnownState(surface) {
    const cancel = this.page.locator('[data-testid$="-confirm-no"]').first();
    if ((await cancel.count()) > 0 && (await cancel.isVisible().catch(() => false))) {
      await cancel.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
      await this.page.waitForTimeout(SETTLE_MS);
    }
    const backdrop = this.page.locator('[data-testid$="-backdrop"]').first();
    if ((await backdrop.count()) > 0 && (await backdrop.isVisible().catch(() => false))) {
      await this.page.keyboard.press("Escape");
      await this.page.waitForTimeout(SETTLE_MS);
    }
    const details = await this.page.locator("details[open]").count();
    if (details > 0) {
      await this.page.evaluate(() => {
        for (const el of document.querySelectorAll("details[open]")) el.open = false;
      });
    }
    await this.presentSurface(surface);
  }

  async presentSurface(surface) {
    if (surface === null) return;
    const trigger = this.page.locator(".app-bar-more-trigger");
    if ((await trigger.count()) > 0 && (await trigger.isVisible().catch(() => false))) {
      await trigger.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
      const folded = this.page.locator(`.app-bar-more-menu .nav-button[aria-label="${surface.label}"]`);
      if ((await folded.count()) > 0 && (await folded.isVisible().catch(() => false))) {
        await folded.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
        await this.page.waitForTimeout(400);
        return;
      }
      await this.page.keyboard.press("Escape");
    }
    const direct = this.page.locator(`.app-bar-actions .nav-button[aria-label="${surface.label}"]`);
    if ((await direct.count()) > 0) {
      await direct
        .first()
        .click({ timeout: CLICK_TIMEOUT_MS })
        .catch(() => undefined);
      await this.page.waitForTimeout(400);
    }
  }

  /** Phase `walk`: every stamped control per surface, each in a fresh state. */
  async phaseWalk() {
    for (const surface of SURFACES) {
      if (this.budgetExceeded("walk")) return;
      this.setSurface(surface);
      this.findings.surfaceTally(surface.key);
      await this.presentSurface(surface);
      const stamped = await this.page.evaluate(STAMP_CONTROLS_IN_PAGE, surface.testid);
      if (stamped.rootPresent === false) {
        this.findings.skip({ what: `${surface.key} surface`, reason: "region_not_rendered_at_this_mount" });
        continue;
      }
      this.findings.add({
        kind: "control_inventory",
        severity: 0,
        outcome: `surface_${surface.key}`,
        detail: `${stamped.controls.length} interactive controls on ${surface.testid}`,
      });
      for (const stamp of stamped.controls) {
        if (this.budgetExceeded("walk")) return;
        const name = stamp.ariaLabel ?? stamp.testId ?? stamp.text ?? `${stamp.tag}[${stamp.index}]`;
        this.setControl(name);
        await this.driveControl({ testId: surface.testid, stamp, name });
        await this.returnToKnownState(surface);
      }
    }
    // The one control outside every surface: the `…` disclosure that folds the bar's tail entries.
    if (!this.budgetExceeded("walk")) {
      await this.setWidth(this.width);
      const folded = await this.presentSurfaceEntries();
      if (folded.foldTriggerPresent) {
        for (const width of WIDTHS) {
          await this.page.setViewportSize({ width, height: 900 });
          await this.page.waitForTimeout(SETTLE_MS);
          this.setWidth(width);
          const trigger = this.page.locator(".app-bar-more-trigger");
          if ((await trigger.count()) === 0 || !(await trigger.isVisible().catch(() => false))) continue;
          this.setControl(`app-bar-more@${width}px`);
          await trigger.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
          await this.page.waitForTimeout(SETTLE_MS);
          const open = await this.page.evaluate(
            () => document.querySelector(".app-bar-more-menu")?.getAttribute("data-open") === "true",
          );
          if (!open) {
            this.findings.add({
              kind: "control_observation",
              severity: 2,
              detail: `the bar's More trigger did not open its panel at ${width}px`,
            });
          }
          this.controlsWalked += 1;
          this.findings.surfaceTally("app-bar").walked += 1;
          await this.page.keyboard.press("Escape");
          await this.page.waitForTimeout(SETTLE_MS);
        }
      } else {
        this.findings.skip({ what: "app-bar More", reason: "bar never folds at the widths this mount renders" });
        this.findings.surfaceTally("app-bar").skipped += 1;
      }
    }
    this.setSurface(null);
  }

  /** Phase `extremes`: the cheap breadth-first extremes, each capped and each reported. */
  async phaseExtremes() {
    const chats = SURFACES.find((surface) => surface.key === "chats");
    const characters = SURFACES.find((surface) => surface.key === "characters");

    // 1. Spam `new chat` a dozen times. The picker's commit button, when a picker opens, is the
    //    product's own commit control; a picker that never opens is the plain New Chat path. The
    //    card's prose is inert text since `c55ea777`, so clicking it creates nothing.
    this.setSurface(chats);
    this.setControl("new-chat x12");
    await this.presentSurface(chats);
    await this.page.setViewportSize({ width: 1440, height: 900 });
    this.setWidth(1440);
    let created = 0;
    for (let i = 0; i < 12; i += 1) {
      if (this.budgetExceeded("extremes")) break;
      const trigger = this.page.locator('[data-testid="new-chat"]').first();
      if ((await trigger.count()) === 0) {
        this.findings.skip({ what: "new chat", reason: "new-chat control absent (creation route not served)" });
        break;
      }
      await trigger.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
      await this.page.waitForTimeout(400);
      const option = this.page.locator('[data-testid="opening-option-commit"]').first();
      if ((await option.count()) > 0 && (await option.isVisible().catch(() => false))) {
        await option.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
        created += 1;
      } else {
        created += 1;
      }
      await this.page.waitForTimeout(700);
      this.controlsWalked += 1;
      this.findings.surfaceTally(chats.key).walked += 1;
    }
    this.findings.add({
      kind: "control_observation",
      severity: 0,
      outcome: "new_chat_spam",
      detail: `${created} new-chat presses accepted`,
    });

    // 2. Archive/trash every row until the list is empty, each through its own arm+confirm.
    this.setControl("chat rows -> empty");
    let removed = 0;
    for (let i = 0; i < 40; i += 1) {
      if (this.budgetExceeded("extremes")) break;
      const arm = this.page.locator('[data-testid="chat-item"] [aria-label]').filter({ hasText: "" }).first();
      const row = this.page.locator('[data-testid="chat-item"]').first();
      if ((await row.count()) === 0) break;
      const trash = row.locator('button[aria-label*="删除"], button[aria-label*="Trash"]').first();
      if ((await trash.count()) === 0) break;
      await trash.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
      const yes = this.page.locator('[data-testid="chat-retention-confirm-yes"]').first();
      if ((await yes.count()) === 0) {
        this.findings.add({
          kind: "control_observation",
          severity: 3,
          detail: "the trash arm produced no confirmation (a destructive control with no confirm step)",
        });
        break;
      }
      await yes.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
      await this.page.waitForTimeout(700);
      removed += 1;
      this.controlsWalked += 1;
      this.findings.surfaceTally(chats.key).walked += 1;
      void arm;
    }
    const remaining = await this.page.locator('[data-testid="chat-item"]').count();
    this.findings.add({
      kind: "control_observation",
      severity: remaining > 0 ? 1 : 0,
      outcome: "empty_the_list",
      detail: `removed=${removed} rows_remaining=${remaining}`,
    });

    // 3. Switch companions: every roster row's inspector opener, opened and closed.
    this.setSurface(characters);
    this.setControl("companion roster");
    await this.presentSurface(characters);
    const roster = await this.page.locator("[data-companion-inspect]").count();
    for (let i = 0; i < roster; i += 1) {
      if (this.budgetExceeded("extremes")) break;
      const opener = this.page.locator("[data-companion-inspect]").nth(i);
      if ((await opener.count()) === 0) break;
      await opener.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
      await this.page.waitForTimeout(400);
      this.controlsWalked += 1;
      this.findings.surfaceTally(characters.key).walked += 1;
      await this.page.keyboard.press("Escape");
      await this.page.waitForTimeout(300);
    }
    if (roster === 0) this.findings.skip({ what: "companion inspector", reason: "roster has no rows at this mount" });

    // 4. Open every drawer: within the current surface, press every control that names a disclosure or
    //    opens a panel, then close it. Capped at 12 so one surface cannot make the suite slow.
    this.setControl("drawers");
    const drawerActions = await this.page.evaluate(() => {
      const surface = document.querySelector("main section[data-testid]");
      if (surface === null) return 0;
      let n = 0;
      for (const el of surface.querySelectorAll(
        'button[aria-expanded], button[aria-haspopup="dialog"], details > summary',
      )) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        n += 1;
      }
      return n;
    });
    if (drawerActions > 12) {
      this.findings.cap({
        what: "drawers",
        reason: "more disclosing controls than the extreme phase drives in one surface",
        limit: "12",
      });
    }
    for (let i = 0; i < Math.min(drawerActions, 12); i += 1) {
      if (this.budgetExceeded("extremes")) break;
      const index = await this.page.evaluate((n) => {
        const surface = document.querySelector("main section[data-testid]");
        const list = [...surface.querySelectorAll('button[aria-expanded], button[aria-haspopup="dialog"]')].filter(
          (el) => el.getBoundingClientRect().width > 0,
        );
        return list[n] === undefined ? null : n;
      }, i);
      if (index === null) break;
      await this.page.evaluate((n) => {
        const surface = document.querySelector("main section[data-testid]");
        const list = [...surface.querySelectorAll('button[aria-expanded], button[aria-haspopup="dialog"]')].filter(
          (el) => el.getBoundingClientRect().width > 0,
        );
        list[n]?.click();
      }, index);
      await this.page.waitForTimeout(400);
      this.controlsWalked += 1;
      this.findings.surfaceTally("drawers").walked += 1;
      await this.page.keyboard.press("Escape");
      await this.page.waitForTimeout(300);
    }

    // 5. Clear every draft: fill the composer, save, then discard whatever the product kept.
    const chat = SURFACES.find((surface) => surface.key === "chat");
    this.setSurface(chat);
    this.setControl("composer draft");
    await this.presentSurface(chat);
    const composer = this.page.locator(".composer-textarea").first();
    if ((await composer.count()) > 0 && (await composer.isEnabled().catch(() => false))) {
      await composer.fill("journey-walker draft", { timeout: CLICK_TIMEOUT_MS });
      const save = this.page.locator("[data-draft-actions] button").first();
      if ((await save.count()) > 0) await save.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
      await this.page.waitForTimeout(600);
      const draftButtons = await this.page.locator("[data-draft-actions] button").count();
      for (let i = draftButtons - 1; i >= 0; i -= 1) {
        if (this.budgetExceeded("extremes")) break;
        const button = this.page.locator("[data-draft-actions] button").nth(i);
        if ((await button.count()) === 0) continue;
        await button.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
        await this.page.waitForTimeout(400);
      }
      await composer.fill("", { timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
      this.controlsWalked += 1;
      this.findings.surfaceTally(chat.key).walked += 1;
    } else {
      this.findings.skip({ what: "composer", reason: "composer absent or disabled at this mount" });
      this.findings.surfaceTally(chat.key).skipped += 1;
    }

    // 6. Toggle every setting: one full round over the Settings surface's own controls, then a
    //    text scan of what those toggles rendered.
    const settings = SURFACES.find((surface) => surface.key === "settings");
    this.setSurface(settings);
    await this.presentSurface(settings);
    const stamped = await this.page.evaluate(STAMP_CONTROLS_IN_PAGE, settings.testid);
    for (const stamp of stamped.controls) {
      if (this.budgetExceeded("extremes")) break;
      const name = stamp.ariaLabel ?? stamp.testId ?? stamp.text ?? stamp.tag;
      this.setControl(name);
      await this.driveControl({ testId: settings.testid, stamp, name });
      await this.returnToKnownState(settings);
    }
    await this.scanDocument("after settings toggles");
    this.setSurface(null);
  }

  /** Phase `widths`: the five widths, no horizontal overflow and nothing clipped to zero. */
  async phaseWidths() {
    for (const surface of SURFACES) {
      this.setSurface(surface);
      this.findings.surfaceTally(surface.key);
      await this.presentSurface(surface);
      for (const width of WIDTHS) {
        if (this.budgetExceeded("widths")) return;
        this.setWidth(width);
        this.setControl(`${surface.key}@${width}px`);
        await this.page.setViewportSize({ width, height: 900 });
        await this.page.waitForTimeout(400);
        const measured = await this.page.evaluate(MEASURE_LAYOUT_IN_PAGE);
        this.findings.add({
          kind: "layout_measurement",
          severity: 0,
          outcome: `${surface.key}@${width}px`,
          detail: `overflow=${measured.overflow} clippedToZero=${measured.clipped.length}`,
        });
        if (measured.overflow > 1) {
          this.findings.add({
            kind: "horizontal_overflow",
            severity: 3,
            detail: `${surface.key} at ${width}px: scrollWidth ${measured.documentScrollWidth} > clientWidth+1 ${measured.documentClientWidth + 1}`,
          });
        }
        for (const clipped of measured.clipped) {
          this.findings.add({
            kind: "clipped_to_zero",
            severity: 3,
            detail: `${surface.key} at ${width}px: ${clipped.path} measured ${clipped.width}x${clipped.height}`,
          });
        }
      }
    }
    this.setSurface(null);
    this.setWidth(null);
    await this.page.setViewportSize({ width: 1440, height: 900 });
  }

  /** Phase `scan`: one full-document text scan at the wide width after everything else ran. */
  async phaseScan() {
    this.setWidth(1440);
    await this.page.setViewportSize({ width: 1440, height: 900 });
    await this.page.waitForTimeout(400);
    const summary = await this.scanDocument("final full-document scan");
    this.findings.add({
      kind: "text_scan",
      severity: 0,
      outcome: summary.label,
      detail: `scanned ${summary.nodes} text nodes, ${summary.hits} hit(s)`,
    });
  }
}

async function attach({ run, paths, log }) {
  const launchState = JSON.parse(readFileSync(paths.launchStateFile, "utf8"));
  if (launchState.kind !== "mounted" || launchState.mounted !== true) {
    throw new Error(`launch_state_not_mounted:${launchState.kind} — run the launch phase first`);
  }
  const chromium = loadChromium();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${launchState.cdpPort}`);
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().includes(`127.0.0.1:${launchState.port}`));
  if (page === undefined) {
    await browser.close().catch(() => undefined);
    throw new Error(`no_product_tab_for_port_${launchState.port} on cdp port ${launchState.cdpPort}`);
  }
  log(`attached to product tab on port ${launchState.port} (cdp ${launchState.cdpPort})`);
  void run;
  return { browser, page, launchState };
}

/**
 * The launch reuse the task requires: this walker never grows a second launcher. It runs the shots
 * kit's own `launch` phase, which pins, claims the CDP port with its lock, isolates the run root and
 * tears down only the pids it started. Returns the mounted launch state.
 */
function launchViaShotsKit({ paths, values, log }) {
  const args = [join(KIT_ROOT, "run.mjs"), "launch", `--out=${paths.outRoot}`, `--stage=${paths.stageRoot}`];
  if (values.commit !== undefined) args.push(`--commit=${values.commit}`);
  if (values.runtime !== undefined) args.push(`--runtime=${values.runtime}`);
  if (values["cdp-port"] !== undefined) args.push(`--cdp-port=${values["cdp-port"]}`);
  if (values["game-dir"] !== undefined) args.push(`--game-dir=${values["game-dir"]}`);
  if (values.edge !== undefined) args.push(`--edge=${values.edge}`);
  log(`launching through the shots kit: node ${args.slice(1).join(" ")}`);
  const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`shots_launch_failed exit=${result.status}`);
  return JSON.parse(readFileSync(paths.launchStateFile, "utf8"));
}

/** Stop the mounted run and tear down only the pids it started, through the kit's own cleanup phase. */
function stopViaShotsKit({ paths, log }) {
  const args = [join(KIT_ROOT, "run.mjs"), "cleanup", `--out=${paths.outRoot}`, `--stage=${paths.stageRoot}`];
  log("stopping through the shots kit's cleanup phase (writes the stop flag, then verifies the ports)");
  const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) log(`cleanup phase exited ${result.status}; read the cleanup log for the teardown facts`);
}

function ensureRun({ values, log }) {
  const outRoot = values.out;
  if (typeof outRoot !== "string" || outRoot.length === 0)
    throw new Error("--out <root> is required (it is the mount root the shots kit owns)");
  const stageRoot = values.stage ?? defaultStageFor(outRoot);
  const paths = runPaths({ outRoot, stageRoot });
  const prior = loadRunConfig(paths);
  if (prior !== null) return { paths, prior };
  const run = {
    tag: sanitizeTag("journey-walker") || sanitizeTag(outRoot),
    commit: typeof values.commit === "string" ? values.commit : "",
    outRoot,
    stageRoot,
    runtimeFixture: typeof values.runtime === "string" ? values.runtime : "",
    gameDir: values["game-dir"] ?? process.env.GB_SHOTS_GAME_DIR ?? "D:\\Steam\\steamapps\\common\\Stardew Valley",
    edgeExe:
      values.edge ?? process.env.GB_SHOTS_EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    cdpPort: Number(values["cdp-port"] ?? process.env.GB_SHOTS_CDP_PORT ?? 9341),
  };
  saveRunConfig(paths, run);
  log(`wrote a run config beside the shots kit's own (${paths.runConfigFile})`);
  return { paths, prior: null };
}

async function main() {
  const values = parseWalkerArgs(process.argv.slice(2));
  const phasesRun = selectPhases(values.only);
  const budgetMs = Number(values["budget-ms"] ?? DEFAULT_BUDGET_MS);
  const logPath = typeof values.log === "string" ? values.log : join(REPO_ROOT, ".pi", "tools", "journey-walker.log");
  mkdirSync(dirname(logPath), { recursive: true });
  const log = (line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    appendFileSync(logPath, `${stamped}\n`);
    console.log(stamped);
  };

  const { paths } = ensureRun({ values, log });
  const findings = new Findings();
  const startedAt = Date.now();
  let launchState = null;
  let browser = null;
  let code = 0;
  try {
    if (values.launch === true) launchState = launchViaShotsKit({ paths, values, log });
    else if (existsSync(paths.launchStateFile)) launchState = JSON.parse(readFileSync(paths.launchStateFile, "utf8"));
    if (launchState === null || launchState.mounted !== true)
      throw new Error("no mounted run: pass --launch, or run the shots kit's launch phase first");

    const attached = await attach({ run: null, paths, log });
    browser = attached.browser;
    const walker = new Walker({ page: attached.page, findings, phasesRun, budgetMs });
    walker.setWidth(1440);
    walker.attachCapture();
    walker.startedAt = Date.now();

    if (phasesRun.includes("walk")) {
      log("== phase walk ==");
      await walker.phaseWalk();
    }
    if (phasesRun.includes("extremes")) {
      log("== phase extremes ==");
      await walker.phaseExtremes();
    }
    if (phasesRun.includes("widths")) {
      log("== phase widths ==");
      await walker.phaseWidths();
    }
    if (phasesRun.includes("scan")) {
      log("== phase scan ==");
      await walker.phaseScan();
    }

    const report = renderReport({
      findings,
      phasesRun,
      launchState,
      capMs: budgetMs,
      elapsedMs: Date.now() - startedAt,
      exclusions: [...TEXT_EXCLUSIONS, ...ALLOWED_TOKENS.map((token) => `token:${token}`)],
    });
    if (typeof values.report === "string") {
      mkdirSync(dirname(values.report), { recursive: true });
      writeFileSync(values.report, report, "utf8");
    }
    console.log(report);
    log(
      `walked=${walker.controlsWalked} findings=${findings.items.length} skips=${findings.skips.length} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`,
    );
    code = reportExitCode(findings);
  } finally {
    // Only this walker's own connection is closed; the mounted run keeps its browser and product, so
    // an attached walk leaves the run exactly where it found it.
    if (browser !== null) await browser.close().catch(() => undefined);
  }
  if (values.stop === true) stopViaShotsKit({ paths, log });
  process.exit(code);
}

// The suite imports this module for its pure parts; only a direct invocation walks.
const invokedDirectly =
  process.argv[1] !== undefined &&
  ["journey-walker.mjs", "journey-walker"].includes(process.argv[1].split(/[\\/]/u).pop());
if (invokedDirectly) {
  await main().catch((error) => {
    console.error(`JOURNEY WALKER FAILED: ${String(error).slice(0, 1200)}`);
    process.exit(2);
  });
}
