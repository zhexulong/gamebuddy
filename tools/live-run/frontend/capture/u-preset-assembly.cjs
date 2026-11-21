// Driver U: the preset assembly readout — what the assembly actually does with the preset that was imported.
//
// The surface (`dialogue-web/src/components/PresetAssemblySurface.tsx`) answers five questions about a preset,
// each one by NAME: how many entries there are and which are switched off, which markers have no content
// source, which macros this product will not evaluate (with their code), which blocks are injected at which
// depths, and what each sampler key is actually sent as plus the layer that decided it. A screenshot cannot
// say any of that back, and a fixture cannot say it either — the question is what the RUN's own Host made of
// the preset — so every fact below is read out of the DOM the product painted, never handed to the panel.
//
// The reconciliation the panel cannot do alone: the entry count the panel prints is the preset document's own
// `prompts.length` (`presetAssemblySurface` sets `entries.total` from it), and a marker the panel calls
// unfilled is a name the document carries. The document side is read from the preset assets this checkout
// holds — every JSON document under `assets/tavern/presets/` with a top-level `prompts` array, the shape rule
// `tools/audit-preset-macro-frequency.mjs` uses — and matched to the row the panel rendered by the preset's
// own name. Both sides are printed side by side, and the two claims are asserted with three outcomes:
// PASS, FAIL, and UNOBSERVED (a side that was not there is not a pass — a claim that is vacuously true over
// an empty set is the false green this driver exists to prevent).
//
// WHAT THE DRIVER COULD NOT OBSERVE IS NAMED, NEVER COUNTED AS ZERO. The surface's one read is
// `GET /api/tavern/v1/presets` (`PRESET_ASSEMBLY_ROUTE` in `dialogue-web/src/preset-assembly-surface.ts`).
// This driver starts by recording what the run's Host answers on that route and what the panel settled on,
// and closes with one `unobserved:<fact>:<reason>` line per fact that had no value to read. See the run's own
// facts file for which of the two shapes this run produced.
//
// THE TWO CLAIMS ARE UNOBSERVED ON THIS RUN, BY THE FIXTURE'S OWN DESIGN, NOT BECAUSE NOTHING WAS SERVED.
// The readout's one read is `GET /api/tavern/v1/presets` (`PRESET_ASSEMBLY_ROUTE` in
// `dialogue-web/src/preset-assembly-surface.ts`), and the launch phase seeds and binds this run's own preset
// through the product's store (`lib/preset-seed.mjs`), so the Host answers it: the run of 2026-11-15 read
// `status=200 parsed=true` and the panel painted one row. That row is the FIXTURE (`lib/preset-fixture.mjs`
// `R1 preset claim fixture`), and no document under `assets/tavern/presets/` carries that name - so
// `entries-total` and `unfilled-carried-by-document` are UNOBSERVED here (a side that is not there is not a
// pass), which is the outcome `preset-fixture.mjs` documents for this driver. The panel is not the thing
// under suspicion: it prints the entry count and the markers of the document it was served.
//
// HOW THE SURFACE IS REACHED, AND WHERE IT RETURNS TO. `cc53d510` (`3e80c552` before it) took `预设装配` out
// of the app bar: it is not a place a player goes on purpose, so it is now ONE disclosure inside Settings —
// `<details data-settings-presets-disclosure>`, collapsed by default, holding one button
// (`labels.presetsOpen`) — and it is left through its own `data-testid="presets-back"`, which returns to
// Settings. This driver used to call `activateSurface(page, "预设装配")`, which looks for
// `.app-bar-actions .nav-button[aria-label="预设装配"]`; on the run of 2026-11-15 that click waited its full
// 30 s for a control the bar no longer carries. The path a player walks is walked here instead —
// 设置 → the disclosure's summary → its one control — and every step asserts the state it asked for.
// `preset-assembly-is-reached-through-settings.spec.ts` is the product's own statement of the same path.
const { readFileSync, readdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join, relative } = require("node:path");
const {
  connect,
  reporter,
  PAGE_HELPERS,
  activateSurface,
  shot,
  observe,
  observationStart,
  REPO_ROOT,
} = require("./common.cjs");
const { reconciliationVerdict } = require("./reconciliation-verdict.mjs");

