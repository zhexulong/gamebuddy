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

test("the zero-message anchor keeps its companion placeholder in both locales", () => {
  // The component substitutes `{{name}}` itself, so a translation that dropped
  // the placeholder would render a line about nobody while looking translated.
  for (const locale of ["en", "zh-CN"]) {
    assert.ok(
      messages(locale).emptyChatOpening.includes("{{name}}"),
      `${locale}.emptyChatOpening lost its {{name}} placeholder`,
    );
  }
});

/**
 * The rewind's confirmation, in the owner's words (audit 2026-10-19).
 *
 * The defect: the confirm read 「删除 / 保留」 for an action that removes this message AND every
 * message after it, which named neither the point the conversation is cut back to nor the difference
 * between it and the single-message delete beside it. The ruling is exact wording, so it is pinned
 * exactly in the catalogue the players read it in; the English catalogue is held to the same force -
 * the prompt names the point and the removal, and the two answers are the rewind and the way out -
 * rather than to a translation of the Chinese sentence.
 */
test("the rewind's confirmation says what it removes, in both catalogues", () => {
  const zh = messages("zh-CN");
  assert.equal(zh.rewindConfirmPrompt, "回退到此之前（删除本条及之后）");
  assert.equal(zh.rewindConfirmYes, "确认回退");
  assert.equal(zh.rewindConfirmNo, "取消");

  const en = messages("en");
  assert.equal(en.rewindConfirmPrompt, "Rewind to before this (deletes this message and everything after it)");
  assert.equal(en.rewindConfirmYes, "Confirm rewind");
  assert.equal(en.rewindConfirmNo, "Cancel");

  for (const locale of ["en", "zh-CN"]) {
    const labels = messages(locale);
    // The control's own name already states the removal and the count it would make; the confirm may
    // not be a second, vaguer sentence about the same press.
    assert.match(labels.rewindHereName, /removes this message and everything after it|删除这条消息及其之后的全部内容/u);
    assert.match(labels.rewindHereName, /\{\{count\}\}/u);
    assert.notEqual(labels.rewindConfirmYes, labels.rewindConfirmNo);
  }
});
