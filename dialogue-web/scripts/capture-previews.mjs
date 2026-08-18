import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const artifactDir =
  "C:/Users/27251/.gemini/antigravity-cli/brain/aba4f88f-3dac-4775-b9e8-cfe40cb5db13";

async function capture() {
  await mkdir(artifactDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  // Helper to capture a state
  const capturePanel = async (panelName, filename) => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      locale: "zh-CN",
    });
    // set zh-CN in localStorage
    await page.addInitScript(() => {
      localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN");
    });
    const url =
      panelName === "none"
        ? "http://127.0.0.1:5173/#boot=dev-demo-token"
        : `http://127.0.0.1:5173/?panel=${panelName}#boot=dev-demo-token`;
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    await page.screenshot({
      path: resolve(artifactDir, filename),
      fullPage: false,
    });
    console.log(`Captured: ${filename}`);
    await page.close();
  };

  // 1. Desktop Main View with Timeline and Composer
  await capturePanel("none", "preview_desktop_main.png");

  // 2. Chats Drawer
  await capturePanel("chats", "preview_drawer_chats.png");

  // 3. Characters Drawer
  await capturePanel("characters", "preview_drawer_characters.png");

  // 4. World Info Drawer
  await capturePanel("worldInfo", "preview_drawer_worldinfo.png");

  // 5. Persona Drawer
  await capturePanel("persona", "preview_drawer_persona.png");

  // 6. Memory Drawer
  await capturePanel("memory", "preview_drawer_memory.png");

  // 7. Settings Drawer
  await capturePanel("settings", "preview_drawer_settings.png");

  await browser.close();
  console.log("All previews captured successfully from live server!");
}

capture().catch((err) => {
  console.error(err);
  process.exit(1);
});
