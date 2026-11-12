/**
 * The shell's own furniture: the conversation column, the bar at both widths, and the fold.
 *
 * The transcript and the composer are the column and the model settings are a popout; the
 * 400px strip folds its trailing peers behind one More and gives the companion's name back; and
 * the current peer surface is marked by a shape rather than by colour alone, including through
 * the More disclosure and under the keyboard.
 */
import { expect, test } from "./frontend-coverage";
import { token, draft, chat, root } from "./composed-reference-game-fixtures";

/**
 * The conversation column's composition, which is the whole of reviewer point 1.
 *
 * The failures this catches, in order:
 *
 * 1. A resident form coming back into the reading flow. The conversation column
 *    must be the transcript and the composer band and nothing else, so the
 *    direct children of the surface's content are asserted by class: a
 *    `reference-draft-section` or a `surface-model-settings` inserted between
 *    them fails here, which is exactly the measured "首屏被挤压" regression.
 * 2. The durable draft silently stopping at the boundary. It must reach the
 *    composer's own field, so a draft that is read but never prefilled fails -
 *    and the same command (`PUT /api/tavern/v1/draft` under the mounted
 *    revision CAS) must still be what saving sends.
 * 3. The model settings becoming unreachable when they left the column. The
 *    popout must open the same controls and the column must still hold no form
 *    while it is open; closing must return focus to the control that opened it.
 */
test("the conversation column is the transcript and the composer, with the model settings as a popout", async ({ page }) => {
  const draftWrites: unknown[] = [];
  let draftState = { apiVersion: 1, revision: draft.revision, text: draft.text };
  // The composer's own enablement is a projection of the nested Chat snapshot:
  // `submitAvailable` needs the published `chat.submit` operation, exactly as a
  // real profile declares it (the reference profile composition publishes the
  // same record). The base `chat` fixture lists no operations, so the composer
  // renders disabled and a journey that must *type* has to publish the
  // operation rather than work around it.
  const submittable = {
    ...root,
    chat: {
      ...chat,
      operations: [
        {
          operationId: "chat.submit",
          labelKey: "tavern.operation.submit",
          availability: "available",
          routeId: "chat.submit",
        },
      ],
    },
  };

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(submittable) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(submittable) }),
  );
  await page.route("**/api/tavern/v1/draft", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draftState) });
      return;
    }
    draftWrites.push(route.request().postDataJSON());
    draftState =
      route.request().method() === "DELETE"
        ? { apiVersion: 1, revision: 6, text: null }
        : { apiVersion: 1, revision: 5, text: draft.text };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draftState) });
  });
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        chat: { revision: 1, thinkingLevel: "medium" },
        game: { revision: 1, thinkingLevel: "medium" },
        recommendedModels: [
          {
            providerId: "cpa-oai",
            providerLabel: "CPA OAI",
            modelId: "deepseek-v4",
            modelLabel: "DeepSeek V4",
            allowedThinkingLevels: ["off", "medium", "high"],
            defaultThinkingLevel: "medium",
          },
        ],
      }),
    }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  const chatSurface = page.getByTestId("chat-surface");
  await expect(chatSurface).toBeVisible();

  // The reading flow is the transcript and the composer band, in that order.
  const content = chatSurface.locator(".surface-content > *");
  await expect(content).toHaveCount(2);
  await expect(content.nth(0)).toHaveClass(/timeline/);
  await expect(content.nth(1)).toHaveClass(/composer-section/);
  // Nothing in the conversation column is a form, and the only field in it is
  // the composer's own.
  await expect(chatSurface.locator("form")).toHaveCount(0);
  await expect(chatSurface.locator(".surface-model-settings")).toHaveCount(0);
  await expect(chatSurface.locator("input, select, textarea")).toHaveCount(1);

  // The draft reached the composer, and its verbs are in the composer band.
  const composer = chatSurface.locator(".composer-textarea");
  await expect(composer).toHaveValue(draft.text);
  const draftRow = chatSurface.locator(".composer-draft");
  await expect(draftRow).toBeVisible();
  await expect(draftRow).toContainText("Saved draft");

  // Saving sends the same command it always did: the composed field's text under
  // the mounted draft's revision CAS.
  await composer.fill("Edited in the composer.");
  await draftRow.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => draftWrites.length).toBe(1);
  expect(draftWrites[0]).toEqual({
    apiVersion: 1,
    selectionGeneration: 1,
    expectedRevision: 4,
    text: "Edited in the composer.",
  });

  // Discarding clears the field and takes its own row with it.
  await draftRow.getByRole("button", { name: "Discard", exact: true }).click();
  await expect.poll(() => draftWrites.length).toBe(2);
  expect(draftWrites[1]).toEqual({ apiVersion: 1, selectionGeneration: 1, expectedRevision: 5 });
  await expect(chatSurface.locator(".composer-draft")).toHaveCount(0);
  await expect(composer).toHaveValue("");

  // The model settings are one click away, over the conversation.
  const drawer = page.getByTestId("chat-model-drawer");
  const trigger = chatSurface.getByTestId("chat-model-trigger");
  await expect(drawer).toHaveCount(0);
  await expect(chatSurface.locator(".surface-model-settings")).toHaveCount(0);
  await trigger.click();
  const popout = page.getByRole("dialog", { name: "Chat model settings" });
  await expect(popout).toBeVisible();
  // The product's own drawer, under its frozen testid: the assertion is about
  // `chat-model-drawer`, not about the shared primitive's own tests.
  await expect(drawer).toBeVisible();
  await expect(popout.locator(".surface-model-settings")).toBeVisible();
  // This surface owns the level it reasons at; the model comes from the active connection.
  await expect(popout.getByLabel("Thinking level")).toHaveValue("medium");
  await expect(popout.getByRole("button", { name: "deepseek-v4" })).toHaveCount(0);
  await expect(popout.locator(".surface-model-chip").first()).toContainText("deepseek-v4");
  // ...and the conversation column still carries no form while it is open.
  await expect(chatSurface.locator("input, select, textarea")).toHaveCount(1);

  // Escape closes this exact drawer and gives focus back to the button that
  // opened it. The failure this catches: a popout whose only way out is its
  // backdrop strands a keyboard player over the conversation, and focus
  // dropped on <body> makes the next Tab restart from the top of the shell.
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(popout).toHaveCount(0);
  await expect(page.getByTestId("chat-model-trigger")).toBeFocused();
});


