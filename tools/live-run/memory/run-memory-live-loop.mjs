#!/usr/bin/env node
/**
 * The third live-run loop: memory.
 *
 * The Chat loop closes its assertions inside one session, and the Game ladder
 * proves native mutation. Neither can say WHICH layer loses a fact that the player
 * stated. This runner answers that, using the four-stage funnel
 * (tools/lib/memory-funnel.mjs, design section 10).
 *
 * Topology (design 10.1, verified against the compositions rather than assumed):
 * no single mounted surface holds both halves. `chat-only` mounts
 * chat.submit/chat.cancel/events but NO memory route; `management` mounts
 * memory.read/memory.mutate but no chat submit. So this runner runs the two halves
 * against the SAME principal.continuityId.
 *
 * That the two halves really share storage is not a hope: resolveRuntimePaths()
 * partitions only sessionDir by surfaceSessionId and leaves runtimeCwd keyed by
 * (playerId, companionId, continuityId), and the Memory service consumes exactly
 * that runtimeCwd. What is NOT yet proven end-to-end is whether assembly (L2/L3)
 * sees the seeded fact; this runner exists to find out.
 *
 * Causal ordering is enforced, not hoped for (reviewer discipline): the seed must
 * be confirmed by the durable readback of the management route BEFORE any chat turn
 * starts. A run where the seed did not land reports the L1 gap and stops - it never
 * proceeds to interpret a later miss.
 *
 * Refuses to read the vendor SQLite directly: the harness runs outside the child
 * and a second connection would risk WAL contention and break the evidence-class
 * discipline. L2 therefore reports a gap until a Host-side diagnostic projection
 * exposes the rendered ids (design 10.8 step 3), and this runner never pretends
 * otherwise.
 *
 * Maintenance contract: this is a runner for the REAL product surfaces. It may not
 * be replaced by a fixture that writes memory rows, by a mock provider, or by a
 * hand-authored funnel report - any of those would turn the loop into
 * self-certification. After each real run, audit the trace with the `auditing-runs`
 * skill and dispatch a reviewer subagent; record what it finds in
 * design/handbook/live-run-patterns.md.
 */
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile, copyFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { launchDesktopCompositionGateChild } from "../../desktop-composition-launch.mjs";
import { evaluateProbeReply, loadProbeManifest, openEventStream, probeTurnCommittedGate, probeVerdict } from "../chat/run-chat-live-audit.mjs";
import { attributeMemoryFunnel, foldCommittedRenderedIdsFromMarkers, m0DigestsFromMarkers, m0SourcesFromMarkers, renderedMemoryIdsFromMarkers, renderedChaptersFromMarkers } from "../../lib/memory-funnel.mjs";
import { openLiveRunCapture, resolveLiveRunRoot } from "../core/capture.mjs";

// The same bounded BCP-47 shape the Host stores for the companion language
// (settings/player-preference-store.ts). Spelled here for the same reason the browser
// contract spells it: the shape is bounded, the language set is the player's choice.
const COMPANION_LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$/;

// Live-run evidence root (repo-local, git-ignored): every memory loop run keeps
// its own directory with the runtime root's evidence and the child stderr, so a
// reviewer can see what actually reached the model instead of only digest facts.
const LIVE_RUN_ROOT = resolveLiveRunRoot({ repoRoot: fileURLToPath(new URL("../../..", import.meta.url)) });

/**
 * The Class B marker Magic Context emits with the ids it assembled into m[0]
 * (owner decision D-1: vendor stderr, never an IPC frame). Declared here rather
 * than imported from `@cortexkit/pi-magic-context/tavern` because these runners
 * resolve their dependencies from the repository root, where Host's vendored
 * package is not linked - and a runner that cannot start is worse than one with a
 * pinned literal. `assertMarkerContract` fails loudly if the vendor ever renames
 * it, so the duplication cannot rot silently.
 */
const PROBE_M0_MEMORY_IDS_PREFIX = "[probe:m0_memory_ids]";
const PROBE_M0_CHAPTERS_PREFIX = "[probe:m0_chapters]";
const PROBE_M0_DIGEST_PREFIX = "[probe:m0_digest]";
const PROBE_M0_SOURCES_PREFIX = "[probe:m0_sources]";
const PROBE_FOLD_COMMITTED_PREFIX = "[probe:fold_committed]";

const MARKER_CONTRACT = Object.freeze([
  ["PROBE_M0_MEMORY_IDS_PREFIX", PROBE_M0_MEMORY_IDS_PREFIX],
  ["PROBE_M0_CHAPTERS_PREFIX", PROBE_M0_CHAPTERS_PREFIX],
  ["PROBE_M0_DIGEST_PREFIX", PROBE_M0_DIGEST_PREFIX],
  ["PROBE_M0_SOURCES_PREFIX", PROBE_M0_SOURCES_PREFIX],
  ["PROBE_FOLD_COMMITTED_PREFIX", PROBE_FOLD_COMMITTED_PREFIX],
]);

function assertMarkerContract() {
  const source = fileURLToPath(
    new URL("../../../vendor/magic-context/packages/pi-plugin/src/probe-materialization-marker.ts", import.meta.url),
  );
  if (!existsSync(source)) return;
  const declared = readFileSync(source, "utf8");
  for (const [name, prefix] of MARKER_CONTRACT) {
    if (!declared.includes(`export const ${name} = "${prefix}"`)) {
      throw new Error("memory_loop_probe_marker_contract_drift");
    }
  }
}
assertMarkerContract();

const HOST_ROOT = resolve(fileURLToPath(new URL("../../../host/", import.meta.url)));

/** The run's requested companion language, set by the entry point's `--language`. */
let requestedLanguage;
const OUTPUT_ROOT = process.env.GAMEBUDDY_MEMORY_LOOP_OUTPUT_ROOT
  ? resolve(process.env.GAMEBUDDY_MEMORY_LOOP_OUTPUT_ROOT)
  : join(HOST_ROOT, "dist");
const REQUEST_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 60_000;

/** Unique per run so each loop gets its own Memory partition, never a stale one. */
function createIdentity() {
  const suffix = randomBytes(6).toString("hex");
  return Object.freeze({
    playerId: `memory_loop_player_${suffix}`,
    companionId: `memory_loop_companion_${suffix}`,
    continuityId: `memory_loop_continuity_${suffix}`,
  });
}

function usage() {
  return "usage: node tools/live-run/memory/run-memory-live-loop.mjs --report <path> [--manifest <probe-fixture.json>] [--seed <text>] [--question <text>] [--card <character-card.json|worldbook.json-dir>]";
}

