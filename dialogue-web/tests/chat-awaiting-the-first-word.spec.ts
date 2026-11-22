import { expect, test, type Page } from "./frontend-coverage";
import { PHONE } from "./viewport-policy";

/**
 * The window between "the Host accepted the turn" and "her first word is on screen".
 *
 * The defect this file exists for is not a crash: for the first seconds of a turn the conversation drew NOTHING on her
 * side. The Chat row's delta lane withholds every fragment a reasoning frame still owns
 * (`host/src/native-companion-content.ts`: the scaffolding projection releases nothing while a model spells out
 * `<thinking>`, and an empty release dispatches no event at all), so no preview exists to paint - and the app bar's
 * "thinking" word is drawn in the bar, retired to a bare pulsing dot under 720 px of container width, which is not
 * where the player is looking after pressing send. A player could not tell "she is working on it" from "it is broken".
 *
 * What the row must be, and what each assertion below protects:
 *
 *  1. `she is drawn while the turn has written nothing` - the window is the one the player reads as silence.
 *  2. `the row says the bar's own word, once` - the word is `generating` from the same catalogue the bar reads, and the
 *     row is not a second polite region: the bar's `role="status"` already speaks this moment, and a second sentence
 *     about it is how a reader learns to ignore both.
 *  3. `the row is not one of the transcript's rows` - it is not durable, so it is drawn outside `message-list` (the
 *     same rule the optimistic player row follows), where it stands at the tail, under the player's own line.
 *  4. `her first word ends the window` - the moment a delta paints, the preview IS her side of the conversation and a
 *     standing "thinking" row beside it would be a claim about a turn that is visibly writing.
 *  5. `a settled turn leaves no row` - the row is about a turn, not about the conversation.
 *  6. `the row is drawn on the strip where the bar keeps only its dot` - the 400x800 cell, which is where the bar has no
 *     word at all.
 */

type AwaitingRow = {
  text: string | null;
  ariaBusy: string | null;
  liveRegion: boolean;
  inMessageList: boolean;
  isTail: boolean;
  avatar: boolean;
  height: number;
  width: number;
};

type ChatProbe = {
  setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void;
  setPreview(text: string | null): void;
  setTurnInFlight(value: boolean): void;
  setAwaitingReply(value: boolean): void;
  awaitingRow(): AwaitingRow | null;
  awaitingSentence(locale: "en" | "zh-CN"): string;
};

declare global {
  interface Window {
    chatProbe: ChatProbe;
  }
}

async function openProbe(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
}

/** The conversation a turn was just submitted in: her opening, then the player's line it answers. */
const SUBMITTED: readonly Readonly<{ role: "player" | "companion"; text: string }>[] = [
  { role: "companion", text: "上线啦？我先去把东边那片清了。" },
  { role: "player", text: "行，我先把水壶灌满。" },
];

test("she is drawn while the turn has written nothing", async ({ page }) => {
  await openProbe(page);
  await page.evaluate((entries) => {
    window.chatProbe.setConversation(entries);
    window.chatProbe.setTurnInFlight(true);
    window.chatProbe.setPreview(null);
    window.chatProbe.setAwaitingReply(true);
  }, SUBMITTED);

  const row = await page.evaluate(() => window.chatProbe.awaitingRow());
  expect(row, "the turn is mounted and no delta has painted, so her side of the flow must not be blank").not.toBeNull();
  expect(row?.avatar, "the row is hers, so it carries her picture the way every one of her rows does").toBe(true);
  expect(row?.ariaBusy, "the row is about to be replaced by her reply").toBe("true");
  // Drawn, not merely rendered: a row that exists at zero height is the silence with extra steps.
  expect(row?.height ?? 0, `the row paints a box: ${JSON.stringify(row)}`).toBeGreaterThan(0);
  expect(row?.width ?? 0).toBeGreaterThan(0);
});

/**
 * And it is drawn where the player was left waiting: the 400x800 strip, where the app bar retires its status WORD to the
 * bare pulsing dot (`style.css`, the container query at 720 px) - so the bar carried no sentence at the width the
 * complaint came from, and this row is the whole of what tells "working" from "broken" there.
 */
test("the row is drawn on the strip where the bar keeps only its dot", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openProbe(page);
  await page.evaluate((entries) => {
    window.chatProbe.setConversation(entries);
    window.chatProbe.setAwaitingReply(true);
  }, SUBMITTED);

  const row = await page.evaluate(() => window.chatProbe.awaitingRow());
  expect(row?.text, "the word is on screen at the measured width").toBeTruthy();
  expect(row?.height ?? 0, `the row keeps a box at ${PHONE.width}x${PHONE.height}`).toBeGreaterThan(0);
  expect(row?.width ?? 0).toBeLessThanOrEqual(PHONE.width);
});

test("the row says the bar's own word, once", async ({ page }) => {
  await openProbe(page);
  await page.evaluate((entries) => {
    window.chatProbe.setConversation(entries);
    window.chatProbe.setAwaitingReply(true);
  }, SUBMITTED);

  const read = await page.evaluate(() => ({
    row: window.chatProbe.awaitingRow(),
    english: window.chatProbe.awaitingSentence("en"),
    chinese: window.chatProbe.awaitingSentence("zh-CN"),
  }));
  // The catalogue's own word for a turn in flight is the row's word: one fact, one spelling.
  expect(read.row?.text).toBe(read.english);
  expect(read.chinese.length).toBeGreaterThan(0);
  expect(read.chinese).not.toBe(read.english);
  // And it is not a second polite region: the app bar already announces this moment.
  expect(read.row?.liveRegion, "a second role=status over the same moment speaks it twice").toBe(false);
});

test("the row is not one of the transcript's rows", async ({ page }) => {
  await openProbe(page);
  await page.evaluate((entries) => {
    window.chatProbe.setConversation(entries);
    window.chatProbe.setAwaitingReply(true);
  }, SUBMITTED);

  const row = await page.evaluate(() => window.chatProbe.awaitingRow());
  expect(row?.inMessageList, "the row is not durable, so it is not an <li> of the transcript").toBe(false);
  expect(row?.isTail, "it stands where her reply will arrive, under the player's own line").toBe(true);
});

test("her first word ends the window", async ({ page }) => {
  await openProbe(page);
  await page.evaluate((entries) => {
    window.chatProbe.setConversation(entries);
    window.chatProbe.setAwaitingReply(true);
  }, SUBMITTED);
  await page.evaluate(() => window.chatProbe.setPreview("东边那片"));
  // The shell derives the fact from the preview's existence, so the journey drives both halves the way it does.
  await page.evaluate(() => window.chatProbe.setAwaitingReply(false));

  expect(await page.evaluate(() => window.chatProbe.awaitingRow())).toBeNull();
});

test("a settled turn leaves no row", async ({ page }) => {
  await openProbe(page);
  await page.evaluate((entries) => {
    window.chatProbe.setConversation(entries);
    window.chatProbe.setTurnInFlight(false);
    window.chatProbe.setAwaitingReply(false);
  }, SUBMITTED);

  expect(await page.evaluate(() => window.chatProbe.awaitingRow())).toBeNull();
});
