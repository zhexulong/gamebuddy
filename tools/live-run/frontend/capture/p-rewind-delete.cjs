// Driver P: the rewind and the delete (brief item 4).
//
// Both are destructive and both follow the product's arm-then-confirm shape, so each is captured in
// three states: the control as it stands, the arm with its own prompt, and the transcript afterwards
// — the DOM the player reads AND the Host's own projection, because "the transcript afterwards" is a
// claim about durable rows: which handles survived, which left, and in what order.
//
// A rewind is only offered on a companion row that is not the greeting, and it removes that row and
// everything after it; a delete is offered on every row but the greeting and removes exactly one,
// leaving the rest of the conversation in place. So the driver first makes sure the open conversation
// is long enough to carry both (two exchanges), gated on the provider credential exactly as driver F
// gates its own turn (`GB_SHOTS_CREDENTIAL_PRESENT`).
//
// BOTH ACTIONS LIVE IN THE ROW'S OVERFLOW NOW. `45889e97` moved the rewind, the fork and the delete off
// the strip and into the panel `[data-testid="message-more"]` opens - `MessageBubble.tsx` renders
// `message-more-menu` only under `moreOpen`, so `message-rewind` and `message-delete` are not in the DOM
// of a collapsed row at all. Read the run of 2026-11-15 (pin 3625acb4): this driver printed
//
//     rows carrying a rewind control: []
//     rows carrying a delete control: []
//     delete: no_delete_control_in_any_row
//     rewind: no_rewind_control_in_any_row
//
// and exited 0 - a green that measured nothing, which is the shape this driver exists to prevent. So the
// census below OPENS each row's overflow, asserts it opened, reads the three entries out of the panel and
// closes it again, and each press opens the overflow of the row it is about to press.
const { connect, reporter, PAGE_HELPERS, activateSurface, shot, readDurableTranscript, canStartTurn, observe, observationStart, conversationShown } = require("./common.cjs");
const { continuityLine } = require("./capability.cjs");

const CREDENTIAL_PRESENT = process.env.GB_SHOTS_CREDENTIAL_PRESENT === "1";

const rowFacts = () =>
  [...document.querySelectorAll(".message-list > li.message")].map((row, index) => {
    const button = (selector) => {
      const node = row.querySelector(selector);
      if (node === null) return null;
      const r = node.getBoundingClientRect();
      return {
        name: (node.getAttribute("aria-label") ?? node.innerText ?? "").trim(),
        disabled: node.disabled,
        box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      };
    };
    const strip = row.querySelector(".message-actions");
    return {
      index,
      role: row.className.includes("player") ? "player" : "companion",
      handle: row.getAttribute("data-handle"),
      text: (row.querySelector(".message-bubble")?.innerText ?? "").trim(),
      // The overflow's own trigger, and whether its panel is open: the three destructive entries are
      // inside that panel, so this is what says whether the row has them to read.
      more: button('[data-testid="message-more"]'),
      overflowOpen: row.querySelector('[data-testid="message-more"]')?.getAttribute("aria-expanded") ?? null,
      overflowEntries: row.querySelector('[data-testid="message-more-menu"]') === null ? 0 : row.querySelectorAll('[data-testid="message-more-menu"] > button').length,
      rewind: button('[data-testid="message-rewind"]'),
      delete: button('[data-testid="message-delete"]'),
      edit: button('[data-testid="message-edit"]'),
      stripBox: strip === null ? null : (() => {
        const r = strip.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      })(),
      stripButtons: strip === null ? 0 : strip.querySelectorAll("button").length,
    };
  });

const confirmFacts = (testid) => {
  const block = document.querySelector(`[data-testid="${testid}"]`);
  if (block === null) return { present: false };
  const rect = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const yes = block.querySelector(`[data-testid="${testid}-yes"]`);
  const no = block.querySelector(`[data-testid="${testid}-no"]`);
  const row = block.closest("li.message");
  return {
    present: true,
    prompt: (block.querySelector('[role="status"]')?.textContent ?? "").trim(),
    box: rect(block),
    yes: { text: (yes?.textContent ?? "").trim(), ariaLabel: yes?.getAttribute("aria-label") ?? null, box: rect(yes) },
    no: { text: (no?.textContent ?? "").trim(), ariaLabel: no?.getAttribute("aria-label") ?? null, box: rect(no) },
    rowHeightWhileArmed: row === null ? null : Math.round(row.getBoundingClientRect().height),
    otherControlsInTheRowWhileArmed: row === null ? null : row.querySelectorAll(".message-actions > button").length,
  };
};

