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
 * The rewind's confirmation, in the owner's words.
 *
 * The premise changed with the owner's ruling of 2026-10-20 (a rewind KEEPS the message it names and
 * drops what follows, the way Pi and SillyTavern both do), and the force is kept exactly: the point the
 * conversation is cut back to, the fact that this row SURVIVES, and the removal after it are named in
 * the catalogue the players read it in; the English catalogue is held to the same force - the prompt
 * names the point, what it keeps and what it removes, and the two answers are the rewind and the way
 * out - rather than to a translation of the Chinese sentence.
 */
test("the rewind's confirmation says what it keeps and what it removes, in both catalogues", () => {
  const zh = messages("zh-CN");
  assert.equal(zh.rewindHere, "回退到此处");
  assert.equal(zh.rewindConfirmPrompt, "确认回退到此处（保留本条，删除其后全部消息）");
  assert.equal(zh.rewindConfirmYes, "回退到此处");
  assert.equal(zh.rewindConfirmNo, "取消");

  const en = messages("en");
  assert.equal(en.rewindHere, "Rewind to here");
  assert.equal(en.rewindConfirmPrompt, "Confirm rewind to here (keeps this message, deletes everything after it)");
  assert.equal(en.rewindConfirmYes, "Rewind to here");
  assert.equal(en.rewindConfirmNo, "Cancel");

  for (const locale of ["en", "zh-CN"]) {
    const labels = messages(locale);
    // The control's own name already states what the cut keeps and what it removes, and the count it
    // would make; the confirm may not be a second, vaguer sentence about the same press.
    assert.match(
      labels.rewindHereName,
      /keeps this message and removes everything after it|保留这条消息，删除其后的全部内容/u,
    );
    assert.match(labels.rewindHereName, /\{\{count\}\}/u);
    assert.notEqual(labels.rewindConfirmYes, labels.rewindConfirmNo);
  }
});

/**
 * One confirmation vocabulary: `[verb] / 取消`.
 *
 * The owner's ruling (2026-10-20) is that the affirmative names what the press DOES, and the way
 * out is always the same word - so a row's two answers never become a pair of state names the
 * player has to decode. The verb stays specific (`Delete`, `Move to trash`, `Rewind to here`) and
 * may not collapse into the negative's word either, which is why both halves are pinned.
 */
test("every destructive confirmation answers with [verb] / 取消 in both catalogues", () => {
  const pairs = [
    ["rewindConfirmYes", "rewindConfirmNo"],
    ["deleteConfirmYes", "deleteConfirmNo"],
    ["chatRetentionArchiveConfirmYes", "chatRetentionConfirmNo"],
    ["chatRetentionTrashConfirmYes", "chatRetentionConfirmNo"],
  ];
  for (const locale of ["en", "zh-CN"]) {
    const labels = messages(locale);
    const out = locale === "en" ? "Cancel" : "取消";
    for (const [yes, no] of pairs) {
      assert.equal(labels[no], out, `${locale}.${no} is not the one way out`);
      assert.notEqual(labels[yes], labels[no], `${locale}.${yes} collapsed into the negative's word`);
    }
  }
});
