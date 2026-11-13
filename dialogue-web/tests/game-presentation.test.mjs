import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { messages } from "../src/i18n.ts";
import { composedProblemView, gameOperationFailure } from "../src/composed-problem-view.ts";
import { ComposedReferenceGameProblemError } from "../src/composed-reference-game-browser-api.ts";
import {
  authorityLabel,
  capabilitiesLabel,
  compatibilityLabel,
  connectionLabel,
  installationCandidateLabel,
  installationDiscoveryFailureState,
  installationDiscoveryState,
  installationModLoaderLabel,
  installationSourceLabel,
  installationStateLabel,
  instanceLabel,
  companionModIsReady,
  companionModLabel,
  outcomeLabel,
  COMPANION_MOD_OUTCOMES,
  orderCandidatesByReadiness,
} from "../src/game-presentation.ts";

/**
 * The frozen `game_browser_api/v1` unions, restated here on purpose: this test
 * is the guard that every state the Host can publish still has a player outcome
 * in both shipped locales. A new union member added to the client without a
 * catalog entry fails here rather than reaching a player as a raw enum
 * (design/104 §10).
 */
const CONNECTION_STATUSES = [
  "none",
  "discovering",
  "launch_pending",
  "attach_pending",
  "compatibility_warning",
  "awaiting_confirmation",
  "connecting",
  "connected_idle",
  "active",
  "stopping",
  "reconnecting",
  "syncing",
  "stopped",
  "failed",
  "disconnected",
];
const INSTANCE_STATUSES = ["none", "detected", "launching", "running", "stopped", "crashed"];
const COMPATIBILITY_STATUSES = ["unchecked", "compatible", "incompatible", "warning"];
const ACTION_AUTHORITIES = ["unavailable", "active", "paused"];
const OUTCOMES = ["none", "succeeded", "failed", "cancelled"];

const locales = ["en", "zh-CN"];

/* ========================================================================== *
 * THE CHANNEL POPULATION, read from the declarations that own it.
 *
 * Three facts below - the states the panel can be in, the diagnostics a scan can report and the
 * sources a candidate can come from - each used to be a hand list in this file. Each was correct on
 * the day it was written and each went stale the moment a channel arrived: the Microsoft Store / PC
 * Game Pass channel shipped with a diagnostic no list named, a state no list named and a source no
 * list named, so its sentences were measured by nothing.
 *
 * A hand list can only catch the members its author remembered; that is the difference between a test
 * and a gate. So the members are read out of the declarations - the client's `InstallationDiscoveryState`,
 * the Host's `DiscoveryDiagnostic` and the Host's candidate `source` - and a union this reader cannot
 * parse is a named failure rather than an empty population that agrees with itself.
 * ========================================================================== */

const TESTS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(TESTS_DIRECTORY, "..");
const CLIENT_GAME_PRESENTATION = join(WEB_ROOT, "src", "game-presentation.ts");
const HOST_DISCOVERY = join(WEB_ROOT, "..", "host", "src", "windows-stardew-installation-discovery", "internal.ts");

/**
 * The string-literal members of the one union `owns` names, or a failure describing what was parsed.
 *
 * Read as structure rather than as text: a comment that quotes a member name, or a second union in the
 * same file, would otherwise join a population nobody meant to measure.
 */
