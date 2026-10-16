// Driver B: the Characters surface — grid column count, per-row card heights, each row's largest
// residual gap, the panel height, and the persona card label at both widths.
const path = require("node:path");
const { connect, reporter, SHOTS, PAGE_HELPERS, activateSurface, shot } = require("./common.cjs");

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("b-characters.txt");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(`${PAGE_HELPERS};undefined`);
  await activateSurface(page, "角色");
  await page.waitForTimeout(1500);

  const facts = await page.evaluate(() => {
    const panel = document.querySelector("[data-characters-panel]");
    const content = document.querySelector('[data-testid="characters-surface"] .surface-content');
    const grid = getComputedStyle(panel);
    const cards = [...panel.children].map((card) => {
      const r = card.getBoundingClientRect();
      return {
        title: String((card.innerText || "").split("\n")[0] || "").slice(0, 32),
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom),
      };
    });
    const sorted = [...cards].sort((left, right) => left.y - right.y || left.x - right.x);
    const rows = [];
    for (const card of sorted) {
      const row = rows.find((candidate) => Math.abs(candidate.top - card.y) <= 24);
      if (row === undefined) rows.push({ top: card.y, cards: [card] });
      else row.cards.push(card);
    }
    return {
      gridTemplateColumns: grid.gridTemplateColumns,
      columnCount: grid.gridTemplateColumns.split(" ").filter((part) => part.length > 0).length,
      alignContent: grid.alignContent,
      alignItems: grid.alignItems,
      gridGap: `${grid.rowGap} / ${grid.columnGap}`,
      panelWidth: Math.round(panel.getBoundingClientRect().width),
      panelHeight: Math.round(panel.getBoundingClientRect().height),
      cardCount: cards.length,
      rows: rows.map((row) => {
        const bottom = Math.max(...row.cards.map((card) => card.bottom));
        const residuals = row.cards.map((card) => bottom - card.bottom);
        return {
          top: row.top,
          columnCount: row.cards.length,
          titles: row.cards.map((card) => card.title),
          cardWidths: row.cards.map((card) => card.w),
          cardHeights: row.cards.map((card) => card.h),
          cardBottoms: row.cards.map((card) => card.bottom),
          rowBottom: bottom,
          residualGaps: residuals,
          largestResidualGap: Math.max(...residuals),
        };
      }),
      scroller: content === null ? null : { scrollHeight: content.scrollHeight, clientHeight: content.clientHeight, overflowY: getComputedStyle(content).overflowY },
    };
  });

  const personaLabels = () => {
    const panel = document.querySelector("[data-characters-panel]");
    const cards = [...panel.children].map((card) => ({
      ariaLabel: card.getAttribute("aria-label"),
      firstLine: String((card.innerText || "").split("\n")[0] || ""),
      headings: [...card.querySelectorAll("h1,h2,h3,h4")].map((heading) => (heading.textContent || "").trim()),
      hasPersonaEditor: card.querySelector("[data-persona-editor]") !== null,
    }));
    const personaCard = cards.find((card) => card.hasPersonaEditor) ?? cards.find((card) => /Persona|用户设定/.test(card.firstLine)) ?? null;
    const editor = document.querySelector("[data-persona-editor]");
    const editorHeading = editor === null ? null : editor.querySelector("h3");
    return {
      cardFirstLines: cards.map((card) => card.firstLine),
      cardAriaLabels: cards.map((card) => card.ariaLabel),
      personaEditorHeadingText: editorHeading === null ? null : (editorHeading.textContent || "").trim(),
      personaEditorSectionAriaLabel: editor === null ? null : editor.getAttribute("aria-label"),
      personaTitleInText: (document.querySelector('[data-testid="characters-surface"]')?.innerText ?? "").includes("用户设定"),
      personaTaxonomyTailVisible: /用户设定\s*\(Persona\)/.test(document.querySelector('[data-testid="characters-surface"]')?.innerText ?? ""),
      personaWordPersonaVisible: /Persona/.test(document.querySelector('[data-testid="characters-surface"]')?.innerText ?? ""),
    };
  };

  say("=== ITEM: Characters persona label @1440x900 ===");
  say(JSON.stringify(await page.evaluate(personaLabels), null, 1));
  say("=== ITEM: Characters grid @1440x900 ===");
  say(JSON.stringify(facts, null, 1));
  await shot(page, "60-characters-grid-1440x900.png");
  const panel = page.locator("[data-characters-panel]");
  await panel.screenshot({ path: path.join(SHOTS, "61-characters-panel-1440x900.png"), timeout: 45000 }).catch(() => undefined);
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(1200);
  await shot(page, "60-characters-grid-400x800.png");
  say("=== ITEM: Characters persona label @400x800 ===");
  say(JSON.stringify(await page.evaluate(personaLabels), null, 1));
  say("=== ITEM: Characters grid @400x800 ===");
  say(JSON.stringify(await page.evaluate(() => {
    const panel = document.querySelector("[data-characters-panel]");
    const grid = getComputedStyle(panel);
    const content = document.querySelector('[data-testid="characters-surface"] .surface-content');
    return {
      gridTemplateColumns: grid.gridTemplateColumns,
      panelWidth: Math.round(panel.getBoundingClientRect().width),
      panelHeight: Math.round(panel.getBoundingClientRect().height),
      cardCount: panel.children.length,
      scroller: { scrollHeight: content.scrollHeight, clientHeight: content.clientHeight },
    };
  }), null, 1));
  flush();
  await browser.close().catch(() => undefined);
  say("DONE-B");
})().catch((error) => {
  console.log("DRIVER B FAILED:", String(error).slice(0, 600));
  process.exit(1);
});