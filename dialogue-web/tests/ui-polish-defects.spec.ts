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
 *      untitled conversation renders the surface's word and its own name - two
 *      headings, not three - and the app bar's brand *word* is retired below
 *      640 px. The gates below pin the refutation so it cannot come back.
 *   5. Two recommended models can share a model id from different providers, and
 *      the chip printed the id alone - two chips reading one identical word.
 *   6. **Refuted.** The composer is in flow, so it cannot cover the transcript:
 *      measured 72 px of clearance at 400x800 and 71 px at 1440x900 with the
 *      transcript scrolled to its end.
 *   7. No control in the product had a pressed state: the stylesheet declared
 *      zero `:active` selectors, so a nav entry, a sheet button and a disclosure
 *      summary all looked identical down and up. Measured while held, at
 *      1440x900: `translate: none` and no movement on all three.
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
  transcript?: readonly Readonly<{ role: "player" | "companion"; text: string; opening?: boolean }>[];
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
          // The opening choice the Host publishes while message zero's greeting
          // set is still unlocked and still resolves: it is what offers the
          // `.swipe-btn` pair this fixture measures.
          ...(message.opening === true
            ? { openingVariant: { variantId: `${"V".repeat(42)}A`, index: 0, count: 2, label: "Default", locked: false } }
            : {}),
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
    route.fulfill(jsonOk({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null, persona: null })),
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

// --- an incidental: three live texts read the disabled token -----------------

/**
 * Three texts the player *reads* were painted in `--text-disabled`, the token the
 * product names for text the player cannot use.
 *
 * Measured in the mounted shell before the change, each resolved against the
 * effective background the runtime contrast gate uses: `.message-author` (the
 * name over a companion's bubble), `.section-subtitle` (a surface's own section
 * heading) and `.surface-model-recommended > span` (the caption over the
 * suggestion chips) all computed `rgb(144, 135, 126)` = `--text-disabled`
 * (`#90877e`) at 12 px - 5.57:1 on the canvas (`#0c0b0b`), and 4.74:1 on the
 * card tone (`#201d1d`) the author line can also sit on. After: all three read
 * `--text-secondary` (`#c8c0b6`) at 10.92:1 on the canvas and 9.30:1 on the card.
 *
 * The assertion is the identity the change is: each control's own computed
 * colour is the product's secondary tone, and never the disabled one. It is
 * read through the same `sampleContrast` the contrast gate uses, so a later
 * re-tune of either token moves both readings together.
 */