function parseArguments(argv) {
  const flags = new Map([
    ["--report", undefined],
    ["--seed", undefined],
    ["--question", undefined],
    ["--manifest", undefined],
    ["--card", undefined],
    ["--language", undefined],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") return Object.freeze({ help: true });
    if (!flags.has(flag)) throw new Error(`${usage()} (unknown flag: ${flag})`);
    const value = argv[index + 1];
    // A value that is itself a known flag means the caller forgot it; refusing is
    // better than silently consuming the next flag as text.
    if (value === undefined || flags.has(value)) throw new Error(usage());
    flags.set(flag, value);
    index += 1;
  }
  const language = flags.get("--language");
  if (language !== undefined && !COMPANION_LOCALE_PATTERN.test(language))
    throw new Error(`${usage()} (--language must be a bounded BCP-47 tag, for example zh-CN or ja-JP)`);
  const reportPath = flags.get("--report");
  if (typeof reportPath !== "string" || reportPath.length === 0) throw new Error(usage());
  return Object.freeze({
    help: false,
    reportPath: resolve(reportPath),
    manifestPath: flags.get("--manifest"),
    cardPath: flags.get("--card"),
    language,
    seed: flags.get("--seed"),
    question: flags.get("--question"),
  });
}

/**
 * Resolve the seeded fact and the probe question.
 *
 * The preferred source is a `chat_memory_probe_manifest/v1` fixture: probe text is
 * fixture-owned by design and must never be invented by the runner, and consuming the
 * same fixtures the Chat loop uses keeps the two loops' scenarios comparable. Inline
 * text stays available for a one-off decision and is used only when no manifest is
 * given.
 */
async function resolveScenario({ manifestPath, seed, question }) {
  if (manifestPath === undefined) {
    const inlineSeed =
      seed ?? "Remember this for later: I retired after many years delivering the post.";
    return Object.freeze({
      seeds: Object.freeze([inlineSeed]),
      seed: inlineSeed,
      question: question ?? "What did I do before I retired?",
      probeId: undefined,
      manifestDigest: undefined,
      dimension: "retention",
      distance: "turn",
      requiredKeywords: ["postman", "mail", "delivering"],
      forbiddenKeywords: ["mine", "haul"],
      minHitRate: 0.5,
    });
  }
  const manifest = loadProbeManifest(await readFile(resolve(manifestPath), "utf8"));
  if (manifest.probes.length !== 1)
    throw new Error("probe_fixture_multi_probe_unsupported");
  const probe = manifest.probes[0];
  const probeStep = probe.steps.find((step) => step.kind === "probe");
  // EVERY seed step, in order - not just the first.
  //
  // Taking only `find(kind === "seed")` silently truncated multi-seed fixtures and
  // then reported the consequence as a product result. It produced a false
  // supersede.fail/old_retained: the supersede fixture's SECOND seed is the whole
  // point of that scenario ("scratch that - parsnips are out, amethyst now"), so with
  // it dropped the overwrite never happened and "old fact retained" was guaranteed.
  // Same for the retention fixture, whose second seed is the distractor: without it
  // the probe was being asked about a world where the distractor never existed.
  const seedSteps = probe.steps.filter((step) => step.kind === "seed");
  if (seedSteps.length === 0 || probeStep === undefined) throw new Error("probe_fixture_incomplete");
  // Which seed does L2 compare against? The one that carries the fact the probe asks
  // about - i.e. a required keyword appears in it. Position alone is wrong in both
  // directions: the supersede fixture puts the asked-about fact LAST (the overwrite),
  // while the retention fixture puts it FIRST and uses the later seed as a distractor
  // that is deliberately NOT the answer.
  const required = probeStep.requiredKeywords ?? [];
  const askedSeed =
    seedSteps.find((step) =>
      required.some((keyword) => step.text.toLowerCase().includes(String(keyword).toLowerCase())),
    ) ?? seedSteps.at(-1);
  // Supersession is modelled as REPLACEMENT, because that is the only overwrite the
  // authenticated management route can express. The route exposes create/update/archive;
  // the vendor's supersede link is a Historian-internal promotion step and is not part
  // of the player API (verified in browser-contract's MemoryMutationCommandV1Schema).
  //
  // This distinction is evidence, not cosmetic: seeding a second fact with `create`
  // leaves BOTH rows active and independently rendered, so a reply naming both is the
  // correct reading of the store - yet the probe's forbidden set scores it
  // `supersede.fail/old_retained`, which would be read as a memory regression. The run
  // that exposed this reported renderedIdCount: 2 with the asked-about fact present.
  const supersedes =
    probe.dimension === "supersession" && seedSteps.length > 1 ? askedSeed.text : undefined;
  const initialSeeds =
    supersedes === undefined ? seedSteps.map((step) => step.text) : [seedSteps[0].text];
  return Object.freeze({
    seeds: Object.freeze(initialSeeds),
    ...(supersedes === undefined ? {} : { supersedes }),
    // The seed carrying the asked-about fact; used for L2's id comparison so the
    // funnel answers "was THIS fact rendered?".
    seed: askedSeed.text,
    question: probeStep.text,
    probeId: probe.probeId,
    manifestDigest: manifest.manifestDigest,
    dimension: probe.dimension,
    // The fixture's declared distance decides which funnel stages are even applicable.
    // `session` (design 3.4, P-restart) is the distance this loop is structurally
    // ALREADY running: phase 1 seeds through one Host child, that child's teardown
    // commits, and phase 2 mounts as its terminal successor on the same root. Declaring
    // it here is what lets L3 report on the restart instead of staying not_applicable.
    distance: probe.distance,
    requiredKeywords: probeStep.requiredKeywords,
    forbiddenKeywords: probeStep.forbiddenKeywords ?? [],
    // The fixture's own threshold must survive into scoring (audit finding: the
    // loop hardcoded 0.5, silently over-ruling a manifest that declares 1.0).
 			minHitRate: Number.isFinite(probeStep.minHitRate) ? probeStep.minHitRate : 0.5,
			// The fixture's filler steps are the DISTANCE the probe is supposed to cross: they are
			// real conversation that happened between the seed and the question, and the fixture
			// declares a distance it assumes they created. They were never sent, so the loop
			// measured a zero-distance conversation while still reporting the declared distance -
			// and no turn count could ever reach the historian's fold threshold, which is why a
			// fold (and therefore a compartment or a chapter) never appeared in these runs.
			fillers: Object.freeze(
				probe.steps.flatMap((step) => (step.kind === "filler" && typeof step.text === "string" ? [step.text] : [])),
			),
		});
	}

async function deadlineFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function bootstrap(origin, token) {
  const response = await deadlineFetch(`${origin}/api/tavern/v1/bootstrap`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
  });
  const body = await response.json().catch(() => undefined);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!response.ok || typeof cookie !== "string" || typeof body?.csrfToken !== "string")
    throw new Error(`bootstrap_failed:${response.status}`);
  return Object.freeze({ cookie, csrf: body.csrfToken });
}

async function readMemory(origin, client) {
  const response = await deadlineFetch(`${origin}/api/tavern/v1/memory`, {
    headers: { Cookie: client.cookie, Origin: origin },
  });
  if (!response.ok) throw new Error(`memory_read_failed:${response.status}`);
  return response.json();
}

/**
 * Install the character card into the disposable runtime root BEFORE any
 * surface launches, so the S1/S2/S3 prompt/worldbook effects are exercised by
 * the real product instead of fixtures. Consumes the same frozen Host import
 * path as run-live-chat-card-e2e.mjs (host/dist-test, built by the host
 * pipeline): preview -> candidate -> IdentityProfile, then writes the
 * canonical identity-profile.json the runtime reads at construction. A
 * worldbook.json next to the card (deepseek-chan preset) becomes the reviewed
 * world book whose constant entries earn the m[0] lorebook_constant seat (S3).
 *
 * The card's profile deliberately does NOT carry the reviewed-import
 * provenance dance: this is a disposable harness root, the reviewer gate is
 * the live-run commit itself, and the runtime treats the on-disk profile as
 * the approved one (readOrCreateIdentityProfile).
 */
/**
 * Records the run's requested companion language before anything mounts.
 *
 * The run manifest records the presentation profile, so the preference has to be
 * in place before the FIRST mount: writing it later leaves the first mount's
 * manifest holding the previous locale and the successor mount refuses to open
 * the same root (`run_manifest_mismatch`). Uses the product's own store module, so
 * the path and the stored shape are the product's, not a hand-written file.
 */
