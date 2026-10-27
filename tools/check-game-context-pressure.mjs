/**
 * Context pressure: did any Game session grow past the model window it was given?
 *
 * Written because a real run reached 466,568 input tokens against a declared 131,072 window and NOTHING in
 * the repo noticed. The twelve `output: 1, stopReason: "length"` turns were visible only in the provider
 * responses, and every gate that reads this run's evidence read compartments instead - while the absence of
 * compartments was defined as `unmeasured` rather than red.
 *
 * The numbers this checks are already written by Magic Context into `session_meta` on every turn:
 *
 *   last_input_tokens        what the provider was actually given
 *   last_usage_context_limit the denominator Magic Context divided by
 *   last_context_percentage  the quotient it acted on
 *
 * Two independent failures to detect, and they are different:
 *
 *   OVER WINDOW     last_input_tokens exceeds the model's declared window. The session was served a request
 *                   it had no room for; the provider may answer `length` or truncate silently.
 *   WRONG DENOMINATOR  last_usage_context_limit is larger than the declared window. Every pressure decision
 *                   that session made was computed against a capacity it does not have, so the reclaim
 *                   threshold could not fire. Measured 2026-10-27: a 750,000 denominator against a 131,072
 *                   window gave 62.7%, below the 65% threshold, `times_execute_threshold_reached = 0` on all
 *                   55 sessions - and the historian fold, the only lane that can reclaim a user message,
 *                   therefore never ran.
 *
 * Usage:
 *   node tools/check-game-context-pressure.mjs                       # fixture checks only, offline
 *   node tools/check-game-context-pressure.mjs --run-dir DIR
 *   node tools/check-game-context-pressure.mjs --run-dir DIR --all
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The model windows this product declares, as `provider/model-id` fragments.
 *
 * Deliberately a table rather than a lookup into the live catalog: this gate must be able to judge an
 * ARCHIVED run, whose catalog may since have changed. A run is judged against what was declared when it
 * ran, and the window is a property of the model, not of today's config.
 */
const DECLARED_WINDOWS = [
  { match: "deepseek-v4.1-flash", window: 131_072 },
  { match: "deepseek", window: 131_072 },
];
const UNKNOWN_MODEL_WINDOW = 32_768;

const checks = [];
const check = (id, ok, detail) =>
  checks.push({ id, status: ok ? "passed" : "failed", ...(detail === undefined ? {} : { detail }) });

/** The window a session's model was declared to have. Unknown models get the conservative one. */
export function declaredWindowFor(modelId) {
  if (typeof modelId !== "string") return UNKNOWN_MODEL_WINDOW;
  const needle = modelId.toLowerCase();
  for (const entry of DECLARED_WINDOWS) if (needle.includes(entry.match)) return entry.window;
  return UNKNOWN_MODEL_WINDOW;
}

/**
 * Judge one `session_meta` row.
 *
 * A row with no `last_input_tokens` is NOT judged: a session that never completed a turn measured nothing,
 * and calling that passed is the same mistake as calling a missing compartment a bad narrative.
 */
export function judgeSession(row) {
  const input = Number(row.last_input_tokens);
  if (!Number.isFinite(input) || input <= 0) return Object.freeze({ judged: false, violations: Object.freeze([]) });

  const modelKey = row.last_observed_model_key ?? row.model_id;
  const declared = declaredWindowFor(modelKey);
  const limit = Number(row.last_usage_context_limit);
  const violations = [];

  if (input > declared) {
    violations.push(
      Object.freeze({
        code: "input_over_declared_window",
        detail: `session=${String(row.session_id)} input=${String(input)} declared=${String(declared)}`,
      }),
    );
  }

  // A denominator ABOVE the declared window is the failure that hides the first one: the quotient reads low,
  // the threshold does not fire, and the session believes it has room it was never promised.
  if (Number.isFinite(limit) && limit > declared) {
    violations.push(
      Object.freeze({
        code: "denominator_over_declared_window",
        detail: `session=${String(row.session_id)} limit=${String(limit)} declared=${String(declared)}`,
      }),
    );
  }

  return Object.freeze({ judged: true, input, declared, limit, violations: Object.freeze(violations) });
}

