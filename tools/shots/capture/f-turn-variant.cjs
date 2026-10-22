// Driver F: one real conversation in the Chat surface.
//   * send 你好, read the settled reply verbatim with characters/sentences/em.message-action count
//   * the variant flow: regenerate (player-row count stays 1, bubble handle identical), swipe back
//     byte-identical, swipe forward byte-identical, pager visible labels
//   * Chinese action beats: computed letter-spacing next to the dialogue's, and both contrasts
//   * the message controls in one strip at the bubble's foot
//   * the optimistic player message scrolls WITH the transcript
//
// CREDENTIAL GATE: a turn needs the provider credential. Drivers never read its value — the
// orchestrator sets GB_SHOTS_CREDENTIAL_PRESENT=1|0 and no part of the value crosses into this
// process. When 0, every stage that requires a live turn records a NAMED SKIP and the geometry
// probes that survive without a turn still run.
const path = require("node:path");
const { connect, reporter, SHOTS, PAGE_HELPERS, activateSurface, shot } = require("./common.cjs");

const CREDENTIAL_PRESENT = process.env.GB_SHOTS_CREDENTIAL_PRESENT === "1";
const SKIP = (reason) => `SKIPPED:${reason}`;

const TURN_RUNNING = () => document.querySelector(".composer-button.stop-button, .composer-button.composer-busy") !== null;

// The surface's own terminal sentence for the turn (`ChatSurface`'s `notice`, drawn as
// `.reference-turn-notice`). A turn that fails pre-commit - the endpoint refusing the request,
// a drop mid-reply, an unwritable transcript - ends with NO companion row and this one sentence.
// Reading it is what separates "the product told the player what happened" from "the turn did
// nothing": without it a refused turn reads as a bare timeout and the driver reports a silence
// the player never saw.
const turnNotice = () => {
  const element = document.querySelector(".reference-turn-notice");
  return element === null ? null : (element.innerText ?? "").trim();
};

const readTranscript = () => [...document.querySelectorAll(".message-list > li.message")].map((row) => {
  const bubble = row.querySelector(".message-bubble");
  return {
    role: row.className.includes("player") ? "player" : "companion",
    streaming: row.hasAttribute("data-streaming"),
    pending: row.getAttribute("data-pending"),
    handle: row.getAttribute("data-handle"),
    text: (bubble?.innerText ?? "").trim(),
  };
});

const settledTranscript = () => [...document.querySelectorAll('.message-list > li.message:not([data-streaming])')].map((row) => ({
  role: row.className.includes("player") ? "player" : "companion",
  handle: row.getAttribute("data-handle"),
  text: (row.querySelector(".message-bubble")?.innerText ?? "").trim(),
}));

const stripFacts = () => {
  const rows = [...document.querySelectorAll(".message-list > li.message.companion:not([data-streaming])")];
  const row = rows.length === 0 ? null : rows[rows.length - 1];
  if (row === null) return { present: false, reason: "no settled companion row" };
  const bubble = row.querySelector(".message-bubble");
  const strip = row.querySelector(".message-actions");
  const pager = strip === null ? null : strip.querySelector(".swipe-controls");
  const regenerate = strip === null ? null : strip.querySelector(".regenerate-btn");
  const buttons = pager === null ? [] : [...pager.querySelectorAll(".swipe-btn")];
  const boxOf = (element) => (element === null ? null : window.__shots.rect(element));
  const centreGap = pager === null || regenerate === null ? null : (() => {
    const a = pager.getBoundingClientRect();
    const b = regenerate.getBoundingClientRect();
    return Math.round(Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)));
  })();
  return {
    present: true,
    messageHandle: row.getAttribute("data-handle"),
    messageActionsPresent: strip !== null,
    bubble: boxOf(bubble),
    strip: boxOf(strip),
    stripChildren: strip === null ? [] : [...strip.children].map((child) => ({ rect: window.__shots.rect(child) })),
    pager: boxOf(pager),
    pagerIndicator: pager === null ? null : pager.querySelector(".swipe-indicator")?.textContent ?? null,
    pagerVisibleLabels: buttons.map((button) => button.querySelector(".swipe-btn-label")?.textContent ?? ""),
    pagerAriaLabels: buttons.map((button) => button.getAttribute("aria-label")),
    pagerDisabled: buttons.map((button) => button.disabled),
    regenerate: regenerate === null ? null : { rect: boxOf(regenerate), text: (regenerate.innerText ?? "").trim(), ariaLabel: regenerate.getAttribute("aria-label") },
    sameStrip: pager !== null && regenerate !== null && pager.parentElement === regenerate.parentElement,
    verticalCentreGap: centreGap,
    gapFromBubbleFoot: pager === null || bubble === null || strip === null ? null : Math.round(strip.getBoundingClientRect().top - bubble.getBoundingClientRect().bottom),
  };
};

