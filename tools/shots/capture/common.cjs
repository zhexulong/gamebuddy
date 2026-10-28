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

/**
 * Whether this mount can start a turn at all - the one rule every turn-dependent driver asks.
 *
 * The question is the composer's own two refusals, and NOT the send button's `disabled` attribute.
 * `Composer.tsx` disables that button on `disabled || sendUnavailable || !value.trim()`: the third
 * term is the field being empty, which is the state every driver is in when it asks, because it has
 * not typed yet. Reading the button therefore answered "this mount cannot send" on every mount,
 * including one with a seeded, active connection - three drivers took a named skip, and the run
 * reported a green `DONE-CAPTURE` with a whole family of screenshots missing.
 *
 * The two terms that are the product's own answer are read where the product states them:
 * `disabled` (`= !submitAvailable`: the Host would not accept a submission now) is the field's own
 * lock, and `sendUnavailable` (the surface's `ChatModelRoute = none`) is the standing banner that
 * route renders. The credential flag is a third, separate fact the drivers already check.
 */
async function canStartTurn(page) {
  return classifyComposer(
    await page.evaluate(() => {
      const field = document.querySelector("textarea.composer-textarea");
      const banner = document.querySelector("[data-chat-no-model]");
      const notice = document.querySelector(".reference-turn-notice");
      return {
        fieldPresent: field !== null,
        submitRefused: field !== null && field.disabled,
        noModel: banner !== null,
        sentence: (banner?.textContent ?? notice?.textContent ?? "").trim() || null,
      };
    }),
  );
}

/** The three readings above, as the rule itself, so a test can hold every member without a browser. */
function classifyComposer(facts) {
  if (!facts.fieldPresent) return { ok: false, reason: "no_composer_on_this_mount", sentence: facts.sentence };
  if (facts.noModel) return { ok: false, reason: "no_model_route", sentence: facts.sentence };
  if (facts.submitRefused) return { ok: false, reason: "submit_refused", sentence: facts.sentence };
  return { ok: true, reason: null, sentence: facts.sentence };
}

/**
 * The Host's own projection of the mounted conversation, read through the product's own state route
 * with the page's own session cookie (a read sends no CSRF header). The DOM is what the player sees;
 * this is what the Host kept, and a driver reports the two apart because they can disagree - a
 * message the transcript no longer renders still has an `order` here, which is what a delete leaves.
 *
 * `selection` is the mount's own published identity. The chat handle, selection generation and
 * state revision are all minted by the mounted lease's projection (an HMAC keyed on a per-lease
 * secret), so all three - and every transcript handle - change together the moment the Host mounts
 * a different lease, and none of them change while the same lease stays mounted.
 */
async function readDurableTranscript(page) {
  return await page.evaluate(async () => {
    try {
      const response = await fetch("/api/tavern/v1/state");
      if (!response.ok) return { ok: false, status: response.status };
      const body = await response.json();
      const chat = body.chat ?? null;
      const selection = body.selection ?? null;
      return {
        ok: true,
        selection:
          selection === null
            ? null
            : {
                chatHandle: selection.chatHandle,
                generation: selection.generation,
                stateRevision: selection.stateRevision,
              },
        title: chat?.title ?? null,
        companion: chat?.companion?.name ?? null,
        transcript: (chat?.transcript ?? []).map((message) => ({
          order: message.order,
          role: message.role,
          revision: message.revision,
          handle: message.handle,
          text: message.text,
        })),
      };
    } catch (error) {
      return { ok: false, failed: String(error).slice(0, 160) };
    }
  });
}

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
  // A drawer another driver left open covers `main` with its own backdrop, and that backdrop
  // intercepts the bar's own controls (a surface switch is then a 30 s click timeout rather than a
  // measurement). Escape is the drawer's own close gesture, so the bar entry is only clicked once
  // nothing is covering it.
  const backdrop = page.locator(".backdrop-overlay").first();
  if ((await page.locator(".backdrop-overlay").count()) > 0 && (await backdrop.isVisible().catch(() => false))) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }
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

/**
 * Create one Chat through the product's own New Chat control, and answer how it really went.
 *
 * One control, two jobs, decided by the catalogue: a companion with openings to choose from opens
 * the picker and the Chat exists only once an opening is committed; one without creates the Chat
 * outright. The picker's commit is `[data-testid="opening-option-commit"]` (`用这个开场`): on
 * 2026-10-27 `c55ea777` made the card's prose inert text a player can read, select and copy, and
 * moved the commit onto that button - the same control `new-chat-opening-picker.spec.ts` drives.
 * Clicking the prose commits nothing, which is what this kit was still doing: `shots-final55`'s
 * driver E pressed it five times, got five `clicked` answers, made no Chat, and the run measured a
 * one-row list - so E's second-row claims, its 41b/41c screenshots and driver K's switch were all
 * gone while the run still reported a green `DONE-CAPTURE`. A gesture that answers "clicked" and
 * creates nothing is why this answers `landed` from the surface instead of from the click.
 *
 * Creating lands IN the created Chat: the shell selects it and moves the region to the chat
 * surface. `landed` is that surface, read after the picker has been answered; `committed` is the
 * opening index this driver pressed, so a refusal (`landed: false`) names what was tried.
 */
async function createChat(page, { openingIndex = 0, settleMs = 1500, rounds = 20 } = {}) {
  const started = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="new-chat"]');
    if (button === null) return "no_create_control";
    if (button.disabled) return "create_disabled";
    button.click();
    return "clicked";
  });
  if (started !== "clicked") return { started, committed: null, landed: false };
  let committed = null;
  for (let round = 0; round < rounds; round += 1) {
    await page.waitForTimeout(settleMs);
    if (await page.evaluate(() => document.querySelector('[data-testid="chat-surface"]') !== null))
      return { started, committed, landed: true };
    const commit = page.locator('[data-testid="opening-option-commit"]').nth(openingIndex);
    if ((await commit.count()) > 0 && (await commit.isVisible().catch(() => false))) {
      await commit.click({ timeout: 10000 }).catch(() => undefined);
      committed = openingIndex;
    }
  }
  return { started, committed, landed: false };
}

module.exports = {
  connect,
  reporter,
  SHOTS,
  PAGE_HELPERS,
  activateSurface,
  shot,
  readDurableTranscript,
  canStartTurn,
  classifyComposer,
  createChat,
};
