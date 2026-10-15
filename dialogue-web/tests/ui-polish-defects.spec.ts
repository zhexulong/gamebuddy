import { expect, test, type Page } from "@playwright/test";

/**
 * The polish defects a three-reviewer audit of the shipped UI listed, each
 * asserted through a value the browser computes rather than through the source
 * that produced it - and each preceded by the measurement that decides whether
 * the review's item is real on this tree.
 *
 *   1. The action beat was painted in `--text-disabled` (`--palette-gray-400`,
 *      #90877e) at weight 600 in CJK, so a companion's stage direction read as a
 *      dead placeholder *and* was heavier than the dialogue beside it. Measured
 *      before: 4.74:1 on the companion card, 3.20:1 on the player's own bubble
 *      (under the 4.5:1 floor), zh weight 600 against the paragraph's 400.
 *      After: `--text-secondary`, 9.30:1 and 6.27:1, weight 400.
 *   2. `MarkdownMessage` rewrote full-width parentheses to ASCII as part of beat
 *      normalisation, which broke Chinese spacing without making Markdown read
 *      `（…）` as emphasis - the beat is authored `*…*`, so the paren rewrite was
 *      never part of that path.
 *   3. The composer placeholder named `Shift+Enter` at 400 px, where the field is
 *      212 px wide and the English hint needs three lines. It never raised a
 *      scrollbar (the field grows to `scrollHeight`), but the compact band paid
 *      two lines of dead hint height and advised a key a phone does not have.
 *   4. **Refuted.** The audit's "three stacked headings" is not on this tree: an
 *      untitled conversation renders exactly one heading, and the app bar's brand
 *      *word* is retired below 640 px. The gates below pin the refutation so it
 *      cannot come back.
 *   5. Two recommended models can share a model id from different providers, and
 *      the chip printed the id alone - two chips reading one identical word.
 *   6. **Refuted.** The composer is in flow, so it cannot cover the transcript:
 *      measured 72 px of clearance at 400x800 and 71 px at 1440x900 with the
 *      transcript scrolled to its end.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const handle = "B".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const worldBookRevision = "W".repeat(42) + "A";
const projectionRevision = "P".repeat(42) + "A";

/** Two providers publishing the same model id: the ambiguity the chips carried. */
const SAME_ID_TWO_PROVIDERS = [
  {
    providerId: "cpa-oai",
    providerLabel: "CPA OAI",
    modelId: "deepseek-v4-flash",
    modelLabel: "DeepSeek V4 Flash",
    allowedThinkingLevels: ["off", "medium", "high"],
    defaultThinkingLevel: "medium",
  },
  {
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    modelId: "deepseek-v4-flash",
    modelLabel: "DeepSeek V4 Flash (OR)",
    allowedThinkingLevels: ["off", "medium", "high"],
    defaultThinkingLevel: "medium",
  },
] as const;

type FixtureOptions = Readonly<{
  transcript?: readonly Readonly<{ role: "player" | "companion"; text: string }>[];
  /** `null` is a conversation the Host has published no title for at all. */
  title?: string | null;
  recommendedModels?: readonly unknown[];
  companionName?: string;
}>;