/**
 * The mini-window floor (owner's item 3, corrected).
 *
 * GameBuddy is usually a 400-500 px strip floating beside Stardew Valley, and
 * the composed shell's AppBar carries six peer entries. At 400 px the rail was
 * about 300 px of a 400 px bar, so the companion block - the one thing that says
 * who the player is talking to - was squeezed to a bare "(". The correction:
 * fold the trailing peers behind one `More` affordance at ≤480 px, keep the
 * conversation and the game surface visible, and give the name its width back.
 *
 * The failure each assertion catches, in order:
 *
 * 1. a bar that overflows its own window - the floating strip grows a sideways
 *    scrollbar and the conversation column is laid out against a width it does
 *    not have;
 * 2. a name that "fits" by being clipped - the measurement is the name's own
 *    box, not the bar's, and the name must be whole (no ellipsis) and at least
 *    150 px wide, which is the width the fold frees;
 * 3. entries that fit by being dropped or shrunk below the touch floor - every
 *    peer is still in the bar, named, 44 px, and inside the window, and the four
 *    folded ones are reachable through the disclosure and really select their
 *    surface (a hidden button that exists only in the DOM is not reachable);
 * 4. a wide bar that changed - at 1440 px the bar must be exactly the row it
 *    was: six peers in order, labels visible, and the fold wrapper no box at all.
 */
