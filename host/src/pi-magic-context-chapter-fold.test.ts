/**
 * CI fold fixture for the chapter rollup (owner ruling H).
 *
 * The chapter rollup only exists when the historian really folds, and Magic Context's fold trigger
 * is a fraction of the model's usable range - 65% of it by default, which on the product's
 * million-token model is roughly 487,000 tokens of context. No test can reach that, and the
 * production trigger stays at the upstream default on purpose (measured: after a five-turn live run
 * `times_execute_threshold_reached = 0`, `compartments = 0`).
 *
 * The only seam that can compress the trigger is the Host's own
 * `internalMagicContextFeatureTestOverride`: private to composition and deliberately unreachable
 * from operator/browser config and from the Desktop child. That is why this fixture is IN-PROCESS
 * and provider-backed rather than a live-loop flag: from outside, neither a user-scope Magic Context
 * config nor a project one can lower the trigger (the Host rewrites the project file at mount, and
 * the user file is not merged on this path), and `protected_tokens` alone has a 4000-token floor
 * that a small conversation can never exceed.
 *
 * What it asserts is exactly H's claim: one real fold happened (a chapter sealed and reached m[0]),
 * and the m[0] prefix stayed byte-stable within each materialization revision.
 *
 * OPEN FINDING (measured 2026-10-08, this fixture). Three of the fold's inputs are USER-tier trusted
 * keys, and the Host writes only the PROJECT config - so a fixture must supply its own user tier or
 * it measures nothing:
 *
 *   - `execute_threshold_tokens`: "a repository may only RAISE execute_threshold_tokens above the
 *     user's trusted token threshold; it cannot force earlier historian work or cloned-repo cost
 *     escalation." A project value of 6000 was ignored outright (vendor loader, verified warning).
 *   - `historian.pi.model`: "historian model selection is user-level only". Ignored from project
 *     scope, and without it the historian does not resolve, so the trigger is never evaluated.
 *   - `protected_tokens`: accepted from project scope, but must be supplied together with the above.
 *
 * This fixture now supplies all of them from an isolated user tier (its own XDG_CONFIG_HOME), which
 * also makes it hermetic - otherwise it silently inherits the operator's own user config, and this
 * machine's sets an 800k threshold, so no fold could ever happen.
 *
 * With that fixed, probing the vendor's own decision (an ESM-safe global, since patching its bundle
 * with `require` silently swallows the writes) answered where it was stuck:
 *
 *   pass  1: "compartment trigger: not firing at 0.1% because unsummarized tail from 1 is too small"
 *   ...
 *   pass 29: "compartment trigger: proactive fire at 2.2% (floor=0% projected post-drop=none ...)"
 *
 * So the trigger DOES fire - but only once the ELIGIBLE tail above the protected boundary outgrows the
 * budget (about 1.4% of the 750k window here, a few turns after the raw usage first crossed the
 * threshold), and the historian then runs ASYNCHRONOUSLY: the firing pass is never the pass that shows
 * a chapter. The chapter appears in a m[0] rendered after the historian publishes.
 *
 * What remains is therefore mechanical, not mysterious: keep turning until a chapter marker appears
 * (the loop below does, bounded), and confirm the fixture both waits correctly and stays honest when
 * the historian never publishes. That last verification is NOT finished - this test still reports the
 * open finding rather than a verdict, and must not be read as evidence either way.
 *
 * MEASURED 2026-10-08 (decisive run, `GAMEBUDDY_CHAPTER_FOLD_FORCE=1`, root kept): 59 passes,
 * `last_input_tokens = 16186`, `last_context_percentage = 2.16%` - well past the trigger, and the
 * vendor logged `proactive fire` from pass 29 onward - yet `compartments = 0` and no chapter ever
 * reached m[0].
 *
 * ANSWER (same run): `historian_runs = 0` rows. That table is written once in the runner's `finally`
 * on EVERY exit path, so zero rows means the runner was never dispatched - and the vendor's own code
 * says why, right after the trigger returns shouldFire:true (context-handler.ts:4846):
 *
 *   // Headless Pi exits after agent_end without dispatching session_shutdown.
 *   // Leave the eligible history in the store for the next interactive pass.
 *   if (!ctx.hasUI) return;
 *
 * A headless Pi host therefore never spawned the historian, and GameBuddy's embedded runtime is such a
 * host - so on it no compartment was ever created, the decayed-history block stayed empty, and no
 * chapter could be sealed, whatever `execute_threshold_*` was set to.
 *
 * FIXED IN THE FORK (`packages/pi-plugin/src/pi-background-run-lifetime.ts`, vendor 58c213a61): the
 * gate now asks whether the host OUTLIVES a background run rather than whether it has a UI, and accepts
 * an embedded host's own declaration. Measured after that change on this fixture: `historian_runs` went
 * from 0 to 62 rows, so the gate was the binding constraint.
 *
 * TWO CONDITIONS REMAIN, both measured on the same run, neither of them the gate:
 *
 *   1. `failed` with `failure_reason = null` and `subagent_invocation_id = null` (2 of the 62 runs):
 *      the embedded historian attempt fails without recording why.
 *   2. `noop` with `internal protected-tail drain budget spent` (60 of the 62): pacing. See the drain
 *      window note in the body - one 10-minute window authorizes about 4000 tokens at this fixture's
 *      geometry.
 *
 * RESOLVED 2026-10-09. (1) first became diagnosable at all - the runner's telemetry default was
 * `status: "failed"` with no reason, so exits that logged their cause still wrote a reason-less row
 * (vendor 259cbc9d9) - and then said exactly what it meant:
 *
 *   subagent run failed (spawn_failed): embedded historian ModelRegistry is not bound
 *
 * Two independent causes, both in the fork (vendor ece542146): Pi evaluates an extension through jiti
 * with `moduleCache: false`, so the binding the Host installed through the documented seam landed in a
 * module evaluation nothing reads (which is also why that seam had no callers); and
 * `resolveContextOptionsForProject` rebuilds the historian on every pass, so the instance
 * `bindHistorianRunner` ever bound is not the instance the trigger runs. The registry is now
 * process-wide and the runner falls back to it at run time. The Host binds it after session
 * construction (`runtime-core.internal.ts`), non-fatally but visibly.
 *
 * MEASURED after that fix, same fixture: `historian_runs = success x2 produced=2`, `compartments = 2`,
 * and this test PASSES - a real fold sealed a chapter, the chapter reached m[0], and the m[0] prefix
 * stayed byte-stable within each materialization revision. (2) turned out not to block: with the runner
 * actually spawning, the first triggers succeeded rather than being held by the drain budget.
 *
 * LIFECYCLE (measured 2026-10-14, this machine, real provider): the body takes 340.7s end to end, so
 * every bound imposed from outside either kills the `finally` with the process (the Host suite bounds
 * each file with `runBoundedChild` against the shared suite deadline) or reports the timeout and then
 * waits the body out (Node's `--test-timeout`, which fired at 180s here and left the root behind
 * anyway). The fixture therefore bounds its own body (`GAMEBUDDY_CHAPTER_FOLD_DEADLINE_SECONDS`, default
 * 600) so that expiry is an ordinary failure whose `finally` still runs.
 *
 * RUNNING THE `finally` IS NOT ENOUGH TO REMOVE THE ROOT, which is the second half of the incident. The
 * runtime holds `data/cortexkit/magic-context/context.db` open, and the vendor releases it only from
 * its own `process.once("exit", closeDatabase)` (vendor pi-plugin `src/index.ts:1176-1179`), so on
 * Windows every `rm` inside the body fails with `EBUSY ... context.db` - a fully passing run leaves its
 * root behind, and the old `.catch(() => undefined)` made that silent. The removal therefore runs from
 * a process-exit hook registered after the vendor's (see the `finally`), and that hook is where the
 * lifecycle assertion lives: it removes the root synchronously and, if the root is still there, writes
 * the failure synchronously and fails the run's exit code.
 */