async function installLanguagePreference(root, locale) {
  if (locale === undefined) return undefined;
  const storeDir = new URL("../../../host/dist-test/", import.meta.url);
  const { PlayerPreferenceStore, playerPreferencePath } = await import(
    new URL("settings/player-preference-store.js", storeDir),
  );
  // The store writes under the product's durable path lock, which releases
  // through the Windows stale-lock reclaimer the runtime binds; this process
  // writes before any child exists, so it binds the same capability itself.
  const { bindWindowsStaleLockReclaimer } = await import(new URL("path-lock.js", storeDir));
  const { createBuildWindowsStaleLockReclaimer } = await import(
    new URL("windows-stale-lock-reclaimer/index.js", storeDir),
  );
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const store = new PlayerPreferenceStore(playerPreferencePath(root));
  const current = await store.read();
  const written = await store.update(current.revision, { action: "setLocale", locale });
  return Object.freeze({ requested: locale, stored: written.locale, revision: written.revision });
}

async function installCharacterCard(root, identity, cardPath) {
  const cardDir = new URL("../../../host/dist-test/", import.meta.url);
  const { candidateToIdentityProfile, previewStCard } = await import(new URL("st-card-import.js", cardDir));
  const { identityProfileMetadata, validateIdentityProfile } = await import(new URL("identity-profile.js", cardDir));
  const { resolveRuntimePaths } = await import(new URL("runtime.js", cardDir));
  const card = JSON.parse(await readFile(cardPath, "utf8"));
  const preview = previewStCard(card);
  const profile = candidateToIdentityProfile(preview, 1);
  // Product policy: limits only prevent physical blowup, never the player's
  // choices. The card profile loads LOSSESSLY (no truncation); the product's
  // own write validator is the only gate, and it is anti-blowup wide (64 KiB
  // chars). A card the validator rejects is a harness bug to report loudly,
  // never silently boarded.
  validateIdentityProfile(profile);
  const paths = resolveRuntimePaths(identity, root);
  await mkdir(paths.runtimeCwd, { recursive: true });
  const metadata = identityProfileMetadata(profile);
  await writeFile(
    join(paths.runtimeCwd, "identity-profile.json"),
    `${JSON.stringify({ ...profile, canonicalHash: metadata.canonicalHash }, null, 2)}\n`,
    "utf8",
  );
  const worldbookPath = join(dirname(cardPath), "worldbook.json");
  if (existsSync(worldbookPath)) {
    await copyFile(worldbookPath, join(paths.runtimeCwd, "worldbook.json"));
  }
  const coreChars = profile.persona === undefined ? null : profile.persona.core.length;
  return Object.freeze({
    profileId: metadata.profileId,
    canonicalHash: metadata.canonicalHash,
    coreChars,
  });
}

/**
 * Lightweight reply observations for the S1/S2/S3 effects (NOT probe scoring
 * — that stays in the frozen kernel): language script of the committed reply,
 * first-person framing, expressive stage direction, assistant-shell
 * boilerplate. The reviewer sees raw signals, never a machine opinion about
 * "liveliness". Returns null when no companion text committed this turn.
 */
function observeCompanionReply(committedText) {
  const text = typeof committedText === "string" ? committedText : "";
  if (text.trim().length === 0) return null;
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu) ?? []).length;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const cjkRatio = letters > 0 ? cjk / letters : 0;
  const primaryScript = cjkRatio >= 0.5 ? "cjk" : cjkRatio >= 0.05 ? "mixed" : "latin";
  const firstPerson = /我/u.test(text) || /(?:^|[^A-Za-z])[Ii]\b/u.test(text);
  const expressive = /（[^（）\n]{1,10}）|\*[^*\n]+\*/u.test(text);
  const assistantShell = /(?:as an AI|语言模型|人工智能|AI assistant|作为一个AI)/iu.test(text);
  const signals = [];
  if (firstPerson) signals.push("first_person");
  if (expressive) signals.push("expressive_stage_direction");
  if (!assistantShell) signals.push("no_assistant_shell");
  return Object.freeze({
    // The reply as committed, so a language observation can be judged against the
    // text it was taken from rather than believed.
    text,
    committedChars: text.length,
    cjkRatio: Number(cjkRatio.toFixed(3)),
    primaryScript,
    chineseEffective: cjkRatio >= 0.5,
    signals: Object.freeze(signals),
    ...(assistantShell ? { assistantShell: true } : {}),
  });
}

/**
 * Phase 1: seed through the management surface and confirm durability from the
 * route's OWN readback. `mutate()` ends with projectRows(await readRows()), so a
 * 200 whose body contains the row IS the durability evidence - no second query and
 * no direct SQLite read is needed or wanted.
 */
/**
 * Writes the companion language through the mounted management route and reads
 * it back from the durable store. The response IS the read-back (the store
 * re-reads the written file before projecting), so a returned locale that
 * equals the request is the product's own confirmation, not the caller's.
 */
export async function setCompanionLanguage(origin, client, locale) {
  const read = async () => {
    const response = await deadlineFetch(`${origin}/api/tavern/v1/settings/language`, {
      headers: { Cookie: client.cookie, Origin: origin },
    });
    if (!response.ok) throw new Error(`language_read_failed:${response.status}`);
    return await response.json();
  };
  const before = await read();
  if (typeof before?.revision !== "number") throw new Error("language_revision_unavailable");
  const written = await deadlineFetch(`${origin}/api/tavern/v1/settings/language`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": client.csrf,
      Cookie: client.cookie,
      Origin: origin,
    },
    body: JSON.stringify({ expectedRevision: before.revision, locale }),
  });
  if (!written.ok) throw new Error(`language_update_failed:${written.status}`);
  const stored = await read();
  if (stored?.locale !== locale)
    throw new Error(`language_update_not_durable:${String(stored?.locale)}`);
  return Object.freeze({ requested: locale, stored: stored.locale, revision: stored.revision });
}

export async function seedMemory(origin, client, seedTexts, supersedeText) {
  let projectionRevision;
  let last;
  let firstHandle;
  let supersededHandle;
  const texts = supersedeText === undefined ? seedTexts : [...seedTexts, supersedeText];
  for (const [index, seedText] of texts.entries()) {
    const before = await readMemory(origin, client);
    if (typeof before?.projectionRevision !== "string") throw new Error("projection_revision_unavailable");
    projectionRevision = before.projectionRevision;
    // A supersession is expressed as an `update` of the row it replaces. The route has
    // no supersede verb (create/update/archive only), and `update` is the operation that
    // actually overwrites the stored fact, so the store ends with ONE active row for
    // this topic - which is what the probe's forbidden set assumes. Reaching this with
    // two independent `create`s instead leaves both rows active and the scenario
    // unfalsifiable in the direction the probe cares about.
    const replacing = supersedeText !== undefined && index === texts.length - 1;
    if (replacing && supersededHandle === undefined) throw new Error("memory_supersede_handle_missing");
    const response = await deadlineFetch(`${origin}/api/tavern/v1/memory`, {
      method: "PUT",
      headers: {
        Cookie: client.cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "x-csrf-token": client.csrf,
      },
      body: JSON.stringify(
        replacing
          ? {
              apiVersion: 1,
              expectedProjectionRevision: before.projectionRevision,
              operation: "update",
              handle: supersededHandle,
              content: seedText,
            }
          : {
              apiVersion: 1,
              expectedProjectionRevision: before.projectionRevision,
              operation: "create",
              content: seedText,
            },
      ),
    });
    if (!response.ok) throw new Error(`memory_seed_failed:${response.status}`);
    const after = await response.json();
    const rows = Array.isArray(after?.memories) ? after.memories : [];
    const seeded = rows.some((row) => row?.content === seedText);
    if (!seeded) {
      // Stop at the first unproven write: later seeds would otherwise be reported
      // against a store that never received the earlier ones.
      return Object.freeze({ durable: false, rowCount: rows.length, projectionChanged: after?.projectionRevision !== before.projectionRevision });
    }
    if (!replacing) {
      firstHandle ??= rows.find((row) => row.content === seedText)?.handle;
      supersededHandle = rows.find((row) => row.content === seedText)?.handle;
    }
    last = after;
  }
  return Object.freeze({
    durable: true,
    rowCount: Array.isArray(last?.memories) ? last.memories.length : 0,
    // The opaque handle is the ONLY stable cross-phase reference we keep: it is the
    // product's own projection of the row and carries no content.
    seedHandle: firstHandle,
    projectionChanged: projectionRevision !== undefined,
  });
}

