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
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompanionRuntime, resolveRuntimePaths, type CompanionIdentity } from "./runtime.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

const apiKey = process.env.CPA_OAI_API_KEY;const identity: CompanionIdentity = Object.freeze({
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
    // 2. The fixture does not yet produce a fold even with BOTH window-derived quantities
    //    compressed (measured: `execute_threshold_tokens: 6000` + `protected_tokens: 4000`, 12 real
    //    turns, ~13k tokens -> `[probe:m0_chapters] 0` every pass, `compartments` stays 0). So a
    //    third condition gates the fold, and it has to be identified before this can be a gate:
    //    the two candidates are (a) the plugin does not read the Host-written project config on this
    //    in-process path, or (b) Magic Context's pressure decision needs a context-usage reading a
    //    bare in-process session does not supply. Until that is settled this must NOT be reported as
    //    evidence - a green test here would be a lie, and a red one would blame the product.
    skip:
      apiKey === undefined
        ? "requires CPA_OAI_API_KEY: this fixture runs real provider turns"
        : "open finding: an in-process fold does not happen yet even with the fixture knobs compressed (see the file header)",
  },
  async () => {
    // Narrowed after the skip guard: the closure below must not see `string | undefined`.
    if (apiKey === undefined) throw new Error("requires CPA_OAI_API_KEY");
    const key = apiKey;
    bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
    const root = await mkdtemp(join(tmpdir(), "gamebuddy-chapter-fold-"));
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
      for (let index = 1; index <= 12; index += 1) {
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
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      bindWindowsStaleLockReclaimer(undefined);
    }
  },
);
