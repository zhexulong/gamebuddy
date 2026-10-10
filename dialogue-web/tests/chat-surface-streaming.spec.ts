import { expect, test, type Page } from "@playwright/test";

/**
 * The typewriter delta must be contained to the preview bubble.
 *
 * The failure this catches: the event stream sets a new `preview` state on every
 * `companion.delta`, and the transcript is rendered in the same tree. If a
 * settled message re-renders on that state change, its Markdown is re-parsed and
 * re-sanitised on every token - the cost grows with the length of the
 * conversation, which is the jank the review reported at the composer.
 *
 * The probe's committed messages expose an instrumented `text` accessor, so a
 * read means the bubble's body genuinely ran (React.memo compares the `message`
 * prop by reference and bails without reading it). The test streams 30 deltas
 * into a 40-message conversation and requires zero reads: streaming cost is
 * independent of how long the conversation already is.
 */

type ChatProbe = {
  setTranscript(texts: readonly string[]): void;
  setPreview(text: string | null): void;
  bubbleHtml(handle: string): string | null;
  totalTextReads(): number;
  resetTextReads(): void;
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

test("a streaming delta does not re-render settled messages", async ({ page }) => {
  await openProbe(page);
  const heavy = Array.from(
    { length: 40 },
    (_, index) => `Paragraph ${index} with *beat ${index}* and \`code ${index}\`.\n\nSecond paragraph for rhythm.`,
  );
  await page.evaluate((texts) => window.chatProbe.setTranscript(texts), heavy);

  // Establish the stream: a seed preview, then zero the settled-message
  // counters, so any read from here on is a settled message re-rendering.
  await page.evaluate(() => {
    window.chatProbe.setPreview("seed");
    window.chatProbe.resetTextReads();
  });
  let streamed = "";
  for (let index = 0; index < 30; index += 1) {
    streamed += `token${index} `;
    await page.evaluate((text) => window.chatProbe.setPreview(text), streamed);
  }

  // The preview tracked the stream...
  const previewHtml = await page.evaluate(() => window.chatProbe.bubbleHtml("T_preview"));
  expect(previewHtml).toContain("token29");
  // ...and no settled message was read even once across 30 deltas.
  expect(await page.evaluate(() => window.chatProbe.totalTextReads())).toBe(0);
});
