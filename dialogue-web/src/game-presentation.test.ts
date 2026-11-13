import assert from "node:assert/strict";
import test from "node:test";
import type { InstallationDiscoveryState } from "./game-presentation";
import {
  deriveCapabilityBoard,
  installationDiscoveryFailureState,
  installationDiscoveryState,
  installationHintLabel,
  installationModLoaderLabel,
  installationStateLabel,
  orderCandidatesByReadiness,
} from "./game-presentation";
import { messages } from "./i18n";

/**
 * The installation-discovery judgements, held to their contract without a browser.
 *
 * These are the pure functions the panel reads, so a wrong answer here is a wrong
 * sentence in front of the player whatever the DOM does. The measured defect behind
 * the first two cases: the Host rightly said it could not read Steam/GOG, and the
 * surface told the player no Stardew Valley installation was found - a claim about
 * their machine that the Host never made.
 */

const LOCALES = ["en", "zh-CN"] as const;

/**
 * The diagnostics that name a source the scan could not read. The full population is
 * derived from the Host's own `DiscoveryDiagnostic` union by
 * `tests/game-presentation.test.mjs`; this is the sample a unit test drives directly.
 */
const SOURCE_READ_FAILURES = [
  "source-unavailable",
  "registry-unavailable",
  "vdf-unreadable",
  "vdf-malformed",
  "invalid-app-manifest",
  "gog-unavailable",
  "gog-metadata-unreadable",
  "gog-metadata-malformed",
  // The Microsoft Store channel's own two read failures.
  "microsoft-store-unavailable",
  "microsoft-store-root-unreadable",
];

const INSTALLATION_STATES: readonly InstallationDiscoveryState[] = [
  "not_configured",
  "loading",
  "candidates",
  "confirming",
  "retrying",
  "cancelled",
  "source-unavailable",
  "no-candidates",
  // A copy the player has, in the layout no mod loader can run in.
  "install-cannot-load-mods",
  "result-unavailable",
  "mod-loader-missing",
  "not-stardew-installation",
  "reparse-point",
  "selection-unavailable",
  "confirmed",
  "expired",
  "error",
];

test("an empty scan says a source could not be read when a diagnostic names one", () => {
  // A scan that read everything and found nothing says exactly that.
  assert.equal(installationDiscoveryState(0, []), "no-candidates");
  assert.equal(installationDiscoveryState(0, ["no-candidates"]), "no-candidates");
  // A scan that could not read a source is not a machine without the game.
  for (const diagnostic of SOURCE_READ_FAILURES)
    assert.equal(installationDiscoveryState(0, [diagnostic]), "source-unavailable", diagnostic);
  // One failure diagnostic outweighs any number of absence diagnostics beside it.
  assert.equal(installationDiscoveryState(0, ["no-candidates", "registry-unavailable"]), "source-unavailable");
});

test("a copy the player has is named ahead of a channel that failed beside it", () => {
  // The ordinary answer on a Windows machine with no GOG Galaxy: its config file is absent, so the
  // GOG channel reports `gog-metadata-unreadable` (`stardew-game-install/gog-source.ts`) beside
  // whatever the Store channel found. A Game Pass player's copy in the layout without mod support
  // must still be the sentence they read - the fact is about the game they own, while a channel
  // that failed only means another search is unevaluated.
  assert.equal(
    installationDiscoveryState(0, [
      "microsoft-store-install-not-mod-enabled",
      "gog-metadata-unreadable",
      "no-candidates",
    ]),
    "install-cannot-load-mods",
  );
  // With no such copy, the failed channel is still what the reply says.
  assert.equal(installationDiscoveryState(0, ["gog-metadata-unreadable", "no-candidates"]), "source-unavailable");
  // And a candidate the Host offers outranks both.
  assert.equal(
    installationDiscoveryState(1, ["microsoft-store-install-not-mod-enabled", "gog-metadata-unreadable"]),
    "candidates",
  );
});