const WIDTHS = [
  { w: 1440, h: 900, tag: "1440x900" },
  { w: 400, h: 800, tag: "400x800" },
];

/** The Settings surface's bar entry (`labels.settingsPanel`): the surface that carries the disclosure. */
const SETTINGS_LABEL = "设置";
/** Settings' own block for the readout, and the readout's own way back to it. */
const DISCLOSURE_SELECTOR = "[data-settings-presets-disclosure]";
const BACK_SELECTOR = '[data-testid="presets-back"]';
/** The route the surface's one read uses — the constant the panel calls, spelled once here. */
const READOUT_ROUTE = "/api/tavern/v1/presets";
/** Where this checkout's own SillyTavern presets live (the `assets` root the macro census walks). */
const PRESET_ROOT = join(REPO_ROOT, "assets", "tavern", "presets");
/**
 * The five facts the surface promises. A fact with no value to read is reported as an absence by this name,
 * so a panel that painted nothing cannot be mistaken for a preset with nothing to report.
 */
const FACTS = ["entries", "unfilledMarkers", "macros", "depth", "sampling"];

/**
 * The readout as the DOM holds it. Self-contained: a serialized page function cannot see module scope.
 *
 * The entry counts are the one fact with no attribute of their own — the panel prints them as one localized
 * line (`条目：{{total}} · {{enabled}} 启用 · {{disabled}} 关闭`), so the three digits are read in the order
 * the line places them and the raw line is carried beside them for a reader to check. Every other fact keeps
 * its identifier as an attribute (`data-preset-marker`, `data-preset-macro`, `data-preset-depth-block`,
 * `data-preset-sampling-row`), so those are read as names rather than parsed out of prose.
 */
const readReadout = () => {
  const surface = document.querySelector('[data-testid="presets-surface"]');
  if (surface === null) return { surfacePresent: false };
  const clean = (value) => (value ?? "").replace(/\s+/g, " ").trim();
  const textOf = (el) => (el === null ? null : clean(el.textContent));
  const rows = [...surface.querySelectorAll("[data-preset-assembly]")].map((row) => {
    const entriesLine = textOf(row.querySelector("[data-preset-entries]"));
    const digits = (entriesLine ?? "").match(/\d+/gu) ?? [];
    const depthLine = textOf(row.querySelector("[data-preset-depth-line]"));
    return {
      presetId: row.getAttribute("data-preset-assembly"),
      name: textOf(row.querySelector("h3")),
      entriesLine,
      // `total · enabled · disabled`, in the order the line prints them; three digits or nothing is claimed.
      entries:
        digits.length === 3
          ? { total: Number(digits[0]), enabled: Number(digits[1]), disabled: Number(digits[2]) }
          : null,
      disabled: [...row.querySelectorAll("[data-preset-disabled-entry]")].map((li) =>
        li.getAttribute("data-preset-disabled-entry"),
      ),
      disabledSaysNone: row.querySelector("[data-preset-disabled-none]") !== null,
      unfilled: [...row.querySelectorAll("[data-preset-marker]")].map((li) => li.getAttribute("data-preset-marker")),
      unfilledSaysNone: row.querySelector("[data-preset-unfilled-none]") !== null,
      macros: [...row.querySelectorAll("[data-preset-macro]")].map((li) => {
        const text = clean(li.textContent);
        const bespoke = /\(([^)]*)\)\s*$/u.exec(text);
        return {
          code: li.getAttribute("data-preset-macro"),
          text,
          entries:
            bespoke === null
              ? []
              : bespoke[1]
                  .split(",")
                  .map((part) => part.trim())
                  .filter((part) => part.length > 0),
        };
      }),
      macrosSaysNone: row.querySelector("[data-preset-macros-none]") !== null,
      depthLine,
      depthDigits: (depthLine ?? "").match(/\d+/gu)?.map(Number) ?? [],
      depthSaysNone: row.querySelector("[data-preset-depth-none]") !== null,
      // Each block row reads `identifier · depth`; the identifier is the row's own attribute.
      depthBlocks: [...row.querySelectorAll("[data-preset-depth-block]")].map((li) => {
        const text = clean(li.textContent);
        const depth = /(\d+)\s*$/u.exec(text);
        return {
          identifier: li.getAttribute("data-preset-depth-block"),
          text,
          depth: depth === null ? null : Number(depth[1]),
        };
      }),
      // Each sampling row reads `key = value (source)`.
      sampling: [...row.querySelectorAll("[data-preset-sampling-row]")].map((li) => {
        const text = clean(li.textContent);
        const parts = /^(.*?)\s*=\s*(.*?)\s*\(([^)]+)\)$/u.exec(text);
        return {
          key: li.getAttribute("data-preset-sampling-row"),
          text,
          value: parts === null ? null : parts[2],
          source: parts === null ? null : parts[3],
        };
      }),
      box: window.__shots.rect(row),
    };
  });
  return {
    surfacePresent: true,
    heading: textOf(surface.querySelector("h2")),
    readOnlyHint: textOf(surface.querySelector("[data-preset-readout] > .management-settings-hint")),
    readFailed: textOf(surface.querySelector("[data-preset-read-failed]")),
    none: textOf(surface.querySelector("[data-preset-none]")),
    rows,
    box: window.__shots.rect(surface),
  };
};

