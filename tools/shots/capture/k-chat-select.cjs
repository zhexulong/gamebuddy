// Driver K: chat-select switches surface + title. From the Chats list, choosing a NON-selected
// conversation (data-testid="chat-select" inside a `chat-item` row) commits a chat switch:
//   * the surface moves to 聊天 (the Chats surface unmounts);
//   * the Timeline's title band — the one place the surface names which conversation is open — shows
//     the chosen conversation's own name. That band DROPS the row's list number: an unnamed row reads
//     "新对话 1" in the list but the band the open conversation reads is "新对话". So the expected
//     band value is the row's title with a trailing list number stripped.
//   * the chosen row is the selected one the next time the Chats list is read (the list is re-opened
//     to observe the flip, because the surface that carries the rows is unmounted while Chat is shown).
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

const surfaceFacts = () => ({
  chatSurfacePresent: document.querySelector('[data-testid="chat-surface"]') !== null,
  chatsSurfacePresent: document.querySelector('[data-testid="chats-surface"]') !== null,
  timelineTitleBand: (() => {
    const heading = document.querySelector(".timeline .timeline-heading h1");
    return heading === null ? null : (heading.textContent ?? "").trim();
  })(),
  documentTitle: document.title,
});

// The list names an unnamed row with a 1-based number; the open-conversation band drops it.
const bandExpectedFromRow = (titleText) => titleText.replace(/\s*\d+$/u, "").trim();

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

  const expectedBand = bandExpectedFromRow(unselected.titleText);
  say(`surface before: ${JSON.stringify(await page.evaluate(() => document.querySelector('[data-testid="chats-surface"]') !== null))} (chats-surface present)`);
  say(`choosing row index=${unselected.index} title=${JSON.stringify(unselected.titleText)} expected band=${JSON.stringify(expectedBand)} hasChatSelect=${unselected.hasChatSelect}`);
  const clicked = await page.evaluate(clickChatSelect, { index: unselected.index });
  say("click:", clicked);

  let after = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(1500);
    after = await page.evaluate(surfaceFacts);
    if (after.chatSurfacePresent && !after.chatsSurfacePresent) break;
  }
  say("=== ITEM: after choosing the other conversation (surface) ===");
  say(JSON.stringify(after, null, 1));
  say(`surface after: ${after.chatSurfacePresent ? "chat-surface" : after.chatsSurfacePresent ? "chats-surface (did not move)" : "?"}`);
  say(`timeline title band after: ${JSON.stringify(after.timelineTitleBand)}`);
  say(`title matches the chosen conversation's own name (${JSON.stringify(expectedBand)}): ${after.timelineTitleBand === expectedBand}`);
  await shot(page, "55-chat-select-switched.png");

  // Reopen the list to observe the selection flip (the Chats surface was unmounted while Chat showed).
  await activateSurface(page, "会话");
  await page.waitForTimeout(1500);
  const reopened = await page.evaluate(rowsFact);
  say("=== ITEM: the list reopened — the chosen row is now the selected one ===");
  say(JSON.stringify(reopened, null, 1));
  const chosenNow = reopened.rows.find((row) => row.titleText === unselected.titleText) ?? null;
  say(`chosen row found again: ${chosenNow !== null}`);
  say(`selected row flips: ${chosenNow !== null ? JSON.stringify({ index: chosenNow.index, titleText: chosenNow.titleText, selected: chosenNow.selected }) : "none"}`);
  say(`the clicked row is now the selected one: ${chosenNow !== null && chosenNow.selected === true}`);

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-K");
})().catch((error) => {
  console.log("DRIVER K FAILED:", String(error).slice(0, 900));
  process.exit(1);
});