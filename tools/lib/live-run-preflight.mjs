/**
 * Live-run preflight: everything that killed a run during the 2026-10-19/20 session, checked in about a second, before
 * a game process exists.
 *
 * Measured from that session's 144 result files: 23 runs ended `blocked` with ZERO wall clock - they never started - and
 * every cause was knowable from the file system:
 *
 *   - a mods directory holding two GameBuddy folders (SMAPI refuses the mod, starts the game WITHOUT it, and the run dies
 *     120 s later as `stardew_pipe_not_listening`);
 *   - a launcher pipe name that does not match the Mod's own config (the same symptom, one line of cause);
 *   - a host test artifact older than `host/src`;
 *   - a Mod bundle older than its C# sources - the worst of the four, because the run then measures code that is not the
 *     code under test and can still pass;
 *   - leftover fixture transactions and orphaned backups;
 *   - a save name whose template directory was never created.
 *
 * Each check reports a stable code, and the FIRST failure is what the caller prints: one line instead of a 25-minute
 * discovery cycle. Every check reads the file system and writes nothing; the one check about a runner's entry point
 * imports that runner in a child process, because what an import does is the property it needs (see
 * `importsWithoutStarting`).
 *
 * A text match for `import.meta.main` is satisfied by a comment, and it says nothing about a driver that starts the
 * session at top level as well - the shape that wasted the day's runs. So that check observes the import itself.
 *
 * `probeProviderReadiness` is the one check that crosses the network, and it is not part of `preflightLiveRun`: it
 * reads the root's own model profile, provider catalog and credential, then asks the provider for one model listing.
 * A provider that cannot answer is the failure that costs the most wall clock for the least evidence - two runs ended
 * `503 auth_unavailable` with zero tokens, and nothing in their results said the provider had never been asked.
 *
 * `probeGuardianPipe` is the one check that decides whether this MACHINE can run at all, and the caller passes its
 * answer in rather than having `preflightLiveRun` read it: the gate conformance suite materializes synthetic trees
 * that never launch a Host (`tools/lib/harness-conformance.mjs`), and judging those against this machine's pipe
 * namespace would red a good tree. Measured 2026-11-13: a chat live run was launched four times and every attempt
 * ended `dialogue_exited_before_ready:1:desktop_runtime_bootstrap_unavailable:guardian_pipe_unreachable`, reaching
 * no capture phase at all, while the preflight reported this tree healthy.
 *
 * Every check therefore reports one of three verdicts, not two: `passed`, `blocked` (a condition this host fails) and
 * `not_measured` (the prerequisite was absent, so nothing was measured - never a pass, and the same line
 * `tools/lib/assert-non-vacuous.mjs` draws for a gate's population). A `not_measured` check refuses the run exactly
 * as a `blocked` one does, because a run started on an unmeasured prerequisite is how four launches died.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OPERATOR_GATEWAY_PROVIDER_ID } from "./operator-gateway.mjs";
import { bridgeConfigPath, bridgePipeNameFor } from "./stardew-bridge-pipe.mjs";

/** `passed` when the condition holds; `blocked` when this host fails it; `not_measured` when nothing was measured. */
const check = (code, ok, detail) => ({ code, ok, status: ok ? "passed" : "blocked", detail });

/** The prerequisite is absent, so the check measured nothing. `ok` is false: an unmeasured run is not a startable one. */
const notMeasured = (code, condition, detail, route) => ({
  code,
  ok: false,
  status: "not_measured",
  condition,
  detail: `${condition}: ${detail}`,
  route,
});

const newestUnder = (root, match, skipDirectory) => {
  let newest = null;
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirectory(entry.name)) continue;
        walk(path, depth + 1);
      } else if (match(entry.name)) {
        const mtimeMs = statSync(path).mtimeMs;
        if (newest === null || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
      }
    }
  };
  walk(root, 0);
  return newest;
};

const stamp = (entry) => (entry === null ? "(missing)" : `${entry.path} @${new Date(entry.mtimeMs).toISOString()}`);
const freshnessDetail = (input, output, missingOutput, missingInput) => {
  if (output === null) return missingOutput;
  if (input === null) return missingInput;
  return `newest input ${stamp(input)} vs output ${stamp(output)}`;
};

const hostArtifactCheck = (hostRoot) => {
  const input = newestUnder(
    join(hostRoot, "src"),
    (name) => /\.(ts|json)$/u.test(name),
    (name) => /^(node_modules|dist-test|\.git)$/u.test(name),
  );
  const artifact = newestUnder(
    join(hostRoot, "dist-test"),
    (name) => name.endsWith(".js"),
    (name) => /^node_modules$/u.test(name),
  );
  const ok = input !== null && artifact !== null && artifact.mtimeMs >= input.mtimeMs;
  return check(
    "host_artifact_fresh",
    ok,
    freshnessDetail(input, artifact, "host/dist-test is missing — build it", "no host/src inputs found"),
  );
};

