// Driver T: the installation-discovery panel — the reconciliation the Game surface cannot do alone.
//
// The panel (`dialogue-web/src/components/StardewInstallationDiscovery.tsx`) answers the player with
// exactly ONE sentence, chosen from a typed state it derives from the Host's own answer. A driver that
// reads only the DOM therefore cannot tell whether that sentence is TRUE: "搜索游戏安装位置失败" is the
// panel's catch-all (`error`), and the same sentence stands for a genuinely unclassifiable refusal and
// for a moment the Host answered perfectly well. This driver reads BOTH sides for the same moment —
// the panel's DOM facts, and the Host's own answer through the product's own route
// (`GET /api/composed-reference-game/v1/game/installation/discovery`, the exact route the panel reads) —
// prints them side by side, and asserts the sentence the surface shows is the true one for what the
// Host answered.
//
// The mapping this driver asserts (named, not a restated label list):
//
//   host resolved an installation        -> the surface must say "we found installations"  (never "not found")
//   host found nothing                   -> the surface must say "nothing was found"        (never "the search failed")
//   host could not read a source         -> the surface must say "the search is unavailable" (never "the search failed")
//   host refused unclassifiably          -> ONLY here may the surface say "the search failed"
//
// Which state a scan can produce is the machine's own fact, so a state this machine cannot produce is a
// NAMED SKIP with the reason — never a silent pass.
//
// 选择游戏文件夹 opens the OS folder picker: the control is read (name, box, disabled), and the driver
// says plainly that the native dialog is out of its reach. 确认 registers an installation into this run's
// durable state, which the task scopes this driver out of; it too is read, not clicked.
const { connect, reporter, PAGE_HELPERS, activateSurface, shot } = require("./common.cjs");

const WIDTHS = [
  { w: 1440, h: 900, tag: "1440x900" },
  { w: 400, h: 800, tag: "400x800" },
];

/**
 * The panel's typed state -> the sentence a player reads (`installationStateLabel` + `dialogue-web/src/i18n.ts`).
 * Both locales are carried so the exact sentence a state must produce is pinned without assuming which
 * language the run is in; the page's own `aria-label` (`labels.gameInstallationAria`) picks the locale.
 */
const SENTENCE = {
  not_configured: { zh: "GameBuddy 需要找到你的《星露谷物语》安装位置。", en: "GameBuddy needs to find your Stardew Valley installation." },
  loading: { zh: "正在查找《星露谷物语》安装位置…", en: "Looking for your Stardew Valley installation…" },
  candidates: { zh: "已找到可能的安装位置，请选择一个进行连接。", en: "We found possible installations. Choose one to connect." },
  confirming: { zh: "正在确认安装位置…", en: "Confirming the installation…" },
  retrying: { zh: "正在重新搜索…", en: "Searching again…" },
  cancelled: { zh: "搜索已取消。", en: "Search cancelled." },
  "source-unavailable": { zh: "目前无法搜索游戏安装位置。", en: "The installation search is unavailable right now." },
  "no-candidates": { zh: "未找到《星露谷物语》安装位置。", en: "No Stardew Valley installation was found." },
  expired: { zh: "搜索结果已过期，请重新搜索。", en: "These search results expired. Search again." },
  error: { zh: "搜索游戏安装位置失败。", en: "The installation search failed." },
};
/** `labels.gameInstallationAria`, which tells the driver which locale's sentences to match. */
const ARIA = { zh: "游戏安装设置", en: "Game installation setup" };
/** The panel's own accessible names for its controls (`gameInstallationChooseFolder` / `FindAgain` / `Confirm` / `gameResumeCancel`). */
const CONTROL = {
  chooseFolder: { zh: "选择游戏文件夹", en: "Choose game folder" },
  findAgain: { zh: "重新查找", en: "Find again" },
  confirm: { zh: "确认", en: "Confirm" },
  cancel: { zh: "取消", en: "Cancel" },
};
const ALL_STATES = [
  "not_configured",
  "loading",
  "candidates",
  "confirming",
  "retrying",
  "cancelled",
  "source-unavailable",
  "no-candidates",
  "expired",
  "error",
];
/**
 * The Host's diagnostics that name a source it could not read
 * (`host/src/stardew-game-install/discovery.ts` and `windows-stardew-installation-discovery/internal.ts`).
 * `no-candidates` is the empty-scan marker, not a read failure, so it is not in this set.
 */