function stringLiteralUnion(file, what, owns, atLeast) {
  const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const unions = [];
  const visit = (node) => {
    const type = ts.isTypeAliasDeclaration(node) || ts.isPropertySignature(node) ? node.type : undefined;
    if (type !== undefined && owns(node) && ts.isUnionTypeNode(type)) {
      const members = type.types
        .filter((member) => ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal))
        .map((member) => member.literal.text);
      if (members.length > 0) unions.push(members);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.equal(
    unions.length,
    1,
    `${what}: expected exactly one string-literal union, and the reader found ${unions.length} in ${file}`,
  );
  assert.ok(unions[0].length >= atLeast, `${what}: derived ${unions[0].length} member(s), so the parse is wrong`);
  return unions[0];
}

/** The states the installation panel can be in: the client's own union, not this file's memory of it. */
function installationStates() {
  return stringLiteralUnion(
    CLIENT_GAME_PRESENTATION,
    "InstallationDiscoveryState",
    (node) => ts.isTypeAliasDeclaration(node) && node.name.text === "InstallationDiscoveryState",
    16,
  );
}

/** Every diagnostic the Host's scan can report. */
function hostDiagnostics() {
  return stringLiteralUnion(
    HOST_DISCOVERY,
    "DiscoveryDiagnostic",
    (node) => ts.isTypeAliasDeclaration(node) && node.name.text === "DiscoveryDiagnostic",
    8,
  );
}

/** Every source a candidate can come from: the Host's candidate vocabulary. */
function hostCandidateSources() {
  return stringLiteralUnion(
    HOST_DISCOVERY,
    "the candidate's `source`",
    (node) => ts.isPropertySignature(node) && ts.isIdentifier(node.name) && node.name.text === "source",
    4,
  );
}

/**
 * The states a rejected discovery read can name, from the client's own code list.
 *
 * `installationDiscoveryFailureState` branches on the Host codes it declares and answers every other
 * code with its own sentence. The codes are read out of that function and one code it does not declare
 * is added, so the fallback's sentence is measured too.
 */
function rejectedReadStates() {
  const body = readFileSync(CLIENT_GAME_PRESENTATION, "utf8").match(
    /export function installationDiscoveryFailureState\([\s\S]*?\n\}/u,
  )?.[0];
  assert.notEqual(body, undefined, "installationDiscoveryFailureState must be declared in game-presentation.ts");
  const codes = [...new Set([...body.matchAll(/code === "([a-z0-9_]+)"/gu)].map((match) => match[1]))];
  assert.ok(codes.length >= 2, `derived ${codes.length} rejected-read code(s), so the parse is wrong`);
  return [
    ...codes.map((code) => installationDiscoveryFailureState(code)),
    installationDiscoveryFailureState("a_code_this_build_does_not_declare"),
  ];
}

/** Every state a settled or rejected discovery answer can put the panel in, from those declarations. */
function discoveryOutcomeStates() {
  return [
    installationDiscoveryState(1, []),
    installationDiscoveryState(0, []),
    ...hostDiagnostics().map((diagnostic) => installationDiscoveryState(0, [diagnostic])),
    ...rejectedReadStates(),
  ];
}

/** The installation states the panel can paint, from the union that declares them. */
const INSTALLATION_STATES = installationStates();

test("every typed game fact renders a localized player outcome, never the raw enum", () => {
  for (const locale of locales) {
    const labels = messages(locale);
    for (const status of CONNECTION_STATUSES) {
      const value = connectionLabel(labels, status);
      assert.ok(typeof value === "string" && value.length > 0, `${locale} connection ${status} is empty`);
      assert.notEqual(value, status, `${locale} connection ${status} is rendered raw`);
      assert.ok(!value.includes("_"), `${locale} connection ${status} still reads like an enum`);
    }
    for (const status of INSTANCE_STATUSES) {
      const value = instanceLabel(labels, { status, gameTitle: null, generation: 0 });
      assert.notEqual(value, status, `${locale} instance ${status} is rendered raw`);
      assert.ok(!value.includes("_"), `${locale} instance ${status} still reads like an enum`);
    }
    // A published title is content, not a label: it passes through untouched.
    assert.equal(instanceLabel(labels, { status: "running", gameTitle: "Stardew Valley", generation: 1 }), "Stardew Valley");
    for (const status of COMPATIBILITY_STATUSES) {
      const value = compatibilityLabel(labels, { status, message: null });
      assert.notEqual(value, status, `${locale} compatibility ${status} is rendered raw`);
    }
    // The Host's own compatibility sentence wins over the generic state word.
    assert.equal(compatibilityLabel(labels, { status: "warning", message: "Untested version" }), "Untested version");
    for (const authority of ACTION_AUTHORITIES) {
      const value = authorityLabel(labels, authority);
      assert.notEqual(value, authority, `${locale} actionAuthority ${authority} is rendered raw`);
    }
    for (const outcome of OUTCOMES) {
      const value = outcomeLabel(labels, outcome);
      assert.notEqual(value, outcome, `${locale} latestOutcome ${outcome} is rendered raw`);
    }
    for (const state of INSTALLATION_STATES) {
      const value = installationStateLabel(labels, state);
      assert.ok(typeof value === "string" && value.length > 0, `${locale} installation ${state} is empty`);
      assert.notEqual(value, state, `${locale} installation ${state} is rendered raw`);
    }
  }
});

test("the Game settings section says when the world's name is chosen, in both languages", () => {
  // The finding this pins: the farm name is written once, by `CreateNewWorld`
  // (`WorldCreationBootstrap.cs:250`), and the game's only player-reachable
  // farm-name writer is the new-game form's box, which the post-creation screen
  // hides (`CharacterCustomization.cs:1118`, guarded write at `:2849`). So the
  // settings surface may not offer a rename - and must instead say so once.
  const en = messages("en");
  const zh = messages("zh-CN");
  assert.ok(en.gameSettingsWorldNameNote.trim().length > 0, "the English note is empty");
  assert.ok(zh.gameSettingsWorldNameNote.trim().length > 0, "the Chinese note is empty");
  assert.notEqual(zh.gameSettingsWorldNameNote, en.gameSettingsWorldNameNote, "the note is not translated");
  // Each locale names the thing it is about, so the sentence cannot drift into a
  // generic hint that a player would skim past.
  assert.match(en.gameSettingsWorldNameNote, /farm/iu);
  assert.match(zh.gameSettingsWorldNameNote, /农场/u);
  // The section reads the key, so it is not declared-and-unread (i18n.7's rule
  // applied to this one sentence, where the finding lives).
  const component = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "components", "GamePlayerSettings.tsx"),
    "utf8",
  );
  assert.ok(component.includes("labels.gameSettingsWorldNameNote"), "the settings section does not render the note");
  // Rendered outside the loaded/unavailable branch: a player who opens the section
  // on a build that cannot reach the settings route still learns the fact.
  assert.ok(
    component.indexOf("data-settings-note=\"world-name\"") > component.indexOf("labels.gameSettingsSave"),
    "the note must sit after the settings form, not inside the branch that a failed read replaces",
  );
});

