// Shared plumbing for the shots capture drivers. Adapted from the proven lane drivers
// (scratch/shots13/f13-common.cjs and scratch/shots12/fa15-common.cjs): the shots directory and the
// page-helper global come from env (GB_SHOTS_OUT / GB_SHOTS_REPO / GB_SHOTS_CDP_PORT) instead of
// being hard-coded. Geometry/measurement patterns are carried over unchanged where a lane earned them.
const path = require("node:path");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");

const REPO = process.env.GB_SHOTS_REPO ?? __dirname;
const SHOTS = process.env.GB_SHOTS_OUT ?? path.join(__dirname, ".shots-out");

function loadChromium() {
  for (const candidate of [
    path.join(REPO, "dialogue-web", "node_modules", "@playwright", "test"),
    path.join(REPO, "dialogue-web", "node_modules", "playwright"),
    path.join(REPO, "node_modules", "playwright"),
  ]) {
    if (!existsSync(candidate)) continue;
    try {
      const chromium = require(candidate).chromium;
      if (chromium) return chromium;
    } catch {
      /* next candidate */
    }
  }
  throw new Error("playwright_not_resolvable");
}

async function connect() {
  const cdpPort = process.argv[3] ?? process.env.GB_SHOTS_CDP_PORT ?? "9341";
  const productPort = process.argv[2];
  const chromium = loadChromium();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().includes(`127.0.0.1:${productPort}`));
  if (page === undefined) {
    await browser.close().catch(() => undefined);
    throw new Error(`no_product_tab_for_port_${productPort}`);
  }
  mkdirSync(SHOTS, { recursive: true });
  return { browser, page };
}

function reporter(name) {
  const lines = [];
  const say = (...parts) => {
    const line = parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ");
    lines.push(line);
    console.log(line);
  };
  const flush = () => writeFileSync(path.join(SHOTS, name), `${lines.join("\n")}\n`, "utf8");
  return { say, flush };
}

// The product's own page globals the drivers share: geometry, overlay count, beat contrast.
const PAGE_HELPERS = `
window.__shots = {
  rect(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
  },
  effectiveBackground(el) {
    let node = el;
    while (node) {
      const color = getComputedStyle(node).backgroundColor;
      if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
      node = node.parentElement;
    }
    return "rgb(0, 0, 0)";
  },
  parseColor(value) {
    const m = /rgba?\\(([^)]+)\\)/.exec(value || "");
    if (!m) return null;
    const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  },
  luminance(color) {
    const channel = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  },
  contrast(foreground, background) {
    const l1 = this.luminance(foreground);
    const l2 = this.luminance(background);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  },
  overlays() {
    const selectors = ['[role="dialog"]', '[aria-modal="true"]', ".overlay", ".modal", ".backdrop"];
    const visible = [...document.querySelectorAll(selectors.join(","))].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    });
    return { count: visible.length, detail: visible.map((el) => ({ tag: el.tagName.toLowerCase(), text: (el.getAttribute("aria-label") ?? el.innerText ?? "").slice(0, 60) })) };
  },
  surfaceRegions() {
    return [...document.querySelectorAll('section[data-testid$="-surface"]')].map((el) => el.getAttribute("data-testid"));
  },
  scrollContainer(el) {
    let node = el?.parentElement ?? null;
    while (node) {
      const style = getComputedStyle(node);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight >= node.clientHeight) {
        return { cls: String(node.className), overflowY: style.overflowY, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
      }
      node = node.parentElement;
    }
    return null;
  },
};
`;

module.exports = { connect, reporter, SHOTS, PAGE_HELPERS, activateSurface, shot };

/**
 * A screenshot that does not throw the driver away.
 *
 * `page.screenshot()` intermittently never returns on this headless-hosted Edge session (the
 * window is often occluded, and an occluded Chrome renderer can stop committing compositor
 * frames, which is what `Page.captureScreenshot` waits for). The failure is transport, not the
 * product: every screenshot therefore brings the page forward, disables animations, allows a
 * long settle, retries, and finally REPORTS the failure as data instead of aborting the driver.
 */
async function shot(page, file, options = {}) {
  const target = path.join(SHOTS, file);
  const attempts = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.bringToFront().catch(() => undefined);
      if (attempt > 0) await page.waitForTimeout(1500);
      await page.screenshot({ path: target, animations: "disabled", caret: "initial", timeout: 45000, ...options });
      return { file, ok: true, attempts };
    } catch (error) {
      attempts.push(String(error).split("\n")[0].slice(0, 120));
    }
  }
  console.log(`SCREENSHOT FAILED (transport, not product): ${file} :: ${JSON.stringify(attempts)}`);
  return { file, ok: false, attempts };
}

/**
 * Select a peer surface by its AppBar entry name. A narrow bar folds the trailing entries into one
 * `更多` disclosure, so the same entry is either a bar button or a row inside that panel.
 */
async function activateSurface(page, label) {
  const trigger = page.locator(".app-bar-more-trigger");
  if ((await trigger.count()) > 0 && (await trigger.isVisible())) {
    await trigger.click();
    const folded = page.locator(`.app-bar-more-menu .nav-button[aria-label="${label}"]`);
    if ((await folded.count()) > 0 && (await folded.isVisible())) {
      await folded.click();
      await page.waitForTimeout(600);
      return "folded-menu";
    }
    await page.keyboard.press("Escape");
  }
  const direct = page.locator(`.app-bar-actions .nav-button[aria-label="${label}"]`);
  await direct.first().click();
  await page.waitForTimeout(600);
  return "app-bar";
}