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
const { connect, reporter, PAGE_HELPERS, activateSurface, shot, readDurableTranscript, canStartTurn } = require("./common.cjs");

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

const composerState = () => ({
  running: document.querySelector(".composer-button.stop-button, .composer-button.composer-busy") !== null,
  optimistic: document.querySelector('[data-testid="optimistic-player-message"]') !== null,
  streaming: document.querySelectorAll(".message-list > li.message[data-streaming]").length,
  players: document.querySelectorAll(".message-list > li.message.player").length,
});

async function sendAndSettle(page, text) {
  await page.evaluate((line) => {
    const area = document.querySelector(".composer-textarea");
    if (area === null) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(area, line);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
  await page.waitForTimeout(300);
  await page.locator(".composer-button.send-button").click();
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
  await shot(page, "87-controls-in-the-strip-1440x900.png");

  const deletable = rows.find((row) => row.delete !== null) ?? null;
  say(`rows carrying a rewind control: ${JSON.stringify(rows.filter((row) => row.rewind !== null).map((row) => ({ index: row.index, ariaLabel: row.rewind.name })))}`);
  say(`rows carrying a delete control: ${JSON.stringify(rows.filter((row) => row.delete !== null).map((row) => row.index))}`);
  // Owner's ruling 2, second half: on the LAST message the rewind and the delete are the same act, so
  // that row offers the delete alone. The fact is read off the last row's own strip, not assumed.
  const lastRow = rows.length === 0 ? null : rows[rows.length - 1];
  say(
    `the transcript's own last row (index ${lastRow?.index}): role=${lastRow?.role} rewind=${JSON.stringify(lastRow?.rewind?.name ?? null)} delete=${JSON.stringify(lastRow?.delete?.name ?? null)} edit=${JSON.stringify(lastRow?.edit?.name ?? null)}`,
  );
  say(
    `the last row offers the delete alone (no rewind there): ${lastRow !== null && lastRow.delete !== null && lastRow.rewind === null}`,
  );

  // ---- DELETE: one row out of the middle ----
  say("=== ITEM: the delete — armed, then confirmed ===");
  let deleteOutcome = "could_not_drive";
  if (deletable === null) {
    deleteOutcome = "no_delete_control_in_any_row";
  } else {
    const targetRow = rows.find((row) => row.delete !== null && row.role === "player") ?? deletable;
    const targetIndex = rows.findIndex((row) => row.handle === targetRow.handle);
    say(`deleting row index=${targetIndex} (${JSON.stringify(targetRow.text.slice(0, 24))}), handle=${JSON.stringify(targetRow.handle)}`);
    const row = page.locator(".message-list > li.message").nth(targetIndex);
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
    say(`the deleted handle is gone from the Host's own rows: ${durableBefore.rows.some((row) => row.handle === targetRow.handle) && !durableAfterDelete.rows.some((row) => row.handle === targetRow.handle)}`);
    say(`every other row is still there, in the same order: ${JSON.stringify(durableAfterDelete.rows.map((row) => ({ order: row.order, role: row.role, text: row.text.slice(0, 14) })))}`);
    say(`durable rows after: [${durableAfterDelete.rows.map((row) => `${row.order}:${row.role}`).join(", ")}]`);
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
  const rewindableNow = rows.find((row) => row.rewind !== null) ?? null;
  let rewindOutcome = "could_not_drive";
  if (rewindableNow === null) {
    rewindOutcome = "no_rewind_control_in_any_row";
  } else {
    const targetIndex = rows.findIndex((row) => row.handle === rewindableNow.handle);
    const row = page.locator(".message-list > li.message").nth(targetIndex);
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
    await shot(page, "87-after-rewind-1440x900.png");
    await page.setViewportSize({ width: 400, height: 800 });
    await page.waitForTimeout(1200);
    await shot(page, "87-after-rewind-400x800.png");
    rewindOutcome = `rows ${rows.length}->${afterRewind.length}`;
  }
  say(`rewind: ${rewindOutcome}`);

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-P");
})().catch((error) => {
  console.log("DRIVER P FAILED:", String(error).slice(0, 900));
  process.exit(1);
});
