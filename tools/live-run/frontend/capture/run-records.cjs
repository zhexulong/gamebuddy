// The four records a passing run leaves about itself, and the driver that finally opens them.
//
// WHY THIS MODULE EXISTS. Four steps of the OOBE chain were declared `gap:` - not "the product does not do
// this", but "the seam exists, the file is on disk after an ordinary run, and no driver reads it":
//
//   oobe-manifest-admitted   owner.json          the Host admits the manifest and reserves her client
//   oobe-bridge-identity     stardew-session.json the request's identity is the live world's
//   oobe-run-enter           recovery journal las runEnter enters the world and binds continuity
//   oobe-client-in-world     her client's trace   her own process is in the world, hearing and presenting
//
// Each one is here as one reader, answering one fact. They share the attempt tree because that is what a
// reader needs: three of the four files live under ONE `<declaredDataRoot>/stardew-private-bootstrap/<id>/`,
// and a reader that picked a different attempt per file could report a manifest from one launch beside a
// session from another.
//
// WHAT "READ" MEANS, and why it is more than the file existing. `owner.json` existing says the Host wrote a
// reservation; the step says the manifest THIS RUN issued is the one the Host admitted, which is a join:
// the attachment response names the manifest (`manifestPath`), the manifest names the companion and the
// farmhand, and the owner record reserves that same companion. A file that exists and names another run's
// companion is the shape this reading has to refuse, not pass.
//
// THE TRACE IS NOT IN THE RUN ROOT. `ModTraceRecorder` writes `gamebuddy-trace-<runId>.json` into SMAPI's
// own log directory (`integrations/stardew/ModTraceRecorder.cs:44`, `Constants.LogDir`), which this machine
// shares between every Stardew process - the same directory `w-game-launch` already reads `SMAPI-latest.txt`
// from. The listing is bounded by the run id the trace carries in its own file name, so only a process that
// started at or after this launch is read, and "hers" is decided by the frame only a local-bridge process
// hears (see `aiClientTraceOf`).
//
// Four named absences, never a skip: `owner_json_absent`, `session_document_absent`,
// `recovery_journal_absent`, `ai_client_trace_absent` - and beside them the shapes that are worse than an
// absence because they read as a pass: `owner_json_incomplete`, `session_identity_inconsistent`,
// `recovery_journal_unbound`, `ai_client_trace_not_hers`, `ai_client_trace_incomplete`.

const { readFileSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");

/** The directory the Host keeps one per bootstrap attempt, under the run's declared data root. */
const ATTEMPT_ROOT = "stardew-private-bootstrap";

const OWNER_FILE = "owner.json";
const SESSION_FILE = "stardew-session.json";
const MANIFEST_FILE = "stardew-farmhand-manifest.json";
const RESPONSE_FILE = "stardew-attachment-response.json";

/** Where `runEnter` opens its journal, relative to the run's declared data root. */
const RECOVERY_ROOT = "stardew-recovery";
const JOURNAL_FILE = "stardew-logical-action-recovery-journal.jsonl";

/** One file per game run, named by the Mod's own `yyyyMMdd-HHmmss` run id. */
const TRACE_PREFIX = "gamebuddy-trace-";
const TRACE_SUFFIX = ".json";

/** The two roles `lib/run-game.mjs` records for the game processes this run caused. */
const GAME_ROLES = Object.freeze(["game-smapi", "game-client"]);

/**
 * The four facts, spelled exactly as `lib/chain-steps.mjs` declares them.
 *
 * They live here because this module is what answers them: a declaration whose fact is spelled only in the
 * vocabulary has nothing holding it to a reading, and `chain-steps.test.mjs` finds these strings in the
 * module the driver requires.
 */
const FACTS = Object.freeze({
  owner: "owner.json carries the ai-client managed paths",
  session: "stardew-session.json saveId/worldId/nonce",
  journal: "stardew-logical-action-recovery-journal.jsonl header",
  trace: "her client's own gamebuddy-trace, hello and companion_presentation_request",
});

/** The frames that make a trace hers: a client with a local bridge session hears its ingress and its lines. */
const INGRESS_FRAMES = Object.freeze(["hello", "observe_request"]);
const PRESENTATION_FRAME = "companion_presentation_request";

const REASONS = Object.freeze({
  ownerAbsent: "owner_json_absent",
  ownerUnreadable: "owner_json_unreadable",
  ownerIncomplete: "owner_json_incomplete",
  ownerWithoutManifest: "owner_json_without_the_manifest_this_run_issued",
  sessionAbsent: "session_document_absent",
  sessionUnreadable: "session_document_unreadable",
  sessionInconsistent: "session_identity_inconsistent",
  journalContinuityUnknown: "recovery_journal_continuity_unknown",
  journalAbsent: "recovery_journal_absent",
  journalUnreadable: "recovery_journal_unreadable",
  journalUnbound: "recovery_journal_unbound",
  traceAbsent: "ai_client_trace_absent",
  traceNotHers: "ai_client_trace_not_hers",
  traceIncomplete: "ai_client_trace_incomplete",
});

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

/** A JSON file as `{ file, bytes, value }`, or `null` when it is not there or is not JSON. */
function readJson(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    return { file, bytes: Buffer.byteLength(text, "utf8"), value: JSON.parse(text) };
  } catch {
    return { file, bytes: Buffer.byteLength(text, "utf8"), value: null };
  }
}

