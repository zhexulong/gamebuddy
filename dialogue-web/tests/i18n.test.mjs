import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDocumentLocale,
  messages,
  persistLocale,
  resolveLocale,
} from "../src/i18n.ts";

test("resolveLocale prioritizes stored valid preference", () => {
  const storageEn = { getItem: (key) => (key === "gamebuddy.tavern.ui-locale" ? "en" : null) };
  const storageZh = { getItem: (key) => (key === "gamebuddy.tavern.ui-locale" ? "zh-CN" : null) };
  const navZh = { languages: ["zh-CN", "en"], language: "zh-CN" };

  assert.equal(resolveLocale(storageEn, navZh), "en");
  assert.equal(resolveLocale(storageZh, { languages: ["en-US"], language: "en-US" }), "zh-CN");
});

test("resolveLocale ignores invalid stored preference and falls back to navigator", () => {
  const invalidStorage = { getItem: () => "fr-FR" };
  const navZh = { languages: ["zh-Hans", "en"], language: "zh-Hans" };
  const navEn = { languages: ["en-US", "en"], language: "en-US" };

  assert.equal(resolveLocale(invalidStorage, navZh), "zh-CN");
  assert.equal(resolveLocale(invalidStorage, navEn), "en");
});

test("resolveLocale maps zh, zh-Hans, zh-CN to zh-CN, and others to en", () => {
  assert.equal(resolveLocale(null, { languages: ["zh"], language: "zh" }), "zh-CN");
  assert.equal(resolveLocale(null, { languages: ["zh-Hans-CN"], language: "zh-Hans-CN" }), "zh-CN");
  assert.equal(resolveLocale(null, { languages: ["ja-JP", "en-US"], language: "ja-JP" }), "en");
  assert.equal(resolveLocale(null, { languages: [], language: "" }), "en");
  assert.equal(resolveLocale(null, null), "en");
});

test("applyDocumentLocale sets documentElement.lang without storing", () => {
  const fakeDoc = { documentElement: { lang: "" } };
  applyDocumentLocale("zh-CN", fakeDoc);
  assert.equal(fakeDoc.documentElement.lang, "zh-CN");

  applyDocumentLocale("en", fakeDoc);
  assert.equal(fakeDoc.documentElement.lang, "en");
});

test("persistLocale writes exact storage key", () => {
  const items = {};
  const fakeStorage = { setItem: (key, val) => { items[key] = val; } };
  persistLocale("zh-CN", fakeStorage);
  assert.equal(items["gamebuddy.tavern.ui-locale"], "zh-CN");

  persistLocale("en", fakeStorage);
  assert.equal(items["gamebuddy.tavern.ui-locale"], "en");
});

test("messages returns complete dictionary with identical keys for en and zh-CN", () => {
  const enMessages = messages("en");
  const zhMessages = messages("zh-CN");

  const enKeys = Object.keys(enMessages).sort();
  const zhKeys = Object.keys(zhMessages).sort();

  assert.deepEqual(enKeys, zhKeys);
  for (const key of enKeys) {
    assert.ok(typeof enMessages[key] === "string" && enMessages[key].length > 0, `en.${key} is empty`);
    assert.ok(typeof zhMessages[key] === "string" && zhMessages[key].length > 0, `zh.${key} is empty`);
  }
});
