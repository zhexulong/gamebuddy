// The two product chains, step by step, and which live-run driver measures each step.
//
// The chains themselves are written down for a reader in `design/handbook/live-run-chains.md`:
// OOBE is a player's first ever run (installation registration through her client standing in the
// world) and daily use is the session a farm that already exists gets. This module is the same two
// chains in the shape a gate can hold: one declaration per step, its owning code seam, the single
// observable fact that says the step happened, and the driver that reads that fact - or the reason
// no driver can yet.
//
// WHY A DECLARATION AND NOT PROSE ALONE. An alignment table in a document drifts silently: a driver
// is renamed, a rung is folded into another, and the table keeps claiming coverage nobody produces.
// `chain-steps.test.mjs` holds this list against the kit itself - the roster in `phases/drivers.mjs`,
// the game-chain drivers discovered from the capture directory, and the driver sources the facts
// are quoted from - so a step whose driver is gone, a driver that measures a chain and names no step,
// and a fact no driver prints are all failures with a name.
//
// WHAT A `gap:` IS. Not "unimportant" and not "unmeasured by the product": a seam that exists and
// whose fact no driver reads yet. The suffix says which reading is missing, and the document's open
// items list owns the work.
//
// TWO KINDS, and a reader has to tell them apart or all of them read as missing product. Four of the
// gaps are READING gaps: `owner.json`, the session document, the recovery journal and her client's trace
// are written by any ordinary run and a driver only has to open a file that is already there. One is an
// INTERACTION gap (`no_driver_speaks_to_her_in_the_world`): nothing in the world speaks to her, so there is
// no file to open until somebody speaks - the missing thing is the interaction, and a reader for it would
// have to cause one first. Her turn account used to be a fifth reading gap and is not one any more: the
// Host prints `GAME_TURN_ACCOUNT` on the product entry's stderr, `phases/launch.mjs` keeps those bytes in a
// file, and `capture/turn-account.cjs` reads the line `w-game-launch` waits for (`daily-agent-awake`).
//
// One fact per step, and it is a literal that the named driver (or a capture module that driver
// requires) really writes. Two spellings of one fact is how a table starts disagreeing with itself.

/** The two chains, in the order a player meets them. */
export const CHAIN_NAMES = Object.freeze(["oobe", "daily"]);

/** What a step is in its chain: the mandatory path, one of the ways the chain ends, or an interruption. */
export const STEP_KINDS = Object.freeze(["step", "exit", "branch"]);

/**
 * The prefix that turns a step's `driver` into a named missing reading.
 *
 * `gap:no_driver_reads_the_recovery_journal` says the seam exists, the journal is written, and no
 * driver opens it - which is a different sentence from "the product does not do this".
 */
export const GAP_PREFIX = "gap:";

const step = (entry) => Object.freeze({ kind: "step", ...entry });

/**
 * Both chains, one declaration per step.
 *
 * `owner` is the seam that produces the fact - a module the reader can open. It carries no line
 * number on purpose: a line number in a vocabulary drifts on every edit above it, and the document
 * that wants to point at one line quotes it in its own prose.
 */