function modifiedAt(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The attempts under one declared data root, newest first.
 *
 * One attempt per launch is the ordinary case and `attempts=<n>` travels with every reading, so a root
 * holding two is visible instead of silently read as one.
 */
function readAttempts(declaredDataRoot) {
  if (!nonEmpty(declaredDataRoot)) return Object.freeze([]);
  const root = path.join(declaredDataRoot, ATTEMPT_ROOT);
  let names = [];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return Object.freeze([]);
  }
  const attempts = names.map((name) => {
    const directory = path.join(root, name);
    const sessionDirectory = path.join(directory, "session");
    const ownerFile = path.join(directory, OWNER_FILE);
    const owner = readJson(ownerFile);
    return Object.freeze({
      name,
      directory,
      sessionDirectory,
      ownerFile,
      ownerFileModifiedAtMs: modifiedAt(ownerFile),
      owner,
      sessionFile: path.join(sessionDirectory, SESSION_FILE),
      manifestFile: path.join(sessionDirectory, MANIFEST_FILE),
      responseFile: path.join(sessionDirectory, RESPONSE_FILE),
    });
  });
  // The record revision is the Host's own ordering (owner.json `ownerRecordRevision`); the file's mtime only
  // breaks a tie. A reader that sorted on the clock alone would read the older attempt on a fast relaunch.
  return Object.freeze(
    [...attempts].sort((left, right) => {
      const leftRevision = Number(left.owner?.value?.ownerRecordRevision ?? -1);
      const rightRevision = Number(right.owner?.value?.ownerRecordRevision ?? -1);
      if (leftRevision !== rightRevision) return rightRevision - leftRevision;
      return Number(right.ownerFileModifiedAtMs ?? 0) - Number(left.ownerFileModifiedAtMs ?? 0);
    }),
  );
}

/** The attempt a reading is about: the newest one that has an owner record, else the newest with a session. */
function selectedAttempt(attempts) {
  return attempts.find((attempt) => attempt.owner?.value !== null && attempt.owner?.value != null) ?? attempts[0] ?? null;
}

/**
 * The manifest the attachment response names, resolved inside the attempt's own session directory.
 *
 * `manifestPath` is relative by construction (`stardew-attachment-response.json` ->
 * `"manifestPath":"stardew-farmhand-manifest.json"`); a value that resolves outside the session directory is
 * refused rather than followed, because then it is not the file the Mod issued for this attempt.
 */
