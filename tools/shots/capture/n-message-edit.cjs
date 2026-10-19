// Driver N: editing a message in place (brief item 3).
//
// The control lives in the PLAYER row's own strip — the same strip the companion's reply carries its
// own controls in — it opens the editor where the row is, and the transcript a save produces is the
// Host's own re-read rather than a local guess. So the driver reads both halves of that claim: the
// DOM the player is looking at, and the Host's projection through the product's own state route.
//
// The open conversation is whatever the earlier drivers left: a chat switch moves the open Chat, so
// this driver first ensures the row it needs exists rather than assuming one is mounted. When the
// open conversation carries no message of its own, it gets one real turn, gated exactly as driver F
// gates its own (`GB_SHOTS_CREDENTIAL_PRESENT`, set by the orchestrator; the value never crosses in).
const { connect, reporter, PAGE_HELPERS, activateSurface, shot, readDurableTranscript } = require("./common.cjs");

const CREDENTIAL_PRESENT = process.env.GB_SHOTS_CREDENTIAL_PRESENT === "1";

const domRows = () =>
  [...document.querySelectorAll(".message-list > li.message")].map((row, index) => ({
    index,
    role: row.className.includes("player") ? "player" : "companion",
    handle: row.getAttribute("data-handle"),
    streaming: row.hasAttribute("data-streaming"),
    text: (row.querySelector(".message-bubble")?.innerText ?? "").trim(),
  }));

const composerState = () => ({
  running: document.querySelector(".composer-button.stop-button, .composer-button.composer-busy") !== null,
  optimistic: document.querySelector('[data-testid="optimistic-player-message"]') !== null,
  streaming: document.querySelectorAll(".message-list > li.message[data-streaming]").length,
  players: document.querySelectorAll(".message-list > li.message.player").length,
  settledCompanions: document.querySelectorAll(".message-list > li.message.companion:not([data-streaming])").length,
});

const sendLine = (text) => {
  const area = document.querySelector(".composer-textarea");
  if (area === null) return "no_composer";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(area, text);
  area.dispatchEvent(new Event("input", { bubbles: true }));
  return "typed";
};

async function sendAndSettle(page, text, settled) {
  await page.evaluate(sendLine, text);
  await page.waitForTimeout(300);
  await page.locator(".composer-button.send-button").click();
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await page.waitForTimeout(2000);
    const state = await page.evaluate(composerState);
    if (!state.running && state.optimistic === false && state.streaming === 0 && (await page.evaluate(settled)))
      return state;
  }
  return null;
}

/** The controls in one row's strip: what the player can press, with the shape of each. */
const stripFacts = (selector) => {
  const row = document.querySelector(selector);
  if (row === null) return { present: false };
  const strip = row.querySelector(".message-actions");
  const buttons = strip === null ? [] : [...strip.querySelectorAll("button")];
  const rect = (node) => {
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    present: true,
    row: rect(row),
    strip: strip === null ? null : rect(strip),
    controlCount: buttons.length,
    controls: buttons.map((button) => ({
      testid: button.getAttribute("data-testid"),
      name: (button.getAttribute("aria-label") ?? button.innerText ?? "").trim(),
      disabled: button.disabled,
      box: rect(button),
    })),
    bubbleText: (row.querySelector(".message-bubble")?.innerText ?? "").trim(),
  };
};