import assert from "node:assert/strict";
import { existsSync, realpathSync, rmSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createCompanionRuntime, resolveRuntimePaths, type CompanionIdentity } from "./runtime.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

/**
 * The root these cases build in - the same shape the Host's own launcher uses, because the product
 * verifies it. `%LOCALAPPDATA%` on Windows (a path the OS authored, so already canonical), the temp
 * directory elsewhere; canonicalizing `tmpdir()` alone is not enough on a CI runner (measured: the
 * fold cases still failed `unsafe_path_boundary` with that fix in place).
 */
function canonicalRootParent(): string {
  const root = process.platform === "win32" ? (process.env.LOCALAPPDATA ?? tmpdir()) : tmpdir();
  return realpathSync(root);
}
import { createGameBuddyPlayerMemoryCrudFacade } from "@cortexkit/pi-magic-context/memory";

const apiKey = process.env.CPA_OAI_API_KEY;
const identity = Object.freeze({
  // Production's chat runtime carries a continuity id, and the Host only declares the memory
  // partition when it is present. WITHOUT it the plugin falls back to a git-root walk from a
  // temporary directory - finds no project, and memory plus the historian stay off. A fixture
  // without it measures nothing, which is what this one did until it was added.
  continuityId: "continuity_01",
  playerId: "player_01",
  saveId: "save_01",
  worldId: "world_01",
  companionId: "companion_01",
} satisfies CompanionIdentity);