test("the 400px strip folds its trailing peers behind one More and gives the companion's name back", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/tavern/v1/chats", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, chats: [] }) }),
  );

  await page.setViewportSize({ width: 400, height: 720 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  // The conversation surface is the one shown, so the strip is measured in the
  // state a player actually works in.
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();

  const narrow = await page.evaluate(() => {
    const title = document.querySelector<HTMLElement>(".app-bar-title");
    const trigger = document.querySelector<HTMLElement>(".app-bar-more-trigger");
    return {
      viewport: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      name: {
        text: (title?.textContent ?? "").trim(),
        clientWidth: title?.clientWidth ?? 0,
        scrollWidth: title?.scrollWidth ?? 0,
      },
      triggerWidth: trigger === null ? 0 : Math.round(trigger.getBoundingClientRect().width),
      entries: [...document.querySelectorAll<HTMLElement>(".app-bar-actions .nav-button")].map((entry) => {
        const box = entry.getBoundingClientRect();
        return {
          name: entry.getAttribute("aria-label"),
          title: entry.getAttribute("title"),
          visible: box.width > 0 && box.height > 0,
          left: Math.round(box.left),
          right: Math.round(box.right),
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      }),
    };
  });

  // 1. The document itself never scrolls sideways at 400 px.
  expect(narrow.documentScrollWidth).toBeLessThanOrEqual(narrow.viewport);
  // 2. The name the strip exists for is whole, and has its 150 px back.
  expect(narrow.name.text, "the strip still names the companion").toBe("Mira");
  expect(narrow.name.scrollWidth, "the companion's name is rendered in full, not ellipsised").toBeLessThanOrEqual(
    narrow.name.clientWidth + 1,
  );
  expect(narrow.name.clientWidth, "the companion's name gets back 150 px or more").toBeGreaterThanOrEqual(150);
  // 3. Two peers and the disclosure are the strip's rail; every one is a real target.
  expect(narrow.entries.filter((entry) => entry.visible).map((entry) => entry.name)).toEqual([
    "Chat",
    "Game",
    "More",
  ]);
  // The other four are in the bar, not dropped: six peers plus the trigger.
  expect(narrow.entries).toHaveLength(7);
  expect(narrow.entries.filter((entry) => !entry.visible).map((entry) => entry.name)).toEqual([
    "Chats",
    "Characters",
    "Settings",
    "Memory",
  ]);
  for (const entry of narrow.entries.filter((candidate) => candidate.visible)) {
    expect(entry.name, "every entry keeps its accessible name").toBeTruthy();
    expect(entry.title).toBe(entry.name);
    expect(entry.width).toBeGreaterThanOrEqual(44);
    expect(entry.height).toBeGreaterThanOrEqual(44);
    expect(entry.left).toBeGreaterThanOrEqual(0);
    expect(entry.right).toBeLessThanOrEqual(narrow.viewport);
  }
  expect(narrow.triggerWidth).toBeGreaterThanOrEqual(44);
  console.log(
    `[appbar] 400px: name "${narrow.name.text}" ${narrow.name.clientWidth}px (scrollWidth ${narrow.name.scrollWidth}); rail ${narrow.entries
      .filter((entry) => entry.visible)
      .map((entry) => entry.name)
      .join(" > ")}; folded ${narrow.entries
      .filter((entry) => !entry.visible)
      .map((entry) => entry.name)
      .join(", ")}; document ${narrow.documentScrollWidth}/${narrow.viewport}`,
  );

  // The four folded peers are reachable, named, and the same size as the rail's.
  await page.getByRole("button", { name: "More", exact: true }).click();
  const panel = page.locator(".app-bar-more-menu");
  const folded = await panel.locator(".nav-button").evaluateAll((entries) =>
    entries.map((entry) => {
      const box = entry.getBoundingClientRect();
      return {
        name: entry.getAttribute("aria-label"),
        label: (entry.querySelector(".nav-label")?.textContent ?? "").trim(),
        width: Math.round(box.width),
        height: Math.round(box.height),
        right: Math.round(box.right),
      };
    }),
  );
  expect(folded.map((entry) => entry.name)).toEqual(["Chats", "Characters", "Settings", "Memory"]);
  for (const entry of folded) {
    expect(entry.label, "a folded entry reads by name inside the panel").toBe(entry.name);
    expect(entry.height).toBeGreaterThanOrEqual(44);
    expect(entry.right).toBeLessThanOrEqual(narrow.viewport);
  }

  // Escape closes the disclosure and gives focus back to the control that opened
  // it, without also stepping the shell back to the conversation behind it.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: "More", exact: true })).toBeFocused();

  // A folded entry really selects its surface - the whole point of keeping it.
  await page.getByRole("button", { name: "More", exact: true }).click();
  await panel.getByRole("button", { name: "Chats", exact: true }).click();
  await expect(page.getByTestId("chats-surface")).toBeVisible();
  await expect(panel).toBeHidden();

  // 4. At 1440 px the bar is the row it always was: six peers, labels and all,
  // and the fold wrapper is not a box at all.
  await page.setViewportSize({ width: 1440, height: 900 });
  const wide = await page.evaluate(() => {
    const wrapper = document.querySelector<HTMLElement>(".app-bar-more");
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      wrapper: wrapper === null ? null : { width: Math.round(wrapper.getBoundingClientRect().width), display: getComputedStyle(wrapper).display },
      entries: [...document.querySelectorAll<HTMLElement>(".app-bar-actions .nav-button")].map((entry) => ({
        name: entry.getAttribute("aria-label"),
        labelDisplay: entry.querySelector<HTMLElement>(".nav-label") === null ? null : getComputedStyle(entry.querySelector<HTMLElement>(".nav-label")!).display,
        width: Math.round(entry.getBoundingClientRect().width),
        top: Math.round(entry.getBoundingClientRect().top),
        right: Math.round(entry.getBoundingClientRect().right),
      })),
    };
  });
  expect(wide.documentScrollWidth).toBeLessThanOrEqual(wide.viewport);
  // Six peers, in order, each with the width it has always had; the trigger is in
  // the DOM but has no box and no name in the accessibility tree.
  const widePeers = wide.entries.filter((entry) => entry.width > 0);
  expect(widePeers.map((entry) => entry.name)).toEqual([
    "Chat",
    "Game",
    "Chats",
    "Characters",
    "Settings",
    "Memory",
  ]);
  expect(new Set(widePeers.map((entry) => entry.top)).size, "the peers share one row").toBe(1);
  for (const entry of widePeers)
    expect(entry.labelDisplay, "a wide bar shows every peer's name").not.toBe("none");
  expect(wide.entries.find((entry) => entry.name === "More")?.width, "the trigger is not a box on a wide bar").toBe(0);
  expect(wide.wrapper?.display, "the fold wrapper is no box at all on a wide bar").toBe("contents");
  expect(wide.wrapper?.width).toBe(0);
  // The trigger does not exist where nothing folds.
  expect(await page.getByRole("button", { name: "More", exact: true }).count()).toBe(0);
});


