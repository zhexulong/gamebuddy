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
 * The fold STILL does not fire: `protected_tokens_effective` now honors the fixture (4000), and after
 * twenty real turns `last_input_tokens = 10898` - far past the 6000 threshold - yet
 * `times_execute_threshold_reached = 0`. So one more condition remains. The most likely candidate is
 * that the pressure decision needs a context-usage reading the Pi session supplies at request time
 * (the same run reports `detected_context_limit_provenance = unknown` while carrying a usable window),
 * i.e. that a bare in-process session never crosses it however much text it holds. The next probe is
 * to log the handler's own trigger inputs on one pass, rather than reason about them.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createCompanionRuntime, resolveRuntimePaths, type CompanionIdentity } from "./runtime.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

const apiKey = process.env.CPA_OAI_API_KEY;const identity: CompanionIdentity = Object.freeze({
  // Production's chat runtime carries a continuity id, and the Host only declares the memory
  // partition when it is present. WITHOUT it the plugin falls back to a git-root walk from a
  // temporary directory - finds no project, and memory plus the historian stay off. A fixture
  // without it measures nothing, which is what this one did until it was added.
  continuityId: "continuity_01",
  playerId: "player_01",
  saveId: "save_01",
  worldId: "world_01",
  companionId: "companion_01",
});

/** One turn of ordinary conversation, sized so a handful of them cross the fixture trigger. */
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
async function captureMarkers(run: () => Promise<void>): Promise<readonly Marker[]> {
  const markers: Marker[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const line of text.split("\n")) if (line.includes("[probe:")) markers.push({ line: line.trim() });
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return markers;
}

test(
  "a real fold seals a chapter and keeps the m[0] prefix byte-stable (CI fold fixture)",
  {
    // Two gates, and the second one is an OPEN FINDING rather than a permission:
    //
    // 1. Without a credential there is nothing to run - this fixture needs real provider turns.
    // 2. The fixture does not yet produce a fold: identity, the user-tier keys and the protected tail
    //    are all now correct (measured `protected_tokens_effective = 4000`, `last_input_tokens =
    //    10898`), yet `times_execute_threshold_reached = 0`. One more condition gates the trigger; the
    //    file header names the candidate and the next probe. Until then this must NOT be reported as
    //    evidence - a green test here would be a lie, and a red one would blame the product.
    //    `GAMEBUDDY_CHAPTER_FOLD_FORCE=1` runs it anyway, for diagnosis.
    skip:
      process.env.GAMEBUDDY_CHAPTER_FOLD_FORCE === "1"
        ? false
        : apiKey === undefined
          ? "requires CPA_OAI_API_KEY: this fixture runs real provider turns"
          : "open finding: an in-process fold does not happen yet even with the fixture knobs compressed (see the file header)",
  },
  async () => {
    // Narrowed after the skip guard: the closure below must not see `string | undefined`.
    if (apiKey === undefined) throw new Error("requires CPA_OAI_API_KEY");
    const key = apiKey;
    bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
    const root = await mkdtemp(join(tmpdir(), "gamebuddy-chapter-fold-"));
    // Magic Context treats the fold trigger as a USER-tier trusted key, and its rule is explicit:
    // "a repository may only RAISE execute_threshold_tokens above the user's trusted token
    // threshold; it cannot force earlier historian work or cloned-repo cost escalation." So the
    // Host-written project config can never lower it - measured: a project value of 6000 was ignored
    // and the run kept the operator's own user-tier threshold. The fixture therefore supplies its
    // OWN user tier, which is also what keeps it hermetic: without this it would silently inherit
    // whatever the machine's operator has configured (here: an 800k threshold, so no fold ever).
    const configHome = join(root, "config-home");
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    await mkdir(join(configHome, "cortexkit"), { recursive: true });
    await writeFile(
      join(configHome, "cortexkit", "magic-context.jsonc"),
      `${JSON.stringify(
        {
          execute_threshold_tokens: { default: 6_000 },
          protected_tokens: 4_000,
          // Also a trusted USER-tier key, and ignored from project scope by the same security rule:
          // "historian model selection is user-level only; a repository cannot force extra compaction
          // cost". Without it the historian does not resolve at all, so the trigger is never even
          // evaluated - which is what the earlier runs measured as "threshold never reached".
          historian: { pi: { model: "cpa-oai/deepseek-v4-flash", thinking_level: "low" } },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    process.env.XDG_CONFIG_HOME = configHome;
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
      await writeFile(
        join(agentDir, "auth.json"),
    				JSON.stringify({ "cpa-oai": { type: "api_key", key } }),
        "utf8",
      );
      const markers = await captureMarkers(async () => {
        const runtime = await createCompanionRuntime(
          identity,
          root,
          undefined,
          { provider: "cpa-oai", modelId: "deepseek-v4-flash", thinkingLevel: "low" },
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
        );
      for (let index = 1; index <= 20; index += 1) {
        await runtime.session.prompt(filler(index));
      }
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
   			const chapterCounts = chapterLines.map((match) => Number(match?.[2] ?? "0"));
      assert.ok(
        Math.max(...chapterCounts) >= 1,
        `no chapter reached m[0]; observed counts ${JSON.stringify(chapterCounts)}`,
      );
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
      for (const [revision, seen] of perRevision) {
        assert.equal(seen.size, 1, `revision ${revision} rendered ${seen.size} different m[0] byte images`);
      }
    } finally {
      // Diagnosis aid: keep the root when asked, so Magic Context's own database can be read
      // afterwards (it is where the fold's reasons live: `session_meta`).
      if (process.env.GAMEBUDDY_CHAPTER_FOLD_KEEP_ROOT === "1") {
        process.stderr.write(`[chapter-fold-fixture] kept root: ${root}\n`);
      } else {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
      bindWindowsStaleLockReclaimer(undefined);
      process.chdir(previousCwd);
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
    }
  },
);
