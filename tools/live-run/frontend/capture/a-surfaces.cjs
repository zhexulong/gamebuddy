// Driver A: six peer surfaces at 1440x900 and 400x800 — AppBar labels, frame fill, overlays
// (must be 0), document horizontal overflow (must be 0), the product's own name in the bar, and
// each surface heading's computed outline right after a route change.
const path = require("node:path");
const { connect, reporter, SHOTS, PAGE_HELPERS, shot } = require("./common.cjs");

const SURFACES = [
  { key: "chat", label: "聊天", testid: "chat-surface" },
  { key: "game", label: "游戏", testid: "game-surface" },
  { key: "chats", label: "会话", testid: "chats-surface" },
  { key: "characters", label: "角色", testid: "characters-surface" },
  { key: "settings", label: "设置", testid: "settings-surface" },
  { key: "memory", label: "记忆", testid: "memory-surface" },
];

const measure = (testid) => {
  const region = document.querySelector(`section[data-testid="${testid}"]`);
  if (region === null) return { present: false };
  const frame = region.parentElement;
  const header = region.querySelector(".surface-header");
  const h2 = region.querySelector(".surface-header h2");
  const content = region.querySelector(".surface-content");
  const style = h2 === null ? null : getComputedStyle(h2);
  const headerStyle = header === null ? null : getComputedStyle(header);
  const headerBox = header === null ? null : window.__shots.rect(header);
  const headingBox = h2 === null ? null : window.__shots.rect(h2);
  const labelledBy = region.getAttribute("aria-labelledby");
  const labelNode = labelledBy === null ? null : document.getElementById(labelledBy);
  return {
    present: true,
    headingText: h2 === null ? null : h2.textContent,
    // Owner's ruling 4: at the narrow breakpoint the surface's own heading must no longer be DRAWN,
    // while the region keeps its accessible name. "Drawn" is the sheet's own recipe read back:
    // the header leaves the visual flow (position absolute) and its box is clipped away
    // (clip-path inset(50%)) - the two computed declarations a screenshot can only guess at.
    heading: {
      box: headingBox,
      headerBox,
      headerPosition: headerStyle === null ? null : headerStyle.position,
      headerClipPath: headerStyle === null ? null : headerStyle.clipPath,
      headerDisplay: headerStyle === null ? null : headerStyle.display,
      painted: headerBox !== null && headerBox.w > 0 && headerBox.h > 0 && (headerStyle?.clipPath ?? "none") === "none",
      inTheVisualFlow: headerStyle === null ? null : headerStyle.position !== "absolute",
      offsetParentIsNotNull: h2 === null ? null : h2.offsetParent !== null,
      clientRects: h2 === null ? null : h2.getClientRects().length,
      tabIndex: h2 === null ? null : h2.tabIndex,
    },
    regionAccessibleName: labelNode === null ? null : (labelNode.textContent ?? null),
    contentTop: content === null ? null : window.__shots.rect(content).y,
    region: window.__shots.rect(region),
    frame: window.__shots.rect(frame),
    content: content === null ? null : {
      rect: window.__shots.rect(content),
      scrollHeight: content.scrollHeight,
      clientHeight: content.clientHeight,
      overflowY: getComputedStyle(content).overflowY,
      horizontalOverflow: content.scrollWidth - content.clientWidth,
    },
    overlays: window.__shots.overlays(),
    surfaceRegions: window.__shots.surfaceRegions(),
    headingOutline: style === null ? null : {
      outline: style.outline,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      boxShadow: style.boxShadow,
      focused: document.activeElement === h2,
      activeElement: document.activeElement === null ? null : `${document.activeElement.tagName}#${document.activeElement.id}`,
    },
    viewportBottomGap: window.innerHeight - window.__shots.rect(region).bottom,
    docHorizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
  };
};

