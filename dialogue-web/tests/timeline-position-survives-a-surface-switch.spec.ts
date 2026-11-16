import { expect, test, type Page } from "./frontend-coverage";
import { chat, jsonOk, root, token } from "./composed-reference-game-fixtures";

/**
 * The conversation comes back to the line the player was reading.
 *
 * The measured defect: the shell rendered `<ChatSurface>` only while the conversation was the
 * selected surface (`shownSurface === CHAT_PANEL`), so glancing at the game unmounted the
 * transcript, and `Timeline`'s mount effect - which brings the newest content into view because
 * `atBottomRef` starts `true` - put the reader back at the tail when it mounted again. A player
 * who had scrolled back through a long conversation to re-read something, looked at the game, and
 * returned was shown the newest line instead of their place.
 *
 * These are measured numbers, not class names: the spec reads the transcript scroller's real
 * `scrollTop`/`scrollHeight`/`clientHeight`, the row crossing the scroller's top edge (the line
 * being read) and that row's offset from the edge, before and after one surface switch.
 *
 * What the fix must keep, and what these journeys hold:
 *  - a deliberate switch away and back preserves the position (the reader's own place wins);
 *  - a reply that lands while the conversation is parked still brings the tail into view, because
 *    "the reader is following the newest content" is the state that had to survive too;
 *  - the parked conversation is the SAME transcript, mounted and out of the way: one `.timeline`
 *    in the document, one announcement region, and neither exposed while it is parked.
 */

/** The row geometry a reading position is: where the scroller is, and which line is at its top edge. */
type Reading = Readonly<{
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** The row crossing the scroller's top edge - the line the player was reading. */
  topHandle: string | null;
  /** How far into the viewport that row starts, so "the same line" is also "at the same place". */
  topOffset: number;
  /** The transcript's last row, and whether it is inside the scroller's box. */
  tailHandle: string | null;
  tailInView: boolean;
}>;

/** How close to the end counts as "the reader is at the tail" (`Timeline`'s own threshold). */
const TAIL_FOLLOW_THRESHOLD_PX = 24;

/** A row is a canonical opaque handle: 22-128 chars of unpadded base64url. */
function messageHandle(index: number): string {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(index + 1, 0);
  bytes.fill(0x5a, 4);
  return bytes.toString("base64url");
}

/** A conversation long enough that the transcript scrolls at every declared viewport. */
function transcriptOf(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    handle: messageHandle(index),
    role: index % 2 === 0 ? "companion" : "player",
    text: `Line ${index}. ${"The farm keeps its own weather and the valley answers to it. ".repeat(3)}`,
    locale: "und",
    order: index,
    revision: 1,
  }));
}

type Host = Readonly<{
  /** What the next read publishes: the same conversation, or the same one plus one more reply. */
  publish: (transcript: ReturnType<typeof transcriptOf>) => void;
}>;

/**
 * Mounts the shell on a long conversation, and lets the journey move the projection the way the
 * Host does while another surface is open - the arrival read publishes it, not a local append.
 */
async function mountLongConversation(page: Page, transcript: ReturnType<typeof transcriptOf>): Promise<Host> {
  let published = transcript;
  const projection = () => ({
    ...root,
    chat: { ...chat, chat: { ...chat.chat, transcript: published } },
  });
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  return {
    publish: (next) => {
      published = next;
    },
  };
}

/** The scroller's own numbers and the two rows that say where the reader is. */
async function readReading(page: Page): Promise<Reading> {
  return await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("section.timeline");
    if (scroller === null) throw new Error("the transcript has no scroller");
    const box = scroller.getBoundingClientRect();
    const rows = [...scroller.querySelectorAll<HTMLElement>("li[data-handle]")];
    const painted = (row: HTMLElement): boolean => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > box.top && rect.top < box.bottom;
    };
    const crossing = rows.find(painted) ?? null;
    const tail = rows[rows.length - 1] ?? null;
    return {
      scrollTop: Math.round(scroller.scrollTop),
      scrollHeight: Math.round(scroller.scrollHeight),
      clientHeight: Math.round(scroller.clientHeight),
      topHandle: crossing?.getAttribute("data-handle") ?? null,
      topOffset: crossing === null ? 0 : Math.round(crossing.getBoundingClientRect().top - box.top),
      tailHandle: tail?.getAttribute("data-handle") ?? null,
      tailInView: tail !== null && painted(tail),
    };
  });
}

/** How much of the transcript is below the reader: 0 is the tail. */
function tailGap(reading: Reading): number {
  return reading.scrollHeight - reading.scrollTop - reading.clientHeight;
}

