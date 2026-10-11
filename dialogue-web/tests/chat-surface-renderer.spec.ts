import { expect, test, type Page } from "@playwright/test";

/**
 * The conversation surface's presentation contract, mounted.
 *
 * These are the failures each test catches - the reason the assertion exists,
 * not a restatement of the code:
 *
 * 1. `renders the model's text inert` - the companion's reply is model output,
 *    so a reply containing `<script>`, an `<img onerror>` or a
 *    `javascript:` link must reach the document as text. Without the
 *    sanitise pass the raw string would be injected into the bubble and the
 *    handler would run in the player's session.
 * 2. `gives an italic beat its own class` - `*nods*` is a stage direction and
 *    must be distinguishable from speech so narration can read as narration;
 *    a reply that renders every emphasis identically loses that.
 * 2b. `renders a narration beat with the reading treatment` - the class being
 *    mounted is not the treatment: with no rule for `.message-action` a stage
 *    direction is drawn in the browser's default italic *and* in the same
 *    colour as speech. This resolves the computed colour against the token, so
 *    a missing or drifted rule fails here instead of looking acceptable in a
 *    screenshot.
 * 3. `renders the model-written class inert` - an explicit allowlist with no
 *    attributes must strip a `class=`/`data-` the model wrote, so model text
 *    can never fabricate the narration class or any other surface hook.
 * 4. `renders blocks, lists, quotes and code` - the shape of the reply
 *    (paragraphs, lists, quotes, code) has to survive; rendering it as one
 *    run-on line is exactly the chat-log failure this work exists to remove.
 * 5. `settled preview and committed message render identically` - the detached
 *    streaming preview must not use a second, poorer renderer: the bytes the
 *    player saw while streaming must be the bytes of the committed message, or
 *    the reply "changes" as it settles.
 */

type ChatProbe = {
  setTranscript(texts: readonly string[]): void;
  setPreview(text: string | null): void;
  bubbleHtml(handle: string): string | null;
  narrationStyle(handle: string): { color: string; expectedColor: string; fontStyle: string } | null;
  textReads(handle: string): number;
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

async function setTranscript(page: Page, texts: readonly string[]): Promise<void> {
  await page.evaluate((values) => window.chatProbe.setTranscript(values), texts);
}

async function bubbleHtml(page: Page, handle: string): Promise<string> {
  const html = await page.evaluate((value) => window.chatProbe.bubbleHtml(value), handle);
  expect(html, `no bubble rendered for ${handle}`).not.toBeNull();
  return html as string;
}

test("renders the model's text inert", async ({ page }) => {
  await openProbe(page);
  await setTranscript(page, [
    [
      "before",
      '<script>window.__pwned = "script";</script>',
      '<img src="x" onerror="window.__pwned = \'img\';" />',
      '<a href="javascript:window.__pwned = \'href\';">link</a>',
      "after",
    ].join(" "),
  ]);

  const html = await bubbleHtml(page, "h0");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onerror");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("javascript:");
  // The words themselves are not dropped - they are just inert.
  expect(html).toContain("before");
  expect(html).toContain("after");
  expect(html).toContain("link");
  // Nothing dangerous became an element, and nothing ran.
  expect(await page.locator("li[data-handle='h0'] script, li[data-handle='h0'] img, li[data-handle='h0'] a").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: string }).__pwned)).toBeUndefined();
});

test("gives an italic beat its own class", async ({ page }) => {
  await openProbe(page);
  await setTranscript(page, ["*nods slowly*\nShe looks up."]);

  const html = await bubbleHtml(page, "h0");
  expect(html).toContain('<em class="message-action">nods slowly</em>');
  await expect(page.locator("li[data-handle='h0'] em.message-action")).toHaveCount(1);
  await expect(page.locator("li[data-handle='h0'] em.message-action")).toHaveText("nods slowly");
});

test("renders a narration beat with the reading treatment", async ({ page }) => {
  await openProbe(page);
  await setTranscript(page, ["*nods slowly*\nShe looks up."]);

  const style = await page.evaluate(() => window.chatProbe.narrationStyle("h0"));
  expect(style).not.toBeNull();
  // The computed colour IS the narration token, and it is not the colour of the
  // speech beside it - the de-emphasis is rendered, not merely named.
  expect(style?.color).toBe(style?.expectedColor);
  expect(style?.fontStyle).toBe("italic");
  const speech = await page.evaluate(
    () => getComputedStyle(document.querySelector("li[data-handle='h0'] p") as Element).color,
  );
  expect(style?.color).not.toBe(speech);
});

test("renders the model-written class inert", async ({ page }) => {
  await openProbe(page);
  await setTranscript(page, ['<p class="injected-class" data-x="1">text</p>']);

  const html = await bubbleHtml(page, "h0");
  expect(html).not.toContain("injected-class");
  expect(html).not.toContain("data-x");
  expect(html).toContain("text");
});

test("renders blocks, lists, quotes and code", async ({ page }) => {
  await openProbe(page);
  await setTranscript(page, [
    [
      "First paragraph.",
      "",
      "Second paragraph with `inline code` and **weight**.",
      "",
      "- one",
      "- two",
      "",
      "> quoted line",
      "",
      "```",
      "code block",
      "```",
    ].join("\n"),
  ]);

  const bubble = page.locator("li[data-handle='h0'] .message-bubble");
  await expect(bubble.locator("> p")).toHaveCount(2);
  await expect(bubble.locator("li")).toHaveCount(2);
  await expect(bubble.locator("blockquote")).toHaveCount(1);
  await expect(bubble.locator("pre > code")).toHaveCount(1);
  await expect(bubble.locator("code")).toHaveCount(2); // inline + block
  await expect(bubble.locator("strong")).toHaveText("weight");
});

test("settled preview and committed message render identically", async ({ page }) => {
  await openProbe(page);
  const settled = "*nods slowly*\n\nA paragraph with `code` and **weight**.\n\n- a\n- b";

  await setTranscript(page, []);
  await page.evaluate((text) => window.chatProbe.setPreview(text), settled);
  const previewHtml = await bubbleHtml(page, "T_preview");

  // The turn commits the same text the preview showed.
  await page.evaluate((text) => {
    window.chatProbe.setTranscript([text]);
    window.chatProbe.setPreview(null);
  }, settled);
  const committedHtml = await bubbleHtml(page, "h0");

  expect(committedHtml).toBe(previewHtml);
  expect(previewHtml).toContain('<em class="message-action">');
});
