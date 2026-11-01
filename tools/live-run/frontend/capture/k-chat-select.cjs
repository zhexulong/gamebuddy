// Driver K: chat-select switches surface + title. From the Chats list, choosing a NON-selected
// conversation (data-testid="chat-select" inside a `chat-item` row) commits a chat switch:
//   * the surface moves to 聊天 (the Chats surface unmounts);
//   * the Timeline's title band — the one place the surface names which conversation is open — shows
//     the chosen conversation's own name. That band DROPS the row's list number: an unnamed row reads
//     "新对话 1" in the list but the band the open conversation reads is "新对话". So the expected
//     band value is the row's title with a trailing list number stripped.
//   * the chosen row is the selected one the next time the Chats list is read (the list is re-opened
//     to observe the flip, because the surface that carries the rows is unmounted while Chat is shown).
//
// A switch needs two rows and a fresh root has one, so this driver CREATES the row it chooses when the
// list it finds has no unselected row - through the product's own New Chat control, landing in the
// created Chat and then re-opening the list. Earlier runs had their second row handed to them by an
// earlier driver (E created one); when E stopped creating (see common.cjs `createChat`) this driver
// took a named skip and the run lost 55-chat-select-switched.png and the 41b/41c shots. A create that
// does not land is reported as a driver failure rather than a skip: the scenario is runnable, and a
// control that answers a click without making a Chat is the defect to say out loud.
const { connect, reporter, PAGE_HELPERS, activateSurface, shot, createChat } = require("./common.cjs");

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

  if (rows.rows.every((row) => row.selected)) {
    // A fresh root holds one Chat and a switch needs two: the second row is made the way a player
    // makes one, and the list is re-opened because creating lands IN the created Chat.
    say("=== ITEM: this list has no unselected row, so one is created ===");
    const created = await createChat(page);
    say(`the product's own New Chat control: control=${created.started} committed_opening=${JSON.stringify(created.committed)} landed_in_the_new_chat=${created.landed}`);
    if (!created.landed) {
      flush();
      throw new Error(`driver_k: the New Chat control made no Chat (control=${created.started}, committed_opening=${JSON.stringify(created.committed)}) - a switch needs two rows and there is no other control that creates one`);
    }
    say("re-opened the Chats surface:", await activateSurface(page, "会话"));
    await page.waitForTimeout(1500);
    rows = await page.evaluate(rowsFact);
    say("=== ITEM: the list after creating a second Chat ===");
    say(JSON.stringify(rows, null, 1));
  }

  const unselected = rows.rows.find((row) => !row.selected) ?? null;
  if (unselected === null) {
    flush();
    throw new Error(`driver_k: the list still has ${rows.rows.length} row(s) and every one of them is selected, so there is nothing to switch to`);
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