test("every companion-Mod outcome renders a localized player outcome, derived from the Host contract", () => {
  // Derived from the contract's own list - the same array the schema's union is built from. A
  // hand-written list here would agree today and drift the first time the Host adds an outcome.
  const declared = [...COMPANION_MOD_OUTCOMES];
  assert.ok(declared.length > 0, "the contract declares no companionMod outcomes");

  const READY = ["companion-mod-installed", "companion-mod-current", "companion-mod-updated"];
  assert.deepEqual(
    declared.filter((outcome) => companionModIsReady(outcome)).sort(),
    [...READY].sort(),
    "the ready outcomes are not exactly the three that mean the Mod is in place",
  );

  for (const locale of locales) {
    const labels = messages(locale);
    const rendered = new Set();
    const readySentences = new Set(READY.map((outcome) => companionModLabel(labels, outcome)));
    for (const outcome of declared) {
      const value = companionModLabel(labels, outcome);
      assert.ok(typeof value === "string" && value.length > 0, `${locale} ${outcome} is empty`);
      assert.notEqual(value, outcome, `${locale} ${outcome} is rendered raw`);
      assert.ok(!value.includes("companion-mod-"), `${locale} ${outcome} still reads like an enum`);
      const ready = READY.includes(outcome);
      assert.equal(
        companionModIsReady(outcome),
        ready,
        `${locale} ${outcome} disagrees with the ready split`,
      );
      // Outcomes that need the same player action may share a sentence: `game-not-found` and
      // `game-installation-not-found` both mean "choose the folder again", so forcing two sentences would ask
      // the player to tell apart two identical situations. What must never happen is a refusal reading like
      // success - that is the failure this wording exists to prevent, and it is derivable here.
      if (!ready) {
        assert.ok(
          !readySentences.has(value),
          `${locale} ${outcome} reads as success: ${JSON.stringify(value)}`,
        );
      }
      rendered.add(value);
    }
  }
});

test("the two shipped locales are both really translated", () => {
  const en = messages("en");
  const zh = messages("zh-CN");
  for (const status of CONNECTION_STATUSES) {
    assert.notEqual(connectionLabel(zh, status), connectionLabel(en, status), `connection ${status} is not translated`);
  }
  for (const status of INSTANCE_STATUSES) {
    assert.notEqual(instanceLabel(zh, { status, gameTitle: null, generation: 0 }), instanceLabel(en, { status, gameTitle: null, generation: 0 }), `instance ${status} is not translated`);
  }
  for (const status of COMPATIBILITY_STATUSES) {
    assert.notEqual(compatibilityLabel(zh, { status, message: null }), compatibilityLabel(en, { status, message: null }), `compatibility ${status} is not translated`);
  }
  for (const authority of ACTION_AUTHORITIES) {
    assert.notEqual(authorityLabel(zh, authority), authorityLabel(en, authority), `authority ${authority} is not translated`);
  }
  for (const outcome of OUTCOMES) {
    assert.notEqual(outcomeLabel(zh, outcome), outcomeLabel(en, outcome), `outcome ${outcome} is not translated`);
  }
  for (const state of INSTALLATION_STATES) {
    assert.notEqual(installationStateLabel(zh, state), installationStateLabel(en, state), `installation ${state} is not translated`);
  }
});