function composedRoot(options: FixtureOptions = {}) {
  const transcript = options.transcript ?? [];
  return {
    apiVersion: 1,
    build: {
      browserContract: "composed_reference_game_browser_api/v1",
      profileId: "gamebuddy.composed.reference-game",
    },
    chat: {
      apiVersion: 1,
      build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
      csrfToken,
      browserSession: { expiresAtMs },
      operations: [
        { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
      ],
      navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
      selection: { chatHandle: handle, generation: 1, stateRevision: handle },
      chat: {
        companion: { name: options.companionName ?? "Mira" },
        title: options.title === undefined ? null : options.title,
        transcript: transcript.map((message, index) => ({
          handle: `M${String(index).padStart(2, "0")}${"A".repeat(40)}`,
          role: message.role,
          text: message.text,
          locale: "und",
          order: index,
          revision: 1,
        })),
        draft: { revision: 0, present: false },
        turn: null,
        worldInfo: null,
      },
      memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
      eventStream: null,
    },
    game: {
      apiVersion: 1,
      build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
      csrfToken,
      browserSession: { expiresAtMs },
      game: {
        prerequisites: { status: "unknown", detectedGame: null, missingItems: [] },
        instance: { status: "none", gameTitle: null, generation: 0 },
        compatibility: { status: "unchecked", message: null },
        attachment: { status: "none", generation: 0 },
        connectionStatus: "none",
        actionAuthority: "unavailable",
        role: null,
        companionName: null,
        selectedWorld: null,
        selectedSave: null,
        capabilitySummary: { available: false, count: 0 },
        latestOutcome: "none",
      },
    },
  };
}

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function mountShell(
  page: Page,
  options: FixtureOptions & Readonly<{ locale?: string; reload?: boolean }> = {},
): Promise<void> {
  const locale = options.locale ?? "zh-CN";
  const root = composedRoot(options);
  await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), locale);
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: [] })),
  );
  await page.route(/\/api\/tavern\/v1\/chats(\?|$)/, (route) => route.fulfill(jsonOk({ apiVersion: 1, chats: [] })));
  await page.route("**/api/tavern/v1/memory", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, projectionRevision, memories: [], chapters: [] })),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: worldBookRevision, items: [] })),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(jsonOk({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null })),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) => route.fulfill(jsonOk({ devices: [], defaultSelectable: true })));
  await page.route("**/api/tavern/v1/settings/language", (route) => route.fulfill(jsonOk({ revision: 1, locale })));
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 1, active: null, connections: [], providers: [] })),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chat: { revision: 1, modelId: "deepseek-v4-flash", thinkingLevel: "medium" },
        game: { revision: 1, modelId: "deepseek-v4-flash", thinkingLevel: "medium" },
        recommendedModels: options.recommendedModels ?? [],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle, name: options.companionName ?? "Mira", isCurrent: true }] })),
  );
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null })),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));

  // The journey URL is one URL with a fragment, so a second `goto` to it is a
  // same-document navigation and would leave the first projection on screen. A
  // re-mount therefore reloads.
  if (options.reload === true) await page.reload();
  else await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
}

/**
 * The tones of the given selectors, measured exactly the way the runtime contrast
 * gate measures them: computed colour, the effective background composited up
 * through the ancestors to the first opaque one, and the WCAG ratio for the
 * element's own size and weight. One engine, so a reading here and a reading in
 * `runtime-frontend-gates.spec.ts` cannot disagree about what "the ratio" is.
 */
async function sampleContrast(page: Page, selectors: readonly string[]) {
  return page.evaluate((wanted: readonly string[]) => {
    const parse = (value: string): [number, number, number, number] => {
      const match = value.match(/rgba?\(([^)]+)\)/u);
      if (match === null) return [0, 0, 0, 0];
      const parts = match[1]!.split(",").map((part) => Number.parseFloat(part.trim()));
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    };
    const effective = (element: Element): [number, number, number] | null => {
      const stack: [number, number, number, number][] = [];
      let node: Element | null = element;
      while (node !== null) {
        const background = parse(getComputedStyle(node).backgroundColor);
        stack.push(background);
        if (background[3]! >= 0.999) break;
        node = node.parentElement;
      }
      const bottom = stack[stack.length - 1]!;
      if (bottom[3]! < 0.999) return null;
      let result = bottom;
      for (let index = stack.length - 2; index >= 0; index -= 1) {
        const top = stack[index]!;
        const alpha = top[3]!;
        result = [
          top[0]! * alpha + result[0]! * (1 - alpha),
          top[1]! * alpha + result[1]! * (1 - alpha),
          top[2]! * alpha + result[2]! * (1 - alpha),
          1,
        ];
      }
      return [result[0]!, result[1]!, result[2]!];
    };
    const luminance = ([red, green, blue]: readonly number[]): number => {
      const channel = (value: number): number => {
        const scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(red!) + 0.7152 * channel(green!) + 0.0722 * channel(blue!);
    };
    const ratio = (foreground: readonly number[], background: readonly number[]): number => {
      const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b! - a!);
      return (lighter! + 0.05) / (darker! + 0.05);
    };
    return wanted.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) return { selector, found: false as const };
      const style = getComputedStyle(element);
      const background = effective(element);
      const size = Number.parseFloat(style.fontSize);
      const weight = Number.parseInt(style.fontWeight, 10) || 400;
      return {
        selector,
        found: true as const,
        text: (element.textContent ?? "").trim().slice(0, 40),
        color: style.color,
        background:
          background === null ? "unresolved" : `rgb(${background.map((value) => Math.round(value)).join(",")})`,
        size,
        weight,
        fontStyle: style.fontStyle,
        letterSpacing: style.letterSpacing,
        ratio: background === null ? 0 : Number(ratio(parse(style.color), background).toFixed(2)),
      };
    });
  }, selectors);
}

