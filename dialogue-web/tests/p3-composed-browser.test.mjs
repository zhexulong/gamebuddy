import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { chromium } from "@playwright/test";

const dialogueRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(dialogueRoot, "..");
const hostRoot = resolve(repositoryRoot, "host");
const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";

async function startShippedComposition() {
  const pointer = JSON.parse(await readFile(resolve(hostRoot, "dist", "current.json"), "utf8"));
  if (!pointer || typeof pointer.generation !== "string" || !/^g-[a-z0-9-]+$/.test(pointer.generation))
    throw new Error("p3_test_production_generation_unavailable");
  const artifactRoot = resolve(hostRoot, "dist", "generations", pointer.generation);
  const load = async (path) => await import(pathToFileURL(resolve(artifactRoot, path)).href);
  const [{ startP3StaticShellComposition }, { composeTavernProfile }, { createPublishedWindowsReparseInspector }] = await Promise.all([
    load("tavern/p3-static-shell-composition.js"),
    load("tavern/browser-contract/index.js"),
    load("windows-reparse-inspector/index.js"),
  ]);
  const profile = composeTavernProfile({
    profileId: "gamebuddy.chat-core.p3",
    releaseTier: "chat_core",
    routeIds: ["bootstrap", "state.read", "draft.read"],
    operationIds: [],
    navigationItemIds: ["chat"],
  });
  const p3Facade = Object.freeze({
    read: async () => Object.freeze({
      selection: Object.freeze({ chatHandle: handle, generation: 1, stateRevision: handle }),
      companionDisplayName: "Mira",
      title: "Exact Chat",
      transcript: Object.freeze([
        Object.freeze({ handle, role: "companion", text: "A durable opening.", locale: "und", order: 0, revision: 1 }),
      ]),
      draft: Object.freeze({ revision: 4, text: "Saved locally by Host." }),
    }),
  });
  const inspector = await createPublishedWindowsReparseInspector(artifactRoot);
  return await startP3StaticShellComposition({
    artifactRoot: resolve(artifactRoot, "browser", "tavern", "v1"),
    inspector,
    p3Facade,
    profile,
    bootstrapToken: token,
  });
}

test("shipped P3 browser artifact reads a same-origin composed API without route mocks", async () => {
  const server = await startShippedComposition();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    const apiOrigins = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/tavern/v1/")) apiOrigins.push(new URL(request.url()).origin);
    });

    await page.goto(server.launchUrl, { waitUntil: "networkidle" });

    // 1. Initial live render verification
    await assert.doesNotReject(() => page.getByRole("heading", { name: "Exact Chat" }).waitFor());
    await assert.doesNotReject(() => page.getByText("A durable opening.").waitFor());
    await assert.doesNotReject(() => page.getByRole("region", { name: /Saved draft|已保存草稿/ }).getByText("Saved locally by Host.").waitFor());
    await assert.doesNotReject(() => page.getByText("Read-only chat").waitFor());

    // 2. Interactive live verification: open settings drawer
    await page.getByRole("button", { name: "Settings" }).click();
    await assert.doesNotReject(() => page.getByRole("dialog", { name: "Settings" }).waitFor());

    // 3. Live bilingual switching: switch to Simplified Chinese
    await page.locator("#language-select").selectOption("zh-CN");
    await assert.doesNotReject(() => page.getByRole("dialog", { name: "设置" }).waitFor());
    await assert.doesNotReject(() => page.getByText("只读会话").waitFor());

    // 4. Verify authored content remains exact byte-for-byte in live environment
    await assert.doesNotReject(() => page.getByRole("heading", { name: "Exact Chat" }).waitFor());
    await assert.doesNotReject(() => page.getByText("A durable opening.").waitFor());
    await assert.doesNotReject(() => page.getByText("Saved locally by Host.").waitFor());

    // 5. Close settings drawer via Escape
    await page.keyboard.press("Escape");
    await assert.doesNotReject(() => page.getByRole("dialog").waitFor({ state: "hidden" }));

    // 6. Security and protocol assertions
    assert.deepEqual([...new Set(apiOrigins)], [server.origin]);
    assert.equal(new URL(page.url()).hash, "");
  } finally {
    await browser.close();
    await server.close();
  }
});
