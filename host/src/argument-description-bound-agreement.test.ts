import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MAX_ARGUMENT_DESCRIPTION_LENGTH } from "./protocol.js";

/**
 * `one_argument_description_bound` — every surface that bounds an argument's description bounds it at the wire's number.
 *
 * <p>
 * THE DEFECT THIS EXISTS FOR. Measured 2026-11-25: the Mod published a 595-character sentence for
 * `use_mine_ladder`'s `expectedTargetId`, this Host's `isValidActionDescriptor` bounded an argument description at 512,
 * and one refused descriptor refuses the WHOLE `hello_ack` registration list — so the attach died on one sentence, and
 * no tool ever mounted. The number had been written on the reading side four times and by the C# that WRITES both
 * published shapes (the frame and the exported artifact) not at all: the producer could publish what the consumer
 * refuses, and nothing failed until a live run.
 * </p>
 *
 * <p>
 * WHY A COMPARISON AND NOT AN IMPORT. `MAX_ARGUMENT_DESCRIPTION_LENGTH` is the authority and it is this file's import;
 * the other sites cannot import it. The Host is consumed compiled (`host/src/protocol.ts` names sibling `.js` outputs a
 * clean checkout does not carry, so a producer script importing it fails to resolve), and the Mod is C#. Each site
 * therefore states the number and this gate holds every statement to the wire's.
 * </p>
 *
 * <p>
 * THE POPULATION IS THE COMPARISON, NOT THE CONSTANT NAME. A reader that declares one number and then writes a second
 * literal beside it has two, and the one an editor changes may not be the one that runs — which is how this defect
 * arrived: one artifact gateway declared 2,048 and refused at 512. So each entry names the line that APPLIES the bound
 * (accepting either a literal or a named constant resolved in the same file), and a file that stops applying a bound
 * fails as unreadable instead of dropping out of the comparison.
 * </p>
 *
 * `// source-invariant:` the applied-comparison lines and the `const` declarations they may name, read here and nowhere
 *   else; each entry fails when its line moves.
 * `// source-expiry:` delete an entry when its site stops bounding an argument description.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** The repository root: found by walking up to the workspace file, because tests run from `host/dist-test`. */
function repositoryRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository_root_not_found:${start}`);
    directory = parent;
  }
}

const ROOT = repositoryRoot(HERE);

type BoundSite = Readonly<{
  /** The surface, named the way a reader of the failure would go looking for it. */
  site: string;
  path: string;
  /** The line that applies the bound to an argument's description: capture 1 is a literal, capture 2 a constant name. */
  applied: RegExp;
}>;

/**
 * Every surface that bounds an argument's description, and the one fact each is a statement of.
 *
 * The producer entry is the site whose absence was the defect: the C# constant is what the catalog's initialization
 * refuses on, and it is the declaration both published shapes are projected from
 * (`FarmhandActionArgumentPublication.ToWire` and `ToSurface`).
 */
const BOUND_SITES: readonly BoundSite[] = Object.freeze([
  {
    site: "the Mod's catalog initialization (the refusal both published shapes are projected after)",
    path: "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs",
    applied: /description\.Length > (?:(?<literal>\d+)|(?<constant>[A-Za-z_][A-Za-z0-9_.]*))/gu,
  },
  {
    site: "the artifact gateway's typed reader (the artifact the Mod exports)",
    path: "integrations/stardew/action-development/src/action-surface.mjs",
    applied: /description\.length > (?:(?<literal>\d+)|(?<constant>[A-Za-z_][A-Za-z0-9_]*))/gu,
  },
  {
    site: "the game-action-program gateway (the artifact's other reader)",
    path: "packages/game-action-program/src/descriptors.mjs",
    applied: /value\.length <= (?:(?<literal>\d+)|(?<constant>[A-Za-z_][A-Za-z0-9_]*))\s*;\s*$/gmu,
  },
]);

/** A named constant's value in the same file - a JS `const` or a C# `public const int`, by its last segment - or null. */
function declaredConstant(source: string, name: string): number | null {
  const bare = name.slice(name.lastIndexOf(".") + 1);
  for (const declaration of [
    `^\\s*(?:export\\s+)?const\\s+${bare}\\s*=\\s*(\\d+);$`,
    `^\\s*public const int ${bare} = (\\d+);$`,
  ]) {
    const match = new RegExp(declaration, "mu").exec(source);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return null;
}

type Reading = Readonly<{ site: string; path: string; applied: readonly number[]; findings: readonly string[] }>;

function readSite(bound: BoundSite): Reading {
  const path = join(ROOT, bound.path);
  if (!existsSync(path))
    return {
      site: bound.site,
      path: bound.path,
      applied: [],
      findings: [`${bound.path}: not there, so ${bound.site} bounds nothing`],
    };

  const source = readFileSync(path, "utf8");
  const findings: string[] = [];
  const applied: number[] = [];
  for (const match of source.matchAll(bound.applied)) {
    const groups = match.groups ?? {};
    const name = groups.constant;
    const value = name === undefined ? Number(groups.literal) : declaredConstant(source, name);
    if (value === null || !Number.isSafeInteger(value)) {
      findings.push(
        `${bound.path}: ${bound.site} applies \`${match[0].trim()}\`, and \`${String(name)}\` is not declared in that ` +
          `file - the bound is stated somewhere this gate cannot read, which is a number nobody compares`,
      );
      continue;
    }
    applied.push(value);
    if (value !== MAX_ARGUMENT_DESCRIPTION_LENGTH)
      findings.push(
        `${bound.path}: ${bound.site} bounds an argument's description at ${String(value)} while the wire's ` +
          `\`MAX_ARGUMENT_DESCRIPTION_LENGTH\` is ${String(MAX_ARGUMENT_DESCRIPTION_LENGTH)} (measured on ` +
          `\`${match[0].trim()}\`). The wire is the authority because it is what refuses: a longer statement here ` +
          `publishes a sentence the Host refuses, and ONE refused descriptor refuses the WHOLE registration list at ` +
          `attach (invalid_hello_ack)`,
      );
  }
  if (applied.length === 0 && findings.length === 0)
    findings.push(
      `${bound.path}: no line matches ${bound.applied.source} - ${bound.site} either stopped bounding an argument's ` +
        `description (then it accepts what the wire refuses) or moved the comparison to a shape this gate cannot read; ` +
        `restore the comparison or delete this entry`,
    );
  return { site: bound.site, path: bound.path, applied, findings };
}

test("one_argument_description_bound: every surface applies the wire's number", (t) => {
  const readings = BOUND_SITES.map(readSite);
  const findings = readings.flatMap((reading) => reading.findings);

  t.diagnostic(
    `bound ${String(MAX_ARGUMENT_DESCRIPTION_LENGTH)} · sites examined ${String(readings.length)} · ` +
      `comparisons read ${String(readings.reduce((total, reading) => total + reading.applied.length, 0))} · ` +
      `findings ${String(findings.length)}`,
  );
  for (const reading of readings) t.diagnostic(`  ${reading.applied.join(",").padStart(4, " ")}  ${reading.path}`);

  assert.ok(
    BOUND_SITES.length >= 3,
    `blocked: examined ${String(BOUND_SITES.length)} surfaces; the producer and both artifact readers must be compared`,
  );
  assert.deepEqual(findings, [], findings.join("\n"));
});

/**
 * The producer's bound is a refusal, not a comment: the constant above it is what catalog initialization throws on.
 *
 * `// source-invariant:` the static constructor's call, which is what makes an over-long sentence unbuildable.
 * `// source-expiry:` delete with the validator if the catalog stops being validated at initialization.
 */
test("one_argument_description_bound: the producer refuses at catalog initialization", (t) => {
  const path = "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs";
  const source = readFileSync(join(ROOT, path), "utf8");
  const refuses = /static FarmhandActionCatalog\(\)[\s\S]{0,400}?ValidateArgumentDescriptions\(Registrations\);/u.test(
    source,
  );
  const names =
    /farmhand action '\{registration\.ActionId\}' argument '\{argument\.Name\}' description is \{description\.Length\}/u.test(
      source,
    );

  t.diagnostic(
    `${path}: catalog initialization validates ${refuses ? "yes" : "no"} · the diagnostic names action and argument ${names ? "yes" : "no"}`,
  );
  assert.ok(
    refuses,
    `${path}: catalog initialization no longer validates argument descriptions, so the producer can publish what the Host refuses`,
  );
  assert.ok(
    names,
    `${path}: the refusal no longer names the action and the argument, which is what a live run would otherwise have to discover`,
  );
});
