import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "./frontend-coverage";
import { COMPANION_REPLY_GRAMMAR, replyConstruct } from "../src/components/companion-reply-grammar";

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
 *    colour as speech. This resolves the computed colour against the narration
 *    token and against the *disabled* token, so a missing rule, a drifted one or
 *    a beat painted in the grey a disabled control is drawn in all fail here
 *    instead of looking acceptable in a screenshot.
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
 * 6. `Enter sends and Shift+Enter writes a newline` - a companion chat is
 *    multi-line by nature, so the two keys have to do different things: without
 *    the Shift branch a player who presses Enter mid-thought fires a half-written
 *    message, and a composer that swallowed Shift+Enter into a send would make a
 *    second paragraph impossible. The assertion reads the field *and* the send
 *    log, because a composer that fired the send and left the text behind would
 *    look correct in the DOM alone.
 * 7. `the zero-message anchor appears only while the transcript is empty` - a
 *    brand-new conversation renders no bubbles, and a first screen that says
 *    nothing at all is indistinguishable from a surface that failed to load.
 *    The assertion pins the anchor to exactly the zero-message case (it has to
 *    be gone again the moment one message exists, or it would sit above every
 *    conversation) and resolves its colour against `--palette-gray-400`, so a
 *    drifted or missing rule fails here instead of in a screenshot.
 * 8. `a code block and a quote carry the card tone and the glass hairline` - a
 *    companion that formats its reply (a quoted line, a fenced block) is paying
 *    for that shape to read as hierarchy; a block left on the prose treatment,
 *    or on a colour written by hand, is a shape the player has to guess at. The
 *    assertion resolves both blocks against the tokens themselves.
 */

type ChatProbe = {
  setTranscript(texts: readonly string[]): void;
  setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void;
  setPreview(text: string | null): void;
  bubbleHtml(handle: string): string | null;
  bubbleText(handle: string): string | null;
  narrationStyle(
    handle: string,
  ): { color: string; expectedColor: string; disabledColor: string; fontStyle: string } | null;
  composerValue(): string | null;
  sends(): readonly string[];
  resetSends(): void;
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
  // A stage direction is a quieter voice, not an unavailable control: the grey a
  // disabled control's own text is drawn in is on the player's burgundy bubble
  // under the 4.5:1 floor, so the beat must not resolve to it.
  expect(style?.color).not.toBe(style?.disabledColor);
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

/**
 * One assertion per key, and one on the hint that teaches them.
 *
 * The failure it catches: a composer that sends on every Enter - the shape this
 * surface would take by default - makes a two-paragraph message impossible,
 * while a composer that inserts a newline on plain Enter never sends at all.
 * Both are invisible in a screenshot of a one-line draft, so the assertion
 * presses both keys and reads the field *and* the surface's send log.
 */
test("Enter sends and Shift+Enter writes a newline", async ({ page }) => {
  await openProbe(page);
  const composer = page.locator("textarea.composer-textarea");
  await expect(composer).toBeVisible();

  // The discoverability carrier for the same two keys, in the field the player
  // is already looking at: a shortcut nobody is told about is not ergonomics.
  await expect(composer).toHaveAttribute("placeholder", /Enter to send, Shift\+Enter for newline/);

  await composer.click();
  await page.keyboard.type("First line");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("Second line");

  // Shift+Enter stayed inside the one drafted message and sent nothing.
  expect(await page.evaluate(() => window.chatProbe.composerValue())).toBe("First line\nSecond line");
  expect(await page.evaluate(() => window.chatProbe.sends())).toEqual([]);

  await page.keyboard.press("Enter");
  // The same message, newline and all, went out; Enter did not stay in the field.
  expect(await page.evaluate(() => window.chatProbe.sends())).toEqual(["First line\nSecond line"]);
  await expect(composer).toHaveValue("");
});

/**
 * The zero-message state, and the two things about it that a screenshot cannot
 * tell apart: that it is present *only* with zero messages, and that its line is
 * drawn in the secondary warm grey the token layer names.
 */
test("the zero-message anchor appears only while the transcript is empty", async ({ page }) => {
  await openProbe(page);
  await setTranscript(page, []);

  const anchor = page.locator("[data-empty-anchor]");
  await expect(anchor).toHaveCount(1);
  // The zero state is one invitation that names the companion; the app bar
  // above already carries the monogram and the name, so there is no second plate.
  await expect(anchor.locator(".empty-state-nameplate")).toHaveCount(0);
  await expect(anchor.locator(".empty-state-opening")).toContainText("Mira");

  const drawn = await page.evaluate(() => {
    const line = document.querySelector("[data-empty-anchor] .empty-state-opening");
    const probe = document.createElement("span");
    probe.style.color = "var(--palette-gray-400)";
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { color: line === null ? null : getComputedStyle(line).color, expected };
  });
  expect(drawn.color).toBe(drawn.expected);

  // One message, and the anchor is gone - it never sits above a live transcript.
  await setTranscript(page, ["The first thing the companion says."]);
  await expect(anchor).toHaveCount(0);
  await expect(page.locator("li[data-handle='h0'] .message-bubble")).toBeVisible();
});

/**
 * Item 4: the two Markdown blocks that carry a shape of their own inside a
 * companion's prose - a fenced code block and a quote.
 *
 * The failure it catches: either block left on the previous tone (or on a colour
 * written by hand) is indistinguishable from the paragraphs around it, so a
 * companion that emits formatted text loses exactly the hierarchy the shape was
 * for. Both are resolved against the tokens themselves, so a drifted or missing
 * rule fails here rather than looking acceptable in a screenshot.
 */
test("a code block and a quote carry the card tone and the glass hairline", async ({ page }) => {
  await openProbe(page);
  await setTranscript(page, ["A paragraph of prose.\n\n> a quoted line\n\n```\nconst answer = 42;\n```"]);

  const blocks = await page.evaluate(() => {
    const token = (name: string) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${name})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    const read = (selector: string) => {
      const element = document.querySelector(`li[data-handle='h0'] ${selector}`);
      if (element === null) return null;
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        borderTopWidth: style.borderTopWidth,
        borderTopColor: style.borderTopColor,
      };
    };
    return {
      card: token("--surface-card"),
      glass: token("--border-glass"),
      prose: read("p"),
      quote: read("blockquote"),
      code: read("pre"),
    };
  });

  expect(blocks.quote, "the quote is rendered").not.toBeNull();
  expect(blocks.code, "the code block is rendered").not.toBeNull();
  for (const [what, block] of [
    ["the quote", blocks.quote],
    ["the code block", blocks.code],
  ] as const) {
    expect(block?.background, `${what} carries the card tone`).toBe(blocks.card);
    expect(block?.borderTopWidth, `${what} draws the hairline`).toBe("1px");
    expect(block?.borderTopColor, `${what} carries the glass border`).toBe(blocks.glass);
  }
  // The prose beside them is the bubble itself, not a card: the two blocks are
  // told apart from the paragraph, not painted the same as everything.
  expect(blocks.prose?.background).toBe("rgba(0, 0, 0, 0)");
});