const modBundleCheck = (modRoot, releaseDir) => {
  const input = newestUnder(
    modRoot,
    (name) => name.endsWith(".cs"),
    (name) => /^(bin|obj|node_modules|\.git)$/u.test(name),
  );
  const dll = join(releaseDir, "GameBuddy.Stardew.dll");
  const output = existsSync(dll) ? { path: dll, mtimeMs: statSync(dll).mtimeMs } : null;
  const ok = input !== null && output !== null && output.mtimeMs >= input.mtimeMs;
  return check(
    "mod_bundle_fresh",
    ok,
    freshnessDetail(input, output, `no ${dll} — build the Mod`, "no C# inputs found"),
  );
};

const gameBuddyFoldersIn = (modsPath) => {
  try {
    return readdirSync(modsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^GameBuddy[.]/u.test(`${entry.name}.`))
      .map((entry) => entry.name);
  } catch (error) {
    return [`(unreadable:${String(error?.code ?? error)})`];
  }
};

const bridgeConfigCheck = (modsPath) => {
  const configPath = bridgeConfigPath(modsPath);
  if (!existsSync(configPath)) return check("bridge_config_readable", false, `no config at ${configPath}`);
  try {
    return check("bridge_config_readable", true, `PipeName=${bridgePipeNameFor(modsPath)}`);
  } catch (error) {
    return check("bridge_config_readable", false, String(error instanceof Error ? error.message : error));
  }
};

const fixtureChecks = (fixtureRoot, saveName) => {
  if (fixtureRoot === null || fixtureRoot === undefined) return [];
  let entries = [];
  try {
    entries = readdirSync(fixtureRoot);
  } catch {
    entries = [];
  }
  const orphans = entries.filter((name) => name.includes(".orphaned-"));
  const lock = entries.some((name) => name.startsWith(".stardew-native-local-player-fixture.lock"));
  const checks = [
    check("fixture_root_has_no_orphan_backups", orphans.length === 0, `${String(orphans.length)} orphaned entr(ies)`),
    check("fixture_lock_free", !lock, lock ? "a fixture transaction is still held" : "free"),
    // The recovery journal is cumulative per scope and admission records are never evicted. Once it passes its budget
    // every admission write throws, and the companion experiences that as a node that waits for ever - no code it can
    // read, no retry that helps. 811 records had accumulated by 2026-10-26 and clearing them made the same build work.
    recoveryJournalCheck(fixtureRoot),
  ];
  if (saveName !== null && saveName !== undefined) {
    const template = join(fixtureRoot, "templates", saveName);
    checks.push(check("fixture_template_present", existsSync(template), template));
  }
  return checks;
};

const ACTION_RUNNERS = Object.freeze({
  respond_level_up: "run-stardew-native-local-player-respond-level-up-smoke.mjs",
  respond_level_up_branch: "run-stardew-native-local-player-respond-level-up-branch-smoke.mjs",
  hold_absorption: "run-stardew-native-local-player-hold-absorption-smoke.mjs",
});

const RUNNER_IMPORT_TIMEOUT_MS = 30_000;

/**
 * Whether the module at `path` can be imported and starts nothing behind it.
 *
 * Imported in a child process that must exit cleanly without printing: a module whose CLI is gated runs nothing on
 * import, while a module that starts the session at top level either prints, fails, or never returns.
 */
