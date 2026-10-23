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
 * built-in default connection" - *keep going, something already works*. Nothing works there: the
 * catalogue's default is the operator environment entry, whose credential is the ambient
 * `CPA_OAI_API_KEY` and whose endpoint is a loopback port nothing in a shipped install listens on
 * (`host/src/tavern/provider-catalog.ts`), so the sentence promised a first message that could only
 * fail. The premise changed twice since. First the banner stopped promising that default; then, once
 * the Chat began deriving its own answer in `chat-model-route.ts`, it stopped making any claim about
 * delivery at all. The reason is in that module and measured on capture `shots-final43`: a root with
 * no saved connection still answers, through the Chat model profile the build ships, so "no
 * connection" is not "no model". The section now says what it configures and where the rest of the
 * work happens, and the delivery verdict lives on the one surface that reads it.
 *
 * 2.1: a wrong, revoked or unserved credential reached the chat surface as
 * "回复运行时暂不可用，请稍后再试。" - the product blaming itself and inviting a retry that fails
 * identically. The English catalogue had already moved to the honest sentence; the Chinese one had
 * drifted back to the generic line. The force pinned here is what a player needs from a credential
 * refusal: name the credential and the model, point at Settings, and say a retry changes nothing.
 */
test("the connection section asks for what the form can do, in both catalogues", () => {
  const en = messages("en").connectionSetupNotice;
  const zh = messages("zh-CN").connectionSetupNotice;

  // The control the form actually has. Its only submit is "Save connection"; activating is a
  // separate Host operation that refuses a record whose probe has not passed.
  assert.match(en, /save the connection here/u);
  assert.match(zh, /在这里保存连接/u);
  assert.match(en, /test it there/u);
  assert.match(zh, /在那里测试/u);
  // No claim about delivery: not the one this section got wrong, and not its Chinese phrasing.
  for (const [locale, notice] of [["en", en], ["zh-CN", zh]]) {
    assert.doesNotMatch(notice, /cannot reach a model|no model|none to fall back on/u, `${locale} claims a reply has no model`);
    assert.doesNotMatch(notice, /无法送达|没有模型|没有它可回退/u, `${locale} claims a reply has no model`);
    assert.doesNotMatch(notice, /keeps? using|继续使用/u, `${locale} still promises the default will answer`);
    // And not a control that is not on the screen: `保存并启用`/"save and enable" exists only inside
    // a saved row, which renders after `connections.length > 0` and is disabled until the probe passes.
    assert.doesNotMatch(notice, /save and enable|保存并启用/u, `${locale} asks for a control this state lacks`);
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

/**
 * Who provides a credential is two facts, not one (owner decision D).
 *
 * `cpa-oai` is this product's own local gateway: an operator runs it on this
 * machine and its key is that operator's environment variable. An arbitrary
 * player cannot self-serve one, so the sentence beside that entry must say the
 * operator provides it rather than invite a key that no form here can accept.
 * Every third-party entry is the opposite fact - the player's own account with
 * that provider - and keeps bring-your-own-key wording.
 *
 * Both halves are pinned, and pinned as *different sentences*: a single merged
 * sentence that mentioned both would let the operator's entry read as a place to
 * paste a key, which is exactly the lie this removes.
 */
test("the credential sentence names the operator for our gateway and the player for a third party", () => {
  for (const locale of ["en", "zh-CN"]) {
    const labels = messages(locale);
    const operator = labels.connectionCredentialOperatorProvided;
    const player = labels.connectionCredentialBringYourOwn;
    assert.notEqual(operator, player, `${locale} must not merge the two facts into one sentence`);
    assert.ok(operator.trim().length > 0 && player.trim().length > 0, `${locale} must state both`);
  }

  const en = messages("en");
  // The operator's entry: this machine's environment, and no key to type.
  assert.match(en.connectionCredentialOperatorProvided, /provided by the operator/iu);
  assert.match(en.connectionCredentialOperatorProvided, /environment variables/iu);
  assert.match(en.connectionCredentialOperatorProvided, /no key to enter/iu);
  assert.doesNotMatch(en.connectionCredentialOperatorProvided, /bring your own key/iu);
  // The third-party entry: the player's own account, and the product supplies none.
  assert.match(en.connectionCredentialBringYourOwn, /bring your own key/iu);
  assert.match(en.connectionCredentialBringYourOwn, /your own account/iu);
  assert.doesNotMatch(en.connectionCredentialBringYourOwn, /provided by the operator/iu);

  const zh = messages("zh-CN");
  assert.match(zh.connectionCredentialOperatorProvided, /运营方/u);
  assert.match(zh.connectionCredentialOperatorProvided, /环境变量/u);
  assert.doesNotMatch(zh.connectionCredentialOperatorProvided, /自备密钥/u);
  assert.match(zh.connectionCredentialBringYourOwn, /自备密钥/u);
  assert.match(zh.connectionCredentialBringYourOwn, /自己的账号/u);
  assert.doesNotMatch(zh.connectionCredentialBringYourOwn, /运营方/u);

  // The provider picker's own suffix says the same thing in one phrase, so the two
  // places a player reads it cannot drift apart.
  assert.match(en.connectionEnvironmentManaged, /provided by the operator/iu);
  assert.match(zh.connectionEnvironmentManaged, /运营方/u);
});