export const CHAIN_STEPS = Object.freeze([
  // ---------------------------------------------------------------- OOBE: a player's first ever run
  step({
    id: "oobe-installation-registered",
    chain: "oobe",
    title: "the installation is registered",
    driver: "w-game-launch",
    fact: 'prerequisites === "met"',
    owner: "host/src/stardew-production-lifecycle-coordinator.internal.ts registerInstallationLocator",
  }),
  step({
    id: "oobe-lifecycle-activated",
    chain: "oobe",
    title: "the lifecycle is activated and staged",
    driver: "w-game-launch",
    fact: "lifecycle/activate",
    owner: "host/src/stardew-production-lifecycle-coordinator.internal.ts activate",
  }),
  step({
    id: "oobe-launch-admitted",
    chain: "oobe",
    title: "the launch is admitted",
    driver: "w-game-launch",
    fact: "launch admitted",
    owner: "host/src/stardew-production-lifecycle-coordinator.internal.ts launchPlayerHost",
  }),
  step({
    id: "oobe-guardian-armed",
    chain: "oobe",
    title: "the Guardian is armed and holds the game it launches",
    driver: "w-game-launch",
    fact: "guardian armed",
    owner:
      "integrations/stardew/GameBuddy.Stardew.csproj (role broker) + host/src/composition/stardew/stardew-guardian-platform.ts",
  }),
  step({
    id: "oobe-game-process",
    chain: "oobe",
    title: "the game process exists",
    driver: "w-game-launch",
    fact: "process started",
    owner: "host/src/stardew-player-host-process-owner.ts",
  }),
  step({
    id: "oobe-world-created",
    chain: "oobe",
    title: "the game creates the world through its own path",
    driver: "w-game-launch",
    fact: "this run starts from its own world",
    owner: "integrations/stardew/WorldCreationBootstrap.cs EstablishCompanionCabinLayout",
  }),
  step({
    id: "oobe-save-loaded",
    chain: "oobe",
    title: "the world is loaded",
    driver: "w-game-launch",
    fact: "Context: loaded save",
    owner: "integrations/stardew/ModEntry.cs (the Mod's own SMAPI log line)",
  }),
  step({
    id: "oobe-cabin-seat",
    chain: "oobe",
    title:
      "the companion has a cabin to be provisioned into (the rung's two proofs: the engine's released unclaimed native slot, or a cabin the Mod built on a free pad)",
    driver: "w-game-launch",
    // The rung, not one of its two sentences. The driver accepts both (`capture/w-game-launch.cjs`
    // `CHAIN_LOG_PATTERNS`, where the Mod's own line is a build on a free pad or a released native slot), and a
    // fresh world takes either branch: `frontend--r23` met the build, `livenow10` met the release. Naming one
    // sentence here made the step read as unmeasured on the other branch, which is how the first draft of this
    // declaration would have reported a seat the run had already measured.
    fact: "cabin ready",
    owner: "integrations/stardew/HostFarmhandProvisioning/CompanionCabinProvisioning.cs",
  }),
  step({
    id: "oobe-cabin-read",
    chain: "oobe",
    title: "the Host answers the cabin read",
    driver: "w-game-launch",
    fact: "cabin read(auto)",
    owner: "host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.internal.ts (cabin choices)",
  }),
  step({
    id: "oobe-cabin-confirm",
    chain: "oobe",
    title: "the confirmation is pressed and accepted by the route",
    driver: "w-game-launch",
    fact: "cabin confirm",
    owner: "host/src/stardew-production-lifecycle-coordinator.internal.ts confirmCabinChoice",
  }),
  step({
    id: "oobe-manifest-issued",
    chain: "oobe",
    title: "the Mod issues her signed manifest",
    driver: "w-game-launch",
    fact: "stardew-attachment-response.json",
    owner: "integrations/stardew/HostFarmhandProvisioner.cs HandleRequest",
  }),
  step({
    id: "oobe-manifest-admitted",
    chain: "oobe",
    title: "the Host admits the manifest and reserves her client",
    driver: "gap:no_driver_opens_owner_json",
    fact: "owner.json carries the ai-client managed paths",
    owner: "host/src/games/stardew/lifecycle/stardew-private-bootstrap-owner-records.private.ts",
  }),
  step({
    id: "oobe-bridge-identity",
    chain: "oobe",
    title: "the request's identity is the live world's",
    driver: "gap:no_driver_reads_the_session_document",
    fact: "stardew-session.json saveId/worldId/nonce",
    owner: "host/src/stardew-attachment.ts confirmAndRequest",
  }),
  step({
    id: "oobe-run-enter",
    chain: "oobe",
    title: "her runtime enters the world and binds continuity",
    driver: "gap:no_driver_reads_the_recovery_journal",
    fact: "stardew-logical-action-recovery-journal.jsonl header",
    owner: "host/src/continuity-semantic-deployment-composition/continuity-semantic-game-facade.internal.ts runEnter",
  }),
  step({
    id: "oobe-attach",
    chain: "oobe",
    title: "the attachment is published",
    driver: "w-game-launch",
    fact: "attachment=attached",
    owner: "host/src/stardew-production-lifecycle-coordinator.internal.ts (attachment projection)",
  }),
  step({
    id: "oobe-client-in-world",
    chain: "oobe",
    title: "her own game client is in the world",
    driver: "gap:no_driver_reads_the_ai_client_trace",
    fact: "her client's own gamebuddy-trace, hello and companion_presentation_request",
    owner: "host/src/stardew-ai-client-process-owner.ts",
  }),

  // ---------------------------------------------------------------- daily use: a world that exists
  step({
    id: "daily-launch-admitted",
    chain: "daily",
    title: "the launch is admitted",
    driver: "w-game-launch",
    fact: "launch admitted",
    owner: "host/src/stardew-production-lifecycle-coordinator.internal.ts launchPlayerHost",
  }),
  step({
    id: "daily-guardian-armed",
    chain: "daily",
    title: "the Guardian is armed and holds the game it launches",
    driver: "w-game-launch",
    fact: "guardian armed",
    owner: "host/src/composition/stardew/stardew-guardian-platform.ts",
  }),
  step({
    id: "daily-game-process",
    chain: "daily",
    title: "the game process exists",
    driver: "w-game-launch",
    fact: "process started",
    owner: "host/src/stardew-player-host-process-owner.ts",
  }),
  step({
    id: "daily-cabin-seat",
    chain: "daily",
    title: "she has a seat: the engine hands one over, or the Mod builds one",
    driver: "w-game-launch",
    fact: "cabin ready",
    owner: "integrations/stardew/HostFarmhandProvisioning/CompanionCabinProvisioning.cs",
  }),
  step({
    id: "daily-cabin-read",
    chain: "daily",
    title: "the Host answers the cabin read",
    driver: "w-game-launch",
    fact: "cabin read(auto)",
    owner: "host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.internal.ts (cabin choices)",
  }),
  step({
    id: "daily-cabin-confirm",
    chain: "daily",
    title: "the confirmation is pressed and accepted by the route",
    driver: "w-game-launch",
    fact: "cabin confirm",
    owner: "host/src/stardew-production-lifecycle-coordinator.internal.ts confirmCabinChoice",
  }),
  step({
    id: "daily-manifest-issued",
    chain: "daily",
    title: "the Mod issues her signed manifest",
    driver: "w-game-launch",
    fact: "stardew-attachment-response.json",
    owner: "integrations/stardew/HostFarmhandProvisioner.cs HandleRequest",
  }),
  step({
    id: "daily-attach",
    chain: "daily",
    title: "the attachment is published and her client runs",
    driver: "w-game-launch",
    fact: "attachment=attached",
    owner: "host/src/stardew-production-lifecycle-coordinator.internal.ts (attachment projection)",
  }),
  step({
    id: "daily-agent-awake",
    chain: "daily",
    title: "her agent is awake while the world runs, opened by the world's own facts and not by the player",
    // The Host, not a caller, owns her turns: `acceptHostMintedFact` enqueues the fact and starts the flush
    // with nothing waiting on it, and `CompanionLoop.flush` answers one Pi turn per delivered batch and
    // prints this line. So "she is working while the player plays" has an observable fact of its own, and it
    // is a different fact from the player speaking to her (`daily-play`). The bytes reach the kit on the
    // product entry's stderr, which `phases/launch.mjs` now keeps in `paths.entryStderrFile`, and
    // `capture/turn-account.cjs` parses the line `w-game-launch` waits for after the attachment lands. The
    // step is awake only when at least one turn opened FOR A WORLD FACT: a session where only the player's
    // own words opened turns does not prove it.
    driver: "w-game-launch",
    fact: "GAME_TURN_ACCOUNT turns opened",
    owner: "host/src/host-service.ts acceptHostMintedFact -> flushSoon; host/src/companion-loop.ts flush",
  }),
  step({
    id: "daily-play",
    chain: "daily",
    title: "she acts in the world, and the observation and presentation traffic runs",
    driver: "gap:no_driver_speaks_to_her_in_the_world",
    fact: "her client's observe_request and companion_presentation_request in its own trace",
    owner: "integrations/stardew/ModEntry.cs (native chat ingress) + the capability surface",
  }),
  Object.freeze({
    id: "daily-stop",
    chain: "daily",
    kind: "exit",
    title: "the player stops driving the world and the AI authority closes",
    driver: "w-game-launch",
    fact: "game/stop",
    owner: "dialogue-web/src/components/GameSurface.tsx handleGameStop",
  }),
  Object.freeze({
    id: "daily-endgame",
    chain: "daily",
    kind: "exit",
    title: "the player ends the game explicitly",
    driver: "y-game-endgame",
    fact: "game/endgame",
    owner: "host/src/stardew-production-lifecycle-coordinator.internal.ts endgameGame",
  }),
  Object.freeze({
    id: "daily-disconnect",
    chain: "daily",
    kind: "exit",
    title: "the surface disconnects and the world keeps running",
    driver: "z-game-disconnect",
    fact: "game/disconnect",
    owner: "host/src/stardew-production-lifecycle-coordinator.internal.ts disconnectGame",
  }),
  Object.freeze({
    id: "daily-game-dies",
    chain: "daily",
    kind: "branch",
    title: "the game dies under the session",
    driver: "x-game-death",
    fact: "stardew_player_host_exited",
    owner: "host/src/stardew-production-lifecycle-coordinator.internal.ts recordPlayerHostExit",
  }),
]);