export function importsWithoutStarting(path, { spawn = spawnSync, timeoutMs = RUNNER_IMPORT_TIMEOUT_MS } = {}) {
  if (!existsSync(path)) return { ok: false, detail: `${path} does not exist` };
  const url = pathToFileURL(resolve(path)).href;
  const result = spawn(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(url)});`], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  // One line was not enough to tell the failures apart: a throw puts the file URL on the first line and the
  // message below it, so "import exited 1: file:///…" said nothing about why. Collapsing the whole excerpt
  // keeps `import printed:` readable (stdout is one line in practice) while making a thrown reason visible -
  // which is what lets a caller tell a missing build artifact from a missing package.
  const excerpt = (text) =>
    String(text ?? "")
      .trim()
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join(" | ")
      .slice(0, 400);
  if (result.error?.code === "ETIMEDOUT") return { ok: false, detail: `import did not return in ${timeoutMs}ms` };
  if (result.status !== 0)
    return { ok: false, detail: `import exited ${String(result.status)}: ${excerpt(result.stderr)}` };
  const printed = excerpt(result.stdout);
  if (printed !== "") return { ok: false, detail: `import printed: ${printed}` };
  return { ok: true, detail: "imported with nothing started" };
}

/**
 * The provider a saved model profile resolves to. A profile stores only the model id and the thinking level, so the
 * provider is the product's own resolution (`resolveModelProfileConfig`, host/src/settings/model-profile-store.ts:114).
 */
const PROFILE_PROVIDER = OPERATOR_GATEWAY_PROVIDER_ID;
const PROVIDER_PROBE_TIMEOUT_MS = 10_000;

const readJsonIfPresent = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
};

/** The model this root's Game profile names, or null when it names none. */
async function readProfileModel(runtimeRoot) {
  const profile = await readJsonIfPresent(join(runtimeRoot, "settings", "model-profiles.json"));
  const modelId = profile?.game?.modelId;
  return typeof modelId === "string" && modelId.length > 0 ? modelId : null;
}

/** One provider entry of Pi's own `models.json`: the endpoint it serves and the model ids it lists. */
async function readProviderCatalog(agentDir, provider) {
  const catalog = await readJsonIfPresent(join(agentDir, "models.json"));
  const entry = catalog?.providers?.[provider];
  if (entry === null || typeof entry !== "object") return null;
  const modelIds = Array.isArray(entry.models)
    ? entry.models.map((model) => model?.id).filter((id) => typeof id === "string")
    : [];
  return Object.freeze({ baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : null, modelIds });
}

/** The credential Pi reads for that provider: `auth.json` sits beside `models.json` in the identity's agent dir. */
async function readProviderCredential(agentDir, provider) {
  const auth = await readJsonIfPresent(join(agentDir, "auth.json"));
  const key = auth?.[provider]?.key;
  return typeof key === "string" && key.length > 0 ? key : null;
}

/**
 * Whether the provider this root's model profile names can answer at all, asked BEFORE the first model turn.
 *
 * Two measured runs ended `503 auth_unavailable` with zero tokens and zero player-visible text, and their result files
 * could not say whether the provider had ever been asked anything. The readiness is therefore resolved from the files
 * the runtime itself reads - the Game profile's model id, the provider entry in Pi's `models.json`, the credential in
 * `auth.json` beside it - and then confirmed against the endpoint with one minimal request.
 *
 * Each reason is a different repair, which is why it is named:
 *   `profile-invalid`  the profile names no model, so nothing says what to check
 *   `missing-model`    the provider's catalog does not list the model the profile names
 *   `auth`             no credential for that provider, or the endpoint refused it (401/403)
 *   `unreachable`      no endpoint, a transport failure, a timeout, or any other non-2xx answer
 *   `ready`            the endpoint answered
 *
 * Read-only, and it never spawns anything: the refusal is the caller's decision, made before a turn or a runtime exists.
 *
 * The saved profile is the authority here. A player's active connection overrides provider and model when the Game
 * attachment builds its runtime (`game-runtime-attachment.ts:107`), so a root that carries one is checked against the
 * profile instead: reading the connection record would mean re-deriving a product path this tool does not own.
 */
export async function probeProviderReadiness({
  runtimeRoot,
  agentDir,
  transport = fetch,
  timeoutMs = PROVIDER_PROBE_TIMEOUT_MS,
}) {
  const provider = PROFILE_PROVIDER;
  const model = await readProfileModel(runtimeRoot);
  if (model === null) return Object.freeze({ ok: false, provider, model: null, reason: "profile-invalid" });
  const catalog = await readProviderCatalog(agentDir, provider);
  if (catalog === null || !catalog.modelIds.includes(model))
    return Object.freeze({ ok: false, provider, model, reason: "missing-model" });
  const apiKey = await readProviderCredential(agentDir, provider);
  if (apiKey === null) return Object.freeze({ ok: false, provider, model, reason: "auth" });
  if (catalog.baseUrl === null) return Object.freeze({ ok: false, provider, model, reason: "unreachable" });
  const answer = await requestModelListing(catalog.baseUrl, apiKey, transport, timeoutMs);
  return Object.freeze({ ok: answer === null, provider, model, reason: answer ?? "ready" });
}

/** `null` when the endpoint answered; otherwise the refusal reason. Its body is never read, so no provider text escapes. */
async function requestModelListing(baseUrl, apiKey, transport, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await transport(`${baseUrl.replace(/\/+$/u, "")}/models`, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    });
    if (response.ok === true) return null;
    return response.status === 401 || response.status === 403 ? "auth" : "unreachable";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

/** The name a caller refuses with, so a refused run says which provider and model never answered, and why. */
export function providerReadinessRefusal(readiness) {
  return `provider_not_ready:${readiness.provider}:${readiness.model ?? "unknown"}:${readiness.reason}`;
}

/* ------------------------------------------------------------------ the Desktop guardian endpoint */

/**
 * The endpoint prefix of the Host's one authenticated guardian session.
 *
 * The endpoint is `\\.\pipe\GameBuddy.HostGuardian.<bootstrapId>`, and it has exactly two owners in this tree:
 *
 *   - the SERVER, only inside the native Desktop supervisor -
 *     `desktop/GameBuddy.Desktop/DesktopHostBootstrapBroker.cs:47` creates
 *     `GameBuddy.HostGuardian.<bootstrapId>` with `FirstPipeInstance | CurrentUserOnly`;
 *   - the CLIENT, the Host's own bootstrap - `host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts:621`
 *     connects to that name, and a refused connect is `guardian_pipe_unreachable` (:904).
 *
 * Nothing else derives a name of its own here: the bootstrap id is opaque and minted per launch
 * (`tools/desktop-composition-launch.mjs:769`), so reachability is read from the OS pipe namespace rather than
 * from a name this file could build. `live-run-preflight.test.mjs` holds every file that spells the prefix, so a
 * rename on the product side goes red here instead of silently matching nothing.
 *
 * The gate launcher binds a look-alike endpoint for a launch it drives (`tools/desktop-composition-launch.mjs:508`)
 * and answers `hello` only: any `arm_attempt` / `launch_role` / `contain_role` frame destroys the socket (:542-545),
 * because forging those would forge Stardew containment.
 */
export const GUARDIAN_ENDPOINT_PREFIX = "GameBuddy.HostGuardian.";

const WINDOWS_NAMED_PIPE_DIRECTORY = "\\\\.\\pipe\\";

/**
 * Whether a Desktop guardian endpoint is bound on this machine right now, read without launching anything.
 *
 * Read-only, and deliberately never connects. The production broker authenticates the FIRST client on that
 * one-shot pipe by comparing its process id and session with the child it launched and refuses anything else
 * (`DesktopHostBootstrapBroker.cs:63-67`), so a probe that dialled an in-flight launch's endpoint would break the
 * launch it was checking.
 *
 * `examined` travels with the answer on purpose: "no endpoint" is only a measurement of a namespace that was
 * actually read, and `unreadable` names the case where it was not.
 */
export function probeGuardianPipe({
  readPipeDirectory = () => readdirSync(WINDOWS_NAMED_PIPE_DIRECTORY),
  prefix = GUARDIAN_ENDPOINT_PREFIX,
} = {}) {
  let names;
  try {
    names = readPipeDirectory();
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : String(error?.message ?? error);
    return Object.freeze({ endpoints: Object.freeze([]), examined: 0, unreadable: code });
  }
  const endpoints = [...names]
    .map((name) => String(name))
    .filter((name) => name.startsWith(prefix))
    .sort();
  return Object.freeze({ endpoints: Object.freeze(endpoints), examined: names.length, unreadable: null });
}

/**
 * The operator's two routes to a run, printed when no guardian endpoint is bound.
 *
 * The first is the product path: the Desktop supervisor owns the endpoint and is the only thing that can answer
 * `arm_attempt` / `launch_role` / `contain_role`. The second exists and is named rather than implied, because it is
 * a real route for a chat-only run and a dead one for anything that arms, launches or contains a game.
 */
const GUARDIAN_OPERATOR_ROUTE = Object.freeze([
  "start the native Desktop supervisor - it is the only server of this endpoint (desktop/GameBuddy.Desktop/DesktopHostBootstrapBroker.cs:47)",
  "or drive a chat-only run through tools/desktop-composition-launch.mjs, which binds the same endpoint for the launch it drives and answers hello only: it destroys the socket on any arm_attempt/launch_role/contain_role frame (tools/desktop-composition-launch.mjs:542-545), so it cannot carry a run that arms, launches or contains a game",
]);

/**
 * The guardian reading as a check. A bound endpoint passes; an absent or unreadable namespace is `not_measured`.
 *
 * The absent case names the condition the product will fail with (`guardian_pipe_unreachable`) and what it costs
 * the run: the guardian session is the Host's second bootstrap stage, before the composition exists, so nothing is
 * captured and `INJECTION` and `RECONCILIATION` would be unobserved rather than passing.
 */
const guardianCheck = (probe) => {
  if (probe.endpoints.length > 0)
    return check(
      "guardian_pipe_reachable",
      true,
      `${String(probe.examined)} named pipe(s) examined; bound: ${probe.endpoints.join(", ")}`,
    );
  const examined =
    probe.unreadable === null
      ? `${String(probe.examined)} named pipe(s) examined`
      : `pipe namespace unreadable:${probe.unreadable}`;
  return notMeasured(
    "guardian_pipe_reachable",
    "guardian_pipe_unreachable",
    `${examined}; no ${GUARDIAN_ENDPOINT_PREFIX}* endpoint is bound, so the Host's guardian-session bootstrap stage cannot connect (host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts:621) and the run dies dialogue_exited_before_ready:1:desktop_runtime_bootstrap_unavailable:guardian_pipe_unreachable before any capture phase - INJECTION and RECONCILIATION would be unobserved, not passing`,
    GUARDIAN_OPERATOR_ROUTE,
  );
};

