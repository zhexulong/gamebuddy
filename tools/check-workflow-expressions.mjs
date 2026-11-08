/**
 * Gate: a workflow expression may only use the contexts GitHub allows in that position.
 *
 * Two errors of exactly this kind shipped in one commit and were caught by nothing:
 *
 *   * `if: ${{ secrets.X != '' }}` on a step - GitHub rejects the entire file with
 *     "Unrecognized named-value: 'secrets'". `secrets` is available in `env:` and `with:`, never in `if:`.
 *   * `env: { KEY: "${{ env.KEY }}" }` as a re-export of a value an earlier step wrote to `GITHUB_ENV`. The `env` context
 *     holds workflow and job values only, so the re-export evaluates to the empty string - a signature that silently is not
 *     one.
 *
 * Both are invisible in review and fatal at runtime, which is what makes a gate worth more than a note. The population is
 * every workflow file, discovered rather than listed; every `if:` and every `env:` entry in it is examined. Zero population
 * is a blocked reading, never a pass.
 *
 * The rules are the documented ones, and they are narrow on purpose: a gate that also guesses at `matrix` or `steps`
 * ordering would fire on workflows that are fine, and a gate people mute is not a gate.
 *
 * The matcher and the gate are two different claims, so the sibling test drives the gate itself over a temporary
 * workflows directory. Measured 2026-11-07:
 *
 * red-proof: inject  narrow the extension filter so the gate lists no file -> `examined 0`, the synthetic-directory
 *                   case fails (`15 pass / 3 fail` across the two sibling test files) and the empty-directory case
 *                   only passes because it already expects 0; restoring the file leaves `git diff` empty
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const workflowsRoot = join(repositoryRoot, ".github", "workflows");

/** Contexts GitHub documents as unavailable in `if:`. `secrets` is the one that bites in practice. */
const FORBIDDEN_IN_IF = ["secrets"];

function fail(reason) {
  throw new Error(`workflow_expression_gate_failed:${reason}`);
}

/**
 * A workflow is walked as text rather than parsed as YAML, because the findings have to name a line a reader can open.
 * Both patterns are anchored on the syntax they police, so a comment or a `run:` body cannot trigger them.
 */
export function inspectWorkflow({ text, file }) {
  const blocking = [];
  // Both endings: a CRLF copy would leave a trailing `\r` on every line, and an anchored rule would then stop matching
  // while the file still looked valid.
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("if:")) {
      for (const context of FORBIDDEN_IN_IF) {
        if (trimmed.includes(`${context}.`)) {
          blocking.push({
            file,
            line: index + 1,
            rule: "forbidden_context_in_if",
            detail: `'${context}' is not available in an if: condition; pass it through env: first`,
            text: trimmed.slice(0, 120),
          });
        }
      }

      // `if:` may not name a step's output before the step, but that needs the graph; reported, not blocked.
    }

    // A self-re-export through the `env` context: `KEY: "${{ env.KEY }}"` can only ever be the empty string.
    const selfExport = /^(\s*)([A-Z0-9_]+):\s*"?\$\{\{\s*env\.([A-Z0-9_]+)\s*\}\}"?$/u.exec(line);
    if (selfExport !== null && selfExport[2] === selfExport[3]) {
      blocking.push({
        file,
        line: index + 1,
        rule: "self_reexport_through_env_context",
        detail:
          `'${selfExport[2]}' re-exports itself through the env context, which holds workflow/job values only - a value an ` +
          "earlier step wrote to GITHUB_ENV is not visible this way, so this always evaluates empty",
        text: trimmed.slice(0, 120),
      });
    }
  }

  return { blocking };
}

export async function checkWorkflowExpressions({ root = workflowsRoot } = {}) {
  const files = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/iu.test(entry.name))
    .map((entry) => join(root, entry.name))
    .sort();
  const blocking = [];
  let examined = 0;
  for (const file of files) {
    examined += 1;
    blocking.push(...inspectWorkflow({ text: await readFile(file, "utf8"), file }).blocking);
  }
  return Object.freeze({ files: Object.freeze(files), examined, blocking: Object.freeze(blocking) });
}

const describe = (finding) =>
  `${relative(repositoryRoot, finding.file).replaceAll("\\", "/")}:${finding.line}  ${finding.rule}\n    ${finding.text}\n    ${finding.detail}`;

async function main() {
  // The optional root is not a convenience: the red proof for this gate points it at a directory holding a deliberately broken
  // copy, and a gate that ignores that argument validates a population nobody asked about.
  const root = process.argv[2] === undefined ? workflowsRoot : resolve(process.argv[2]);
  const result = await checkWorkflowExpressions({ root });
  process.stdout.write(`examined ${result.examined} workflow file(s)\n`);
  if (result.examined === 0) fail("no_workflow_files_examined");
  if (result.blocking.length > 0) {
    process.stdout.write(`\n${result.blocking.length} expression defect(s):\n`);
    for (const finding of result.blocking) process.stdout.write(`  ${describe(finding)}\n`);
    fail(`${result.blocking.length}`);
  }

  process.stdout.write("workflow_expressions_valid\n");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