/**
 * The current peer surface is marked by a shape, not only by a colour.
 *
 * At 1440 the bar is the whole of "where am I": the surface's own `<h2>` is
 * clipped away, so a player's only on-screen answer is the nav entry carrying
 * `aria-current="page"`. What that entry had was colour - `--accent` instead of
 * `--text-secondary`, `--surface-raised` instead of transparent,
 * `--border-strong` instead of transparent - and a state that is three colour
 * steps apart from its peers is invisible to a colour-blind player and to a
 * low-contrast theme. The bar (`.nav-button.active { box-shadow: inset 0 -2px 0 0
 * currentColor }`, style.css) is the channel that does not depend on colour, and
 * being `currentColor` it adds no colour step to the sheet.
 *
 * The bar and not an absolutely positioned `::after`: a pseudo element needs
 * `position: relative` on the entry and declares `bottom` on it, which turns the
 * entry's own `transition: all` into a motion site
 * (`tests/reduced-motion-gate.test.mjs`) and owes a reduced-motion escape for a
 * bar that never moves. An inset shadow is paint, and it costs the entry no box,
 * so the 400 px strip's measured widths are what they were.
 *
 * The readings quoted below are this same journey, mounted, with the pointer
 * parked away from the bar, taken from a run with the one rule reverted:
 *
 *  - 1440, Chat current - before: `box-shadow: none`, identical to Game's, and the
 *    two differed only in colour - `color: rgb(200, 120, 125)` vs
 *    `rgb(200, 192, 182)`, `background: rgb(32, 29, 29)` vs `rgba(0, 0, 0, 0)`,
 *    `border-color: rgba(255, 255, 255, 0.15)` vs `rgba(0, 0, 0, 0)` - with
 *    `font-weight: 500` on both. After: `rgb(200, 120, 125) 0px -2px 0px 0px
 *    inset` against Game's `none`. So the assertion below is exactly the one
 *    that failed before.
 *  - 400, Memory current (one of the four folded peers) - before: `Memory` and
 *    the `More` trigger both read `box-shadow: none`, and the trigger carried no
 *    `active` state (`class="nav-button app-bar-more-trigger"`), so the strip said
 *    nothing about which of the four was showing. After: both read
 *    `rgb(200, 120, 125) 0px -2px 0px 0px inset` while the other five entries
 *    read `none`.
 *
 * Each assertion, and the failure it catches:
 *  - the selected entry draws the bar and a non-current sibling does not:
 *    catches a state that is still colour-only;
 *  - the bar is painted in the entry's own `color`: catches a bar that quietly
 *    introduced a second accent (or a hardcoded one);
 *  - `aria-current="page"` stays on exactly one entry and never on the trigger:
 *    catches the visual state drifting away from the accessible one, and a
 *    disclosure claiming to be the page;
 *  - the trigger carries the state only while the current surface is folded
 *    inside it: catches a `More` that is always lit (which would be the same
 *    "nothing on screen tells you" one state over) and one that never is;
 *  - a hovered entry draws no bar, and a keyboard-focused one draws the sheet's
 *    gold ring instead of it: catches the bar leaking out of the selected state,
 *    which would make hover, focus and current indistinguishable from each other.
 *  - hover and the current entry keep the SAME raised paint (`rgb(32, 29, 29)`
 *    on both) and differ only in colour: that is the bar with no bar, and it is
 *    why the bar - not a fourth colour - is what has to separate them.
 */