function readIssuedManifest(attempt, response) {
  const named = response?.value?.manifestPath;
  if (!nonEmpty(named)) return { file: null, value: null, reason: "the attachment response names no manifestPath" };
  const file = path.resolve(attempt.sessionDirectory, named);
  if (path.normalize(path.dirname(file)) !== path.normalize(attempt.sessionDirectory))
    return { file, value: null, reason: `manifestPath ${JSON.stringify(named)} resolves outside the session directory` };
  const manifest = readJson(file);
  if (manifest === null) return { file, value: null, reason: `${named} is named by the response and is not on disk` };
  if (manifest.value === null) return { file, value: null, reason: `${named} is not JSON` };
  return { file, value: manifest.value, reason: null };
}

const verdict = (kind, reason, detail, reading) => Object.freeze({ kind, reason, detail, reading });

/**
 * `oobe-manifest-admitted`: the manifest this run issued is the one the Host admitted.
 *
 * The Host's admission is `owner.json`: `state=reserved` plus the `ai-client` half of `managedPaths`, which is
 * the inventory it laid down for her client. The join is what makes it this run's: the companion the owner
 * record reserved is the companion the issued manifest binds.
 */
function ownerAdmissionOf(attempts) {
  if (attempts.length === 0)
    return verdict(
      "unreadable",
      REASONS.ownerAbsent,
      `no attempt directory under ${ATTEMPT_ROOT}: nothing was examined, so no ${OWNER_FILE} was looked for`,
      { attempts: 0 },
    );
  const attempt = selectedAttempt(attempts);
  const withOwner = attempts.filter((candidate) => candidate.owner?.value != null);
  if (withOwner.length === 0) {
    const named = attempts.map((candidate) => candidate.ownerFile);
    return verdict(
      "absent",
      REASONS.ownerAbsent,
      `${String(attempts.length)} attempt(s) examined and none carries a readable ${OWNER_FILE}: looked for ${named.join(", ")}`,
      { attempts: attempts.length },
    );
  }
  const owner = attempt.owner.value;
  const managedPaths = Array.isArray(owner.managedPaths) ? owner.managedPaths : [];
  const aiClientPaths = managedPaths.filter((entry) => typeof entry === "string" && entry.startsWith("ai-client"));
  const problems = [];
  if (owner.state !== "reserved") problems.push(`state=${JSON.stringify(owner.state)} is not "reserved"`);
  if (owner.aiClient?.kind !== "launch_reserved") problems.push(`aiClient.kind=${JSON.stringify(owner.aiClient?.kind)}`);
  if (aiClientPaths.length === 0) problems.push("managedPaths names no ai-client entry");
  if (!nonEmpty(owner.companionId)) problems.push("the record names no companionId");
  if (problems.length > 0)
    return verdict(
      "incomplete",
      REASONS.ownerIncomplete,
      `${attempt.owner.file} reserves no client this chain can read: ${problems.join("; ")} (managedPaths=${JSON.stringify(managedPaths.slice(0, 4))}${managedPaths.length > 4 ? ` +${String(managedPaths.length - 4)} more` : ""})`,
      { attempts: attempts.length, file: attempt.owner.file },
    );

  const response = readJson(attempt.responseFile);
  const manifest = readIssuedManifest(attempt, response);
  if (manifest.value === null)
    return verdict(
      "unjoined",
      REASONS.ownerWithoutManifest,
      `${attempt.owner.file} reserves companion ${JSON.stringify(owner.companionId)}, and the manifest it admits cannot be named: ${manifest.reason} (${String(attempt.responseFile)})`,
      { attempts: attempts.length, file: attempt.owner.file, manifest: manifest.file },
    );
  if (manifest.value.companionId !== owner.companionId)
    return verdict(
      "unjoined",
      REASONS.ownerWithoutManifest,
      `the owner record reserves companion ${JSON.stringify(owner.companionId)} and the manifest this run issued binds ${JSON.stringify(manifest.value.companionId)} (${String(manifest.file)}): the admitted manifest is not the one the run issued`,
      { attempts: attempts.length, file: attempt.owner.file, manifest: manifest.file },
    );

  return verdict(
    "admitted",
    null,
    `attempt ${attempt.name}: state=${String(owner.state)}/aiClient=${String(owner.aiClient.kind)} launchGeneration=${String(owner.aiClient.launchGeneration)}, companion ${JSON.stringify(owner.companionId)}, managedPaths=${String(managedPaths.length)} with the ai-client half ${JSON.stringify(aiClientPaths.slice(0, 2))}${aiClientPaths.length > 2 ? ` +${String(aiClientPaths.length - 2)} more` : ""}; admitted manifest ${path.basename(String(manifest.file))} binds that same companion (farmhandId=${String(manifest.value.farmhandId)}, cabinId=${String(manifest.value.cabinId)}, nonce=${String(manifest.value.sessionNonce)}) as ${String(response.value.state)}/${String(response.value.reasonCode)} named it`,
    { attempts: attempts.length, file: attempt.owner.file, manifest: manifest.file, aiClientPaths },
  );
}

