import { expect, test, type Page } from "@playwright/test";

/**
 * Streaming must not yank the viewport out from under a reader who scrolled up.
 *
 * The failure this catches: `Timeline` re-runs its scroll effect on every
 * streaming delta (`preview.text` changes on every token), and the old effect
 * assigned `scrollTop = scrollHeight` unconditionally. A player reading back
 * through a long reply was pulled to the bottom every few dozen milliseconds.
 *
 * These are measured numbers, not class names: the spec reads the transcript
 * scroller's real `scrollTop`/`scrollHeight`/`clientHeight` before and after a
 * stream, both while the reader is parked at the tail (must follow) and after
 * they scrolled away from it (must be preserved).
 */

type ChatProbe = {
  setTranscript(texts: readonly string[]): void;
  setPreview(text: string | null): void;
  timelineScroll(): { scrollTop: number; scrollHeight: number; clientHeight: number } | null;
  setTimelineScrollTop(top: number): void;
};

declare global {
  interface Window {
    chatProbe: ChatProbe;
  }
}

const TAIL_FOLLOW_THRESHOLD_PX = 24;

/** Let React flush its commit and the browser settle layout before measuring. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function openScrollingProbe(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  // The shared probe is unbounded; bound it so the transcript really scrolls.
  await page.addStyleTag({
    content: "#probe-root { height: 320px; display: flex; flex-direction: column; }",
  });
  const heavy = Array.from({ length: 30 }, (_, index) => `Paragraph ${index}. ${"x".repeat(160)}`);
  await page.evaluate((texts) => window.chatProbe.setTranscript(texts), heavy);
  await page.evaluate(() => window.chatProbe.setPreview("seed"));
}

test("streaming follows the tail while the reader is at the bottom and leaves them alone once they scroll up", async ({
  page,
}) => {
  await openScrollingProbe(page);
  await page.waitForFunction(() => {
    const scroll = window.chatProbe.timelineScroll();
    return scroll !== null && scroll.scrollHeight > scroll.clientHeight;
  });
  // Park at the tail the way a reader does, so the stream starts from the
  // normal "following the newest content" state regardless of load timing.
  await page.evaluate(() => {
    const scroll = window.chatProbe.timelineScroll()!;
    window.chatProbe.setTimelineScrollTop(scroll.scrollHeight);
  });

  // Normal case: parked at the tail, a stream keeps the newest token in view.
  let streamed = "seed";
  for (let index = 0; index < 20; index += 1) {
    streamed += ` token${index}`;
    await page.evaluate((text) => window.chatProbe.setPreview(text), streamed);
  }
  await settle(page);
  // A `scroll-behavior`/layout settle may mean the last programmatic follow is
  // still converging; poll to the settled state, then measure it.
  await page.waitForFunction(
    () => {
      const scroll = window.chatProbe.timelineScroll();
      return scroll !== null && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 24;
    },
    undefined,
    { timeout: 2_000 },
  );
  const following = await page.evaluate(() => window.chatProbe.timelineScroll()!);
  expect(following.scrollHeight - following.scrollTop - following.clientHeight).toBeLessThanOrEqual(
    TAIL_FOLLOW_THRESHOLD_PX,
  );

  // The reader scrolls up to re-read: the stream must not pull them back.
  await page.evaluate(() => window.chatProbe.setTimelineScrollTop(0));
  const beforeScroll = await page.evaluate(() => window.chatProbe.timelineScroll()!);
  expect(beforeScroll.scrollTop).toBe(0);
  for (let index = 0; index < 20; index += 1) {
    streamed += ` more${index}`;
    await page.evaluate((text) => window.chatProbe.setPreview(text), streamed);
  }
  await settle(page);
  const afterScroll = await page.evaluate(() => window.chatProbe.timelineScroll()!);
  expect(afterScroll.scrollTop).toBe(beforeScroll.scrollTop);

  // Scrolling back to the tail re-arms following: the next token is brought in.
  await page.evaluate(() => {
    const scroll = window.chatProbe.timelineScroll()!;
    window.chatProbe.setTimelineScrollTop(scroll.scrollHeight);
  });
  await page.evaluate((text) => window.chatProbe.setPreview(`${text} again`), streamed);
  await settle(page);
  const rearmed = await page.evaluate(() => window.chatProbe.timelineScroll()!);
  expect(rearmed.scrollHeight - rearmed.scrollTop - rearmed.clientHeight).toBeLessThanOrEqual(
    TAIL_FOLLOW_THRESHOLD_PX,
  );
});
