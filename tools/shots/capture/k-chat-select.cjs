// Driver K: chat-select switches surface + title. From the Chats list, choosing a NON-selected
// conversation (data-testid="chat-select" inside a `chat-item` row) commits a chat switch: the
// surface moves to 聊天, the Timeline's title band (the one place the surface names which
// conversation is open) shows the chosen conversation's own name, and the row's selected state flips.
const { connect, reporter, PAGE_HELPERS, activateSurface, shot } = require("./common.cjs");

const rowsFact = () => {
  const surface = document.querySelector('[data-testid="chats-surface"]');
  const rows = [...surface.querySelectorAll('[data-testid="chat-item"]')];
  return {
    count: rows.length,
    rows: rows.map((row, index) => {
      const title = row.querySelector(".chat-item-title");
      return {
        index,
        titleText: (title?.textContent ?? "").trim(),
        selected: (row.getAttribute("data-selected") ?? "") === "true",
        hasChatSelect: row.querySelector('[data-testid="chat-select"]') !== null,
      };
    }),
  };
};

const clickChatSelect = ({ index }) => {
  const surface = document.querySelector('[data-testid="chats-surface"]');
  const rows = [...surface.querySelectorAll('[data-testid="chat-item"]')];
  const row = rows[index];
  if (row === undefined) return "no_such_row";
  const button = row.querySelector('[data-testid="chat-select"]');
  if (button === null) return "no_chat_select";
  button.click();
  return "clicked";
};

const afterFacts = () => {
  const chatSurface = document.querySelector('[data-testid="chat-surface"]');
  const chatsSurface = document.querySelector('[data-testid="chats-surface"]');
  const heading = document.querySelector(".timeline .timeline-heading h1");
  const selectedRow = [...document.querySelectorAll('[data-testid="chat-item"]')]
    .map((row, index) => ({ index, text: (row.querySelector(".chat-item-title")?.textContent ?? "").trim(), selected: (row.getAttribute("data-selected") ?? "") === "true" }))
    .find((row) => row.selected) ?? null;
  return {
    chatSurfacePresent: chatSurface !== null,
    chatsSurfacePresent: chatsSurface !== null,
    timelineTitleBand: heading === null ? null : (heading.textContent ?? "").trim(),
    documentTitle: document.title,
    selectedRow,
  };
};

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("k-chat-select.txt");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(`${PAGE_HELPERS};undefined`);
  await activateSurface(page, "会话");
  await page.waitForTimeout(1500);

  let rows = await page.evaluate(rowsFact);
  say("=== ITEM: chat-select — the list before choosing ===");
  say(JSON.stringify(rows, null, 1));

  const unselected = rows.rows.find((row) => !row.selected) ?? null;
  if (unselected === null) {
    say("SKIPPED:no_unselected_row remains to choose");
    flush();
    await browser.close().catch(() => undefined);
    say("DONE-K");
    process.exit(0);
  }

  say(`surface before: ${(await page.evaluate(() => document.querySelector('[data-testid="chats-surface"]') !== null)) ? "chats-surface" : "?"}`);
  say(`choosing row index=${unselected.index} title=${JSON.stringify(unselected.titleText)} (hasChatSelect=${unselected.hasChatSelect})`);
  const clicked = await page.evaluate(clickChatSelect, { index: unselected.index });
  say("click:", clicked);

  let after = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(1500);
    after = await page.evaluate(afterFacts);
    if (after.chatSurfacePresent && !after.chatsSurfacePresent) break;
  }
  say("=== ITEM: after choosing the other conversation ===");
  say(JSON.stringify(after, null, 1));
  say(`surface after: ${after.chatSurfacePresent ? "chat-surface" : after.chatsSurfacePresent ? "chats-surface (did not move)" : "?"}`);
  say(`timeline title band after: ${JSON.stringify(after.timelineTitleBand)}`);
  say(`title equals row title (${JSON.stringify(unselected.titleText)}): ${after.timelineTitleBand === unselected.titleText}`);
  say(`selected row flips: ${after.selectedRow !== null ? JSON.stringify(after.selectedRow) : "none"}`);
  const switches = after.selectedRow !== null && after.selectedRow.index === unselected.index;
  say(`the clicked row is now the selected one: ${switches}`);

  await shot(page, "55-chat-select-switched.png");

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-K");
})().catch((error) => {
  console.log("DRIVER K FAILED:", String(error).slice(0, 900));
  process.exit(1);
});