/** How many line boxes the field's own placeholder occupies when it is painted. */
async function placeholderLineCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
    const style = getComputedStyle(textarea);
    const probe = document.createElement("div");
    probe.style.cssText = [
      "position:absolute",
      "visibility:hidden",
      "left:-9999px",
      `width:${textarea.clientWidth}px`,
      `font-family:${style.fontFamily}`,
      `font-size:${style.fontSize}`,
      `line-height:${style.lineHeight}`,
      `letter-spacing:${style.letterSpacing}`,
      "white-space:pre-wrap",
      "overflow-wrap:break-word",
    ].join(";");
    probe.textContent = textarea.placeholder;
    document.body.appendChild(probe);
    const range = document.createRange();
    range.selectNodeContents(probe);
    const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    probe.remove();
    return lines;
  });
}

/** The composer field's own box, as the browser laid it out. */
async function composerField(page: Page) {
  return page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
    const style = getComputedStyle(textarea);
    return {
      placeholder: textarea.placeholder,
      inlineHeight: textarea.style.height,
      clientHeight: textarea.clientHeight,
      scrollHeight: textarea.scrollHeight,
      overflowY: style.overflowY,
      lineHeight: Number.parseFloat(style.lineHeight),
      width: textarea.clientWidth,
      minHeight: style.minHeight,
    };
  });
}

// --- defect 1 ----------------------------------------------------------------

test("defect 1: an action beat is a quieter voice than dialogue, never the disabled tone", async ({ page }) => {
  await mountShell(page, {
    transcript: [
      { role: "companion", text: "*nods slowly*\nShe looks up and says nothing for a while." },
      { role: "player", text: "*waves*" },
    ],
  });
  await expect(page.locator("li.message.companion em.message-action")).toHaveText("nods slowly");

  const [companionBeat, companionProse, playerBeat] = await sampleContrast(page, [
    "li.message.companion em.message-action",
    "li.message.companion .message-bubble p",
    "li.message.player em.message-action",
  ]);
  const placeholderColour = await page.evaluate(
    () => getComputedStyle(document.querySelector(".composer-textarea")!, "::placeholder").color,
  );
  console.log(
    `[defect-1] companion beat ${companionBeat!.color} on ${companionBeat!.background} = ${companionBeat!.ratio}:1; ` +
      `prose ${companionProse!.ratio}:1; player beat ${playerBeat!.color} on ${playerBeat!.background} = ${playerBeat!.ratio}:1; ` +
      `disabled/placeholder tone ${placeholderColour}; zh beat weight ${companionBeat!.weight} vs prose ${companionProse!.weight}`,
  );

  expect(companionBeat!.found, "the companion beat renders").toBe(true);
  expect(playerBeat!.found, "the player's beat renders").toBe(true);
  // The tone is not the disabled one: that identity is what made a stage
  // direction read as a dead placeholder (both were `--palette-gray-400`).
  expect(
    companionBeat!.color,
    `the beat is ${companionBeat!.color}, which is the disabled tone the placeholder uses (${placeholderColour}); it must be its own voice`,
  ).not.toBe(placeholderColour);
  // Quieter than the dialogue it sits beside, and clear of the WCAG floor for
  // its own size - including on the player's bubble, where the old tone was
  // 3.20:1.
  expect(companionBeat!.ratio, `the companion beat reads ${companionBeat!.ratio}:1`).toBeGreaterThanOrEqual(4.5);
  expect(playerBeat!.ratio, `the player's beat reads ${playerBeat!.ratio}:1 on its own bubble`).toBeGreaterThanOrEqual(4.5);
  expect(companionBeat!.ratio, "the beat stays quieter than the dialogue beside it").toBeLessThan(companionProse!.ratio);
  // De-emphasis is never a *heavier* voice: the CJK beat used to be 600 against
  // the paragraph's 400.
  expect(
    companionBeat!.weight,
    `the beat is set at weight ${companionBeat!.weight} against the dialogue's ${companionProse!.weight}: de-emphasis may not be bolder than the speech`,
  ).toBeLessThanOrEqual(companionProse!.weight);
});