const beatFacts = () => {
  const rows = [...document.querySelectorAll(".message-list > li.message.companion:not([data-streaming])")];
  const replyRow = rows.length === 0 ? null : rows[rows.length - 1];
  const carrying = rows.filter((row) => row.querySelector("em.message-action") !== null);
  const row = carrying.length === 0 ? null : carrying[carrying.length - 1];
  if (row === null) return { present: false, replyBeatCount: 0, reason: "no em.message-action in any settled companion bubble" };
  const bubble = row.querySelector(".message-bubble");
  const beats = [...bubble.querySelectorAll("em.message-action")];
  const dialogue = [...bubble.querySelectorAll("p")].find((paragraph) => paragraph.querySelector("em.message-action") === null && (paragraph.innerText ?? "").trim().length > 0);
  const factsFor = (element) => {
    if (element === null || element === undefined) return null;
    const style = getComputedStyle(element);
    const foreground = window.__shots.parseColor(style.color);
    const background = window.__shots.parseColor(window.__shots.effectiveBackground(element));
    return {
      fontSize: style.fontSize,
      letterSpacing: style.letterSpacing,
      fontStyle: style.fontStyle,
      color: style.color,
      background: window.__shots.effectiveBackground(element),
      contrast: foreground === null || background === null ? null : window.__shots.contrast(foreground, background),
    };
  };
  return {
    present: true,
    measuredOn: row.getAttribute("data-handle"),
    isTheReply: row === replyRow,
    replyBeatCount: replyRow === null ? 0 : replyRow.querySelectorAll("em.message-action").length,
    beatsInMeasuredBubble: beats.length,
    beatText: beats.length === 0 ? null : (beats[0].innerText ?? "").trim().slice(0, 80),
    dialogueText: dialogue === undefined ? null : (dialogue.innerText ?? "").trim().slice(0, 80),
    beat: factsFor(beats[0] ?? null),
    dialogue: factsFor(dialogue ?? null),
  };
};

const optimisticFacts = () => {
  const element = document.querySelector('[data-testid="optimistic-player-message"]');
  if (element === null) return { present: false };
  const scroller = element.closest(".timeline");
  const rule = getComputedStyle(element);
  const result = {
    present: true,
    text: (element.innerText ?? "").replace(/\s+/g, " ").trim(),
    rect: window.__shots.rect(element),
    position: rule.position,
    nearestScrollAncestor: window.__shots.scrollContainer(element),
    scrollContainer: scroller === null ? null : {
      overflowY: getComputedStyle(scroller).overflowY,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    },
    isChildOfTheTranscriptScroller: scroller !== null && element.parentElement === scroller,
    siblingOfTheMessageList: scroller !== null && scroller.querySelector(".message-list") !== null,
    insideMessageList: element.closest(".message-list") !== null,
    transcriptRows: document.querySelectorAll(".message-list > li.message").length,
  };
  if (scroller !== null && scroller.scrollHeight <= scroller.clientHeight) {
    const previousMax = scroller.style.maxHeight;
    scroller.style.maxHeight = "220px";
    const before = element.getBoundingClientRect().top;
    scroller.scrollTop = scroller.scrollHeight;
    const after = element.getBoundingClientRect().top;
    result.forcedOverflowProbe = {
      forced: true,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      scrollTop: scroller.scrollTop,
      viewportShift: Math.round(before - after),
      followsTheScroller: Math.abs((before - after) - scroller.scrollTop) <= 2,
    };
    scroller.scrollTop = 0;
    scroller.style.maxHeight = previousMax;
  } else if (scroller !== null) {
    const before = element.getBoundingClientRect().top;
    scroller.scrollTop = scroller.scrollHeight;
    const after = element.getBoundingClientRect().top;
    result.nativeScrollProbe = { scrollTop: scroller.scrollTop, viewportShift: Math.round(before - after), followsTheScroller: Math.abs((before - after) - scroller.scrollTop) <= 2 };
    scroller.scrollTop = 0;
  }
  return result;
};