const SOURCE_FAILURE_DIAGNOSTICS = [
  "source-unavailable",
  "registry-unavailable",
  "vdf-unreadable",
  "vdf-malformed",
  "invalid-app-manifest",
  "candidate-invalid",
];

/** The panel's DOM facts. Self-contained: a serialized page function cannot see module scope. */
const readPanel = () => {
  const surface = document.querySelector('[data-testid="game-surface"]');
  const panel = surface === null ? null : surface.querySelector(".game-installation-panel");
  if (panel === null) return { present: false, surfacePresent: surface !== null };
  const nameOf = (el) => (el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
  const disabledOf = (el) => el.disabled === true || el.getAttribute("aria-disabled") === "true";
  const controls = [...panel.querySelectorAll("button, select, input, textarea, a[href]")].map((el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      name: nameOf(el),
      box: window.__shots.rect(el),
      w: Math.round(r.width),
      h: Math.round(r.height),
      meets44: Math.round(r.width) >= 44 && Math.round(r.height) >= 44,
      disabled: disabledOf(el),
      visible: r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden",
    };
  });
  const statusParagraphs = [...panel.querySelectorAll(".installation-state")].map((p) => ({
    text: (p.textContent ?? "").trim(),
    role: p.getAttribute("role"),
  }));
  const status = panel.querySelector(".installation-state");
  return {
    present: true,
    surfacePresent: surface !== null,
    panelTestid: panel.getAttribute("data-testid"),
    dataState: panel.getAttribute("data-state"),
    ariaLabel: panel.getAttribute("aria-label"),
    tabIndex: panel.getAttribute("tabindex"),
    box: window.__shots.rect(panel),
    scroll: {
      overflowY: getComputedStyle(panel).overflowY,
      scrollHeight: panel.scrollHeight,
      clientHeight: panel.clientHeight,
      scrollable: panel.scrollHeight > panel.clientHeight + 1,
    },
    headings: [...panel.querySelectorAll("h2, h3, h4")].map((h) => (h.textContent ?? "").trim()),
    statusText: status === null ? null : (status.textContent ?? "").trim(),
    statusParagraphs,
    candidates: [...panel.querySelectorAll(".installation-candidate")].map((li) => {
      const confirm = li.querySelector("button");
      return {
        label: (li.querySelector(".installation-candidate-label")?.textContent ?? "").trim(),
        source: (li.querySelector(".installation-source")?.textContent ?? "").trim(),
        hint: (li.querySelector(".installation-hint")?.textContent ?? "").trim() || null,
        confirmName: confirm === null ? null : (confirm.textContent ?? "").trim(),
        confirmDisabled: confirm === null ? null : disabledOf(confirm),
      };
    }),
    controls,
    // "the panel's own testids": what the panel actually carries, reported as a fact rather than assumed.
    testids: [...new Set([...panel.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid")))].sort(),
  };
};

/** The Host's own answer, through the product's own route and with the page's own session cookie. */
const readHostDiscovery = async () => {
  try {
    const response = await fetch("/api/composed-reference-game/v1/game/installation/discovery", {
      method: "GET",
      credentials: "same-origin",
    });
    let body = null;
    let parseFailed = false;
    try {
      body = await response.json();
    } catch {
      parseFailed = true;
    }
    return { status: response.status, ok: response.ok, body, parseFailed };
  } catch (error) {
    return { status: 0, ok: false, body: null, networkError: String(error).slice(0, 200) };
  }
};

/** Click one control of the panel by its accessible name. Inlined name matching; labels passed in. */
const clickNamedControl = ({ labels }) => {
  const surface = document.querySelector('[data-testid="game-surface"]');
  if (surface === null) return "no_game_surface";
  const panel = surface.querySelector(".game-installation-panel");
  if (panel === null) return "no_panel";
  const nameOf = (el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
  const button = [...panel.querySelectorAll("button")].find((candidate) => labels.includes(nameOf(candidate)));
  if (button === undefined) return `no_control:${labels.join("|")}`;
  if (button.disabled) return `disabled:${nameOf(button)}`;
  button.click();
  return `clicked:${nameOf(button)}`;
};

const scrollPanelIntoView = () => {
  const panel = document.querySelector('[data-testid="game-surface"] .game-installation-panel');
  if (panel === null) return false;
  panel.scrollIntoView({ block: "center" });
  return true;
};

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("t-installation-discovery.txt");
  await page.evaluate(`${PAGE_HELPERS};undefined`);

  // The wire, so "the Host answered the cancel" is a fact about the product's own route rather than an
  // inference from the DOM.
  const wire = [];
  page.on("response", (response) => {
    try {
      const path = new URL(response.url()).pathname;
      if (path.includes("/installation/discovery")) {
        wire.push({ method: response.request().method(), path, status: response.status() });
      }
    } catch {
      // A response whose URL does not parse is not a route this check is about.
    }
  });

  let checks = 0;
  let failed = 0;
  const check = (name, ok, detail) => {
    checks += 1;
    if (!ok) failed += 1;
    say(`ASSERT ${name}: ${ok ? "PASS" : "FAIL"} — ${detail}`);
  };
  const observed = new Set();
  const names = (control) => [CONTROL[control].zh, CONTROL[control].en];

  const localeOf = (panel) => (panel.ariaLabel === ARIA.zh ? "zh" : panel.ariaLabel === ARIA.en ? "en" : null);

  /**
   * The Host's own answer, classified in the Host's own terms. This is the whole mapping: the Host's
   * kind -> the single sentence the surface must show, and the name of the claim being asserted.
   */
  const classifyHost = (host) => {
    if (host.status === 200 && host.body !== null && Array.isArray(host.body.candidates)) {
      const diagnostics = Array.isArray(host.body.diagnostics) ? host.body.diagnostics : [];
      const sourceFailure = diagnostics.some((item) => SOURCE_FAILURE_DIAGNOSTICS.includes(item));
      return host.body.candidates.length > 0
        ? { host: "resolved", sentence: "candidates", diagnostics, candidateCount: host.body.candidates.length }
        : { host: "nothing-found", sentence: "no-candidates", diagnostics, candidateCount: 0, sourceFailure };
    }
    const code = host.body !== null && typeof host.body.code === "string" ? host.body.code : null;
    if (code === "game_unavailable" || code === "source_unavailable") {
      return { host: "source-unavailable", sentence: "source-unavailable", code };
    }
    return { host: "refused", sentence: "error", code };
  };

  /** Read both sides, print them side by side, and assert the sentence is the true one. */
  const reconcile = async (label) => {
    const panel = await page.evaluate(readPanel);
    const host = await page.evaluate(readHostDiscovery);
    const expected = classifyHost(host);
    const locale = panel.present ? localeOf(panel) : null;
    say(`--- RECONCILIATION ${label} ---`);
    say(
      `HOST   : ${JSON.stringify({
        http: host.status,
        ok: host.ok,
        answer: expected.host,
        code: expected.code ?? null,
        candidateCount: expected.candidateCount ?? null,
        sourceFailureNamed: expected.sourceFailure ?? false,
        diagnostics: expected.diagnostics ?? [],
        body: host.body,
      })}`,
    );
    say(
      `SURFACE: ${JSON.stringify(
        panel.present
          ? {
              panelTestid: panel.panelTestid,
              dataState: panel.dataState,
              ariaLabel: panel.ariaLabel,
              locale,
              statusText: panel.statusText,
              statusRole: panel.statusParagraphs[0]?.role ?? null,
              candidateRows: panel.candidates.length,
            }
          : { present: false, surfacePresent: panel.surfacePresent },
      )}`,
    );
    if (!panel.present) {
      check(`panel-present[${label}]`, false, "the Game surface has no .game-installation-panel, so no sentence can be reconciled against the Host's answer");
      return { panel, host, expected, locale };
    }
    if (locale === null) {
      check(`locale[${label}]`, false, `the panel's aria-label ${JSON.stringify(panel.ariaLabel)} is neither the zh nor the en installation sentence, so the expected sentence cannot be pinned`);
      return { panel, host, expected, locale };
    }
    check(
      `state[${label}]`,
      panel.dataState === expected.sentence,
      `the Host answered '${expected.host}'${expected.code ? ` (code ${JSON.stringify(expected.code)})` : ""}${expected.candidateCount === null ? "" : ` with ${expected.candidateCount} candidate(s)`}, so the surface must show data-state='${expected.sentence}'; it shows ${JSON.stringify(panel.dataState)}`,
    );
    check(
      `sentence[${label}]`,
      panel.statusText === SENTENCE[expected.sentence][locale],
      `data-state='${expected.sentence}' must read ${JSON.stringify(SENTENCE[expected.sentence][locale])} (${locale}); it reads ${JSON.stringify(panel.statusText)}`,
    );
    // The named claims, stated in the owner's own terms rather than as a label list.
    if (expected.host === "resolved") {
      check(
        `named:resolved-is-not-notfound[${label}]`,
        panel.dataState !== "no-candidates" && panel.statusText !== SENTENCE["no-candidates"][locale],
        `the Host resolved an installation, so the surface must not say ${JSON.stringify(SENTENCE["no-candidates"][locale])}`,
      );
      check(
        `named:resolved-is-not-failed[${label}]`,
        panel.statusText !== SENTENCE.error[locale],
        `the Host resolved an installation, so the surface must not say ${JSON.stringify(SENTENCE.error[locale])}`,
      );
    }
    if (expected.host === "nothing-found") {
      check(
        `named:nothing-found-is-not-failed[${label}]`,
        panel.statusText !== SENTENCE.error[locale],
        `the Host's scan found nothing${expected.sourceFailure ? " and named a source it could not read" : ""}, so the surface must not say ${JSON.stringify(SENTENCE.error[locale])}`,
      );
    }
    if (expected.host === "source-unavailable") {
      check(
        `named:source-unavailable-is-not-failed[${label}]`,
        panel.statusText !== SENTENCE.error[locale],
        `the Host could not read a source, so the surface must not say ${JSON.stringify(SENTENCE.error[locale])}`,
      );
    }
    if (expected.host === "refused") {
      check(
        `named:refusal-may-read-failed[${label}]`,
        panel.statusText === SENTENCE.error[locale],
        `the Host refused with ${expected.code === null ? "no bounded code" : `code ${JSON.stringify(expected.code)}`}, which the client cannot classify as a source failure, so ${JSON.stringify(SENTENCE.error[locale])} is the honest sentence`,
      );
    }
    return { panel, host, expected, locale };
  };

  // ── The panel at both widths, and the Host's own answer for the same moment ──
  let lastAnswer = "unknown";
  for (const size of WIDTHS) {
    await page.setViewportSize({ width: size.w, height: size.h });
    await page.waitForTimeout(800);
    await activateSurface(page, "游戏");
    const firstSample = await page.evaluate(readPanel);
    if (firstSample.dataState) observed.add(firstSample.dataState);
    await page.waitForTimeout(1600);
    const settled = await page.evaluate(readPanel);
    if (settled.dataState) observed.add(settled.dataState);
    const result = await reconcile(`@${size.tag}`);
    if (result.panel.dataState) observed.add(result.panel.dataState);
    lastAnswer = result.expected.host;
    say(`===== INSTALLATION PANEL @${size.tag} =====`);
    say(`the surface, immediately after it mounted (the first sample): ${JSON.stringify({ dataState: firstSample.dataState, statusText: firstSample.statusText })}`);
    say(`the settled panel facts: ${JSON.stringify(settled, null, 1)}`);
    say(`panel testids: ${JSON.stringify({ panelTestid: settled.panelTestid, testidsInside: settled.testids })}`);
    say(`44 px floor over the panel's ${settled.controls.length} control(s): ${JSON.stringify(settled.controls.map((c) => ({ name: c.name, box: c.box, disabled: c.disabled, visible: c.visible, meets44: c.meets44 })))}`);
    say(`panel scrolled into view: ${await page.evaluate(scrollPanelIntoView)}`);
    await shot(page, `91-installation-discovery-${size.tag}.png`);
    await shot(page, `91-installation-discovery-${size.tag}-full.png`, { fullPage: true });
  }

  // ── Drive the re-scan (重新查找) — the one control that starts work again ──
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(700);
  say("===== DRIVING THE RE-SCAN (重新查找) =====");
  say(`before the re-scan: data-state=${JSON.stringify((await page.evaluate(readPanel)).dataState)}`);
  const retryClick = await page.evaluate(clickNamedControl, { labels: names("findAgain") });
  say(`re-scan click: ${retryClick}`);
  const during = await page.evaluate(readPanel);
  if (during.dataState) observed.add(during.dataState);
  say(`immediately after the click (the searching-again moment): ${JSON.stringify({ dataState: during.dataState, statusText: during.statusText })}`);
  await page.waitForTimeout(2200);
  const afterRetry = await reconcile("after the re-scan");
  if (afterRetry.panel.dataState) observed.add(afterRetry.panel.dataState);
  lastAnswer = afterRetry.expected.host;
  await shot(page, "91-installation-after-rescan-1440x900.png");

  // ── Drive the cancel (取消) — the control that abandons the read ──
  say("===== DRIVING THE CANCEL (取消) =====");
  const wireBeforeCancel = wire.length;
  say(`cancel click: ${await page.evaluate(clickNamedControl, { labels: names("cancel") })}`);
  await page.waitForTimeout(1600);
  const afterCancel = await page.evaluate(readPanel);
  if (afterCancel.dataState) observed.add(afterCancel.dataState);
  const cancelWire = wire.slice(wireBeforeCancel);
  const cancelAnswer = cancelWire.find((entry) => entry.path.endsWith("/discovery/cancel")) ?? null;
  say(`the wire the cancel produced: ${JSON.stringify(cancelWire)}`);
  say(`after the cancel: ${JSON.stringify({ dataState: afterCancel.dataState, statusText: afterCancel.statusText })}`);
  check(
    "cancel[cancelled]",
    afterCancel.dataState === "cancelled",
    `the Host's own cancel route answered ${cancelAnswer === null ? "no POST .../discovery/cancel" : `HTTP ${cancelAnswer.status}`}, so a settled cancel must show data-state='cancelled'; it shows ${JSON.stringify(afterCancel.dataState)}`,
  );
  await shot(page, "91-installation-after-cancel-1440x900.png");

  // ── The controls the driver reads but must not drive ──
  say("===== THE CONTROLS THIS DRIVER MAY NOT DRIVE =====");
  const panelNow = await page.evaluate(readPanel);
  const pick = (control) => panelNow.controls.find((c) => names(control).includes(c.name)) ?? null;
  const chooseFolder = pick("chooseFolder");
  say(`选择游戏文件夹 control: ${JSON.stringify(chooseFolder)}`);
  if (chooseFolder === null) {
    say(
      `the panel offers 选择游戏文件夹 only in its retryable states (no-candidates / source-unavailable / error / expired); this machine's state was ${JSON.stringify(panelNow.dataState)}, so the control is absent here — a fact, not a driver failure`,
    );
  }
  say(
    "NATIVE DIALOG: 选择游戏文件夹 opens the OS folder picker, a native dialog this driver cannot see or close. The control is read here and nothing is clicked that would open a modal dialog, so the picker path is out of this driver's reach.",
  );
  say(`确认 control(s), one per candidate: ${JSON.stringify(panelNow.controls.filter((c) => names("confirm").includes(c.name)))}`);
  say(
    "确认 registers an installation into this run's durable state, which the task scopes this driver out of; it is read here, not clicked.",
  );

  // ── The states this machine cannot produce: named skips, never a silent pass ──
  say("===== NAMED SKIPS =====");
  const reasonFor = (state) => {
    switch (state) {
      case "not_configured":
        return "no route produces it: the panel mounts in 'loading' and its first read always starts";
      case "loading":
        return "the mount read settled faster than one CDP round-trip, so the searching state was not observed";
      case "confirming":
        return "it is produced only by 确认, which registers an installation into this run's durable state; this driver does not drive it";
      case "retrying":
        return "it is the transient state while a re-scan is outstanding, between the click and the answer";
      case "expired":
        return "no route produces it: nothing in the shipped Host expires a discovery result";
      case "source-unavailable":
        return "only a source-read refusal produces it, and no route refused that way on this machine";
      case "no-candidates":
        return `the Host's own answer on this machine was '${lastAnswer}', so the not-found sentence ${lastAnswer === "resolved" ? "cannot be produced while a real installation is present" : "is not what this machine's scan reports"}`;
      case "candidates":
        return `the Host's own answer on this machine was '${lastAnswer}', so the found-installations sentence ${lastAnswer === "nothing-found" ? "cannot be produced while no installation is present" : "is not what this machine's scan reports"}`;
      case "cancelled":
        return "the cancel path was not driven on this machine";
      default:
        return "the Host answered classifiably, so the unclassifiable refusal state did not occur";
    }
  };
  for (const state of ALL_STATES) {
    if (!observed.has(state)) say(`SKIP state=${state} reason=${reasonFor(state)}`);
  }
  if (chooseFolder === null) {
    say(
      `SKIP control=选择游戏文件夹 reason=the panel renders it only while a scan is retryable (no-candidates / source-unavailable / error / expired); this machine's state was ${JSON.stringify(panelNow.dataState)}, so the picker path could not be read here`,
    );
  }

  say(`RECONCILIATION: ${checks} assertion(s), ${failed} failed`);
  say(`observed data-states: ${JSON.stringify([...observed].sort())}`);
  flush();
  await browser.close().catch(() => undefined);
  say("DONE-T");
})().catch((error) => {
  console.log("DRIVER T FAILED:", String(error).slice(0, 800));
  process.exit(1);
});
