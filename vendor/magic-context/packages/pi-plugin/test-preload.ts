// Test-isolation guard — runs ONCE before any test file is imported (wired via
// bunfig.toml `[test] preload`). Forces XDG data and config homes to one
// throwaway temp tree so NO test can read or migrate the user's real shared
// cortexkit DB (~/.local/share/cortexkit/magic-context/context.db), which
// pi-plugin shares with OpenCode via @magic-context/core's `getDataDir()` =
// `XDG_DATA_HOME ?? ~/.local/share`. See the OpenCode plugin's test-preload.ts
// for the full rationale: a 2026-06-01 unisolated test migrated the real DB,
// and #388 found a fixture-scoped test resolving the user's real embedding
// endpoint and model through the user config tier. Per-test XDG_DATA_HOME or XDG_CONFIG_HOME
// fixtures may replace this root, while MAGIC_CONTEXT_STORAGE_DIR can never
// escape test isolation. Do not remove.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolatedDataHome = mkdtempSync(join(tmpdir(), "mc-pi-test-xdg-"));

// Bulletproof DB guard (see @magic-context/core resolveDatabasePath): never
// mutated by any test, so a bare openDatabase() can never reach the real DB.
process.env.MAGIC_CONTEXT_TEST_DATA_DIR = isolatedDataHome;
process.env.XDG_DATA_HOME = isolatedDataHome;
process.env.XDG_CONFIG_HOME = isolatedDataHome;
