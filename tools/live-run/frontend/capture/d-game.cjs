// Driver D: the Game surface at 1440x900 and 400x800 — the drawer's column count and the scroller's
// scrollHeight/clientHeight, plus the groups' left-edge count.
const { connect, reporter, PAGE_HELPERS, activateSurface } = require("./common.cjs");

const measure = () => {
  const surface = document.querySelector('[data-testid="game-surface"]');
  const content = surface.querySelector(".surface-content");
  const drawer = surface.querySelector(".composed-game-drawer");
  const groups = [...surface.querySelectorAll(".game-group")].map((group) => {
    const r = group.getBoundingClientRect();
    return {
      title: String((group.querySelector(".game-group-title")?.textContent ?? "").trim()),
      x: Math.round(r.x),
      width: Math.round(r.width),
      y: Math.round(r.y),
      height: Math.round(r.height),
    };
  });
  const distinctLeftEdges = [...new Set(groups.map((group) => group.x))].sort((left, right) => left - right);
  return {
    drawerPresent: drawer !== null,
    gridTemplateColumns: drawer === null ? null : getComputedStyle(drawer).gridTemplateColumns,
    columnCount: drawer === null ? null : getComputedStyle(drawer).gridTemplateColumns.split(" ").filter((part) => part.length > 0).length,
    gridGap: drawer === null ? null : `${getComputedStyle(drawer).rowGap} / ${getComputedStyle(drawer).columnGap}`,
    drawerRect: drawer === null ? null : window.__shots.rect(drawer),
    contentWidth: Math.round(content.getBoundingClientRect().width),
    scrollHeight: content.scrollHeight,
    clientHeight: content.clientHeight,
    horizontalOverflow: content.scrollWidth - content.clientWidth,
    groups,
    distinctLeftEdges,
  };
};

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("d-game.txt");
  await page.evaluate(`${PAGE_HELPERS};undefined`);

  for (const size of [{ w: 1440, h: 900, tag: "1440x900" }, { w: 400, h: 800, tag: "400x800" }]) {
    await page.setViewportSize({ width: size.w, height: size.h });
    await page.waitForTimeout(800);
    await activateSurface(page, "游戏");
    await page.waitForTimeout(1200);
    say(`=== ITEM: Game @${size.tag} ===`);
    say(JSON.stringify(await page.evaluate(measure), null, 1));
    await page.screenshot({ path: `${process.env.GB_SHOTS_OUT}\\20-game-${size.tag}.png`, animations: "disabled", caret: "initial", timeout: 45000 }).catch(() => undefined);
    await page.screenshot({ path: `${process.env.GB_SHOTS_OUT}\\21-game-${size.tag}-full.png`, animations: "disabled", caret: "initial", timeout: 45000 }).catch(() => undefined);
  }

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-D");
})().catch((error) => {
  console.log("DRIVER D FAILED:", String(error).slice(0, 600));
  process.exit(1);
});