/** The Host's own answer on the route the panel reads, through the page's own session cookie. */
const readHostReadout = async (route) => {
  try {
    const response = await fetch(route, { method: "GET", credentials: "same-origin" });
    let body = null;
    let parsed = false;
    try {
      body = await response.json();
      parsed = true;
    } catch {
      parsed = false;
    }
    return {
      status: response.status,
      ok: response.ok,
      parsed,
      contentType: response.headers.get("content-type"),
      body,
    };
  } catch (error) {
    return { status: 0, ok: false, parsed: false, contentType: null, body: null, networkError: String(error).slice(0, 200) };
  }
};

/**
 * The disclosure's own control, found by what it is rather than by what it says.
 *
 * This used to be a hard-coded `getByRole("button", { name: "查看预设装配", exact: true })`, which is
 * the product's copy spelled a second time here: a lane rewriting the catalogue to "查看预设" turned
 * this driver red for a change that broke nothing (measured r17: `the_settings_disclosure_offers_no_
 * readout_control`, while the product's own `preset-assembly-is-reached-through-settings.spec.ts`,
 * which reads `catalogue.presetsOpen`, stayed green). A label is the product's fact; this driver's
 * fact is that the disclosure LEADS SOMEWHERE.
 *
 * So the reading is the disclosure's own control count: exactly one enabled button, whichever words
 * it carries, and the words are reported beside it for a reader. A second control turns this red on
 * purpose - the driver would not know which one is the way in, and guessing is how a path gets a
 * green for pressing an import button.
 */
async function readoutControl(disclosure) {
  const buttons = disclosure.getByRole("button");
  const found = await buttons.count();
  if (found === 0)
    throw new Error(
      `the_settings_disclosure_offers_no_readout_control: ${DISCLOSURE_SELECTOR} carries no button at all, so the ` +
        `disclosure says something can be read and offers nothing that reads it`,
    );
  const names = [];
  for (let index = 0; index < found; index += 1) names.push((await buttons.nth(index).innerText()).trim());
  if (found > 1)
    throw new Error(
      `the_settings_disclosure_offers_no_readout_control: ${DISCLOSURE_SELECTOR} carries ${String(found)} controls ` +
        `(${JSON.stringify(names)}), and this driver cannot say which one opens the readout`,
    );
  const control = buttons.first();
  if (await control.isDisabled())
    throw new Error(
      `the_settings_disclosure_readout_control_is_disabled: ${JSON.stringify(names[0])} is the disclosure's only ` +
        `control and it cannot be pressed, so the readout is behind a control that does nothing`,
    );
  return { control, name: names[0] };
}

/**
 * Walk to the readout the way the product publishes the path, and say what each step found.
 *
 * Settings carries one disclosure for the readout and nothing else points at it, so every step here is
 * asserted: the Settings surface's own block is present, its fold really opened (a summary that missed
 * leaves the control behind a shut `<details>`, which is the same 30 s wait by another name), the one
 * control is there and pressable, and the readout mounted. A step that cannot be taken fails this
 * driver BY NAME instead of timing out on a selector the product no longer carries.
 */