async function barFacts(page) {
  return await page.evaluate(() => {
    const bar = document.querySelector(".app-bar");
    const buttons = [...document.querySelectorAll(".app-bar-actions .nav-button")];
    const visible = buttons.filter((button) => {
      const r = button.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return {
      brandName: document.querySelector(".app-bar-brand-name")?.textContent ?? null,
      brandNameDisplay: document.querySelector(".app-bar-brand-name") === null
        ? null
        : getComputedStyle(document.querySelector(".app-bar-brand-name")).display,
      brandMark: document.querySelector(".app-bar-brand-mark")?.textContent ?? null,
      title: document.querySelector(".app-bar-title")?.textContent ?? null,
      status: document.querySelector(".app-bar-status-label")?.textContent ?? null,
      documentTitle: document.title,
      bar: bar === null ? null : window.__shots.rect(bar),
      navVisibleLabels: visible.map((button) => button.getAttribute("aria-label")),
      navVisibleCount: visible.length,
      moreTriggerVisible: (() => {
        const trigger = document.querySelector(".app-bar-more-trigger");
        if (trigger === null) return false;
        const r = trigger.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })(),
      moreTriggerLabel: document.querySelector(".app-bar-more-trigger")?.getAttribute("aria-label") ?? null,
      navAllLabels: buttons.map((button) => button.getAttribute("aria-label")),
      bodyTextHasTavern: /酒馆|Tavern/.test(document.body.innerText),
      tavernMatches: (document.body.innerText.match(/酒馆|Tavern/g) ?? []).slice(0, 8),
    };
  });
}

// A fixed 900 ms wait measured whatever the frame happened to hold at that instant. That is how
// shots-final60 recorded the settings surface at scrollHeight 844 while shots-final61 recorded 2423
// for the same viewport and the same container geometry: one of the two read a skeleton whose inner
// forms had not mounted yet. Waiting for a duration cannot distinguish "settled" from "not started".
//
// This waits for a fact instead. It returns how the wait ended, and the caller writes that verdict
// beside the numbers, so a reading taken from an unsettled frame can no longer look like a reading
// taken from a settled one. Swallowing a timeout would put the defect straight back.
async function waitForSurfaceSettled(page, testid) {
  const deadline = Date.now() + 8000;
  let last = null;
  let previous = null;
  while (Date.now() < deadline) {
    const sample = await page.evaluate((id) => {
      const region = document.querySelector(`section[data-testid="${id}"]`);
      if (region === null) return { mounted: false, height: null, elements: 0 };
      const content = region.querySelector(".surface-content");
      if (content === null) return { mounted: true, height: null, elements: 0 };
      return {
        mounted: true,
        height: content.scrollHeight,
        elements: content.querySelectorAll("*").length,
      };
    }, testid);
    // Three consecutive identical samples, not two: a form that mounts in two waves (container, then
    // its fields) can be momentarily stable between the waves, and two samples would accept it.
    const settled =
      sample.mounted &&
      sample.height !== null &&
      sample.height > 0 &&
      sample.elements > 0 &&
      last !== null &&
      last.height === sample.height &&
      last.elements === sample.elements &&
      previous !== null &&
      previous.height === sample.height &&
      previous.elements === sample.elements;
    if (settled) return { settled: true, height: sample.height, elements: sample.elements };
    previous = last;
    last = sample;
    await page.waitForTimeout(100);
  }
  return {
    settled: false,
    height: last === null ? null : last.height,
    elements: last === null ? null : last.elements,
    mounted: last !== null && last.mounted,
  };
}

async function activate(page, label) {
  const trigger = page.locator(".app-bar-more-trigger");
  if ((await trigger.count()) > 0 && (await trigger.isVisible())) {
    await trigger.click();
    const folded = page.locator(`.app-bar-more-menu .nav-button[aria-label="${label}"]`);
    if ((await folded.count()) > 0 && (await folded.isVisible())) {
      await folded.click();
      return "folded-menu";
    }
    await page.keyboard.press("Escape");
  }
  const direct = page.locator(`.app-bar-actions .nav-button[aria-label="${label}"]`);
  if ((await direct.count()) > 0) {
    await direct.first().click();
    return "app-bar";
  }
  throw new Error(`nav_entry_not_found:${label}`);
}

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("a-surfaces.txt");
  await page.evaluate(`${PAGE_HELPERS};undefined`);

  for (const size of [{ w: 1440, h: 900, tag: "1440x900" }, { w: 400, h: 800, tag: "400x800" }]) {
    await page.setViewportSize({ width: size.w, height: size.h });
    await page.waitForTimeout(1200);
    say(`===== VIEWPORT ${size.tag} =====`);
    say("bar:", JSON.stringify(await barFacts(page)));
    if (size.w === 400) {
      await shot(page, "01-appbar-400x800.png");
      const trigger = page.locator(".app-bar-more-trigger");
      if ((await trigger.count()) > 0 && (await trigger.isVisible())) {
        await trigger.click();
        await page.waitForTimeout(400);
        say("folded menu labels:", JSON.stringify(await page.evaluate(() => [...document.querySelectorAll(".app-bar-more-menu .nav-button .nav-label")].map((el) => el.textContent))));
        await shot(page, "01-appbar-folded-open-400x800.png");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }
    } else {
      await shot(page, "01-appbar-1440x900.png");
    }
    for (const surface of SURFACES) {
      const how = await activate(page, surface.label);
      const wait = await waitForSurfaceSettled(page, surface.testid);
      const facts = await page.evaluate(measure, surface.testid);
      say(`--- ${surface.label} (${surface.testid}) @ ${size.tag} via ${how}`);
      say(`settled=${wait.settled} elements=${wait.elements} heightAtRest=${wait.height}`);
      say(JSON.stringify(facts));
      say(
        `${surface.label} @ ${size.tag}: surfaceHeader position=${facts.heading?.headerPosition} clipPath=${facts.heading?.headerClipPath} box=${JSON.stringify(facts.heading?.headerBox)} headingBox=${JSON.stringify(facts.heading?.box)} headingPainted=${facts.heading?.painted} headingInTheVisualFlow=${facts.heading?.inTheVisualFlow} headingClientRects=${facts.heading?.clientRects} regionAccessibleName=${JSON.stringify(facts.regionAccessibleName)} contentTop=${facts.contentTop}`,
      );
      await shot(page, `10-${surface.key}-${size.tag}.png`);
    }
  }

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-A");
})().catch((error) => {
  console.log("DRIVER A FAILED:", String(error).slice(0, 600));
  process.exit(1);
});