/**
 * The player sentence follows the Host's own answer, not the candidate count.
 *
 * Measured defect: on a machine where Stardew Valley IS installed, the Host's discovery
 * replied with no candidate and diagnostics naming the sources it could not read
 * (`registry-unavailable` + `source-unavailable`), and the panel read that as "No Stardew
 * Valley installation was found." - a statement about the player's machine that the Host
 * never made. A rejected read had a second version of the same fault: a thrown code this
 * build does not know collapsed into "The installation search failed."
 */
test("the installation sentence follows the transport's own answer", () => {
  // A reply that carries a candidate is a candidate whatever else it reported.
  assert.equal(installationDiscoveryState(1, []), "candidates");
  assert.equal(installationDiscoveryState(1, ["registry-unavailable"]), "candidates");
  // A scan that could not read a source says so, from the Host's own diagnostics.
  for (const diagnostic of [
    "source-unavailable",
    "registry-unavailable",
    "vdf-unreadable",
    "vdf-malformed",
    "invalid-app-manifest",
    // The GOG source's own failures. A player whose Galaxy registry could not be read is a
    // player whose search could not run, not one whose game is absent.
    "gog-unavailable",
    "gog-metadata-unreadable",
    "gog-metadata-malformed",
  ])
    assert.equal(installationDiscoveryState(0, [diagnostic]), "source-unavailable", diagnostic);
  assert.equal(installationDiscoveryState(0, ["registry-unavailable", "invalid-app-manifest"]), "source-unavailable");
  assert.equal(installationDiscoveryState(0, ["source-unavailable", "no-candidates"]), "source-unavailable");
  // A scan that read everything and found nothing says exactly that.
  assert.equal(installationDiscoveryState(0, ["no-candidates"]), "no-candidates");
  assert.equal(installationDiscoveryState(0, []), "no-candidates");
  // A rejected read: the two codes that mean the scan itself could not run, the one that
  // means the Host refused to produce the result, and every code this build cannot name.
  assert.equal(installationDiscoveryFailureState("game_unavailable"), "source-unavailable");
  assert.equal(installationDiscoveryFailureState("source_unavailable"), "source-unavailable");
  assert.equal(installationDiscoveryFailureState("state_unavailable"), "error");
  for (const code of ["unauthorized", "not_found", "malformed_request", "closed", "invalid_stardew_installation_discovery", "network_error", null])
    assert.equal(installationDiscoveryFailureState(code), "result-unavailable", String(code));
});

test("a confirmation reads as the outcome it is, in both languages", () => {
  // A registered installation is the one moment a player needs to be told what
  // happened next; it used to be spoken as the empty scan a registration causes.
  assert.equal(
    installationStateLabel(messages("en"), "confirmed"),
    "Confirmed. Next, enable companion play and set up Stardew Valley, then load your farm.",
  );
  assert.equal(
    installationStateLabel(messages("zh-CN"), "confirmed"),
    "已确认。接下来启用伙伴陪玩，再设置《星露谷物语》，就可以载入你的农场。",
  );
  assert.notEqual(
    installationStateLabel(messages("en"), "confirmed"),
    installationStateLabel(messages("en"), "candidates"),
    "a confirmed installation is not the candidate-found sentence",
  );
});