/** The steps of one chain, in declaration order. */
export function stepsOfChain(chain) {
  return Object.freeze(CHAIN_STEPS.filter((entry) => entry.chain === chain));
}

/** Every step whose driver is a named gap, as `{ id, gap }`. */
export function namedGaps() {
  return Object.freeze(
    CHAIN_STEPS.filter((entry) => entry.driver.startsWith(GAP_PREFIX)).map((entry) =>
      Object.freeze({ id: entry.id, gap: entry.driver.slice(GAP_PREFIX.length) }),
    ),
  );
}

/** The driver keys this vocabulary names, sorted, so a caller can print or join them. */
export function measuredDrivers() {
  const keys = CHAIN_STEPS.filter((entry) => !entry.driver.startsWith(GAP_PREFIX)).map((entry) => entry.driver);
  return Object.freeze([...new Set(keys)].sort());
}

/**
 * The alignment as one block of lines: the counts first, because "17 steps, 11 measured, 6 gaps" is
 * the sentence a reader needs before any row, then a line per declaration.
 *
 * The population is printed with the verdict. A table that reports "0 gaps" over an empty list is
 * the shape this kit has been burned by, so the counts always name what they counted.
 */
export function describeChainAlignment(entries = CHAIN_STEPS) {
  const all = Array.isArray(entries) ? entries : [];
  const gaps = all.filter((entry) => String(entry.driver).startsWith(GAP_PREFIX));
  const measured = all.length - gaps.length;
  const byKind = (kind) => all.filter((entry) => entry.kind === kind).length;
  const lines = [
    `CHAIN-ALIGNMENT examined ${String(all.length)} declaration(s): ${String(measured)} measured by a driver, ${String(gaps.length)} named gap(s)`,
    `CHAIN-ALIGNMENT kinds: ${STEP_KINDS.map((kind) => `${String(byKind(kind))} ${kind}`).join(", ")}`,
  ];
  for (const chain of CHAIN_NAMES) {
    const steps = all.filter((entry) => entry.chain === chain);
    const chainGaps = steps.filter((entry) => String(entry.driver).startsWith(GAP_PREFIX)).length;
    lines.push(
      `CHAIN-ALIGNMENT ${chain}: ${String(steps.length)} declaration(s), ${String(steps.length - chainGaps)} measured, ${String(chainGaps)} gap(s)`,
    );
  }
  for (const entry of all)
    lines.push(
      `CHAIN-ALIGNMENT ${entry.chain}/${entry.kind} ${entry.id} ${String(entry.driver)} - ${entry.title} [${entry.fact}]`,
    );
  return lines;
}

