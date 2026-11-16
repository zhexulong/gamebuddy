/**
 * Where a gate may live, and the closed sets a gate's declaration is checked against.
 *
 * This module exists apart from `gates/registry.mjs` because the registry also imports the parsing seam
 * (`tools/lib/javascript-ast.mjs`, which loads `web-tree-sitter`), and the things that need to know which DIRECTORY a
 * gate lives in are cheap: the formatter and linter ratchets run on every commit, the corpus runner derives its
 * population on every CI run, and a directory list that costs a wasm parser to read is a directory list those tools
 * will restate instead.
 *
 * `GATE_TREE_ROOTS` is the same authority one level up: the top-level trees the directories live under. A consumer that
 * scans trees rather than directories (`jscpd`, the formatter's `SCOPE`, `check-spec-reachability`'s suite population)
 * reads THIS, so the day a domain directories moves is not the day twenty-one tools each learn its own answer.
 */

/** The three closed sets a declaration is checked against, in the order a reader wants them. */
export const GATE_DOMAINS = Object.freeze(["product", "data", "arch", "stardew", "meta"]);
export const GATE_TIERS = Object.freeze(["l0", "l1", "l2"]);
export const GATE_KINDS = Object.freeze(["contract", "totality", "ratchet"]);

/** The directory a domain's gates live in. One string per domain, derived from the domain list. */
const DOMAIN_ROOT = "gates";

/**
 * The directories a gate file may live in: `tools/` for the gates no domain has claimed yet, and one directory per
 * domain beneath `gates/`.
 *
 * DERIVED FROM `GATE_DOMAINS`, not written out, so filing a domain in its directory is a `git mv` and no edit at all.
 * `tools/` stays listed until the last gate there has a domain directory to go to: a registry that stopped seeing the
 * un-moved half would answer a smaller question and print green.
 */
export const GATE_DIRECTORIES = Object.freeze(["tools", ...GATE_DOMAINS.map((domain) => `${DOMAIN_ROOT}/${domain}`)]);

/** The top-level trees those directories live under: `gates` and `tools`. Derived, and the only spelling of either. */
export const GATE_TREE_ROOTS = Object.freeze([
  ...new Set(GATE_DIRECTORIES.map((directory) => directory.split("/")[0])),
]);