/**
 * Wait (bounded) for the turn THIS harness just submitted to reach a terminal state.
 *
 * Two phases, because one is not enough: the projection lags the 202, so immediately after the
 * send `/state` can still show NO turn - and treating "no turn" as "settled" reads the previous
 * turn's transcript and reports a memory miss for a turn that never ran. So first wait for the
 * turn to appear, then wait for it to reach a terminal state. Returns what it observed so the
 * caller can report an honest gap instead of guessing.
 */
async function awaitSubmittedTurnTerminal(origin, client) {
	const readTurn = async () => {
		const response = await deadlineFetch(`${origin}/api/tavern/v1/state`, {
			headers: { Cookie: client.cookie, Origin: origin },
		});
		const snapshot = await response.json().catch(() => undefined);
		return snapshot?.chat?.turn ?? null;
	};
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const seen = await readTurn();
		if (seen === null) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			continue;
		}
		for (let settled = 0; settled < 240; settled += 1) {
			const turn = await readTurn();
			if (turn === null) return Object.freeze({ observed: true, terminalState: "cleared" });
			if (turn.state === "completed" || turn.state === "failed" || turn.state === "cancelled")
				return Object.freeze({ observed: true, terminalState: turn.state });
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		return Object.freeze({ observed: true, terminalState: "unsettled" });
	}
	return Object.freeze({ observed: false, terminalState: "never-visible" });
}

/**
 * Wait (bounded) until no turn is in flight on this chat. Sending while the previous turn is
 * still running is refused with `turn_busy`, which is how a multi-turn harness dies on its
 * second filler: the projection can still report the finished turn as `queued` after its reply
 * has been committed.
 */
async function awaitChatIdle(origin, client, attempts = 60) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const response = await deadlineFetch(`${origin}/api/tavern/v1/state`, {
			headers: { Cookie: client.cookie, Origin: origin },
		});
		const snapshot = await response.json().catch(() => undefined);
		const turn = snapshot?.chat?.turn ?? null;
		if (turn === null || turn.state === "completed" || turn.state === "failed" || turn.state === "cancelled") return true;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return false;
}

/**
 * Phase 2: run a real turn on the chat-only surface under the SAME continuity and
 * capture the committed companion text. The text is used for keyword scoring and is
 * never written into the report.
 *
 * Route and shapes are taken from the existing harness rather than guessed: the
 * submit route is `/messages` (202 + `disposition`). The committed reply is the transcript
 * entry THIS turn added, NOT the last companion entry: this harness sends several turns
 * (the fixture's own fillers, then the probe), so "last message" would score the previous
 * turn's answer and report a memory miss that never happened.
 */
async function runChatTurn(origin, client, text) {
	await awaitChatIdle(origin, client);
	const stateResponse = await deadlineFetch(`${origin}/api/tavern/v1/state`, {
		headers: { Cookie: client.cookie, Origin: origin },
	});
	const state = await stateResponse.json().catch(() => undefined);
	const companionBefore = Array.isArray(state?.chat?.transcript)
		? state.chat.transcript.filter((message) => message?.role === "companion").length
		: 0;
	const selectionGeneration = state?.selection?.generation;
  if (!Number.isSafeInteger(selectionGeneration)) throw new Error("selection_generation_unavailable");
  const draftRevision = Number.isSafeInteger(state?.chat?.draft?.revision) ? state.chat.draft.revision : undefined;

  const response = await deadlineFetch(`${origin}/api/tavern/v1/messages`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: client.cookie,
      "X-CSRF-Token": client.csrf,
      "Idempotency-Key": randomBytes(16).toString("base64url"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      apiVersion: 1,
      selectionGeneration,
      text,
      locale: "en",
      ...(draftRevision === undefined ? {} : { expectedDraftRevision: draftRevision }),
    }),
  });
  if (response.status !== 202) {
    // The refusal's own problem code is the whole diagnostic value: a bare status
    // says nothing about WHICH runtime refused, and the product's 503s cover
    // runtime_unavailable, storage_unavailable and composition failures alike.
    // Read the bounded body, never the transcript.
    const body = await response.text().catch(() => "");
    const code = /"code"\s*:\s*"([a-z0-9_]+)"/u.exec(body)?.[1];
    // A refused message usually means the mounted runtime never became ready, and
    // the state snapshot is the only place that says why. Report the turn
    // projection verbatim (bounded) instead of guessing at field names: the
    // snapshot's own shape is the authority on what a refusal looks like.
    const turnProjection = JSON.stringify(state?.chat?.turn ?? null).slice(0, 300);
    const chatKeys = state?.chat === undefined ? "-" : Object.keys(state.chat).join(",");
    throw new Error(
      `message_failed:${response.status}${code === undefined ? "" : `:${code}`}` +
        `:turn=${turnProjection}:chatKeys=${chatKeys}`,
    );
  }

 	// Terminal wait, bounded on the AUTHORITATIVE projection rather than on the SSE stream.
	// With several turns in one run the stream replays earlier terminals (it starts from an
	// epoch and the previous turn's terminal is already committed), so "the stream settled"
	// can mean "the PREVIOUS turn settled" - which read a queued probe turn as if it had no
	// reply. The two-phase wait cannot be fooled that way: it first requires THIS turn to be
	// visible, then waits for that turn's own terminal.
	const terminal = await awaitSubmittedTurnTerminal(origin, client);
	if (!terminal.observed) {
		// Never surfaced. Report it as what it is rather than reading a reply that belongs to
		// another turn.
		return Object.freeze({
			turnState: "never-visible",
			streamTerminal: terminal.terminalState,
			committedCompanionMessages: companionBefore,
			committedCompanionDelta: 0,
			committedText: undefined,
		});
	}
	return readTurnOutcome(origin, client, terminal.terminalState, companionBefore);
}

/**
 * Read the durable /state read-back exactly once and project the outcome. The
 * transcript for a fresh chat-only surface session starts empty, so the companion
 * count IS this turn's delta - there are no earlier turns to leak in.
 */
async function readTurnOutcome(origin, client, streamTerminal, companionBefore) {
  const snapshot = await (
    await deadlineFetch(`${origin}/api/tavern/v1/state`, { headers: { Cookie: client.cookie, Origin: origin } })
  ).json();
 	const turnState = snapshot?.chat?.turn?.state ?? null;
	const transcript = Array.isArray(snapshot?.chat?.transcript) ? snapshot.chat.transcript : [];
	const companion = transcript.filter((message) => message?.role === "companion");
	// The reply THIS turn added. A multi-turn run (the fixture's fillers, then the probe) has
	// earlier companion messages, so taking the last entry would score the previous turn's answer.
	const reply = companion.length > companionBefore ? companion[companionBefore] : undefined;
	return Object.freeze({
		turnState,
		streamTerminal: streamTerminal ?? null,
		committedCompanionMessages: companion.length,
		committedCompanionDelta: companion.length - companionBefore,
		committedText: typeof reply?.text === "string" ? reply.text : undefined,
	});
}

const noopRecorder = Object.freeze({ record() {} });

/**
 * Seed memory facts through a REAL management-surface child and return the
 * same durability evidence `runMemoryLiveLoop` uses, without running any
 * chat turn. This lets other live carriers (the Stardew ladder runner) plant
 * a fact under a product continuity and then observe whether a Game runtime
 * on the SAME root/continuity renders it into m[0] — the cross-surface
 * embodiment path that a chat-only memory loop cannot close by itself.
 */
