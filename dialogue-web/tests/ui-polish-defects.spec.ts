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
 *   8. A Game section heading did not outrank the body it introduced.
 *   9. **The fold showed three empty cards instead of the one action.** On a
 *      fresh session the Game surface's first column was a "nothing published"
 *      sentence, three empty-state cards ("your companion" / "nothing published"
 *      / "no action authority") and a waiting paragraph, while the only
 *      clickable thing - enable companion play - sat in the second column, and
 *      at 400x800 below the fold outright. Measured before at 1440x900: board
 *      y=56, its three cards to y=237, the enable control at y=169 in the other
 *      column; at 400x800 the board ran 119..516 and the control did not appear
 *      until y=669, under a guide that starts at y=536.
 *   10. **Three cards, each titled by its own emptiness.** "你的同伴 /
 *      还没有公布 / 尚未提供" was one fact told three ways in ~250 px. The board
 *      now states it in one sentence and carries one named state for it
 *      (`data-capability-state="unpublished"`).
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
    modelId: "deepseek-v4.1-flash",
    modelLabel: "DeepSeek V4.1 Flash",
    allowedThinkingLevels: ["off", "medium", "high"],
    defaultThinkingLevel: "medium",
  },
  {
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    modelId: "deepseek-v4.1-flash",
    modelLabel: "DeepSeek V4.1 Flash (OR)",
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
        companion: { name: options.companionName ?? "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
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
        chat: { revision: 1, thinkingLevel: "medium" },
        game: { revision: 1, thinkingLevel: "medium" },
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
 * heading) and `.surface-model-recommended > p` (the caption over the
 * suggestion chips) all computed `rgb(144, 135, 126)` = `--text-disabled`
 * (`#90877e`) at 12 px - 5.57:1 on the canvas (`#0c0b0b`), and 4.74:1 on the
 * card tone (`#201d1d`) the author line can also sit on. After: all three read
 * `--text-secondary` (`#c8c0b6`) at 10.92:1 on the canvas and 9.30:1 on the card.
 *
 * The assertion is the identity the change is: the two captions' own computed
 * colour is the product's secondary tone, and never the disabled one. The section
 * heading is the same guarantee but a layer up - defect 8 gives a section heading
 * the product's heading tone (`--text-primary`) so it outranks the body under it,
 * and what this test holds for it is unchanged: the live token, read through the
 * same `sampleContrast` the contrast gate uses, so a later re-tune of either token
 * moves both readings together.
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
    await expect(page.locator(".surface-model-recommended > p")).toBeVisible();
    return sampleContrast(page, [".surface-model-recommended > p"]);
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
    return { primary: read("--text-primary"), secondary: read("--text-secondary"), disabled: read("--text-disabled") };
  });
  console.log(
    `[live-text-tone] ${JSON.stringify({ author, caption, headings, tokens })}`,
  );

  expect(tokens.secondary, "the two tones the captions sat between are not the same").not.toBe(tokens.disabled);
  expect(tokens.primary, "and the heading's tone is a third, brighter one").not.toBe(tokens.secondary);
  for (const reading of [author, caption, ...headings]) {
    expect(reading, "every one of the three is on screen").toMatchObject({ found: true });
    expect(
      reading.color,
      `${reading.selector} reads ${reading.color} on ${reading.background}, ${reading.ratio}:1`,
    ).not.toBe(tokens.disabled);
    expect(reading.ratio, `${reading.selector} clears the 4.5:1 body-text floor`).toBeGreaterThanOrEqual(4.5);
  }
  for (const reading of [author, caption]) {
    expect(reading.color, `${reading.selector} reads the live secondary tone`).toBe(tokens.secondary);
  }
  for (const reading of headings) {
    expect(
      reading.color,
      `${reading.selector} reads the product's heading tone, so it outranks the body it introduces`,
    ).toBe(tokens.primary);
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
  // Wait for the suggestions before reading them: the drawer opens before its chips
  // render, so a snapshot here reads however many had painted - usually none under
  // load, and the empty list then failed as "both suggestions are offered" (the
  // test passes alone and failed in roughly half the multi-file runs).
  await expect(page.locator(".surface-model-chip")).toHaveCount(SAME_ID_TWO_PROVIDERS.length);

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

/**
 * What each management panel's own content column measures, and where it sits.
 *
 * The failure this pins: the panels kept the whole region while only *some* of
 * their blocks carried the form measure, so at 1440x900 the Chats list was a
 * 640 px column against the left edge with 768 px of empty region beside it, and
 * the Memory notebook had no measure at all - a 1408 px card whose own heading
 * and refresh control sat 1360 px apart. The measure and the *centring* are one
 * property: a column hugging one edge of a wide region reads as a broken layout,
 * not as a measure.
 *
 * The Characters roster is deliberately not in this list: it is a grid of cards,
 * and the region's width is what gives it its columns.
 */
const PANEL_COLUMNS = [
  { id: "chats-surface", nav: "会话" },
  { id: "settings-surface", nav: "设置" },
  { id: "memory-surface", nav: "记忆" },
] as const;

const FORM_MEASURE_PX = 640;

/**
 * The measure-carrying blocks, one per panel that has them. The gate asserts the
 * property (each column reads the measure and sits centred in a wide region),
 * not a mechanism: shrinking the region itself would move every block at once,
 * but the region is the panel's own surface and three existing assertions pin it
 * as the wide one (`management-surface-panels.spec.ts` "the desktop panel is the
 * wide surface"). Both halves are asserted here now.
 */
const MEASURED_BLOCKS = [
  ".chat-list",
  ".chat-item-card",
  ".tavern-memory-section",
  ".memory-notebook",
  ".connection-form",
  ".voice-device-selector",
  ".model-profile-editor",
] as const;

async function measurePanelColumn(page: Page, testId: string) {
  return await page.evaluate(
    ({ id, blocks }) => {
      const surface = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (surface === null) return null;
      const content = surface.querySelector<HTMLElement>(".surface-content");
      if (content === null) return null;
      const region = surface.getBoundingClientRect();
      const columns = [...content.querySelectorAll<HTMLElement>(blocks.join(","))]
        .filter((node) => node.getBoundingClientRect().width > 0)
        .map((node) => {
          const box = node.getBoundingClientRect();
          return {
            className: node.className.toString().split(" ")[0] ?? "",
            width: Math.round(box.width),
            leftDead: Math.round(box.left - region.left),
            rightDead: Math.round(region.right - box.right),
          };
        });
      return {
        regionWidth: Math.round(region.width),
        columns,
        contentOverflow: content.scrollWidth - content.clientWidth,
      };
    },
    { id: testId, blocks: [...MEASURED_BLOCKS] },
  );
}

test("the management panels read one centred column, so no panel hugs an edge", async ({ page }) => {
  await mountShell(page);
  // The Chats panel's own column is its list, so the state has to carry one: an
  // empty library renders the empty-state block instead and the panel would have
  // nothing measured in it.
  await page.route("**/api/tavern/v1/chats?*", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chats: [
          {
            handle: "B".repeat(42) + "A",
            title: "A durable chat",
            status: "active",
            managementRevision: 1,
            isSelected: true,
            updatedAtMs: 1_760_000_000_000,
            preview: "The parsnips took.",
          },
        ],
      }),
    ),
  );
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const { id, nav } of PANEL_COLUMNS) {
    await page.getByRole("button", { name: nav, exact: true }).click();
    await expect(page.getByTestId(id)).toBeVisible();
    // Each panel reads its content from the Host, so the column exists only once
    // that read has landed: measure after it, or the gate reads a loading surface
    // and finds no column at all (which is how it first reported `columns: []`).
    await expect(page.locator(`[data-testid="${id}"] .surface-content > *`).first()).toBeVisible();
    await expect(page.locator(`[data-testid="${id}"] .surface-content .empty-subtle, [data-testid="${id}"] .surface-content .chat-list, [data-testid="${id}"] .surface-content .tavern-memory-section, [data-testid="${id}"] .surface-content .connection-form`).first()).toBeVisible();
    // A panel re-reads its library on every change (and a re-read briefly renders
    // the loading state, which has no list), so the column is measured once it is
    // there rather than once the click returned.
    let measured = await measurePanelColumn(page, id);
    for (let attempt = 0; attempt < 20 && measured !== null && measured.columns.length === 0; attempt += 1) {
      await page.waitForTimeout(100);
      measured = await measurePanelColumn(page, id);
    }
    console.log(`[panel-column ${id}] ${JSON.stringify(measured)}`);
    expect(measured, `${id} renders a content region`).not.toBeNull();
    const panel = measured!;
    // The region is the panel's own surface and stays wide: this is the invariant
    // that made centring the region the wrong lever.
    expect(panel.regionWidth, `${id} is the wide surface at 1440`).toBeGreaterThan(1200);
    expect(panel.columns.length, `${id} has at least one measured column`).toBeGreaterThan(0);
    for (const column of panel.columns) {
      expect(
        column.width,
        `${id} ${column.className} takes the form measure, not the whole ${panel.regionWidth} px region`,
      ).toBeLessThanOrEqual(FORM_MEASURE_PX);
      expect(
        Math.abs(column.leftDead - column.rightDead),
        `${id} ${column.className} centres its column (left ${column.leftDead}, right ${column.rightDead})`,
      ).toBeLessThanOrEqual(2);
    }
    expect(panel.contentOverflow, `${id} does not scroll sideways`).toBe(0);
  }
});

