// Driver H: resolves the three things the sweep could only flag as "suspicious", each to a computed
// fact:
//   (a) 聊天 @400x800: elements whose top is above the app bar — painted over it, or clipped?
//   (b) the Chats row clamp: which declaration wins, and how much of the preview is inside the box?
//   (c) the Game surface's large empty <pre>/<code> blocks — what are they, and are they rendered?
const { connect, reporter, PAGE_HELPERS, activateSurface, shot } = require("./common.cjs");

const barProbe = () => {
  const bar = document.querySelector(".app-bar");
  const barRect = bar.getBoundingClientRect();
  const points = [];
  for (const x of [10, 60, 120, 220, 320, 380]) {
    for (const y of [Math.round(barRect.height / 2)]) {
      const el = document.elementFromPoint(x, y);
      points.push({ x, y, hit: el === null ? null : `${el.tagName.toLowerCase()}` });
    }
  }
  const scroller = document.querySelector(".timeline");
  const surface = document.querySelector('[data-testid="chat-surface"]');
  const content = surface?.querySelector(".surface-content");
  const rows = [...(scroller?.querySelectorAll(":scope > ol.message-list > li.message") ?? [])];
  const scrollerRect = scroller === null ? null : (() => { const r = scroller.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), scrollTop: Math.round(scroller.scrollTop) }; })();
  const paintedOverTheBar = rows
    .map((row) => {
      const r = row.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    })
    .filter((row) => scrollerRect !== null && row.top < scrollerRect.top && row.bottom > scrollerRect.top);
  return {
    barRect: { top: Math.round(barRect.top), bottom: Math.round(barRect.bottom), h: Math.round(barRect.height) },
    elementFromPointInsideTheBar: points,
    scrollerRect,
    surfaceContentRect: content === null ? null : (() => { const r = content.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; })(),
    transcriptRowRects: rows.map((row) => { const r = row.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; }),
    rowsClippedByTheScrollerTop: paintedOverTheBar,
  };
};

const clampProbe = () => {
  const meta = document.querySelector('[data-testid="chat-item-meta"]');
  const preview = document.querySelector('[data-testid="chat-item-preview"]');
  const surface = document.querySelector('[data-testid="chats-surface"]');
  if (meta === null) return { present: false, reason: "no [data-testid=chat-item-meta]" };
  const probeDiv = document.createElement("div");
  probeDiv.style.display = "-webkit-box";
  document.body.appendChild(probeDiv);
  const webkitBoxComputesTo = getComputedStyle(probeDiv).display;
  probeDiv.style.display = "flow-root";
  const flowRootComputesTo = getComputedStyle(probeDiv).display;
  probeDiv.remove();
  const metaRect = meta.getBoundingClientRect();
  const style = getComputedStyle(meta);
  const text = preview?.firstChild ?? null;
  let visibleChars = 0;
  let totalChars = 0;
  let lastVisibleChar = null;
  if (text !== null && text.nodeType === 3) {
    totalChars = (text.textContent ?? "").length;
    const range = document.createRange();
    for (let index = 0; index < totalChars; index += 1) {
      range.setStart(text, index);
      range.setEnd(text, index + 1);
      const r = range.getBoundingClientRect();
      if (r.height === 0) { visibleChars += 1; continue; }
      if (r.bottom <= metaRect.bottom + 0.5) {
        visibleChars += 1;
        lastVisibleChar = (text.textContent ?? "")[index];
      }
    }
  }
  const previewRect = preview === null ? null : preview.getBoundingClientRect();
  return {
    present: true,
    meta: {
      display: style.display,
      webkitLineClamp: style.webkitLineClamp,
      lineClamp: style.lineClamp,
      overflowY: style.overflowY,
      textOverflow: style.textOverflow,
      height: Math.round(metaRect.height),
      bottom: Math.round(metaRect.bottom),
      clientHeight: meta.clientHeight,
      scrollHeight: meta.scrollHeight,
    },
    preview: previewRect === null ? null : {
      rect: { top: Math.round(previewRect.top), bottom: Math.round(previewRect.bottom), h: Math.round(previewRect.height) },
      display: getComputedStyle(preview).display,
      webkitLineClamp: getComputedStyle(preview).webkitLineClamp,
      extendsPastTheMetaBox: previewRect.bottom > metaRect.bottom + 0.5,
    },
    previewCharsTotal: totalChars,
    previewCharsInsideTheVisibleBox: visibleChars,
    lastVisibleChar,
    cssSupport: {
      webkitBoxComputesTo,
      flowRootComputesTo,
      supportsLineClamp: CSS.supports("line-clamp", "2"),
      supportsWebkitLineClamp: CSS.supports("-webkit-line-clamp", "2"),
    },
  };
};