test("a selection refusal names its cause, and an unnamed one says only what it knows", () => {
  // A folder holding no game: the player can fix it, so the sentence names the folder and
  // what to pick instead. It is not the search's sentence.
  assert.equal(
    installationStateLabel(messages("en"), "not-stardew-installation"),
    "That folder is not a Stardew Valley installation. Choose the game folder that contains Stardew Valley.exe.",
  );
  assert.equal(
    installationStateLabel(messages("zh-CN"), "not-stardew-installation"),
    "这个文件夹不是《星露谷物语》的安装位置。请选择包含 Stardew Valley.exe 的那个游戏文件夹。",
  );
  // A registration the Host could not name a cause for claims nothing beyond that, and in
  // particular is not the "could not read the source" sentence.
  assert.equal(
    installationStateLabel(messages("en"), "selection-unavailable"),
    "That folder could not be used. Choose another game folder.",
  );
  assert.equal(
    installationStateLabel(messages("zh-CN"), "selection-unavailable"),
    "无法使用这个文件夹，请重新选择游戏文件夹。",
  );
  assert.notEqual(
    installationStateLabel(messages("zh-CN"), "selection-unavailable"),
    installationStateLabel(messages("zh-CN"), "source-unavailable"),
    "a registration that could not complete is not a source that could not be read",
  );
});

/**
 * The third selection refusal, and the sentence that has to name the fix.
 *
 * A shortcut, a junction or an MO2 virtual folder holds the game and the mod loader - so the
 * two older refusals cannot be what refuses it - and it reached the player as the generic
 * "that folder could not be used", which names no cause and no action. The sentence has to say
 * what the path is and which folder to pick instead, in both languages.
 */
test("a linked folder is refused as a link, in words that name the folder to pick instead", () => {
  const en = installationStateLabel(messages("en"), "reparse-point");
  const zh = installationStateLabel(messages("zh-CN"), "reparse-point");
  for (const [locale, sentence] of [
    ["en", en],
    ["zh-CN", zh],
  ]) {
    assert.ok(sentence.length > 0, `${locale} reparse-point sentence is empty`);
    assert.notEqual(sentence, "reparse-point", `${locale} reparse-point is rendered raw`);
    // The three shapes a player's folder can be, named rather than implied.
    assert.match(sentence, /shortcut|快捷方式/u, `${locale} names the shortcut case`);
    assert.match(sentence, /junction|联接/u, `${locale} names the junction case`);
    assert.match(sentence, /Mod Organizer 2/u, `${locale} names the virtual-folder case`);
    // And the fix: the game's real folder, not a link to it.
    assert.match(sentence, /Stardew Valley\.exe/u, `${locale} says which folder holds the game`);
  }
  // Each of the three selection refusals says something the other two do not: the collapsed
  // state was exactly this - one sentence standing for three different fixes.
  const states = ["mod-loader-missing", "not-stardew-installation", "reparse-point"];
  for (const locale of ["en", "zh-CN"]) {
    const sentences = states.map((state) => installationStateLabel(messages(locale), state));
    assert.equal(new Set(sentences).size, states.length, `${locale} selection refusals do not share one sentence`);
    assert.ok(
      !sentences.includes(installationStateLabel(messages(locale), "selection-unavailable")),
      `${locale} a named refusal is not the unnamed one`,
    );
  }
});

/**
 * The panel's list of source-read failures is a hand copy of the Host's `DiscoveryDiagnostic`
 * union, so it drifts the moment the Host adds a member - and the drift is silent and harmful:
 * a diagnostic the panel does not know reads as "no installation was found", which is a
 * statement about the player's machine the Host never made. That is exactly how the GOG
 * diagnostics would have been lost.
 *
 * So the population is derived from the Host's own declaration and the exceptions are named:
 * every member of `DiscoveryDiagnostic` must make the panel say one of the three things the
 * Host's own members can mean - a search that could not run, a copy the player has that cannot
 * load mods, or an absence. A new member fails here until someone decides which it is.
 */
test("the panel knows every discovery diagnostic the Host can send, by derivation", () => {
  const members = hostDiagnostics();
  // The members that describe an absence rather than a failed read. They are named here rather than
  // inferred, so a new one has to be a decision somebody makes.
  //
  // `library-without-game` belongs here: a Steam library that simply does not hold this game is the ordinary
  // state of most libraries, and telling the player their search could not run would be a statement the Host
  // never made.
  const NAMES_ABSENCE_NOT_FAILURE = ["no-candidates", "candidate-invalid", "library-without-game"];
  // The member that names neither: the game is really installed, in the Store layout the Xbox app
  // creates without mod support, so "nothing was found" and "the search could not run" are both
  // untrue of it. It has its own sentence, and this asks for that sentence by name.
  const NAMES_A_COPY_THAT_CANNOT_LOAD_MODS = ["microsoft-store-install-not-mod-enabled"];
  // An exception that outlives the member it excuses would quietly stop checking anything.
  assert.deepEqual(
    [...NAMES_ABSENCE_NOT_FAILURE, ...NAMES_A_COPY_THAT_CANNOT_LOAD_MODS].filter(
      (member) => !members.includes(member),
    ),
    [],
    "a named exception names a member the Host's union no longer declares",
  );
  const failures = [];
  for (const member of members) {
    if (NAMES_ABSENCE_NOT_FAILURE.includes(member)) continue;
    const expected = NAMES_A_COPY_THAT_CANNOT_LOAD_MODS.includes(member)
      ? "install-cannot-load-mods"
      : "source-unavailable";
    const actual = installationDiscoveryState(0, [member]);
    if (actual !== expected) failures.push(`${member} reads as ${actual}, not ${expected}`);
  }
  assert.deepEqual(failures, []);
});