/** Every `session_meta` row under a run's captured runtime root. */
export function readSessionMeta(root) {
  const contexts = join(root, "contexts");
  if (!existsSync(contexts)) return [];
  const rows = [];
  for (const contextId of readdirSync(contexts)) {
    const dbPath = join(contexts, contextId, "data", "cortexkit", "magic-context", "context.db");
    if (!existsSync(dbPath)) continue;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      continue;
    }
    try {
      const columns = db
        .prepare("PRAGMA table_info(session_meta)")
        .all()
        .map((column) => column.name);
      if (!columns.includes("last_input_tokens")) continue;
      // The model is NOT in `session_meta`: it keeps the CACHE key it was materialized under
      // (`last_observed_model_key`) instead. Reading a `model_id` that does not exist returned undefined and
      // made every session fall to the conservative window, which reported 117 violations on a real run -
      // almost all of them "over 32,768" against a window that was never 32,768. A gate that fires on every
      // row is not detecting anything.
      const wanted = [
        "session_id",
        "last_observed_model_key",
        "last_input_tokens",
        "last_usage_context_limit",
        "last_context_percentage",
      ];
      const selected = wanted.filter((column) => columns.includes(column)).join(", ");
      for (const row of db.prepare(`SELECT ${selected} FROM session_meta`).all()) rows.push(row);
    } catch {
      // A session_meta table this old does not carry the columns; it measured nothing to judge.
    } finally {
      db.close();
    }
  }
  return rows;
}

function fixtureChecks() {
  const healthy = judgeSession({
    session_id: "ok",
    model_id: "deepseek-v4.1-flash",
    last_input_tokens: 90_000,
    last_usage_context_limit: 131_072,
  });
  check("a session inside its declared window passes", healthy.violations.length === 0);

  const over = judgeSession({
    session_id: "over",
    model_id: "deepseek-v4.1-flash",
    last_input_tokens: 466_568,
    last_usage_context_limit: 750_000,
  });
  check(
    "the measured 2026-10-27 session is red on BOTH counts",
    over.violations.length === 2 &&
      over.violations.some((entry) => entry.code === "input_over_declared_window") &&
      over.violations.some((entry) => entry.code === "denominator_over_declared_window"),
    over.violations.map((entry) => entry.code).join(","),
  );

  const wrongDenominatorOnly = judgeSession({
    session_id: "denom",
    model_id: "deepseek-v4.1-flash",
    last_input_tokens: 60_000,
    last_usage_context_limit: 750_000,
  });
  check(
    "an oversized denominator is caught even when the input still fits",
    wrongDenominatorOnly.violations.length === 1 &&
      wrongDenominatorOnly.violations[0].code === "denominator_over_declared_window",
  );

  const unmeasured = judgeSession({ session_id: "empty", model_id: "deepseek-v4.1-flash" });
  check("a session that measured nothing is not judged (and not passed)", unmeasured.judged === false);

  const unknown = judgeSession({
    session_id: "unknown",
    model_id: "some-new-model",
    last_input_tokens: 40_000,
    last_usage_context_limit: 131_072,
  });
  // BOTH fire, and both are correct: 40,000 is over the conservative 32,768, AND 131,072 is over it too. An
  // unknown model is not allowed to inherit the largest window the product happens to know about.
  check(
    "an unknown model is judged against the conservative window",
    unknown.violations.length === 2 &&
      unknown.violations.every(
        (entry) => entry.code === "input_over_declared_window" || entry.code === "denominator_over_declared_window",
      ),
    unknown.violations.map((entry) => entry.code).join(","),
  );

  return checks;
}

function main() {
  const args = process.argv.slice(2);
  const runDirIndex = args.indexOf("--run-dir");
  const all = args.includes("--all");
  const offline = fixtureChecks();

  let judged = [];
  if (runDirIndex >= 0) {
    const target = args[runDirIndex + 1];
    if (!target || !existsSync(target)) {
      console.error(`context_pressure_run_dir_missing:${String(target)}`);
      process.exit(1);
    }
    const roots = all
      ? readdirSync(target)
          .map((name) => join(target, name))
          .filter((path) => existsSync(join(path, "runtime-root")))
          .map((path) => join(path, "runtime-root"))
      : [join(target, "runtime-root")];
    for (const root of roots) {
      for (const row of readSessionMeta(root)) {
        const verdict = judgeSession(row);
        if (!verdict.judged) continue;
        judged.push({ row, verdict });
      }
    }
  }

  const failures = [...offline.filter((entry) => entry.status === "failed")];
  for (const { row, verdict } of judged) {
    for (const violation of verdict.violations)
      failures.push({ id: violation.code, status: "failed", detail: violation.detail });
  }

  for (const entry of [...offline, ...failures.filter((failure) => !offline.includes(failure))]) {
    console.log(
      `${entry.status === "passed" ? "PASS" : "FAIL"} ${entry.id}${entry.detail ? ` (${entry.detail})` : ""}`,
    );
  }
  if (judged.length === 0 && runDirIndex >= 0) {
    console.log("UNMEASURED no session carried a token reading - this is not a pass");
  }

  process.exit(failures.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/gu, "/").split("/").pop())) main();