const gameEmptyProbe = () => {
  const surface = document.querySelector('[data-testid="game-surface"]');
  const out = [];
  for (const el of surface.querySelectorAll("pre, code, .game-diagnostics, .game-diagnostics-json, textarea")) {
    const r = el.getBoundingClientRect();
    out.push({
      tag: el.tagName.toLowerCase(),
      w: Math.round(r.width),
      h: Math.round(r.height),
      textLength: (el.textContent ?? "").length,
      innerTextLength: (el.innerText ?? "").length,
      visible: r.width > 0 && r.height > 0,
      placeholder: el.getAttribute("placeholder"),
      ariaLabel: el.getAttribute("aria-label"),
      first80Chars: (el.textContent ?? "").slice(0, 80),
      sectionHeading: (() => {
        let node = el;
        while (node !== null && node !== surface) {
          const heading = node.querySelector?.("h3, h4, .game-group-title, summary");
          if (heading !== null && heading !== undefined) return (heading.textContent ?? "").trim().slice(0, 40);
          node = node.parentElement;
        }
        return null;
      })(),
    });
  }
  return { text: (surface.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 300), blocks: out };
};

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("h-probe.txt");
  await page.evaluate(`${PAGE_HELPERS};undefined`);

  say("=== (a) 聊天 @400x800: is anything actually painted over the app bar? ===");
  await page.setViewportSize({ width: 400, height: 800 });
  await activateSurface(page, "聊天");
  await page.waitForTimeout(1500);
  say(JSON.stringify(await page.evaluate(barProbe), null, 1));
  await shot(page, "50-chat-scroller-vs-appbar-400x800.png");

  say("=== (b) the Chats row clamp: which declaration wins, and what is inside the box ===");
  await page.setViewportSize({ width: 400, height: 800 });
  await activateSurface(page, "会话");
  await page.waitForTimeout(1500);
  say(JSON.stringify(await page.evaluate(clampProbe), null, 1));
  await shot(page, "51-chats-row-clamp-400x800.png");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(1200);
  say("--- the same probe at 1440x900");
  say(JSON.stringify(await page.evaluate(clampProbe), null, 1));
  const row = page.locator('[data-testid="chat-item"]').first();
  await row.screenshot({ path: `${process.env.GB_SHOTS_OUT}\\52-chats-row-closeup-1440x900.png`, animations: "disabled", timeout: 45000 }).catch(() => undefined);

  say("=== (c) the Game surface's large empty blocks ===");
  for (const size of [{ w: 1440, h: 900, tag: "1440x900" }, { w: 400, h: 800, tag: "400x800" }]) {
    await page.setViewportSize({ width: size.w, height: size.h });
    await activateSurface(page, "游戏");
    await page.waitForTimeout(1200);
    say(`--- Game @${size.tag}`);
    say(JSON.stringify(await page.evaluate(gameEmptyProbe), null, 1));
  }

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-H");
})().catch((error) => {
  console.log("DRIVER H FAILED:", String(error).slice(0, 900));
  process.exit(1);
});