/**
 * The channels whose candidate row has no sentence of its own, declared so the absence is measured.
 *
 * The list this test used to carry was the four sources that existed when GOG was the new channel; the
 * Store channel then arrived with a source member no list named, and its row read `Found on this
 * computer` - the sentence for a source this build cannot name - while every test stayed green.
 *
 * A channel here is not exempt from being read: it is recorded because naming it needs a catalogue key
 * in both locales and a case in `installationSourceLabel`, which is a copy decision rather than a gate.
 * The entry fails the moment that sentence lands, and it fails if a channel joins this list without being
 * written down - so neither direction can rot.
 */
const CHANNELS_WITHOUT_OWN_SENTENCE = [
  {
    source: "microsoft-store",
    reason:
      "the Store channel's rows fall back to the generic `Found on this computer` sentence, so a player cannot " +
      "tell an Xbox-app copy from a source this build does not know",
  },
];

/**
 * Every source the discovery session can declare reads as a sentence, in both languages - and a channel
 * with no sentence of its own is stated rather than silently reading as the fallback.
 *
 * The population is the Host's own union, so the next channel is measured on its first run instead of
 * joining the product behind a green suite.
 */
test("each declared discovery source reads as its own sentence in both languages", () => {
  const sources = hostCandidateSources();
  const en = messages("en");
  const zh = messages("zh-CN");
  const recorded = CHANNELS_WITHOUT_OWN_SENTENCE.map((entry) => entry.source);
  const table = [];
  const failures = [];
  for (const source of sources) {
    const english = installationSourceLabel(en, source);
    const chinese = installationSourceLabel(zh, source);
    table.push(`${source.padEnd(18)} en=${JSON.stringify(english)} zh=${JSON.stringify(chinese)}`);
    if (english.length === 0) failures.push(`en source ${source} is empty`);
    if (english === source) failures.push(`en source ${source} is rendered raw`);
    if (english.includes("_")) failures.push(`en source ${source} still reads like an enumeration`);
    if (chinese === english) failures.push(`source ${source} is not translated`);
    // A channel recorded as having no sentence of its own must still have none, and a channel that is
    // not recorded must name itself: the two directions are what keep this list from rotting.
    const isFallback = english === en.gameInstallationSourceOther;
    if (recorded.includes(source) && !isFallback)
      failures.push(
        `${source} is recorded as having no sentence of its own and now reads ${JSON.stringify(english)}; drop the entry`,
      );
    if (!recorded.includes(source) && isFallback)
      failures.push(`${source} reads the generic sentence ${JSON.stringify(english)}; every declared channel names itself`);
  }
  for (const source of recorded)
    if (!sources.includes(source)) failures.push(`${source} is recorded as a nameless channel and the Host no longer declares it`);
  // The GOG sentence names the store, so a player can tell it from the Steam rows beside it.
  assert.match(installationSourceLabel(en, "gog"), /GOG/u);
  assert.match(installationSourceLabel(zh, "gog"), /GOG/u);
  // A source this build has no sentence for still describes a candidate the Host published.
  assert.equal(installationSourceLabel(en, "epic-games-store"), en.gameInstallationSourceOther);
  console.log(
    `[discovery sources] examined ${sources.length} source(s) x ${locales.length} locale(s), ` +
      `${recorded.length} recorded without a sentence:\n  ${table.join("\n  ")}`,
  );
  assert.deepEqual(failures, [], "every declared discovery channel reads as its own sentence");
});

