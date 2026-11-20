// Shared plumbing for the shots capture drivers. Adapted from the proven lane drivers
// (scratch/shots13/f13-common.cjs and scratch/shots12/fa15-common.cjs): the shots directory and the
// page-helper global come from env (GB_SHOTS_OUT / GB_SHOTS_REPO / GB_SHOTS_CDP_PORT) instead of
// being hard-coded. Geometry/measurement patterns are carried over unchanged where a lane earned them.
const path = require("node:path");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");

const REPO = process.env.GB_SHOTS_REPO ?? __dirname;
const SHOTS = process.env.GB_SHOTS_OUT ?? path.join(__dirname, ".shots-out");

/*
 * The repository root, found by walking up to the directory that owns `.git`.
 *
 * Exported so a driver can name a path inside the repo without counting `../` from its own location.
 * `l-new-surfaces.cjs` counted three levels from `capture/` and reached `tools/host/dist-test`, which
 * does not exist; the require failed and its fallback quietly built the PNG itself, so the run stayed
 * green while the "same PNG the host's own tests use" claim was false. A path derived by counting
 * directories from a file that can move is wrong after the move, and the failure it produces names the
 * missing module rather than the arithmetic.
 */
const REPO_ROOT = (() => {
  let directory = __dirname;
  for (;;) {
    if (existsSync(path.join(directory, ".git"))) return directory;
    const parent = path.resolve(directory, "..");
    if (parent === directory) throw new Error(`no .git above ${__dirname}: the kit must live inside the repository`);
    directory = parent;
  }
})();

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
 * `Composer.tsx` refuses that button on `sendRefused(uiState.send) || !value.trim()`: the second term
 * is the field being empty, which is the state every driver is in when it asks, because it has not
 * typed yet. Reading the button therefore answered "this mount cannot send" on every mount, including
 * one with a seeded, active connection - three drivers took a named skip, and the run reported a green
 * `DONE-CAPTURE` with a whole family of screenshots missing.
 *
 * The two refusals are read where the product states them: `fieldLocked(uiState.send)` is the
 * textarea's own `disabled` (the Host would not accept a submission now, or this surface is
 * rewriting the transcript), and `replyHasNoModel(uiState.send)` is the standing
 * `[data-chat-no-model]` banner (the surface's `ChatModelRoute = none`). Send is refused for either,
 * which is `sendRefused`. The credential flag is a third, separate fact the drivers already check.
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
 *
 * A panel a previous step opened is a MODAL `<dialog>` (`ContextDrawer` calls `showModal()`), anchored to
 * the right edge with a `.drawer-header` exactly one `var(--appbar-height)` row tall at the top of the
 * window - which is where `.app-bar-actions` is. So while one is open the bar's entries are behind the top
 * layer and every click on them ends in `intercepts pointer events`, not in a measurement.
 *
 * THE GATE USED TO KEY ON `.backdrop-overlay`, a class the product no longer has: the scrim is the
 * platform's `dialog::backdrop` now, and the class survives only inside a comment in `style.css`. The gate
 * was therefore never true, Escape was never pressed, and twenty-one drivers failed in the same place
 * (`frontend-final-r1.stage/logs/capture.log`: 21 of 21 failures name an interceptor, 0 name an unstable
 * element). It keys on the open dialog itself now, and it verifies the closure instead of assuming it: a
 * drawer that outlives the Escape is reported by name rather than left to look like a click timeout.
 */
async function activateSurface(page, label) {
  const openDrawer = page.locator("dialog.context-panel[open]");
  if ((await openDrawer.count()) > 0) {
    await page.keyboard.press("Escape");
    const closed = await openDrawer
      .first()
      .waitFor({ state: "detached", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!closed) {
      const open = await openDrawer.first().getAttribute("data-testid").catch(() => null);
      throw new Error(`surface_switch_blocked_by_open_drawer: ${open ?? "(no data-testid)"}`);
    }
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
 * Wait until a panel a driver is about to read has mounted its own data.
 *
 * `activateSurface` commits the surface's region and its paint; it commits nothing about that
 * surface's data. The 角色 panel is the measured case: it renders `<section data-opening-editor>` as soon
 * as the panel mounts and its `.opening-variant-row` rows only once the card read lands, so
 * between the two the editor holds ZERO rows and NO buttons - and zero rows is also exactly what a
 * companion whose opening set is already down to one holds. Driver M slept a fixed 1600 ms there,
 * read `variantCount: 0`, took it for "already one opening", and pressed a save control that did not
 * exist yet (`saving the one-opening set: no_button:保存开场白`), then died on a 30 s click timeout in
 * the next surface switch. The sleep was not too short; it was the wrong instrument.
 *
 * Three conditions, each named so a failure says what it waited for:
 *
 *   present   the panel root exists (`panel`), so the surface really switched;
 *   loaded    the product's own loading line (`.loading-text`) is gone from that root - the one
 *             marker the product publishes for "my read has not landed", and the reason a count of 0
 *             cannot be trusted on its own;
 *   stable    `item`'s count is the same across two reads `settleMs` apart, so a panel that renders
 *             its rows one batch at a time is not read half-drawn.
 *
 * A condition that never holds throws `panel_never_settled:<name>` and quotes the last reading, so the
 * driver fails naming its premise instead of reporting a number measured from a panel that was not
 * there. A driver that legitimately has no items still passes: zero rows after the loading line has
 * cleared and has stayed cleared is a reading, and the driver's own assertion judges it.
 */
async function waitForPanel(page, { name, panel, item = null, timeoutMs = 20000, settleMs = 300 }) {
  if (typeof name !== "string" || name.length === 0) throw new Error("waitForPanel_requires_a_name");
  if (typeof panel !== "string" || panel.length === 0)
    throw new Error(`waitForPanel_${name}_requires_a_panel_selector`);
  const started = Date.now();
  let previousCount = null;
  let reading = { panel: false, loading: 0, count: null };
  for (;;) {
    reading = await page.evaluate(
      ({ panelSelector, itemSelector }) => {
        const root = document.querySelector(panelSelector);
        if (root === null) return { panel: false, loading: 0, count: null };
        return {
          panel: true,
          loading: root.querySelectorAll(".loading-text").length,
          count: itemSelector === null ? null : root.querySelectorAll(itemSelector).length,
        };
      },
      { panelSelector: panel, itemSelector: item },
    );
    if (reading.panel && reading.loading === 0) {
      if (item === null) return { ...reading, waitedMs: Date.now() - started };
      if (previousCount !== null && reading.count === previousCount)
        return { ...reading, waitedMs: Date.now() - started };
      previousCount = reading.count;
    } else {
      previousCount = null;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `panel_never_settled:${name} after ${Date.now() - started}ms: waited for ${panel} to mount, its .loading-text to clear${
          item === null ? "" : ` and ${item} inside it to hold the same count across two reads ${settleMs}ms apart`
        }; last reading panel=${reading.panel} loading=${reading.loading} count=${reading.count}`,
      );
    }
    await page.waitForTimeout(settleMs);
  }
}

/**
 * Wait until a panel that publishes its own typed state has SETTLED, and never read a working state as an answer.
 *
 * `waitForPanel` above answers "this panel has drawn its data"; this answers the other half - "this panel has
 * stopped working" - for the one panel that publishes the fact: `StardewInstallationDiscovery.tsx:304` renders
 * `<section className="game-installation-panel" ... data-state={state}>`, and its state machine
 * (`InstallationDiscoveryState`, `dialogue-web/src/game-presentation.ts:149`) has three members it publishes ONLY
 * while a request of its own is outstanding:
 *
 *   loading      a scan is in flight (`read()` sets it before it awaits the Host)
 *   confirming   确认 is in flight (`action("confirm")`)
 *   retrying     重新查找 is in flight (`action("retry")`)
 *
 * The measured defect is a driver that sleeps instead of waiting for one of the others. `frontend--r13` (a loaded
 * machine: 10.3 min build against run 1's 4.2, the same code in both - `git diff --stat 40c9b7f5 088f1f99` is
 * empty for the product and this kit) had the Host answer `{"answer":"resolved","candidateCount":1}` while the
 * panel still read `retrying`, and driver T - which had slept 2200 ms after pressing 重新查找 - asserted the Host's
 * answer against a panel that had not finished drawing it. The same sleep left driver W's 确认 disabled
 * (`scannerDisabled` is `pending !== "none"`), so no launch was ever requested and x/y/z named the missing
 * registration behind it. Neither red is a product reading: both are a driver that took "still working" for "the
 * answer".
 *
 * `settledStates` is the set the caller accepts as ITS answer, and it must contain no member the panel publishes
 * while it works: `INSTALLATION_DISCOVERY_STATES` (the panel's own vocabulary, shared by both drivers) keeps the
 * two apart, and `wait-for-panel.test.mjs` holds that split against the product's union. A caller that has just
 * pressed a control passes the states that control can settle ON (取消 answers `cancelled`, or a refusal) rather
 * than every settled state, because the panel republishes the state it already had while the request is
 * outstanding - "any settled state" would answer with the press's own past.
 *
 * A reading is accepted only when the same state is still there `settleMs` later, which is the rule
 * `waitForPanel` already applies to its item count and the reason a press whose re-render has not flushed yet
 * cannot be answered with the state from before it.
 */
async function waitForPanelSettled(page, { name, panel, settledStates, timeoutMs = 20000, settleMs = 300 }) {
  if (typeof name !== "string" || name.length === 0) throw new Error("waitForPanelSettled_requires_a_name");
  if (typeof panel !== "string" || panel.length === 0)
    throw new Error(`waitForPanelSettled_${name}_requires_a_panel_selector`);
  if (!Array.isArray(settledStates) || settledStates.length === 0)
    throw new Error(`waitForPanelSettled_${name}_requires_the_states_it_accepts`);
  const started = Date.now();
  const observed = [];
  let previous = null;
  let reading = { panel: false, state: null };
  for (;;) {
    reading = await page.evaluate((panelSelector) => {
      const root = document.querySelector(panelSelector);
      if (root === null) return { panel: false, state: null };
      return { panel: true, state: root.getAttribute("data-state") };
    }, panel);
    if (reading.panel && observed[observed.length - 1] !== reading.state) observed.push(reading.state);
    const settled = reading.panel && settledStates.includes(reading.state);
    if (settled && previous === reading.state) return { state: reading.state, observed, waitedMs: Date.now() - started };
    previous = settled ? reading.state : null;
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `panel_never_settled:${name} after ${Date.now() - started}ms: waited for ${panel} to report one of ${JSON.stringify(
          settledStates,
        )} on two reads ${settleMs}ms apart; ${
          reading.panel ? `it reported ${JSON.stringify(observed)}` : `no element matched ${panel}`
        }`,
      );
    }
    await page.waitForTimeout(settleMs);
  }
}

/**
 * Whether the shell is SHOWING the conversation, as opposed to merely carrying it.
 *
 * The conversation is the one surface that stays MOUNTED while another one is selected: the shell
 * parks it in `.surface-slot-parked` (`visibility: hidden`, never `display: none`, so the transcript
 * keeps its scroll offset) and renders every other peer conditionally. `[data-testid="chat-surface"]`
 * is therefore on the page on EVERY surface, and "is it there" answers yes to a question about which
 * surface is shown - which is how six creates were reported as landed without committing an opening
 * (`frontend-final-r2.stage`: every attempt answered `committed_opening=null landed=true`, and the
 * run's own threads show no Chat was made).
 *
 * The shell's statement of which surface takes the region is the URL (`useSurfaceRoute`:
 * `shownSurface = openPanel ?? CHAT_PANEL`, design/104 §2): the conversation is `panel=chat` or no
 * `panel` word at all, and the picker standing over the Chats list is `panel=chats`.
 */
const conversationShown = () => {
  if (document.querySelector('[data-testid="chat-surface"]') === null) return false;
  const panel = new URLSearchParams(window.location.hash.slice(1)).get("panel");
  return panel === null || panel === "chat";
};

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
 * opening index this driver pressed, so a refusal (`landed: false`) names what was tried. The
 * surface is read by `conversationShown`, never by the conversation's presence on the page: a
 * mounted-but-parked conversation made this helper answer `landed` on the first round without ever
 * pressing the commit, so the Chat was never created and the list stayed at one row.
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
    if (await page.evaluate(conversationShown)) return { started, committed, landed: true };
    const commit = page.locator('[data-testid="opening-option-commit"]').nth(openingIndex);
    if ((await commit.count()) > 0 && (await commit.isVisible().catch(() => false))) {
      await commit.click({ timeout: 10000 }).catch(() => undefined);
      committed = openingIndex;
    }
  }
  return { started, committed, landed: false };
}

const { observe, observationStart } = require("./observation.cjs");

module.exports = {
  connect,
  reporter,
  observe,
  observationStart,
  REPO_ROOT,
  SHOTS,
  PAGE_HELPERS,
  activateSurface,
  waitForPanel,
  waitForPanelSettled,
  shot,
  readDurableTranscript,
  canStartTurn,
  classifyComposer,
  conversationShown,
  createChat,
};