async function openReadout(page) {
  const entered = await activateSurface(page, SETTINGS_LABEL);
  const disclosure = page.locator(DISCLOSURE_SELECTOR);
  if ((await disclosure.count()) === 0)
    throw new Error(
      `settings_carries_no_preset_disclosure: ${DISCLOSURE_SELECTOR} is not on the Settings surface (bar entry ` +
        `${JSON.stringify(SETTINGS_LABEL)} reached it as ${entered}), so the readout has no path this driver knows`,
    );
  if ((await disclosure.evaluate((node) => node.open)) !== true) await disclosure.locator("summary").click();
  if ((await disclosure.evaluate((node) => node.open)) !== true)
    throw new Error(
      `the_settings_disclosure_did_not_open: ${DISCLOSURE_SELECTOR} is still shut after pressing its summary, so ` +
        `its control is behind a fold - the readout is not reachable from this reading`,
    );
  const { control, name } = await readoutControl(disclosure);
  await control.click();
  const surface = page.locator('[data-testid="presets-surface"]');
  if ((await surface.count()) === 0)
    throw new Error(
      `the_readout_did_not_mount: pressing ${JSON.stringify(name)} left no ` +
        `[data-testid="presets-surface"] on the page`,
    );
  return { entered, disclosureOpen: true, control: name, back: BACK_SELECTOR };
}

/** The readout's own way out, pressed and read back: it returns to the surface that opened it. */
async function leaveReadout(page) {
  const back = page.locator(BACK_SELECTOR);
  if ((await back.count()) === 0)
    throw new Error(
      `the_readout_offers_no_way_back: no ${BACK_SELECTOR} control, and the surface it is reached from is Settings`,
    );
  await back.first().click();
  const settings = await page.locator('[data-testid="settings-surface"]').count();
  const readout = await page.locator('[data-testid="presets-surface"]').count();
  if (settings === 0 || readout !== 0)
    throw new Error(
      `the_readout's back control did not return to Settings: settings-surface present=${settings}, ` +
        `presets-surface still present=${readout}`,
    );
  return { returnedTo: "settings-surface", readoutClosed: readout === 0 };
}

/**
 * The readout's own settle, named so a failure says what it waited for.
 *
 * The panel publishes no `.loading-text` (its loading line is a plain `<p>`), so `waitForPanel` would read
 * the empty state as settled. The three markers below are the panel's own tombstones for "the read has
 * landed": a row, the read-failure line, or the empty line. A panel that reaches none of them fails this
 * driver by name instead of being read as a preset with nothing in it.
 */
async function waitForReadout(page, { name, timeoutMs = 20000, settleMs = 400 }) {
  const started = Date.now();
  let reading = { surfacePresent: false };
  for (;;) {
    reading = await page.evaluate(() => {
      const surface = document.querySelector('[data-testid="presets-surface"]');
      if (surface === null) return { surfacePresent: false };
      return {
        surfacePresent: true,
        rows: surface.querySelectorAll("[data-preset-assembly]").length,
        readFailed: surface.querySelector("[data-preset-read-failed]") !== null,
        none: surface.querySelector("[data-preset-none]") !== null,
      };
    });
    if (reading.surfacePresent && (reading.rows > 0 || reading.readFailed || reading.none))
      return { ...reading, waitedMs: Date.now() - started };
    if (Date.now() - started > timeoutMs)
      throw new Error(
        `preset_readout_never_settled:${name} after ${Date.now() - started}ms: waited for [data-testid="presets-surface"] to hold a ` +
          `[data-preset-assembly] row, its [data-preset-read-failed] line or its [data-preset-none] line; last reading ${JSON.stringify(reading)}`,
      );
    await page.waitForTimeout(settleMs);
  }
}

/**
 * Every SillyTavern preset document this checkout carries: a JSON document under the preset root with a
 * top-level `prompts` array is one, by shape and not by filename — so a preset added anywhere under the root
 * is in the next reading, and a document that loses the shape leaves the population with its name absent.
 */
function presetDocuments(root) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".json")) continue;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(full, "utf8"));
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.prompts)) continue;
      found.push({ path: full, relativePath: relative(REPO_ROOT, full).replace(/\\/gu, "/"), document: parsed });
    }
  };
  walk(root);
  return found;
}