/**
 * A row's overflow, OPENED — and read back, so the opening is a fact and not a press.
 *
 * The rewind, the fork and the delete are children of `message-more-menu`, which the product renders
 * only while the trigger's own `moreOpen` is true. A click on `message-rewind` in a collapsed row
 * therefore waits on an element that does not exist, and a READING of it silently reports "this row
 * offers no rewind" — which is what the run of 2026-11-15 recorded for every row. So the trigger is
 * pressed here and the panel's presence is asserted; the entries are then read off that panel.
 */
async function openOverflow(page, index) {
  const row = page.locator(".message-list > li.message").nth(index);
  const trigger = row.locator('[data-testid="message-more"]');
  if ((await trigger.count()) === 0)
    throw new Error(
      `row ${index} offers no overflow trigger ([data-testid="message-more"]), so the rewind, the fork and the ` +
        `delete this driver presses are unreachable there`,
    );
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  const expanded = await trigger.getAttribute("aria-expanded");
  const panel = await row.locator('[data-testid="message-more-menu"]').count();
  if (expanded !== "true" || panel === 0)
    throw new Error(
      `the overflow on row ${index} did not open (aria-expanded=${JSON.stringify(expanded)}, panel present=${panel}), ` +
        `so its entries are behind a press that missed`,
    );
  return row;
}

/** The overflow, closed again: the census and the reading leave the rows as it found them. */
async function closeOverflow(page, index) {
  const trigger = page.locator(".message-list > li.message").nth(index).locator('[data-testid="message-more"]');
  if ((await trigger.count()) > 0 && (await trigger.getAttribute("aria-expanded")) === "true") await trigger.click();
}

/**
 * The transcript's own actions, read out of the overflow each one lives in.
 *
 * One row at a time, because the panel is a single out-of-flow child of the row that opened it: opening
 * row i, reading its three entries and closing it again is the only way to say WHICH row carries a
 * rewind without guessing at a control that is not in the DOM.
 */
async function overflowCensus(page, rows) {
  const census = [];
  for (const row of rows) {
    const facts = {
      index: row.index,
      role: row.role,
      handle: row.handle,
      more: row.more !== null,
      rewind: null,
      fork: null,
      delete: null,
    };
    if (facts.more) {
      await openOverflow(page, row.index);
      const panel = await page.evaluate(() => {
        const open = document.querySelector('.message-list > li.message [data-testid="message-more-menu"]');
        if (open === null) return null;
        const control = (selector) => {
          const node = open.querySelector(selector);
          return node === null ? null : { name: (node.getAttribute("aria-label") ?? node.innerText ?? "").trim() };
        };
        return {
          rewind: control('[data-testid="message-rewind"]'),
          fork: control('[data-testid="message-fork"]'),
          delete: control('[data-testid="message-delete"]'),
          entries: open.querySelectorAll("button").length,
        };
      });
      if (panel === null)
        throw new Error(`row ${row.index} opened its overflow and the panel [data-testid="message-more-menu"] was not there`);
      Object.assign(facts, panel);
      await closeOverflow(page, row.index);
    }
    census.push(facts);
  }
  return census;
}

const composerState = () => ({
  running: document.querySelector(".composer-button.stop-button, .composer-button.composer-busy") !== null,
  optimistic: document.querySelector('[data-testid="optimistic-player-message"]') !== null,
  streaming: document.querySelectorAll(".message-list > li.message[data-streaming]").length,
  players: document.querySelectorAll(".message-list > li.message.player").length,
});

/**
 * Wait until the shell is SHOWING the conversation and its composer is mounted, then until the send
 * control is pressable with the draft this driver typed.
 *
 * `activateSurface` presses the bar entry and returns; a conversation that is mounted but parked
 * (`.surface-slot-parked`) still answers every `page.evaluate` read of its rows and of its textarea, so
 * a driver that only READS can be wrong about which surface the player is on. Playwright cannot be
 * wrong about it: a parked `.composer-button.send-button` is invisible, and `click()` then waits its
 * own 30 s and fails with `TimeoutError: locator.click: Timeout 30000ms exceeded` - a message that says
 * nothing about which surface the shell was on or whether a turn was in flight (measured r17).
 *
 * The two phases are separate because the control really is disabled while the draft is empty
 * (`Composer.tsx`: `disabled={sendRefused(...) || !value.trim()}`), so "pressable" before typing is a
 * question nobody asked. The state that blocks the press is carried into the failure by name.
 */