test("the author line, a section heading and the suggestion caption read the live tone, not the disabled one", async ({ page }) => {
  await mountShell(page, {
    transcript: [{ role: "companion", text: "Good morning, farmer." }],
    recommendedModels: SAME_ID_TWO_PROVIDERS,
    // The English shell names the app bar's entries in English; the surface's own
    // section headings are the same two texts in either catalogue.
    locale: "en",
  });
  await expect(page.locator(".message-author")).toBeVisible();

  const [author] = await sampleContrast(page, [".message-author"]);
  // The chat surface's model popout carries the suggestion caption; the Game
  // surface carries the two section headings below it.
  await page.getByTestId("chat-model-trigger").click();
  await expect(page.getByTestId("chat-model-drawer")).toBeVisible();
  const [caption] = await (async () => {
    // The popout's own profile read must settle before the caption exists.
    await expect(page.locator(".surface-model-recommended > span")).toBeVisible();
    return sampleContrast(page, [".surface-model-recommended > span"]);
  })();
  // The popout is a drawer over the conversation, so it has to be closed before
  // the app bar behind its backdrop is reachable.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-model-drawer")).toHaveCount(0);

  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
  // The Game surface's own reads settle before its section headings exist.
  await expect(page.locator(".section-subtitle").first()).toBeVisible();
  const headings = await sampleContrast(page, [".section-subtitle"]);
  const tokens = await page.evaluate(() => {
    const read = (name: string): string => {
      const probe = document.createElement("span");
      probe.style.color = `var(${name})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    return { secondary: read("--text-secondary"), disabled: read("--text-disabled") };
  });
  console.log(
    `[live-text-tone] ${JSON.stringify({ author, caption, headings, tokens })}`,
  );

  expect(tokens.secondary, "the two tokens are the ones the change is between").not.toBe(tokens.disabled);
  for (const reading of [author, caption, ...headings]) {
    expect(reading, "every one of the three is on screen").toMatchObject({ found: true });
    expect(
      reading.color,
      `${reading.selector} reads ${reading.color} on ${reading.background}, ${reading.ratio}:1`,
    ).toBe(tokens.secondary);
    expect(reading.color, "and never the token named for text the player cannot use").not.toBe(tokens.disabled);
    expect(reading.ratio, `${reading.selector} clears the 4.5:1 body-text floor`).toBeGreaterThanOrEqual(4.5);
  }
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

test("defect 4 (refuted): the first screen names the surface and the conversation, not a repeated name", async ({ page }) => {
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
  const texts = rendered.map((heading) => heading.text);
  expect(
    rendered.length,
    `the surface's word and the conversation's own name, found ${JSON.stringify(rendered)}`,
  ).toBe(2);
  expect(texts, "the surface keeps its own word").toContain("聊天");
  expect(texts, "the untitled conversation carries the catalogue's own name").toContain("新对话");
  expect(new Set(texts).size, "no two headings print the same word").toBe(texts.length);
  expect(measured.placeholderBand, "the conversation's name is a real band, not suppressed").toBe(true);
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

// --- the disabled pager's double attenuation ---------------------------------

/**
 * A disabled control is attenuated once, not twice.
 *
 * `.swipe-btn:disabled` carried the muted token *and* an `opacity`: the two
 * compound, and the product's own muted grey (`--text-disabled`, `#90877e`) at
 * 40% over the card tone (`#201d1d`) paints `rgb(77,71,68)` - measured 1.84:1,
 * so the arrow is not a dimmed control but an invisible one. The product's
 * established disabled state is the muted token alone: the composer's placeholder
 * and the Chats row's meta line both read `--text-disabled` at 4.74:1 on this
 * same card tone and neither carries an opacity.
 *
 * Measured on the mounted shell at 1440x900, on the opening bubble's own switcher
 * with its `Previous` arrow disabled by the Host's own `index <= 0` precondition:
 * declared colour `rgb(144, 135, 126)` at `opacity: 0.4`, painted
 * `rgb(77,71,68)` = 1.84:1. After: the same declared colour with no opacity, so
 * the painted glyph IS the declared one, 4.74:1, and it clears the 4.5:1 floor.
 *
 * The opacity is what makes this invisible to the runtime contrast gate: gate 3
 * composites a leaf's *own* background but reads `color` and never `opacity`, and
 * this button is not even one of its leaves - it has a child and no text node of
 * its own, so the gate samples the inner label span instead (4.74:1, before and
 * after). An attenuation that lives only in `opacity` is therefore invisible to
 * every sampler in this tree, which is the reason this test composites the two
 * itself rather than trusting one reading.
 */
test("a disabled pager arrow is muted, not doubly attenuated into invisibility", async ({ page }) => {
  await mountShell(page, {
    transcript: [{ role: "companion", text: "The lantern over the porch is still lit.", opening: true }],
  });
  const [previous, next] = [page.locator(".swipe-btn").first(), page.locator(".swipe-btn").last()];
  await expect(previous).toBeVisible();
  await expect(previous, "the Host's own index <= 0 precondition disables it").toBeDisabled();
  await expect(next, "and the other direction stays operable").toBeEnabled();

  const read = async (button: typeof previous) =>
    button.evaluate((node) => {
      const parse = (value: string): [number, number, number, number] => {
        const match = value.match(/rgba?\(([^)]+)\)/u);
        if (match === null) return [0, 0, 0, 0];
        const parts = match[1]!.split(",").map((part) => Number.parseFloat(part.trim()));
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
      };
      const luminance = ([red, green, blue]: readonly number[]): number => {
        const channel = (value: number): number => {
          const scaled = value / 255;
          return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(red!) + 0.7152 * channel(green!) + 0.0722 * channel(blue!);
      };
      const ratio = (foreground: readonly number[], background: readonly number[]): number => {
        const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        return (lighter! + 0.05) / (darker! + 0.05);
      };
      // The opaque background behind the arrow, composited exactly as gate 3 does.
      const stack: [number, number, number, number][] = [];
      for (let current: Element | null = node; current !== null; current = current.parentElement) {
        const background = parse(getComputedStyle(current).backgroundColor);
        stack.push(background);
        if (background[3] >= 0.999) break;
      }
      let effective: number[] = [...stack[stack.length - 1]!.slice(0, 3)];
      for (let index = stack.length - 2; index >= 0; index -= 1) {
        const top = stack[index]!;
        effective = [
          top[0]! * top[3] + effective[0]! * (1 - top[3]),
          top[1]! * top[3] + effective[1]! * (1 - top[3]),
          top[2]! * top[3] + effective[2]! * (1 - top[3]),
        ];
      }
      const style = getComputedStyle(node);
      const declared = parse(style.color).slice(0, 3);
      const opacity = Number.parseFloat(style.opacity);
      const painted = declared.map((channel, index) => channel * opacity + effective[index]! * (1 - opacity));
      return {
        opacity,
        declaredColor: style.color,
        background: `rgb(${effective.map((value) => Math.round(value)).join(",")})`,
        paintedColor: `rgb(${painted.map((value) => Math.round(value)).join(",")})`,
        ratio: Number(ratio(painted, effective).toFixed(2)),
      };
    });

  const disabled = await read(previous);
  const enabled = await read(next);
  console.log(`[disabled-pager] ${JSON.stringify({ disabled, enabled })}`);

  // The compounding is gone: whatever the token says is what is painted, because
  // no opacity attenuates it a second time.
  expect(
    disabled.opacity,
    `the disabled arrow is attenuated by opacity ${disabled.opacity} as well as by its colour`,
  ).toBe(1);
  expect(disabled.paintedColor, "the glyph paints the colour its token declares").toBe(
    disabled.declaredColor.replace(/\s/gu, ""),
  );
  expect(
    disabled.ratio,
    `the disabled arrow paints ${disabled.paintedColor} on ${disabled.background} = ${disabled.ratio}:1`,
  ).toBeGreaterThanOrEqual(4.5);
  // Muted is still muted: the disabled direction is dimmer than the live one.
  expect(disabled.declaredColor, "the disabled direction is not the live one's tone").not.toBe(enabled.declaredColor);
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

// --- defect 7 ----------------------------------------------------------------

/**
 * A held control answers the press, and the answer is the same one everywhere.
 *
 * The stylesheet declared no `:active` selector at all, so nothing in the
 * product responded to a press: a nav entry, a sheet button and a disclosure
 * summary were indistinguishable down and up. The press is one beat - the
 * control moves down by `--press-shift` while it is held - declared once on the
 * shell every control renders inside, so a control added tomorrow presses
 * without its own rule.
 *
 * The reading is the held control's own box: `translate` while held, and the
 * y its bounding rect lands on, against the same two values at rest. The press
 * is a transform, so the last leg asks the same question with
 * `prefers-reduced-motion: reduce` and requires the movement to be gone.
 */
test("defect 7: a held control answers with the product's own press beat, and reduced motion drops it", async ({ page }) => {
  await mountShell(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId("chat-surface")).toBeVisible();

  /** Holds the pointer down on the control and reads it while it is held. */
  const press = async (selector: string) => {
    const control = page.locator(selector).first();
    await expect(control, `${selector} is on screen`).toBeVisible();
    const read = () =>
      control.evaluate((node) => {
        const style = getComputedStyle(node);
        return { translate: style.translate, y: Math.round(node.getBoundingClientRect().y) };
      });
    const rest = await read();
    const box = await control.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    // The beat is `--motion-duration-fast` (150 ms): read the settled value, not
    // an interpolated one.
    await page.waitForTimeout(250);
    const held = await read();
    await page.mouse.up();
    return { rest, held };
  };

  const shift = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--press-shift").trim(),
  );
  expect(shift, "the press beat is a token, not a literal per rule").not.toBe("");

  const nav = await press(".app-bar .nav-button");
  await page.getByRole("button", { name: "会话", exact: true }).click();
  await expect(page.getByTestId("chats-surface")).toBeVisible();
  const sheet = await press("[data-testid='chats-surface'] .small-button");
  await page.getByRole("button", { name: "角色", exact: true }).click();
  await expect(page.getByTestId("characters-surface")).toBeVisible();
  const disclosure = await press("[data-card-import] details.custom-disclosure > summary");
  console.log(`[press] shift=${shift} nav=${JSON.stringify(nav)} sheet=${JSON.stringify(sheet)} disclosure=${JSON.stringify(disclosure)}`);

  for (const [name, reading] of Object.entries({ nav, sheet, disclosure })) {
    expect(reading.rest.translate, `${name} is at rest before the press`).toBe("none");
    expect(
      reading.held.translate,
      `${name} pressed is the token's own shift (${JSON.stringify(reading)})`,
    ).toContain(shift);
    expect(
      reading.held.y - reading.rest.y,
      `${name} moves down by exactly one press (${JSON.stringify(reading)})`,
    ).toBe(1);
  }

  // The same press, with the player's reduced-motion preference honoured.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await press(".app-bar .nav-button");
  console.log(`[press] reduced-motion nav=${JSON.stringify(reduced)}`);
  expect(reduced.rest.translate, "the control is still at rest").toBe("none");
  expect(
    reduced.held.translate,
    `reduced motion drops the press's movement (${JSON.stringify(reduced)})`,
  ).toBe("none");
  expect(reduced.held.y - reduced.rest.y, "and the control does not move").toBe(0);
});