test("a candidate's own line carries where it is, so two installations are not one row twice", () => {
  const en = messages("en");
  const zh = messages("zh-CN");
  assert.equal(installationCandidateLabel(en, null), "Stardew Valley");
  // The game's name is the product's, in the player's language - the Host's `label` is
  // one fixed English string for every installation.
  assert.equal(installationCandidateLabel(zh, null), "《星露谷物语》");
  // With a location the row states it, and the parentheses are the locale's own.
  assert.equal(installationCandidateLabel(en, "D: · SteamLibrary"), "Stardew Valley (D: · SteamLibrary)");
  assert.equal(installationCandidateLabel(zh, "D: · SteamLibrary"), "《星露谷物语》（D: · SteamLibrary）");
  // The property two rows depend on: equal when they agree, different when they do not.
  assert.notEqual(
    installationCandidateLabel(en, "C: · Steam"),
    installationCandidateLabel(en, "D: · SteamLibrary"),
  );
  assert.equal(
    installationCandidateLabel(en, "D: · SteamLibrary"),
    installationCandidateLabel(en, "D: · SteamLibrary"),
  );
});

/**
 * The outcomes a discovery answer can name are different sentences, in both languages.
 *
 * The population used to be four states somebody listed. The fifth channel's state -
 * `install-cannot-load-mods`, the Store copy no mod loader can run in - arrived later and was measured
 * by nothing: it could have shipped carrying an empty scan's sentence and this test would have stayed
 * green. The states are now derived from the declarations that decide them (the Host's diagnostics and
 * the client's own code list), so a channel that maps to a new state is measured the day it is declared.
 */
test("the discovery outcomes a reply can name are distinct sentences in both languages", () => {
  const states = [...new Set(discoveryOutcomeStates())];
  const table = [];
  const failures = [];
  for (const locale of locales) {
    const labels = messages(locale);
    const sentences = states.map((state) => installationStateLabel(labels, state));
    for (const [index, sentence] of sentences.entries())
      table.push(`${locale} ${states[index].padEnd(26)} ${JSON.stringify(sentence)}`);
    // Two outcomes a player must tell apart may not share one sentence.
    const seen = new Map();
    for (const [index, sentence] of sentences.entries()) {
      if (seen.has(sentence))
        failures.push(
          `${locale}: ${states[seen.get(sentence)]} and ${states[index]} read the same sentence: ${JSON.stringify(sentence)}`,
        );
      seen.set(sentence, index);
    }
  }
  assert.ok(states.length >= 5, `derived ${states.length} outcome(s); the derivation is wrong`);
  console.log(
    `[discovery outcomes] examined ${states.length} state(s) x ${locales.length} locale(s):\n  ${table.join("\n  ")}`,
  );
  assert.deepEqual(failures, [], "two discovery outcomes a player must tell apart share one sentence");
});

test("the capability summary says how many capabilities are published, or says it published none", () => {
  const en = messages("en");
  assert.equal(capabilitiesLabel(en, { available: true, count: 7 }), "7 available");
  assert.equal(capabilitiesLabel(en, { available: false, count: 0 }), en.gameCapabilitiesUnavailable);
  assert.equal(capabilitiesLabel(messages("zh-CN"), { available: true, count: 7 }), "7 项可用");
});

test("a candidate says whether its folder can load the companion, and ready folders come first", () => {
  // The loader is the player's to install and a machine can hold several installations, so this label is the fact
  // their choice depends on. `null` is "the Host did not say" and must render nothing rather than "missing".
  for (const locale of locales) {
    const labels = messages(locale);
    const present = installationModLoaderLabel(labels, "present");
    const missing = installationModLoaderLabel(labels, "missing");
    const unknown = installationModLoaderLabel(labels, null);

    assert.ok(typeof present === "string" && present.length > 0, `${locale} present is empty`);
    assert.ok(typeof missing === "string" && missing.length > 0, `${locale} missing is empty`);
    assert.equal(unknown, null, `${locale} rendered a state the Host did not report`);
    assert.notEqual(present, missing, `${locale} reads ready and not-ready the same way`);
    // Neither may leak the wire token.
    for (const value of [present, missing]) {
      assert.ok(!value.includes("_"), `${locale} label still reads like an enum: ${value}`);
    }
  }

  // Ordering: ready first, and the Host's order preserved inside each group.
  const input = [
    { candidateId: "a", modLoader: "missing" },
    { candidateId: "b", modLoader: "present" },
    { candidateId: "c", modLoader: null },
    { candidateId: "d", modLoader: "present" },
  ];
  const ordered = orderCandidatesByReadiness(input);
  assert.deepEqual(
    ordered.map((candidate) => candidate.candidateId),
    ["b", "d", "a", "c"],
  );
  // The input is not mutated: the panel renders a derived list, not a re-sorted value it was handed.
  // This assertion used to compare a literal with itself, so no implementation could have reddened it.
  assert.deepEqual(
    input.map((candidate) => candidate.candidateId),
    ["a", "b", "c", "d"],
    "ordering re-sorted the caller's own list",
  );
});