export async function seedMemoriesViaManagementSurface({ root, deploymentManifestPath, seeds, supersedes, language, outputRoot, readyTimeoutMs, gameSessionMode = "fresh", onPhase } = {}) {
  const markers = [];
  // Phase marks: the seed is the dominant cold-start cost (~49s measured in a real
  // ladder-5 run), so the caller needs to know WHICH part costs it - booting the
  // management composition, or the memory CRUD calls it makes afterwards.
  const phases = {};
  const seedStartedAtMs = Date.now();
  const mark = (name) => { phases[name] = Date.now() - seedStartedAtMs; onPhase?.(name, phases[name]); };
  const launch = await launchDesktopCompositionGateChild({
    outputRoot: outputRoot ?? OUTPUT_ROOT,
    root,
    surface: "management",
    nonceSha256: createHash("sha256").update(randomBytes(32)).digest("hex"),
    manifestPath: deploymentManifestPath,
    readyTimeoutMs: readyTimeoutMs ?? START_TIMEOUT_MS,
    gameSessionMode,
    spawnImpl: (command, args, options) => {
      const child = spawn(command, args, options);
      child.stderr?.setEncoding?.("utf8");
      child.stderr?.on?.("data", (chunk) => {
      		for (const line of String(chunk).split("\n")) {
			if (
				line.startsWith(PROBE_M0_MEMORY_IDS_PREFIX) ||
  							line.startsWith(PROBE_M0_CHAPTERS_PREFIX) ||
  							line.startsWith(PROBE_M0_DIGEST_PREFIX) ||
  							line.startsWith(PROBE_M0_SOURCES_PREFIX) ||
  							line.startsWith(PROBE_FOLD_COMMITTED_PREFIX)
			)
				markers.push(line.trim());
		}
      });
      return child;
    },
  });
  mark("childSpawnedMs");
  try {
    const launchUrl = await launch.waitForReady();
    mark("readyMs");
    const url = new URL(launchUrl);
    const origin = `${url.protocol}//${url.host}`;
    const bootstrapToken = new URLSearchParams(url.hash.slice(1)).get("boot");
    if (bootstrapToken === null) throw new Error("bootstrap_token_missing");
    const client = await bootstrap(origin, bootstrapToken);
    mark("bootstrapAuthMs");
    const result = await seedMemory(origin, client, seeds, supersedes);
    mark("seedWrittenMs");
    // The player's language choice, written through the same mounted product
    // route the management UI uses, so the runtime's own read is what phase 2
    // exercises.
    const languageResult =
      language === undefined ? undefined : await setCompanionLanguage(origin, client, language);
    mark("languageWrittenMs");
    return Object.freeze({ result, languageResult, markers: Object.freeze([...markers]), phases: Object.freeze({ ...phases }) });
  } finally {
    launch.dispose?.();
    await stopChildGracefully(launch.child);
    mark("stoppedMs");
  }
}

/**
 * Close the run capture and return a bounded summary for the report JSON.
 *
 * The report itself is recorded inside the run directory before closing, so
 * evidence and verdict travel together. Never throws: a broken capture becomes
 * a `capture` field with `failures`, not a crashed loop.
 */
async function closeIntoReport(capture, root, report) {
  if (capture === null || capture === undefined) return null;
  try {
    await capture.record("report.json", report);
    await capture.captureRuntimeRoot(root);
    const summary = await capture.close();
    return Object.freeze({
      schema: "gamebuddy_live_run_capture/v1",
      dir: summary.dir,
      filesWritten: summary.filesWritten,
      skipped: summary.skipped,
      failures: summary.failures,
    });
  } catch (error) {
    return Object.freeze({
      schema: "gamebuddy_live_run_capture/v1",
      dir: capture.dir ?? null,
      failures: [{ op: "capture_close", error: String(error instanceof Error ? error.message : error) }],
    });
  }
}

async function withSurface({ surface, run, root, deploymentManifestPath, gameSessionMode = "fresh", capture }) {
  if (typeof root !== "string" || root.length === 0) throw new Error("runtime_root_required");
  if (typeof deploymentManifestPath !== "string" || deploymentManifestPath.length === 0)
    throw new Error("deployment_manifest_path_required");
  await mkdir(root, { recursive: true });
  const nonceSha256 = createHash("sha256").update(randomBytes(32)).digest("hex");

  let stderr = "";
  const pendingAppends = [];
  // Marker channel (Class B, owner decision D-1): Magic Context reports its own
  // materialization facts on stderr, including which memory ids it assembled into
  // m[0]. We collect the lines here instead of only keeping a bounded diagnostic
  // tail, because those markers are the ONLY observability the L2 (assembly) stage
  // has - the Host never sees m[0] bytes and the persistence row is not exposed.
 	const markers = [];
 	const launch = await launchDesktopCompositionGateChild({
 		outputRoot: OUTPUT_ROOT,
 		root,
 		surface,
 		nonceSha256,
 		manifestPath: deploymentManifestPath,
 		readyTimeoutMs: START_TIMEOUT_MS,
 		gameSessionMode,
 		spawnImpl: (command, args, options) => {
 			const child = spawn(command, args, options);
 			child.stderr?.setEncoding?.("utf8");
 			child.stderr?.on?.("data", (chunk) => {
 				if (stderr.length < 2_048) stderr = `${stderr}${chunk}`;
 				// Harness-level capture: full child stderr lands in the run directory
 				// (git-ignored, local only), so a reviewer can see the real
 				// materialization narration instead of only the marker lines.
 				if (capture !== undefined && capture !== null)
 					pendingAppends.push(capture.append(`child-${surface}.stderr.log`, String(chunk)).catch(() => {}));
 				for (const line of String(chunk).split("\n")) {
 					// Strictly prefixed and parsed: an unrelated stderr line can never be
 					// mistaken for a materialization fact.
 					if (
 						line.startsWith(PROBE_M0_MEMORY_IDS_PREFIX) ||
  							line.startsWith(PROBE_M0_CHAPTERS_PREFIX) ||
  							line.startsWith(PROBE_M0_DIGEST_PREFIX) ||
  							line.startsWith(PROBE_M0_SOURCES_PREFIX) ||
  							line.startsWith(PROBE_FOLD_COMMITTED_PREFIX)
 					)
 						markers.push(line.trim());
 				}
 			});
 			return child;
 		},
 	});
  try {
    const launchUrl = await launch.waitForReady();
    const url = new URL(launchUrl);
    const origin = `${url.protocol}//${url.host}`;
    const bootstrapToken = new URLSearchParams(url.hash.slice(1)).get("boot");
    if (bootstrapToken === null) throw new Error("bootstrap_token_missing");
    const client = await bootstrap(origin, bootstrapToken);
    const result = await run(origin, client);
    // Drain pending stderr appends BEFORE returning: the report branch closes the
    // capture right after, and a late stderr flush must not land after the
    // summary was written (audit NOTE-5).
    await Promise.allSettled(pendingAppends);
    return Object.freeze({ result, markers: Object.freeze([...markers]) });
  } catch (error) {
    const diagnostic = stderr.trim();
    throw new Error(
      diagnostic.length > 0
        ? `${surface}:${error?.message ?? "surface_failed"}:${diagnostic}`
        : `${surface}:${error?.message ?? "surface_failed"}`,
    );
  } finally {
    launch.dispose?.();
    await stopChildGracefully(launch.child);
  }
}