test("the current peer surface is marked by a shape in the bar, at both widths and through the More disclosure", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/tavern/v1/chats", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, chats: [] }) }),
  );

  const readBar = () =>
    page.evaluate(() => {
      const read = (node: HTMLElement) => {
        const entry = getComputedStyle(node);
        return {
          name: node.getAttribute("aria-label"),
          current: node.getAttribute("aria-current"),
          active: node.classList.contains("active"),
          color: entry.color,
          background: entry.backgroundColor,
          weight: entry.fontWeight,
          outline: `${entry.outlineWidth} ${entry.outlineStyle} ${entry.outlineColor}`,
          bar: entry.boxShadow,
        };
      };
      // Every nav control the bar renders, including the ones the `More` disclosure holds: the folded entries are
      // `renderEntry`'d inside `.app-bar-more-menu`, not inside `.app-bar-actions`, so a selector rooted at the
      // actions row alone never sees them and `entries` was always missing the four folded peers.
      const entries = [...document.querySelectorAll<HTMLElement>(".app-bar .nav-button:not(.app-bar-more-trigger)")];
      const trigger = document.querySelector<HTMLElement>(".app-bar-more-trigger");
      return {
        entries: entries.map(read),
        trigger: trigger === null ? null : { ...read(trigger), expanded: trigger.getAttribute("aria-expanded") },
        triggerDrawn: trigger !== null && trigger.getBoundingClientRect().width > 0,
      };
    });
  /** No bar: the entry paints no shadow at all. */
  const unmarked = "none";

  // The strip this product lives in: Memory is one of the four peers that fold
  // behind `More` at 400 px, so the trigger is the only thing on screen that can
  // report it.
  await page.setViewportSize({ width: 400, height: 720 });
  await page.mouse.move(1, 700);
  // Reached the way a player reaches it, not through the hash: the shell restores a surface from `panel=` only for the
  // ids it knows, and this journey spent four attempts waiting for a `Memory` entry that never became current.
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await expect(page.getByTestId("memory-surface")).toBeVisible();
  // A CI-only disagreement cannot be diagnosed from `expected 1, received 0`, so this loops itself and prints the whole
  // reading every attempt: the trigger's class list and each folded entry's own flags. The assertion then runs on the
  // last reading, so a failure on a slower machine leaves the state in the log instead of only the expectation.
  const readFoldedBar = () =>
    page.evaluate(() => {
      const triggers = [...document.querySelectorAll<HTMLElement>(".app-bar-more-trigger")];
      const menus = [...document.querySelectorAll<HTMLElement>(".app-bar-more-menu")];
      const bars = [...document.querySelectorAll<HTMLElement>(".app-bar")];
      const moreWrap = document.querySelector<HTMLElement>(".app-bar-more");
      const trigger = triggers[0] ?? null;
      const folded = [...(menus[0]?.querySelectorAll<HTMLElement>(".nav-button") ?? [])];
      const triggerClass = trigger === null ? null : trigger.className;
      return {
        // `data-folded-active` is what the component computed; `triggerClass` is what reached the DOM. If they disagree
        // the render and the commit disagree, which is a React-level question, not a selector one.
        computedFoldedActive: moreWrap?.getAttribute("data-folded-active") ?? null,
        // The count is the question: one render pass cannot produce a folded entry with `active` beside a trigger without
        // it, since both read the same `foldedEntries`. Two bars in the document can.
        barCount: bars.length,
        triggerCount: triggers.length,
        menuCount: menus.length,
        triggerClasses: triggers.map((node) => node.className),
        triggerClass,
        active: triggerClass !== null && /(^|\s)active(\s|$)/.test(triggerClass),
        folded: folded.map((node) => ({
          name: node.getAttribute("aria-label"),
          current: node.getAttribute("aria-current"),
          className: node.className,
        })),
      };
    });

  let foldedBar = await readFoldedBar();
  for (let attempt = 0; attempt < 60 && !foldedBar.active; attempt += 1) {
    console.log(`[folded-bar ${attempt}] ${JSON.stringify(foldedBar)}`);
    await page.waitForTimeout(500);
    foldedBar = await readFoldedBar();
  }
  console.log(`[folded-bar final] ${JSON.stringify(foldedBar)}`);
  expect(foldedBar.folded.some((entry) => entry.current === "page"), "a folded entry is the selected surface").toBe(
    true,
  );
  expect(foldedBar.active, "the trigger carries the folded current surface's state").toBe(true);
  await page.waitForTimeout(200);

  const narrow = await readBar();
  const narrowCurrent = narrow.entries.filter((entry) => entry.current === "page");
  console.log(
    `[nav-current] 400 memory: ${narrow.entries
      .map((entry) => `${entry.name}{current=${entry.current ?? "-"} active=${entry.active} bar=${entry.bar}}`)
      .join(" ")}`,
  );
  expect(narrow.triggerDrawn, "the strip folds at 400 px").toBe(true);
  expect(narrow.trigger?.name).toBe("More");
  expect(narrowCurrent.map((entry) => entry.name)).toEqual(["Memory"]);
  expect(narrowCurrent[0]!.bar, "the folded current entry draws the bar itself").not.toBe(unmarked);
  expect(narrow.trigger?.current, "the disclosure is not the page").toBeNull();
  expect(narrow.trigger?.active, "the trigger carries the folded current surface's state").toBe(true);
  expect(narrow.trigger?.bar, "the trigger reports the surface it is hiding").toBe(narrowCurrent[0]!.bar);
  // Everything else - the rail's own two visible entries and the three peers
  // that are not current - draws nothing: the bar is the selection's alone.
  for (const entry of narrow.entries.filter((candidate) => !candidate.active))
    expect(entry.bar, `${entry.name} is not current and must not draw the bar`).toBe(unmarked);

  // Returning to a surface the rail shows directly releases the trigger: a
  // `More` that stayed lit would be the same "nothing tells you" one state over.
  await page.locator('.app-bar-actions .nav-button[aria-label="Chat"]').click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.mouse.move(1, 700);
  await page.waitForTimeout(200);
  const narrowChat = await readBar();
  console.log(
    `[nav-current] 400 chat: ${narrowChat.entries
      .map((entry) => `${entry.name}{current=${entry.current ?? "-"} active=${entry.active} bar=${entry.bar}}`)
      .join(" ")}`,
  );
  expect(narrowChat.trigger?.current, "selecting a rail surface does not mark the disclosure").toBeNull();
  expect(narrowChat.trigger?.active, "Chat is on the rail, so nothing folded is current").toBe(false);
  expect(narrowChat.trigger?.bar).toBe(unmarked);
  expect(narrowChat.entries.filter((entry) => entry.current === "page").map((entry) => entry.name)).toEqual(["Chat"]);

  // The wide bar, where the entry's own word is the only other thing that could
  // say where the player is.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.mouse.move(1, 890);
  await page.waitForTimeout(200);

  const wide = await readBar();
  const currentWide = wide.entries.filter((entry) => entry.current === "page");
  const selected = currentWide[0]!;
  const sibling = wide.entries.find((entry) => entry.name === "Game")!;
  console.log(
    `[nav-current] 1440 chat: ${wide.entries
      .map((entry) => `${entry.name}{current=${entry.current ?? "-"} color=${entry.color} weight=${entry.weight} bar=${entry.bar}}`)
      .join(" ")}`,
  );
  expect(wide.triggerDrawn, "the trigger is no box on a wide bar").toBe(false);
  expect(currentWide.map((entry) => entry.name), "exactly one peer reports the page").toEqual(["Chat"]);
  expect(selected.bar, "the current entry draws a bar a sibling does not").not.toBe(unmarked);
  // An inset shadow along the bottom edge, painted in the entry's own colour.
  expect(selected.bar, "the bar is inset, so it costs the entry no box").toContain("inset");
  expect(selected.bar, "the bar is the entry's own colour, not a new palette step").toContain(selected.color);
  expect(sibling.bar, "a non-current sibling in the same row draws no bar").toBe(unmarked);

  // Hover and focus keep their own channels and never draw the bar.
  await page.hover('.app-bar-actions .nav-button[aria-label="Game"]');
  await page.waitForTimeout(200);
  const hovered = (await readBar()).entries.find((entry) => entry.name === "Game")!;
  await page.locator('.app-bar-actions .nav-button[aria-label="Game"]').focus();
  // Keyboard focus has its own channel - the sheet's `:focus-visible` ring - and
  // a programmatic `.focus()` is not it, so the ring is measured the way a
  // keyboard player reaches the rail: by tabbing to it.
  for (let hop = 0; hop < 8; hop += 1) {
    await page.keyboard.press("Tab");
    if (
      await page.evaluate(() => {
        const node = document.activeElement;
        return (
          node instanceof HTMLElement && node.classList.contains("nav-button") && node.getAttribute("aria-current") === null
        );
      })
    )
      break;
  }
  // The ring is a transitioned property (`transition: all` on the entry), so the
  // reading is taken once it has settled.
  await page.waitForTimeout(200);
  const tabbed = await page.evaluate(() => {
    const node = document.activeElement;
    if (!(node instanceof HTMLElement) || !node.classList.contains("nav-button")) return null;
    const style = getComputedStyle(node);
    return {
      name: node.getAttribute("aria-label"),
      current: node.getAttribute("aria-current"),
      outline: `${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}`,
      bar: style.boxShadow,
    };
  });
  console.log(
    `[nav-current] 1440 states: hovered Game color=${hovered.color} bg=${hovered.background} bar=${hovered.bar}; tabbed ${tabbed?.name} outline=${tabbed?.outline} bar=${tabbed?.bar}`,
  );
  expect(hovered.bar, "a hovered entry is not the current one").toBe(unmarked);
  // Hover and the current entry share one raised paint, so on a colour-blind
  // player's screen the bar is the only thing that separates them - which is
  // exactly why a hover must never draw it.
  expect(hovered.background, "hover paints the same raised surface the current entry keeps").toBe(selected.background);
  expect(hovered.color, "hover and current differ in colour, and only the bar survives that").not.toBe(selected.color);
  expect(tabbed, "Tab reaches the bar's own entries").not.toBeNull();
  expect(tabbed?.current, "a non-current entry is what the ring is measured on").toBeNull();
  expect(tabbed?.outline, "the keyboard-focused entry draws the focus ring").toContain("solid");
  expect(tabbed?.bar, "focus is not the current state").toBe(unmarked);
});