/**
 * The gate over this vocabulary, as a pure function so it can be driven by the real tree and by a
 * violation in the same run.
 *
 * `drivers` is the roster (`phases/drivers.mjs`) and `readSource(file)` returns a capture file's
 * text (`null` when it cannot be read). A driver is part of the population when the roster lists it
 * AND the roster says it opens the game (`requiresGame`, the field `phases/drivers.mjs` already owns
 * for the drivers that launch a world). So a new game-chain driver enters this gate by being
 * declared as what it is, and every Chat-geometry driver that shares the capture directory stays
 * out of a population it has nothing to say about.
 *
 * Every problem names the member that broke: a gate that says "expected true, got false" costs the
 * next reader an afternoon.
 */
export function auditChainAlignment({ entries, drivers, readSource }) {
  const steps = Array.isArray(entries) ? entries : [];
  const roster = Array.isArray(drivers) ? drivers : [];
  const problems = [];
  const seen = new Set();

  for (const entry of steps) {
    if (seen.has(entry.id)) problems.push({ code: "duplicate_step_id", detail: `${entry.id} is declared twice` });
    seen.add(entry.id);
    if (!CHAIN_NAMES.includes(entry.chain))
      problems.push({ code: "unknown_chain", detail: `${entry.id} declares chain ${JSON.stringify(entry.chain)}` });
    if (!STEP_KINDS.includes(entry.kind))
      problems.push({ code: "unknown_kind", detail: `${entry.id} declares kind ${JSON.stringify(entry.kind)}` });
    if (String(entry.driver).startsWith(GAP_PREFIX) && entry.driver.length === GAP_PREFIX.length)
      problems.push({ code: "empty_gap_reason", detail: `${entry.id} names an empty gap` });
  }

  const population = roster.filter((driver) => driver.requiresGame === true && readSource(driver.file) !== null);
  if (roster.length === 0) problems.push({ code: "empty_roster", detail: "the driver roster is empty" });
  if (population.length === 0)
    problems.push({
      code: "empty_population",
      detail: `none of ${String(roster.length)} roster driver(s) declares requiresGame and can be read, so no driver in this kit opens a world to measure a chain over`,
    });

  const named = new Set(steps.filter((entry) => !String(entry.driver).startsWith(GAP_PREFIX)).map((e) => e.driver));
  for (const driver of population)
    if (!named.has(driver.key))
      problems.push({
        code: "driver_without_step",
        detail: `${driver.key} (${driver.file}) opens a world and names no chain step in lib/chain-steps.mjs`,
      });

  const requiredBy = (fileName) => {
    const source = readSource(fileName);
    if (source === null) return [];
    const names = [...source.matchAll(/require\("\.\/([^"]+)"\)/gu)].map((match) => match[1]);
    return [...new Set(names)];
  };

  for (const entry of steps) {
    if (String(entry.driver).startsWith(GAP_PREFIX)) continue;
    const driver = roster.find((candidate) => candidate.key === entry.driver);
    if (driver === undefined) {
      problems.push({
        code: "step_driver_not_in_roster",
        detail: `${entry.id} names driver ${entry.driver}, which phases/drivers.mjs does not list`,
      });
      continue;
    }
    const own = readSource(driver.file);
    if (own === null) {
      problems.push({
        code: "step_driver_missing",
        detail: `${entry.id} names driver ${entry.driver} (${driver.file}), which cannot be read`,
      });
      continue;
    }
    const sources = [own, ...requiredBy(driver.file).map((name) => readSource(name) ?? "")];
    if (!sources.some((source) => source.includes(entry.fact)))
      problems.push({
        code: "step_fact_absent",
        detail: `${entry.id}'s fact ${JSON.stringify(entry.fact)} appears in neither ${driver.file} nor the capture modules it requires`,
      });
  }

  const gaps = steps.filter((entry) => String(entry.driver).startsWith(GAP_PREFIX));
  return Object.freeze({
    examined: steps.length,
    measured: steps.length - gaps.length,
    gaps: gaps.length,
    population: Object.freeze(population.map((driver) => driver.key)),
    problems: Object.freeze(problems),
  });
}
