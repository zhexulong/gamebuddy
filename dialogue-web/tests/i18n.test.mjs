import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDocumentLocale,
  messages,
  persistLocale,
  resolveLocale,
} from "../src/i18n.ts";
import { turnFailureText } from "../src/components/turn-failure-text.ts";

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

/**
 * The first hour's two lies about a connection (OOBE review 1.2 and 2.1).
 *
 * 1.2: the settings banner told a player with no connection that "the assistant keeps using the
 * built-in default connection" - *keep going, something already works*. Nothing works: the
 * catalogue's default is the operator environment entry, whose credential is the ambient
 * `CPA_OAI_API_KEY` and whose endpoint is a loopback port nothing in a shipped install listens on
 * (`host/src/tavern/provider-catalog.ts`), so the sentence promised a first message that could only
 * fail. The premise changed; the force did not: the banner still says which state the player is in
 * and what to do about it, and it now says it about the state that is actually true - there is no
 * default a normal install can use, and configuring one is the way forward. The provider itself is
 * untouched: this repository's own runs reach it through the model profile.
 *
 * 2.1: a wrong, revoked or unserved credential reached the chat surface as
 * "回复运行时暂不可用，请稍后再试。" - the product blaming itself and inviting a retry that fails
 * identically. The English catalogue had already moved to the honest sentence; the Chinese one had
 * drifted back to the generic line. The force pinned here is what a player needs from a credential
 * refusal: name the credential and the model, point at Settings, and say a retry changes nothing.
 */
test("the no-connection banner sends the player to configure a connection, in both catalogues", () => {
  const en = messages("en").connectionNoSelectionNotice;
  const zh = messages("zh-CN").connectionNoSelectionNotice;

  // What is true, and what the old sentence denied: a normal install has no default to fall back on.
  assert.match(en, /a normal install has none/u);
  assert.match(zh, /普通安装没有它/u);
  // What to do, and where - in the form's own words (渠道 in Chinese, Provider in English).
  assert.match(en, /configure a connection here/u);
  assert.match(zh, /请在这里配置一条连接/u);
  assert.match(en, /save and enable/u);
  assert.match(zh, /保存并启用/u);
  // The promise the product cannot keep, in either catalogue's own phrasing of it.
  for (const [locale, notice] of [["en", en], ["zh-CN", zh]]) {
    assert.doesNotMatch(notice, /keeps? using|继续使用/u, `${locale} still promises the default will answer`);
  }
});

test("the failed-turn refusal names the credential, the model and Settings, in both catalogues", () => {
  const readings = {
    en: turnFailureText("runtime_unavailable", messages("en")),
    "zh-CN": turnFailureText("runtime_unavailable", messages("zh-CN")),
  };
  // The three fixes the settings side offers for this exact failure (`TavernConnectionProbeFailure`:
  // `unauthorized`, `not_found`, `unreachable`), named rather than left to the word "runtime".
  assert.match(readings.en, /API key/u);
  assert.match(readings["zh-CN"], /API Key/u);
  assert.match(readings.en, /model/u);
  assert.match(readings["zh-CN"], /模型/u);
  // Where to fix it: the panel's own name, in each catalogue.
  assert.match(readings.en, /Settings \(Connection and model\)/u);
  assert.match(readings["zh-CN"], /连接与模型/u);
  // And that a retry is not the way out, which is what the old sentence got wrong.
  assert.match(readings.en, /fail the same way/u);
  assert.match(readings["zh-CN"], /同样方式失败/u);
  assert.doesNotMatch(readings.en, /not available right now/iu);
  assert.doesNotMatch(readings["zh-CN"], /暂不可用|稍后再试/u);

  // The category is this one member and no other: the four declared codes still say four things.
  const labels = messages("en");
  const sentences = [
    "interrupted",
    "no_visible_presentation",
    "runtime_unavailable",
    "storage_unavailable",
  ].map((code) => turnFailureText(code, labels));
  assert.equal(new Set(sentences).size, 4, "the four declared codes render four different sentences");
});