const composerState = () => ({
  running: document.querySelector(".composer-button.stop-button, .composer-button.composer-busy") !== null,
  stopButton: document.querySelector(".composer-button.stop-button") !== null,
  busyButton: document.querySelector(".composer-button.composer-busy") !== null,
  optimistic: document.querySelector('[data-testid="optimistic-player-message"]') !== null,
  streamingRows: document.querySelectorAll(".message-list > li.message[data-streaming]").length,
  settledCompanions: document.querySelectorAll(".message-list > li.message.companion:not([data-streaming])").length,
  settledPlayers: document.querySelectorAll(".message-list > li.message.player:not([data-streaming])").length,
});

async function waitForSettle(page, label, predicate, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.waitForTimeout(2000);
    const state = await page.evaluate(composerState);
    const settled = await page.evaluate(predicate);
    if (attempt % 5 === 0) console.log(`${label} t+${(attempt + 1) * 2}s`, JSON.stringify(state));
    if (!state.running && state.optimistic === false && state.streamingRows === 0 && settled) return state;
  }
  return null;
}

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("f-turn-variant.txt");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(`${PAGE_HELPERS};undefined`);
  await activateSurface(page, "聊天");
  await page.waitForTimeout(1500);

  say(`credential present (present|absent only; the value never crosses in): ${CREDENTIAL_PRESENT ? "present" : "absent"}`);

  const beforeRows = await page.evaluate(settledTranscript);
  say("=== settled transcript before the turn ===");
  say(JSON.stringify(beforeRows, null, 1));
  await shot(page, "70-before-turn.png");

  if (!CREDENTIAL_PRESENT) {
    say(`=== ITEM: real conversation -> ${SKIP("no provider credential (CPA_OAI_API_KEY absent); a turn would fail before the reply exists")}`);
    say(`=== ITEM: variant flow -> ${SKIP("needs a settled reply to regenerate")}`);
    say("=== ITEM: beat letter-spacing (measured on whatever settled companion bubble exists) ===");
    say(JSON.stringify(await page.evaluate(beatFacts), null, 1));
    say("=== ITEM: the controls strip on the newest settled companion bubble ===");
    say(JSON.stringify(await page.evaluate(stripFacts), null, 1));
    await shot(page, "72-skip-no-credential.png");
    flush();
    await browser.close().catch(() => undefined);
    say("DONE-F");
    process.exit(0);
  }

  // ---- ITEM: the optimistic bubble, between send and settle ----
  await page.evaluate(() => {
    const area = document.querySelector(".composer-textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(area, "你好");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(250);
  await page.locator(".composer-button.send-button").click();
  let optimistic = { present: false };
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(200);
    optimistic = await page.evaluate(optimisticFacts);
    if (optimistic.present) break;
  }
  say("=== ITEM: the optimistic player message (in flight) ===");
  say(JSON.stringify(optimistic, null, 1));
  if (optimistic.present) await shot(page, "71-optimistic-bubble.png");

  const settledState = await waitForSettle(page, "turn", () => document.querySelectorAll(".message-list > li.message.companion:not([data-streaming])").length > 1);
  say("turn settled:", settledState !== null);
  // The surface's own words for the turn, read whatever the settling said: a refused turn
  // settles idle carrying this sentence and no reply row, so without this line the driver
  // would report "no reply and no error" for a product that showed one. The notice element
  // also carries benign opening notes, so it is only read as the turn's outcome when no
  // reply settled; the verbatim text is printed either way for the reader to judge.
  const noticeAfterTurn = await page.evaluate(turnNotice);
  say("surface notice after the turn:", JSON.stringify(noticeAfterTurn));
  say(
    `the surface reported a failure instead of a reply: ${settledState === null && noticeAfterTurn !== null}`,
  );
  say("=== ITEM: transcript after 你好 ===");
  const afterTurn = await page.evaluate(settledTranscript);
  say(JSON.stringify(afterTurn, null, 1));
  await shot(page, "72-turn-settled.png");

  const reply = afterTurn[afterTurn.length - 1];
  const characters = [...(reply?.text ?? "")].length;
  const sentences = (reply?.text ?? "").split(/[。!?!?\n]+/u).filter((part) => part.trim().length > 0).length;
  say("=== ITEM: the reply to 你好 (VERBATIM) ===");
  say(JSON.stringify(reply?.text ?? null));
  say(`role=${reply?.role} streaming=false characters=${characters} sentences=${sentences} handle=${JSON.stringify(reply?.handle)}`);
  say(`em.message-action beats in the reply bubble: ${(await page.evaluate(() => [...document.querySelectorAll(".message-list > li.message.companion:not([data-streaming]) .message-bubble em.message-action")].length))}`);
  say(`raw asterisks in the reply: ${(reply?.text ?? "").split("*").length - 1}; raw "{{": ${(reply?.text ?? "").split("{{").length - 1}`);
  const playerRowsAfter = afterTurn.filter((row) => row.role === "player").length;
  say(`player rows: before=${beforeRows.filter((row) => row.role === "player").length} after=${playerRowsAfter}`);

  say("=== ITEM: the beat's letter-spacing and contrast next to the dialogue's ===");
  say(JSON.stringify(await page.evaluate(beatFacts), null, 1));
  const before = await page.evaluate(stripFacts);
  say("=== ITEM: the reply's controls BEFORE regenerate ===");
  say(JSON.stringify(before, null, 1));
  await shot(page, "73-reply.png");

  // ---- regenerate ----
  const originalText = reply?.text ?? null;
  const originalHandle = reply?.handle ?? null;
  const regenerateButton = page.locator(".message-list > li.message.companion:not([data-streaming])").last().locator(".regenerate-btn");
  say("regenerate control count:", await regenerateButton.count());
  await regenerateButton.first().click();
  const regeneratedState = await waitForSettle(page, "regenerate", `(() => {
    const rows = [...document.querySelectorAll(".message-list > li.message.companion:not([data-streaming])")];
    const text = (rows[rows.length - 1]?.querySelector(".message-bubble")?.innerText ?? "").trim();
    return text.length > 0 && text !== ${JSON.stringify(originalText)};
  })()`);
  say("regenerate settled:", regeneratedState !== null);
  const afterRegenerate = await page.evaluate(settledTranscript);
  const newReply = afterRegenerate[afterRegenerate.length - 1];
  say("=== ITEM: after regenerate (VERBATIM) ===");
  say(JSON.stringify(newReply?.text ?? null));
  say(`player rows for the exchange: before=${playerRowsAfter} after=${afterRegenerate.filter((row) => row.role === "player").length}`);
  say(`bubble handle before=${JSON.stringify(originalHandle)} after=${JSON.stringify(newReply?.handle ?? null)} sameRow=${originalHandle === (newReply?.handle ?? null)}`);
  say(`transcript rows before=${afterTurn.length} after=${afterRegenerate.length}; text changed=${newReply?.text !== originalText}`);
  say("=== ITEM: the reply's controls AFTER regenerate (the pager exists) ===");
  say(JSON.stringify(await page.evaluate(stripFacts), null, 1));
  await shot(page, "80-variant-after-regenerate.png");
  const strip = page.locator(".message-list > li.message.companion:not([data-streaming])").last().locator(".message-actions");
  if ((await strip.count()) > 0) await strip.first().screenshot({ path: path.join(SHOTS, "81-message-controls-strip.png"), timeout: 45000 }).catch(() => undefined);

  // ---- switch back / forward ----
  const replyRow = page.locator(".message-list > li.message.companion:not([data-streaming])").last();
  await replyRow.locator(".swipe-btn").first().click();
  let back = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(1000);
    const state = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".message-list > li.message.companion:not([data-streaming])")];
      const row = rows[rows.length - 1];
      return {
        running: document.querySelector(".composer-button.stop-button, .composer-button.composer-busy") !== null,
        text: (row?.querySelector(".message-bubble")?.innerText ?? "").trim(),
        indicator: row?.querySelector(".swipe-indicator")?.textContent ?? null,
      };
    });
    back = state;
    if (!state.running && state.text === originalText) break;
  }
  say("=== ITEM: switching back to variant 1 ===");
  say(`indicator after switch-back: ${JSON.stringify(back?.indicator ?? null)}`);
  say(`text after switch-back equals the original: ${back?.text === originalText}`);
  say(`byte-identical to the ORIGINAL pre-regenerate reply: ${back?.text === originalText}`);
  await shot(page, "82-variant-switched-back.png");

  await replyRow.locator(".swipe-btn").last().click();
  let forward = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(1000);
    const state = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".message-list > li.message.companion:not([data-streaming])")];
      const row = rows[rows.length - 1];
      return {
        running: document.querySelector(".composer-button.stop-button, .composer-button.composer-busy") !== null,
        text: (row?.querySelector(".message-bubble")?.innerText ?? "").trim(),
        indicator: row?.querySelector(".swipe-indicator")?.textContent ?? null,
      };
    });
    forward = state;
    if (!state.running && state.text === (newReply?.text ?? null)) break;
  }
  say(`text after switching forward equals the regenerated text: ${forward?.text === (newReply?.text ?? null)} indicator=${JSON.stringify(forward?.indicator ?? null)}`);
  await shot(page, "83-variant-switched-forward.png");

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-F");
})().catch((error) => {
  console.log("DRIVER F FAILED:", String(error).slice(0, 900));
  process.exit(1);
});