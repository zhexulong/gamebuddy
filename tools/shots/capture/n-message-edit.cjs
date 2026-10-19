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

const PLAYER_ROW = ".message-list > li.message.player";

/**
 * The row's own editor, measured the way the product's own mounted suite measures it
 * (`dialogue-web/tests/chat-surface-probe.tsx::editInPlace`): the bubble's box, the field's box, the
 * TEXT nodes that paint the words, and `copies` - those nodes plus the one the field's value holds,
 * because a textarea's value is not a text node. Closed, `copies` is 1 (the bubble); open, the bubble
 * is gone and the words stand once, in the field.
 */
const editInPlace = ({ selector, text }) => {
  const row = document.querySelector(selector);
  if (row === null) return { present: false };
  const box = (element) => {
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      top: Math.round(rect.top),
    };
  };
  const bubble = row.querySelector(".message-bubble");
  const field = row.querySelector('[data-testid="message-edit-field"]');
  let textNodes = 0;
  const carriers = [];
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node.textContent ?? "").includes(text)) continue;
    const parent = node.parentElement;
    if (parent === null || parent.getClientRects().length === 0) continue;
    if (parent.closest("textarea, input, select") !== null) continue;
    textNodes += 1;
    carriers.push(`${parent.tagName.toLowerCase()}.${parent.className}`);
  }
  const inField = field !== null && field.value.includes(text);
  const strip = row.querySelector(".message-actions");
  return {
    present: true,
    row: box(row),
    bubble: box(bubble),
    field: box(field),
    bubblePresent: bubble !== null,
    fieldValue: field === null ? null : field.value,
    textNodes,
    carriers,
    copies: textNodes + (inField ? 1 : 0),
    stripMarginTop: strip === null ? null : getComputedStyle(strip).marginTop,
    stripButtonsBesideTheEditor: row.querySelectorAll(".message-actions > button").length,
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

  const row = page.locator(PLAYER_ROW).first();
  const edit = row.locator('[data-testid="message-edit"]');
  say(`edit control count in that row: ${await edit.count()}`);
  const closedInPlace = await page.evaluate(editInPlace, { selector: PLAYER_ROW, text: original });
  say(
    `closed:  row=${JSON.stringify(closedInPlace.row)} bubble=${JSON.stringify(closedInPlace.bubble)} field=${JSON.stringify(closedInPlace.field)} copies=${closedInPlace.copies} textNodes=${closedInPlace.textNodes} carriers=${JSON.stringify(closedInPlace.carriers)}`,
  );
  await edit.first().click();
  await page.waitForTimeout(900);

  const editorOpen = await page.evaluate(editorFacts);
  say("=== ITEM: the editor, open in the row's own strip ===");
  say(JSON.stringify(editorOpen, null, 1));
  say(`the field starts on the words the row shows: ${editorOpen.field?.value === original}`);
  say(`save is not offered while nothing has changed: ${editorOpen.save?.disabled === true}`);

  // ---- the owner's ruling: the bubble gives way to the editor, and Escape is lossless ----
  const inPlace = await page.evaluate(editInPlace, { selector: PLAYER_ROW, text: original });
  say("=== ITEM: the editor in the bubble's own place, and the copies of the words on screen ===");
  say(
    `open:    row=${JSON.stringify(inPlace.row)} bubble=${JSON.stringify(inPlace.bubble)} field=${JSON.stringify(inPlace.field)} copies=${inPlace.copies} textNodes=${inPlace.textNodes} carriers=${JSON.stringify(inPlace.carriers)}`,
  );
  say(`the bubble is GONE rather than repeated: bubblePresent=${inPlace.bubblePresent}`);
  say(
    `the editor takes the bubble's own place in the flow: field.top=${inPlace.field?.top} bubble.top was=${closedInPlace.bubble?.top} sameTop=${inPlace.field?.top === closedInPlace.bubble?.top}`,
  );
  say(
    `the words stand on screen once: copies ${closedInPlace.copies} -> ${inPlace.copies} (text nodes carrying them ${closedInPlace.textNodes} -> ${inPlace.textNodes})`,
  );
  say(
    `the row's own height: before=${closedInPlace.row.h} while editing=${inPlace.row.h}; the strip under it marginTop=${inPlace.stripMarginTop} buttons beside the editor=${inPlace.stripButtonsBesideTheEditor}`,
  );
  say(`the field holds the row's own words: ${inPlace.fieldValue === original}`);

  say("=== ITEM: Escape brings the bubble back at the box it had ===");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(900);
  const restored = await page.evaluate(editInPlace, { selector: PLAYER_ROW, text: original });
  say(
    `after Escape: bubblePresent=${restored.bubblePresent} bubble=${JSON.stringify(restored.bubble)} field=${JSON.stringify(restored.field)} copies=${restored.copies} rowHeight=${restored.row.h}`,
  );
  say(`the bubble came back at the box it had: ${JSON.stringify(restored.bubble) === JSON.stringify(closedInPlace.bubble)}`);
  say(`the row came back to its own height: ${restored.row.h === closedInPlace.row.h}`);
  say(
    `the surface and the transcript are still mounted after Escape: ${await page.evaluate(() => document.querySelector('[data-testid="chat-surface"]') !== null && document.querySelectorAll('.message-list > li.message').length > 0)}`,
  );
  await edit.first().click();
  await page.waitForTimeout(900);
  say(`the editor is open again for the rest of the flow: ${(await page.evaluate(editorFacts)).present}`);
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
