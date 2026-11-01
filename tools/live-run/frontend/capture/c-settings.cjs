// Driver C: Settings at 1440x900 and 400x800 — every control's width, whether the visible controls
// share one measure, and the raw OS controls (native <select>) that don't.
const { connect, reporter, PAGE_HELPERS, activateSurface } = require("./common.cjs");

const measure = () => {
  const surface = document.querySelector('[data-testid="settings-surface"]');
  const content = surface.querySelector(".surface-content");
  const describe = (labelElement) => {
    if (labelElement === null) return null;
    const text = (labelElement.innerText || labelElement.textContent || "").replace(/\s+/g, " ").trim();
    return text.length > 40 ? `${text.slice(0, 40)}...` : text;
  };
  const controls = [...surface.querySelectorAll("input, select, textarea")].map((control) => {
    const r = control.getBoundingClientRect();
    const id = control.getAttribute("id");
    const explicit = id === null ? null : surface.querySelector(`label[for="${id}"]`);
    const wrapper = control.closest("label") ?? explicit;
    return {
      tag: control.tagName.toLowerCase(),
      type: control.getAttribute("type") ?? null,
      testid: control.getAttribute("data-testid") ?? null,
      name: control.getAttribute("name") ?? null,
      ariaLabel: control.getAttribute("aria-label") ?? null,
      label: describe(wrapper),
      x: Math.round(r.x),
      width: Math.round(r.width),
      height: Math.round(r.height),
      visible: r.width > 0 && r.height > 0,
      appearance: getComputedStyle(control).appearance,
    };
  });
  const containers = [".connection-form", "[data-connection-list]", ".voice-device-selector", ".model-profile-editor"]
    .flatMap((selector) => [...surface.querySelectorAll(selector)].map((container) => {
      const r = container.getBoundingClientRect();
      return { selector, x: Math.round(r.x), width: Math.round(r.width), height: Math.round(r.height) };
    }));
  const visibleControls = controls.filter((control) => control.visible);
  const widths = [...new Set(visibleControls.map((control) => control.width))].sort((left, right) => left - right);
  return {
    surfaceWidth: Math.round(surface.getBoundingClientRect().width),
    scroller: { scrollHeight: content.scrollHeight, clientHeight: content.clientHeight },
    controlCount: controls.length,
    visibleControlCount: visibleControls.length,
    distinctVisibleWidths: widths,
    containers,
    controls,
    rawOsControls: visibleControls.filter((control) => control.appearance === "auto" || control.appearance === "menulist").map((control) => ({ tag: control.tag, testid: control.testid, appearance: control.appearance, width: control.width })),
    docHorizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
  };
};

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("c-settings.txt");
  await page.evaluate(`${PAGE_HELPERS};undefined`);

  for (const size of [{ w: 1440, h: 900, tag: "1440x900" }, { w: 400, h: 800, tag: "400x800" }]) {
    await page.setViewportSize({ width: size.w, height: size.h });
    await page.waitForTimeout(800);
    await activateSurface(page, "设置");
    await page.waitForTimeout(1200);
    say(`=== ITEM: Settings @${size.tag} ===`);
    say(JSON.stringify(await page.evaluate(measure), null, 1));
    await page.screenshot({ path: `${process.env.GB_SHOTS_OUT}\\90-settings-${size.tag}.png`, animations: "disabled", caret: "initial", timeout: 45000 }).catch(() => undefined);
  }

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-C");
})().catch((error) => {
  console.log("DRIVER C FAILED:", String(error).slice(0, 600));
  process.exit(1);
});