/**
 * The CJK half of defect 1, kept as its own assertion because it is the half the
 * audit's screenshots showed: `:lang(zh)` retires the faux italic, and it must
 * not answer with weight instead.
 */
test("defect 1: the CJK beat drops the faux italic without gaining weight", async ({ page }) => {
  await mountShell(page, { transcript: [{ role: "companion", text: "*轻轻点头*\n她抬起头，看了你一眼。" }] });
  const [beat, prose] = await sampleContrast(page, [
    "li.message.companion em.message-action",
    "li.message.companion .message-bubble p",
  ]);
  const lang = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>("li.message.companion em.message-action")!;
    return { documentLang: document.documentElement.lang, matchesZh: element.matches(":lang(zh)") };
  });
  console.log(`[defect-1 zh] ${JSON.stringify({ beat, prose, ...lang })}`);

  expect(lang.documentLang, "the surface runs in the language the rule keys on").toBe("zh-CN");
  expect(lang.matchesZh, "the CJK beat really is `:lang(zh)`").toBe(true);
  expect(beat!.fontStyle, "a CJK beat is not mechanically slanted").toBe("normal");
  expect(prose!.fontStyle, "the dialogue beside it is upright too").toBe("normal");
  expect(beat!.weight, "the CJK beat is not heavier than the dialogue").toBeLessThanOrEqual(prose!.weight);
  expect(beat!.ratio, "the CJK beat clears the floor on the card").toBeGreaterThanOrEqual(4.5);

  // The slant is gone, so the tone was the only thing telling the CJK beat from
  // the speech: `--text-secondary` against `--text-primary` is a 1.58:1
  // brightness step, which the audit read as one grey mass. The beat also
  // carries the narration's own tracking now (`--beat-tracking`, theme.polish),
  // and that is the distinction - it states no colour, so the two tones and
  // their ratios are exactly what they were.
  const tracking = Number.parseFloat(beat!.letterSpacing);
  console.log(
    `[defect-1 zh tracking] beat ${beat!.letterSpacing} (${tracking}px) vs dialogue ${prose!.letterSpacing}; ` +
      `tones ${beat!.color} ${beat!.ratio}:1 and ${prose!.color} ${prose!.ratio}:1`,
  );
  expect(
    tracking,
    `the CJK beat's tracking is ${beat!.letterSpacing} against the dialogue's ${prose!.letterSpacing}`,
  ).toBeGreaterThanOrEqual(1);
  expect(prose!.letterSpacing, "the dialogue keeps the paragraph's own spacing").toBe("normal");
  expect(beat!.ratio, "the beat's tone is unchanged by the tracking").toBeGreaterThanOrEqual(4.5);
  expect(prose!.ratio, "the dialogue's tone stays the brighter of the two").toBeGreaterThan(beat!.ratio);
});

// --- defect 2 ----------------------------------------------------------------