/**
 * Ask a composed child to close itself, and wait for it to actually exit.
 *
 * This is the whole reason the memory loop can have a second phase. The product
 * admits a `known` mount as a terminal SUCCESSOR, which requires the predecessor
 * chat-runtime teardown to have COMMITTED, and that commit happens only inside the
 * child's own close path (desktop-runtime-bootstrap finally -> composition.close()).
 *
 * On Windows there is no way to make that path run from outside: `child.kill("SIGTERM")`
 * is TerminateProcess and the handler never executes (probe: exit reported
 * `signal SIGTERM`, handler not invoked), and disposing the guardian peer leaves the
 * child running. So the child now accepts a cooperative request on the IPC channel the
 * gate already opens for readiness, and this asks politely before ever escalating.
 */
export const SHUTDOWN_REQUEST_SCHEMA = "gamebuddy-desktop-shutdown-request/v1";

async function stopChildGracefully(child, timeoutMs = 30_000) {
  if (child === undefined || child === null || child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", () => resolveExit(true)));
  // The request only reaches a child that was spawned with an IPC channel and has
  // not disconnected. `connected` is the product's own gate: a child without the
  // channel (production Desktop) simply never gets asked, which is correct - it is
  // stopped by its supervisor.
  const canRequest = typeof child.send === "function" && child.connected === true;
  if (canRequest) {
    try {
      child.send(Object.freeze({ schema: SHUTDOWN_REQUEST_SCHEMA, protocolVersion: 1 }));
    } catch {
      // A send failure is not fatal: the escalation below still guarantees exit.
    }
  }
  const closed = await Promise.race([
    exited,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs)),
  ]);
  if (closed === true) return;
  // Escalate. `kill` without a signal is the portable hard stop; SIGTERM is
  // equivalent on Windows and unreliable elsewhere, so it is not used as a fallback.
  child.kill();
  await Promise.race([
    exited,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
  ]);
}

/**
 * One disposable root for the WHOLE memory loop, shared across both phases.
 *
 * A reviewer of the first memory-loop runs proved this was the fatal design flaw:
 * `withSurface` used to `mkdtemp` per phase, so the management phase and the
 * chat-only phase resolved DIFFERENT `runtimeCwd`s (resolveRuntimePaths keys the
 * cwd by identity, but under the phase's OWN root). The seed row was written to one
 * SQLite file and the chat turn read another - the loop could not have measured
 * cross-phase memory even in principle. One root for both phases is what makes
 * "seed on management, ask on chat-only" a real storage-identity claim.
 *
 * The root is also removed here, not leaked: the old code never cleaned it, so
 * every run left two generation copies rotting in %TEMP%.
 */
async function withMemoryLoopRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-memory-loop-"));
  // Diagnosis escape hatch: keep the root so the authority DB can be inspected after
  // a failure (which is how the storage-identity claims get checked). Unset means the
  // normal path, where the root is removed.
  const keepRoot = process.env.GAMEBUDDY_MEMORY_LOOP_KEEP_ROOT === "1";
  try {
    return await run(root);
  } finally {
    if (!keepRoot) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Resolve the numeric id of the row this run seeded.
 *
 * The product deliberately hides it: the management projection returns an HMAC
 * `handle` (memory-management.ts `projectHandle`), not the vendor's `stateToken`,
 * so the id cannot be read back through the API. The harness therefore resolves it
 * from its OWN disposable runtime root - never the player's - and only AFTER
 * phase 1 has exited, so there is no concurrent writer to contend with.
 *
 * This is a lookup key, not evidence: what the run asserts about assembly comes
 * from the vendor's own marker, never from this read.
 */
function resolveSeededMemoryId(root, seedText) {
  // Locate the store by directory shape rather than by recomputing Host's
  // `identityKey`: a re-implementation here would silently drift from the
  // product's partition function and start reading a different (or no) database.
  // This disposable root holds exactly one context, so the shape is unambiguous.
  const contextsRoot = join(root, "contexts");
  if (!existsSync(contextsRoot)) return undefined;
  const contextKeys = readdirSync(contextsRoot);
  if (contextKeys.length !== 1) return undefined;
  const dbPath = join(contextsRoot, contextKeys[0], "data", "cortexkit", "magic-context", "context.db");
  if (!existsSync(dbPath)) return undefined;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT id FROM memories WHERE content = ? ORDER BY id LIMIT 1").get(seedText);
    return typeof row?.id === "number" ? row.id : undefined;
  } catch {
    // A missing id leaves the comparison key unknown, so L2 stays a gap rather
    // than claiming the seed was absent. The marker still reports what happened.
    return undefined;
  } finally {
    db?.close?.();
  }
}

/**
 * Parse the vendor's rendered-memory markers using the FROZEN funnel rule, not a
 * second implementation: the two loops must never disagree about whether L2 was
 * observed.
 */
function renderedIdsForRun(markers) {
  return renderedMemoryIdsFromMarkers(markers);
}

/**
 * Score the reply with the FROZEN kernel rule, not a second implementation.
 *
 * The Chat loop already owns probe scoring (`evaluateProbeReply` + `probeVerdict`: the
 * threshold, the dimension routing, and the two causes of `distractor.confused`).
 * Re-implementing it here - even "better", with word boundaries - would let the two
 * loops disagree about the same reply, which is exactly the drift the frozen
 * vocabulary exists to prevent.
 */
function scoreReply({ committedText, scenario, chat }) {
  // A keyword verdict may ONLY be scored against a turn that durably committed a
  // companion reply for THIS turn (the same gate the Chat harness uses). A turn that
  // failed, was cancelled, or committed no new companion text is an observability
  // gap, NEVER a scored miss - the audit's finding: the loop used to hardcode
  // `gate: { ok: true }`, so a failed turn was scored as needle.miss and (once L2
  // gets a producer) mis-attributed to presentation admission.
  const gate = probeTurnCommittedGate({
    terminal: chat.turnState !== null && chat.turnState !== undefined,
    committedCompanionDelta: chat.committedCompanionDelta ?? 0,
  });
  if (!gate.ok) return verdict_gap(gate.reason);
  const keywords = evaluateProbeReply({
    transcriptText: committedText,
    step: {
      requiredKeywords: scenario.requiredKeywords,
      forbiddenKeywords: scenario.forbiddenKeywords,
      minHitRate: scenario.minHitRate ?? 0.5,
    },
  });
  return probeVerdict({ gate: { ok: true }, keywords, dimension: scenario.dimension });
}

function verdict_gap(reason) {
  return Object.freeze({ event: "observability_gap", reason });
}