test("a reply that carries a candidate is a candidate whatever else it reported", () => {
  for (const candidateCount of [1, 2, 9]) {
    assert.equal(installationDiscoveryState(candidateCount, []), "candidates");
    assert.equal(installationDiscoveryState(candidateCount, ["registry-unavailable", "gog-unavailable"]), "candidates");
  }
});

test("a rejected read blames the search only for the codes that say the search could not run", () => {
  assert.equal(installationDiscoveryFailureState("game_unavailable"), "source-unavailable");
  assert.equal(installationDiscoveryFailureState("source_unavailable"), "source-unavailable");
  // The Host refused to produce the result: a genuine search failure, not an unreadable one.
  assert.equal(installationDiscoveryFailureState("state_unavailable"), "error");
  assert.notEqual(installationDiscoveryFailureState("state_unavailable"), "source-unavailable");

  for (const unknownCode of [
    null,
    "unauthorized",
    "not_found",
    "malformed_request",
    "closed",
    "network_error",
    "invalid_stardew_installation_discovery",
  ])
    assert.equal(installationDiscoveryFailureState(unknownCode), "result-unavailable", String(unknownCode));
});

test("a candidate's mod-loader state reads as itself, and `null` says nothing at all", () => {
  for (const locale of LOCALES) {
    const labels = messages(locale);
    // A reported state that produced no sentence reads as empty, which is what these assert.
    const present = installationModLoaderLabel(labels, "present") ?? "";
    const missing = installationModLoaderLabel(labels, "missing") ?? "";
    assert.ok(present.length > 0, `${locale} present is empty`);
    assert.ok(missing.length > 0, `${locale} missing is empty`);
    assert.notEqual(present, missing, `${locale} reads a ready folder and an unready one the same way`);
    for (const sentence of [present, missing]) assert.ok(!sentence.includes("_"), `${locale} ${sentence}`);
    // The Host did not say: the panel states nothing rather than "missing".
    assert.equal(installationModLoaderLabel(labels, null), null);
  }
});

test("ready folders come first, and the Host's order survives inside each group", () => {
  type Candidate = Readonly<{ candidateId: string; modLoader: "present" | "missing" | null }>;
  const hostOrder: readonly Candidate[] = [
    { candidateId: "missing-1", modLoader: "missing" },
    { candidateId: "present-1", modLoader: "present" },
    { candidateId: "unknown-1", modLoader: null },
    { candidateId: "present-2", modLoader: "present" },
    { candidateId: "missing-2", modLoader: "missing" },
  ];

  const ordered = orderCandidatesByReadiness(hostOrder);
  const ids = (candidates: readonly Candidate[]) => candidates.map((candidate) => candidate.candidateId);

  assert.deepEqual(ids(ordered), ["present-1", "present-2", "missing-1", "unknown-1", "missing-2"]);
  // Stable: every ready folder precedes every folder whose loader state is not present.
  assert.deepEqual(
    ordered.map((candidate) => (candidate.modLoader === "present" ? 0 : 1)),
    [0, 0, 1, 1, 1],
  );
  // Re-sorting a sorted list changes nothing, so a re-read does not reshuffle the rows.
  assert.deepEqual(ids(orderCandidatesByReadiness(ordered)), ids(ordered));
  // The list handed in is not reordered in place, and the result is a new list.
  assert.deepEqual(ids(hostOrder), ["missing-1", "present-1", "unknown-1", "present-2", "missing-2"]);
  assert.notEqual(ordered as readonly Candidate[], hostOrder);

  // Boundaries: nothing to offer, and one row keeps its place.
  assert.deepEqual(orderCandidatesByReadiness([]), []);
  assert.deepEqual(ids(orderCandidatesByReadiness([{ candidateId: "only", modLoader: null }])), ["only"]);
});

test("the Host's own note becomes the player's sentence, never the Host's English", () => {
  const labels = messages("en");
  assert.equal(installationHintLabel(labels, null), null);
  // A note is the fact that the redacted path is not shown; the Host's wording is not republished.
  const sentence = installationHintLabel(labels, "Full path hidden in this projection");
  assert.equal(sentence, labels.gameInstallationHintPathHidden);
  assert.equal(installationHintLabel(labels, "another producer sentence"), sentence);
});