test("defect 2: a full-width parenthesis survives verbatim and the beat still reads as a beat", async ({ page }) => {
  await mountShell(page, {
    transcript: [
      { role: "companion", text: "她（轻轻点头）道：「好。」\n＊放下水壶＊\n*Latin beat*" },
    ],
  });
  await expect(page.locator("li.message.companion .message-bubble")).toBeVisible();

  const rendered = await page.evaluate(() => {
    const bubble = document.querySelector<HTMLElement>("li.message.companion .message-bubble")!;
    return {
      html: bubble.innerHTML,
      text: (bubble.textContent ?? "").trim(),
      beats: [...bubble.querySelectorAll("em.message-action")].map((node) => node.textContent),
    };
  });
  console.log(`[defect-2] ${JSON.stringify(rendered)}`);

  // The two parens the review measured: the rewrite made the sentence read
  // `她(轻轻点头)道` - the ASCII form, with the spacing a CJK reader does not
  // expect between a word and its parenthetical.
  expect(rendered.text, "the full-width parentheses reach the reader verbatim").toContain("她（轻轻点头）道");
  expect(rendered.text, "no half-width rewrite is left in the rendered text").not.toContain("她(轻轻点头)道");
  expect(rendered.text, "the closing full-width paren survives too").toContain("「好。」");
  // The rewrite was removed, not the beat: both the full-width asterisk form and
  // the ASCII form are still stage directions.
  expect(rendered.beats, "a full-width and an ASCII beat both render as beats").toEqual(["放下水壶", "Latin beat"]);
});

// --- defect 3 ----------------------------------------------------------------

test("defect 3: the composer hint is one line and the field does not scroll at 400px", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  // English is the longer catalogue and therefore the one that wraps first.
  await mountShell(page, { locale: "en", transcript: [{ role: "companion", text: "The morning light comes over the ridge." }] });

  const lines = await placeholderLineCount(page);
  const field = await composerField(page);
  console.log(`[defect-3 narrow] lines=${lines} ${JSON.stringify(field)}`);

  expect(lines, "the compact hint is one line at 400px").toBe(1);
  expect(
    field.placeholder,
    `the compact hint is ${JSON.stringify(field.placeholder)}: "Shift+Enter" is advice a phone cannot take`,
  ).not.toMatch(/Shift\s*\+\s*Enter/iu);
  // The field's height is the composer token's floor, and nothing overflows: the
  // audit's scrollbar reading was the field quietly growing to three lines.
  expect(field.inlineHeight, "the field sits on the composer's own minimum").toBe("48px");
  expect(field.clientHeight, "the rendered field is the 48px minimum").toBe(48);
  expect(field.clientHeight, "no line is hidden above the field's own box").toBe(field.scrollHeight);
  expect(field.scrollHeight, "the field does not overflow, so it cannot raise a scrollbar").toBeLessThanOrEqual(
    field.clientHeight,
  );
});

test("defect 3: the wide composer keeps the Enter hint the compact one drops", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountShell(page, { locale: "en", transcript: [{ role: "companion", text: "The morning light comes over the ridge." }] });

  const lines = await placeholderLineCount(page);
  const field = await composerField(page);
  console.log(`[defect-3 wide] lines=${lines} ${JSON.stringify(field)}`);

  expect(field.placeholder, "the wide composer still teaches the send key").toMatch(/Enter/iu);
  expect(field.placeholder, "and the newline modifier with it").toMatch(/Shift\s*\+\s*Enter/iu);
  expect(lines, "one line: the hint is an affordance, not a paragraph").toBe(1);
  expect(field.clientHeight, "the field is the minimum height with an empty value").toBe(48);
});

// --- defect 4 (refuted) ------------------------------------------------------