/**
 * `oobe-bridge-identity`: the session document's world/save/farmhand/companion identity, self-consistent.
 *
 * Self-consistency is the whole reading. A document with a `saveId` and a `worldId` that agree with nothing is
 * as readable as one that agrees with everything, and only the joins below tell them apart: the host player IS
 * the world's player, the cabin the companion is bound to carries the farmhand the identity names, and the
 * document was published by the player host in the ready state.
 */
function sessionIdentityOf(attempts, { principal = null } = {}) {
  if (attempts.length === 0)
    return verdict(
      "unreadable",
      REASONS.sessionAbsent,
      `no attempt directory under ${ATTEMPT_ROOT}: nothing was examined, so no ${SESSION_FILE} was looked for`,
      { attempts: 0 },
    );
  const readable = attempts
    .map((candidate) => ({ attempt: candidate, session: readJson(candidate.sessionFile) }))
    .filter((entry) => entry.session?.value != null)
    .sort((left, right) => Number(right.session.value.publishedAtUnixMs ?? 0) - Number(left.session.value.publishedAtUnixMs ?? 0));
  if (readable.length === 0)
    return verdict(
      "absent",
      REASONS.sessionAbsent,
      `${String(attempts.length)} attempt(s) examined and none carries a readable ${SESSION_FILE}: looked for ${attempts.map((candidate) => candidate.sessionFile).join(", ")}`,
      { attempts: attempts.length },
    );
  const { session } = readable[0];
  const document = session.value;

  const problems = [];
  for (const member of ["saveId", "worldId", "hostPlayerId", "nonce", "signature"])
    if (!nonEmpty(document[member])) problems.push(`${member} is not a string`);
  if (document.runtimeRole !== "player_host")
    problems.push(`runtimeRole=${JSON.stringify(document.runtimeRole)} is not "player_host"`);
  if (document.state !== "ready") problems.push(`state=${JSON.stringify(document.state)} is not "ready"`);
  if (nonEmpty(document.worldId) && nonEmpty(document.hostPlayerId) && document.hostPlayerId !== document.worldId)
    problems.push(`hostPlayerId ${JSON.stringify(document.hostPlayerId)} is not worldId ${JSON.stringify(document.worldId)}`);
  const cabins = Array.isArray(document.cabins) ? document.cabins : [];
  const bound = cabins.filter((cabin) => cabin !== null && typeof cabin === "object" && nonEmpty(cabin.boundCompanionId));
  if (bound.length === 0) problems.push("no cabin names a boundCompanionId");
  if (principal !== null && nonEmpty(principal?.companionId)) {
    const mine = cabins.filter((cabin) => cabin?.boundCompanionId === principal.companionId);
    if (mine.length === 0)
      problems.push(
        `no cabin is bound to the run's companion ${JSON.stringify(principal.companionId)} (bound: ${JSON.stringify(bound.map((cabin) => cabin.boundCompanionId))})`,
      );
    else if (mine.filter((cabin) => nonEmpty(cabin.ownerFarmhandId)).length === 0)
      problems.push(`the cabin bound to ${JSON.stringify(principal.companionId)} names no ownerFarmhandId`);
  }
  if (problems.length > 0)
    return verdict(
      "inconsistent",
      REASONS.sessionInconsistent,
      `${session.file} is not the live world's identity: ${problems.join("; ")}`,
      { attempts: attempts.length, file: session.file },
    );

  const cabin = principal !== null ? bound.find((entry) => entry.boundCompanionId === principal.companionId) : bound[0];
  return verdict(
    "ready",
    null,
    `${session.file}: saveId=${String(document.saveId)} worldId=${String(document.worldId)} hostPlayerId=${String(document.hostPlayerId)} nonce=${String(document.nonce)} runtimeRole=${String(document.runtimeRole)} state=${String(document.state)}, and the companion's cabin ${JSON.stringify(cabin?.cabinId)} carries farmhandId=${String(cabin?.ownerFarmhandId)} boundCompanionId=${String(cabin?.boundCompanionId)}`,
    { attempts: attempts.length, file: session.file, document },
  );
}