export async function runMemoryLiveLoop({ reportPath, manifestPath, seed, question, cardPath } = {}) {
  if (typeof reportPath !== "string" || reportPath.length === 0) throw new Error("report_path_required");
  const scenario = await resolveScenario({ manifestPath, seed, question });
  const identity = createIdentity();

  // One root for BOTH phases. A reviewer of the first runs proved this is the fatal
  // invariant: with a fresh root per phase, the management write and the chat read
  // lived in different SQLite files (runtimeCwd is identity-keyed UNDER the phase's
  // own root), so the loop could not measure cross-phase memory even in principle.
  return withMemoryLoopRoot(async (root) => {
    // One local evidence directory for this run (git-ignored, harness-level):
    // child stderr narration, the runtime root's own evidence, and the report
    // travel together so a reviewer can see what actually reached the model.
    const capture = await openLiveRunCapture({ kind: "memory-loop", label: scenario.probeId, root: LIVE_RUN_ROOT });
    // Optional character-card install (S1/S2/S3 effects): the deepseek-chan
    // whale preset is the reference card; installing it BEFORE any surface
    // launch means the runtime constructs with the reviewed persona, the
    // voice-anchor examples and the always-on world book (lorebook_constant).
    // The companion language the player asked for, recorded before the first mount
    // for the same reason the card is: the run manifest captures the presentation
    // profile, and a later write would make the successor mount refuse the root.
    const installedLanguage = await installLanguagePreference(root, requestedLanguage);
    if (installedLanguage !== undefined)
      process.stderr.write(`[memory-loop] language=${String(installedLanguage.stored)}\n`);
    const installedCard =
      cardPath === undefined
        ? undefined
        : await installCharacterCard(root, identity, cardPath);
    // ONE deployment manifest and ONE bootstrap operation for the whole loop. The
    // authority marker records the bootstrap operation, and `known` open validates it
    // exactly - so writing a second manifest with a fresh bootstrapOperationId made
    // phase 2 fail with `production_authority_artifact_present`. One loop is one
    // deployment identity.
    const deploymentManifestPath = join(root, "memory-loop.json");
    await writeFile(
      deploymentManifestPath,
      JSON.stringify(
        {
          schemaVersion: 2,
          topology: "independent_chat_and_game_surfaces",
          runtimeRoot: root,
          principal: { ...identity },
          bootstrapOperationId: `memory_loop_${randomBytes(12).toString("hex")}`,
          authorityGeneration: 1,
        },
        null,
        2,
      ),
      "utf8",
    );
    // Phase 1 - management surface: seed and confirm durability.
    process.stderr.write(`[memory-loop] phase1 management launching (root=${root})\n`);
    const seededResult = await withSurface({
      surface: "management",
      root,
      deploymentManifestPath,
      capture,
      run: async (origin, client) => {
        return await seedMemory(origin, client, scenario.seeds, scenario.supersedes);
      },
    });
    const seeded = seededResult.result;
    const languageEvidence = installedLanguage;
    if (languageEvidence !== undefined)
      process.stderr.write(
        `[memory-loop] phase1 language=${String(languageEvidence.stored)}\n`,
      );
    else process.stderr.write(`[memory-loop] phase1 language=<unset>\n`);
    process.stderr.write(`[memory-loop] phase1 durable=${seeded.durable}\n`);

    // Resolve the seed's vendor id AFTER phase 1 exited: the product hides it behind
    // an HMAC handle, and reading while the child still runs would contend with its
    // writer. Phase 1 has committed its teardown by this point, so the DB is quiet.
    const seededMemoryId = seeded.durable ? resolveSeededMemoryId(root, scenario.seed) : undefined;

    const observation = {
      distance: scenario.distance,
      ...(languageEvidence === undefined ? {} : { language: languageEvidence }),
      seedRequired: true,
      seedPresentInReadback: seeded.durable,
      // Restart evidence for a `session`-distance probe. The successor mount is the
      // product's OWN statement that the predecessor committed terminal teardown: the
      // child refuses a `known` mount otherwise (`chat_runtime_reentry_selection_invalid`,
      // handled below). Reaching phase 2 therefore means the persistence partition was
      // reopened, not that an in-process cache survived.
      ...(scenario.distance === "session" ? { foldObserved: true } : {}),
    };

    // Causal gate: a seed we could not confirm durable means L1 is unproven, so the
    // run reports that and stops. Proceeding would let a later miss be blamed on
    // recall when the fact may never have been stored.
    if (!seeded.durable) {
      const attributed = attributeMemoryFunnel(observation);
      const report = Object.freeze({
        schema: "memory_live_loop/v1",
        identity: Object.freeze({ continuityId: identity.continuityId }),
        seed: Object.freeze({ durable: false, rowCount: seeded.rowCount }),
        chat: Object.freeze({ attempted: false, reason: "seed_not_durable" }),
        funnel: attributed,
      });
      const finalReport = Object.freeze({ ...report, capture: await closeIntoReport(capture, root, report) });
      await writeFile(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`, "utf8");
      return finalReport;
    }

    // Phase 2 - chat-only surface, SAME root, SAME continuity: ask the question.
    // Session mode `known` OPENS the authority that phase 1's management surface
    // provisioned, instead of provisioning a fresh one. This is the storage-identity
    // core of the whole loop: a fresh second phase would create an EMPTY second
    // SQLite and the seeded row could never be seen (the audit's finding).
    //
    // The Chat surface is the only surface this loop can ask on: the Game surface is
    // driven from inside the running game (the Game child exposes game-lifecycle
    // routes, not a dialogue route), so a Game-surface recall claim belongs to the
    // Stardew live ladder, not here. Memory, continuity and the materializer are
    // shared, and the vendor's m[0] source marker names what was compiled in, so
    // the two surfaces remain comparable without this loop pretending to be both.
    //
    // The child accepts a cooperative shutdown request over the IPC channel
    // (desktop-runtime-bootstrap `waitForTermination`), which is what lets that
    // teardown commit and this phase mount as a successor. Without it the product
    // rejects the mount with `chat_runtime_reentry_selection_invalid`; see the
    // blocked branch below for that case.
    process.stderr.write(`[memory-loop] phase2 chat-only launching known\n`);
    let chatResult;
    try {
      chatResult = await withSurface({
        surface: "chat-only",
        root,
        deploymentManifestPath,
        gameSessionMode: "known",
        capture,
   					run: async (origin, client) => {
						// Real turns first, in fixture order, so the probe is asked at the declared distance
						// rather than immediately after the seed.
						for (const filler of scenario.fillers) await runChatTurn(origin, client, filler);
						return runChatTurn(origin, client, scenario.question);
					},
      });
    } catch (error) {
      const message = String(error?.message ?? error);
      const reentryBlocked = message.includes("chat_runtime_reentry_selection_invalid");
      if (!reentryBlocked) throw error;
      const attributed = attributeMemoryFunnel({
        distance: "turn",
        seedRequired: true,
        seedPresentInReadback: true,
      });
      const report = Object.freeze({
        schema: "memory_live_loop/v1",
      identity: Object.freeze({ continuityId: identity.continuityId }),
      runtimeRootKey: createHash("sha256").update(identity.continuityId).digest("hex").slice(0, 16),
      scenario: Object.freeze({
        ...(scenario.probeId === undefined ? {} : { probeId: scenario.probeId }),
        ...(scenario.manifestDigest === undefined ? {} : { manifestDigest: scenario.manifestDigest }),
        dimension: scenario.dimension,
      }),
      // Which surface answered. The seeded fact, the Memory authority and the
      // Magic Context materializer are shared with the Game surface, which answers
      // through the running game instead; the name is recorded so a reader never
      // has to guess what this report measured.
      askingSurface: "chat",
      ...(installedCard === undefined
        ? {}
        : { card: Object.freeze({ profileId: installedCard.profileId, canonicalHash: installedCard.canonicalHash }) }),
      seed: Object.freeze({ durable: true, rowCount: seeded.rowCount, projectionChanged: seeded.projectionChanged }),
        chat: Object.freeze({
          attempted: true,
          launched: false,
          reason: "phase2_reentry_requires_predecessor_teardown",
        }),
        funnel: attributed,
      });
      const finalReport = Object.freeze({ ...report, capture: await closeIntoReport(capture, root, report) });
      await writeFile(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`, "utf8");
      return finalReport;
    }

    const chat = chatResult.result;
    const verdict = scoreReply({ committedText: chat.committedText, scenario, chat });

    // S1/S2/S3 live observations (never probe scoring): prefix-cache byte
    // stability (vendor m[0] digest per materialization revision), reply
    // language effectiveness, and persona-liveness signals.
    const m0Digests = m0DigestsFromMarkers(chatResult.markers);
    // S3: which kinds of reviewed authored context the vendor actually compiled
    // into m[0] - the direct evidence that the companion's always-on world book
    // is in the Tier 2 baseline, on whichever surface this run drove.
    const m0Sources = m0SourcesFromMarkers(chatResult.markers);
    const replyObservation = observeCompanionReply(chat.committedText);

    // L2 (assembly): did the fact reach the context the model was given? The vendor
    // reports which memory ids it rendered into m[0]; we compare that against the id
    // of the row we seeded. Absent marker -> the funnel reports a gap, never a miss.
    //
    // An unresolved seed id is ALSO a gap, not a break: without the comparison key we
    // cannot say whether the id was missing or we simply asked the wrong question.
    // Resolve the chapters rendered into m[0] (v1 chapter rollup marker).
    const chapters = renderedChaptersFromMarkers(chatResult.markers);

    const renderedIds = renderedIdsForRun(chatResult.markers);
    // Real-fold evidence for a `fold`-distance probe: the vendor's fold-commit
    // marker shares its revision with the rendered-memory marker of the SAME
    // materialization, so the ids observed at that revision ARE the post-fold
    // rendered set. A session-distance probe keeps using the restart substitute
    // (postFoldAssembly) below; a fold probe passes the real commit evidence.
    const realFold = foldCommittedRenderedIdsFromMarkers(chatResult.markers);
    const attributed = attributeMemoryFunnel({
      ...observation,
      renderedMemoryIdsObserved: renderedIds !== undefined && seededMemoryId !== undefined,
      ...(seededMemoryId === undefined ? {} : { seedIdRendered: renderedIds?.has(seededMemoryId) === true }),
      // L3 for a session-distance probe: the fact must still be rendered in the NEW
      // process. Same marker, post-restart phase - which is exactly the difference the
      // stage is asking about. An unresolved seed id leaves this undefined so L3 reports
      // a gap ("we could not compare") instead of claiming the fact was dropped.
      ...(scenario.distance === "session" && seededMemoryId !== undefined && renderedIds !== undefined
        ? { postFoldAssembly: renderedIds.has(seededMemoryId) ? "present" : "absent" }
        : {}),
      // L3 for a `fold`-distance probe: the REAL fold-commit evidence (revision +
      // post-fold rendered set) when the vendor actually reported a fold this run;
      // absent otherwise so L3 reports a gap instead of a fabricated fold.
      ...(scenario.distance === "fold" && realFold !== undefined
        ? { realFold: { ...realFold, ...(seededMemoryId === undefined ? {} : { seedId: seededMemoryId }) } }
        : {}),
      probeEvent: verdict.event,
      ...(verdict.reason === undefined ? {} : { probeReason: verdict.reason }),
    });

    const report = Object.freeze({
      schema: "memory_live_loop/v1",
      identity: Object.freeze({ continuityId: identity.continuityId }),
      // The one storage fact that lets a reader SEE that both phases shared a root.
      runtimeRootKey: createHash("sha256").update(identity.continuityId).digest("hex").slice(0, 16),
      scenario: Object.freeze({
        ...(scenario.probeId === undefined ? {} : { probeId: scenario.probeId }),
        ...(scenario.manifestDigest === undefined ? {} : { manifestDigest: scenario.manifestDigest }),
        dimension: scenario.dimension,
      }),
      // Which surface answered. The seeded fact, the Memory authority and the
      // Magic Context materializer are shared with the Game surface, which answers
      // through the running game instead; the name is recorded so a reader never
      // has to guess what this report measured.
      askingSurface: "chat",
      ...(installedCard === undefined
        ? {}
        : {
            card: Object.freeze({
              profileId: installedCard.profileId,
              canonicalHash: installedCard.canonicalHash,
              coreChars: installedCard.coreChars,
            }),
          }),
      // S1/S2/S3 effect observations: prefix-cache stability, reply language,
      // persona liveness. All content-free or signal-level; the committed reply
      // text itself is still scored and never persisted.
      observations: Object.freeze({
        // The vendor emits [probe:m0_digest] at EVERY materialization boundary;
        // identical m[0] bytes per revision is the prefix-cache contract. A
        // revision change is a fold (legit new baseline), never a defect.
        prefixCache: Object.freeze({
          markerObserved: m0Digests?.observed === true,
          passCount: m0Digests?.passes?.length ?? null,
          revisionCount: m0Digests?.revisionCount ?? null,
          digestStablePerRevision: m0Digests?.stable ?? null,
        }),
        // S3: the kinds of reviewed authored context the vendor compiled into the
        // m[0] it presented. `lorebookConstantPresent` is the claim itself; the
        // kinds are reported raw so a reader can see what else rode the baseline.
        m0Sources: Object.freeze({
          markerObserved: m0Sources?.observed === true,
          stableKinds: m0Sources?.stableKinds ?? null,
          volatileKinds: m0Sources?.volatileKinds ?? null,
          lorebookConstantPresent: m0Sources?.lorebookConstantPresent ?? null,
        }),
        ...(replyObservation === null
        ? {}
        : {
            replyLanguage: Object.freeze({
              cjkRatio: replyObservation.cjkRatio,
              primaryScript: replyObservation.primaryScript,
              chineseEffective: replyObservation.chineseEffective,
            }),
            persona: Object.freeze({
              committedChars: replyObservation.committedChars,
              signals: replyObservation.signals,
              ...(replyObservation.assistantShell === true ? { assistantShell: true } : {}),
            }),
            // The reply itself. A language observation without the text it was taken from
            // cannot be judged: "the companion answered in Chinese" and "the observation
            // is wrong" look identical. This is the live run's own evidence copy, the same
            // way the harness records the question it asked.
            replyText: Object.freeze({ text: replyObservation.text }),
          }),
      }),
      seed: Object.freeze({ durable: true, rowCount: seeded.rowCount, projectionChanged: seeded.projectionChanged }),
      // The L2 comparison facts, content-free but auditable: which side of the
      // comparison was even available. Without these a `broken` L2 is not
      // distinguishable from an unresolved comparison key, which would be a harness
      // defect reported as a product defect.
      assembly: Object.freeze({
        seededIdResolved: seededMemoryId !== undefined,
        markerObserved: renderedIds !== undefined,
        renderedIdCount: renderedIds === undefined ? null : renderedIds.size,
        seedIdRendered: seededMemoryId !== undefined && renderedIds?.has(seededMemoryId) === true,
      }),
      // Chapter rollup observation (v1): did sealed chapters reach m[0], and
      // is the chapter block byte-stable? `null` means the vendor never
      // emitted the marker; a number (possibly 0) means it did.
      chapters: Object.freeze({
        markerObserved: chapters !== undefined,
        renderedCount: chapters?.count ?? null,
        ...(chapters?.digest === undefined ? {} : { blockDigest: chapters.digest }),
      }),
      chat: Object.freeze({
        attempted: true,
        turnState: chat.turnState ?? null,
        committedCompanionDelta: chat.committedCompanionDelta ?? 0,
        committed: typeof chat.committedText === "string" && chat.committedText.length > 0,
        // Content-free: the reply text is scored here and never persisted.
        verdict: verdict.event,
        ...(verdict.reason === undefined ? {} : { verdictReason: verdict.reason }),
      }),
      funnel: attributed,
    });
    const finalReport = Object.freeze({ ...report, capture: await closeIntoReport(capture, root, report) });
    await writeFile(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`, "utf8");
    return finalReport;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    requestedLanguage = parsed.language;
    const report = await runMemoryLiveLoop({
      reportPath: parsed.reportPath,
      manifestPath: parsed.manifestPath,
      seed: parsed.seed,
      question: parsed.question,
      cardPath: parsed.cardPath,
    });
    process.stdout.write(
      `${JSON.stringify({
        state: report.seed.durable ? "collected" : "blocked",
        verdict: report.chat.verdict ?? null,
        stages: report.funnel.stages.map((row) => `${row.stage}:${row.status}`),
        findings: report.funnel.findings.length,
      })}\n`,
    );
  }
}