test("defect 4 (refuted): the first screen stacks one heading and no repeat of the surface's name", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await mountShell(page, { transcript: [{ role: "companion", text: "The morning light comes over the ridge." }] });

  const measured = await page.evaluate(() => {
    const headings = [...document.querySelectorAll<HTMLElement>("h1, h2, h3, h4")].map((node) => ({
      tag: node.tagName,
      text: (node.textContent ?? "").trim(),
      rendered: node.getClientRects().length > 0,
      height: Math.round(node.getBoundingClientRect().height),
    }));
    const brandName = document.querySelector<HTMLElement>(".app-bar-brand-name");
    const composer = document.querySelector<HTMLElement>(".composer-section")!;
    const timeline = document.querySelector<HTMLElement>(".timeline")!;
    return {
      headings,
      brandWord: brandName === null ? null : { text: (brandName.textContent ?? "").trim(), height: brandName.offsetHeight },
      placeholderBand: document.querySelector(".timeline-heading") !== null,
      chromeHeight: Math.round(timeline.getBoundingClientRect().top),
      firstScreenContent: Math.round(composer.getBoundingClientRect().top - timeline.getBoundingClientRect().top),
    };
  });
  console.log(`[defect-4 narrow] ${JSON.stringify(measured)}`);

  const rendered = measured.headings.filter((heading) => heading.rendered);
  expect(rendered.length, `one heading names the first screen, found ${JSON.stringify(rendered)}`).toBe(1);
  expect(rendered[0]!.text, "and it is the surface's own word").toBe("聊天");
  expect(measured.placeholderBand, "an untitled conversation prints no placeholder title band").toBe(false);
  expect(
    measured.brandWord!.height,
    "the app bar's brand *word* is retired at the compact width, so it is not a stacked title",
  ).toBe(0);
  // The two bands that do stay are one owner each - the product's app bar and the
  // surface's header - and they are bounded: 119px of 800 measured here, which is
  // the number the review's ">13%" names.
  expect(measured.chromeHeight, "the app bar + surface header stay under 120px").toBeLessThanOrEqual(120);
  expect(measured.firstScreenContent, "the transcript keeps the rest of the first screen").toBeGreaterThanOrEqual(580);
});

test("defect 4 (refuted): a published title is the panel's own heading, not a second surface name", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountShell(page, { title: "Winter on the Ridge" });

  const measured = await page.evaluate(() => {
    const headings = [...document.querySelectorAll<HTMLElement>("h1, h2, h3, h4")]
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => ({ tag: node.tagName, text: (node.textContent ?? "").trim() }));
    const total = headings.reduce((sum, heading) => {
      const node = [...document.querySelectorAll<HTMLElement>("h1, h2")].find(
        (candidate) => (candidate.textContent ?? "").trim() === heading.text,
      );
      return sum + (node === undefined ? 0 : node.getBoundingClientRect().height);
    }, 0);
    return { headings, headingHeightTotal: Math.round(total), viewportHeight: window.innerHeight };
  });
  console.log(`[defect-4 wide] ${JSON.stringify(measured)}`);

  expect(measured.headings.length, `two headings at most, found ${JSON.stringify(measured.headings)}`).toBe(2);
  const texts = measured.headings.map((heading) => heading.text);
  expect(texts, "the surface's word and the conversation's title").toContain("聊天");
  expect(texts, "the conversation's published title is shown").toContain("Winter on the Ridge");
  expect(
    new Set(texts).size,
    "no two headings print the same word: a panel does not repeat the shell header",
  ).toBe(texts.length);
  expect(
    (measured.headingHeightTotal / measured.viewportHeight) * 100,
    `the headings occupy ${measured.headingHeightTotal}px of ${measured.viewportHeight}`,
  ).toBeLessThan(13);
});

// --- defect 5 ----------------------------------------------------------------

test("defect 5: two recommended models with one id read as two different chips", async ({ page }) => {
  await mountShell(page, { transcript: [{ role: "companion", text: "Hello." }], recommendedModels: SAME_ID_TWO_PROVIDERS });
  await page.getByTestId("chat-model-trigger").click();
  await expect(page.getByTestId("chat-model-drawer")).toBeVisible();

  const chips = await page.locator(".surface-model-chip").evaluateAll((nodes) =>
    nodes.map((node) => (node.textContent ?? "").trim()),
  );
  console.log(`[defect-5] ${JSON.stringify(chips)}`);

  // Neither suggestion is dropped: they are two different models the endpoint
  // resolves differently, which is why the review asked for disambiguation rather
  // than deletion.
  expect(chips.length, "both providers' suggestions are offered").toBe(SAME_ID_TWO_PROVIDERS.length);
  expect(new Set(chips).size, `two chips must not read one identical word: ${JSON.stringify(chips)}`).toBe(chips.length);
  for (const entry of SAME_ID_TWO_PROVIDERS) {
    const mine = chips.filter((chip) => chip.includes(entry.providerLabel));
    expect(mine.length, `one chip names the provider ${entry.providerLabel} (${entry.providerId})`).toBe(1);
    expect(mine[0], "and it still names the model id the chip applies").toContain(entry.modelId);
  }
});