/**
 * Creating a Chat lands the player in it.
 *
 * The failure this pins: "New Chat" created a conversation and left the player on
 * the list, so the surface they had just made was one they still had to find and
 * click - a conversation not started. Creation now issues the **same** selection a
 * row click makes (the panel shares one `requestSelection`), and the shell's own
 * switch path adopts the mount and moves the region, so the created Chat's opening
 * is what the player is reading when the request settles.
 *
 * The assertions cover the whole gesture rather than the call: the surface shown is
 * the conversation, the transcript carries the created Chat's own opening, and the
 * request that moved it is the Host's own `chat.select` for the handle the Host
 * returned from creation (not an identity composed here).
 */
test("creating a Chat lands in it, with its own opening already read", async ({ page }) => {
  const createdHandle = "N".repeat(42) + "A";
  const opening = "灶上温着粥，你先坐。";
  // The surface's own words are read in the product's English catalogue here, so
  // the journey names the control the way the catalogue does.
  await mountShell(page, { locale: "en" });
  let selected: string | null = null;
  await page.route(/\/api\/tavern\/v1\/chats(\?|$)/, (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, chats: [] })),
  );
  await page.route("**/api/tavern/v1/chats", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chat: {
          handle: createdHandle,
          title: null,
          status: "active",
          managementRevision: 1,
          isSelected: false,
          updatedAtMs: 1_760_000_000_000,
          preview: opening,
        },
        opening,
      }),
    ),
  );
  await page.route("**/api/tavern/v1/chat/select", async (route) => {
    const body = route.request().postDataJSON() as { chatHandle?: string };
    selected = body.chatHandle ?? null;
    await route.fulfill(jsonOk({ apiVersion: 1, status: "switched" }));
  });
  // The adopted snapshot is the created Chat, which is what makes the opening the
  // conversation's own first message.
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill(
      jsonOk({
        ...composedRoot(),
        chat: {
          ...composedRoot().chat,
          selection: { chatHandle: createdHandle, generation: 1, stateRevision: createdHandle },
          chat: {
            ...composedRoot().chat.chat,
            title: null,
            transcript: [
              { handle: createdHandle, role: "companion", text: opening, locale: "und", order: 0, revision: 1 },
            ],
          },
        },
      }),
    ),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=chats`);
  await expect(page.getByTestId("chats-surface")).toBeVisible();
  await page.getByRole("button", { name: "New Chat", exact: true }).click();

  // The region is the conversation, not the list it was created from.
  const chat = page.getByTestId("chat-surface");
  await expect(chat).toBeVisible();
  await expect(page.getByTestId("chats-surface")).toHaveCount(0);
  await expect(chat.locator(".message-list")).toContainText(opening);
  // …and the move was the Host's own selection of the handle it minted.
  await expect.poll(() => selected).toBe(createdHandle);
});

// --- defect 8 ----------------------------------------------------------------

/**
 * A Game section heading outranks the body it introduces.
 *
 * The failure this pins: after the first pass unified the two heading classes they
 * both read 12px/600/`--text-secondary`, which is *below* the body each one heads.
 * Measured at 400x800 from `99-game-400x800.png`: `下一步` (y≈490) sat above
 * `启动星露谷` (y≈513) at 13px/600/`#f5f0e8` - the group's own name was smaller and
 * greyer than the step it introduced. The same held under the capability board's
 * lead sentence (13px/400/secondary), under `会话`'s fact values (13px/500/primary)
 * and above the cabin choice's name (14px).
 *
 * The rule asserted is the hierarchy, not the numbers: every section heading on
 * the surface strictly outranks every text element inside its own section, by size
 * first, then weight, then the product's three text tokens. That order is why the
 * fix needs no new colour and no `text-transform: uppercase` - a heading cannot be
 * made to outrank a 14 px body by capitals, which CJK does not render.
 *
 * Both directions are measured: `stretch` - here, the pre-fix declarations, put
 * back through an unlayered style rule - has to make the same assertions fail.
 */