async function waitForComposer(page, timeoutMs = 20000) {
  const started = Date.now();
  let last = null;
  for (;;) {
    const shown = await page.evaluate(conversationShown);
    last = await page.evaluate(() => {
      const send = document.querySelector(".composer-button.send-button");
      const area = document.querySelector(".composer-textarea");
      return {
        send: send === null ? "absent" : send.disabled ? "disabled" : "pressable",
        stop: document.querySelector(".composer-button.stop-button, .composer-button.composer-busy") !== null,
        textarea: area !== null,
      };
    });
    const composer = { ...last, shown };
    if (composer.shown && composer.textarea && composer.send !== "absent")
      return { ready: true, waitedMs: Date.now() - started, state: composer };
    if (Date.now() - started > timeoutMs) return { ready: false, waitedMs: Date.now() - started, state: composer };
    await page.waitForTimeout(250);
  }
}

/** The draft is in the textarea, so the send control leaves `disabled`; this is that moment. */
async function waitForSendEnabled(page, timeoutMs = 10000) {
  const started = Date.now();
  let state = null;
  for (;;) {
    state = await page.evaluate(() => {
      const send = document.querySelector(".composer-button.send-button");
      const area = document.querySelector(".composer-textarea");
      return { send: send === null ? "absent" : send.disabled ? "disabled" : "pressable", draft: area === null ? null : area.value.length };
    });
    if (state.send === "pressable") return { ready: true, waitedMs: Date.now() - started, state };
    if (Date.now() - started > timeoutMs) return { ready: false, waitedMs: Date.now() - started, state };
    await page.waitForTimeout(200);
  }
}