/** Whether the checkout's own git index carries a document at HEAD, so a cross-revision comparison is visible. */
function trackedByGit(relativePath) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", relativePath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? "tracked" : "untracked_in_main_checkout";
}

/** The document side of the reconciliation: the facts the panel's claims are checked against, and the names it carries. */
function documentSide(document, relativePath, tracked) {
  const identifiers = document.prompts
    .map((prompt) => (prompt !== null && typeof prompt === "object" ? prompt.identifier : null))
    .filter((identifier) => typeof identifier === "string" && identifier.length > 0);
  const topLevelKeys = Object.keys(document);
  return {
    path: relativePath,
    tracked,
    name: typeof document.name === "string" ? document.name : null,
    prompts: document.prompts.length,
    promptOrder: Array.isArray(document.prompt_order) ? document.prompt_order.length : null,
    identifiers,
    topLevelKeys,
    // A marker is a prompt identifier or a top-level document key: the two places a name can be carried.
    carried: new Set([...identifiers, ...topLevelKeys]),
    samplingKeys: topLevelKeys.filter((key) => typeof document[key] === "number"),
  };
}

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("u-preset-assembly.txt");
  const observationFrom = await observationStart(page);
  await page.evaluate(`${PAGE_HELPERS};undefined`);

  // The panel's own read, as the wire saw it: every response on the readout's path, in arrival order.
  const wire = [];
  page.on("response", (response) => {
    try {
      const path = new URL(response.url()).pathname;
      if (path === READOUT_ROUTE) wire.push({ method: response.request().method(), path, status: response.status() });
    } catch {
      // A response whose URL does not parse is not this route.
    }
  });

  let checks = 0;
  let failed = 0;
  let unobserved = 0;
  const check = (name, outcome, detail) => {
    checks += 1;
    if (outcome === "fail") failed += 1;
    if (outcome === "unobserved") unobserved += 1;
    say(`ASSERT ${name}: ${outcome === "pass" ? "PASS" : outcome === "fail" ? "FAIL" : "UNOBSERVED"} — ${detail}`);
  };

  let population = null;
  const documents = () => {
    if (population === null) population = presetDocuments(PRESET_ROOT);
    return population;
  };
  /** The five facts, as read. A fact is observed when a row was painted: it then shows either values or its own "none" line. */
  const observed = new Set();

  const reconcile = (label, sample) => {
    say(`--- RECONCILIATION ${label} ---`);
    const carried = documents().map((entry) => documentSide(entry.document, entry.relativePath, trackedByGit(entry.relativePath)));
    say(
      `DOCUMENT POPULATION: ${carried.length} SillyTavern preset document(s) under ${relative(REPO_ROOT, PRESET_ROOT).replace(/\\/gu, "/")}: ${JSON.stringify(
        carried.map((entry) => ({ path: entry.path, name: entry.name, prompts: entry.prompts, tracked: entry.tracked })),
      )}`,
    );
    say(
      `PANEL: ${JSON.stringify({
        surfacePresent: sample.surfacePresent,
        heading: sample.heading,
        rows: sample.rows.length,
        readFailed: sample.readFailed,
        none: sample.none,
      })}`,
    );
    for (const row of sample.rows) say(`PANEL ROW: ${JSON.stringify({ ...row, box: row.box })}`);

    if (sample.rows.length === 0) {
      check(
        `entries-total[${label}]`,
        "fail",
        `the panel painted no [data-preset-assembly] row (it settled on ${JSON.stringify(sample.readFailed ?? sample.none)}), so ` +
          `there is no entry count to hold against the document's own prompts length — read this as "the assembled facts were not ` +
          `served", not as "the panel shows the wrong count": the panel is telling the truth about a read it could not complete`,
      );
      check(
        `unfilled-carried-by-document[${label}]`,
        "unobserved",
        "the panel named no unfilled marker, so \"every marker it calls unfilled is one the document carries\" holds over an " +
          "empty set and is not evidence of anything",
      );
      return;
    }
    for (const row of sample.rows) {
      // The document is the one the panel's own row names: a preset the panel did not name is a different preset.
      const matched = carried.find((entry) => entry.name !== null && entry.name === row.name) ?? null;
      if (matched === null) {
        check(
          `entries-total[${label}]`,
          "unobserved",
          `the panel's row names ${JSON.stringify(row.name)}, and no document under the preset root carries that name (population: ` +
            `${JSON.stringify(carried.map((entry) => entry.name))}), so there is nothing to hold its entry count against`,
        );
        check(
          `unfilled-carried-by-document[${label}]`,
          "unobserved",
          `the panel's row names ${JSON.stringify(row.name)} and no document under the preset root carries that name`,
        );
        continue;
      }
      say(
        `DOCUMENT MATCHED: ${JSON.stringify({
          path: matched.path,
          tracked: matched.tracked,
          name: matched.name,
          prompts: matched.prompts,
          promptOrder: matched.promptOrder,
          identifiers: matched.identifiers,
          topLevelKeys: matched.topLevelKeys,
          // The numeric top-level keys the document carries: the sampler settings it wrote itself.
          samplingKeys: matched.samplingKeys,
        })}`,
      );
      if (row.entries === null) {
        check(
          `entries-total[${label}]`,
          "fail",
          `the row's entries line ${JSON.stringify(row.entriesLine)} does not carry three counts, so the panel states no entry count ` +
            `to hold against the document's ${matched.prompts} prompts`,
        );
      } else {
        check(
          `entries-total[${label}]`,
          row.entries.total === matched.prompts ? "pass" : "fail",
          `the panel's entries line ${JSON.stringify(row.entriesLine)} reads total=${row.entries.total}; the document ` +
            `${matched.path} carries ${matched.prompts} prompts${row.entries.total === matched.prompts ? "" : " — the count the player reads is not the document's own entry count"}`,
        );
      }
      const notCarried = row.unfilled.filter((marker) => !matched.carried.has(marker));
      check(
        `unfilled-carried-by-document[${label}]`,
        notCarried.length === 0 ? "pass" : "fail",
        notCarried.length === 0
          ? `the panel names ${row.unfilled.length} unfilled marker(s) ${JSON.stringify(row.unfilled)}, and ${matched.path} carries every one of them`
          : `the panel calls ${JSON.stringify(notCarried)} unfilled, and ${matched.path} carries no prompt identifier or top-level key ` +
              `of that name — a marker the document does not hold cannot be a slot it left blank`,
      );
    }
  };

  // ── The surface at both widths: what the panel painted, and the document beside it ──
  let readout = null;
  for (const size of WIDTHS) {
    await page.setViewportSize({ width: size.w, height: size.h });
    await page.waitForTimeout(800);
    say(`===== PRESET SURFACE @${size.tag} =====`);
    const walked = await openReadout(page);
    say(
      `the readout reached the way the product publishes it: ${JSON.stringify(SETTINGS_LABEL)} (bar entry reached it as ` +
        `${walked.entered}) -> ${DISCLOSURE_SELECTOR} opened -> ${JSON.stringify(walked.control)} (the product's copy, ` +
        `reported rather than spelled by this driver)`,
    );
    const settled = await waitForReadout(page, { name: `@${size.tag}` });
    say(`the panel's own settle: ${JSON.stringify(settled)}`);
    readout = await page.evaluate(readReadout);
    if (readout.rows.length > 0) for (const fact of FACTS) observed.add(fact);
    say(`the readout: ${JSON.stringify(readout, null, 1)}`);
    if (readout.rows.length === 0) {
      say(
        `the panel's read-only hint: ${JSON.stringify(readout.readOnlyHint)} — present, so the surface itself mounted; what it has no ` +
          `value for is the assembly behind it`,
      );
    } else {
      for (const row of readout.rows) {
        say(`--- ${row.presetId} — "${row.name}" ---`);
        say(`entries: ${JSON.stringify({ line: row.entriesLine, counts: row.entries })}`);
        say(
          `switched off: ${JSON.stringify({ listed: row.disabled, saysNone: row.disabledSaysNone })}`,
        );
        say(`unfilled markers: ${JSON.stringify({ named: row.unfilled, saysNone: row.unfilledSaysNone })}`);
        say(
          `macros this product cannot evaluate: ${JSON.stringify({
            found: row.macros.map((macro) => ({ code: macro.code, entries: macro.entries })),
            saysNone: row.macrosSaysNone,
          })}`,
        );
        say(
          `depth injection: ${JSON.stringify({
            line: row.depthLine,
            count: row.depthDigits[0] ?? null,
            depthsInLine: row.depthDigits.slice(1),
            blocks: row.depthBlocks.map((block) => ({ identifier: block.identifier, depth: block.depth })),
            saysNone: row.depthSaysNone,
          })}`,
        );
        say(
          `sampling in force, one row per key (key = value (source)): ${JSON.stringify(
            row.sampling.map((entry) => ({ key: entry.key, value: entry.value, source: entry.source, text: entry.text })),
          )}`,
        );
      }
    }
    reconcile(`@${size.tag}`, readout);
    await shot(page, `92-preset-assembly-${size.tag}.png`);
    await shot(page, `92-preset-assembly-${size.tag}-full.png`, { fullPage: true });
    say(`the readout's own way back @${size.tag}: ${JSON.stringify(await leaveReadout(page))}`);
  }

  // ── The Host's own answer for the same moment, through the route the panel reads ──
  say("===== THE ROUTE THE PANEL READS =====");
  const host = await page.evaluate(readHostReadout, READOUT_ROUTE);
  const body = host.body;
  const bounded = (value) => {
    const text = JSON.stringify(value);
    return text !== undefined && text.length > 1200 ? `${text.slice(0, 1200)}… (${text.length} chars)` : (value ?? null);
  };
  say(
    `GET ${READOUT_ROUTE} from the page: ${JSON.stringify({
      status: host.status,
      ok: host.ok,
      parsed: host.parsed,
      contentType: host.contentType,
      networkError: host.networkError ?? null,
    })}`,
  );
  say(
    `its body: ${
      host.parsed && body !== null && typeof body === "object" && Array.isArray(body.presets)
        ? JSON.stringify({
            apiVersion: body.apiVersion ?? null,
            presets: body.presets.length,
            presetIds: body.presets.map((preset) => preset?.presetId ?? null),
          })
        : bounded(host.parsed ? body : null)
    }`,
  );
  say(`the wire the panel's own read produced: ${JSON.stringify(wire)}`);
  if (wire.length === 0)
    say(
      "the page recorded no response on the readout's path: the panel's fetch either never went out or answered off the wire this " +
        "listener sees — a fact, not a zero",
    );

  // ── The facts this driver could not read, each by name ──
  say("===== WHAT THIS DRIVER COULD NOT OBSERVE =====");
  const absence = () => {
    if (readout.rows.length > 0) return null;
    if (readout.readFailed !== null)
      return `the panel settled on its read-failure line ${JSON.stringify(readout.readFailed)} and the Host answered ${host.status} to ${READOUT_ROUTE}, so no assembly was painted and this fact had no value to read`;
    if (readout.none !== null)
      return `the Host served an empty preset list, so the panel says ${JSON.stringify(readout.none)}: nothing was imported into this run's store (or the readout emptied it), so no assembly has this fact`;
    return "the panel painted neither a row, its read-failure line nor its empty line";
  };
  const missing = FACTS.filter((fact) => !observed.has(fact));
  for (const fact of missing) say(`unobserved:${fact}: ${absence()}`);
  if (missing.length === 0) say(`unobserved:none: every one of the five facts was painted by the panel and read above`);
  say(
    "unobserved:the-request-the-values-become: this driver reads the panel, not the provider request — whether the sampling values and " +
      "entry order the panel shows are the ones the runtime sends is the INJECTION section's reading (the run's wire-requests file), " +
      "not this driver's",
  );
  say(
    "unobserved:why-a-slot-was-unfilled: the assembly's `markers` input is the caller's (the companion card and the bound world book), so " +
      "this driver can read that a marker has no content source but not which caller decided it",
  );

  say(reconciliationVerdict({ assertions: checks, failures: failed, unobserved }));
  await observe(page, say, "u", { sinceMs: observationFrom });
  flush();
  await browser.close().catch(() => undefined);
  say("DONE-U");
})().catch((error) => {
  console.log("DRIVER U FAILED:", String(error).slice(0, 800));
  process.exit(1);
});