// --- the shipped card's own lines ---------------------------------------------------

/**
 * The reviewed card the product actually ships, and the lines it teaches with.
 *
 * The card is the artefact that owns the companion's voice, so its own `first_mes` and
 * `mes_example` are the only corpus that cannot be wrong about what a reply looks like:
 * every line here was authored, reviewed and shipped as a turn this companion says or
 * receives. A renderer that consumes a construct out of those lines - drops a
 * parenthetical, or repaints it as a different construct - is a renderer that disagrees
 * with the voice it is drawing.
 *
 * Population, derived from the file: the gate reads the card on disk rather than a
 * transcription of it, so a line added to the card is judged the day it lands, and the
 * failure names the line.
 */
const CARD_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "assets",
  "tavern",
  "presets",
  "default-companion",
  "card.json",
);

type CardTurn = Readonly<{ label: string; role: "player" | "companion"; text: string }>;

function shippedCardTurns(): CardTurn[] {
  const card = JSON.parse(readFileSync(CARD_PATH, "utf8")) as {
    data: { first_mes: string; alternate_greetings?: string[]; mes_example: string };
  };
  const data = card.data;
  const turns: CardTurn[] = [{ label: "first_mes", role: "companion", text: data.first_mes }];
  for (const [index, greeting] of (data.alternate_greetings ?? []).entries())
    turns.push({ label: `alternate_greetings[${index}]`, role: "companion", text: greeting });
  for (const [index, scene] of data.mes_example.split("<START>").entries()) {
    const player = scene.split("{{user}}:")[1]?.split("{{char}}:")[0]?.trim();
    const companion = scene.split("{{char}}:")[1]?.trim();
    if (player !== undefined && player.length > 0)
      turns.push({ label: `mes_example[${index}].player`, role: "player", text: player });
    if (companion !== undefined && companion.length > 0)
      turns.push({ label: `mes_example[${index}].companion`, role: "companion", text: companion });
  }
  return turns;
}