/**
 * A game that died, and the words the panel owes it.
 *
 * The measured defect behind this pair: the Guardian's `role_exited` fact reached the Host and
 * stopped there, so a crash was projected as the ordinary "still starting" instance and the
 * cabin read as a retryable `state_unavailable`. The two facts below are what the panel now
 * reads instead - the exit sentence with the code the OS reported, and the cabin refusal's own
 * sentence - and the negative is the half that keeps it honest: with no exit reported, neither
 * may claim the game ended.
 */
test("the instance reads the exit the Host published, code and all, in both languages", () => {
  const exitCode = 3221225781;
  for (const locale of locales) {
    const labels = messages(locale);
    const sentence = instanceLabel(labels, {
      status: "crashed",
      gameTitle: "Stardew Valley",
      generation: 1,
      playerHostExitCode: exitCode,
    });
    assert.ok(sentence.includes(String(exitCode)), `${locale} hides the exit code the Host published`);
    assert.ok(!sentence.includes("{{code}}"), `${locale} left the template marker in the sentence`);
    assert.notEqual(sentence, labels.gameInstanceCrashed, `${locale} falls back to the bare state word`);
    // The title alone ("Stardew Valley") beside a crashed instance says nothing about what
    // happened to it, which is why the published code wins.
    assert.notEqual(sentence, instanceLabel(labels, { status: "running", gameTitle: "Stardew Valley", generation: 1 }));
  }
  assert.notEqual(
    instanceLabel(messages("zh-CN"), { status: "crashed", gameTitle: null, generation: 0, playerHostExitCode: exitCode }),
    instanceLabel(messages("en"), { status: "crashed", gameTitle: null, generation: 0, playerHostExitCode: exitCode }),
    "the exit sentence is not translated",
  );
  // The negative: no published code means the Host observed no exit, so the panel must not
  // claim one - it says the state word it always said.
  const withoutExit = instanceLabel(messages("en"), { status: "crashed", gameTitle: "Stardew Valley", generation: 1 });
  assert.equal(withoutExit, "Stardew Valley", "a Host that published no exit must not be read as one");
  assert.ok(!withoutExit.includes("exit code"), "the panel invented an exit code");
});

test("the cabin read's exit refusal reaches the player as the ending it is, not as a retry", () => {
  const cabinReadRefused = () => new ComposedReferenceGameProblemError("stardew_player_host_exited", 409);
  for (const locale of locales) {
    const labels = messages(locale);
    const view = composedProblemView(cabinReadRefused(), labels);
    assert.equal(view.kind, "problem");
    assert.ok(view.title.length > 0 && view.detail.length > 0, `${locale} has no sentence for the refusal`);
    assert.ok(!view.title.includes("stardew_player_host_exited"), `${locale} prints the raw code`);
    assert.ok(!view.detail.includes("stardew_player_host_exited"), `${locale} prints the raw code`);
    // It is a refusal, not an unsettled operation: the read did not happen and cannot.
    assert.deepEqual(gameOperationFailure(cabinReadRefused(), labels), {
      kind: "refused",
      sentence: view.detail,
    });
    // The step is the one that can change the answer. Restarting GameBuddy is what a
    // quarantined lifecycle needs; "read it again" is the retry that cannot help.
    assert.equal(view.step.kind, "outside_surface");
    assert.equal(view.step.step, "restart_gamebuddy");
    // The negative: the same read with no exit reported keeps the "we do not know" sentence,
    // which is a retry - so the two situations really do read differently.
    const unknown = composedProblemView(new ComposedReferenceGameProblemError("state_unavailable", 503), labels);
    assert.notEqual(unknown.title, view.title, `${locale} reads "gone" and "unknown" the same way`);
    assert.equal(unknown.step.kind, "control");
    assert.ok(
      !unknown.detail.includes("{{code}}") && !unknown.title.includes("{{code}}"),
      `${locale} left a template marker in the unknown sentence`,
    );
  }
});