/**
 * One turn of ordinary conversation, sized so a handful of them cross the fixture trigger.
 *
 * Deliberately lean. An earlier version of this filler also carried relationship content (an explicitly
 * stated preference and an observation) to inspect what the fold kept, and that measurement succeeded -
 * the sealed compartment read back "the player twice stated plainly that they hate going down into the
 * mines, and that rainy mornings are their favourite thing about the valley" (recorded in
 * design/architecture/airp-memory-evolution-architecture.md 4.3). Keeping it in THIS fixture made the
 * conversation heavy enough that the second fold no longer fit inside one protected-tail drain window,
 * and this gate is about the fold sealing a chapter, not about content - so the content measurement
 * stays a recorded one-off.
 */
function filler(index: number): string {
  return (
    `Filler turn ${index} of a long stretch of ordinary small talk. We talked about the weather, ` +
    `the state of the road, the price of copper, and how the lanterns need trimming before the ` +
    `season turns. We compared two suppliers, argued mildly about the colour of the shutters, and ` +
    `agreed to leave the upper room closed for another week. Nothing here is a fact worth keeping. `
  ).repeat(6);
}

type Marker = Readonly<{ line: string }>;

/** Capture the vendor's own materialization markers, which it writes to stderr. */
async function captureMarkers(run: (markers: Marker[]) => Promise<void>): Promise<readonly Marker[]> {
  const markers: Marker[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const line of text.split("\n")) if (line.includes("[probe:")) markers.push({ line: line.trim() });
    return true;
  }) as typeof process.stderr.write;
  try {
    // The callback receives the live array, so a wait loop inside it can inspect what has arrived so
    // far. Reading the OUTER binding that this call is still assigning is a temporal-dead-zone error,
    // which is how the first version of that loop reported `Cannot access 'markers' before
    // initialization` instead of a fold result.
    await run(markers);
  } catch (error) {
    // Carry the markers seen so far into the failure: a run that died mid-loop must not be
    // indistinguishable from one whose historian never published (that hid a real error for a
    // whole iteration earlier).
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} | markersBeforeFailure=${markers.length}`,
    );
  } finally {
    process.stderr.write = original;
  }
  return markers;
}

test(
  "a real fold seals a chapter and keeps the m[0] prefix byte-stable (CI fold fixture)",
  {
    // Opt-in only. The fixture spends a real historian model call and, measured here, 340.7s of body
    // time, and CI sets no provider credential - so gating it on the credential alone meant it never
    // ran in CI while every developer machine that had one paid for both in each suite run. Run it
    // deliberately with `GAMEBUDDY_CHAPTER_FOLD_FORCE=1`; the credential is still required on that
    // path, and its absence is a named skip rather than an obscure failure inside the body.
    skip:
      process.env.GAMEBUDDY_CHAPTER_FOLD_FORCE === "1"
        ? apiKey === undefined
          ? "GAMEBUDDY_CHAPTER_FOLD_FORCE=1 is set but CPA_OAI_API_KEY is absent: this fixture runs real provider turns"
          : false
        : "opt-in only (GAMEBUDDY_CHAPTER_FOLD_FORCE=1): a real historian model call and about 340s of body time",
  },
  async () => {
    // Narrowed after the skip guard: the closure below must not see `string | undefined`.
    if (apiKey === undefined) throw new Error("requires CPA_OAI_API_KEY");
    const key = apiKey;
    bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
    let runtime: Awaited<ReturnType<typeof createCompanionRuntime>> | undefined;
    let bodyFailed = false;
    const root = await mkdtemp(join(canonicalRootParent(), "gamebuddy-chapter-fold-"));
    // The fixture's own bound on its body, and the reason it exists: a bound imposed from outside is
    // not a failure this test can survive. Node reports `--test-timeout` and then waits for the body,
    // so the run looks stalled for minutes; a runner that does kill the process (the Host suite's
    // per-file `runBoundedChild`) kills the `finally` with it, so the runtime's root and its handles
    // outlive the run and the next run inherits the debris. Measured here: 340.7s of body, so the
    // default is a whole minute-scale budget rather than a few seconds. Raise it with
    // `GAMEBUDDY_CHAPTER_FOLD_DEADLINE_SECONDS` on a slower machine or a stricter provider.
    const configuredDeadlineSeconds = Number.parseInt(process.env.GAMEBUDDY_CHAPTER_FOLD_DEADLINE_SECONDS ?? "600", 10);
    const budgetMs =
      (Number.isSafeInteger(configuredDeadlineSeconds) && configuredDeadlineSeconds > 0
        ? configuredDeadlineSeconds
        : 600) * 1_000;
    const bodyStartedAt = Date.now();
    const bodyDeadline = bodyStartedAt + budgetMs;
    const secondsSince = (from: number): string => ((Date.now() - from) / 1_000).toFixed(1);
    // Collected rather than written: `captureMarkers` owns stderr for the whole body, so the phase log
    // is flushed by the `finally` on every exit path - including the deadline failure, whose entire
    // value is naming the phase that spent the budget.
    const phases: string[] = [];
    const phase = (name: string, from?: number): void => {
      phases.push(
        `phase=${name} at=${secondsSince(bodyStartedAt)}s` +
          (from === undefined ? "" : ` delta=${secondsSince(from)}s`),
      );
    };
    const deadlineExpired = (name: string): string =>
      `chapter_fold_fixture_deadline_expired: ${name} after ${secondsSince(bodyStartedAt)}s (budget ${budgetMs / 1_000}s)`;
    /**
     * Run one phase inside the fixture's own budget. Nothing here is cancellable - a provider turn in
     * flight cannot be recalled - so expiry abandons the work and lets the `finally` dispose the
     * session that owns it, instead of the process being killed with no `finally` at all.
     */
    const bounded = async <T>(name: string, work: Promise<T>): Promise<T> => {
      const remainingMs = bodyDeadline - Date.now();
      if (remainingMs <= 0) throw new Error(deadlineExpired(name));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(deadlineExpired(name))), remainingMs);
          }),
        ]);
      } finally {
        // Cleared on both paths, so the fixture's own bound can never outlive the phase it bounds.
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    // Magic Context treats the fold trigger as a USER-tier trusted key, and its rule is explicit:
    // No isolated user tier here on purpose. The runtime owns its Magic Context user-scope config
    // inside its own root and the Host points XDG_CONFIG_HOME at it (runtime-core.internal.ts), so
    // supplying one from the fixture would test the fixture instead of the product - and would hide
    // exactly the inheritance this run has to rule out: `~/.config/cortexkit/magic-context.jsonc` on
    // whatever machine runs this, which sets an 800k fold threshold and a historian model of its own.
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    // The embedded host's own declaration, and the one the fork's historian gate now asks for: this
    // process owns its lifetime and disposes the session (dispatching session_shutdown), so a
    // fire-and-forget historian run can be seen through instead of being killed at exit. Production
    // sets it for the composed child; the fixture must not silently rely on the ambient value.
    const previousEmbeddedRuntime = process.env.GAMEBUDDY_EMBEDDED_RUNTIME;
    process.env.GAMEBUDDY_EMBEDDED_RUNTIME = "1";
    // Magic Context resolves its PROJECT config from the session's working directory, and the Host
    // writes that config into the CONTEXT directory (`<root>/contexts/<hash>/.cortexkit/...`), which is
    // what a composed child's cwd is. Measured: without this the plugin read nothing and the fold
    // trigger stayed at the 65% default even though the fixture's config file asked for 6000 tokens.
    const contextDir = dirname(resolveRuntimePaths(identity, root).agentDir);
    await mkdir(contextDir, { recursive: true });
    const previousCwd = process.cwd();
    process.chdir(contextDir);
    try {
      // The provider credential, exactly where the runtime reads it.
      const agentDir = resolveRuntimePaths(identity, root).agentDir;
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "cpa-oai": { type: "api_key", key } }), "utf8");
      const markers = await captureMarkers(async (markers) => {
        const runtimeStartedAt = Date.now();
        runtime = await bounded(
          "runtime_create",
          createCompanionRuntime(
            identity,
            root,
            undefined,
            { provider: "cpa-oai", modelId: "deepseek-v4.1-flash", thinkingLevel: "low" },
            undefined,
            undefined,
            false,
            undefined,
            "chat_session_01",
            undefined,
            "chat",
            // The private composition seam: compress BOTH window-derived quantities so a real fold fits
            // in a test. The trigger alone is not enough - see `historianProtectedTokens`.
            { historianExecuteThresholdTokens: 6_000, historianProtectedTokens: 4_000 },
          ),
        );
        phase("runtime_create", runtimeStartedAt);
        // Thirty turns, and the number is measured rather than guessed. Magic Context's own log gives
        // the reason on each pass it declines:
        //   "compartment trigger: not firing at 0.4% because unsummarized tail from 1 is too small"
        //   "compartment trigger: proactive fire at 1.4% (floor=0% projected post-drop=none target=0.6%)"
        // So the trigger needs the ELIGIBLE tail (above the protected boundary) to reach the budget,
        // which at this window geometry happens around 1.4% of 750k tokens - a few turns past the
        // moment the raw usage first crossed the threshold. The historian then runs asynchronously and
        // the chapter appears in a LATER pass's m[0], which is why the loop keeps prompting.
        for (let index = 1; index <= 30; index += 1) {
          const turnStartedAt = Date.now();
          await bounded(`prompt_${index}`, runtime.session.prompt(filler(index)));
          phase(`prompt_${index}`, turnStartedAt);
        }
        // The historian runs ASYNCHRONOUSLY (fire-and-forget), so a chapter can only appear in a m[0]
        // rendered AFTER it publishes - the firing pass is never the pass that shows it.
        // The wait has to span DRAIN WINDOWS, not just a few turns: Magic Context authorizes
        // protected-tail draining per 10-minute window (`DRAIN_WINDOW_MS = 10 * 60 * 1000`) with a
        // budget of `min(500k, max(perRunCap, 20% of usable))`, and every attempt inside a spent
        // window returns `noop` with `internal protected-tail drain budget spent`. Measured with this
        // fixture's compressed trigger (usable ~6000 tokens), one window authorizes about 4000 tokens
        // while the eligible tail is far larger, so a fold needs several windows - which is why this is
        // a nightly gate and not a per-commit test. The budget defaults to five minutes and is raised
        // with `GAMEBUDDY_CHAPTER_FOLD_WAIT_MINUTES` on a CI job that can afford it.
        // The wait has to span DRAIN WINDOWS, not just a few turns: Magic Context authorizes
        // protected-tail draining per 10-minute window (`DRAIN_WINDOW_MS = 10 * 60 * 1000`) with a
        // budget of `min(500k, max(perRunCap, 20% of usable))`. Measured after the registry fix, the
        // first triggers succeed inside the first window, so five minutes is generous headroom rather
        // than a requirement - raise it with `GAMEBUDDY_CHAPTER_FOLD_WAIT_MINUTES` if a machine is slow.
        const waitMinutes = Number.parseInt(process.env.GAMEBUDDY_CHAPTER_FOLD_WAIT_MINUTES ?? "5", 10);
        const deadline = Date.now() + Math.max(1, waitMinutes) * 60_000;
        while (Date.now() < deadline) {
          if (markers.some(({ line }) => /^\[probe:m0_chapters\]\s+\S+\s+[1-9]/u.test(line))) break;
          await bounded("chapter_wait_sleep", new Promise((resolve) => setTimeout(resolve, 30_000)));
          const turnStartedAt = Date.now();
          await bounded("chapter_wait_prompt", runtime.session.prompt("Still here?"));
          phase("chapter_wait_prompt", turnStartedAt);
        }
        phase("chapter_wait_exit");
      });
      const chapterLines = markers
        .map(({ line }) => /^\[probe:m0_chapters\]\s+(\S+)\s+(\d+)\s+(\S+)$/u.exec(line))
        .filter((match) => match !== null);
      const digests = markers
        .map(({ line }) => /^\[probe:m0_digest\]\s+([a-f0-9]{64})\s+(\S+)$/u.exec(line))
        .filter((match) => match !== null);
      // The fixture is only meaningful if the run produced markers at all: no markers means the
      // probe path failed, which this must report rather than read as "no fold".
      assert.ok(digests.length > 0, "the run reported no m[0] digest marker at all");
      assert.ok(chapterLines.length > 0, "the run reported no chapter marker at all");
      let chapterCounts: number[] = [];
      let revisionCount = 0;
      try {
        chapterCounts = chapterLines.map((match) => Number(match?.[2] ?? "0"));
        assert.ok(
          Math.max(...chapterCounts) >= 1,
          `no chapter reached m[0]; observed counts ${JSON.stringify(chapterCounts)}`,
        );
      } catch (error) {
        // Failure-path evidence. The previous version of this wait did its bookkeeping AFTER the point
        // a failure occurred, so a failing run reported nothing but the assertion - which is how a run
        // that was silently broken inside the prompt loop looked identical to one where the historian
        // simply never published. Name what was actually observed.
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} | passes=${digests.length}` +
            ` revisions=${revisionCount} chapterCounts=${JSON.stringify(chapterCounts)}` +
            ` firstDigest=${digests[0]?.[1]?.slice(0, 12) ?? "none"}` +
            ` lastDigest=${digests.at(-1)?.[1]?.slice(0, 12) ?? "none"}`,
        );
      }
      // Byte stability is judged PER REVISION: a revision change IS the fold, not a defect.
      const perRevision = new Map<string, Set<string>>();
      for (const match of digests) {
        const digest = match?.[1];
        const revision = match?.[2];
        // Both are non-optional in the pattern above; this only keeps the types honest.
        if (digest === undefined || revision === undefined) continue;
        const set = perRevision.get(revision) ?? new Set<string>();
        set.add(digest);
        perRevision.set(revision, set);
      }
      revisionCount = perRevision.size;
      for (const [revision, seen] of perRevision) {
        assert.equal(seen.size, 1, `revision ${revision} rendered ${seen.size} different m[0] byte images`);
      }

      // The panel's OWN path against this real fold: the same read the management surface calls, then the
      // player's two corrections. This is what makes the fold gate evidence for the feature a player sees,
      // instead of evidence that a database table was written.
      const profileBinding = {
        continuityId: identity.continuityId,
        // The runtime's OWN working directory, which is what the panel resolves its continuity path
        // from: passing the temp root resolved a different project and read an empty history.
        runtimeCwd: resolveRuntimePaths(identity, root).runtimeCwd,
        profileId: "chat",
        profileRevision: 1,
      };
      const facade = createGameBuddyPlayerMemoryCrudFacade(profileBinding);
      const panelStartedAt = Date.now();
      const panelSees = await bounded(
        "panel_list_chapters",
        facade.listChapters({
          continuityId: identity.continuityId,
          profileId: "chat",
          profileRevision: 1,
        }),
      );
      assert.ok(panelSees.length >= 1, "the panel's read returned no chapter after a real fold sealed one");
      const folded = panelSees[0];
      if (folded === undefined) throw new Error("unreachable: asserted above");
      assert.equal(folded.status, "sealed", "a freshly folded chapter must read as the fold's own text");

      const corrected = await bounded(
        "panel_update_chapter",
        facade.updateChapter({
          continuityId: identity.continuityId,
          profileId: "chat",
          profileRevision: 1,
          chapterId: folded.chapterId,
          content: "What I remember of those first days.",
        }),
      );
      assert.equal(corrected.status, "edited", "the player's correction must persist as theirs");
      assert.equal(corrected.content, "What I remember of those first days.");

      const removed = await bounded(
        "panel_delete_chapter",
        facade.deleteChapter({
          continuityId: identity.continuityId,
          profileId: "chat",
          profileRevision: 1,
          chapterId: folded.chapterId,
        }),
      );
      assert.equal(removed.status, "deleted", "a removal must tombstone the chapter");
      assert.equal(
        removed.content,
        "What I remember of those first days.",
        "the tombstone keeps the body, so a removal stays auditable",
      );
      const afterRemoval = await bounded(
        "panel_list_after_removal",
        facade.listChapters({
          continuityId: identity.continuityId,
          profileId: "chat",
          profileRevision: 1,
        }),
      );
      assert.equal(
        afterRemoval.filter((chapter) => chapter.status !== "deleted").length,
        0,
        "a removed chapter must not be shown as live history",
      );
      phase("panel_path", panelStartedAt);
      process.stderr.write(
        `[chapter-fold-fixture] panel path: folded=${folded.status} corrected=${corrected.status} removed=${removed.status} listed=${afterRemoval.length}\n`,
      );
    } catch (error) {
      bodyFailed = true;
      throw error;
    } finally {
      // Without this the run's handles keep the test process alive after the assertions. A cleanup
      // failure must not MASK the fold evidence though: on this machine (2026-10-08) releasing the
      // runtime's durable lock reports `durable_path_lock_release_failed:windows_reclaimer_unavailable`
      // even with the reclaimer bound the same way `chat-transcript.test.ts` binds it, so failures are
      // collected and reported alongside the verdict instead of replacing it.
      const cleanupStartedAt = Date.now();
      const cleanupFailures: string[] = [];
      const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
      try {
        // Disposed while the reclaimer is still bound: the runtime's durable lock release runs here.
        runtime?.session.dispose();
        phase("dispose", cleanupStartedAt);
      } catch (error) {
        cleanupFailures.push(`dispose failed: ${describe(error)}`);
        process.stderr.write(`[chapter-fold-fixture] dispose failed: ${describe(error)}\n`);
      }
      bindWindowsStaleLockReclaimer(undefined);
      // Out of the root BEFORE any removal is attempted. This process's own working directory is inside
      // `<root>/contexts/<hash>` (`contextDir`), and on Windows a live current directory holds the tree
      // open as well, so the ordering has to be this one whichever platform runs it.
      process.chdir(previousCwd);
      if (process.env.GAMEBUDDY_CHAPTER_FOLD_KEEP_ROOT === "1") {
        // Diagnosis aid: keep the root when asked, so Magic Context's own database can be read
        // afterwards (it is where the fold's reasons live: `session_meta`). Retaining this root is this
        // run's declared outcome, so neither the removal below nor its assertion applies.
        process.stderr.write(`[chapter-fold-fixture] kept root: ${root}\n`);
      } else {
        // Worth one attempt here: on POSIX an open file can still be unlinked, so the root is gone at
        // the end of the body wherever the platform allows it.
        const removalFailure = await rm(root, { recursive: true, force: true }).then(
          () => undefined,
          (error: unknown) => describe(error),
        );
        if (existsSync(root)) {
          // Measured here (2026-10-14, this machine): `EBUSY: resource busy or locked, unlink
          // '...\magic-context\context.db'` - every time, on a passing run as much as on a deadline
          // failure, because the handle above is still open. This hook is registered after the
          // runtime's own, i.e. after the vendor's, so the handle is closed by the time it runs.
          phase("root_removal_deferred_to_process_exit", cleanupStartedAt);
          if (removalFailure !== undefined) phase(`root_removal_failed_here: ${removalFailure}`);
          process.once("exit", () => {
            // Synchronous by necessity - an exit handler can await nothing - and `writeSync(2, ...)` is
            // the one report that survives one on every platform.
            try {
              rmSync(root, { recursive: true, force: true });
            } catch {
              // Reported by the check below, which does not depend on the error's shape.
            }
            if (existsSync(root)) {
              process.exitCode = 1;
              writeSync(
                2,
                "[chapter-fold-fixture] cleanup failure (fold verdict preserved): " +
                  `chapter_fold_fixture_temp_root_survived_cleanup: ${root}\n`,
              );
            }
          });
        } else {
          phase("root_removed", cleanupStartedAt);
        }
      }
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      if (previousEmbeddedRuntime === undefined) delete process.env.GAMEBUDDY_EMBEDDED_RUNTIME;
      else process.env.GAMEBUDDY_EMBEDDED_RUNTIME = previousEmbeddedRuntime;
      // Where the budget went, on every exit path: a deadline failure is only actionable when it
      // names the phase that spent the budget.
      for (const line of phases) process.stderr.write(`[chapter-fold-fixture] ${line}\n`);
      for (const failure of cleanupFailures)
        process.stderr.write(`[chapter-fold-fixture] cleanup failure (fold verdict preserved): ${failure}\n`);
      // Only when nothing else is failing: otherwise the fold verdict is already on its way out and
      // replacing it with a cleanup error would hide the thing this fixture exists to measure.
      if (cleanupFailures.length > 0 && !bodyFailed) {
        throw new Error(`runtime cleanup failed: ${cleanupFailures.join("; ")}`);
      }
    }
  },
);