async function measureGameSectionHeadings(page: Page) {
  return await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-testid="game-surface"]');
    if (surface === null) return null;
    // The three text tokens, resolved to the colours they compute to, so a reading
    // is compared as a rank rather than as an rgb string.
    const TOKENS = ["--text-primary", "--text-secondary", "--text-disabled"] as const;
    const byColour: Record<string, string> = {};
    for (const name of TOKENS) {
      const probe = document.createElement("span");
      probe.style.color = `var(${name})`;
      document.body.appendChild(probe);
      byColour[getComputedStyle(probe).color] = name;
      probe.remove();
    }
    const RANK: Record<string, number> = { "--text-primary": 3, "--text-secondary": 2, "--text-disabled": 1 };
    const read = (node: Element) => {
      const style = getComputedStyle(node);
      const colour = byColour[style.color] ?? style.color;
      return {
        text: (node.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 24),
        size: Number.parseFloat(style.fontSize),
        weight: Number.parseInt(style.fontWeight, 10) || 400,
        colour,
        colourRank: RANK[colour] ?? 0,
        letterSpacing: style.letterSpacing,
      };
    };
    // The section headings the surface has: the drawer's own groups and the
    // capability board, the installation panel and the cabin handoff's sub-panel.
    const sections = [
      ...surface.querySelectorAll<HTMLElement>(
        ".game-capability-board, .game-installation-panel, .game-group, .game-subpanel",
      ),
    ];
    return sections.flatMap((section) => {
      const heading = section.querySelector<HTMLElement>(
        ":scope > .game-group-title, :scope > .section-subtitle",
      );
      if (heading === null) return [];
      // The body it introduces: every text-bearing element inside the section that
      // is not itself a heading. A nested heading is a level of its own (the guide's
      // step titles, the cabin handoff's own subtitle), not body text.
      const bodies = [...section.querySelectorAll("*")]
        .filter((node) => node !== heading && !/^H[1-6]$/u.test(node.tagName))
        .filter((node) => node.getClientRects().length > 0)
        .filter((node) =>
          [...node.childNodes].some(
            (child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim().length > 0,
          ),
        )
        .map(read);
      return [{ id: heading.id === "" ? heading.textContent : heading.id, heading: read(heading), bodies }];
    });
  });
}