/**
 * Every word the card wrote reaches the player.
 *
 * The failure this catches, measured on the shipped card: `（站在田埂上看着远山没动静）`
 * is a bracketed stage direction the card demonstrates as the player's own input, and the
 * renderer consumed its parentheses as the leading prosody tag - the treatment for a tone
 * the VOICE layer performs rather than speaks. A player's own action, or their note, was
 * repainted as a direction for the companion's tone, and the syntax the card used to write
 * it was deleted from the bubble.
 *
 * It is a comparison of what the player can READ against what the card wrote, not of the
 * markup: a construct the renderer is entitled to consume (`*beat*` delimiters, and the
 * parentheses of a leading prosody tag in the companion's own reply) is not asserted here,
 * because the card's authored lines use neither.
 */
test("every word of the shipped card's own lines reaches the player", async ({ page }) => {
  await openProbe(page);
  const turns = shippedCardTurns();
  expect(turns.length, "the card's authored lines are this gate's population").toBeGreaterThan(20);
  await page.evaluate(
    (entries) => window.chatProbe.setConversation(entries),
    turns.map(({ role, text }) => ({ role, text })),
  );

  for (const [index, turn] of turns.entries()) {
    const shown = await page.evaluate((handle) => window.chatProbe.bubbleText(handle), `h${index}`);
    expect(shown, `${turn.label} (${turn.role}): the card's own words reach the player`).toBe(turn.text);
  }
});

// --- the reply grammar ----------------------------------------------------------------

/**
 * One declaration, two halves, and this is the seam where they are held together.
 *
 * `companion-reply-grammar.ts` declares what a reply may be made of. The renderer's
 * sanitizer allowlist IS that declaration's tag union, so the forward direction is a
 * property of the construction; what the assertions below prove is that the construction
 * still holds and that each declared construct reaches the player as the treatment the
 * declaration promises. The failure each one catches is a real drift that shipped: the
 * shipped card forbade every parenthesis while the renderer painted a leading one, and the
 * card's own `mes_example` demonstrated the construct its text banned.
 *
 * Population: the declaration itself, so a construct added there is judged the day it
 * lands, and a construct that stops being painted fails by name.
 */
test("every construct the reply grammar declares is one the bubble draws", async ({ page }) => {
  await openProbe(page);
  expect(COMPANION_REPLY_GRAMMAR.length, "the grammar's constructs are this gate's population").toBeGreaterThan(8);

  for (const construct of COMPANION_REPLY_GRAMMAR) {
    await setTranscript(page, [construct.sample]);
    const html = await bubbleHtml(page, "h0");
    switch (construct.paint) {
      case "speech":
        expect(html, `${construct.id}: the words are drawn as a prose block`).toContain("<p>");
        expect(html, `${construct.id}: the words themselves are drawn`).toContain(construct.sample);
        break;
      case "action-beat":
        // Painted as the narration element, and its delimiters are consumed: a beat left
        // as literal asterisks is the renderer not drawing what the grammar declares.
        expect(html, `${construct.id}: the beat is drawn as an element`).toContain("<em");
        expect(html, `${construct.id}: the beat's delimiters are consumed, not printed`).not.toContain("*");
        break;
      case "prosody-badge":
        expect(html, `${construct.id}: the tag is drawn as the badge plate`).toContain("data-mood-tag");
        break;
      case "shape":
        for (const tag of construct.tags)
          expect(html, `${construct.id}: the declared <${tag}> element is drawn`).toContain(`<${tag}`);
        break;
    }
  }

  // The grammar's `speaker` is a paint rule too, not a comment: the one construct scoped to
  // the companion's reply must not appear on the player's. This is the direction that
  // failed on the shipped card's `（站在田埂上看着远山没动静）`.
  const prosody = replyConstruct("prosody-tag");
  await page.evaluate(() => window.chatProbe.setConversation([{ role: "player", text: "（轻声）种子出芽了。" }]));
  expect(
    await bubbleHtml(page, "h0"),
    `${prosody.id}: a player's parenthetical is their own stage direction, not a direction for her tone`,
  ).not.toContain("data-mood-tag");

  // And the shapes the grammar deliberately does NOT declare keep only their words. The
  // four below are the GFM constructs a reply could plausibly write; the allowlist is the
  // declaration's own tag union and drops everything else, so there is no second list here
  // that could drift - this pins the intent for the four, not the whole population.
  const undeclared = [
    { id: "table", sample: "| a | b |\n| - | - |\n| 1 | 2 |" },
    { id: "heading", sample: "# 标题" },
    { id: "link", sample: "[文字](https://example.com)" },
    { id: "image", sample: "![图](https://example.com/x.png)" },
  ];
  for (const shape of undeclared) {
    await setTranscript(page, [shape.sample]);
    const html = await bubbleHtml(page, "h0");
    for (const tag of ["table", "th", "td", "h1", "a", "img"]) {
      expect(html, `${shape.id}: <${tag}> is not a construct of a reply, so it is not painted`).not.toContain(`<${tag}`);
    }
  }
});