/**
 * `oobe-run-enter`: the recovery journal's header binds this session's continuity, and holds no action.
 *
 * The journal's PATH is its first identity: `runEnter` opens it at
 * `<runtimeRoot>/stardew-recovery/<continuityId>/<saveId>/<worldId>/` (`continuity-semantic-game-runtime-materializer.ts:1898-1906`),
 * so the continuity id the run declared (`principal.continuityId`) and the identity the session document
 * publishes address the file exactly - no scan, and a journal under a different continuity is not read as
 * this session's.
 *
 * A HEADER ALONE IS THE CORRECT SHAPE for a run that entered the world and did not act: every action adds one
 * `record`/`admission` line. So the reading quotes how many it holds instead of demanding none - a run that
 * acted is not a failed reading, it is a different one.
 */
function recoveryJournalOf({ declaredDataRoot, principal, session }) {
  if (!nonEmpty(declaredDataRoot))
    return verdict("unreadable", REASONS.journalContinuityUnknown, "the run declared no data root, so the journal has no path");
  if (!nonEmpty(principal?.continuityId))
    return verdict(
      "unreadable",
      REASONS.journalContinuityUnknown,
      `the run declared no principal.continuityId, so no recovery journal can be addressed under ${declaredDataRoot}: the header binds a continuity this run never named`,
    );
  const document = session?.kind === "ready" ? session.reading?.document ?? null : null;
  if (document === null)
    return verdict(
      "unreadable",
      REASONS.journalContinuityUnknown,
      `the journal's path carries the session's saveId/worldId and ${SESSION_FILE} was ${String(session?.reason ?? "not read")}, so no path can be derived and none was guessed`,
    );
  const directory = path.join(declaredDataRoot, RECOVERY_ROOT, principal.continuityId, document.saveId, document.worldId);
  const file = path.join(directory, JOURNAL_FILE);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return verdict(
      "absent",
      REASONS.journalAbsent,
      `looked for ${file} (continuity ${JSON.stringify(principal.continuityId)}, save ${String(document.saveId)}, world ${String(document.worldId)}): the file is not there, so runEnter opened no journal for this session`,
      { file, directory },
    );
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return verdict(
      "unreadable",
      REASONS.journalUnreadable,
      `${file} is ${String(Buffer.byteLength(text, "utf8"))} byte(s) and its first line is not JSON`,
      { file },
    );
  }
  if (header?.kind !== "header")
    return verdict(
      "unreadable",
      REASONS.journalUnreadable,
      `${file} opens with ${JSON.stringify(header?.kind)}; the journal's first line is its header`,
      { file },
    );
  const scope = header.scope ?? {};
  const problems = [];
  if (scope.continuityId !== principal.continuityId)
    problems.push(
      `header scope.continuityId ${JSON.stringify(scope.continuityId)} is not the run's ${JSON.stringify(principal.continuityId)}`,
    );
  if (String(scope.saveId ?? "") !== String(document.saveId))
    problems.push(`header scope.saveId ${JSON.stringify(scope.saveId)} is not the session's ${JSON.stringify(document.saveId)}`);
  if (String(scope.worldId ?? "") !== String(document.worldId))
    problems.push(
      `header scope.worldId ${JSON.stringify(scope.worldId)} is not the session's ${JSON.stringify(document.worldId)}`,
    );
  if (problems.length > 0)
    return verdict("unbound", REASONS.journalUnbound, `${file}: ${problems.join("; ")}`, { file });
  const actions = lines.slice(1).filter((line) => {
    try {
      const entry = JSON.parse(line);
      return entry?.kind === "record" || entry?.kind === "admission";
    } catch {
      return true;
    }
  });
  return verdict(
    "bound",
    null,
    `${file}: header schemaVersion=${String(header.schemaVersion)} binds continuityId=${String(scope.continuityId)}/${String(scope.integrationId)}/saveId=${String(scope.saveId)}/worldId=${String(scope.worldId)} - the run's own continuity and this session's world - and the journal holds ${String(actions.length)} action line(s)${actions.length === 0 ? " (header-only: the correct shape for a run that entered the world and did not act)" : `: ${JSON.stringify(actions.slice(0, 2))}`}`,
    { file, actions: actions.length, header },
  );
}

