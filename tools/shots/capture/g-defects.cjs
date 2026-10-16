// Driver G: the "what looks wrong" sweep. Pixels cannot be read back by the observer, so every
// claim is a computed fact: clipped/truncated text, elements crossing the viewport edge or the app
// bar, controls under the 44 px touch floor, the lowest text contrasts, and blocks that are large
// but carry almost no text. Runs for six surfaces at both widths.
const { connect, reporter, PAGE_HELPERS, activateSurface, shot } = require("./common.cjs");

const SURFACES = [
  { key: "chat", label: "聊天", testid: "chat-surface" },
  { key: "game", label: "游戏", testid: "game-surface" },
  { key: "chats", label: "会话", testid: "chats-surface" },
  { key: "characters", label: "角色", testid: "characters-surface" },
  { key: "settings", label: "设置", testid: "settings-surface" },
  { key: "memory", label: "记忆", testid: "memory-surface" },
];

const sweep = (testid) => {
  const surface = document.querySelector(`section[data-testid="${testid}"]`);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };
  const inside = [...surface.querySelectorAll("*")].filter((el) => el instanceof HTMLElement && visible(el));

  const clipped = inside.filter((el) => {
    const text = (el.innerText ?? "").trim();
    if (text.length === 0) return false;
    const style = getComputedStyle(el);
    const hidden = style.overflowX === "hidden" || style.overflowX === "clip";
    return hidden && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0;
  }).slice(0, 12).map((el) => ({
    tag: el.tagName.toLowerCase(),
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
    text: (el.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
  }));

  const verticalClip = inside.filter((el) => {
    const text = (el.innerText ?? "").trim();
    const style = getComputedStyle(el);
    return text.length > 0 && (style.overflowY === "hidden" || style.webkitLineClamp !== "none") && el.scrollHeight > el.clientHeight + 1;
  }).slice(0, 8).map((el) => ({
    tag: el.tagName.toLowerCase(),
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    lineClamp: getComputedStyle(el).webkitLineClamp,
    text: (el.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
  }));

  const offscreen = inside.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.right > window.innerWidth + 1 || r.left < -1;
  }).slice(0, 10).map((el) => ({
    tag: el.tagName.toLowerCase(),
    left: Math.round(el.getBoundingClientRect().left),
    right: Math.round(el.getBoundingClientRect().right),
    text: (el.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
  }));

  const barHeight = document.querySelector(".app-bar")?.getBoundingClientRect().height ?? 0;
  const underTheBar = inside.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.top < barHeight - 2 && r.height > 0 && r.width > 0;
  }).slice(0, 8).map((el) => ({ tag: el.tagName.toLowerCase(), top: Math.round(el.getBoundingClientRect().top) }));

  const smallTargets = [...surface.querySelectorAll("button, select, input, textarea, a[href]")].filter((el) => visible(el)).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width < 44 || r.height < 44;
  }).slice(0, 14).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      name: (el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 24),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });

  const textRuns = inside.filter((el) => {
    const own = [...el.childNodes].some((node) => node.nodeType === 3 && (node.textContent ?? "").trim().length > 1);
    return own && visible(el);
  });
  const contrasts = textRuns.map((el) => {
    const style = getComputedStyle(el);
    const foreground = window.__shots.parseColor(style.color);
    const background = window.__shots.parseColor(window.__shots.effectiveBackground(el));
    if (foreground === null || background === null) return null;
    const area = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      color: style.color,
      background: window.__shots.effectiveBackground(el),
      contrast: window.__shots.contrast(foreground, background),
      areaPx: Math.round(area.width * area.height),
      text: (el.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
    };
  }).filter((entry) => entry !== null && entry.areaPx > 200)
    .sort((left, right) => left.contrast - right.contrast)
    .slice(0, 6);

  const emptyBlocks = inside.filter((el) => {
    const r = el.getBoundingClientRect();
    const text = (el.innerText ?? "").replace(/\s+/g, " ").trim();
    return r.width * r.height > 40000 && text.length <= 24 && el.children.length <= 2;
  }).slice(0, 8).map((el) => {
    const r = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height), text: (el.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 24) };
  });

  return {
    testid,
    surfaceText: (surface.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
    surfaceTextLength: (surface.innerText ?? "").replace(/\s+/g, " ").trim().length,
    elementCount: inside.length,
    clipped,
    verticalClip,
    offscreen,
    underTheBar,
    smallTargets,
    lowestContrasts: contrasts,
    emptyBlocks,
  };
};

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("g-defects.txt");
  await page.evaluate(`${PAGE_HELPERS};undefined`);

  for (const size of [{ w: 1440, h: 900, tag: "1440x900" }, { w: 400, h: 800, tag: "400x800" }]) {
    await page.setViewportSize({ width: size.w, height: size.h });
    await page.waitForTimeout(900);
    for (const surface of SURFACES) {
      await activateSurface(page, surface.label);
      await page.waitForTimeout(900);
      say(`===== DEFECT SWEEP ${surface.key} ${surface.testid} @ ${size.tag} =====`);
      say(JSON.stringify(await page.evaluate(sweep, surface.testid)));
      await shot(page, `99-${surface.key}-${size.tag}.png`);
    }
  }

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-G");
})().catch((error) => {
  console.log("DRIVER G FAILED:", String(error).slice(0, 700));
  process.exit(1);
});