async function sendAndSettle(page, text) {
  const composer = await waitForComposer(page);
  if (!composer.ready)
    throw new Error(
      `composer_not_on_screen: after ${String(composer.waitedMs)}ms the shell was not showing a mounted composer ` +
        `(${JSON.stringify(composer.state)}); a parked conversation answers every read and cannot be typed into`,
    );
  await page.evaluate((line) => {
    const area = document.querySelector(".composer-textarea");
    if (area === null) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(area, line);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
  const enabled = await waitForSendEnabled(page);
  if (!enabled.ready)
    throw new Error(
      `send_control_never_became_pressable: after ${String(enabled.waitedMs)}ms the send control still read ` +
        `${JSON.stringify(enabled.state)} with the draft typed, so the composer refused the turn`,
    );
  await page.locator(".composer-button.send-button").click({ timeout: 15000 });
  const before = await page.evaluate(() => document.querySelectorAll(".message-list > li.message.companion:not([data-streaming])").length);
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await page.waitForTimeout(2000);
    const state = await page.evaluate(composerState);
    if (!state.running && state.optimistic === false && state.streaming === 0 && state.players > 0) {
      const companions = await page.evaluate(() => document.querySelectorAll(".message-list > li.message.companion:not([data-streaming])").length);
      if (companions > before) return state;
    }
  }
  return null;
}

const durableRows = async (page) => {
  const durable = await readDurableTranscript(page);
  return {
    ok: durable.ok === true,
    rows: (durable.transcript ?? []).map((message) => ({
      order: message.order,
      role: message.role,
      handle: message.handle,
      text: message.text,
    })),
  };
};

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("p-rewind-delete.txt");
  const observationFrom = await observationStart(page);
  // Both mutations are refused-or-applied silently: the shell re-reads on a refusal and only commits
  // a problem view when that re-read ALSO fails, so the wire is where the reason lives. Every refused
  // API call the page makes, with the status and the Host's own bounded code.
  const refusals = [];
  page.on("response", async (response) => {
    if (response.status() < 400 || !response.url().includes("/api/")) return;
    let body = null;
    try {
      body = (await response.text()).slice(0, 200);
    } catch {
      body = null;
    }
    refusals.push({
      status: response.status(),
      method: response.request().method(),
      route: response.url().split("/api")[1],
      sent: (response.request().postData() ?? "").slice(0, 200),
      body,
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(`${PAGE_HELPERS};undefined`);
  await activateSurface(page, "聊天");
  await page.waitForTimeout(1800);

  say(`credential present (present|absent only): ${CREDENTIAL_PRESENT ? "present" : "absent"}`);

  let rows = await page.evaluate(rowFacts);
  if (rows.filter((row) => row.role === "player").length < 2) {
    const turnGate = await canStartTurn(page);
      if (!CREDENTIAL_PRESENT || !turnGate.ok) {
      say(`SKIPPED:no_turn_possible (${turnGate.ok ? "no provider credential" : turnGate.reason}) - two exchanges are needed and this mount cannot start one`);
      say(`the surface's own sentence: ${turnGate.sentence ?? "(none)"}`);
      await browser.close().catch(() => undefined);
      say("DONE-O");
      process.exit(0);
    }
    say(`exchanges before: player rows=${rows.filter((row) => row.role === "player").length}; one more turn is sent so both controls have a point`);
    const settled = await sendAndSettle(page, "再说一句。");
    say(`turn settled: ${settled !== null} ${JSON.stringify(settled)}`);
    await page.waitForTimeout(1500);
    rows = await page.evaluate(rowFacts);
  }

  say("=== ITEM: the conversation the two controls act on ===");
  say(JSON.stringify(rows, null, 1));
  const durableBefore = await durableRows(page);
  say(`durable rows before: ${JSON.stringify(durableBefore.rows.map((row) => ({ order: row.order, role: row.role, text: row.text.slice(0, 14) })))}`);
  /*
   * The transcript these two destructive controls act on, as a sequence of durable snapshots.
   *
   * Each step declares what it is SUPPOSED to remove, so `continuityLine` can tell a removal the player
   * asked for from a row that simply went missing - which is the only way this driver's "every other row
   * is still there, in the same order" line can be a finding instead of a sentence it prints either way.
   */
  const durableSteps = [{ label: "before either control", rows: durableBefore.rows }];
  await shot(page, "87-controls-in-the-strip-1440x900.png");

  // What each row carries, read through the overflow each entry lives in (see `overflowCensus`).
  const census = await overflowCensus(page, rows);
  const deletable = census.find((row) => row.delete !== null) ?? null;
  say(`rows carrying an overflow trigger: ${JSON.stringify(census.filter((row) => row.more).map((row) => row.index))}`);
  say(`rows carrying a rewind control: ${JSON.stringify(census.filter((row) => row.rewind !== null).map((row) => ({ index: row.index, ariaLabel: row.rewind.name })))}`);
  say(`rows carrying a fork control: ${JSON.stringify(census.filter((row) => row.fork !== null).map((row) => row.index))}`);
  say(`rows carrying a delete control: ${JSON.stringify(census.filter((row) => row.delete !== null).map((row) => row.index))}`);
  say(`entries inside each row's overflow: ${JSON.stringify(census.map((row) => ({ index: row.index, entries: row.entries ?? 0 })))}`);
  // Owner's ruling 2, second half: on the LAST message the rewind and the delete are the same act, so
  // that row offers the delete alone. The fact is read out of that row's own overflow, not assumed.
  const lastRow = census.length === 0 ? null : census[census.length - 1];
  const lastRowStrip = rows[rows.length - 1] ?? null;
  say(
    `the transcript's own last row (index ${lastRow?.index}): role=${lastRow?.role} rewind=${JSON.stringify(lastRow?.rewind?.name ?? null)} delete=${JSON.stringify(lastRow?.delete?.name ?? null)} fork=${JSON.stringify(lastRow?.fork?.name ?? null)} edit=${JSON.stringify(lastRowStrip?.edit?.name ?? null)}`,
  );
  say(
    `the last row offers the delete alone (no rewind there): ${lastRow !== null && lastRow.delete !== null && lastRow.rewind === null}`,
  );

  // ---- DELETE: one row out of the middle ----
  say("=== ITEM: the delete — armed, then confirmed ===");
  let deleteOutcome = "could_not_drive";
  // The rows' own actions AFTER the delete, out of the overflows: what the next item may press is a fact
  // about the transcript that is there now, not about the one this item acted on.
  let censusAfterDelete = null;
  if (deletable === null) {
    deleteOutcome = "no_delete_control_in_any_row";
  } else {
    // `45889e97` put the rewind and the delete in the same overflow, and owner ruling 2 leaves the LAST
    // row with the delete alone - so in a transcript as short as this one the first player row is both
    // the only rewindable row and the first deletable one. Deleting it left the rewind item with nothing
    // to press (`rewind: no_rewind_control_in_any_row`, rows 3->2, guarded session of 2026-11-15). The
    // delete is the smaller act of the two, so it yields: it takes a row that leaves at least one
    // rewindable row behind. When no such row exists the choice falls back to any deletable one, and the
    // rewind item says by name that it could not be driven.
    const rewindableHandles = new Set(census.filter((row) => row.rewind !== null).map((row) => row.handle));
    const keepsARewind =
      rewindableHandles.size === 0
        ? () => true
        : (row) => rewindableHandles.size > 1 || !rewindableHandles.has(row.handle);
    const targetRow =
      census.find((row) => row.delete !== null && row.role === "player" && keepsARewind(row)) ??
      census.find((row) => row.delete !== null && keepsARewind(row)) ??
      deletable;
    const targetIndex = rows.findIndex((row) => row.handle === targetRow.handle);
    say(
      `deleting row index=${targetIndex} role=${targetRow.role} (${JSON.stringify((rows[targetIndex]?.text ?? "").slice(0, 24))}), handle=${JSON.stringify(targetRow.handle)}; ` +
        `it is ${keepsARewind(targetRow) ? "not " : ""}the only row a rewind is offered on`,
    );
    const row = await openOverflow(page, targetIndex);
    await row.locator('[data-testid="message-delete"]').click();
    await page.waitForTimeout(700);
    const armed = await page.evaluate(confirmFacts, "message-delete-confirm");
    say(JSON.stringify(armed, null, 1));
    say(
      `the delete confirmation's own words: prompt=${JSON.stringify(armed.prompt)} confirm=${JSON.stringify(armed.yes.text)} cancel=${JSON.stringify(armed.no.text)}`,
    );
    say(`the armed confirmation is the row's only control (buttons beside it: ${armed.otherControlsInTheRowWhileArmed})`);
    await shot(page, "87-delete-armed-1440x900.png");

    await page.locator('[data-testid="message-delete-confirm-no"]').first().click();
    await page.waitForTimeout(700);
    const afterCancel = await page.evaluate(rowFacts);
    say(`cancelling the arm leaves the row as it was: ${afterCancel.length === rows.length && (await page.evaluate(() => document.querySelector('[data-testid="message-delete-confirm"]') === null))}`);

    await openOverflow(page, targetIndex);
    await row.locator('[data-testid="message-delete"]').click();
    await page.waitForTimeout(700);
    await page.locator('[data-testid="message-delete-confirm-yes"]').first().click();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await page.waitForTimeout(1200);
      const now = await page.evaluate(rowFacts);
      if (now.length === rows.length - 1) break;
    }
    const afterDelete = await page.evaluate(rowFacts);
    const durableAfterDelete = await durableRows(page);
    say("=== ITEM: the transcript after the delete ===");
    say(`refused API calls while the delete was out: ${JSON.stringify(refusals.splice(0))}`);
    say(JSON.stringify(afterDelete, null, 1));
    say(`rows before=${rows.length} after=${afterDelete.length}`);
    censusAfterDelete = await overflowCensus(page, afterDelete);
    say(
      `rows still carrying a rewind control after the delete: ${JSON.stringify(
        censusAfterDelete.filter((entry) => entry.rewind !== null).map((entry) => entry.index),
      )}`,
    );
    say(`the deleted handle is gone from the Host's own rows: ${durableBefore.rows.some((row) => row.handle === targetRow.handle) && !durableAfterDelete.rows.some((row) => row.handle === targetRow.handle)}`);
    say(`every other row is still there, in the same order: ${JSON.stringify(durableAfterDelete.rows.map((row) => ({ order: row.order, role: row.role, text: row.text.slice(0, 14) })))}`);
    say(`durable rows after: [${durableAfterDelete.rows.map((row) => `${row.order}:${row.role}`).join(", ")}]`);
    durableSteps.push({
      label: "after the delete",
      rows: durableAfterDelete.rows,
      removedHandles: [targetRow.handle],
    });
    await shot(page, "87-after-delete-1440x900.png");
    await page.setViewportSize({ width: 400, height: 800 });
    await page.waitForTimeout(1200);
    await shot(page, "87-after-delete-400x800.png");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(900);
    deleteOutcome = `removed=${targetRow.handle !== null}; rows ${rows.length}->${afterDelete.length}`;
    rows = afterDelete;
  }
  say(`delete: ${deleteOutcome}`);

  // ---- REWIND: the conversation cut back to an earlier point ----
  say("=== ITEM: the rewind — armed, then confirmed ===");
  // The delete above took one row out, so the indices this item acts on are re-read from the transcript
  // that is there now - and read through the overflows again, because a row's entries are behind them.
  const rewindableNow = (censusAfterDelete ?? (await overflowCensus(page, rows))).find((row) => row.rewind !== null) ?? null;
  let rewindOutcome = "could_not_drive";
  if (rewindableNow === null) {
    rewindOutcome = "no_rewind_control_in_any_row";
  } else {
    const targetIndex = rows.findIndex((row) => row.handle === rewindableNow.handle);
    const row = await openOverflow(page, targetIndex);
    say(`rewinding to row index=${targetIndex} handle=${JSON.stringify(rewindableNow.handle)}; its own label says: ${JSON.stringify(rewindableNow.rewind.name)}`);
    await row.locator('[data-testid="message-rewind"]').click();
    await page.waitForTimeout(700);
    const armed = await page.evaluate(confirmFacts, "message-rewind-confirm");
    say(JSON.stringify(armed, null, 1));
    say(
      `the rewind confirmation's own words: prompt=${JSON.stringify(armed.prompt)} confirm=${JSON.stringify(armed.yes.text)} cancel=${JSON.stringify(armed.no.text)}`,
    );
    say(`the rewind control's accessible name says what it removes: ${JSON.stringify(rewindableNow.rewind.name)}`);
    say(`the armed confirmation is the row's only control (buttons beside it: ${armed.otherControlsInTheRowWhileArmed})`);
    await shot(page, "87-rewind-armed-1440x900.png");

    await page.locator('[data-testid="message-rewind-confirm-no"]').first().click();
    await page.waitForTimeout(700);
    const cancelled = await page.evaluate(() => ({
      confirmGone: document.querySelector('[data-testid="message-rewind-confirm"]') === null,
      controlsBack: document.querySelectorAll(".message-list > li.message .message-actions > button").length,
    }));
    say(`cancelling the arm: ${JSON.stringify(cancelled)}`);

    await openOverflow(page, targetIndex);
    await row.locator('[data-testid="message-rewind"]').click();
    await page.waitForTimeout(700);
    await page.locator('[data-testid="message-rewind-confirm-yes"]').first().click();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await page.waitForTimeout(1200);
      const now = await page.evaluate(rowFacts);
      if (now.length < rows.length) break;
    }
    const afterRewind = await page.evaluate(rowFacts);
    const durableAfterRewind = await durableRows(page);
    say("=== ITEM: the transcript after the rewind ===");
    say(`refused API calls while the rewind was out: ${JSON.stringify(refusals.splice(0))}`);
    say(JSON.stringify(afterRewind, null, 1));
    say(`rows before=${rows.length} after=${afterRewind.length}`);
    say(`durable rows after: ${JSON.stringify(durableAfterRewind.rows.map((row) => ({ order: row.order, role: row.role, text: row.text.slice(0, 14) })))}`);
    say(`the reply the rewind was taken on survives, and everything after it is gone: ${afterRewind.some((row) => row.handle === rewindableNow.handle)}`);
    const beforeTheRewind = durableSteps[durableSteps.length - 1].rows;
    const rewindTargetIndex = beforeTheRewind.findIndex((row) => row.handle === rewindableNow.handle);
    durableSteps.push({
      label: "after the rewind",
      rows: durableAfterRewind.rows,
      removedHandles: rewindTargetIndex < 0 ? [] : beforeTheRewind.slice(rewindTargetIndex + 1).map((row) => row.handle),
    });
    await shot(page, "87-after-rewind-1440x900.png");
    await page.setViewportSize({ width: 400, height: 800 });
    await page.waitForTimeout(1200);
    await shot(page, "87-after-rewind-400x800.png");
    rewindOutcome = `rows ${rows.length}->${afterRewind.length}`;
  }
  say(`rewind: ${rewindOutcome}`);

  say(
    `CAPABILITY continuity: ${continuityLine("the rows these two controls left", durableSteps)}`,
  );
  await observe(page, say, "p", { sinceMs: observationFrom });
  flush();
  await browser.close().catch(() => undefined);
  say("DONE-P");
})().catch((error) => {
  console.log("DRIVER P FAILED:", String(error).slice(0, 900));
  process.exit(1);
});
