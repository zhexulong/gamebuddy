// Driver I: follow-ups the earlier drivers can only flag.
//   (1) the Chats list's own width and the region beside it at both widths
//   (2) is the 2-line clamp a bare clip or does Chrome reserve a truncation ellipsis? measured as
//       the gap between the last visible glyph and the box's content edge (an ellipsis leaves
//       roughly one glyph of room; a bare clip none)
//   (3) the Game surface's 「游戏数据与诊断」 disclosure: open or closed, and are its large boxes
//       actually rendered?
const { connect, reporter, PAGE_HELPERS, activateSurface, shot } = require("./common.cjs");

const layoutProbe = () => {
  const surface = document.querySelector('[data-testid="chats-surface"]');
  const content = surface.querySelector(".surface-content");
  const list = surface.querySelector(".chat-list");
  const rows = [...surface.querySelectorAll('[data-testid="chat-item"]')];
  const box = (el) => {
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right), h: Math.round(r.height) };
  };
  return {
    viewportWidth: window.innerWidth,
    surface: box(surface),
    content: box(content),
    list: box(list),
    listColumns: list === null ? null : getComputedStyle(list).gridTemplateColumns,
    rowBoxes: rows.map((row) => box(row)),
    rightmostRowEdge: rows.length === 0 ? null : Math.max(...rows.map((row) => Math.round(row.getBoundingClientRect().right))),
    deadWidthAtTheRightOfTheSurface: content === null ? null : Math.round(content.getBoundingClientRect().right - (rows.length === 0 ? content.getBoundingClientRect().left : Math.max(...rows.map((row) => row.getBoundingClientRect().right)))),
  };
};

const ellipsisProbe = (injectedChars) => {
  const meta = document.querySelector('[data-testid="chat-item-meta"]');
  const preview = document.querySelector('[data-testid="chat-item-preview"]');
  if (meta === null || preview === null) return { present: false, reason: "no meta/preview element" };
  const original = preview.textContent;
  if (injectedChars > 0) {
    const sample = "晨风卷着松林和湿泥的草腥气拂过门廊,石阶背风处温着一壶粗茶。听见推门声,顺手拍了拍身旁的木台阶,把捂热的粗瓷茶杯递过去,说快过来坐这儿背风。";
    preview.textContent = sample.repeat(4).slice(0, injectedChars);
  }
  const textNode = preview.firstChild;
  const metaRect = meta.getBoundingClientRect();
  const metaStyle = getComputedStyle(meta);
  const padRight = parseFloat(metaStyle.paddingRight) || 0;
  const contentRight = metaRect.right - padRight;
  let lastVisible = null;
  let visibleChars = 0;
  let totalChars = 0;
  if (textNode !== null && textNode.nodeType === 3) {
    totalChars = (textNode.textContent ?? "").length;
    const range = document.createRange();
    for (let index = 0; index < totalChars; index += 1) {
      range.setStart(textNode, index);
      range.setEnd(textNode, index + 1);
      const r = range.getBoundingClientRect();
      if (r.height === 0 || r.bottom > metaRect.bottom + 0.5) continue;
      visibleChars += 1;
      lastVisible = { char: (textNode.textContent ?? "")[index], right: Math.round(r.right * 100) / 100, top: Math.round(r.top) };
    }
  }
  const ruler = document.createElement("span");
  ruler.textContent = "粗";
  ruler.style.cssText = `position:absolute;visibility:hidden;font:${metaStyle.font};letter-spacing:${metaStyle.letterSpacing};`;
  document.body.appendChild(ruler);
  const oneCharWidth = Math.round(ruler.getBoundingClientRect().width * 100) / 100;
  ruler.remove();
  const result = {
    present: true,
    injectedChars,
    metaClientWidth: meta.clientWidth,
    metaClientHeight: meta.clientHeight,
    metaContentRight: Math.round(contentRight * 100) / 100,
    metaScrollHeight: meta.scrollHeight,
    previewTextLength: totalChars,
    previewCharsInsideTheVisibleBox: visibleChars,
    lastVisibleChar: lastVisible,
    oneCharWidth,
    roomLeftAfterTheLastVisibleChar: lastVisible === null ? null : Math.round((contentRight - lastVisible.right) * 100) / 100,
    roomInCharacters: lastVisible === null ? null : Math.round(((contentRight - lastVisible.right) / oneCharWidth) * 100) / 100,
  };
  if (injectedChars > 0) preview.textContent = original;
  return result;
};

const diagnosticsProbe = () => {
  const details = document.querySelector("details.game-diagnostics");
  if (details === null) return { present: false, reason: "no details.game-diagnostics" };
  const summary = details.querySelector("summary");
  const pre = details.querySelector("pre.game-diagnostics-json");
  const code = details.querySelector("code");
  const box = (el) => {
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) };
  };
  const facts = (el) => (el === null ? null : {
    box: box(el),
    display: getComputedStyle(el).display,
    visibility: getComputedStyle(el).visibility,
    offsetParentIsNull: el.offsetParent === null,
    clientRects: el.getClientRects().length,
    textContentLength: (el.textContent ?? "").length,
    innerTextLength: (el.innerText ?? "").length,
  });
  return {
    present: true,
    detailsOpen: details.open,
    summary: facts(summary),
    pre: facts(pre),
    code: facts(code),
  };
};

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("i-followup.txt");
  await page.evaluate(`${PAGE_HELPERS};undefined`);

  for (const size of [{ w: 1440, h: 900, tag: "1440x900" }, { w: 400, h: 800, tag: "400x800" }]) {
    await page.setViewportSize({ width: size.w, height: size.h });
    await activateSurface(page, "会话");
    await page.waitForTimeout(1500);
    say(`=== (1) 会话 layout @${size.tag} ===`);
    say(JSON.stringify(await page.evaluate(layoutProbe), null, 1));
    say(`=== (2) the clamp's cut @${size.tag}, real preview ===`);
    say(JSON.stringify(await page.evaluate(ellipsisProbe, 0), null, 1));
    say(`=== (2) the clamp's cut @${size.tag}, forced 160-char preview ===`);
    say(JSON.stringify(await page.evaluate(ellipsisProbe, 160), null, 1));
    await shot(page, `53-chats-rows-${size.tag}.png`);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await activateSurface(page, "游戏");
  await page.waitForTimeout(1500);
  say("=== (3) 游戏 游戏数据与诊断: open or closed, and is it rendered? @1440x900 ===");
  say(JSON.stringify(await page.evaluate(diagnosticsProbe), null, 1));
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(1200);
  say("=== (3) the same @400x800 ===");
  say(JSON.stringify(await page.evaluate(diagnosticsProbe), null, 1));

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-I");
})().catch((error) => {
  console.log("DRIVER I FAILED:", String(error).slice(0, 900));
  process.exit(1);
});