const editorFacts = () => {
  const form = document.querySelector('[data-testid="message-edit-form"]');
  if (form === null) return { present: false };
  const rect = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const field = form.querySelector('[data-testid="message-edit-field"]');
  const save = form.querySelector('[data-testid="message-edit-save"]');
  const cancel = form.querySelector('[data-testid="message-edit-cancel"]');
  const row = form.closest("li.message");
  return {
    present: true,
    form: rect(form),
    field: { value: field?.value ?? null, box: rect(field), ariaLabel: field?.getAttribute("aria-label") ?? null },
    save: { box: rect(save), text: (save?.textContent ?? "").trim(), disabled: save?.disabled ?? null },
    cancel: { box: rect(cancel), text: (cancel?.textContent ?? "").trim(), disabled: cancel?.disabled ?? null },
    stripControlsBesideTheEditor: row === null ? null : row.querySelectorAll(".message-actions > button").length,
    rows: document.querySelectorAll(".message-list > li.message").length,
  };
};

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("n-message-edit.txt");
  // A refused mutation is re-read and the refusal is only committed when that re-read ALSO fails, so a
  // refusal leaves the surface looking untouched. The driver therefore reads the wire: every refused
  // API call the page made, with the status and the Host's own bounded code.
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

  let rows = await page.evaluate(domRows);
  say("=== ITEM: the open conversation before the edit ===");
  say(JSON.stringify(rows, null, 1));
  say(`durable transcript before: ${JSON.stringify((await readDurableTranscript(page)).transcript?.map((message) => ({ order: message.order, role: message.role, text: message.text?.slice(0, 12) })))}`);

  if (rows.filter((row) => row.role === "player").length === 0) {
    if (!CREDENTIAL_PRESENT) {
      say('=== ITEM: editing a message -> SKIPPED:no_player_message_mounted_and_no_provider_credential');
      flush();
      await browser.close().catch(() => undefined);
      say("DONE-N");
      process.exit(0);
    }
    say("the open conversation carries no player message; one real turn is sent so there is a row to edit");
    const settled = await sendAndSettle(
      page,
      "在吗？",
      () => document.querySelectorAll(".message-list > li.message.companion:not([data-streaming])").length > 1,
    );
    say(`turn settled: ${settled !== null} ${JSON.stringify(settled)}`);
    rows = await page.evaluate(domRows);
    say(JSON.stringify(rows, null, 1));
  }

  const original = rows.find((row) => row.role === "player")?.text ?? null;
  if (original === null) {
    say("SKIPPED:no_player_row_to_edit_after_the_turn");
    flush();
    await browser.close().catch(() => undefined);
    say("DONE-N");
    process.exit(0);
  }
  say(`the row to edit carries: ${JSON.stringify(original)}`);

  say("=== ITEM: the player row's own strip (the control that opens the editor) ===");
  const stripBefore = await page.evaluate(stripFacts, ".message-list > li.message.player");
  say(JSON.stringify(stripBefore, null, 1));
  say(`controls in the player row's strip: ${stripBefore.controlCount} -> ${JSON.stringify(stripBefore.controls.map((control) => `${control.name} ${control.box.w}x${control.box.h}`))}`);
  await shot(page, "86-player-row-strip-1440x900.png");

  const row = page.locator(".message-list > li.message.player").first();
  const edit = row.locator('[data-testid="message-edit"]');
  say(`edit control count in that row: ${await edit.count()}`);
  await edit.first().click();
  await page.waitForTimeout(900);

  const editorOpen = await page.evaluate(editorFacts);
  say("=== ITEM: the editor, open in the row's own strip ===");
  say(JSON.stringify(editorOpen, null, 1));
  say(`the field starts on the words the row shows: ${editorOpen.field?.value === original}`);
  say(`save is not offered while nothing has changed: ${editorOpen.save?.disabled === true}`);
  await row.scrollIntoViewIfNeeded().catch(() => undefined);
  await shot(page, "86-message-editor-open-1440x900.png");
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(1200);
  await row.scrollIntoViewIfNeeded().catch(() => undefined);
  const editorNarrow = await page.evaluate(editorFacts);
  say(`editor @400x800: ${JSON.stringify({ form: editorNarrow.form, field: editorNarrow.field?.box, save: editorNarrow.save?.box, cancel: editorNarrow.cancel?.box })}`);
  await shot(page, "86-message-editor-open-400x800.png");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(1000);

  const edited = `${original}（改过）`;
  await page.locator('[data-testid="message-edit-field"]').fill(edited);
  await page.waitForTimeout(500);
  const editorFilled = await page.evaluate(editorFacts);
  say(`after typing, save is enabled: ${editorFilled.save?.disabled === false}; field holds ${JSON.stringify(editorFilled.field?.value)}`);
  await shot(page, "86-message-editor-filled-1440x900.png");

  await page.locator('[data-testid="message-edit-save"]').first().click();
  let after = null;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await page.waitForTimeout(1500);
    const now = await page.evaluate(domRows);
    const playerRow = now.find((entry) => entry.role === "player");
    if (playerRow !== undefined && playerRow.text === edited) {
      after = now;
      break;
    }
  }
  say("=== ITEM: the transcript after the save ===");
  say(`refused API calls while the save was out: ${JSON.stringify(refusals.splice(0))}`);
  const editorAfter = await page.evaluate(editorFacts);
  say(`the editor after the save: stillOpen=${editorAfter.present} field=${JSON.stringify(editorAfter.field?.value ?? null)}`);
  say(`the DOM carries the rewritten text in the same row: ${after !== null}`);
  const domAfter = after ?? (await page.evaluate(domRows));
  say(JSON.stringify(domAfter, null, 1));
  const durableAfter = await readDurableTranscript(page);
  say(`durable transcript after: ${JSON.stringify(durableAfter.transcript?.map((message) => ({ order: message.order, role: message.role, revision: message.revision, text: message.text })))}`);
  say(`rows before=${rows.length} after=${domAfter.length} (an edit is not a second message)`);
  say(`the Host's own row carries the rewritten text too: ${durableAfter.transcript?.some((message) => message.text === edited) === true}`);
  await shot(page, "86-message-edited-1440x900.png");
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(1200);
  await shot(page, "86-message-edited-400x800.png");

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-N");
})().catch((error) => {
  console.log("DRIVER N FAILED:", String(error).slice(0, 900));
  process.exit(1);
});
