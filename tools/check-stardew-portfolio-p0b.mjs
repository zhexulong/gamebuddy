#!/usr/bin/env node
import { inspectPortfolioP0b } from "./lib/stardew-portfolio-p0b.mjs";

const pathNames = [
  "GAMEBUDDY_STARDEW_GAME_PATH",
  "GAMEBUDDY_PORTFOLIO_PROFILE_ROOT",
  "GAMEBUDDY_PORTFOLIO_DATA_ROOT",
  "GAMEBUDDY_PORTFOLIO_SAVE_ROOT",
  "GAMEBUDDY_PORTFOLIO_SAVE_NAME",
  "GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT",
  "GAMEBUDDY_PORTFOLIO_INSTALLATION_ATTESTATION",
  "GAMEBUDDY_PORTFOLIO_START_MANIFEST",
  "GAMEBUDDY_PORTFOLIO_HOST_ARTIFACT",
];
const missing = pathNames.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.log(
    JSON.stringify({
      state: "BLOCKED",
      phase: "P0b_read_only_save_and_target_attestation",
      topology: "single_player_native_companion",
      reasons: missing.map((name) => `portfolio_environment_missing:${name}`),
      note: "P0b paths may be supplied by environment; the signing key is read from the process-local secret channel.",
    }),
  );
  process.exitCode = 2;
} else {
  const result = await inspectPortfolioP0b({
    gamePath: process.env.GAMEBUDDY_STARDEW_GAME_PATH,
    profileRoot: process.env.GAMEBUDDY_PORTFOLIO_PROFILE_ROOT,
    dataRoot: process.env.GAMEBUDDY_PORTFOLIO_DATA_ROOT,
    saveRoot: process.env.GAMEBUDDY_PORTFOLIO_SAVE_ROOT,
    saveName: process.env.GAMEBUDDY_PORTFOLIO_SAVE_NAME,
    observedSaveSlot: process.env.GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT,
    installationAttestationPath: process.env.GAMEBUDDY_PORTFOLIO_INSTALLATION_ATTESTATION,
    startManifestPath: process.env.GAMEBUDDY_PORTFOLIO_START_MANIFEST,
    hostArtifactPath: process.env.GAMEBUDDY_PORTFOLIO_HOST_ARTIFACT,
    signingKey: process.env.GAMEBUDDY_PORTFOLIO_START_MANIFEST_KEY,
  });
  console.log(JSON.stringify(result));
  process.exitCode = result.state === "PASS" ? 0 : 2;
}