/** The game pids THIS run recorded (`state/run-processes.jsonl`), as the authority for "her process". */
function recordedGamePids(stateDir) {
  if (!nonEmpty(stateDir)) return Object.freeze([]);
  let text;
  try {
    text = readFileSync(path.join(stateDir, "run-processes.jsonl"), "utf8");
  } catch {
    return Object.freeze([]);
  }
  const pids = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const entry = JSON.parse(line);
      if (GAME_ROLES.includes(entry?.role) && Number.isSafeInteger(entry.pid)) pids.push(entry.pid);
    } catch {
      /* a line the run's own writer did not complete is not a pid */
    }
  }
  return Object.freeze([...new Set(pids)]);
}

/** The machine's SMAPI log directory, where the Mod writes its per-run trace beside `SMAPI-latest.txt`. */
function defaultTraceDirectory() {
  const appData = process.env.APPDATA;
  return nonEmpty(appData) ? path.join(appData, "StardewValley", "ErrorLogs") : null;
}

/**
 * When the Mod that wrote a trace started, from the trace's own name.
 *
 * `ModTraceRecorder` names the file with `DateTime.Now.ToString("yyyyMMdd-HHmmss")`, so the name is the run's
 * start in LOCAL time and `new Date(y, m, d, h, m, s)` reads it back in the same zone. This is the bound that
 * makes the directory listing about THIS launch: a trace named before her client could have started is not a
 * candidate, and the file's mtime is not used for it (a long-lived process keeps flushing an old file).
 */