test("the capability board states the published facts, and waits when nothing is published", () => {
  const labels = messages("en");
  const projection = (available: boolean, count: number, companionName: string | null) => ({
    prerequisites: { status: "met" as const, detectedGame: null, missingItems: [] },
    instance: { status: "running" as const, gameTitle: null, generation: 1 },
    compatibility: { status: "compatible" as const, message: null },
    attachment: { status: "attached" as const, generation: 1 },
    connectionStatus: "connected_idle" as const,
    actionAuthority: "active" as const,
    role: "companion" as const,
    companionName,
    selectedWorld: null,
    selectedSave: null,
    capabilitySummary: { available, count },
    latestOutcome: "none" as const,
  });

  const published = deriveCapabilityBoard(labels, projection(true, 7, "Mira"));
  assert.deepEqual(
    published.cards.map((card) => card.key),
    ["companion", "abilities", "action"],
  );
  assert.ok(published.lead.includes("7"), "the published count is not stated");
  assert.equal(published.waiting, null, "a published surface still reads as waiting");
  assert.equal(published.cards[0].title, "Mira");
  // The board is a derivation of the projection, not a mutation surface.
  assert.ok(Object.isFrozen(published) && Object.isFrozen(published.cards));

  const unpublished = deriveCapabilityBoard(labels, projection(false, 0, null));
  assert.equal(unpublished.waiting, labels.gameBoardWaiting);
  assert.equal(unpublished.cards[0].title, labels.gameBoardCompanionTitle);
  // What the board is waiting for is never a fallback list of abilities.
  assert.equal(unpublished.lead, labels.gameBoardUnpublishedLead);
  assert.notEqual(unpublished.cards[1].detail, published.cards[1].detail);
});

test("every installation state reaches the player as a sentence, in both catalogues", () => {
  const sentencesPerLocale = new Map<string, string[]>();
  for (const locale of LOCALES) {
    const labels = messages(locale);
    const sentences = INSTALLATION_STATES.map((state) => {
      const sentence = installationStateLabel(labels, state);
      assert.ok(sentence.length > 0, `${locale} ${state} is empty`);
      assert.notEqual(sentence, state, `${locale} ${state} is rendered as the wire member`);
      assert.ok(!sentence.includes("_"), `${locale} ${state} still reads like an enumeration: ${sentence}`);
      return sentence;
    });
    // Two different states are two different facts: a shared sentence is a collapsed outcome.
    assert.equal(new Set(sentences).size, INSTALLATION_STATES.length, `${locale} two states share one sentence`);
    sentencesPerLocale.set(locale, sentences);
  }
  const [en, zh] = LOCALES.map((locale) => sentencesPerLocale.get(locale) ?? []);
  assert.ok(
    en.every((sentence, index) => sentence !== zh[index]),
    "a state reads the same in both catalogues, so one of them is untranslated",
  );
});

test("the states the two mappers can produce all have a player sentence", () => {
  // Derived from the mappers rather than listed: a state they can return but the
  // catalogue has no words for would reach the player as its own token.
  const produced = new Set<InstallationDiscoveryState>();
  for (const candidateCount of [0, 1, 4])
    for (const diagnostics of [[], ["no-candidates"], SOURCE_READ_FAILURES])
      produced.add(installationDiscoveryState(candidateCount, diagnostics));
  for (const code of ["game_unavailable", "source_unavailable", "state_unavailable", null, "unauthorized"])
    produced.add(installationDiscoveryFailureState(code));

  assert.ok(produced.size >= 4, `derived ${produced.size} states; the mapper read is wrong`);
  for (const locale of LOCALES) {
    const labels = messages(locale);
    for (const state of produced) {
      const sentence = installationStateLabel(labels, state);
      assert.ok(sentence.length > 0, `${locale} ${state} has no sentence`);
    }
  }
});