test("a deliberate surface switch returns the reader to the line they were reading", async ({ page }) => {
  test.setTimeout(90_000);
  await mountLongConversation(page, transcriptOf(40));

  // The mount lands at the tail - the behaviour the remount used to repeat over a reader's place.
  await expect.poll(async () => tailGap(await readReading(page))).toBeLessThanOrEqual(TAIL_FOLLOW_THRESHOLD_PX);
  const opened = await readReading(page);
  expect(opened.scrollHeight, "the conversation really scrolls").toBeGreaterThan(opened.clientHeight + 600);

  // The player scrolls back through the conversation by a stated amount, and the transcript's own
  // scroll listener sees it (`Timeline` tracks the reader's position from exactly this event):
  // 700 px up from the tail.
  const scrolledBack = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("section.timeline");
    if (scroller === null) throw new Error("the transcript has no scroller");
    scroller.scrollTop -= 700;
    scroller.dispatchEvent(new Event("scroll"));
    return Math.round(scroller.scrollTop);
  });
  const before = await readReading(page);
  expect(before.scrollTop, "the scroller moved by the stated amount").toBe(scrolledBack);
  expect(before.scrollTop, "and the player really left the tail").toBeLessThan(opened.scrollTop - 500);
  expect(tailGap(before), "the reader has left the tail").toBeGreaterThan(TAIL_FOLLOW_THRESHOLD_PX);
  expect(before.topHandle, "and is reading a line of the conversation").not.toBeNull();

  // Glance at the game, then come back.
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  const after = await readReading(page);

  console.log(
    `MEASURE reading-position: before=${JSON.stringify(before)} after=${JSON.stringify(after)} ` +
      `| scrolled up ${opened.scrollTop - before.scrollTop} px, ${tailGap(before)} px of history below`,
  );

  expect(after.scrollHeight, "the same conversation is on screen").toBe(before.scrollHeight);
  expect(after.scrollTop, "the scroller is where the player left it").toBeGreaterThanOrEqual(
    before.scrollTop - 2,
  );
  expect(after.scrollTop, "the scroller is where the player left it").toBeLessThanOrEqual(before.scrollTop + 2);
  expect(after.topHandle, "the line under the top edge is still the line being read").toBe(before.topHandle);
  expect(
    Math.abs(after.topOffset - before.topOffset),
    "and it sits where it sat, so the reader's eye does not have to find it again",
  ).toBeLessThanOrEqual(2);
  expect(tailGap(after), "the reader was not put back at the tail").toBeGreaterThan(TAIL_FOLLOW_THRESHOLD_PX);
});

test("a reply that lands while the conversation is parked still brings the tail into view", async ({ page }) => {
  test.setTimeout(90_000);
  const transcript = transcriptOf(40);
  const host = await mountLongConversation(page, transcript);

  // The player is at the tail, reading along, and the Host writes one more reply while they are
  // looking at the game. Arriving at the conversation publishes it (`useArrivalReread`).
  await expect.poll(async () => tailGap(await readReading(page))).toBeLessThanOrEqual(TAIL_FOLLOW_THRESHOLD_PX);
  const longer = transcriptOf(41);
  host.publish(longer);
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.locator(`li[data-handle="${messageHandle(40)}"]`), "the reply arrived").toHaveCount(1);
  await expect.poll(async () => tailGap(await readReading(page))).toBeLessThanOrEqual(TAIL_FOLLOW_THRESHOLD_PX);
  const after = await readReading(page);

  console.log(`MEASURE tail-follow: after=${JSON.stringify(after)} tailGap=${tailGap(after)}`);
  expect(after.tailHandle, "the newest reply is the transcript's last row").toBe(messageHandle(40));
  expect(after.tailInView, "and it is inside the viewport, not below it").toBe(true);
});

test("the parked conversation is one transcript, out of the way and out of the accessibility tree", async ({ page }) => {
  test.setTimeout(90_000);
  await mountLongConversation(page, transcriptOf(12));

  // While the conversation is selected there is exactly one transcript and one announced channel.
  await expect(page.locator("section.timeline"), "one transcript, never a second live one").toHaveCount(1);
  await expect(page.locator('[data-testid="chat-announcement"]')).toHaveCount(1);
  const timeline = page.locator("section.timeline");
  await expect(timeline.locator('[role="status"]'), "the conversation's one spoken fact").toHaveCount(1);

  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();

  // Still mounted, so its reading position and its scroll box survive...
  await expect(page.getByTestId("chat-surface"), "the conversation stays mounted").toHaveCount(1);
  await expect(page.locator("section.timeline"), "and it is still one transcript").toHaveCount(1);
  // ...and not drawn, not focusable, and not announced.
  await expect(page.getByTestId("chat-surface"), "the parked conversation is not drawn").toBeHidden();
  await expect(page.getByTestId("chat-surface").locator('[data-testid="chat-announcement"]')).toBeHidden();
  await expect(
    page.getByRole("region", { name: "Chat transcript" }),
    "the parked conversation is not in the accessibility tree, so it announces nothing",
  ).toHaveCount(0);

  // Back on the conversation it is the same one transcript - a switch adds no second channel.
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.locator("section.timeline")).toHaveCount(1);
  await expect(page.locator('[data-testid="chat-announcement"]')).toHaveCount(1);
});