const runnerCheck = (action) => {
  const runner = ACTION_RUNNERS[action];
  if (runner === undefined) return [check("smoke_runner_resolves", false, `no runner known for ${action}`)];
  const path = join("tools", runner);
  const present = existsSync(path);
  const imported = present ? importsWithoutStarting(path) : { ok: false, detail: `${path} does not exist` };
  return [check("smoke_runner_resolves", present, path), check("smoke_runner_has_cli", imported.ok, imported.detail)];
};

/** Runs every check in order; `ok` is true only when all pass, and `firstFailure` is what a caller prints. */
/**
 * Whether the recovery journal under this fixture root's runtime has room left.
 *
 * The journal lives at `<runtimeRoot>/stardew-recovery/<identity>/<player>/<companion>/`, and `stardew-fixtures` is a
 * sibling of `stardew-recovery` inside that same root. Budget is 1 MB by default (`DEFAULT_MAX_BYTES`), and admitted
 * records are never evicted - so the only recovery is to clear it, which this check can name but must not do.
 */
const recoveryJournalCheck = (fixtureRoot) => {
  const budgetBytes = 1024 * 1024;
  const runtimeRoot = fixtureRoot === null || fixtureRoot === undefined ? null : resolve(fixtureRoot, "..");
  if (runtimeRoot === null) return check("recovery_journal_within_budget", true, "no fixture root to derive it from");

  const journals = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.name.includes("recovery-journal")) continue;
      try {
        journals.push({ path: full, size: statSync(full).size });
      } catch {
        /* unreadable is not over budget */
      }
    }
  };
  walk(join(runtimeRoot, "stardew-recovery"), 0);

  const over = journals.filter((entry) => entry.size >= budgetBytes);
  return check(
    "recovery_journal_within_budget",
    over.length === 0,
    over.length === 0
      ? `${String(journals.length)} journal(s) within budget`
      : `${String(over.length)} journal(s) at or over ${String(budgetBytes)} bytes: ${over.map((entry) => `${entry.path} (${String(entry.size)})`).join(", ")} - clear it; admission will hang otherwise`,
  );
};

