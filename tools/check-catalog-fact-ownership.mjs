#!/usr/bin/env node
/**
 * CI gate for the CATALOG FACT OWNERSHIP class (see lib/catalog-fact-ownership.mjs).
 *
 * The owner of a shipped model's facts is `TAVERN_PROVIDER_CATALOG`
 * (`host/src/tavern/provider-catalog.ts`). This gate derives the shipped model set
 * and every declared `contextWindow`/`cost` from that module AT RUN TIME - it types
 * no rate, no window and no token cap of its own - and reports every other place in
 * `host/src` that spells one of those facts as a literal.
 *
 * The incident it exists for (2026-11-02): `pi-provider-store.ts` shipped
 * `cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 }` for
 * `deepseek-v4.1-flash`, whose catalog entry states `0.3 / 1.2 / 0.006 / 0`, so the
 * product billed 2.1x/4.3x/10x off and a `cacheWrite` no entry contains. `0.14/0.28`
 * are the PREVIOUS model generation's rates. No test could catch it: a test cannot
 * assert a value it does not know, and the catalog that knows was never compared.
 *
 * Default output is the first finding in
 *   `catalog_fact_ownership:<name>:<model>:<field>:<path>:<line>: catalog=<v> spelled=<v>`
 * form and exit 1; `--json` prints every finding as a JSON array (still exit 1 when
 * any exist). A clean repo prints `catalog_fact_ownership: none` and exits 0.
 *
 * red-proof: inject  a wrong price literal - `0.14 / 0.28 / 0.0028` for
 * `deepseek-v4.1-flash` (tools/lib/catalog-fact-ownership.test.mjs), the rates that
 * shipped - beside the model entry in a production file that reads its price from the
 * catalog -> the gate reports
 * `catalog_fact_ownership:unowned_literal:computed-id:cost:<path>:<line>` with both
 * values, where the same tree with the catalog-derived lookup is green. The derived
 * set is itself falsified by renaming the model in the owner, which the gate then
 * reports as a different (empty) population rather than staying silent.
 * (tools/check-catalog-fact-ownership.test.mjs)
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CATALOG_MODULE_PATH,
  DECLARED_EXEMPTIONS,
  findCatalogFactCopies,
  formatFinding,
  loadDeclaredModels,
} from "./lib/catalog-fact-ownership.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The disagreements and findings, or a thrown error. Exported so a test can drive
 * the same derivation the CLI does without spawning a subprocess.
 */
export async function evaluateCatalogFactOwnership({ root = repoRoot, exemptions = DECLARED_EXEMPTIONS } = {}) {
  const { models, disagreements } = await loadDeclaredModels({ root });
  const findings = findCatalogFactCopies({ root, models, exemptions });
  return { models, disagreements, findings };
}

async function main(argv) {
  let evaluated;
  try {
    evaluated = await evaluateCatalogFactOwnership();
  } catch (error) {
    // Fail closed: a gate that cannot read the owner must not report cleanliness.
    process.stderr.write(
      `catalog_fact_ownership: owner_unreadable: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  const { models, disagreements, findings } = evaluated;
  const derived = [...models.keys()].sort();
  // The population is the owner's declared facts: a fact is what this gate compares a copy AGAINST, so a run that
  // holds none of them has compared nothing. `derived=…` alone states the model names and not that there was one.
  const facts = [...models.values()].reduce((total, entry) => total + Object.keys(entry.facts).length, 0);
  if (facts === 0) {
    process.stderr.write(
      `catalog_fact_ownership_blocked:owner_declares_no_fact: examined 0 fields over ${derived.length} model(s) ` +
        `derived from ${CATALOG_MODULE_PATH}, so no copy had an owner value to disagree with\n`,
    );
    return 2;
  }

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ examined: facts, derived, disagreements, findings }, null, 2)}\n`);
    return findings.length === 0 && disagreements.length === 0 ? 0 : 1;
  }

  for (const disagreement of disagreements)
    console.log(
      `catalog_fact_ownership:catalog_disagrees:${disagreement.modelId}:${disagreement.field}: ` +
        `one entry states ${JSON.stringify(disagreement.first)}, another states ${JSON.stringify(disagreement.second)}`,
    );
  // The derived population is printed on every run, so a rename in the owner is
  // visible as a changed set rather than as silence - and the field count is what a
  // reader needs beside `none`: `fields examined 24 · findings 0` is a measurement,
  // `findings 0` alone is silence that reads like one.
  console.log(
    `catalog_fact_ownership: fields examined ${String(facts)} · models ${String(derived.length)} · ` +
      `derived=${derived.length === 0 ? "none" : derived.join(",")}`,
  );
  if (findings.length === 0 && disagreements.length === 0) {
    console.log("catalog_fact_ownership: none");
    return 0;
  }
  for (const finding of findings) console.log(formatFinding(finding));
  return findings.length === 0 && disagreements.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