// --- defect 6 (refuted) ------------------------------------------------------

const LONG_TRANSCRIPT = [
  { role: "companion", text: "The morning light comes over the ridge. Where should we go next?" },
  { role: "player", text: "Let's check the crops and then walk into town." },
  { role: "companion", text: "I'll bring the watering can. The season is turning, so the north field wants attention." },
  { role: "player", text: "Then the general store - I promised to drop off something for Pierre." },
  { role: "companion", text: "Then we should leave before noon, or the shop will already be shut for the day." },
  { role: "player", text: "Agreed. I'll meet you by the gate." },
  { role: "companion", text: "I will be there, and I will bring the basket with me." },
  { role: "player", text: "Perfect." },
  { role: "companion", text: "The last line of the transcript, which is the one the composer must never cover." },
] as const;

/** The clearance between the transcript's last line and the composer band. */
async function lastLineClearance(page: Page) {
  return page.evaluate(() => {
    const timeline = document.querySelector<HTMLElement>(".timeline")!;
    timeline.scrollTop = timeline.scrollHeight;
    const messages = [...document.querySelectorAll<HTMLElement>("li.message")];
    const last = messages[messages.length - 1]!;
    const bubble = last.querySelector<HTMLElement>(".message-bubble")!;
    const composer = document.querySelector<HTMLElement>(".composer-section")!;
    const container = document.querySelector<HTMLElement>(".composer-container")!;
    return {
      lastBubbleBottom: Math.round(bubble.getBoundingClientRect().bottom),
      lastMessageBottom: Math.round(last.getBoundingClientRect().bottom),
      composerTop: Math.round(composer.getBoundingClientRect().top),
      composerContainerTop: Math.round(container.getBoundingClientRect().top),
      composerPosition: getComputedStyle(composer).position,
      timelineOverflowY: getComputedStyle(timeline).overflowY,
      timelineScrollable: timeline.scrollHeight > timeline.clientHeight,
    };
  });
}

for (const viewport of [
  { width: 400, height: 800 },
  { width: 1440, height: 900 },
] as const) {
  test(`defect 6 (refuted): the last line stays above the composer at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    // The short transcript first: the case where the clearance is not a scroll
    // position at all. Then the overflowing one, which is the case a composer
    // out of flow would cover.
    await mountShell(page, { transcript: LONG_TRANSCRIPT.slice(0, 2) });
    await expect(page.locator("li.message")).toHaveCount(2);
    const short = await lastLineClearance(page);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mountShell(page, { transcript: LONG_TRANSCRIPT, reload: true });
    await expect(page.locator("li.message")).toHaveCount(LONG_TRANSCRIPT.length);
    const overflow = await lastLineClearance(page);
    console.log(`[defect-6:${viewport.width}x${viewport.height}] short ${JSON.stringify(short)} overflow ${JSON.stringify(overflow)}`);

    expect(short.timelineScrollable, "the short transcript really fits").toBe(false);
    expect(overflow.timelineScrollable, "the measured transcript really overflows").toBe(true);
    expect(
      overflow.composerPosition,
      "the composer is in flow, so it cannot cover the transcript it follows",
    ).toBe("static");
    expect(overflow.timelineOverflowY, "the transcript is the scroller").toBe("auto");
    expect(
      overflow.lastBubbleBottom,
      `the last bubble ends at ${overflow.lastBubbleBottom} and the composer starts at ${overflow.composerTop}`,
    ).toBeLessThanOrEqual(overflow.composerTop - 8);
    // Stronger: the last line clears the *field* the player types in, not only the
    // band around it.
    expect(overflow.lastBubbleBottom).toBeLessThanOrEqual(overflow.composerContainerTop - 8);
    expect(short.lastMessageBottom, "a short transcript leaves a gap by construction").toBeLessThan(short.composerTop);
  });
}