export function preflightLiveRun(options) {
  const {
    modsPath,
    fixtureRoot = null,
    releaseDir,
    action = null,
    saveName = null,
    runningGameProcesses = 0,
    hostRoot = "host",
    modRoot = "integrations/stardew",
    guardian = null,
  } = options;

  const folders = gameBuddyFoldersIn(modsPath);
  const oneFolder = folders.length === 1 && !folders[0].startsWith("(");
  const checks = [
    // First because it is the one failure no rebuild repairs: a stale artifact is fixed by building, and a machine
    // with no guardian endpoint is not. Reported first, the operator reads the cause rather than a symptom of it.
    ...(guardian === null ? [] : [guardianCheck(guardian)]),
    hostArtifactCheck(hostRoot),
    modBundleCheck(modRoot, releaseDir),
    check(
      "mods_path_exactly_one_gamebuddy",
      oneFolder,
      folders.length === 0 ? "no GameBuddy folder" : folders.join("+"),
    ),
    ...(oneFolder ? [bridgeConfigCheck(modsPath)] : []),
    ...fixtureChecks(fixtureRoot, saveName),
    ...(runningGameProcesses > 0
      ? [check("no_game_process_running", false, `${String(runningGameProcesses)} process(es)`)]
      : []),
    ...(action === null ? [] : runnerCheck(action)),
  ];
  return Object.freeze({
    ok: checks.every((entry) => entry.ok),
    checks: Object.freeze(checks),
    firstFailure: checks.find((entry) => !entry.ok) ?? null,
  });
}
