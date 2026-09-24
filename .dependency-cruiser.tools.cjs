/**
 * `tools/` (live-run harness and action-development support tooling) graph rules.
 *
 * This ruleset exists so that game decoupling inside `tools/` is observable at
 * all. Until it existed, `knip.json` covered one file and no dependency graph
 * covered `tools/`, so every coupling claim had to be hand-scanned. Follow-up
 * migration work (see design/analysis/live-run-game-decoupling-audit.md) needs
 * these edges to be a regression-checkable invariant.
 *
 * Run with: `pnpm check:tools-boundaries`
 *
 * Layers expressed here, from generic to game-specific:
 *
 *   generic-platform   tools/ whose file name carries no game identity.
 *                      Reusable by a second game; must not name a game.
 *   game-harness       tools/ whose file name names a game (`stardew`,
 *                      `farmhand`, `smapi`). Game-specific runner/probe code.
 *   host               host/src (production sources) and host/scripts.
 *   host-test-artifact host/dist-test (disposable compiled test output).
 *   game-integration   integrations/** (Mod + per-game action project).
 *
 * Rule severity is deliberate:
 *   - `error` = a named obligation that must fail: `tools/` may not depend on
 *     Host production sources, game-integration sources, or the disposable
 *     `host/dist-test` build output.
 *   - `warn`  = a directional signal, not an obligation. The game-identity
 *     split is derived from file names, which is a heuristic rather than
 *     architecture authority; it must stay visible without granting a gate
 *     the power to block on a naming convention.
 *
 * On the `host/dist-test` rule: an anchored `to.path` such as
 * `^host/dist-test/` only matches an edge whose target RESOLVED. When
 * `host/dist-test` is absent (every clean checkout; it is gitignored) the edge
 * is reported with `couldNotResolve: true` and `resolved` left as the raw
 * specifier (`../host/dist-test/...`), so an anchored pattern silently passes.
 * The pattern below is therefore deliberately unanchored so that it matches
 * the raw specifier as well as the resolved path.
 */

const GAME_IDENTITY = "stardew|farmhand|smapi";

/**
 * `tools/` file whose name carries a game identity. dependency-cruiser rejects
 * lookahead in rule patterns, so the game-neutral side is expressed as
 * `path: "^tools/"` + `pathNot: GAME_TOOLS_NAME` rather than as a negated pattern.
 */
const GAME_TOOLS_NAME = "[^/]*(?:" + GAME_IDENTITY + ")[^/]*$";

module.exports = {
  forbidden: [
    {
      name: "no-tools-circular-dependencies",
      comment: "The tools/ graph must stay acyclic; a cycle makes ownership of a harness primitive ambiguous.",
      severity: "error",
      from: { path: "^tools/" },
      to: { path: "^tools/", circular: true },
    },
    {
      name: "tools-must-not-import-host-production-sources",
      comment:
        "tools/ consumes the Host through its published artifact surface (host/scripts/production-artifact.mjs), never by reaching into TypeScript production sources.",
      severity: "error",
      from: { path: "^tools/" },
      to: { path: "^host/src/" },
    },
    {
      name: "tools-must-not-import-disposable-host-test-artifacts",
      comment:
        "host/dist-test is disposable compiled test output; harnesses that import it cannot run on a clean checkout and its module shape carries no production authority. Use tools/lib/host-production-module.mjs instead.",
      severity: "error",
      from: { path: "^tools/" },
      to: { path: "(?:^|/)host/dist-test/" },
    },
    {
      name: "tools-must-not-import-game-integration-sources",
      comment:
        "tools/ is the harness side of the boundary; a per-game action project owns its own scenarios and fixtures, so the harness must not depend on integrations/**.",
      severity: "error",
      from: { path: "^tools/" },
      to: { path: "^integrations/" },
    },
    {
      name: "generic-tools-must-not-depend-on-game-tools",
      comment:
        "Directional signal only: a game-neutral tool file that depends on a game-named tool file is a decoupling candidate. The split is name-derived, so this stays a warning.",
      severity: "warn",
      from: { path: "^tools/", pathNot: GAME_TOOLS_NAME },
      to: { path: GAME_TOOLS_NAME },
    },
    {
      name: "generic-tools-must-not-import-game-integration-sources",
      comment:
        "Directional signal only: a game-neutral tool file importing integrations/** shows a game integration that is not yet behind an interface.",
      severity: "warn",
      from: { path: "^tools/", pathNot: GAME_TOOLS_NAME },
      to: { path: "^integrations/" },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    // Disposable, gitignored scratch scripts. They are not part of the harness
    // and never ship, so they must not contribute coupling evidence.
    exclude: {
      path: "^tools/\\.tmp-",
    },
    combinedDependencies: false,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "default"],
      mainFields: ["module", "main"],
    },
  },
};