type SectionReading = Readonly<{
  id: string;
  heading: Readonly<{ text: string; size: number; weight: number; colour: string; colourRank: number }>;
  bodies: readonly Readonly<{ text: string; size: number; weight: number; colour: string; colourRank: number }>[];
}>;

type TextReading = SectionReading["heading"];

const describeReading = (reading: TextReading): string =>
  `${JSON.stringify(reading.text)} ${reading.size}px/${reading.weight}/${reading.colour}`;

/** Size first, then weight, then the tone: the order a reader ranks type in. */
function outranks(heading: TextReading, body: TextReading): boolean {
  if (heading.size !== body.size) return heading.size > body.size;
  if (heading.weight !== body.weight) return heading.weight > body.weight;
  return heading.colourRank > body.colourRank;
}

/** Every place a section heading fails to outrank a body inside its own section. */
function inversions(sections: readonly SectionReading[]): string[] {
  return sections.flatMap((section) =>
    section.bodies
      .filter((body) => !outranks(section.heading, body))
      .map((body) => `${describeReading(section.heading)} is not above ${describeReading(body)}`),
  );
}

test("defect 8: a Game section heading outranks the body it introduces, at 1440 and 400", async ({ page }) => {
  await mountShell(page, { locale: "zh-CN" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "游戏", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
  // The sections under test are the ones whose reads have to settle first.
  await expect(page.locator(".game-capability-board .game-group-title")).toBeVisible();
  await expect(page.locator(".section-subtitle").first()).toBeVisible();
  await expect(page.locator("[data-guide-step]").first()).toBeVisible();

  const measured: Record<string, Awaited<ReturnType<typeof measureGameSectionHeadings>>> = {};
  for (const viewport of [
    { width: 1440, height: 900, label: "1440x900" },
    { width: 400, height: 800, label: "400x800" },
  ] as const) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect(page.locator(".game-group-title").first()).toBeVisible();
    const sections = await measureGameSectionHeadings(page);
    console.log(`[defect-8 sections @${viewport.label}] ${JSON.stringify(sections)}`);
    measured[viewport.label] = sections;
    expect(sections, `the Game surface renders its sections at ${viewport.label}`).not.toBeNull();
    expect(
      sections!.length,
      `every section heading on the surface is measured at ${viewport.label}`,
    ).toBeGreaterThanOrEqual(4);

    // One treatment: every section heading on the surface is the same size, the
    // same weight and the same tone - a surface does not have two kinds of section.
    const treatments = [
      ...new Set(sections!.map((section) => `${section.heading.size}/${section.heading.weight}/${section.heading.colour}`)),
    ];
    expect(
      treatments,
      `one treatment for every section heading (${sections!.map((section) => `${section.id}: ${describeReading(section.heading)}`).join("; ")})`,
    ).toHaveLength(1);

    // …and each one outranks the body it introduces, everywhere inside its section.
    expect(
      inversions(sections!),
      `no section heading is outranked by its own body at ${viewport.label} (${sections!.map((section) => `${section.id}: ${describeReading(section.heading)}`).join("; ")})`,
    ).toEqual([]);
  }

  // Sensitivity proof, measured through the same probe: the pre-fix declarations
  // (12px/600/`--text-secondary` with caps and eyebrow tracking) are what the
  // review found, so putting them back has to reproduce the inversion. The injected
  // rule is unlayered, so it wins over the layered stylesheet.
  const before = await page.addStyleTag({
    content:
      ".game-group-title, .section-subtitle { font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-secondary); }\n",
  });
  const reverted = await measureGameSectionHeadings(page);
  console.log(`[defect-8 sections @400x800, pre-fix injected] ${JSON.stringify(reverted)}`);
  await before.evaluate((node) => node.remove());
  expect(reverted, "the Game surface renders with the pre-fix headings injected").not.toBeNull();
  expect(inversions(reverted!), "the pre-fix declarations are what the assertion above catches").not.toEqual([]);
});

// --- defect 9 ----------------------------------------------------------------

/**
 * What the drawer shows first on a fresh session, and where the one control it
 * offers sits. Read from the layout, so the answer is the player's and not the
 * source's: the drawer's own children in document order, the enable control's
 * box, the board's box and the installation panel's box.
 *
 * `order` is the drawer's children as `data-testid` / `id` / first class - the
 * reading order the surface really has, which is the property the two defects
 * are about. `below` is every element of the drawer whose top is past the fold.
 */
async function measureGameFold(page: Page) {
  return await page.evaluate(() => {
    const round = (value: number) => Math.round(value);
    const surface = document.querySelector<HTMLElement>('[data-testid="game-surface"]');
    if (surface === null) return null;
    const drawer = surface.querySelector<HTMLElement>(".composed-game-drawer");
    if (drawer === null) return null;
    const nameOf = (node: Element) =>
      node.getAttribute("data-testid") ?? node.id ?? node.className.toString().split(/\s+/u)[0] ?? "";
    const boxOf = (node: Element | null) => {
      if (node === null) return null;
      const box = node.getBoundingClientRect();
      return { top: round(box.top), bottom: round(box.bottom), height: round(box.height), left: round(box.left) };
    };
    const fold = window.innerHeight;
    const action = drawer.querySelector<HTMLElement>('[data-testid="game-activate"]');
    const board = drawer.querySelector<HTMLElement>('[data-testid="game-capability-board"]');
    const install = surface.querySelector<HTMLElement>(".game-installation-panel");
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      order: [...drawer.children].map(nameOf),
      action: boxOf(action),
      actionName: action === null ? null : (action.textContent ?? "").trim(),
      board: boxOf(board),
      install: boxOf(install),
      installVisible: install !== null && install.getBoundingClientRect().top < fold,
      actionInFold: action !== null && action.getBoundingClientRect().bottom <= fold,
      // The reading order, as positions rather than as a list: the action's own
      // top against the board's.
      actionBeforeBoard:
        action !== null &&
        board !== null &&
        (action.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      emptyCapabilityRegions: drawer.querySelectorAll('[data-capability-state="unpublished"]').length,
      boardCards: drawer.querySelectorAll("[data-capability-card]").length,
      boardParagraphs: board === null ? 0 : board.querySelectorAll("p").length,
    };
  });
}

/**
 * Defect 9: on a fresh session the first thing in the reading order is the
 * action the player can take, and it is inside the first viewport at 1440x900.
 *
 * The failure this catches: the drawer led with the capability board while the
 * board had nothing to publish, so the fold spent itself on three cards that
 * each said "nothing" and pushed 启用伙伴陪玩 into the second column (at
 * 1440x900) or below the fold (at 400x800). The guide's own sentence then sent
 * the player "下方「游戏安装」" at a panel that was not on screen.
 *
 * The assertion is the order and the geometry, and it is made at both widths
 * because the narrow one is the worse case: at 400x800 there is no second
 * column for the control to hide in, so its position *is* the reading order.
 */
test("defect 9: a fresh session opens on the action it can take, inside the first viewport", async ({ page }) => {
  await mountShell(page, { locale: "en" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
  await expect(page.locator(".game-capability-board")).toBeVisible();
  await expect(page.getByTestId("game-activate")).toBeVisible();
  await expect(page.locator(".game-installation-panel")).toBeVisible();

  const measured: Record<string, Awaited<ReturnType<typeof measureGameFold>>> = {};
  for (const viewport of [
    { width: 1440, height: 900, label: "1440x900" },
    { width: 400, height: 800, label: "400x800" },
  ] as const) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect(page.getByTestId("game-activate")).toBeVisible();
    const reading = await measureGameFold(page);
    console.log(`[defect-9 fold @${viewport.label}] ${JSON.stringify(reading)}`);
    measured[viewport.label] = reading;
    expect(reading, `the Game surface renders its first viewport at ${viewport.label}`).not.toBeNull();

    // The action is the first group in the reading order: the drawer's first
    // child is the group that holds it, not the board that has nothing to say.
    expect(
      reading!.order[0],
      `the first group on the surface is the one carrying the action at ${viewport.label} (order: ${reading!.order.join(" > ")})`,
    ).toBe("game-group-next-step");
    expect(
      reading!.actionBeforeBoard,
      `the action precedes the empty board in document order at ${viewport.label}`,
    ).toBe(true);
    // …and it is really inside the first viewport, not merely earlier in the DOM.
    expect(
      reading!.actionInFold,
      `the action's bottom (${reading!.action?.bottom}) is inside the ${viewport.height} px viewport at ${viewport.label}`,
    ).toBe(true);
    expect(reading!.actionName, `the control is the one a fresh session can press at ${viewport.label}`).toBe(
      "Enable companion play",
    );
  }

  // The guide no longer points at a panel that is not on screen: the sentence
  // sends the player to this page rather than "below", because at 1440x900 the
  // installation panel starts at y=856 in a 900 px window and at 400x800 it is
  // not in the viewport at all.
  await expect(page.locator('[data-guide-step="1"] .game-guide-step-detail')).toContainText(
    "under Game installation on this page",
  );
  await expect(page.locator('[data-guide-step="1"] .game-guide-step-detail')).not.toContainText(
    "under Game installation first",
  );
});

// --- defect 10 ---------------------------------------------------------------

/**
 * Defect 10: the empty capability state is one element and one sentence.
 *
 * The failure this catches: "your companion / nothing published / no action
 * authority" is one fact - the session has published nothing - told as three
 * cards, each titled by its own emptiness, in about 250 px of the fold. The
 * board must say it once, and the state must have a name an assertion can use:
 * `data-capability-state="unpublished"` on the region, with no card inside it.
 *
 * The published side is asserted in the same test so the rule cannot be satisfied
 * by deleting the cards outright: with a capability summary the board still
 * renders one card per published fact.
 */
test("defect 10: the empty capability state is a single element with a single name", async ({ page }) => {
  await mountShell(page, { locale: "en" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Game", exact: true }).click();

  const board = page.getByTestId("game-capability-board");
  await expect(board).toHaveAttribute("data-capability-state", "unpublished");
  // One element, one sentence: no card, and the region carries no list at all.
  await expect(board.locator("[data-capability-card]")).toHaveCount(0);
  await expect(board.locator(".game-capability-cards")).toHaveCount(0);
  await expect(board.locator("p")).toHaveCount(1);
  // The whole absence is stated once, in the board's own words, and says what it
  // is waiting for rather than only that there is nothing.
  const sentence = ((await board.locator("p").innerText()) ?? "").replace(/\s+/gu, " ").trim();
  console.log(`[defect-10 empty board] ${JSON.stringify(sentence)}`);
  expect(sentence, "the empty board states the absence in one sentence").toContain(
    "has not published what your companion can do with you yet",
  );
  expect(sentence, "and it names what it is waiting for").toContain("come from the game itself");

  // No second element on the whole panel says the same thing: the three-card
  // shape cannot come back through a sibling region.
  const drawer = page.locator(".composed-game-drawer");
  await expect(drawer.locator('[data-capability-state="unpublished"]')).toHaveCount(1);
});

/**
 * The other half of defect 10, so the rule cannot be satisfied by deleting the
 * cards outright: with a published capability summary the board still renders one
 * card per published fact, and the region says so under its own name.
 */
test("defect 10: a published capability surface still renders one card per fact", async ({ page }) => {
  await mountShell(page, { locale: "en" });
  // Both reads carry the published summary: the shell re-reads `game.state.read`
  // on a mount, so a bootstrap-only fixture would be overwritten by the empty one.
  const root = composedRoot();
  const published = JSON.stringify({
    ...root,
    game: { ...root.game, game: { ...root.game.game, capabilitySummary: { available: true, count: 4 } } },
  });
  for (const pattern of ["**/api/composed-reference-game/v1/bootstrap", "**/api/composed-reference-game/v1/state"])
    await page.route(pattern, (route) => route.fulfill({ status: 200, contentType: "application/json", body: published }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.getByRole("button", { name: "Game", exact: true }).click();

  const board = page.getByTestId("game-capability-board");
  await expect(board).toHaveAttribute("data-capability-state", "published");
  await expect(board.locator("[data-capability-card]")).toHaveCount(3);
  await expect(board).toContainText("4");
});