function traceStartMs(name) {
  const match = /^gamebuddy-trace-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.json$/u.exec(name);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

/**
 * `oobe-client-in-world`: her own process is in the world - it heard the ingress frames and was asked to present.
 *
 * WHICH TRACE IS HERS, and why the brand is not a pid. Both game processes of one launch write a
 * `gamebuddy-trace-*.json` into the same machine directory, and the run's own `state/run-processes.jsonl` does
 * not always carry the child the Mod ran in (measured: `firstjoin-r1` recorded two `StardewModdingAPI.exe`
 * loaders and the traces belong to their game children), so a pid join would be a false refusal. What IS
 * structural is the frame: `hello` is dispatched only by a process with a local bridge session, and only the
 * AI-client profile enables one (`stardew-private-bootstrap-composer.core.internal.ts:3326-3327`
 * `EnableLocalBridge: true`; the Player Host profile is authored with it off). So her trace is the one that
 * dispatches the ingress frame, and the recorded pid is reported beside it as corroboration rather than used
 * as the gate.
 *
 * The population is bounded by the trace's own start (`sinceMs`, her client cannot predate the launch): a
 * trace from an earlier attempt or a sibling lane's client is not read at all. `untilMs` closes the other end,
 * so a run re-read from disk after a LATER run wrote its own client's trace into the same directory is not
 * credited with it.
 */
function aiClientTraceOf({ traceDirectory = defaultTraceDirectory(), stateDir = null, sinceMs = null, untilMs = null } = {}) {
  if (!nonEmpty(traceDirectory))
    return verdict(
      "unreadable",
      REASONS.traceAbsent,
      "this machine declares no APPDATA, so there is no SMAPI log directory to look in for a Mod trace",
    );
  let names = [];
  try {
    names = readdirSync(traceDirectory);
  } catch {
    return verdict(
      "unreadable",
      REASONS.traceAbsent,
      `${traceDirectory} cannot be read, so no ${TRACE_PREFIX}*${TRACE_SUFFIX} was examined`,
    );
  }
  const candidates = names
    .filter((name) => name.startsWith(TRACE_PREFIX) && name.endsWith(TRACE_SUFFIX))
    .map((name) => ({ name, file: path.join(traceDirectory, name), startedAtMs: traceStartMs(name) }))
    .filter(
      (candidate) =>
        (!Number.isFinite(sinceMs) || Number(candidate.startedAtMs ?? -Infinity) >= sinceMs) &&
        (!Number.isFinite(untilMs) || Number(candidate.startedAtMs ?? Infinity) <= untilMs),
    );
  if (candidates.length === 0)
    return verdict(
      "absent",
      REASONS.traceAbsent,
      `examined ${String(names.length)} file(s) in ${traceDirectory} and none is a ${TRACE_PREFIX}*${TRACE_SUFFIX} whose own run id starts inside this run's window${Number.isFinite(sinceMs) ? ` (from ${new Date(sinceMs).toISOString()}` : " (no launch time was given"}${Number.isFinite(untilMs) ? ` to ${new Date(untilMs).toISOString()})` : ")"}`,
      { examined: names.length, considered: 0 },
    );

  const pids = recordedGamePids(stateDir);
  const readings = candidates.map((candidate) => {
    const trace = readJson(candidate.file);
    const events = Array.isArray(trace?.value?.traceEvents) ? trace.value.traceEvents : [];
    const eventPids = [...new Set(events.map((event) => Number(event?.pid)).filter((pid) => Number.isSafeInteger(pid)))];
    const dispatches = events
      .filter((event) => event?.name === "mod.dispatch")
      .map((event) => ({ type: event?.args?.type ?? null, correlationId: event?.args?.correlationId ?? null }));
    return { ...candidate, runId: trace?.value?.otherData?.runId ?? null, eventPids, dispatches };
  });
  const types = (reading) => reading.dispatches.map((dispatch) => dispatch.type);
  const withIngress = readings.filter((reading) => types(reading).includes(INGRESS_FRAMES[0]));
  if (withIngress.length === 0)
    return verdict(
      "not-hers",
      REASONS.traceNotHers,
      `${String(readings.length)} trace(s) started at or after this launch (${JSON.stringify(readings.map((reading) => reading.name))}) and none dispatches ${INGRESS_FRAMES[0]}, the frame only a process with a local bridge session hears - so none of them is her client: their dispatch types are ${JSON.stringify(readings.map((reading) => types(reading)))}`,
      { examined: names.length, considered: readings.length, pids },
    );
  const recorded = (reading) => reading.eventPids.some((pid) => pids.includes(pid));
  const hers = withIngress.find(recorded) ?? withIngress[withIngress.length - 1];
  const present = types(hers);
  const missing = [...INGRESS_FRAMES, PRESENTATION_FRAME].filter((frame) => !present.includes(frame));
  const basis = `pid ${JSON.stringify(hers.eventPids)} (${recorded(hers) ? `recorded by this run as one of ${JSON.stringify(pids)}` : `not among the game pids this run recorded ${JSON.stringify(pids)}`})`;
  if (missing.length > 0)
    return verdict(
      "incomplete",
      REASONS.traceIncomplete,
      `${hers.file} (runId ${String(hers.runId)}, ${basis}) is her client's trace and its ${String(hers.dispatches.length)} mod.dispatch span(s) carry ${JSON.stringify(present)}: ${missing.join(", ")} is not among them, so her client was not heard entering the world or asked to present`,
      { examined: names.length, considered: readings.length, file: hers.file },
    );
  return verdict(
    "in the world",
    null,
    `${hers.file} (runId ${String(hers.runId)}, ${basis}) carries ${String(hers.dispatches.length)} mod.dispatch span(s): ${JSON.stringify(hers.dispatches)}`,
    { examined: names.length, considered: readings.length, file: hers.file, dispatches: hers.dispatches },
  );
}

/**
 * The four readings as the lines a driver prints, one per fact, in chain order.
 *
 * `null` facts are named, never dropped: a run that reaches the attachment and finds no owner record must say
 * `owner_json_absent` on the same screen that says `attachment=attached`, or the absence reads as a pass.
 */
function readRunRecords({
  declaredDataRoot = null,
  principal = null,
  stateDir = null,
  sinceMs = null,
  untilMs = null,
  traceDirectory,
} = {}) {
  const attempts = readAttempts(declaredDataRoot);
  const owner = ownerAdmissionOf(attempts);
  const session = sessionIdentityOf(attempts, { principal });
  const journal = recoveryJournalOf({ declaredDataRoot, principal, session });
  const trace = aiClientTraceOf({ traceDirectory, stateDir, sinceMs, untilMs });
  return Object.freeze({ attempts: attempts.length, owner, session, journal, trace });
}

/**
 * The reading as printed lines: the four facts in chain order, then how many of them were read.
 *
 * The last line is the point of printing them together - "3 of 4 read" names a run that reached the
 * attachment with one of its own records unopened, which no single line says.
 */
function describeRunRecords(reading) {
  const facts = [FACTS.owner, FACTS.session, FACTS.journal, FACTS.trace];
  const verdicts = [reading.owner, reading.session, reading.journal, reading.trace];
  const lines = [];
  let read = 0;
  verdicts.forEach((entry, index) => {
    if (entry.reason === null) {
      read += 1;
      lines.push(`CHAIN RECORD ${facts[index]} - ${entry.detail}`);
    } else lines.push(`CHAIN RECORD ${facts[index]} - ${entry.reason}: ${entry.detail}`);
  });
  lines.push(
    `CHAIN RECORD ${String(read)} of 4 record(s) read from ${String(reading.attempts)} attempt(s)${read === 4 ? "" : `; unread: ${JSON.stringify(verdicts.filter((entry) => entry.reason !== null).map((entry) => entry.reason))}`}`,
  );
  return Object.freeze(lines);
}

module.exports = {
  ATTEMPT_ROOT,
  FACTS,
  INGRESS_FRAMES,
  JOURNAL_FILE,
  OWNER_FILE,
  PRESENTATION_FRAME,
  REASONS,
  RECOVERY_ROOT,
  SESSION_FILE,
  TRACE_PREFIX,
  TRACE_SUFFIX,
  aiClientTraceOf,
  defaultTraceDirectory,
  describeRunRecords,
  ownerAdmissionOf,
  readAttempts,
  readRunRecords,
  recordedGamePids,
  recoveryJournalOf,
  sessionIdentityOf,
  traceStartMs,
};
